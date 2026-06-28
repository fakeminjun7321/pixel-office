// =============================================================================
// pixelart.js  →  App.PixelArt
// PIXEL AI COMPANY ("NEON//WORKS") — pure procedural neon pixel art.
//
// Authority:
//   - SPEC.md §7.1 pins the PUBLIC SIGNATURES (screen-px form):
//       drawTile(ctx, tileType, sx, sy, size)
//       drawFurniture(ctx, furniture, sx, sy, size [, seatedAgent])
//       drawAgent(ctx, agent, sx, sy, size [, opts])
//       drawBubble / drawNameplate / drawSelection / drawFX / glowText / drawLogoGlyph
//     (sx,sy) = SCREEN px (top-left for tiles/furniture; FEET center-bottom for agents).
//     `size`  = cell edge in SCREEN px (= TILE * PIXEL * zoom).
//   - design_visual.md §2/§3 is the ART authority for the rect coordinate MAPS.
//     Those maps are authored in 16-art-px space; here we scale them by `s = size/16`
//     so a logical art-px becomes `s` screen px. This keeps the visual.md coordinates
//     verbatim while honoring SPEC's screen-px signatures.
//   - SPEC.md §3 reconciliations win where docs disagree (e.g. tile enum FLOOR:0…VOID:5).
//
// PURITY: this module only DRAWS. It reads `App.config.palette` (and a couple of
// config constants) but never reads/writes App.state. Every entry point is wrapped
// in try/catch so a bad sprite can never freeze the animation loop.
//
// CRISP PIXELS: main.js sets ctx.imageSmoothingEnabled=false once; we re-assert it
// defensively in the FX pass. All fills land on integer screen-px via `pr()` flooring.
// No import/export. Classic script. Attaches to window.App.
// =============================================================================

window.App = window.App || {};

(function () {
  'use strict';

  var PixelArt = {};

  // ---------------------------------------------------------------------------
  // Palette + small config mirrors (config.js loads first, so these exist).
  // We keep the SAME object reference as App.config.palette per SPEC §5.
  // Fallback palette is a defensive copy in case config failed to load — so this
  // module is independently testable and never throws on a missing namespace.
  // ---------------------------------------------------------------------------
  var FALLBACK_PALETTE = {
    void: '#070912', floor: '#0d1226', floorAlt: '#0f1530',
    gridLine: '#1c2b55', gridGlow: '#2e57b8',
    wallFace: '#141a33', wallTop: '#1d264a', wallTrim: '#39d7ff', wallShadow: '#080b18',
    cyan: '#39d7ff', magenta: '#ff3df0', purple: '#9b5cff', blue: '#4d7cff', lime: '#5dff9b',
    amber: '#ffc24d', red: '#ff4d6d',
    suitDark: '#23304f', suitMid: '#33436b',
    skin: ['#e8b48c', '#c98a63', '#f2c7a8', '#a86c4a'],
    hair: ['#1a1d2e', '#3a2f4f', '#5a4a35'],
    boot: '#11162b', outline: '#05070f',
    uiPanel: '#0b1024', uiPanelEdge: '#22305c', uiText: '#dce6ff', uiTextDim: '#8294c4',
    uiTextFaint: '#4d5d8a', uiBtn: '#16203f', uiBtnHover: '#1d2c54', uiField: '#0a0f20',
    uiDivider: '#1a2647', uiScrim: 'rgba(5,7,15,0.72)'
  };

  function cfg() { return (window.App && App.config) || {}; }
  function P() {
    var c = cfg();
    return (c.palette && c.palette.void) ? c.palette : FALLBACK_PALETTE;
  }

  // Tile enum (SPEC §4.2 — arch numbering WINS). Local mirror so we never depend
  // on load order beyond config (which is guaranteed first anyway).
  var TILES = { FLOOR: 0, WALL: 1, CARPET: 2, DOOR: 3, RUG: 4, VOID: 5 };

  // Art-px sprite metrics (visual.md §3.1 / SPEC §2). One cell = 16 art-px wide;
  // the agent sprite is 16 wide × 24 tall — taller than a tile, on purpose.
  var ART_TILE = 16; // art-px per cell edge
  var SPR_W = 16, SPR_H = 24;

  // Hash helper (mirror App.util.hash; self-contained fallback for purity/testing).
  function hash(str) {
    if (window.App && App.util && App.util.hash) { try { return App.util.hash(str); } catch (e) {} }
    var h = 2166136261; str = String(str || '');
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0);
  }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // ---------------------------------------------------------------------------
  // Color utilities — convert a base hex to rgba so we can apply per-rect alpha
  // (visual.md uses "color (alpha 0.x)" extensively). Cached for speed.
  // ---------------------------------------------------------------------------
  var _rgbCache = {};
  function hexToRgb(hex) {
    if (_rgbCache[hex]) return _rgbCache[hex];
    var r = 255, g = 255, b = 255;
    var h = String(hex || '').trim();
    if (h.charAt(0) === '#') h = h.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length >= 6) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    }
    if (isNaN(r) || isNaN(g) || isNaN(b)) { r = g = b = 255; }
    var out = { r: r, g: g, b: b };
    _rgbCache[hex] = out;
    return out;
  }
  function rgba(hex, a) {
    if (a === undefined || a === null || a >= 1) return hex; // opaque → use raw hex (fast path)
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + clamp01(a) + ')';
  }

  // ---------------------------------------------------------------------------
  // Drawing primitive. The active "rect context" carries the screen origin (ox,oy)
  // and the art→screen scale (s). `pr(x,y,w,h,color,alpha)` draws an art-px rect.
  // We FLOOR to integer device px (after scale) for crisp seams, and ensure a
  // minimum 1px so thin neon lines never vanish at small zoom.
  // ---------------------------------------------------------------------------
  var _ctx = null, _ox = 0, _oy = 0, _s = 1;

  function begin(ctx, ox, oy, scale) { _ctx = ctx; _ox = ox; _oy = oy; _s = scale; }

  function pr(x, y, w, h, color, alpha) {
    if (!_ctx) return;
    var sx = Math.floor(_ox + x * _s);
    var sy = Math.floor(_oy + y * _s);
    var ex = Math.ceil(_ox + (x + (w === undefined ? 1 : w)) * _s);
    var ey = Math.ceil(_oy + (y + (h === undefined ? 1 : h)) * _s);
    var ww = ex - sx, hh = ey - sy;
    if (ww < 1) ww = 1;
    if (hh < 1) hh = 1;
    _ctx.fillStyle = (alpha === undefined) ? color : rgba(color, alpha);
    _ctx.fillRect(sx, sy, ww, hh);
  }

  // Glow wrapper: SPEC §5.2 recipe — set shadow, draw, reset. Budgeted: callers
  // only wrap monitors, visors, trim, LEDs, signs, selection, bubble borders.
  function withGlow(ctx, color, blur, fn) {
    var pc = ctx.shadowColor, pb = ctx.shadowBlur, px = ctx.shadowOffsetX, py = ctx.shadowOffsetY;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    try { fn(); } catch (e) {}
    ctx.shadowColor = pc; ctx.shadowBlur = pb; ctx.shadowOffsetX = px; ctx.shadowOffsetY = py;
  }

  // Animated quantities are driven by a frame counter we derive from time so the
  // module needs no per-call frame argument (the SPEC signatures don't pass one).
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function timeSec() {
    // Prefer the shared loop clock if present (keeps everything in lockstep), else wall clock.
    var st = window.App && App.state;
    if (st && typeof st._time === 'number') return st._time;
    return nowMs() / 1000;
  }
  function frameCounter() { return Math.floor(timeSec() * (cfg().ANIM_FPS || 6)); }

  // ===========================================================================
  // PALETTE ACCESSORS (SPEC §7.1)
  // ===========================================================================
  // Same reference as config.palette (per SPEC §5). Defined as a getter-like
  // property each access so it tracks config even if config loads oddly.
  Object.defineProperty(PixelArt, 'palette', { get: function () { return P(); }, enumerable: true });
  PixelArt.getPalette = function () { return P(); };

  // ===========================================================================
  // drawTile(ctx, tileType, sx, sy, size)   — SPEC §7.1, visual.md §2.1–2.4
  // (sx,sy) = SCREEN top-left of the cell; size = cell edge in screen px.
  // ===========================================================================
  PixelArt.drawTile = function (ctx, tileType, sx, sy, size) {
    try {
      var pal = P();
      var s = size / ART_TILE;
      begin(ctx, sx, sy, s);

      switch (tileType) {
        case TILES.VOID:
          // Flat deep void — no grid (SPEC §4.2).
          pr(0, 0, 16, 16, pal.void);
          break;

        case TILES.WALL:
          drawWallTile(ctx, sx, sy, s, pal);
          break;

        case TILES.DOOR:
          drawDoorTile(ctx, sx, sy, s, pal);
          break;

        case TILES.CARPET: // boss zone → cyan border (SPEC §4.2)
          drawZoneTile(ctx, sx, sy, s, pal, pal.cyan);
          break;

        case TILES.RUG: // meeting zone → purple border (SPEC §4.2)
          drawZoneTile(ctx, sx, sy, s, pal, pal.purple);
          break;

        case TILES.FLOOR:
        default:
          drawFloorTile(ctx, sx, sy, s, pal, tileType);
          break;
      }
    } catch (e) { /* never throw from draw */ }
  };

  // FLOOR — neon grid (visual.md §2.1). Caller passes raw screen pos; we recover
  // the grid cell from screen origin so checker + "major line every 4" stay phase-
  // stable across the map regardless of camera.
  function drawFloorTile(ctx, sx, sy, s, pal, tileType) {
    // Recover approximate grid coords for deterministic checker/major-line/dots.
    var gx = 0, gy = 0;
    try {
      var W = window.App && App.World;
      if (W && W.screenToCell) {
        var c = W.screenToCell(sx + 1, sy + 1);
        gx = c.gx | 0; gy = c.gy | 0;
      }
    } catch (e) {}

    // Base + subtle checker.
    pr(0, 0, 16, 16, ((gx + gy) & 1) ? pal.floorAlt : pal.floor);

    // Seamless grid lines on top + left edges (visual.md §2.1).
    pr(0, 0, 16, 1, pal.gridLine);
    pr(0, 0, 1, 16, pal.gridLine);

    // Major lines every 4th column/row, brighter glow accent at half alpha.
    if (gx % 4 === 0) pr(0, 0, 1, 16, pal.gridGlow, 0.5);
    if (gy % 4 === 0) pr(0, 0, 16, 1, pal.gridGlow, 0.5);

    // Sparse "data" floor dot on ~1-in-6 tiles (hashed → stable, no thrash).
    if ((hash(gx + ',' + gy) % 6) === 0) pr(7, 7, 2, 2, pal.gridGlow, 0.25);
  }

  // WALL — extruded neon-trim wall (visual.md §2.2). Trim line glows cyan.
  function drawWallTile(ctx, sx, sy, s, pal) {
    pr(0, 0, 16, 5, pal.wallTop);        // top lip
    pr(0, 5, 16, 11, pal.wallFace);      // face
    pr(5, 6, 1, 9, pal.wallShadow);      // panel seam
    pr(11, 6, 1, 9, pal.wallShadow);     // panel seam
    // Glowing cyan trim line on the lip.
    withGlow(ctx, pal.wallTrim, 6, function () { pr(0, 4, 16, 1, pal.wallTrim); });
  }

  // DOOR — wall face with a lime "open/online" seam (visual.md §2.3).
  function drawDoorTile(ctx, sx, sy, s, pal) {
    pr(0, 0, 16, 5, pal.wallTop);
    pr(0, 5, 16, 11, '#0a1024');         // darker door face
    pr(5, 6, 1, 9, pal.wallShadow);
    pr(11, 6, 1, 9, pal.wallShadow);
    withGlow(ctx, pal.lime, 6, function () { pr(7, 5, 2, 11, pal.lime); });
  }

  // CARPET / RUG zone — glowing-bordered floor patch (visual.md §2.4). zoneColor
  // = cyan for boss CARPET, purple for meeting RUG (SPEC §4.2 mapping).
  function drawZoneTile(ctx, sx, sy, s, pal, zoneColor) {
    pr(0, 0, 16, 16, pal.floorAlt);
    // 1px inner border glow at alpha 0.4.
    pr(0, 0, 16, 1, zoneColor, 0.4);
    pr(0, 15, 16, 1, zoneColor, 0.4);
    pr(0, 0, 1, 16, zoneColor, 0.4);
    pr(15, 0, 1, 16, zoneColor, 0.4);
    // Faint center glow dot.
    pr(6, 6, 4, 4, zoneColor, 0.15);
  }

  // ===========================================================================
  // drawFurniture(ctx, furniture, sx, sy, size [, seatedAgent])  — SPEC §7.1
  // Renders across the item's w*h footprint; respects furniture.dir.
  // (sx,sy) = SCREEN top-left of the furniture's ANCHOR cell (gx,gy).
  // For multi-cell props we draw within the full footprint box (size*w × size*h).
  // ===========================================================================
  PixelArt.drawFurniture = function (ctx, furniture, sx, sy, size, seatedAgent) {
    try {
      if (!furniture) return;
      var pal = P();
      var s = size / ART_TILE;
      var dir = furniture.dir || 'down';
      var type = furniture.type;

      // Resolve footprint (cells). Prefer config FURNITURE def; fall back to item fields.
      var def = (cfg().FURNITURE && cfg().FURNITURE[type]) || null;
      var w = furniture.w || (def && def.w) || 1;
      var h = furniture.h || (def && def.h) || 1;

      // Establish the art-px rect context (origin = this cell's screen TL, scale s)
      // so every single-cell helper that uses pr() has it ready. Multi-cell props
      // (meetingTable/whiteboard) draw with explicit ctx rects and don't need it,
      // but it's harmless to set.
      begin(ctx, sx, sy, s);

      switch (type) {
        case 'desk':         drawDesk(ctx, sx, sy, s, size, pal, dir, w, h, seatedAgent); break;
        case 'server':       drawServer(ctx, sx, sy, s, pal); break;
        case 'meetingTable': drawMeetingTable(ctx, sx, sy, s, size, pal, w, h); break;
        case 'chair':        drawChair(ctx, sx, sy, s, pal, dir, seatedAgent); break;
        case 'plant':        drawPlant(ctx, sx, sy, s, pal); break;
        case 'coffee':       drawCoffee(ctx, sx, sy, s, pal, seatedAgent); break;
        case 'neonSign':     drawNeonSign(ctx, sx, sy, s, pal); break;
        case 'whiteboard':   drawWhiteboard(ctx, sx, sy, s, size, pal, w, h); break;
        default:             drawUnknownProp(ctx, sx, sy, s, pal); break;
      }
    } catch (e) { /* never throw from draw */ }
  };

  // --- DESK + MONITOR (visual.md §2.5). Authored for dir 'up'; other dirs via
  // flip/rotate of the begin() origin. Desk spans 2×1 (config); we draw the body
  // on cell A (anchor) and let the monitor read across. The seated agent's state
  // drives the screen content (visual.md §2.5.1). -------------------------------
  function drawDesk(ctx, sx, sy, s, size, pal, dir, w, h, seatedAgent) {
    // We author all desk art in a 16×16 art-px box and orient it per dir.
    // Approach: pick an origin + axis flips so the same map serves all 4 dirs.
    var screenState = seatedAgent ? seatedAgent.state : 'idle';
    var screenColor = (seatedAgent && seatedAgent.color) || pal.cyan;

    if (dir === 'left' || dir === 'right') {
      // Side-view tower (visual.md §2.5 dir variants). Horizontal desk surface.
      // Mirror horizontally for 'right' by flipping x within the cell.
      var flipX = (dir === 'right');
      var bx = function (x) { return flipX ? (16 - x) : x; };
      // Desk surface (horizontal).
      pr(2, 9, 12, 4, '#1a2340');
      pr(2, 9, 12, 1, '#2a375f');
      pr(2, 13, 2, 3, '#11182f'); pr(12, 13, 2, 3, '#11182f');
      // Side monitor tower on the dir side.
      var towerX = flipX ? 10 : 2;
      pr(towerX, 2, 4, 9, '#05070f');
      // Screen (thin) — animated.
      drawMonitorScreen(ctx, towerX + 1, 3, 2, 7, s, pal, screenState, screenColor, true);
      // Front shadow.
      pr(2, 16, 12, 1, pal.wallShadow, 0.6);
      void bx;
      return;
    }

    // dir up/down: monitor at back (up) or near bottom (down). We author 'up' and
    // mirror vertically for 'down' by reflecting each y → (16 - y - hgt).
    var flipY = (dir === 'down');
    var M = function (y, hgt) { return flipY ? (16 - y - hgt) : y; };

    // Desk surface.
    pr(1, M(9, 4), 14, 4, '#1a2340');
    pr(1, M(9, 1), 14, 1, '#2a375f');
    // Legs / front.
    pr(2, M(13, 3), 2, 3, '#11182f');
    pr(12, M(13, 3), 2, 3, '#11182f');
    // Monitor stand.
    pr(7, M(7, 2), 2, 2, '#0e1428');
    // Monitor bezel (near-black).
    pr(3, M(1, 7), 10, 7, '#05070f');
    pr(4, M(7, 1), 8, 1, '#0e1530'); // bezel chin
    // Animated screen — the hero glow source.
    drawMonitorScreen(ctx, 4, M(2, 5), 8, 5, s, pal, screenState, screenColor, false);

    // Drop shadow under the desk front edge onto the floor (visual.md §2.5).
    pr(1, flipY ? 0 : 15, 14, 1, pal.wallShadow, 0.5);

    // If desk spans a 2nd cell (w==2), extend the surface into it so a 2-wide desk
    // reads as one continuous slab. Drawn relative to the 2nd cell box.
    if (w >= 2) {
      var off = size; // screen px to the next cell to the right
      begin(ctx, _ox + off, _oy, s);
      pr(0, M(9, 4), 14, 4, '#1a2340');
      pr(0, M(9, 1), 14, 1, '#2a375f');
      pr(11, M(13, 3), 2, 3, '#11182f');
      begin(ctx, _ox - off, _oy, s); // restore origin for any later calls (defensive)
      begin(ctx, sx, sy, s);
    }
  }

  // Monitor screen content by seated agent's state (visual.md §2.5.1). `thin` for
  // the side-view tower (narrower screen). Glow in agent color.
  function drawMonitorScreen(ctx, x, y, w, h, s, pal, state, color, thin) {
    var f = frameCounter();
    switch (state) {
      case 'coding': {
        pr(x, y, w, h, '#08121f');
        // 3 code lines, lengths shifting; colors cycle cyan/lime/magenta.
        var cols = [pal.cyan, pal.lime, pal.magenta];
        for (var i = 0; i < 3 && i < h; i++) {
          var len = 2 + ((hash('cl' + i + (f >> 1)) % (w - 1)));
          if (len > w) len = w;
          pr(x, y + i, len, 1, cols[i % 3], 0.9);
        }
        // Blinking caret.
        if ((f >> 1) & 1) pr(x + Math.min(w - 1, 1 + (hash('car' + (f >> 2)) % (w - 1))), y + (h - 1), 1, 1, '#ffffff', 0.9);
        break;
      }
      case 'searching': {
        pr(x, y, w, h, '#08121f');
        // Sweeping vertical amber scan column.
        var sxn = x + (f % w);
        pr(sxn, y, Math.max(1, Math.round(2 * (w / 8))), h, pal.amber, 0.85);
        break;
      }
      case 'thinking': {
        // Slow pulsing purple.
        var a = 0.4 + 0.4 * (0.5 + 0.5 * Math.sin(timeSec() * 3));
        pr(x, y, w, h, pal.purple, a);
        break;
      }
      case 'idle':
      case 'meeting':
      case 'coffee':
      default: {
        pr(x, y, w, h, '#0a1830');
        pr(x, y + 2, w, 1, pal.cyan, 0.3); // 1 dim cyan scanline
        break;
      }
    }
    // Glow the screen once (budgeted). thin screens get a smaller blur.
    withGlow(ctx, color || pal.cyan, thin ? 7 : 10, function () {
      // re-stroke the outline by re-filling a 1px frame so glow reads as an edge
      pr(x, y, w, 1, color || pal.cyan, 0.0001); // negligible fill just to carry shadow
    });
  }

  // --- SERVER RACK (visual.md §2.7). Blinking LEDs are the focal glow. ---------
  function drawServer(ctx, sx, sy, s, pal) {
    pr(2, 1, 12, 15, '#0c1226');
    pr(2, 1, 12, 1, '#1c2748');           // edge highlight
    // 5 rack-unit slots.
    var rows = [2, 4, 6, 8, 10];
    for (var i = 0; i < rows.length; i++) pr(3, rows[i], 11, 1, '#060912');
    // Blinking LEDs — each on its own phase: on when (frame + slot*7) % N truthy.
    var f = frameCounter();
    var ledCols = [pal.lime, pal.amber, pal.red];
    withGlow(ctx, pal.lime, 4, function () {
      for (var j = 0; j < rows.length; j++) {
        var phase = (f + j * 7);
        var on = (phase % 5) < 3;       // ~60% duty
        if (!on) continue;
        // color choice: mostly lime, sometimes amber, rarely red.
        var pick = (phase % 11 === 0) ? 2 : ((phase % 4 === 0) ? 1 : 0);
        var col = ledCols[pick];
        pr(4, rows[j], 1, 1, col);
        pr(12, rows[j], 1, 1, col);
      }
    });
    // Vent grille at bottom.
    pr(4, 12, 8, 3, '#10182f');
    pr(4, 12, 8, 1, pal.cyan, 0.4);
    pr(4, 13, 8, 1, pal.cyan, 0.4);
    pr(4, 14, 8, 1, pal.cyan, 0.4);
  }

  // --- MEETING TABLE (visual.md §2.10). 3×2 footprint; pulsing purple holo. ----
  function drawMeetingTable(ctx, sx, sy, s, size, pal, w, h) {
    w = w || 3; h = h || 2;
    var fw = size * w, fh = size * h;       // full footprint in screen px
    // We draw the slab across the whole footprint using direct rects (not the
    // 16-art-px box, since this prop is bigger than one cell).
    var pad = Math.round(size * 0.10);
    var topY = Math.round(sy + fh * 0.30);
    var slabH = Math.round(fh * 0.50);
    ctx.fillStyle = '#1a2238';
    ctx.fillRect(Math.floor(sx + pad), topY, Math.floor(fw - pad * 2), slabH);
    // Top highlight.
    ctx.fillStyle = '#2c3960';
    ctx.fillRect(Math.floor(sx + pad), topY, Math.floor(fw - pad * 2), Math.max(1, Math.round(size * 0.06)));
    // Edge neon trim (purple) with glow.
    withGlow(ctx, pal.purple, 8, function () {
      ctx.fillStyle = rgba(pal.purple, 0.6);
      ctx.fillRect(Math.floor(sx + pad), topY + slabH - Math.max(1, Math.round(size * 0.06)),
        Math.floor(fw - pad * 2), Math.max(1, Math.round(size * 0.06)));
    });
    // Center holo ring — pulsing purple (drawn as 4 edges of a small ring).
    var cx = sx + fw / 2, cy = topY + slabH * 0.35;
    var rad = size * 0.40;
    var pulse = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(timeSec() * 2.2));
    withGlow(ctx, pal.purple, 10, function () {
      ctx.strokeStyle = rgba(pal.purple, pulse);
      ctx.lineWidth = Math.max(1, Math.round(size * 0.06));
      ctx.beginPath();
      ctx.rect(Math.floor(cx - rad), Math.floor(cy - rad), Math.floor(rad * 2), Math.floor(rad * 2));
      ctx.stroke();
    });
    // Tiny hot core.
    ctx.fillStyle = rgba('#ffffff', 0.5 * pulse);
    ctx.fillRect(Math.floor(cx - size * 0.05), Math.floor(cy - size * 0.05), Math.max(1, Math.round(size * 0.10)), Math.max(1, Math.round(size * 0.10)));
  }

  // --- CHAIR (visual.md §2.6). Accent stripe takes the seated agent's color. ---
  function drawChair(ctx, sx, sy, s, pal, dir, seatedAgent) {
    var accent = (seatedAgent && seatedAgent.color) || pal.blue;
    // Seat.
    pr(4, 8, 8, 4, '#19223f');
    pr(4, 8, 8, 1, '#2b3a64');
    // Backrest (dir up: at top). For down, put it near the bottom.
    if (dir === 'down') {
      pr(4, 11, 8, 5, '#141b34');
      pr(5, 14, 6, 1, accent, 0.7);
    } else {
      pr(4, 3, 8, 5, '#141b34');
      pr(5, 4, 6, 1, accent, 0.7);
    }
    // Legs.
    pr(5, 12, 1, 3, '#0c1124');
    pr(10, 12, 1, 3, '#0c1124');
  }

  // --- PLANT (visual.md §2.8). Foliage sways ±1 art-px on a slow sine; neon edge. --
  function drawPlant(ctx, sx, sy, s, pal) {
    var sway = Math.round(Math.sin(timeSec() * 1.1)); // -1,0,1
    // Pot.
    pr(5, 11, 6, 4, '#2a2036');
    pr(5, 11, 6, 1, '#3a2c4c');
    // Foliage cluster (shifted by sway).
    var fx = sway;
    pr(6 + fx, 4, 4, 3, '#1f6b4a');
    pr(4 + fx, 6, 4, 3, '#1f6b4a');
    pr(8 + fx, 6, 4, 3, '#1f6b4a');
    pr(6 + fx, 7, 4, 3, '#1f6b4a');
    // Neon edge highlights (foliage catches the office light).
    pr(7 + fx, 4, 1, 1, pal.lime, 0.8);
    pr(5 + fx, 6, 1, 1, pal.lime, 0.8);
    pr(11 + fx, 7, 1, 1, pal.lime, 0.8);
  }

  // --- COFFEE MACHINE (visual.md §2.9). Steam rises when an agent is on coffee. --
  function drawCoffee(ctx, sx, sy, s, pal, seatedAgent) {
    pr(3, 3, 10, 12, '#161d36');
    pr(3, 3, 10, 2, '#222c4d');           // top
    // Display.
    pr(5, 5, 6, 2, pal.cyan, 0.7);
    // Spout + cup.
    pr(7, 8, 2, 1, '#0c1124');
    pr(6, 10, 4, 3, '#e6ecff');
    // Steam particles when an agent is taking coffee.
    if (seatedAgent && seatedAgent.state === 'coffee') {
      var f = frameCounter();
      for (var i = 0; i < 3; i++) {
        var yy = 9 - ((f + i * 2) % 6);
        var a = clamp01((yy + 2) / 8);
        pr(7 + (i % 2), yy, 1, 1, '#dce6ff', 0.5 * a);
      }
    }
  }

  // --- NEON WALL SIGN (visual.md §2.11 + §6). Backplate + flickering logo glyph. --
  function drawNeonSign(ctx, sx, sy, s, pal) {
    pr(1, 2, 14, 8, '#0a0e1e');
    var flick = signFlicker('sign');
    // Mini network glyph echo (hex core + 2 satellites) inside the sign.
    withGlow(ctx, pal.cyan, 6, function () {
      pr(7, 5, 2, 2, pal.cyan, flick);              // core
      pr(4, 4, 1, 1, pal.magenta, flick);           // satellite
      pr(11, 7, 1, 1, pal.lime, flick);             // satellite
      // connectors
      pr(5, 5, 2, 1, pal.cyan, 0.4 * flick);
      pr(9, 7, 2, 1, pal.cyan, 0.4 * flick);
    });
  }

  // --- WHITEBOARD (config FURNITURE; not in visual.md by name → designed to match). --
  function drawWhiteboard(ctx, sx, sy, s, size, pal, w, h) {
    w = w || 2;
    var fw = size * w;
    ctx.fillStyle = '#0c1226';
    ctx.fillRect(Math.floor(sx), Math.floor(sy + size * 0.15), Math.floor(fw), Math.floor(size * 0.6));
    // Cyan frame glow.
    withGlow(ctx, pal.cyan, 6, function () {
      ctx.strokeStyle = rgba(pal.cyan, 0.6);
      ctx.lineWidth = Math.max(1, Math.round(size * 0.05));
      ctx.strokeRect(Math.floor(sx), Math.floor(sy + size * 0.15), Math.floor(fw), Math.floor(size * 0.6));
    });
    // Scribbles.
    ctx.fillStyle = rgba(pal.lime, 0.7);
    ctx.fillRect(Math.floor(sx + size * 0.2), Math.floor(sy + size * 0.3), Math.floor(fw * 0.4), Math.max(1, Math.round(size * 0.04)));
    ctx.fillRect(Math.floor(sx + size * 0.2), Math.floor(sy + size * 0.45), Math.floor(fw * 0.6), Math.max(1, Math.round(size * 0.04)));
    ctx.fillStyle = rgba(pal.magenta, 0.7);
    ctx.fillRect(Math.floor(sx + size * 0.2), Math.floor(sy + size * 0.6), Math.floor(fw * 0.3), Math.max(1, Math.round(size * 0.04)));
  }

  function drawUnknownProp(ctx, sx, sy, s, pal) {
    // Generic glowing crate so unknown furniture is still visible, never crashes.
    pr(3, 4, 10, 11, '#141a33');
    pr(3, 4, 10, 1, '#1d264a');
    pr(3, 14, 10, 1, pal.purple, 0.5);
  }

  // ===========================================================================
  // drawAgent(ctx, agent, sx, sy, size [, opts])   — SPEC §7.1, visual.md §3
  // (sx,sy) = SCREEN px of the FEET anchor (bottom-center). size = cell edge px.
  // The 16×24 sprite is positioned so its anchor (8,23) lands on (sx,sy):
  //   originX = sx - 8*s ; originY = sy - 23*s
  // opts = { seated, selected }. Exception-safe: unknown state → idle-bob.
  // ===========================================================================
  PixelArt.drawAgent = function (ctx, agent, sx, sy, size, opts) {
    try {
      if (!agent) return;
      var pal = P();
      var s = size / ART_TILE; // art-px → screen px
      opts = opts || {};

      var seated = !!opts.seated || agent.state === 'coding' || agent.state === 'searching';
      var state = agent.state || 'idle';
      var facing = agent.facing || 'down';
      var frame = (agent.anim && agent.anim.frame) || 0;
      var color = agent.color || roleColorFor(agent.role) || pal.purple;
      var role = agent.role || 'generalist';

      // Boss reads as a slightly bigger silhouette (×1.12). We scale `s` but keep
      // the FEET anchor fixed by recomputing the origin against the boosted scale.
      if (role === 'boss') s = s * 1.12;

      // Deterministic per-agent skin/hair from id hash (visual.md §3.4).
      var hp = agent.id ? hash(agent.id) : 0;
      var skin = pal.skin[hp % pal.skin.length];
      var hair = pal.hair[(hp >> 3) % pal.hair.length];
      var longHair = (hp & 4) !== 0;

      // Wave B/C: sprite CUSTOMIZATION. agent.sprite may override hair/skin (by
      // palette index or explicit hex) and accent (the neon color). Defaults above
      // are kept when a field is absent. Indices wrap; bad values fall through.
      var sp = agent.sprite;
      if (sp && typeof sp === 'object') {
        if (typeof sp.skin === 'string') skin = sp.skin;
        else if (typeof sp.skin === 'number' && pal.skin.length) skin = pal.skin[((sp.skin % pal.skin.length) + pal.skin.length) % pal.skin.length];
        if (typeof sp.hair === 'string') hair = sp.hair;
        else if (typeof sp.hair === 'number' && pal.hair.length) hair = pal.hair[((sp.hair % pal.hair.length) + pal.hair.length) % pal.hair.length];
        if (typeof sp.accent === 'string' && sp.accent) color = sp.accent;
      }

      // Vertical bob offset (idle/thinking/meeting/coffee) and walk lift.
      var bobY = 0;
      if (state === 'idle' || state === 'thinking' || state === 'meeting' || state === 'coffee') {
        // 2-frame bob via BOB_PERIOD sine — gentle breathe.
        var period = cfg().BOB_PERIOD || 1.6;
        bobY = (Math.sin((timeSec() / period) * Math.PI * 2) > 0) ? -1 : 0;
      }

      // Sprite origin so anchor (8,23) sits on the feet point (sx,sy).
      var ox = sx - 8 * s;
      var oy = sy - 23 * s + bobY * s;
      begin(ctx, ox, oy, s);

      // Selection ring is drawn by drawSelection() (caller decides). If opts.selected
      // is passed AND caller relies on drawAgent, we still skip ring here to honor
      // the separate drawSelection() signature — but brighten the visor a touch.
      var selBoost = opts.selected ? 1 : 0;

      // Dispatch pose.
      if (seated) {
        drawSeated(ctx, s, pal, color, skin, hair, longHair, facing, state, frame, selBoost, role);
      } else if (state === 'walking') {
        drawWalking(ctx, s, pal, color, skin, hair, longHair, facing, frame, selBoost, role);
      } else {
        // idle / thinking / meeting / coffee → idle-bob standing pose.
        drawStanding(ctx, s, pal, color, skin, hair, longHair, facing, state, frame, selBoost, role);
        // thinking → tiny pulsing "…" above head + amber emblem tint handled inside.
      }
    } catch (e) { /* never throw from draw — bad agent must not freeze loop */ }
  };

  function roleColorFor(role) {
    var rc = cfg().roleColor || {};
    return rc[role];
  }

  // ===========================================================================
  // drawAgentGlow(ctx, agent, sx, sy, size, strength)   — Wave B/C
  // A soft radial activity halo pooled at the agent's FEET (sx,sy), in the agent's
  // accent color. `strength` is 0..1 (Agents.activityGlow). Pure draw; drawn UNDER
  // the sprite by the caller. Uses additive 'lighter' blending for a neon bloom and
  // restores all state. Never throws.
  // ===========================================================================
  PixelArt.drawAgentGlow = function (ctx, agent, sx, sy, size, strength) {
    try {
      if (!agent || !ctx) return;
      var st = Number(strength);
      if (!isFinite(st) || st <= 0) return;
      if (st > 1) st = 1;
      var pal = P();
      var s = size / ART_TILE;

      // Accent: prefer custom sprite accent, then agent color, then role/cyan.
      var color = (agent.sprite && typeof agent.sprite.accent === 'string' && agent.sprite.accent) ||
        agent.color || roleColorFor(agent.role) || pal.cyan;

      // Pool centered on the feet, slightly up so it hugs the ground like the
      // selection ring. Radius grows a touch with strength; gentle pulse.
      var pulse = 0.85 + 0.15 * (0.5 + 0.5 * Math.sin(timeSec() * 4));
      var cx = sx, cy = sy - 1 * s;
      var rad = (10 + 4 * st) * s * pulse;
      if (rad < 1) return;

      var rgb = hexToRgb(color);
      var inner = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (0.30 * st).toFixed(3) + ')';

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, inner);
      g.addColorStop(0.55, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (0.10 * st).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0)');
      ctx.fillStyle = g;
      // Flatten vertically so it reads as a floor pool, not a sphere.
      ctx.translate(cx, cy);
      ctx.scale(1, 0.5);
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } catch (e) { /* never throw from draw */ }
  };

  // --- Shared body parts (standing). Authored facing DOWN (visual.md §3.2),
  // adapted for up/side. Draws an outline underlay first for a 1px silhouette. ---
  function drawStanding(ctx, s, pal, color, skin, hair, longHair, facing, state, frame, selBoost, role) {
    var f1 = (frame % 2) === 1; // idle-bob frame
    var emblemColor = color;
    if (state === 'thinking') {
      // Pulse emblem color C ↔ amber.
      emblemColor = ((frameCounter() >> 1) & 1) ? pal.amber : color;
    }
    var visorA = (f1 ? 1.0 : 0.85) + selBoost * 0.0; // f1 brightens visor

    // Ground shadow (visual.md §3.2).
    pr(4, 22, 8, 2, 'rgba(0,0,0,0.35)');
    pr(5, 23, 6, 1, 'rgba(0,0,0,0.5)');

    if (facing === 'up') {
      drawBodyUp(ctx, pal, color, skin, hair, longHair, emblemColor, visorA, false, role, state, frame);
    } else if (facing === 'left' || facing === 'right') {
      drawBodySide(ctx, pal, color, skin, hair, longHair, emblemColor, visorA, facing, false, role, state, frame);
    } else {
      drawBodyDown(ctx, pal, color, skin, hair, longHair, emblemColor, visorA, false, role, state, frame);
    }

    // thinking "…" mini bubble dots above head.
    if (state === 'thinking') {
      var t = frameCounter();
      var dots = (t % 3) + 1;
      for (var i = 0; i < dots; i++) pr(6 + i * 2, -3, 1, 1, pal.amber, 0.9);
    }
    // meeting → small purple emblem already via state? emblem stays color; add hint.
    if (state === 'meeting') {
      pr(6, 10, 4, 4, pal.purple, 0.5); // overlay tint
    }
    // coffee → tiny cup at hand (visual.md §3.5.4).
    if (state === 'coffee') {
      pr(11, 12, 2, 2, '#e6ecff');
    }
  }

  // ===========================================================================
  // drawRoleLayer(ctx, role, pal, color, facing, state, frame)   — v6 ROLE SPRITES
  // Per-role pixel cues (headwear, held prop, garment, chest icon) layered ON TOP
  // of the shared body, in the SAME 16-art-px box (pr() origin already set by the
  // body draw). Facing-aware: 'up' hides face props but keeps headwear silhouette;
  // side draws the held prop only on the FRONT hand (mirrored via X()). Wrapped in
  // try/catch so a bad layer never freezes the loop. Reads accent colors from the
  // palette but never changes config role colors. Pure draw.
  // ===========================================================================
  function drawRoleLayer(ctx, role, pal, color, facing, state, frame) {
    try {
      if (!role) return;
      var up = (facing === 'up');
      var side = (facing === 'left' || facing === 'right');
      var flip = (facing === 'left');
      // Mirror helper for side view (matches body draw convention).
      var X = function (x, w) { return flip ? (16 - x - (w || 1)) : x; };

      switch (role) {
        case 'boss':       drawRoleBoss(ctx, pal, color, up, side, X); break;
        case 'engineer':   drawRoleEngineer(ctx, pal, color, up, side, X); break;
        case 'designer':   drawRoleDesigner(ctx, pal, color, up, side, X); break;
        case 'researcher': drawRoleResearcher(ctx, pal, color, up, side, X); break;
        case 'writer':     drawRoleWriter(ctx, pal, color, up, side, X); break;
        case 'qa':         drawRoleQA(ctx, pal, color, up, side, X, state); break;
        case 'generalist':
        default:           drawRoleGeneralist(ctx, pal, color, up, side, X); break;
      }
    } catch (e) { /* never throw from draw */ }
  }

  // --- BOSS (cyan): crown + suit lapels + cyan tie + star chest icon. ----------
  function drawRoleBoss(ctx, pal, color, up, side, X) {
    var cyan = pal.cyan, suitMid = pal.suitMid;
    // 3-tooth crown — keep silhouette even when facing up.
    withGlow(ctx, cyan, 5, function () {
      pr(X(5, 1), -2, 1, 2, cyan);
      pr(X(7, 1), -2, 1, 2, cyan);
      pr(X(9, 1), -2, 1, 2, cyan);
      pr(X(5, 5), 0, 5, 1, cyan, 0.9); // crown band
    });
    pr(X(7, 1), -3, 1, 1, '#ffffff', 0.9); // center spark
    if (up) return; // suit/tie/icon are front-only
    // Suit lapels + cyan tie.
    pr(X(5, 1), 8, 1, 4, suitMid);
    pr(X(10, 1), 8, 1, 4, suitMid);
    pr(X(7, 2), 8, 2, 5, cyan, 0.85);  // tie
    pr(X(7, 2), 8, 2, 1, cyan);        // knot
    // Star chest icon (5px plus + corners).
    if (!side) {
      pr(7, 11, 2, 2, '#ffffff', 0.9);
      pr(6, 12, 4, 1, cyan, 0.8);
      pr(7, 10, 2, 4, cyan, 0.7);
    }
  }

  // --- ENGINEER (blue): hood + headset + glasses + </> chevrons. ---------------
  function drawRoleEngineer(ctx, pal, color, up, side, X) {
    var blue = pal.blue, suitMid = pal.suitMid;
    var hd = '#1a2238';
    // Hood silhouette (kept for up too).
    pr(X(3, 1), 0, 1, 5, hd);
    pr(X(12, 1), 0, 1, 5, hd);
    pr(X(4, 8), -1, 8, 2, hd);
    // Headset band + ear cup + mic boom.
    pr(X(4, 8), 1, 8, 1, '#0c1124');
    withGlow(ctx, blue, 4, function () { pr(X(3, 1), 2, 1, 2, blue, 0.9); });
    if (up) return;
    pr(X(3, 2), 4, 2, 1, blue, 0.8); // mic boom (front only)
    // Glasses.
    pr(X(5, 2), 3, 2, 1, '#bfe0ff', 0.7);
    pr(X(9, 2), 3, 2, 1, '#bfe0ff', 0.7);
    if (side) return;
    // Hoodie pocket + </> chevrons chest icon.
    pr(5, 12, 6, 2, suitMid);
    pr(5, 11, 1, 1, blue, 0.9); pr(6, 12, 1, 1, blue, 0.9); pr(5, 13, 1, 1, blue, 0.9); // <
    pr(10, 11, 1, 1, blue, 0.9); pr(9, 12, 1, 1, blue, 0.9); pr(10, 13, 1, 1, blue, 0.9); // >
  }

  // --- DESIGNER (magenta): tilted beret + stylus + smock + pen-nib icon. -------
  function drawRoleDesigner(ctx, pal, color, up, side, X) {
    var magenta = pal.magenta;
    var be = '#2a1030';
    // Tilted beret.
    pr(X(4, 8), 0, 8, 2, be);
    pr(X(4, 5), -1, 5, 1, be);
    withGlow(ctx, magenta, 4, function () { pr(X(4, 1), -1, 1, 1, magenta, 0.9); }); // nub
    if (up) return;
    // Held stylus on front hand (side) / right hand (front).
    pr(X(12, 1), 11, 1, 4, '#dddddd');
    pr(X(12, 1), 11, 1, 1, magenta, 0.9); // tip
    // Smock + paint flecks.
    pr(X(4, 8), 9, 8, 6, '#3a2742');
    if (side) return;
    pr(6, 11, 1, 1, magenta, 0.8);
    pr(9, 13, 1, 1, pal.lime, 0.8);
    pr(8, 10, 1, 1, pal.amber, 0.8);
    // Pen-nib chest icon.
    pr(7, 10, 2, 3, '#ffffff', 0.85);
    pr(7, 13, 2, 1, magenta, 0.9);
  }

  // --- RESEARCHER (lime): round glasses + magnifier + WHITE LAB COAT + flask. --
  function drawRoleResearcher(ctx, pal, color, up, side, X) {
    var lime = pal.lime;
    var coat = '#e8eef7';
    // Lab coat torso + sleeves (under headwear, drawn first so glasses sit on top).
    if (!up) {
      pr(X(4, 8), 8, 8, 8, coat);
      pr(X(7, 1), 8, 1, 7, '#c9d4e6'); // center seam
      pr(X(6, 1), 8, 1, 2, '#c9d4e6'); pr(X(9, 1), 8, 1, 2, '#c9d4e6'); // collar V
      pr(X(3, 2), 9, 2, 5, coat);  // left sleeve
      pr(X(11, 2), 9, 2, 5, coat); // right sleeve
      // Flask chest icon.
      if (!side) {
        pr(7, 10, 2, 1, lime, 0.9);
        pr(6, 11, 4, 3, lime, 0.6);
        pr(7, 11, 2, 3, '#ffffff', 0.5);
      }
    }
    if (up) return;
    // Round glasses + glints.
    pr(X(4, 2), 3, 2, 2, lime, 0.5);
    pr(X(10, 2), 3, 2, 2, lime, 0.5);
    pr(X(4, 1), 3, 1, 1, '#ffffff', 0.7);
    pr(X(10, 1), 3, 1, 1, '#ffffff', 0.7);
    // Magnifier on the front/right hand.
    pr(X(11, 3), 12, 3, 1, lime, 0.8); // ring top
    pr(X(11, 3), 14, 3, 1, lime, 0.8); // ring bottom
    pr(X(11, 1), 13, 1, 1, lime, 0.8); // ring left
    pr(X(13, 1), 13, 1, 1, lime, 0.8); // ring right
    pr(X(12, 1), 13, 1, 1, '#ffffff', 0.6); // glint
    pr(X(13, 1), 15, 2, 1, '#caa15a'); // handle
  }

  // --- WRITER (amber): pencil behind ear + scarf + notepad + pen-nib icon. -----
  function drawRoleWriter(ctx, pal, color, up, side, X) {
    var amber = pal.amber;
    // Pencil behind ear (headwear-ish silhouette, keep for up).
    pr(X(3, 1), 2, 1, 3, '#caa15a');
    pr(X(3, 1), 5, 1, 1, '#444444'); // tip
    // Amber scarf.
    pr(X(5, 6), 7, 6, 2, amber, 0.8);
    pr(X(4, 1), 8, 1, 3, amber, 0.7); // tail
    if (up) return;
    if (side) return;
    // Notepad on left hand.
    pr(2, 12, 4, 4, '#f2efe6');
    pr(3, 13, 3, 1, '#9aa0b0', 0.7);
    pr(3, 14, 3, 1, '#9aa0b0', 0.7);
    pr(2, 12, 1, 4, '#caa15a'); // spiral
    // Pen-nib chest icon.
    pr(7, 10, 2, 3, '#ffffff', 0.85);
    pr(7, 13, 2, 1, amber, 0.9);
  }

  // --- QA (red): flat cap + clipboard (check/X by state) + red armband. --------
  function drawRoleQA(ctx, pal, color, up, side, X, state) {
    var red = pal.red, lime = pal.lime;
    var fail = (state === 'fail' || state === 'error');
    // Flat cap crown + front brim + red button.
    pr(X(3, 10), 0, 10, 2, '#1a1d2e');
    if (!up) pr(X(4, 8), 2, 8, 1, '#0c1124'); // brim (front)
    withGlow(ctx, red, 3, function () { pr(X(7, 1), 0, 1, 1, red, 0.9); }); // button
    // Red armband.
    if (!up) pr(X(3, 2), 9, 2, 1, red, 0.85);
    if (up) return;
    if (side) return;
    // Clipboard with check (or red X on fail).
    pr(5, 11, 6, 6, '#e6e6ea');
    pr(7, 10, 2, 1, '#b0b4c0'); // clip
    if (fail) {
      pr(6, 12, 1, 1, red); pr(7, 13, 1, 1, red); pr(8, 14, 1, 1, red);
      pr(8, 12, 1, 1, red); pr(7, 13, 1, 1, red); pr(6, 14, 1, 1, red);
    } else {
      pr(9, 12, 1, 1, lime); pr(8, 13, 1, 1, lime); pr(7, 14, 1, 1, lime); pr(6, 13, 1, 1, lime);
    }
  }

  // --- GENERALIST (purple): knit beanie + wrench + utility vest + gear icon. ---
  function drawRoleGeneralist(ctx, pal, color, up, side, X) {
    var purple = pal.purple;
    var kn = '#2a2440';
    // Knit beanie + fold + pom.
    pr(X(4, 8), -1, 8, 3, kn);
    pr(X(4, 8), 1, 8, 1, '#3a3458'); // fold
    withGlow(ctx, purple, 4, function () { pr(X(7, 2), -2, 2, 1, purple, 0.9); }); // pom
    if (up) return;
    // Wrench on front/right hand.
    pr(X(11, 1), 11, 1, 4, '#9aa0b0'); // shaft
    pr(X(11, 3), 11, 3, 2, purple, 0.85); // open-end head
    // Utility vest pockets + zipper.
    if (!side) {
      pr(5, 12, 2, 2, '#3a3458');
      pr(9, 12, 2, 2, '#3a3458');
      pr(7, 9, 1, 6, '#4a4470'); // zipper
      // Gear chest icon.
      pr(7, 10, 2, 2, purple, 0.85);
      pr(6, 10, 1, 1, purple, 0.7); pr(9, 10, 1, 1, purple, 0.7);
      pr(6, 11, 1, 1, purple, 0.7); pr(9, 11, 1, 1, purple, 0.7);
    }
  }

  // Standing body — FACING DOWN (the canonical map, visual.md §3.2). The `seatTint`
  // arg is unused for standing but kept for symmetry.
  function drawBodyDown(ctx, pal, color, skin, hair, longHair, emblemColor, visorA, seatTint, role, state, frame) {
    // Outline underlay: cheap silhouette by drawing the main blocks 1px larger first.
    pr(3, 0, 10, 23, pal.outline, 0.0); // (kept negligible; per-block underlays below)

    // Legs.
    pr(5, 16, 3, 5, pal.suitDark);   // left leg
    pr(8, 16, 3, 5, pal.suitDark);   // right leg
    pr(6, 17, 1, 4, pal.suitMid);    // left crease hl
    pr(9, 17, 1, 4, pal.suitMid);    // right crease hl
    pr(5, 21, 3, 2, pal.boot);       // left boot
    pr(8, 21, 3, 2, pal.boot);       // right boot
    pr(5, 20, 6, 1, color, 0.6);     // glowing ankle accent *** neon ***

    // Torso.
    pr(4, 8, 8, 8, pal.suitDark);    // torso block
    pr(5, 9, 6, 2, pal.suitMid);     // chest panel hl
    pr(4, 8, 8, 1, pal.suitMid);     // shoulder line
    pr(6, 10, 4, 4, emblemColor, 0.85); // chest emblem / core *** neon ***
    pr(7, 11, 2, 2, '#ffffff', 0.7); // hot center

    // Arms (down pose).
    pr(3, 9, 2, 6, pal.suitDark);    // left arm
    pr(11, 9, 2, 6, pal.suitDark);   // right arm
    pr(3, 14, 2, 2, skin);           // left hand
    pr(11, 14, 2, 2, skin);          // right hand

    // Neck.
    pr(7, 7, 2, 1, skin);

    // Head.
    pr(4, 1, 8, 6, skin);            // face block
    pr(4, 0, 8, 2, hair);            // hair top
    pr(3, 1, 1, 4, hair);            // hair left
    pr(12, 1, 1, 4, hair);           // hair right
    pr(4, 1, 8, 1, hair);            // hairline/bangs
    if (longHair) { pr(3, 2, 1, 2, hair); pr(12, 2, 1, 2, hair); } // longer-hair variety bit

    // VISOR (the neon face signature). shadowBlur 4.
    pr(5, 3, 6, 2, '#05070f');       // housing
    withGlow(ctx, color, 4, function () { pr(5, 3, 6, 1, color, visorA); }); // glowing band
    pr(6, 3, 1, 1, '#ffffff', 0.8);  // visor glint

    drawRoleLayer(ctx, role, pal, color, 'down', state, frame);
  }

  // Standing body — FACING UP (away; no face). visual.md §3.3.
  function drawBodyUp(ctx, pal, color, skin, hair, longHair, emblemColor, visorA, seatTint, role, state, frame) {
    // Legs.
    pr(5, 16, 3, 5, pal.suitDark);
    pr(8, 16, 3, 5, pal.suitDark);
    pr(6, 17, 1, 4, pal.suitMid);
    pr(9, 17, 1, 4, pal.suitMid);
    pr(5, 21, 3, 2, pal.boot);
    pr(8, 21, 3, 2, pal.boot);
    pr(5, 20, 6, 1, color, 0.6);     // ankle accent

    // Torso (back).
    pr(4, 8, 8, 8, pal.suitDark);
    pr(5, 9, 6, 5, pal.suitMid);     // back panel
    pr(7, 9, 2, 5, color, 0.8);      // spine stripe *** neon ***
    pr(4, 8, 8, 1, pal.suitMid);     // shoulder line

    // Arms.
    pr(3, 9, 2, 6, pal.suitDark);
    pr(11, 9, 2, 6, pal.suitDark);
    pr(3, 14, 2, 2, skin);
    pr(11, 14, 2, 2, skin);

    // Neck.
    pr(7, 7, 2, 1, hair);

    // Head (all hair from behind).
    pr(4, 0, 8, 6, hair);
    if (longHair) { pr(3, 2, 1, 3, hair); pr(12, 2, 1, 3, hair); }
    // Nape line — visor glow bleeds around the head.
    withGlow(ctx, color, 4, function () { pr(5, 5, 6, 1, color, visorA * 0.8); });

    drawRoleLayer(ctx, role, pal, color, 'up', state, frame);
  }

  // Standing body — FACING SIDE (right; mirror for left). visual.md §3.3.
  function drawBodySide(ctx, pal, color, skin, hair, longHair, emblemColor, visorA, facing, seatTint, role, state, frame) {
    var flip = (facing === 'left');
    // Mirror by reflecting x within the 16-wide cell when facing left.
    var X = function (x, w) { return flip ? (16 - x - (w || 1)) : x; };

    // Legs (front/back).
    pr(X(7, 3), 16, 3, 5, pal.suitDark);          // front leg
    pr(X(5, 3), 16, 3, 5, rgba(pal.suitDark, 1)); // back leg
    pr(X(7, 3), 21, 3, 2, pal.boot);
    pr(X(5, 3), 21, 3, 2, pal.boot);
    pr(X(5, 6), 20, 6, 1, color, 0.6);            // ankle accent

    // Torso (narrower).
    pr(X(5, 7), 8, 7, 8, pal.suitDark);
    pr(X(5, 5), 9, 5, 2, pal.suitMid);
    pr(X(7, 3), 10, 3, 4, emblemColor, 0.8);      // emblem partial *** neon ***

    // Arms — front arm visible, back arm a sliver.
    pr(X(4, 2), 9, 2, 5, pal.suitDark);           // back arm sliver
    pr(X(9, 2), 9, 2, 6, pal.suitDark);           // front arm
    pr(X(9, 2), 14, 2, 2, skin);                  // front hand

    // Neck.
    pr(X(7, 2), 7, 2, 1, skin);

    // Head (narrower profile).
    pr(X(5, 6), 1, 6, 6, skin);
    pr(X(5, 6), 0, 6, 2, hair);
    pr(X(4, 1), 1, 1, 5, hair);                   // back hair edge
    if (longHair) pr(X(4, 1), 2, 1, 3, hair);
    // Visor band on the front half.
    withGlow(ctx, color, 4, function () { pr(X(8, 3), 3, 3, 1, color, visorA); });

    drawRoleLayer(ctx, role, pal, color, facing, state, frame);
  }

  // --- WALKING (visual.md §3.5.2). 4-frame leg swing + 1px body bob. ----------
  function drawWalking(ctx, s, pal, color, skin, hair, longHair, facing, frame, selBoost, role) {
    var f = frame % 4; // [contactL, passing, contactR, passing]
    var lift = (f === 1 || f === 3) ? -1 : 0; // body lifts on passing frames

    // Ground shadow (squashes a touch while walking).
    pr(4, 22, 8, 2, 'rgba(0,0,0,0.32)');
    pr(5, 23, 6, 1, 'rgba(0,0,0,0.48)');

    // Re-origin for body lift (everything above legs shifts up on passing frames).
    var saveOy = _oy;
    // Legs first (do NOT lift legs as much — contact frames keep feet planted).
    drawWalkLegs(pal, color, facing, f);

    // Lift the torso/head by `lift` art-px.
    begin(ctx, _ox, saveOy + lift * s, s);
    if (facing === 'up') {
      drawWalkUpper(ctx, pal, color, skin, hair, longHair, 'up', f, color, role);
    } else if (facing === 'left' || facing === 'right') {
      drawWalkUpper(ctx, pal, color, skin, hair, longHair, facing, f, color, role);
    } else {
      drawWalkUpper(ctx, pal, color, skin, hair, longHair, 'down', f, color, role);
    }
    begin(ctx, _ox, saveOy, s); // restore
  }

  function drawWalkLegs(pal, color, facing, f) {
    if (facing === 'left' || facing === 'right') {
      var flip = (facing === 'left');
      var X = function (x, w) { return flip ? (16 - x - (w || 1)) : x; };
      // SIDE stride (visual.md §3.5.2).
      if (f === 0) { pr(X(8, 3), 16, 3, 5, pal.suitDark); pr(X(4, 3), 16, 3, 5, pal.suitDark, 0.85); }
      else if (f === 2) { pr(X(7, 3), 16, 3, 5, pal.suitDark); pr(X(5, 3), 16, 3, 4, pal.suitDark, 0.85); }
      else { pr(X(6, 3), 16, 3, 5, pal.suitDark); } // passing — together
      pr(X(5, 6), 20, 6, 1, color, 0.5);
      // boots
      pr(X((f === 0) ? 8 : (f === 2 ? 7 : 6), 3), 21, 3, 2, pal.boot);
      return;
    }
    // DOWN/UP front-facing legs.
    if (f === 0) {              // contactL: left fwd (longer), right back (shorter)
      pr(5, 16, 3, 6, pal.suitDark); pr(8, 16, 3, 4, pal.suitDark);
      pr(5, 21, 3, 2, pal.boot); pr(8, 19, 3, 2, pal.boot);
    } else if (f === 2) {       // contactR: mirror
      pr(8, 16, 3, 6, pal.suitDark); pr(5, 16, 3, 4, pal.suitDark);
      pr(8, 21, 3, 2, pal.boot); pr(5, 19, 3, 2, pal.boot);
    } else {                    // passing: legs centered together
      pr(6, 16, 2, 5, pal.suitDark); pr(8, 16, 2, 5, pal.suitDark);
      pr(6, 20, 4, 2, pal.boot);
    }
    pr(5, 20, 6, 1, color, 0.5); // ankle accent
  }

  // Upper body for walking (torso/arms/head) — reuses standing torso/head with a
  // small arm swing. Arms swing opposite on passing frames.
  function drawWalkUpper(ctx, pal, color, skin, hair, longHair, facing, f, emblemColor, role) {
    var swing = (f === 1) ? -1 : (f === 3 ? 1 : 0);
    if (facing === 'up') {
      // Torso back.
      pr(4, 8, 8, 8, pal.suitDark);
      pr(5, 9, 6, 5, pal.suitMid);
      pr(7, 9, 2, 5, color, 0.8);
      pr(3 + swing, 9, 2, 6, pal.suitDark);
      pr(11 - swing, 9, 2, 6, pal.suitDark);
      pr(7, 7, 2, 1, hair);
      pr(4, 0, 8, 6, hair);
      if (longHair) { pr(3, 2, 1, 3, hair); pr(12, 2, 1, 3, hair); }
      withGlow(ctx, color, 4, function () { pr(5, 5, 6, 1, color, 0.85); });
      drawRoleLayer(ctx, role, pal, color, 'up', 'walking', f);
      return;
    }
    if (facing === 'left' || facing === 'right') {
      var flip = (facing === 'left');
      var X = function (x, w) { return flip ? (16 - x - (w || 1)) : x; };
      pr(X(5, 7), 8, 7, 8, pal.suitDark);
      pr(X(5, 5), 9, 5, 2, pal.suitMid);
      pr(X(7, 3), 10, 3, 4, emblemColor, 0.8);
      pr(X(9, 2), 9 + swing, 2, 6, pal.suitDark); // front arm swings
      pr(X(9, 2), 14 + swing, 2, 2, skin);
      pr(X(7, 2), 7, 2, 1, skin);
      pr(X(5, 6), 1, 6, 6, skin);
      pr(X(5, 6), 0, 6, 2, hair);
      pr(X(4, 1), 1, 1, 5, hair);
      withGlow(ctx, color, 4, function () { pr(X(8, 3), 3, 3, 1, color, 0.9); });
      drawRoleLayer(ctx, role, pal, color, facing, 'walking', f);
      return;
    }
    // DOWN.
    pr(4, 8, 8, 8, pal.suitDark);
    pr(5, 9, 6, 2, pal.suitMid);
    pr(4, 8, 8, 1, pal.suitMid);
    pr(6, 10, 4, 4, emblemColor, 0.85);
    pr(7, 11, 2, 2, '#ffffff', 0.7);
    pr(3, 9 + swing, 2, 6, pal.suitDark);  // left arm swing
    pr(11, 9 - swing, 2, 6, pal.suitDark); // right arm swing
    pr(3, 14 + swing, 2, 2, skin);
    pr(11, 14 - swing, 2, 2, skin);
    pr(7, 7, 2, 1, skin);
    pr(4, 1, 8, 6, skin);
    pr(4, 0, 8, 2, hair);
    pr(3, 1, 1, 4, hair);
    pr(12, 1, 1, 4, hair);
    pr(4, 1, 8, 1, hair);
    if (longHair) { pr(3, 2, 1, 2, hair); pr(12, 2, 1, 2, hair); }
    pr(5, 3, 6, 2, '#05070f');
    withGlow(ctx, color, 4, function () { pr(5, 3, 6, 1, color, 0.9); });
    pr(6, 3, 1, 1, '#ffffff', 0.8);

    drawRoleLayer(ctx, role, pal, color, 'down', 'walking', f);
  }

  // --- SEATED / sit-and-type (visual.md §3.5.3). Used for coding & searching. --
  // Lower legs occluded by chair; torso lowered ~2px; hands tap on the desk.
  function drawSeated(ctx, s, pal, color, skin, hair, longHair, facing, state, frame, selBoost, role) {
    var typeUp = (frame % 2) === 1; // 2-frame typing tap
    var emblemColor = (state === 'searching') ? pal.amber : color;

    // No ground shadow (chair has its own). Lower the whole rig by 2 art-px.
    var saveOy = _oy;
    begin(ctx, _ox, saveOy + 2 * s, s);

    // Seated thighs only (no boots).
    pr(6, 16, 4, 3, pal.suitDark);

    if (facing === 'up') {
      // Back to camera, hunched over keyboard.
      pr(4, 8, 8, 8, pal.suitDark);
      pr(5, 9, 6, 5, pal.suitMid);
      pr(7, 9, 2, 5, color, 0.8);   // spine
      pr(4, 0, 8, 6, hair);
      if (longHair) { pr(3, 2, 1, 3, hair); pr(12, 2, 1, 3, hair); }
      withGlow(ctx, color, 4, function () { pr(5, 5, 6, 1, color, 0.85); });
      // Forearms forward onto desk.
      var hy = typeUp ? 14 : 15;
      pr(4, hy, 2, 2, skin);   // L hand
      pr(10, hy, 2, 2, skin);  // R hand
      drawRoleLayer(ctx, role, pal, color, 'up', state, frame);
    } else if (facing === 'left' || facing === 'right') {
      var flip = (facing === 'left');
      var X = function (x, w) { return flip ? (16 - x - (w || 1)) : x; };
      pr(X(5, 7), 8, 7, 8, pal.suitDark);
      pr(X(5, 5), 9, 5, 2, pal.suitMid);
      pr(X(7, 3), 10, 3, 4, emblemColor, 0.8);
      pr(X(5, 6), 1, 6, 6, skin);
      pr(X(5, 6), 0, 6, 2, hair);
      pr(X(4, 1), 1, 1, 5, hair);
      withGlow(ctx, color, 4, function () { pr(X(8, 3), 3, 3, 1, color, 0.9); });
      var hyS = typeUp ? 14 : 15;
      pr(X(9, 2), hyS, 2, 2, skin); // front hand taps
      drawRoleLayer(ctx, role, pal, color, facing, state, frame);
    } else {
      // DOWN seated (faces camera).
      pr(4, 8, 8, 8, pal.suitDark);
      pr(5, 9, 6, 2, pal.suitMid);
      pr(6, 10, 4, 4, emblemColor, 0.85);
      pr(7, 11, 2, 2, '#ffffff', 0.7);
      pr(7, 7, 2, 1, skin);
      pr(4, 1, 8, 6, skin);
      pr(4, 0, 8, 2, hair);
      pr(3, 1, 1, 4, hair); pr(12, 1, 1, 4, hair);
      pr(4, 1, 8, 1, hair);
      if (longHair) { pr(3, 2, 1, 2, hair); pr(12, 2, 1, 2, hair); }
      pr(5, 3, 6, 2, '#05070f');
      withGlow(ctx, color, 4, function () { pr(5, 3, 6, 1, color, 0.95); });
      pr(6, 3, 1, 1, '#ffffff', 0.8);
      var hyD = typeUp ? 14 : 15;
      pr(4, hyD, 2, 2, skin);
      pr(10, hyD, 2, 2, skin);
      drawRoleLayer(ctx, role, pal, color, 'down', state, frame);
    }

    // Occasional keypress sparks (visual.md §3.5.3) in agent color.
    if (typeUp && (frameCounter() % 4 === 0)) {
      pr(4, 13, 1, 1, color, 0.8);
      pr(11, 13, 1, 1, color, 0.8);
    }

    begin(ctx, _ox, saveOy, s); // restore origin
  }

  // ===========================================================================
  // drawBubble(ctx, text, sx, sy, size [, color])   — SPEC §7.1, visual.md §5.5
  // Pixel speech bubble anchored ABOVE the head at screen (sx,sy). Wraps text,
  // max 3 lines + "…". Uses DOM canvas text (smoothing off for crisp-ish look).
  // (sx,sy) is treated as the HEAD screen position; box floats above it with a tail.
  // ===========================================================================
  PixelArt.drawBubble = function (ctx, text, sx, sy, size, color) {
    try {
      var pal = P();
      color = color || pal.cyan;
      text = String(text == null ? '' : text);
      if (!text) return;

      var s = size / ART_TILE;
      // Font size scales with cell but stays readable; clamp to sane bounds.
      var fontPx = Math.max(8, Math.min(16, Math.round(7 * s + 2)));
      ctx.save();
      ctx.font = fontPx + 'px "DejaVu Sans Mono", ui-monospace, Menlo, Consolas, monospace';
      ctx.textBaseline = 'top';

      // Wrap to ~16 chars/line, max 3 lines (visual.md §5.5).
      var maxChars = 16;
      var maxLines = 3;
      var lines = wrapText(text, maxChars, maxLines);

      // Measure widest line.
      var maxW = 0;
      for (var i = 0; i < lines.length; i++) {
        var w = ctx.measureText(lines[i]).width;
        if (w > maxW) maxW = w;
      }
      var padX = Math.round(4 * s), padY = Math.round(3 * s);
      var lineH = Math.round(fontPx * 1.15);
      var boxW = Math.ceil(maxW) + padX * 2;
      var boxH = lines.length * lineH + padY * 2;

      // Position: centered above head, floating ~ (head height) above the anchor.
      var headTop = sy - Math.round(26 * s); // top of sprite head in screen px
      var bx = Math.round(sx - boxW / 2);
      var by = Math.round(headTop - boxH - Math.round(6 * s));

      // Flip below the head if it would clip the top of the canvas.
      var flipped = false;
      if (by < 2) { by = Math.round(sy - 8 * s); flipped = true; }

      // Fade out over the last 0.4s (caller stores agent.bubble.until; we can't
      // see it here, so fade is handled by caller passing a pre-faded color if
      // desired — we keep full alpha box, which is correct for steady display).

      // Box background.
      ctx.fillStyle = rgba(pal.uiPanel, 0.95);
      roundRectFill(ctx, bx, by, boxW, boxH, Math.max(1, Math.round(1.5 * s)));

      // Border glow.
      withGlow(ctx, color, 6, function () {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, Math.round(s));
        roundRectStroke(ctx, bx + 0.5, by + 0.5, boxW - 1, boxH - 1, Math.max(1, Math.round(1.5 * s)));
      });

      // Tail — small triangle pointing toward the head.
      var cx = Math.round(sx);
      ctx.fillStyle = rgba(pal.uiPanel, 0.95);
      if (!flipped) {
        // points down to head
        var ty = by + boxH;
        for (var t = 0; t < 3; t++) {
          ctx.fillRect(cx - (3 - t) * Math.max(1, Math.round(s)) / 2 | 0, ty + t * Math.max(1, Math.round(s)),
            Math.max(1, Math.round((3 - t) * s)), Math.max(1, Math.round(s)));
        }
      } else {
        // points up to head
        var ty2 = by;
        for (var t2 = 0; t2 < 3; t2++) {
          ctx.fillRect(cx - (3 - t2) * Math.max(1, Math.round(s)) / 2 | 0, ty2 - (t2 + 1) * Math.max(1, Math.round(s)),
            Math.max(1, Math.round((3 - t2) * s)), Math.max(1, Math.round(s)));
        }
      }

      // Text.
      ctx.fillStyle = pal.uiText;
      for (var k = 0; k < lines.length; k++) {
        ctx.fillText(lines[k], bx + padX, by + padY + k * lineH);
      }

      ctx.restore();
    } catch (e) { /* never throw */ }
  };

  // Wrap text into up to maxLines of ~maxChars; last line gets an ellipsis if cut.
  function wrapText(text, maxChars, maxLines) {
    var words = text.split(/\s+/);
    var lines = [];
    var cur = '';
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      // Hard-break very long words.
      while (word.length > maxChars) {
        if (cur) { lines.push(cur); cur = ''; if (lines.length >= maxLines) break; }
        lines.push(word.slice(0, maxChars - 1) + '-');
        word = word.slice(maxChars - 1);
        if (lines.length >= maxLines) break;
      }
      if (lines.length >= maxLines) break;
      var trial = cur ? (cur + ' ' + word) : word;
      if (trial.length > maxChars && cur) {
        lines.push(cur);
        cur = word;
        if (lines.length >= maxLines) break;
      } else {
        cur = trial;
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    // Trim & ellipsize.
    if (lines.length > maxLines) lines = lines.slice(0, maxLines);
    if (lines.length === maxLines) {
      // If there were leftover words, mark the last line with an ellipsis.
      var consumed = lines.join(' ').replace(/-/g, '').length;
      if (consumed < text.replace(/\s+/g, ' ').length) {
        var last = lines[maxLines - 1];
        if (last.length >= maxChars) last = last.slice(0, maxChars - 1);
        lines[maxLines - 1] = last + '…';
      }
    }
    return lines.length ? lines : [''];
  }

  // Pixel-ish rounded rect helpers (corners clipped by `r` px). Smoothing is off,
  // so we approximate with a filled rect plus cut corners rather than arcs.
  function roundRectFill(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
    ctx.fillRect(x + r, y, w - 2 * r, h);
    ctx.fillRect(x, y + r, w, h - 2 * r);
  }
  function roundRectStroke(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.lineTo(x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.lineTo(x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.lineTo(x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.closePath();
    ctx.stroke();
  }

  // ===========================================================================
  // drawNameplate(ctx, agent, sx, sy, size)   — SPEC §7.1, visual.md §4
  // Name pill + state dot above head. (sx,sy) = FEET screen pos (same anchor as
  // drawAgent), so we offset upward to sit just above the head.
  // ===========================================================================
  PixelArt.drawNameplate = function (ctx, agent, sx, sy, size) {
    try {
      if (!agent) return;
      var pal = P();
      var s = size / ART_TILE;
      var name = String(agent.name || 'agent');
      var color = agent.color || roleColorFor(agent.role) || pal.cyan;

      var fontPx = Math.max(7, Math.min(13, Math.round(6 * s + 1)));
      ctx.save();
      ctx.font = fontPx + 'px "DejaVu Sans Mono", ui-monospace, Menlo, Consolas, monospace';
      ctx.textBaseline = 'top';

      // State dot color (visual.md §4 / SPEC §5.3).
      var sc = (cfg().stateColor) || {};
      var dotColor = sc[agent.state] || pal.uiTextDim;
      // pulsing for thinking/searching.
      var dotAlpha = 1;
      if (agent.state === 'thinking' || agent.state === 'searching') {
        dotAlpha = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(timeSec() * 5));
      }

      var dotSz = Math.max(2, Math.round(2 * s));
      var gap = Math.round(2 * s);
      var textW = ctx.measureText(name).width;
      var padX = Math.round(3 * s), padY = Math.round(1.5 * s);
      var pillW = Math.ceil(textW) + dotSz + gap + padX * 2;
      var pillH = fontPx + padY * 2;

      // Pill anchored above the head. Head top ≈ feet - 26*s; nameplate at -6 art-y.
      var px0 = Math.round(sx - pillW / 2);
      var py0 = Math.round(sy - Math.round(26 * s) - pillH - Math.round(2 * s));
      if (py0 < 1) py0 = 1;

      // Pill bg + border (border full alpha if selected per visual.md §5.4; the
      // selected boost is applied by drawSelection which the caller pairs with this).
      ctx.fillStyle = rgba(pal.uiPanel, 0.85);
      roundRectFill(ctx, px0, py0, pillW, pillH, Math.max(1, Math.round(s)));
      ctx.strokeStyle = rgba(color, 0.7);
      ctx.lineWidth = Math.max(1, Math.round(s));
      roundRectStroke(ctx, px0 + 0.5, py0 + 0.5, pillW - 1, pillH - 1, Math.max(1, Math.round(s)));

      // State dot.
      ctx.fillStyle = rgba(dotColor, dotAlpha);
      ctx.fillRect(px0 + padX, py0 + Math.round((pillH - dotSz) / 2), dotSz, dotSz);

      // Name text.
      ctx.fillStyle = pal.uiText;
      ctx.fillText(name, px0 + padX + dotSz + gap, py0 + padY);

      ctx.restore();
    } catch (e) { /* never throw */ }
  };

  // ===========================================================================
  // drawSelection(ctx, agent, sx, sy, size)   — SPEC §7.1, visual.md §5.4
  // Animated double ring + corner ticks at the agent's feet, in agent.color.
  // (sx,sy) = FEET screen position. Drawn UNDER the agent by the caller.
  // ===========================================================================
  // Boss reads bigger (×1.12); chrome (glow/ring/nameplate) uses this so it matches
  // the boss body scaled inside drawAgent. Keep in sync with drawAgent's boss scale.
  PixelArt.roleScale = function (role) { return role === 'boss' ? 1.12 : 1; };

  PixelArt.drawSelection = function (ctx, agent, sx, sy, size) {
    try {
      if (!agent) return;
      var pal = P();
      var s = size / ART_TILE;
      var color = agent.color || roleColorFor(agent.role) || pal.cyan;

      // Ring radius pulses ±1 art-px on a sine.
      var pulse = Math.sin(timeSec() * 3);
      var rx = (7 + pulse) * s;   // horizontal radius (ellipse, flatter for ground)
      var ry = (3.2 + pulse * 0.5) * s;
      var cx = sx, cy = sy - 1 * s; // at feet, slightly up so it hugs the ground

      ctx.save();
      withGlow(ctx, color, 8, function () {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, Math.round(s));
        // Outer ring.
        ellipseStroke(ctx, cx, cy, rx, ry);
        // Inner ring (tighter, dimmer).
        ctx.strokeStyle = rgba(color, 0.6);
        ellipseStroke(ctx, cx, cy, rx * 0.7, ry * 0.7);
      });

      // Corner ticks (targeting reticle) — 4 short marks at NE/NW/SE/SW.
      var tick = Math.max(2, Math.round(2 * s));
      var off = rx * 0.92;
      var offy = ry * 0.92;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(cx - off), Math.round(cy - offy), tick, Math.max(1, Math.round(s))); // NW h
      ctx.fillRect(Math.round(cx - off), Math.round(cy - offy), Math.max(1, Math.round(s)), tick);  // NW v
      ctx.fillRect(Math.round(cx + off - tick), Math.round(cy - offy), tick, Math.max(1, Math.round(s))); // NE
      ctx.fillRect(Math.round(cx + off - 1), Math.round(cy - offy), Math.max(1, Math.round(s)), tick);
      ctx.fillRect(Math.round(cx - off), Math.round(cy + offy - 1), tick, Math.max(1, Math.round(s))); // SW
      ctx.fillRect(Math.round(cx - off), Math.round(cy + offy - tick), Math.max(1, Math.round(s)), tick);
      ctx.fillRect(Math.round(cx + off - tick), Math.round(cy + offy - 1), tick, Math.max(1, Math.round(s))); // SE
      ctx.fillRect(Math.round(cx + off - 1), Math.round(cy + offy - tick), Math.max(1, Math.round(s)), tick);
      ctx.restore();
    } catch (e) { /* never throw */ }
  };

  function ellipseStroke(ctx, cx, cy, rx, ry) {
    ctx.beginPath();
    if (ctx.ellipse) {
      ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
    } else {
      // Fallback: approximate with scaled arc.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, Math.abs(ry) / Math.max(0.001, Math.abs(rx)));
      ctx.arc(0, 0, Math.abs(rx), 0, Math.PI * 2);
      ctx.restore();
    }
    ctx.stroke();
  }

  // ===========================================================================
  // drawFX(ctx, w, h, time)   — SPEC §7.1, visual.md §5.3
  // Full-canvas post pass (CSS px): scanlines + faint bloom + vignette.
  // Drawn LAST. Gated by config.fx.{scanlines,bloom,vignette}. Cheap.
  // ===========================================================================
  var _scanPattern = null, _scanPatternKey = '';
  PixelArt.drawFX = function (ctx, w, h, time) {
    try {
      var pal = P();
      var fx = cfg().fx || { scanlines: true, bloom: true, vignette: true };
      if (!w || !h) return;
      ctx.save();
      ctx.imageSmoothingEnabled = false; // re-assert after any transform reset

      // --- Bloom: one barely-there radial haze, additive. ---
      if (fx.bloom) {
        var g = ctx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, Math.max(w, h) * 0.7);
        g.addColorStop(0, rgba(pal.cyan, 0.04));
        g.addColorStop(0.5, rgba(pal.purple, 0.02));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
      }

      // --- Scanlines: cached 2px-tall pattern (row0 transparent, row1 dark). ---
      if (fx.scanlines) {
        if (!_scanPattern || _scanPatternKey !== 'v1') {
          var pc = document.createElement('canvas');
          pc.width = 2; pc.height = 2;
          var pctx = pc.getContext('2d');
          pctx.clearRect(0, 0, 2, 2);
          pctx.fillStyle = 'rgba(0,0,0,0.10)';
          pctx.fillRect(0, 1, 2, 1);
          try { _scanPattern = ctx.createPattern(pc, 'repeat'); _scanPatternKey = 'v1'; } catch (e) { _scanPattern = null; }
        }
        if (_scanPattern) {
          // Optional slow vertical drift.
          var drift = Math.floor((time || 0) * 8) % 2;
          ctx.save();
          ctx.translate(0, drift);
          ctx.fillStyle = _scanPattern;
          ctx.fillRect(0, -2, w, h + 4);
          ctx.restore();
        }
      }

      // --- Vignette: radial transparent → void at corners. ---
      if (fx.vignette) {
        var vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
        vg.addColorStop(0, 'rgba(0,0,0,0)');
        vg.addColorStop(1, rgba(pal.void, 0.45));
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, w, h);
      }

      // --- Ambiance: day/night tint by hour (Wave B/C). A full-canvas wash whose
      //     hue + alpha shift with the real local hour (cool blue at night, warm
      //     amber at dawn/dusk, neutral at midday). Gated by CFG().AMBIANCE_ENABLED
      //     (default ON). Kept subtle so the neon still pops. ---
      if (cfg().AMBIANCE_ENABLED !== false) {
        var tint = ambianceTint();
        if (tint && tint.a > 0.001) {
          ctx.fillStyle = 'rgba(' + tint.r + ',' + tint.g + ',' + tint.b + ',' + tint.a.toFixed(3) + ')';
          ctx.fillRect(0, 0, w, h);
        }
      }

      ctx.restore();
    } catch (e) { /* never throw */ }
  };

  // Ambiance tint for the current local hour. Returns {r,g,b,a}. Three anchor
  // colors blended by hour: deep night (cool indigo), midday (no tint), and the
  // dawn/dusk warm band (amber). Pure; deterministic per minute; never throws.
  function ambianceTint() {
    var hour = 12;
    try { hour = new Date().getHours() + new Date().getMinutes() / 60; } catch (e) { hour = 12; }
    if (!isFinite(hour)) hour = 12;

    // "Daylight" factor 0..1: ~1 around noon, ~0 deep night (centered on 13:00).
    var day = 0.5 + 0.5 * Math.cos(((hour - 13) / 24) * Math.PI * 2);
    // "Golden" factor: peaks near 6:30 (dawn) and 18:30 (dusk).
    function bump(center, width) {
      var d = (hour - center) / width;
      return Math.exp(-d * d);
    }
    var golden = Math.max(bump(6.5, 2.2), bump(18.5, 2.4));

    // Night = cool indigo wash; alpha strongest when day≈0.
    var nightA = (1 - day) * 0.22;
    // Golden = warm amber wash, capped so it never overwhelms.
    var goldA = golden * 0.12;

    // Blend night (indigo) and golden (amber) additively over a neutral base.
    var nr = 30, ng = 40, nb = 90;     // indigo
    var gr = 255, gg = 150, gb = 60;   // amber
    var totA = nightA + goldA;
    if (totA <= 0.001) return { r: 0, g: 0, b: 0, a: 0 };
    var r = (nr * nightA + gr * goldA) / totA;
    var g = (ng * nightA + gg * goldA) / totA;
    var b = (nb * nightA + gb * goldA) / totA;
    if (totA > 0.30) totA = 0.30; // hard cap on overall tint strength
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: totA };
  }

  // ===========================================================================
  // glowText(ctx, text, sx, sy [, opts])   — SPEC §7.1
  // Helper for neon signs / labels. opts = { color, size, align, glow, alpha, font }.
  // ===========================================================================
  PixelArt.glowText = function (ctx, text, sx, sy, opts) {
    try {
      var pal = P();
      opts = opts || {};
      var color = opts.color || pal.cyan;
      var sizePx = opts.size || 14;
      var align = opts.align || 'left';
      var glow = (opts.glow === undefined) ? 8 : opts.glow;
      var alpha = (opts.alpha === undefined) ? 1 : opts.alpha;
      var font = opts.font || (sizePx + 'px "DejaVu Sans Mono", ui-monospace, Menlo, Consolas, monospace');

      ctx.save();
      ctx.font = font;
      ctx.textAlign = align;
      ctx.textBaseline = opts.baseline || 'alphabetic';
      ctx.fillStyle = rgba(color, alpha);
      if (glow > 0) {
        ctx.shadowColor = color;
        ctx.shadowBlur = glow;
        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      }
      ctx.fillText(String(text == null ? '' : text), sx, sy);
      ctx.restore();
    } catch (e) { /* never throw */ }
  };

  // ===========================================================================
  // drawLogoGlyph(ctx, sx, sy, size)   — SPEC §7.1, visual.md §6.1
  // The NEON//WORKS hex-node glyph: a boss node linked to 2 worker satellites.
  // Authored in a 16-art-px box; (sx,sy) = SCREEN top-left; size = box edge px.
  // ===========================================================================
  PixelArt.drawLogoGlyph = function (ctx, sx, sy, size) {
    try {
      var pal = P();
      var s = size / ART_TILE;
      begin(ctx, sx, sy, s);
      var flick = signFlicker('logo');

      // Connector lines first (so nodes sit on top).
      pr(3, 4, 4, 1, pal.cyan, 0.35 * flick);   // core → magenta satellite
      pr(9, 8, 4, 1, pal.cyan, 0.35 * flick);   // core → lime satellite
      pr(7, 4, 1, 4, pal.cyan, 0.30 * flick);

      // Hexagon outline (approximate with px edges) around the core.
      withGlow(ctx, pal.cyan, 6, function () {
        pr(6, 1, 4, 1, pal.cyan, flick);   // top edge
        pr(4, 2, 2, 1, pal.cyan, flick);   // upper-left
        pr(10, 2, 2, 1, pal.cyan, flick);  // upper-right
        pr(3, 4, 1, 8, pal.cyan, flick);   // left edge
        pr(12, 4, 1, 8, pal.cyan, flick);  // right edge
        pr(4, 12, 2, 1, pal.cyan, flick);  // lower-left
        pr(10, 12, 2, 1, pal.cyan, flick); // lower-right
        pr(6, 13, 4, 1, pal.cyan, flick);  // bottom edge
        // Core.
        pr(7, 7, 2, 2, pal.cyan, flick);
      });

      // Two satellite "agent" dots — magenta + lime (the workers).
      withGlow(ctx, pal.magenta, 5, function () { pr(2, 3, 1, 1, pal.magenta, flick); });
      withGlow(ctx, pal.lime, 5, function () { pr(13, 11, 1, 1, pal.lime, flick); });
    } catch (e) { /* never throw */ }
  };

  // ---------------------------------------------------------------------------
  // Neon sign flicker (visual.md §5.2). Mostly 1.0; ~3% chance of a brief stutter
  // dropping alpha to {0.3,0.6,0.9}. Per-key so signs/logo flicker independently.
  // State kept locally; deterministic-ish but lively. Never throws.
  // ---------------------------------------------------------------------------
  var _flick = {};
  function signFlicker(key) {
    var st = _flick[key];
    if (!st) { st = _flick[key] = { until: 0, value: 1, lastT: 0 }; }
    var t = timeSec();
    if (t >= st.until) {
      // Roll for a new stutter ~3% of frames (gate by small time delta so it's
      // frame-rate independent-ish).
      if (Math.random() < 0.03) {
        var picks = [0.3, 0.6, 0.9];
        st.value = picks[(Math.random() * picks.length) | 0];
        st.until = t + (0.05 + Math.random() * 0.12); // 2–5 frames @60fps-ish
      } else {
        st.value = 1.0;
        st.until = t + 0.04;
      }
    }
    return st.value;
  }

  // ---------------------------------------------------------------------------
  // Expose.
  // ---------------------------------------------------------------------------
  App.PixelArt = PixelArt;

})();
