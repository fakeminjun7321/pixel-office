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
   * DEFAULT LAYOUT — the seeded neon office (v2: bigger, multi-ROOM).
   *   Deterministic. 46×30 grid, walled outer ring, one bottom DOOR.
   *
   *   Room map (top → bottom; interior walls with DOOR gaps between rooms):
   *     ┌───────── BOSS OFFICE (cyan CARPET, top-center) ─────────┐
   *     │  ENGINEERING BAY (left)   │   DESIGN STUDIO (right)      │
   *     │  RESEARCH LAB (left)      │   MEETING ROOM (purple RUG)  │
   *     │  LOUNGE / BREAK ROOM (coffee + sofa-chairs + plants)     │
   *     └──────────────────────────────────────────────────────────┘
   *
   *   ≥6 desks total so workers AND temp workers get seats. The seeded agents'
   *   desks are placed FIRST (in this order) so Store.seed lines up:
   *     index 0 = Boss       → bossDesk.seat
   *     index 1 = Engineer   → engDesk.seat   (Engineering bay)
   *     index 2 = Designer   → desDesk.seat   (Design studio)
   *     index 3 = Researcher → resDesk.seat   (Research lab)
   *   The remaining desks (spare engineering + spare design, etc.) are free for
   *   writer/qa/generalist temps via freeDeskCell().
   *
   *   This builder is robust to the grid being 30×20 (legacy) OR 46×30 (v2): it
   *   derives every position from cols/rows, never hardcoding the larger size.
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
    place('server', x0, engRowTop, 'down');        // a little server rack in the bay
    place('plant', engColX, (engRowTop + engRowBot) >> 1, 'down');

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
    place('whiteboard', desColX, desRowTop - 1, 'down');   // studio whiteboard
    place('plant', desColX + 1, (desRowTop + desRowBot) >> 1, 'down');

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
    // research server racks (datacenter-ish cluster in the lab corner)
    place('server', x0, resRowTop, 'down');
    place('server', x0, resRowTop + 1, 'down');
    place('plant', resColX, (resRowTop + resRowBot) >> 1, 'down');

    // ===== MEETING ROOM (lower-right, purple rug + meetingTable) =====
    var tableX = meetX + Math.floor((meetW - 3) / 2);    // center the 3-wide table
    var tableY = meetY + Math.floor((meetH - 2) / 2);
    place('meetingTable', tableX, tableY, 'up');
    place('whiteboard', tableX, meetY - 1, 'down');      // whiteboard above the rug
    place('plant', meetX + meetW - 1, meetY, 'down');

    // ===== LOUNGE / BREAK ROOM (bottom band, full width below labBot) =====
    // Coffee machine + a sofa-style cluster of chairs + plants. We tag the lounge
    // furniture with lounge:true so World.breakSpots() can find loiter cells.
    var loungeY = labBot + 2;                       // a row inside the lounge
    if (loungeY > y1) loungeY = y1;                 // legacy-grid safety
    var coffeeX = corrX - 1;
    var coffeeY = labBot + 1;
    if (coffeeY > y1) coffeeY = y1;
    place('coffee', coffeeX, coffeeY, 'down', { lounge: true });  // seat below it
    place('plant', coffeeX - 1, coffeeY, 'down', { lounge: true });
    place('plant', coffeeX + 1, coffeeY, 'down', { lounge: true });

    // Sofa = a short row of chairs facing the coffee table area (left of center).
    var sofaY = Math.min(y1, loungeY + 1);
    place('chair', corrX - 4, sofaY, 'down', { lounge: true });
    place('chair', corrX - 3, sofaY, 'down', { lounge: true });
    place('chair', corrX - 2, sofaY, 'down', { lounge: true });
    // A couple of lounge chairs on the right side too.
    place('chair', corrX + 2, sofaY, 'down', { lounge: true });
    place('chair', corrX + 3, sofaY, 'down', { lounge: true });
    // Greenery + a neon sign for break-room flavor.
    place('plant', x0, loungeY, 'down', { lounge: true });
    place('plant', x1, loungeY, 'down', { lounge: true });
    place('neonSign', corrX, labBot + 1, 'down', { lounge: true });

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

  // Publish.
  App.World = World;
})();
