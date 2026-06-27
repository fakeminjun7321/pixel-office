# PIXEL AI COMPANY — Visual Design Spec (Art Director)

> Single source of truth for all procedural pixel art, tiles, FX, and UI chrome.
> Theme: **NEON CYBERPUNK** — near-black navy floor, glowing cyan/magenta/purple accents,
> scanlines + bloom. Everything below is drawn in code with `ctx.fillRect` (no images).
> Note: `SPEC.md` did not exist at authoring time; signatures here are written to match the
> project namespace contract (`App.PixelArt`, `App.config`, the Agent object, `App.state.layout`).
> If a later `SPEC.md` defines different signatures, that file wins — but the **pixel maps,
> palette, and rect coordinates here are still the authoritative art**.

---

## 0. RENDERING MODEL (read first)

- **Internal pixel scale.** Every sprite/tile is authored on a small integer grid, then upscaled.
  - `TILE = 16` art-pixels per tile cell (the "logical" tile is 16×16 art-px).
  - `PX` = how many screen pixels one art-pixel becomes. Default `PX = 3` (so a tile = 48 screen px before camera zoom). Camera zoom multiplies on top.
  - ALWAYS set `ctx.imageSmoothingEnabled = false` once per frame after any context reset.
- **Two-pass crisp pixels.** Recommended: draw the whole world to an offscreen canvas at `1 art-px = 1 device-px` (i.e. world is `cols*16 × rows*16`), then `drawImage` that offscreen onto the visible canvas scaled by `PX*zoom` with smoothing off. This guarantees uniform crisp upscaling and makes glow/scanline post-FX a single cheap pass. Sprites may also be pre-baked to tiny offscreen canvases and cached by `(spriteKey,color,frame,dir)`.
- **Coordinate helper.** A "pixel" `p(x,y,w,h)` inside a sprite means: fill `rect(originX + x, originY + y, w, h)` in art-px. All rect tables below are in art-px relative to the sprite's top-left origin.
- **Drawing primitive used everywhere:**
  ```js
  function px(ctx, x, y, w, h, color){ ctx.fillStyle = color; ctx.fillRect(x|0, y|0, (w||1)|0, (h||1)|0); }
  ```

---

## 1. COLOR PALETTE (named hex — the whole app uses ONLY these)

Expose as `App.config.palette`. Keep the set tight for cohesion.

### 1.1 Environment / floor / walls
| Name | Hex | Use |
|---|---|---|
| `bg.void` | `#070912` | Deepest background, outside-office void, modal scrim base |
| `bg.floor` | `#0d1226` | Main floor fill (dark navy) |
| `bg.floorAlt` | `#0f1530` | Checker variant for floor (every other tile, very subtle) |
| `grid.line` | `#1c2b55` | Base neon grid line on floor |
| `grid.glow` | `#2e57b8` | Brighter grid line accent (drawn 1px, lower alpha overlay) |
| `wall.face` | `#141a33` | Wall front face |
| `wall.top` | `#1d264a` | Wall top edge (lighter, sells height) |
| `wall.trim` | `#39d7ff` | Neon trim strip running along wall tops (cyan) |
| `wall.shadow` | `#080b18` | 1px drop shadow under walls / furniture onto floor |

### 1.2 Neon accents (the 5 signature colors)
| Name | Hex | Mood / use |
|---|---|---|
| `neon.cyan` | `#39d7ff` | Primary brand accent, monitors, wall trim, default Boss-area glow |
| `neon.magenta` | `#ff3df0` | Secondary accent, signage, designer agents |
| `neon.purple` | `#9b5cff` | Tertiary, server racks, meeting zone carpet glow |
| `neon.blue` | `#4d7cff` | Electric blue, UI focus rings, links, engineer agents |
| `neon.lime` | `#5dff9b` | "Success / done / online" accent, researcher agents, status OK |
| `neon.amber` | `#ffc24d` | Warning / "thinking" pulse / coffee, error-adjacent attention |
| `neon.red` | `#ff4d6d` | Error state, blocked task, stop button |

> The 5 *signature* accents are cyan, magenta, purple, blue, lime. amber + red are functional status colors.

### 1.3 Agent body base colors (tint targets — see §3.4)
These are *desaturated suit/uniform* bases; the agent's `color` (neon accent) is layered on as visor/trim/glow so every agent reads as a distinct neon while sharing one silhouette.
| Name | Hex | Use |
|---|---|---|
| `body.suitDark` | `#23304f` | Default body/torso (dark techwear) |
| `body.suitMid` | `#33436b` | Torso highlight panel |
| `body.skin1` | `#e8b48c` | Skin tone A |
| `body.skin2` | `#c98a63` | Skin tone B |
| `body.skin3` | `#f2c7a8` | Skin tone C |
| `body.skin4` | `#a86c4a` | Skin tone D |
| `body.hair1` | `#1a1d2e` | Hair near-black |
| `body.hair2` | `#3a2f4f` | Hair plum |
| `body.hair3` | `#5a4a35` | Hair brown |
| `body.boot` | `#11162b` | Shoes/boots |
| `body.outline` | `#05070f` | 1px dark outline around whole sprite silhouette |

### 1.4 UI chrome (DOM overlays)
| Name | Hex | Use |
|---|---|---|
| `ui.panel` | `#0b1024` | Panel background (95% alpha) |
| `ui.panelEdge` | `#22305c` | Panel 1px border |
| `ui.panelGlowEdge` | `#39d7ff` | Panel accent border / header underline (cyan, glow) |
| `ui.text` | `#dce6ff` | Primary text |
| `ui.textDim` | `#8294c4` | Secondary/dim text, labels |
| `ui.textFaint` | `#4d5d8a` | Placeholder, disabled |
| `ui.btn` | `#16203f` | Button base |
| `ui.btnHover` | `#1d2c54` | Button hover |
| `ui.field` | `#0a0f20` | Input/textarea background |
| `ui.divider` | `#1a2647` | Hairline dividers |
| `ui.scrim` | `rgba(5,7,15,0.72)` | Modal backdrop |

### 1.5 Glow colors (for shadowBlur / radial gradients)
Use the matching neon hex with alpha. Standard glow recipe: `ctx.shadowColor = <neon>; ctx.shadowBlur = 6..14` OR an additive radial-gradient sprite (`screen`/`lighter` composite). Glow alpha typically `0.35–0.6`.

---

## 2. TILE & FURNITURE DESIGN (16×16 art-px tiles)

Each furniture item is keyed by `type` in `App.state.layout.furniture[{type,gx,gy,dir}]`. `dir ∈ {up,down,left,right}`. Tiles are the `App.state.layout.tiles` enum.

Tile enum (suggested): `0 VOID, 1 FLOOR, 2 WALL, 3 CARPET_MEETING, 4 CARPET_BOSS, 5 DOOR`.

### 2.1 FLOOR (tile 1) — neon grid
- Base fill whole 16×16 with `bg.floor`. For checker, if `((gx+gy)&1)` use `bg.floorAlt`.
- Grid lines: draw on the **top edge** (y=0, 16×1) and **left edge** (x=0, 1×16) with `grid.line`. This makes seamless gridlines across the map without double-drawing.
- Glow accent: ~every 4th line (where `gx%4===0` or `gy%4===0`) redraw that edge in `grid.glow` at alpha 0.5 — produces a subtle "data grid" with brighter major lines.
- Optional sparse "floor dot": at tile center `p(7,7,2,2)` in `grid.glow` alpha 0.25 on ~1 in 6 tiles (hash of gx,gy) for texture.

### 2.2 WALL (tile 2) — extruded neon-trim wall
Drawn 16 wide, occupies full cell but reads as a chunky wall with a top lip.
- Top lip (height): `p(0,0,16,5)` = `wall.top`.
- Neon trim line on lip: `p(0,4,16,1)` = `wall.trim` (cyan) — this is the glowing edge; give it shadowBlur 6 cyan.
- Face: `p(0,5,16,11)` = `wall.face`.
- Vertical panel seams: `p(5,6,1,9)` and `p(11,6,1,9)` = `wall.shadow` (subtle paneling).
- Drop shadow onto floor below: when the tile *below* is floor, draw `p(0,15,16,1)`... actually draw onto the floor tile: 2px `wall.shadow` strip at top of the floor tile beneath. (Renderer concern — note it, don't overthink.)

### 2.3 DOOR (tile 5)
- Wall face as above but face color `#0a1024`, with a vertical neon seam `p(7,5,2,11)` in `neon.lime` (open/online feel), shadowBlur 6.

### 2.4 CARPET zones (tiles 3,4) — room floor accent
- Fill 16×16 with `bg.floorAlt`.
- Border glow: 1px inner border (`p(0,0,16,1)`,`p(0,15,16,1)`,`p(0,0,1,16)`,`p(15,0,1,16)`) in zone color at alpha 0.4: meeting = `neon.purple`, boss = `neon.cyan`. Interior gets a faint center glow dot `p(6,6,4,4)` alpha 0.15.
- The point: rooms read as glowing-bordered floor patches, not solid carpets (keeps the dark cyberpunk vibe).

### 2.5 DESK + MONITOR (furniture `desk`) — the hero prop
Desk faces a direction; agent sits on the *opposite* side and types toward the monitor. Author for `dir='up'` (monitor at back/top, chair slot at bottom); rotate/mirror for other dirs.

Desk body (16×16, dir up):
- Desk surface (top): `p(1,9,14,4)` = `#1a2340` with top highlight `p(1,9,14,1)` = `#2a375f`.
- Desk legs/front: `p(2,13,2,3)` and `p(12,13,2,3)` = `#11182f`.
Monitor (sits on desk, upper area):
- Monitor stand: `p(7,7,2,2)` = `#0e1428`.
- Monitor bezel: `p(3,1,10,7)` = `#05070f` (near-black bezel).
- **Screen**: `p(4,2,8,5)` = animated screen fill (see §2.5.1). The screen is the main glow source.
- Bezel bottom chin: `p(4,7,8,1)` = `#0e1530`.
Outline whole desk with `body.outline` where it meets floor; 1px `wall.shadow` under front legs.

**dir variants:** `down` = mirror vertically (monitor near bottom, chair slot top). `left`/`right` = monitor is a thin side-view tower `p(2,2,4,9)` with screen `p(3,3,2,7)` and the desk surface horizontal `p(2,9,12,4)`; chair sits to the open side.

#### 2.5.1 Screen content states (drives the room's neon mood)
The screen fill animates by the *seated agent's state* (or idle code if empty):
- `idle`/no agent: dim — fill `#0a1830`, 1 cyan scanline `p(4,4,8,1)` alpha 0.3.
- `coding`: base `#08121f`; draw 3–4 horizontal "code lines" of random length each frame from a seeded list, colors cycling `neon.cyan / neon.lime / neon.magenta`, e.g. lines at screen rows y=2,3,4 widths {5,7,4} shifting 1px every ~6 frames. Add a 1px blinking caret.
- `searching`: screen shows a scanning bar — a 2px-wide vertical `neon.amber` column sweeping x across the screen each frame.
- `thinking`: slow pulsing solid `neon.purple` at alpha oscillating 0.4↔0.8.
- `meeting`/away: screen dims to `idle`.
Always give the screen a glow: after drawing, set `shadowColor = agent.color || neon.cyan`, `shadowBlur = 10`, and stroke/refill the screen rect once (see §5.1 monitor glow).

### 2.6 CHAIR (furniture `chair`) — usually auto-placed at desk's seat slot
- Seat: `p(4,8,8,4)` = `#19223f`, top hl `p(4,8,8,1)` = `#2b3a64`.
- Backrest (for dir up, back at top): `p(4,3,8,5)` = `#141b34` with neon accent stripe `p(5,4,6,1)` = agent.color (or `neon.blue`) alpha 0.7.
- Legs: `p(5,12,1,3)`,`p(10,12,1,3)` = `#0c1124`.

### 2.7 SERVER RACK (furniture `server`)
Tall, glowing — a signature cyberpunk prop. 16 wide; reads as a 1-tile rack.
- Cabinet: `p(2,1,12,15)` = `#0c1226`, edge highlight `p(2,1,12,1)` = `#1c2748`.
- Rack units: 5 horizontal slots at y = 2,4,6,8,10 (height 1, x 3..13) = `#060912`.
- Blinking LEDs: per slot, 2 small `p(4,row,1,1)` and `p(12,row,1,1)`; cycle colors `neon.lime` (ok) / `neon.amber` (busy) / occasionally `neon.red`, each LED blinks on its own phase (use `(frame + slot*7) % N`). Give the LED column shadowBlur 4.
- Vent grille at bottom `p(4,12,8,3)` = `#10182f` with 3 thin `neon.cyan` lines alpha 0.4.

### 2.8 PLANT (furniture `plant`) — organic contrast (neon-lit foliage)
- Pot: `p(5,11,6,4)` = `#2a2036` (dark plum), rim `p(5,11,6,1)` = `#3a2c4c`.
- Foliage: clustered rects `p(6,4,4,3)`,`p(4,6,4,3)`,`p(8,6,4,3)`,`p(6,7,4,3)` = `#1f6b4a` (deep teal-green) with neon edge highlights `p(7,4,1,1)`,`p(5,6,1,1)`,`p(11,7,1,1)` = `neon.lime` alpha 0.8 (foliage catches neon light). Subtle sway: shift whole foliage block ±1px on a slow sine.

### 2.9 COFFEE MACHINE (furniture `coffee`)
- Body: `p(3,3,10,12)` = `#161d36`, top `p(3,3,10,2)` = `#222c4d`.
- Display: `p(5,5,6,2)` = `neon.cyan` alpha 0.7 (tiny glow).
- Spout + cup: spout `p(7,8,2,1)` `#0c1124`; cup `p(6,10,4,3)` = `#e6ecff`.
- Steam/drip anim (when an agent is on `coffee`): 1px `#dce6ff` particles rising from `p(7,9..2)` alpha fading; or amber "fill" rising in cup.

### 2.10 MEETING TABLE (furniture `table`) — collaboration hub (occupies 2×1 or 2×2; author per cell)
- Tabletop: fill cell `p(0,5,16,8)` = `#1a2238`, top hl `p(0,5,16,1)` = `#2c3960`.
- Center holo: a glowing `neon.purple` ring `p(6,7,4,4)` ring (draw ring as 4 edges) alpha pulsing — sells "they're collaborating around a holo display".
- Edge neon trim `p(0,12,16,1)` = `neon.purple` alpha 0.6 with shadowBlur 8.
- Chairs auto-placed on the open sides during a `meeting` state (agents path to slots around it).

### 2.11 NEON WALL SIGN (furniture `sign`) — flavor, optional placement
A wall-mounted glowing logo/sign (see §6 for the company logo). 16-wide: dark backplate `p(1,2,14,8)` = `#0a0e1e`, glyphs drawn in `neon.magenta`/`neon.cyan` with flicker (see §5.2).

---

## 3. AGENT CHARACTER SPRITE

### 3.1 Canvas size & layout
- **Base resolution: 16 wide × 24 tall art-px** (`SPR_W=16, SPR_H=24`). Sprite origin = top-left; feet sit at the bottom; the character occupies x≈4..12, leaving margin for outline and side-step poses.
- The sprite's "anchor" for world placement is **bottom-center** = `(8, 23)`. When drawn at world cell, place so feet center on the cell's lower-middle; head overhangs upward (taller than tile — that's intended for readable characters).
- Vertical zones (art-px rows, dir=down baseline pose):
  - rows 0–1: hair top
  - rows 1–6: head (with hair sides, face, visor)
  - rows 7–8: neck/collar
  - rows 7–16: torso/arms
  - rows 16–21: legs
  - rows 21–23: feet/boots + 1px ground shadow

### 3.2 Base pixel map — FACING DOWN, idle frame 0 (the canonical pose)
Coordinates are `p(x,y,w,h)` in art-px. Draw in this order (back to front). `C` = `agent.color` (neon accent), tints are from §1.3. Pick `skin`, `hair` per-agent deterministically (hash of id).

```
// --- ground shadow (drawn first, on floor) ---
p( 4,22, 8,2)  color: rgba(0,0,0,0.35)            // soft ellipse-ish shadow (2 stacked: p(5,23,6,1) darker)
p( 5,23, 6,1)  color: rgba(0,0,0,0.5)

// --- legs ---
p( 5,16, 3,5)  body.suitDark      // left leg
p( 8,16, 3,5)  body.suitDark      // right leg
p( 6,17, 1,4)  body.suitMid       // left leg crease hl
p( 9,17, 1,4)  body.suitMid       // right leg crease hl
p( 5,21, 3,2)  body.boot          // left boot
p( 8,21, 3,2)  body.boot          // right boot
p( 5,20, 6,1)  C (alpha 0.6)      // glowing sole/ankle accent line  *** neon tint ***

// --- torso ---
p( 4, 8, 8,8)  body.suitDark      // torso block
p( 5, 9, 6,2)  body.suitMid       // chest panel highlight
p( 6,10, 4,4)  C (alpha 0.85)     // chest emblem / glowing core panel  *** main neon tint ***
p( 7,11, 2,2)  #ffffff (alpha .7) // tiny hot center of emblem
p( 4, 8, 8,1)  body.suitMid       // shoulder line

// --- arms (down pose: at sides) ---
p( 3, 9, 2,6)  body.suitDark      // left arm
p(11, 9, 2,6)  body.suitDark      // right arm
p( 3,14, 2,2)  skin               // left hand
p(11,14, 2,2)  skin               // right hand

// --- neck ---
p( 7, 7, 2,1)  skin

// --- head ---
p( 4, 1, 8,6)  skin               // face block
p( 4, 0, 8,2)  hair               // hair top
p( 3, 1, 1,4)  hair               // hair left side
p(12, 1, 1,4)  hair               // hair right side
p( 4, 1, 8,1)  hair               // hairline/bangs

// --- VISOR (the neon signature of the face) ---
p( 5, 3, 6,2)  #05070f            // visor housing (dark)
p( 5, 3, 6,1)  C                  // glowing visor band  *** neon tint, shadowBlur 4 ***
p( 6, 3, 1,1)  #ffffff (alpha .8) // visor glint

// --- outline pass ---
// After all fills, trace 1px body.outline around the silhouette’s outer edge
// (cheap version: draw the same shapes 1px larger in body.outline BEFORE the fills above,
//  i.e. an "outline underlay": for each major block draw it offset by ±1 in outline color first).
```

> Net read: a hooded/helmeted techwear courier with a glowing visor and a glowing chest core in the agent's neon color. Distinct, cohesive, reads at 16×24 even when small.

### 3.3 Facing variants (4 directions)
Same skeleton; change face/visor and arm placement. Author `down`, `up`, `side` and **mirror `side` for left/right**.

- **DOWN** (toward camera): as §3.2. Visor + chest emblem fully visible. Hands at sides.
- **UP** (away): no face. Head = full `hair` block `p(4,0,8,6)` with a thin `C` nape line `p(5,5,6,1)` (visor glow bleeds around). Chest emblem replaced by a **back panel**: `p(5,9,6,5)` body.suitMid with a vertical `C` spine stripe `p(7,9,2,5)` alpha 0.8. Backpack accent optional `p(6,9,4,3)` darker.
- **SIDE (right; mirror for left)**: head narrower `p(5,1,6,6)`; visor as a short band on the front half `p(8,3,3,1)` = `C`. One visible eye-less profile. Arms: front arm `p(9,9,2,6)`, back arm hidden (just `p(4,9,2,5)` torso-tone sliver). Legs become front/back: front leg `p(7,16,3,5)`, back leg `p(5,16,3,5)` slightly darker. Body slightly narrower: torso `p(5,8,7,8)`.

### 3.4 Per-agent tinting (how `agent.color` + skin/hair vary)
- `agent.color` (a neon hex from §1.2 or custom) is applied to: **visor band, chest emblem/back spine, ankle accent, chair stripe when seated, selection ring, bubble border, panel header.** Everything else stays the shared dark techwear palette → all agents share one silhouette but are instantly distinguishable by neon color.
- Deterministic per-agent picks from `id` hash:
  - `skin = [skin1,skin2,skin3,skin4][hash % 4]`
  - `hair = [hair1,hair2,hair3][hash3 % 3]`
  - Optional hair-shape bit (`hash & 4`): if set, add side bangs `p(3,2,1,2)`,`p(12,2,1,2)` in hair (slightly longer hair) for silhouette variety.
- Role can bias default `color` when none chosen: engineer→`neon.blue`, designer→`neon.magenta`, researcher→`neon.lime`, boss→`neon.cyan`, generalist→`neon.purple`.

### 3.5 ANIMATION FRAMES (exact)

`agent.anim = { frame, t }`. Advance `t` by `dt`; when `t > frameDur` increment `frame` (wrap by clip length). Suggested `frameDur`: walk 0.12s, idle-bob 0.45s, type 0.18s.

#### 3.5.1 Idle-bob — 2 frames (used in `idle`, `thinking`)
- **f0**: base pose (§3.2/§3.3).
- **f1**: whole sprite shifted **up by 1 art-px** (`originY-1`) for rows 0..15 (head+torso bob), legs stay; OR simplest: translate entire sprite `-1px` y and squash shadow by 1px wider (`p(3,22,10,2)`). Visor glow brightens slightly on f1 (alpha 0.85→1.0). Arms: on f1 raise hands 1px (`+ -1` y) for a gentle breathe.
- For `thinking`: also draw a small "…" / pulsing dot above head (see bubble §5.5) and tint emblem to pulse `C`↔`neon.amber`.

#### 3.5.2 Walk — 4 frames × 4 directions
Legs swing; body bobs 1px on contact frames. Walk cycle frames: `[contactL, passing, contactR, passing]`.

Leg deltas (relative to idle leg rects), DOWN/UP facing:
- **f0 contactL**: left leg forward+down `left=p(5,16,3,6)`, right leg back+up `right=p(8,16,3,4)` (shorter). Body y -0.
- **f1 passing**: both legs centered `p(6,16,2,5)` each close together; body y **-1** (lift). Arms swing opposite: left hand back, right hand forward (shift hands ∓1px x).
- **f2 contactR**: mirror of f0 (right leg forward `p(8,16,3,6)`, left `p(5,16,3,4)`). Body y -0.
- **f3 passing**: same as f1 but arm swing reversed.

SIDE facing walk (more pronounced stride):
- **f0**: front leg forward `p(8,16,3,5)`, back leg trailing `p(4,16,3,5)`; front arm back, back arm forward.
- **f1 passing**: legs together under body `p(6,16,3,5)`, body -1px.
- **f2**: back leg now forward `p(7,16,3,5)`, front leg back `p(5,16,3,4)`.
- **f3 passing**: legs together, body -1px, arms mid.
Facing is set from path direction; `left` = mirrored `side`.

#### 3.5.3 Sit-and-type — 2 frames (used in `coding`, also `searching`)
Agent is seated at chair slot facing the desk/monitor (usually `up` or `side`). Render seated:
- Hide lower legs (chair occludes): draw only `p(6,16,4,3)` thighs (seated), no boots, no ground shadow (chair has its own).
- Torso lowered ~2px (`originY+2` for torso/arms/head) to sit in chair.
- Hands on desk/keyboard in front: forearms angled forward.
- **f0**: both hands down `Lhand=p(4,15,2,2)`, `Rhand=p(10,15,2,2)`.
- **f1**: hands up 1px (`y-1`) — typing tap. Alternate f0/f1 at ~0.18s. Add 2–3 tiny `C` "keypress" sparks at hand y occasionally.
- The **monitor screen** (the desk's, §2.5.1) shows the matching `coding`/`searching` content — that animation + the typing hands together sell "working".

#### 3.5.4 Other states
- `meeting`: idle-bob pose, faced toward table center; emblem pulses `neon.purple`; periodic small bubble.
- `coffee`: idle-bob standing at coffee machine; occasional sip = head dips 1px + tiny cup `p(11,12,2,2)` `#e6ecff` at hand.
- `walking`: §3.5.2.
- `thinking`: idle-bob + amber pulse + “…” bubble.

### 3.6 `drawAgent` contract (for `App.PixelArt`)
```
App.PixelArt.drawAgent(ctx, agent, opts)
  // ctx already translated so (0,0)=sprite origin in ART-PX space (caller handles camera/zoom/PX).
  // Reads agent.state, agent.facing, agent.anim.frame, agent.color, agent.id (for skin/hair hash).
  // opts: { seated:bool, selected:bool }  (seated forces the sit-type rig)
  // Must be exception-safe: unknown state -> fall back to idle-bob.
App.PixelArt.drawTile(ctx, tileEnum, gx, gy, frame)
App.PixelArt.drawFurniture(ctx, item, frame, seatedAgent?) // item={type,gx,gy,dir}
App.PixelArt.palette  // = App.config.palette reference
```
All draw fns work purely in art-px; the world renderer sets up `ctx.setTransform` for camera+zoom+PX and `imageSmoothingEnabled=false`.

---

## 4. AGENT NAMEPLATE / STATE BADGE (drawn above sprite, world-space)

- **Name tag**: above head at art-y ≈ -6. Tiny pill: bg `ui.panel` alpha 0.85, 1px border `agent.color` alpha 0.7. Text = agent name in a 5px bitmap-ish font (use canvas `font='6px monospace'` is fine since DOM-free here, but keep size small; smoothing off makes it crisp-ish). Center over `(8,·)`.
- **State icon dot** left of name: 2×2 px dot colored by state — idle `ui.textDim`, walking `neon.cyan`, thinking `neon.amber` (pulsing), coding `neon.lime`, searching `neon.amber`, meeting `neon.purple`, coffee `#e6ecff`, error `neon.red`.

---

## 5. FX

### 5.1 Monitor / emblem glow
Two cheap techniques (use either; offscreen-bake-then-glow is best):
- **shadowBlur method**: when drawing a glowing rect, set `ctx.shadowColor = neonHex; ctx.shadowBlur = 8..14; ctx.shadowOffsetX=shadowOffsetY=0;` then fill the rect. Reset shadowBlur=0 after. Use sparingly (shadowBlur is the priciest op) — only on monitor screens, visors, wall trim, server LEDs, neon signs, selection ring.
- **additive halo sprite**: pre-render a small radial-gradient PNG-in-canvas (center neon→transparent) once per color; draw it with `globalCompositeOperation='lighter'` behind the glowing element, scaled to taste. Cache per color. This gives a richer bloom than shadowBlur and is cheaper at scale.
- Monitors cast a faint colored pool on the floor in front: a low-alpha (0.12) trapezoid/rect of the screen color, `lighter` composite, 2–3 tiles forward of the desk in `dir`.

### 5.2 Neon sign flicker
For wall signs / the top-bar logo glyphs: maintain `flicker` value. Most frames `=1.0`; with ~3% chance per frame for a 2–5 frame "stutter" where alpha randomly drops to {0.3, 0.6, 0.9} then snaps back. Optional per-glyph independent flicker for a broken-sign look on ONE accent letter. Keep subtle so text stays readable.

### 5.3 Scanlines + vignette (full-screen post pass, drawn LAST on the visible canvas, in screen px)
- **Scanlines**: every 2nd device row, fill 1px `rgba(0,0,0,0.10)` across the canvas. Cache as a tiny repeating pattern (2px tall canvas: row0 transparent, row1 alpha) and `fillRect` once with the pattern — cheap. Optional slow vertical drift (offset by `(t*8)%2`).
- **Bloom/haze**: one big radial gradient from screen center, `neon.cyan`/`neon.purple` at alpha ≤0.04, `lighter` — barely-there atmosphere.
- **Vignette**: radial gradient transparent→`bg.void` alpha 0.45 at corners.
- **CRT curve**: skip (not worth perf); scanlines+vignette already sell CRT.
- Make the whole post pass toggleable via `App.config.fx = {scanlines, bloom, vignette}` for low-end devices.

### 5.4 Selection ring (when `App.state.selectedAgentId === agent.id`)
- An animated ring on the floor under the selected agent: ellipse/diamond outline in `agent.color`, drawn in world space at feet (`y≈22`). Two concentric 1px rings, the outer one rotating dashes or pulsing radius `±1px` on a sine. shadowBlur 8 in agent color. Plus 4 corner ticks (NE/NW/SE/SW) like a targeting reticle.
- Also brighten that agent's nameplate border to full alpha.

### 5.5 Speech bubble (world-space, above nameplate) — `agent.bubble = {text, until}`
- **Box**: rounded-ish (pixel rounded: clip corners by 1px) rect, bg `ui.panel` alpha 0.95, 1px border `agent.color`, subtle shadowBlur 6 in agent.color. Padding 3px.
- **Tail**: a 3px triangle (stack of shrinking rects `p(cx-1,by,3,1)`,`p(cx,by+1,1,1)`) pointing down to the head, in same bg + border.
- **Text**: `ui.text`, small monospace, wrap to ~16 chars/line, max 3 lines then `…`. For streaming tokens, show last ~40 chars with a blinking `C` caret. Bubble auto-positions above head; if near top edge, flip below.
- **Special bubbles**:
  - `thinking`: bubble shows pulsing `…` (3 dots animating) in `neon.amber`, no box border glow.
  - inter-agent message (`@Engineer: build X`): tint the `@name` part in that agent's color.
  - `done ✓`: border + a small `neon.lime` check glyph `p` drawn as two strokes.
- Bubbles fade out over the last 0.4s before `until`.

### 5.6 Walking dust / state transitions (optional polish)
- On each walk contact frame, 1–2 single-px `grid.glow` particles puff at feet, fading. Cheap, adds life.
- State change → brief `agent.color` flash ring expanding from chest (1 ring, 0.3s).

---

## 6. LOGO / TOP-BAR TREATMENT

**Company name:** **`NEON//WORKS`**  (alt tagline: "AI AGENT COLLECTIVE"). Use `NEON//WORKS` as the product wordmark; the office is "the floor".

### 6.1 Top bar (DOM, full width)
- Height ~48px. Background: `linear-gradient(90deg, #0a0e1e, #0b1024 60%, #0a0e1e)` with a 1px bottom border `ui.panelGlowEdge` (cyan) glowing (`box-shadow: 0 1px 12px rgba(57,215,255,.35)`).
- **Logo lockup (left):** a small **procedural canvas glyph** (16×16, drawn with the same pixel engine) + wordmark text.
  - Glyph: a stylized **hexagon node** with an inner cyan core and 2 magenta "agent" satellite dots orbiting — i.e. a tiny network/org icon. Draw: hexagon outline `neon.cyan` (approx with px: `p(6,1,4,1),p(4,2,2,1),p(10,2,2,1),p(3,4,1,8)`-ish edges), center core `p(7,7,2,2)` `neon.cyan` glow, two satellites `p(2,3,1,1)` magenta & `p(13,11,1,1)` lime, with 1px connector lines. It should read as "a boss node linked to workers" — literally the app's concept.
  - Wordmark: `NEON` in `ui.text` (or cyan) + `//` in `neon.magenta` + `WORKS` in `ui.text`, font: bold condensed sans / monospace, letter-spacing 2px, uppercase. The `//` flickers per §5.2. Optional subtle text-shadow glow cyan.
- **Center:** the "give big task to Boss" input is fine here OR in a panel; if in bar, style as a glowing field (`ui.field`, focus ring `neon.blue`).
- **Right:** icon buttons — Settings (gear), +Agent, Layout-edit (grid), Pause/Play, Zoom ±. All buttons: `ui.btn` bg, `ui.text` glyph, hover `ui.btnHover` + 1px `neon.cyan` border glow. Active/toggled (e.g. layout edit on) = filled `neon.cyan` bg with dark glyph.
- **Scanline accent:** a 2px animated cyan→magenta gradient line can sweep along the bottom border occasionally (subtle "data flow").

### 6.2 Boot/empty splash
On first run before seeding, show the logo centered over the void with a typewriter "INITIALIZING NEON//WORKS…" in `neon.cyan`, then fade into the office.

---

## 7. PANELS & MODALS (DOM) — visual rules

- All panels: `background: var(--ui-panel)` at 0.96 alpha, `backdrop-filter: blur(4px)`, 1px `ui.panelEdge` border, top accent bar 2px `neon.cyan`, radius 6px, drop shadow `0 8px 32px rgba(0,0,0,.6)` + faint cyan rim `0 0 0 1px rgba(57,215,255,.15)`.
- **Headers**: uppercase, `ui.text`, letter-spacing 1px, with a 1px `neon.cyan` underline that glows.
- **Agent side panel (click agent):** header shows the agent's mini-sprite (re-rendered to a tiny canvas) + name in `agent.color` + role + state badge. Transcript area = `ui.field` bg, monospace, agent messages indented with a left 2px `agent.color` border; user messages with `neon.blue` border. Stats row (tasksDone / tokens) in `ui.textDim` with tiny neon icons. Input at bottom with send button glowing `agent.color`.
- **Task board / kanban:** 3 columns Queued / Running / Done with column header colors `ui.textDim` / `neon.amber` / `neon.lime`. Cards: `ui.btn` bg, left accent bar = assignee agent.color, title `ui.text`, role tag chip, status glow. Running cards get a subtle animated `neon.amber` shimmer bar. "Give big task to Boss" = a prominent textarea + cyan glowing "DISPATCH" button.
- **+Agent modal:** fields name / role (dropdown of presets + custom) / model (3-option picker styled as segmented neon tabs: opus=cyan, sonnet=blue, haiku=lime) / color (swatch row of the §1.2 neons + custom). Live preview canvas of the resulting agent sprite (idle-bob) on the right.
- **Settings modal:** API key (password field, `ui.field`, with show/hide), default model pickers, web-search toggle (a neon switch: off=`ui.textFaint`, on=`neon.lime` glowing), Clear data (danger = `neon.red` outline button), Export/Import JSON buttons.
- **Buttons (global):** primary = `neon.cyan` text on `ui.btn`, hover lifts to `neon.cyan` bg + dark text + glow; danger = `neon.red`; ghost = transparent + `ui.textDim`. Focus ring always `neon.blue` 2px.
- **Toggle/switch component:** 28×16 track, knob 12×12; off track `#1a2236`, on track `neon.lime` alpha .35 + knob glow.
- **Log feed (App.state.log):** monospace small lines; `system` = `ui.textDim`, `msg` = `ui.text` with `@from→@to` colored by those agents, `result` = `neon.lime`. Auto-scroll, max ~200 lines shown.

### 7.1 CSS variable seed (for main.css/inline)
```
:root{
  --void:#070912; --floor:#0d1226; --panel:#0b1024; --panel-edge:#22305c;
  --text:#dce6ff; --text-dim:#8294c4; --text-faint:#4d5d8a;
  --cyan:#39d7ff; --magenta:#ff3df0; --purple:#9b5cff; --blue:#4d7cff; --lime:#5dff9b;
  --amber:#ffc24d; --red:#ff4d6d;
  --btn:#16203f; --btn-hover:#1d2c54; --field:#0a0f20; --divider:#1a2647;
  --scrim:rgba(5,7,15,.72);
  --glow-cyan:0 0 12px rgba(57,215,255,.45);
}
body{ background:var(--void); color:var(--text); font-family:"DejaVu Sans Mono",ui-monospace,Menlo,Consolas,monospace; }
```

---

## 8. DEFAULT SEEDED COMPANY — visual placement guidance (for Store/World)
A furnished readable office on first run (renderer/store implement; this is the *look* target):
- Walls form a rectangular floor (e.g. ~22×16 tiles) with one DOOR on the bottom edge.
- **Boss zone** (top-center): CARPET_BOSS tile patch (cyan-bordered), a desk facing down with a big monitor, a server rack to one side, a neon wall `sign` (the logo) on the back wall behind the Boss.
- **Worker desks** (rows): 4–6 desks along the left/right, each with a chair, monitor, spaced 2 tiles apart; a plant between every couple desks for greenery.
- **Meeting table**: center-bottom, on CARPET_MEETING (purple-bordered), with open chair slots around it — agents gather here during synthesis.
- **Coffee machine** near the door / a corner "break" nook with 1 plant.
- Server rack cluster (2–3) in one corner = the "datacenter", lots of blinking LEDs (focal glow).
- Seeded agents: Boss (cyan), Engineer (blue), Designer (magenta), Researcher (lime) — each at their own desk, distinct neon visor/emblem colors per §3.4.

---

## 9. PALETTE QUICK-REF (copy block for `App.config.palette`)
```js
App.config = App.config || {};
App.config.palette = {
  void:'#070912', floor:'#0d1226', floorAlt:'#0f1530',
  gridLine:'#1c2b55', gridGlow:'#2e57b8',
  wallFace:'#141a33', wallTop:'#1d264a', wallTrim:'#39d7ff', wallShadow:'#080b18',
  cyan:'#39d7ff', magenta:'#ff3df0', purple:'#9b5cff', blue:'#4d7cff', lime:'#5dff9b',
  amber:'#ffc24d', red:'#ff4d6d',
  suitDark:'#23304f', suitMid:'#33436b',
  skin:['#e8b48c','#c98a63','#f2c7a8','#a86c4a'],
  hair:['#1a1d2e','#3a2f4f','#5a4a35'],
  boot:'#11162b', outline:'#05070f',
  uiPanel:'#0b1024', uiPanelEdge:'#22305c', uiText:'#dce6ff', uiTextDim:'#8294c4',
  uiTextFaint:'#4d5d8a', uiBtn:'#16203f', uiBtnHover:'#1d2c54', uiField:'#0a0f20',
  uiDivider:'#1a2647', uiScrim:'rgba(5,7,15,0.72)'
};
App.config.SPR_W = 16; App.config.SPR_H = 24; App.config.TILE = 16; App.config.PX = 3;
App.config.roleColor = { boss:'#39d7ff', engineer:'#4d7cff', designer:'#ff3df0', researcher:'#5dff9b', generalist:'#9b5cff' };
App.config.stateColor = { idle:'#8294c4', walking:'#39d7ff', thinking:'#ffc24d', coding:'#5dff9b', searching:'#ffc24d', meeting:'#9b5cff', coffee:'#dce6ff', error:'#ff4d6d' };
App.config.fx = { scanlines:true, bloom:true, vignette:true };
```

---

## 10. ART DIRECTION PRINCIPLES (don't violate)
1. **One silhouette, many neons.** All agents share the techwear-courier body; identity = neon visor/emblem color. Never recolor whole bodies.
2. **Dark first, glow second.** ~85% of the screen is near-black navy; neon is the spice. Resist neon-everywhere — it kills contrast.
3. **Glow is expensive — budget it.** Only monitors, visors, signs, LEDs, selection, bubbles glow. Floor grid uses flat lines, not shadowBlur.
4. **Readability over realism.** Characters are taller than tiles on purpose; nameplates always legible; bubbles never cover the speaker's head.
5. **Everything animates a little.** Idle-bob, screen flicker, LED blink, plant sway, scanline drift — a living office. But all loops cheap & seeded so it never thrashes the loop.
6. **Functional color is sacred.** lime=ok/done, amber=working/thinking, red=error/blocked, cyan=brand/boss, blue=focus, magenta=design, purple=meeting/generalist. Use consistently across sprites, UI, badges, logs.
