/* =============================================================================
 * world.js  →  App.World
 * -----------------------------------------------------------------------------
 * Grid + camera math + pathfinding + the seeded neon office layout.
 *
 * Authority: SPEC.md §4 (coordinate system, tiles, furniture), §7.2 (signatures),
 *            §9 (default seeded company), design_visual.md §8 (look target).
 *
 * Contract notes (PINNED by SPEC):
 *  - 1 cell = config.TILE (16) world px. screen px per world px = PIXEL*zoom.
 *  - camera.x/.y = WORLD coords of the screen top-left corner.
 *  - layout.tiles[gy][gx] — row-major (first index = row = gy).
 *  - Walkable tiles: FLOOR, CARPET, DOOR, RUG. Blocking: WALL, VOID + blocking furniture.
 *  - findPath({gx,gy},{gx,gy}) — object form ONLY. Excludes start, includes goal.
 *      [] when start==goal; null when unreachable. No diagonals. Never infinite-loops.
 *  - This module reads config + state; it does NOT touch the DOM or network.
 * ========================================================================== */
window.App = window.App || {};

(function () {
  'use strict';

  // Local handles resolved lazily inside functions so load order is irrelevant
  // (config.js is guaranteed first, but state/camera are created by Store later).
  function CFG()    { return App.config; }
  function STATE()  { return App.state; }
  function TILES()  { return App.config.TILES; }
  function FURN()   { return App.config.FURNITURE; }

  var World = {};

  // --- convenience mirror of the cell edge in world px -----------------------
  World.TILE = (App.config && App.config.TILE) || 16;

  /* ---------------------------------------------------------------------------
   * cellSizeScreen(zoom?) → Number   (screen px per cell edge)
   *   = TILE * PIXEL * zoom ;  zoom defaults to current camera zoom.
   * ------------------------------------------------------------------------- */
  World.cellSizeScreen = function (zoom) {
    var c = CFG();
    var z = (typeof zoom === 'number') ? zoom
          : (STATE() && STATE().camera ? STATE().camera.zoom : c.CAMERA_START.zoom);
    return c.TILE * c.PIXEL * z;
  };

  /* ===========================================================================
   * CAMERA / COORDINATE TRANSFORMS  (SPEC §4.1)
   * All canvas math in every module goes through these.
   * ========================================================================= */
  function cam() {
    var s = STATE();
    return (s && s.camera) ? s.camera : CFG().CAMERA_START;
  }

  // worldToScreen(wx,wy) = { x:(wx-cam.x)*PIXEL*zoom, y:(wy-cam.y)*PIXEL*zoom }
  World.worldToScreen = function (wx, wy) {
    var c = CFG(), k = cam(), s = c.PIXEL * k.zoom;
    return { x: (wx - k.x) * s, y: (wy - k.y) * s };
  };

  // screenToWorld(sx,sy) = { x: sx/(PIXEL*zoom)+cam.x, y: sy/(PIXEL*zoom)+cam.y }
  World.screenToWorld = function (sx, sy) {
    var c = CFG(), k = cam(), s = c.PIXEL * k.zoom;
    return { x: sx / s + k.x, y: sy / s + k.y };
  };

  // cellToWorld(gx,gy) → CELL CENTER in world px
  World.cellToWorld = function (gx, gy) {
    var t = CFG().TILE;
    return { x: (gx + 0.5) * t, y: (gy + 0.5) * t };
  };

  // worldToCell(wx,wy) → { gx, gy }  (floor of world / TILE)
  World.worldToCell = function (wx, wy) {
    var t = CFG().TILE;
    return { gx: Math.floor(wx / t), gy: Math.floor(wy / t) };
  };

  // screenToCell — convenience: screenToWorld then worldToCell
  World.screenToCell = function (sx, sy) {
    var w = World.screenToWorld(sx, sy);
    return World.worldToCell(w.x, w.y);
  };

  /* ---------------------------------------------------------------------------
   * clampCamera() — keep camera in bounds (+margin); clamp zoom.
   *   The visible world (cols*TILE × rows*TILE) is kept within a small margin of
   *   the viewport. If the world is smaller than the viewport on an axis, the
   *   world is centered on that axis instead of clamped to an edge.
   * ------------------------------------------------------------------------- */
  World.clampCamera = function () {
    var s = STATE();
    if (!s || !s.camera) return;
    var c = CFG();
    var k = s.camera;

    // 1) clamp zoom
    k.zoom = App.util.clamp(k.zoom, c.ZOOM_MIN, c.ZOOM_MAX);

    // viewport size in CSS screen px (canvas drawn in CSS px; DPR handled by main)
    var canvas = (typeof document !== 'undefined') ? document.getElementById('world-canvas') : null;
    var vpW = canvas ? canvas.clientWidth  : 960;
    var vpH = canvas ? canvas.clientHeight : 600;
    if (!vpW) vpW = 960;
    if (!vpH) vpH = 600;

    var L = s.layout || {};
    var cols = L.cols || c.GRID_COLS;
    var rows = L.rows || c.GRID_ROWS;

    var worldW = cols * c.TILE;            // world px width of the map
    var worldH = rows * c.TILE;
    var pps    = c.PIXEL * k.zoom;          // screen px per world px
    var viewW  = vpW / pps;                 // viewport width  in WORLD px
    var viewH  = vpH / pps;                 // viewport height in WORLD px

    var margin = c.TILE * 2;               // allow panning 2 cells past the edge

    // X axis
    if (worldW <= viewW) {
      k.x = (worldW - viewW) / 2;          // center: negative -> world sits centered
    } else {
      k.x = App.util.clamp(k.x, -margin, worldW - viewW + margin);
    }
    // Y axis
    if (worldH <= viewH) {
      k.y = (worldH - viewH) / 2;
    } else {
      k.y = App.util.clamp(k.y, -margin, worldH - viewH + margin);
    }
  };

  /* ===========================================================================
   * TILE / FURNITURE QUERIES
   * ========================================================================= */

  // tileAt(gx,gy) → tile enum; VOID if out of bounds.
  World.tileAt = function (gx, gy) {
    var s = STATE();
    var L = s && s.layout;
    if (!L || !L.tiles) return TILES().VOID;
    if (gy < 0 || gx < 0 || gy >= L.tiles.length) return TILES().VOID;
    var row = L.tiles[gy];
    if (!row || gx >= row.length) return TILES().VOID;
    var v = row[gx];
    return (typeof v === 'number') ? v : TILES().VOID;
  };

  // furnitureAt(gx,gy) → first Furniture covering the cell, else null.
  World.furnitureAt = function (gx, gy) {
    var s = STATE();
    var L = s && s.layout;
    if (!L || !L.furniture) return null;
    var arr = L.furniture;
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      if (!f) continue;
      var w = f.w || 1, h = f.h || 1;
      if (gx >= f.gx && gx < f.gx + w && gy >= f.gy && gy < f.gy + h) return f;
    }
    return null;
  };

  /* ---------------------------------------------------------------------------
   * isWalkable(gx,gy [,opts]) → Boolean
   *   In-bounds AND tile ∈ {FLOOR,CARPET,DOOR,RUG} AND no BLOCKING furniture.
   *   Furniture that is `walkable` (chair, neonSign) does NOT block.
   *   opts.ignoreAgents (default true) — agents never block pathfinding here.
   * ------------------------------------------------------------------------- */
  var WALKABLE_TILES = null;
  function walkableTileSet() {
    if (WALKABLE_TILES) return WALKABLE_TILES;
    var T = TILES();
    WALKABLE_TILES = {};
    WALKABLE_TILES[T.FLOOR]  = true;
    WALKABLE_TILES[T.CARPET] = true;
    WALKABLE_TILES[T.DOOR]   = true;
    WALKABLE_TILES[T.RUG]    = true;
    // v3 decorative floor tiles — all WALKABLE (purely visual zones, never block).
    // Guarded with typeof so a legacy config without these keys can't poison the set.
    if (typeof T.WOOD      === 'number') WALKABLE_TILES[T.WOOD]      = true;
    if (typeof T.TILEFLOOR === 'number') WALKABLE_TILES[T.TILEFLOOR] = true;
    if (typeof T.GRASS     === 'number') WALKABLE_TILES[T.GRASS]     = true;
    if (typeof T.NEONFLOOR === 'number') WALKABLE_TILES[T.NEONFLOOR] = true;
    return WALKABLE_TILES;
  }

  World.isWalkable = function (gx, gy /*, opts */) {
    var t = World.tileAt(gx, gy);
    if (!walkableTileSet()[t]) return false;     // WALL / VOID / OOB
    var f = World.furnitureAt(gx, gy);
    if (f && f.walkable !== true) return false;  // blocking furniture
    return true;
  };

  // neighbors(gx,gy) → 4-dir walkable cells (no diagonals).
  var DIRS = [ {dx:0,dy:-1}, {dx:1,dy:0}, {dx:0,dy:1}, {dx:-1,dy:0} ];
  World.neighbors = function (gx, gy) {
    var out = [];
    for (var i = 0; i < 4; i++) {
      var nx = gx + DIRS[i].dx, ny = gy + DIRS[i].dy;
      if (World.isWalkable(nx, ny)) out.push({ gx: nx, gy: ny });
    }
    return out;
  };

  /* ===========================================================================
   * PATHFINDING — A* (Manhattan heuristic), 4-connected.
   *   findPath(start, goal) where start/goal = {gx,gy}.
   *   Returns waypoints EXCLUDING start, INCLUDING goal.
   *   [] when start==goal ; null when unreachable.
   *   Bounded by cell count; uses a binary-heap open set → never infinite-loops.
   * ========================================================================= */

  // Tiny binary min-heap keyed by node.f (good enough for a 30×20 grid).
  function Heap() { this.a = []; }
  Heap.prototype.push = function (node) {
    var a = this.a; a.push(node);
    var i = a.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      var tmp = a[p]; a[p] = a[i]; a[i] = tmp; i = p;
    }
  };
  Heap.prototype.pop = function () {
    var a = this.a;
    if (a.length === 0) return null;
    var top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0, n = a.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, sm = i;
        if (l < n && a[l].f < a[sm].f) sm = l;
        if (r < n && a[r].f < a[sm].f) sm = r;
        if (sm === i) break;
        var tmp = a[sm]; a[sm] = a[i]; a[i] = tmp; i = sm;
      }
    }
    return top;
  };
  Heap.prototype.size = function () { return this.a.length; };

  World.findPath = function (start, goal) {
    if (!start || !goal) return null;
    var sx = start.gx | 0, sy = start.gy | 0;
    var gx = goal.gx  | 0, gy = goal.gy  | 0;

    if (sx === gx && sy === gy) return [];          // already there
    if (!World.isWalkable(gx, gy)) return null;     // target not reachable
    // start may be non-walkable (e.g. seated on a desk seat that's fine, or an
    // edge case) — we still expand from it, but only step onto walkable cells.

    var s = STATE();
    var L = (s && s.layout) || {};
    var cols = L.cols || CFG().GRID_COLS;
    var rows = L.rows || CFG().GRID_ROWS;
    var maxCells = cols * rows;

    function key(x, y) { return y * cols + x; }
    function heur(x, y) { return Math.abs(x - gx) + Math.abs(y - gy); }

    var open = new Heap();
    var gScore = {};           // key -> best known cost from start
    var cameFrom = {};         // key -> {x,y}
    var closed = {};           // key -> true

    var startKey = key(sx, sy);
    gScore[startKey] = 0;
    open.push({ x: sx, y: sy, g: 0, f: heur(sx, sy) });

    var guard = 0, guardMax = maxCells * 8 + 64; // hard ceiling against any bug

    while (open.size() > 0) {
      if (++guard > guardMax) return null;       // paranoid: never spin forever
      var cur = open.pop();
      var ck = key(cur.x, cur.y);
      if (closed[ck]) continue;
      closed[ck] = true;

      if (cur.x === gx && cur.y === gy) {
        // reconstruct path (excl start, incl goal)
        var path = [];
        var k = ck;
        var node = { x: cur.x, y: cur.y };
        while (!(node.x === sx && node.y === sy)) {
          path.push({ gx: node.x, gy: node.y });
          var prev = cameFrom[k];
          if (!prev) break;                       // safety
          node = prev;
          k = key(node.x, node.y);
        }
        path.reverse();
        return path;
      }

      var nbrs = World.neighbors(cur.x, cur.y);
      for (var i = 0; i < nbrs.length; i++) {
        var n = nbrs[i];
        var nk = key(n.gx, n.gy);
        if (closed[nk]) continue;
        var tentative = cur.g + 1;
        if (!(nk in gScore) || tentative < gScore[nk]) {
          gScore[nk] = tentative;
          cameFrom[nk] = { x: cur.x, y: cur.y };
          open.push({ x: n.gx, y: n.gy, g: tentative, f: tentative + heur(n.gx, n.gy) });
        }
      }
    }
    return null; // exhausted -> unreachable
  };

  /* ===========================================================================
   * SEMANTIC CELL HELPERS — meeting seats, coffee seat, free desk seat.
   * These read the live layout so they keep working after layout edits.
   * ========================================================================= */

  // meetingSeats() → walkable ring cells around the meeting table.
  World.meetingSeats = function () {
    var s = STATE();
    var L = s && s.layout;
    if (!L || !L.furniture) return [];
    var table = null;
    for (var i = 0; i < L.furniture.length; i++) {
      if (L.furniture[i] && L.furniture[i].type === 'meetingTable') { table = L.furniture[i]; break; }
    }
    if (!table) return [];
    var w = table.w || 3, h = table.h || 2;
    var seats = [];
    var seen = {};
    function tryCell(cx, cy) {
      var k = cx + ',' + cy;
      if (seen[k]) return;
      seen[k] = true;
      if (World.isWalkable(cx, cy)) seats.push({ gx: cx, gy: cy });
    }
    // top & bottom rows
    for (var dx = 0; dx < w; dx++) {
      tryCell(table.gx + dx, table.gy - 1);
      tryCell(table.gx + dx, table.gy + h);
    }
    // left & right columns
    for (var dy = 0; dy < h; dy++) {
      tryCell(table.gx - 1, table.gy + dy);
      tryCell(table.gx + w, table.gy + dy);
    }
    return seats;
  };

  // breakSpots() → walkable cells in the lounge where an agent stands to take a
  //   break (near the coffee machine / sofa). Reads the live layout so it keeps
  //   working after edits. Falls back to coffeeTile() then any coffee neighbour.
  World.breakSpots = function () {
    var s = STATE();
    var L = s && s.layout;
    if (!L || !L.furniture) return [];
    var out = [];
    var seen = {};
    function add(cx, cy) {
      var k = cx + ',' + cy;
      if (seen[k]) return;
      seen[k] = true;
      if (World.isWalkable(cx, cy) && !World.furnitureAt(cx, cy)) {
        out.push({ gx: cx, gy: cy });
      }
    }
    // The lounge is tagged on furniture via `lounge:true` (set by defaultLayout).
    // Gather walkable cells immediately around any lounge furniture (coffee,
    // chairs, plants in the break room) — that's where agents loiter.
    var arr = L.furniture;
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      if (!f || f.lounge !== true) continue;
      // the seat cell if it has one
      if (typeof f.seatGx === 'number' && typeof f.seatGy === 'number') {
        add(f.seatGx, f.seatGy);
      }
      // walkable 4-neighbours of the footprint
      var w = f.w || 1, h = f.h || 1;
      for (var dx = -1; dx <= w; dx++) {
        add(f.gx + dx, f.gy - 1);
        add(f.gx + dx, f.gy + h);
      }
      for (var dy = 0; dy < h; dy++) {
        add(f.gx - 1, f.gy + dy);
        add(f.gx + w, f.gy + dy);
      }
    }
    if (out.length) return out;
    // Fallback: the coffee seat (or its neighbour) as a single spot.
    var ct = World.coffeeTile();
    return ct ? [ct] : [];
  };

  // coffeeTile() → seat cell of a coffee machine (or null).
  World.coffeeTile = function () {
    var s = STATE();
    var L = s && s.layout;
    if (!L || !L.furniture) return null;
    for (var i = 0; i < L.furniture.length; i++) {
      var f = L.furniture[i];
      if (f && f.type === 'coffee') {
        if (typeof f.seatGx === 'number' && typeof f.seatGy === 'number'
            && World.isWalkable(f.seatGx, f.seatGy)) {
          return { gx: f.seatGx, gy: f.seatGy };
        }
        // fall back to any walkable neighbour of the machine
        var nb = World.neighbors(f.gx, f.gy);
        if (nb.length) return { gx: nb[0].gx, gy: nb[0].gy };
      }
    }
    return null;
  };

  // freeDeskCell() → an unoccupied desk seat (for new/temp agents), else null.
  World.freeDeskCell = function () {
    var s = STATE();
    var L = s && s.layout;
    if (!L || !L.furniture) return null;
    var agents = (s && s.agents) || [];

    function seatTaken(gx, gy) {
      for (var a = 0; a < agents.length; a++) {
        if (agents[a] && agents[a].gx === gx && agents[a].gy === gy) return true;
      }
      return false;
    }

    for (var i = 0; i < L.furniture.length; i++) {
      var f = L.furniture[i];
      if (!f || f.type !== 'desk') continue;
      if (typeof f.seatGx !== 'number' || typeof f.seatGy !== 'number') continue;
      if (!World.isWalkable(f.seatGx, f.seatGy)) continue;
      if (!seatTaken(f.seatGx, f.seatGy)) return { gx: f.seatGx, gy: f.seatGy };
    }
    // No free desk seat → return any walkable cell not on an agent (graceful).
    for (var gy = 1; gy < (L.rows || 20) - 1; gy++) {
      for (var gx = 1; gx < (L.cols || 30) - 1; gx++) {
        if (World.isWalkable(gx, gy) && !seatTaken(gx, gy) && !World.furnitureAt(gx, gy)) {
          return { gx: gx, gy: gy };
        }
      }
    }
    return null;
  };

  /* ===========================================================================
   * DEFAULT LAYOUT — the seeded neon office (v8: enlarged, multi-ROOM).
   *   Deterministic. 54×36 grid, walled outer ring, one bottom DOOR.
   *
   *   Room map (top → bottom; interior walls with DOOR gaps between rooms):
   *     ┌───────── BOSS OFFICE (cyan CARPET, top-center) ─────────┐
   *     │  ENGINEERING BAY (left)   │   DESIGN STUDIO (right)      │
   *     │  RESEARCH LAB (left)      │   MEETING ROOM (purple RUG)  │
   *     │  LOUNGE / BREAK ROOM (coffee + sofa-chairs + plants)     │
   *     └──────────────────────────────────────────────────────────┘
   *
   *   10 desks total (1 boss + 3 engineering + 3 design + 3 research) so a full
   *   10-person company AND temp workers get seats. The seeded agents' desks are
   *   placed FIRST (in this order) so Store.seed lines up:
   *     index 0 = Boss       → bossDesk.seat
   *     index 1 = Engineer   → engDesk.seat   (Engineering bay)
   *     index 2 = Designer   → desDesk.seat   (Design studio)
   *     index 3 = Researcher → resDesk.seat   (Research lab)
   *   The remaining 6 desks (spare engineering/design/research) are free for
   *   writer/qa/generalist + temps via freeDeskCell().
   *
   *   This builder is robust to the grid being 30×20 (legacy) / 46×30 (v2) /
   *   54×36 (v8): it derives every position from cols/rows, never hardcoding a
   *   size, and the three 3rd desks are guarded so short grids skip them cleanly.
   * ========================================================================= */
  World.defaultLayout = function () {
    var c = CFG();
    var T = TILES();
    var FD = FURN();
    var cols = c.GRID_COLS;   // 46 (v2)
    var rows = c.GRID_ROWS;   // 30 (v2)

    // --- 1) tiles: fill VOID, carve a walled FLOOR rectangle inside the border ---
    var tiles = [];
    for (var gy = 0; gy < rows; gy++) {
      var row = [];
      for (var gx = 0; gx < cols; gx++) row.push(T.VOID);
      tiles.push(row);
    }
    // Interior playable rect: x in [1, cols-2], y in [1, rows-2]; walls on the ring.
    var x0 = 1, y0 = 1, x1 = cols - 2, y1 = rows - 2;
    for (var yy = y0 - 1; yy <= y1 + 1; yy++) {
      for (var xx = x0 - 1; xx <= x1 + 1; xx++) {
        if (yy < 0 || xx < 0 || yy >= rows || xx >= cols) continue;
        var onRing = (yy === y0 - 1 || yy === y1 + 1 || xx === x0 - 1 || xx === x1 + 1);
        tiles[yy][xx] = onRing ? T.WALL : T.FLOOR;
      }
    }
    // Door on bottom wall, center-ish.
    var doorX = Math.floor(cols / 2);
    tiles[y1 + 1][doorX] = T.DOOR;

    // helper to paint a rectangular tile patch (clamped to interior)
    function paint(px, py, pw, ph, tile) {
      for (var ry = 0; ry < ph; ry++) {
        for (var rx = 0; rx < pw; rx++) {
          var tx = px + rx, ty = py + ry;
          if (ty >= y0 && ty <= y1 && tx >= x0 && tx <= x1) tiles[ty][tx] = tile;
        }
      }
    }
    // helper to draw an interior WALL segment (horizontal or vertical run),
    // clamped to interior; nothing on the outer ring.
    function wallH(px, py, len) {
      for (var i = 0; i < len; i++) {
        var tx = px + i;
        if (py >= y0 && py <= y1 && tx >= x0 && tx <= x1) tiles[py][tx] = T.WALL;
      }
    }
    function wallV(px, py, len) {
      for (var j = 0; j < len; j++) {
        var ty = py + j;
        if (ty >= y0 && ty <= y1 && px >= x0 && px <= x1) tiles[ty][px] = T.WALL;
      }
    }
    // punch a DOOR gap (single walkable DOOR tile) into a wall cell
    function door(px, py) {
      if (py >= y0 && py <= y1 && px >= x0 && px <= x1) tiles[py][px] = T.DOOR;
    }

    // --- 2) room partitions ----------------------------------------------------
    // Strategy: keep a central vertical FLOOR corridor (column `corrX`) that is
    // NEVER walled, so it always connects every band top→bottom. Room divider
    // walls are placed and then DOORED onto that corridor (or onto a guaranteed
    // FLOOR neighbour), so connectivity is structural, not luck.
    //
    // Vertical heights derive from the interior so legacy 30×20 still works.
    //   bossBot : bottom wall row of the boss office band
    //   midBot  : wall row between the upper bays and the lower labs
    //   labBot  : wall row above the lounge / break room band
    var corrX   = Math.floor((x0 + x1) / 2);     // central corridor column (always FLOOR)
    var bossBot = y0 + Math.max(3, Math.floor((rows - 2) * 0.18));   // ~ row 6 @30
    var midBot  = y0 + Math.max(7, Math.floor((rows - 2) * 0.45));   // ~ row 13 @30
    var labBot  = y0 + Math.max(11, Math.floor((rows - 2) * 0.72));  // ~ row 21 @30
    // Robustness (legacy 30×20): the lower band (midBot..labBot) holds the 3×2
    // meeting table, which needs a walkable ring on all sides. Guarantee at least
    // 4 interior rows there so the table can never seal its own seats. Also keep
    // a 2-row lounge below labBot. (No-op on the v2 46×30 grid where the bands are
    // already roomy.) Clamp so the bands never invert on a tiny grid.
    labBot = Math.max(labBot, midBot + 5);
    if (labBot > y1 - 2) labBot = Math.max(midBot + 3, y1 - 2);
    if (midBot >= labBot) midBot = Math.max(bossBot + 2, labBot - 3);
    if (bossBot >= midBot) bossBot = Math.max(y0 + 2, midBot - 2);

    // Vertical divider walls between left/right rooms, placed OFF the corridor so
    // the corridor itself stays open. Left wall at corrX-1, right wall at corrX+1.
    var leftWallX  = corrX - 1;
    var rightWallX = corrX + 1;

    // Horizontal wall under the boss office, then re-open the corridor crossing.
    wallH(x0, bossBot, (x1 - x0 + 1));

    // Vertical divider walls span from below the boss office to the lounge wall.
    wallV(leftWallX,  bossBot + 1, (labBot - (bossBot + 1) + 1));
    wallV(rightWallX, bossBot + 1, (labBot - (bossBot + 1) + 1));

    // Horizontal wall between upper bays and lower labs.
    wallH(x0, midBot, (x1 - x0 + 1));
    // Horizontal wall above the lounge (full width).
    wallH(x0, labBot, (x1 - x0 + 1));

    // Keep the central corridor (corrX) carved FLOOR through EVERY wall row, so
    // boss→bays→labs→lounge is one continuous spine. (Re-FLOOR, overriding walls.)
    for (var cy = y0; cy <= y1; cy++) tiles[cy][corrX] = T.FLOOR;

    // Now DOOR each room off the corridor:
    // Engineering bay (upper-left): door in its east wall (leftWallX) mid-band.
    door(leftWallX,  bossBot + Math.max(2, Math.floor((midBot - bossBot) / 2)));
    // Design studio (upper-right): door in its west wall (rightWallX) mid-band.
    door(rightWallX, bossBot + Math.max(2, Math.floor((midBot - bossBot) / 2)));
    // Research lab (lower-left): door in its east wall mid-band.
    door(leftWallX,  midBot + Math.max(2, Math.floor((labBot - midBot) / 2)));
    // Meeting room (lower-right): door in its west wall mid-band.
    door(rightWallX, midBot + Math.max(2, Math.floor((labBot - midBot) / 2)));

    // --- 3) zone tiles (carpet / rug) -----------------------------------------
    // Boss office: cyan CARPET band across the top room.
    var bossCx = corrX;
    paint(bossCx - 3, y0, 7, (bossBot - y0), T.CARPET);

    // Meeting room: purple RUG in the lower-right room (between midBot & labBot,
    // right of the central wall).
    var meetX = corrX + Math.max(3, Math.floor((x1 - corrX) / 4));
    var meetY = midBot + 2;
    var meetW = Math.min(7, x1 - meetX);
    var meetH = Math.min(5, labBot - meetY);
    if (meetW < 5) { meetX = x1 - 6; meetW = 6; }     // keep room for a 3x2 table
    paint(meetX, meetY, meetW, meetH, T.RUG);

    // --- 3b) decorative FLOOR ZONES (v3) --------------------------------------
    // New tiles WOOD/TILEFLOOR/GRASS/NEONFLOOR are all walkable, so painting them
    // anywhere inside the interior can NEVER block movement. We only repaint cells
    // that are already open floor (paint() clamps to the interior rect and we keep
    // OFF the corridor column / door cells so the look stays clean — connectivity is
    // unaffected either way). Guard each tile read with a numeric fallback so a
    // legacy config without these keys degrades to plain FLOOR instead of NaN.
    var WOOD      = (typeof T.WOOD      === 'number') ? T.WOOD      : T.FLOOR;
    var TILEFLOOR = (typeof T.TILEFLOOR === 'number') ? T.TILEFLOOR : T.FLOOR;
    var GRASS     = (typeof T.GRASS     === 'number') ? T.GRASS     : T.FLOOR;
    var NEONFLOOR = (typeof T.NEONFLOOR === 'number') ? T.NEONFLOOR : T.FLOOR;

    // paintIf: like paint() but skips the corridor column + any DOOR cell, so a
    // decorative repaint can never visually swallow the spine or a doorway.
    function paintIf(px, py, pw, ph, tile) {
      for (var ry = 0; ry < ph; ry++) {
        for (var rx = 0; rx < pw; rx++) {
          var tx = px + rx, ty = py + ry;
          if (ty < y0 || ty > y1 || tx < x0 || tx > x1) continue;
          if (tx === corrX) continue;                 // never repaint the spine
          if (tiles[ty][tx] === T.DOOR) continue;     // never repaint a doorway
          if (tiles[ty][tx] === T.WALL) continue;     // never repaint walls
          tiles[ty][tx] = tile;
        }
      }
    }

    // RECEPTION foyer: warm WOOD planks framing the entrance door at the bottom.
    paintIf(doorX - 3, y1 - 2, 7, 3, WOOD);

    // KITCHEN / PANTRY: tiled hygienic floor in the lounge's left third.
    var kitchenX = x0 + 1;
    var kitchenY = labBot + 1;
    paintIf(kitchenX, kitchenY, 5, Math.max(2, y1 - kitchenY + 1), TILEFLOOR);

    // LOUNGE core: cozy WOOD floor across the lounge center band.
    paintIf(corrX - 5, labBot + 1, 11, Math.max(2, y1 - (labBot + 1) + 1), WOOD);

    // ATRIUM: a GRASS patch in the lounge's right third (greenery zone).
    var atriumX = x1 - 5;
    var atriumY = labBot + 1;
    paintIf(atriumX, atriumY, 5, Math.max(2, y1 - atriumY + 1), GRASS);

    // NEONFLOOR accents in the department rooms (glowing strips, walkable).
    paintIf(bossCx - 3, bossBot - 1, 7, 1, NEONFLOOR);          // boss office front strip
    paintIf(corrX - 5, midBot - 1, 4, 1, NEONFLOOR);            // engineering bay strip
    paintIf(corrX + 2, midBot - 1, 4, 1, NEONFLOOR);            // design studio strip
    paintIf(corrX - 5, labBot - 1, 4, 1, NEONFLOOR);            // research lab strip

    // --- 4) furniture builder -------------------------------------------------
    var furniture = [];
    var fid = 0;
    function nextId() { return 'f_seed_' + (fid++); }

    // Compute the standing seat cell for a piece on the given side (`dir`).
    function seatFor(type, gx, gy, dir, w, h) {
      var def = FD[type] || {};
      if (!def.hasSeat) return { sx: null, sy: null };
      // The seat is a walkable cell adjacent to the footprint on the `dir` side.
      // Convention used by sprites: dir = the direction the prop FACES (toward
      // the user/seat). e.g. a desk facing 'down' is used from below.
      var sx, sy;
      switch (dir) {
        case 'up':    sx = gx + ((w - 1) >> 1); sy = gy - 1;     break;
        case 'down':  sx = gx + ((w - 1) >> 1); sy = gy + h;     break;
        case 'left':  sx = gx - 1;              sy = gy + ((h - 1) >> 1); break;
        case 'right': sx = gx + w;              sy = gy + ((h - 1) >> 1); break;
        default:      sx = gx + ((w - 1) >> 1); sy = gy + h;     break;
      }
      return { sx: sx, sy: sy };
    }

    function place(type, gx, gy, dir, extra) {
      var def = FD[type] || { w: 1, h: 1, blocks: true, hasSeat: false };
      var w = def.w || 1, h = def.h || 1;
      var seat = seatFor(type, gx, gy, dir, w, h);
      var f = {
        id: nextId(),
        type: type,
        gx: gx, gy: gy,
        dir: dir || 'down',
        w: w, h: h,
        // walkable = does NOT block pathfinding. SPEC: chair & neonSign don't block.
        walkable: (def.blocks === false),
        seatGx: seat.sx,
        seatGy: seat.sy,
      };
      if (extra) { for (var k in extra) if (extra.hasOwnProperty(k)) f[k] = extra[k]; }
      // A seeded chair sits ON a desk's seat cell; its own computed seat would land
      // on the (blocking) desk footprint, so it's not a valid walk target. Null it.
      if (type === 'chair') { f.seatGx = null; f.seatGy = null; }
      furniture.push(f);
      return f;
    }

    // ===== BOSS OFFICE (top-center, cyan carpet) =====
    // Desk 2x1 facing DOWN; seat directly below center.
    var bossDeskX = bossCx - 1;
    var bossDeskY = y0 + 1;
    var bossDesk = place('desk', bossDeskX, bossDeskY, 'down');
    place('chair', bossDesk.seatGx, bossDesk.seatGy, 'up');
    place('server', bossDeskX + 3, bossDeskY, 'down');           // rack beside the desk
    place('neonSign', bossCx, y0, 'down');                       // logo on back wall row
    place('plant', bossCx - 3, bossDeskY, 'down');
    // Boss office flair: a TV on the back wall + a potted tree in the far corner.
    place('tv', bossCx + 1, y0, 'down');                         // back-wall display
    place('pottedTree', bossCx + 3, bossDeskY, 'down');          // accent greenery

    // ===== ENGINEERING BAY (upper-left room) =====
    // Two desks facing the central corridor (seat to the RIGHT, toward corridor).
    var engColX  = corrX - 4;                       // desk spans engColX..engColX+1
    var engRowTop = bossBot + 2;
    var engRowBot = bossBot + Math.max(4, Math.floor((midBot - bossBot) * 0.6));
    // index 1: Engineer (seeded) — upper engineering desk
    var engDesk = place('desk', engColX, engRowTop, 'right');
    place('chair', engDesk.seatGx, engDesk.seatGy, 'left');
    // spare engineering desk (free for temps)
    var engDesk2 = place('desk', engColX, engRowBot, 'right');
    place('chair', engDesk2.seatGx, engDesk2.seatGy, 'left');
    // v8: third engineering desk (free for temps) — the enlarged grid makes the bay
    // tall enough for a third row of seating below engDesk2. Guarded so it is only
    // placed when an interior row remains above the room's south wall (midBot).
    var engRow3 = engRowBot + 2;
    if (engRow3 <= midBot - 1) {
      var engDesk3 = place('desk', engColX, engRow3, 'right');
      place('chair', engDesk3.seatGx, engDesk3.seatGy, 'left');
    }
    place('server', x0, engRowTop, 'down');        // a little server rack in the bay
    place('plant', engColX, (engRowTop + engRowBot) >> 1, 'down');
    // Engineering flair: a whiteboard + printer + bookshelf along the far wall.
    place('whiteboard', engColX, engRowTop - 1, 'down');         // sprint board over the desks
    place('printer', x0 + 2, engRowBot, 'down');                 // shared printer (mirrors the lab printer; sits clear of the bookshelf so no 1-cell dead pocket forms in the taller bay)
    place('bookshelf', x0 + 1, engRowTop, 'down');               // 1x2 reference shelf

    // ===== DESIGN STUDIO (upper-right room) =====
    // Two desks facing the corridor (seat to the LEFT, toward corridor).
    var desColX  = corrX + 4;
    var desRowTop = bossBot + 2;
    var desRowBot = bossBot + Math.max(4, Math.floor((midBot - bossBot) * 0.6));
    // index 2: Designer (seeded) — upper design desk
    var desDesk = place('desk', desColX, desRowTop, 'left');
    place('chair', desDesk.seatGx, desDesk.seatGy, 'right');
    // spare design desk (free for temps)
    var desDesk2 = place('desk', desColX, desRowBot, 'left');
    place('chair', desDesk2.seatGx, desDesk2.seatGy, 'right');
    // v8: third design desk (free for temps) — fits in the enlarged studio below
    // desDesk2. Same guard as engineering so legacy/short grids skip it cleanly.
    var desRow3 = desRowBot + 2;
    if (desRow3 <= midBot - 1) {
      var desDesk3 = place('desk', desColX, desRow3, 'left');
      place('chair', desDesk3.seatGx, desDesk3.seatGy, 'right');
    }
    place('whiteboard', desColX, desRowTop - 1, 'down');   // studio whiteboard
    place('plant', desColX + 1, (desRowTop + desRowBot) >> 1, 'down');
    // Design flair: a mood-board TV + printer + potted tree along the far wall.
    place('tv', x1 - 1, desRowTop, 'down');                      // 2x1 mood-board display
    place('printer', x1, desRowBot, 'down');                     // studio printer
    place('pottedTree', x1, desRowBot + 1, 'down');              // accent greenery (clear of TV/printer)

    // ===== RESEARCH LAB (lower-left room) =====
    var resColX  = corrX - 4;
    var resRowTop = midBot + 2;
    var resRowBot = midBot + Math.max(4, Math.floor((labBot - midBot) * 0.55));
    // index 3: Researcher (seeded) — upper research desk
    var resDesk = place('desk', resColX, resRowTop, 'right');
    place('chair', resDesk.seatGx, resDesk.seatGy, 'left');
    // spare research desk (free for temps)
    var resDesk2 = place('desk', resColX, resRowBot, 'right');
    place('chair', resDesk2.seatGx, resDesk2.seatGy, 'left');
    // v8: third research desk (free for temps) — the enlarged lab has room for a
    // third row below resDesk2. Guarded against the lab's south wall (labBot).
    var resRow3 = resRowBot + 2;
    if (resRow3 <= labBot - 1) {
      var resDesk3 = place('desk', resColX, resRow3, 'right');
      place('chair', resDesk3.seatGx, resDesk3.seatGy, 'left');
    }
    // research server racks (datacenter-ish cluster in the lab corner)
    place('server', x0, resRowTop, 'down');
    place('server', x0, resRowTop + 1, 'down');
    place('plant', resColX, (resRowTop + resRowBot) >> 1, 'down');
    // Research flair: a whiteboard, a reference bookshelf, and a printer.
    place('whiteboard', resColX, resRowTop - 1, 'down');         // hypotheses board
    place('bookshelf', x0, resRowBot + 1, 'down');               // 1x2 papers shelf (below the server stack)
    place('printer', x0 + 2, resRowBot, 'down');                 // lab printer

    // ===== MEETING ROOM (lower-right, purple rug + meetingTable) =====
    var tableX = meetX + Math.floor((meetW - 3) / 2);    // center the 3-wide table
    var tableY = meetY + Math.floor((meetH - 2) / 2);
    place('meetingTable', tableX, tableY, 'up');
    place('whiteboard', tableX, meetY - 1, 'down');      // whiteboard above the rug
    place('plant', meetX + meetW - 1, meetY, 'down');
    // Meeting flair: a presentation TV + a potted tree in the room corner.
    // Place against the room's far-right wall, clear of the table's seat ring.
    place('tv', x1 - 1, meetY - 1, 'down');                      // 2x1 presentation screen
    place('pottedTree', x1, labBot - 1, 'down');                 // corner greenery

    // ===== LOUNGE / BREAK ROOM (bottom band, full width below labBot) =====
    // Richer break room: coffee + sofas + arcade + tv + rug + potted trees, plus a
    // KITCHEN/PANTRY on the left and a GRASS ATRIUM on the right. Everything that is
    // a loiter target keeps lounge:true so World.breakSpots() still finds it.
    //
    // Layout reference (v2 46x30): lounge band y in [labBot+1 .. y1] = [22..28];
    // corrX=22 spine + doorX=23 entrance approach must stay clear. We keep all
    // blocking lounge furniture OFF columns corrX and doorX in the two bottom rows
    // so the door->corridor path is never sealed; the connectivity guard below is a
    // final backstop. All coordinates are clamped to the interior by place().
    var loungeTop = labBot + 1;                      // first lounge row
    var loungeY = labBot + 2;                        // a working row inside the lounge
    if (loungeY > y1) loungeY = y1;                  // legacy-grid safety
    var sofaY = Math.min(y1, loungeY + 1);

    // A small rug under the lounge seating cluster for warmth (walkable tile).
    paintIf(corrX - 5, loungeTop, 5, Math.max(2, sofaY - loungeTop + 1), T.RUG);

    // --- Coffee corner (just left of the spine) ---
    var coffeeX = corrX - 2;
    var coffeeY = loungeTop;
    if (coffeeY > y1) coffeeY = y1;
    place('coffee', coffeeX, coffeeY, 'down', { lounge: true });  // seat below it
    place('pottedTree', corrX - 6, coffeeY, 'down', { lounge: true }); // greenery left of the sofas

    // --- Sofa lounge: two real sofas (2x1) facing a TV, with potted trees ---
    // Left sofa + right sofa flanking the rug; both tagged lounge for loiter cells.
    place('sofa', corrX - 5, sofaY, 'up', { lounge: true });      // 2x1, seat above
    place('sofa', corrX - 2, sofaY, 'up', { lounge: true });      // 2x1, seat above
    place('tv', corrX - 4, loungeTop, 'down', { lounge: true });  // wall-mounted screen
    place('pottedTree', corrX - 5, loungeTop, 'down', { lounge: true });

    // --- Arcade nook (right of the spine, clear of the door column) ---
    place('arcade', corrX + 3, sofaY, 'down', { lounge: true });
    place('sofa', corrX + 4, sofaY - 1, 'down', { lounge: true });// chill sofa by arcade
    place('pottedTree', corrX + 6, sofaY, 'down', { lounge: true });

    // --- KITCHEN / PANTRY (far-left of the lounge, TILEFLOOR zone) ---
    // fridge + waterCooler + a coffee counter + small pantry-table chairs.
    place('fridge', x0, loungeTop, 'down', { lounge: true });
    place('waterCooler', x0 + 1, loungeTop, 'down', { lounge: true });
    place('coffee', x0 + 3, loungeTop, 'down', { lounge: true });  // counter machine
    // Small pantry seating: two chairs on the lower kitchen row (loiter cells).
    place('chair', x0, sofaY, 'down', { lounge: true });
    place('chair', x0 + 2, sofaY, 'down', { lounge: true });

    // --- LIBRARY / quiet nook (left-center, bookshelves + chairs + rug) ---
    // Sits between the kitchen and the sofa cluster on the lowest lounge row.
    var libX = corrX - 9;
    if (libX < x0) libX = x0 + 5;
    paintIf(libX, loungeTop, 3, Math.max(2, y1 - loungeTop + 1), WOOD);
    place('bookshelf', libX, loungeTop, 'down', { lounge: true }); // 1x2 shelf
    place('bookshelf', libX + 2, loungeTop, 'down', { lounge: true });
    place('chair', libX + 1, sofaY, 'down', { lounge: true });     // reading chair

    // --- ATRIUM (far-right GRASS patch): potted trees + greenery ---
    place('pottedTree', atriumX, loungeTop, 'down', { lounge: true });
    place('pottedTree', atriumX + 2, loungeTop, 'down', { lounge: true });
    place('plant', atriumX + 4, loungeTop, 'down', { lounge: true });

    // Break-room neon sign for flavor (non-blocking) just off the spine.
    place('neonSign', corrX - 1, loungeTop, 'down', { lounge: true });

    // ===== RECEPTION (near the entrance door, WOOD foyer painted above) =====
    // Reception desk + rug + plants + neon logo, set to one side of the door so the
    // doorway approach column stays open. doorX is the bottom-wall door; the foyer
    // WOOD was painted at [doorX-3 .. doorX+3] x [y1-2 .. y1].
    var recX = doorX - 3;                            // reception desk left of the door
    if (recX < x0) recX = x0;
    place('reception', recX, y1 - 1, 'down', { reception: true }); // 2x1, faces visitors
    place('neonSign', recX, y1 - 2, 'down', { reception: true });  // logo over the desk
    place('pottedTree', doorX - 4, y1, 'down', { reception: true });
    place('pottedTree', doorX + 3, y1, 'down', { reception: true });

    // ===== DATACENTER cluster (bottom-right corner): a few server racks =====
    var dcX = x1, dcY = y1;
    place('server', dcX,     dcY, 'down');
    place('server', dcX - 1, dcY, 'down');
    place('server', dcX,     dcY - 1, 'down');

    // --- 5) connectivity guard --------------------------------------------------
    // The central corridor (corrX) is the structural spine that joins every band
    // (boss → bays → labs → lounge). It is carved FLOOR through each wall row, but
    // decorative BLOCKING furniture placed on the corridor AT a band-crossing row
    // (or the lounge entry just below labBot) would seal a band off. Drop any such
    // piece so the spine is always walkable. (Furniture inside open rooms is fine.)
    var spineRows = [bossBot, midBot, labBot, labBot + 1, labBot + 2];
    furniture = furniture.filter(function (f) {
      if (f.walkable) return true;                 // non-blocking props never seal a path
      for (var fx = f.gx; fx < f.gx + (f.w || 1); fx++) {
        for (var fy = f.gy; fy < f.gy + (f.h || 1); fy++) {
          if (fx === corrX && spineRows.indexOf(fy) !== -1) return false; // would seal the spine
        }
      }
      return true;
    });

    return { cols: cols, rows: rows, tiles: tiles, furniture: furniture };
  };

  /* ===========================================================================
   * WAVE 4a section OFFICE UPGRADES — applyUpgrade / reapplyUpgrades.
   *   Consume App.config.OFFICE_UPGRADES entries and install their furniture or
   *   flair onto App.state.layout. Idempotent (guarded by App.state.upgrades) and
   *   connectivity-safe: blocking furniture is only placed on a cell whose removal
   *   does NOT disconnect any reachable walkable cell from the rest of the floor.
   *   Best-effort: if no valid spot exists for a piece, it is silently skipped.
   *   Never throws (callers wrap, but we are defensive anyway).
   * ========================================================================= */

  // Count walkable cells reachable from `start` (4-connected) given an extra set
  // of cells to treat as BLOCKED (passed as a {key:true} map). Pure flood fill.
  function reachableCount(start, cols, rows, blockedSet) {
    if (!start) return 0;
    var seen = {};
    var stack = [start];
    var count = 0;
    function k(x, y) { return y * cols + x; }
    var sk = k(start.gx, start.gy);
    seen[sk] = true;
    var guard = 0, guardMax = cols * rows + 8;
    while (stack.length) {
      if (++guard > guardMax) break;     // paranoid bound
      var cur = stack.pop();
      count++;
      for (var i = 0; i < 4; i++) {
        var nx = cur.gx + DIRS[i].dx, ny = cur.gy + DIRS[i].dy;
        var nk = k(nx, ny);
        if (seen[nk]) continue;
        if (blockedSet && blockedSet[nk]) continue;   // treated as blocked
        if (!World.isWalkable(nx, ny)) continue;
        seen[nk] = true;
        stack.push({ gx: nx, gy: ny });
      }
    }
    return count;
  }

  // Find an interior walkable+empty cell satisfying `pred` whose blocking would
  // NOT disconnect the floor (only checked when `blocking` is true). Scans the
  // interior deterministically. Returns {gx,gy} or null. `taken` is a {key:true}
  // map of cells already claimed within THIS apply pass (so multiple pieces in one
  // upgrade don't stack or collectively wall off a region).
  function findPlacementCell(cols, rows, blocking, taken) {
    function k(x, y) { return y * cols + x; }
    // Reference anchor for connectivity: any walkable cell (use first found).
    var anchor = null;
    for (var ay = 1; ay < rows - 1 && !anchor; ay++) {
      for (var ax = 1; ax < cols - 1; ax++) {
        if (World.isWalkable(ax, ay)) { anchor = { gx: ax, gy: ay }; break; }
      }
    }
    if (!anchor) return null;
    // Baseline reachable count WITH the cells already taken this pass blocked.
    var baseBlocked = {};
    for (var tk in taken) if (taken.hasOwnProperty(tk)) baseBlocked[tk] = true;
    var baseReach = reachableCount(anchor, cols, rows, baseBlocked);

    for (var gy = 1; gy < rows - 1; gy++) {
      for (var gx = 1; gx < cols - 1; gx++) {
        var ck = k(gx, gy);
        if (taken[ck]) continue;
        if (!World.isWalkable(gx, gy)) continue;       // must be open floor now
        if (World.furnitureAt(gx, gy)) continue;       // don't stack on furniture
        if (gx === anchor.gx && gy === anchor.gy) continue; // keep an anchor open
        if (!blocking) return { gx: gx, gy: gy };      // non-blocking: any open cell
        // Blocking: ensure removing this cell keeps everything reachable.
        var test = {};
        for (var bk in baseBlocked) if (baseBlocked.hasOwnProperty(bk)) test[bk] = true;
        test[ck] = true;
        // After blocking this cell the reachable set must shrink by exactly 1
        // (the cell itself) — i.e. it didn't cut anything else off.
        var newReach = reachableCount(anchor, cols, rows, test);
        if (newReach === baseReach - 1) return { gx: gx, gy: gy };
      }
    }
    return null;
  }

  // Push ONE furniture piece of `type` onto the layout at a safe spot. Returns the
  // placed furniture object or null if no room. `taken` tracks cells claimed in
  // this pass. `extra` merges onto the piece (e.g. {lounge:true}).
  function placeUpgradeFurniture(L, type, taken, extra) {
    var FD = FURN();
    var def = FD[type] || { w: 1, h: 1, blocks: true, hasSeat: false };
    // Only support 1x1 decorative pieces for upgrades (plant/server/neonSign/
    // coffee/chair/whiteboard). For multi-cell types we still place the anchor
    // cell + require its full footprint to be free & connectivity-safe.
    var w = def.w || 1, h = def.h || 1;
    var blocking = (def.blocks !== false);
    var cols = L.cols || CFG().GRID_COLS;
    var rows = L.rows || CFG().GRID_ROWS;

    // For 1x1 the generic finder is enough; for >1 footprint, fall back to 1x1
    // search of the anchor and verify the whole footprint is open + safe.
    function k(x, y) { return y * cols + x; }
    var spot = null;

    if (w === 1 && h === 1) {
      spot = findPlacementCell(cols, rows, blocking, taken);
    } else {
      // multi-cell: scan for an anchor whose entire footprint is open, then
      // verify connectivity by blocking the whole footprint at once.
      var anchor = null;
      for (var ay = 1; ay < rows - 1 && !anchor; ay++) {
        for (var ax = 1; ax < cols - 1; ax++) {
          if (World.isWalkable(ax, ay)) { anchor = { gx: ax, gy: ay }; break; }
        }
      }
      if (anchor) {
        var baseBlocked = {};
        for (var tkk in taken) if (taken.hasOwnProperty(tkk)) baseBlocked[tkk] = true;
        var baseReach = reachableCount(anchor, cols, rows, baseBlocked);
        outer:
        for (var fy = 1; fy < rows - 1 - (h - 1); fy++) {
          for (var fx = 1; fx < cols - 1 - (w - 1); fx++) {
            var foot = [];
            var ok = true;
            for (var ddy = 0; ddy < h && ok; ddy++) {
              for (var ddx = 0; ddx < w; ddx++) {
                var cx = fx + ddx, cy = fy + ddy, kk = k(cx, cy);
                if (taken[kk] || !World.isWalkable(cx, cy) || World.furnitureAt(cx, cy)) { ok = false; break; }
                foot.push(kk);
              }
            }
            if (!ok) continue;
            if (!blocking) { spot = { gx: fx, gy: fy }; break outer; }
            var test = {};
            for (var bk2 in baseBlocked) if (baseBlocked.hasOwnProperty(bk2)) test[bk2] = true;
            for (var fi = 0; fi < foot.length; fi++) test[foot[fi]] = true;
            var newReach = reachableCount(anchor, cols, rows, test);
            if (newReach === baseReach - foot.length) { spot = { gx: fx, gy: fy }; break outer; }
          }
        }
      }
    }

    if (!spot) return null;

    var f = {
      id: 'f_upg_' + (L._upgFid = (L._upgFid || 0) + 1),
      type: type,
      gx: spot.gx, gy: spot.gy,
      dir: (extra && extra.dir) || 'down',
      w: w, h: h,
      walkable: (def.blocks === false),
      seatGx: null, seatGy: null,
      upgrade: true
    };
    if (extra) {
      for (var ek in extra) {
        if (extra.hasOwnProperty(ek) && ek !== 'dir' && ek !== 'count' && ek !== 'extras') f[ek] = extra[ek];
      }
    }
    L.furniture.push(f);
    // Mark every footprint cell as taken for this pass.
    for (var oy = 0; oy < h; oy++) {
      for (var ox = 0; ox < w; ox++) taken[k(spot.gx + ox, spot.gy + oy)] = true;
    }
    return f;
  }

  /* ---------------------------------------------------------------------------
   * applyUpgrade(id) -> Boolean (true if newly applied)
   *   Looks up the OFFICE_UPGRADES entry and installs its furniture/flair onto
   *   App.state.layout. IDEMPOTENT: no-op (returns false) if `id` is already in
   *   App.state.upgrades. Does NOT itself push to state.upgrades — the caller
   *   (UI buy flow / reapplyUpgrades) owns that list — EXCEPT reapply, which sets
   *   it before calling. We guard on membership so double-calls are harmless.
   * ------------------------------------------------------------------------- */
  World.applyUpgrade = function (id) {
    try {
      if (!id) return false;
      var s = STATE();
      if (!s) return false;
      var L = s.layout;
      if (!L || !L.tiles) return false;
      if (!Array.isArray(L.furniture)) L.furniture = [];

      var def = (CFG().upgradeById ? CFG().upgradeById(id) : null);
      if (!def) return false;

      // Idempotency: skip if this id is already recorded AND already installed.
      // We detect prior install via a per-layout applied set so reapply on a
      // fresh layout (after load) re-installs correctly.
      if (!L._appliedUpgrades) L._appliedUpgrades = {};
      if (L._appliedUpgrades[id]) return false;

      var spec = def.spec || {};

      if (def.kind === 'flair') {
        if (!L.flair) L.flair = {};
        if (spec.flag) L.flair[spec.flag] = (typeof spec.value === 'undefined') ? true : spec.value;
        L._appliedUpgrades[id] = true;
        return true;
      }

      // kind === 'furniture' (default): place `count` pieces + any `extras`.
      var taken = {};
      // Seed `taken` with all currently-blocking furniture footprints so we never
      // try to drop a piece onto an existing prop and so connectivity baseline is
      // measured against the live floor.
      var cols = L.cols || CFG().GRID_COLS;
      var arr = L.furniture;
      for (var i = 0; i < arr.length; i++) {
        var ef = arr[i];
        if (!ef || ef.walkable) continue;
        var ew = ef.w || 1, eh = ef.h || 1;
        for (var ey = 0; ey < eh; ey++) {
          for (var ex = 0; ex < ew; ex++) taken[(ef.gy + ey) * cols + (ef.gx + ex)] = true;
        }
      }

      var count = (typeof spec.count === 'number' && spec.count > 0) ? spec.count : 1;
      var placed = 0;
      var carry = {};
      if (spec.lounge) carry.lounge = true;
      if (spec.dir) carry.dir = spec.dir;
      for (var p = 0; p < count; p++) {
        if (placeUpgradeFurniture(L, spec.type, taken, carry)) placed++;
      }
      // Optional bundled extras (e.g. lounge chairs with a coffee machine).
      if (Array.isArray(spec.extras)) {
        for (var x = 0; x < spec.extras.length; x++) {
          var ex2 = spec.extras[x] || {};
          var ec = (typeof ex2.count === 'number' && ex2.count > 0) ? ex2.count : 1;
          var ecarry = {};
          if (ex2.lounge) ecarry.lounge = true;
          if (ex2.dir) ecarry.dir = ex2.dir;
          for (var q = 0; q < ec; q++) {
            if (placeUpgradeFurniture(L, ex2.type, taken, ecarry)) placed++;
          }
        }
      }

      // Mark applied even if 0 pieces fit (the office is full) so we don't retry
      // forever; the purchase still "counts" and re-runs won't duplicate.
      L._appliedUpgrades[id] = true;
      return placed > 0;
    } catch (e) {
      return false;
    }
  };

  /* ---------------------------------------------------------------------------
   * reapplyUpgrades() — install every id in App.state.upgrades onto the current
   *   layout. Called on load (Store) after the layout is rebuilt, since upgrades
   *   are not baked into the persisted layout (only the id list is persisted).
   *   Idempotent via applyUpgrade's per-layout applied set. Never throws.
   * ------------------------------------------------------------------------- */
  World.reapplyUpgrades = function () {
    try {
      var s = STATE();
      if (!s) return;
      var ids = s.upgrades;
      if (!Array.isArray(ids) || !ids.length) return;
      for (var i = 0; i < ids.length; i++) {
        World.applyUpgrade(ids[i]);
      }
    } catch (e) { /* never throw into callers / rAF */ }
  };

  // Publish.
  App.World = World;
})();
