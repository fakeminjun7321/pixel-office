window.App = window.App || {};
// =============================================================================
// graph.js  ->  App.Graph   (WORKFLOW GRAPH — read-only DAG viewer)
// PIXEL AI COMPANY ("NEON//WORKS")
//
// Loads BEFORE ui.js (so el/modal helpers from App.UI are not available yet —
// this module brings its own tiny DOM helpers and styles, and mounts into the
// existing #modal-root using the shared modal/panel CSS classes).
//
//   App.Graph.open()  -> opens a modal that draws the current Boss root task and
//                        its child subtasks as a node graph. Columns are laid out
//                        by dependency depth (computed from task._depIds /
//                        _depIndex). Nodes are colored by status; edges connect a
//                        dependency to its dependent.
//
// Self-install: injects a HUD button ("<> Flow") into #hud-controls that calls
// App.Graph.open(). Everything is guarded; never throws into the rAF loop, and
// no-ops gracefully when there are no tasks or dependencies missing.
//
// Classic <script>; no import/export. ASCII source. Attaches to window.App.
// =============================================================================
(function () {
  'use strict';

  function CFG()   { return App.config || {}; }
  function STATE() { return App.state; }

  // --- status -> color -------------------------------------------------------
  // Prefer the pinned config.stateColor map; fall back to sane defaults so the
  // module is robust even if config shape changes.
  var FALLBACK_STATUS = {
    queued:  '#8294c4',
    blocked: '#8294c4',
    running: '#39d7ff',
    done:    '#5dff9b',
    error:   '#ff4d6d',
    boss:    '#9b5cff'
  };
  function statusColor(status) {
    var sc = CFG().stateColor || {};
    if (status === 'done')    return sc.coding   || FALLBACK_STATUS.done;
    if (status === 'running') return sc.walking  || FALLBACK_STATUS.running;
    if (status === 'error')   return sc.error    || FALLBACK_STATUS.error;
    if (status === 'queued' || status === 'blocked')
      return sc.idle || FALLBACK_STATUS.queued;
    return FALLBACK_STATUS.queued;
  }

  // --- tiny DOM helpers (self-contained; ui.js not loaded yet) ---------------
  function elem(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function on(node, evt, fn) {
    if (node && node.addEventListener) node.addEventListener(evt, fn, false);
  }

  // ---------------------------------------------------------------------------
  // DATA: find the most recent Boss root + its children; build a layered graph.
  // ---------------------------------------------------------------------------
  function tasksArr() {
    var s = STATE();
    return (s && Array.isArray(s.tasks)) ? s.tasks : [];
  }

  // Pick the latest root task (parentId == null). Prefer a running root; else the
  // newest by createdAt.
  function latestRoot() {
    var ts = tasksArr();
    var roots = [];
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i];
      if (t && t.parentId == null) roots.push(t);
    }
    if (!roots.length) return null;
    roots.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    // prefer a running root if one exists, else newest
    for (var j = 0; j < roots.length; j++) {
      if (roots[j].status === 'running') return roots[j];
    }
    return roots[0];
  }

  function childrenOf(rootId) {
    var ts = tasksArr(), out = [];
    for (var i = 0; i < ts.length; i++) {
      if (ts[i] && ts[i].parentId === rootId) out.push(ts[i]);
    }
    return out;
  }

  // Compute a column depth for each child using _depIds (resolved dep task ids)
  // first; fall back to _depIndex ordering if ids are absent. Depth 0 = no deps.
  function computeLayout(root) {
    var kids = childrenOf(root.id);
    var byId = {};
    var i;
    for (i = 0; i < kids.length; i++) byId[kids[i].id] = kids[i];

    var depthCache = {};
    function depthOf(task, seen) {
      if (!task) return 0;
      if (depthCache[task.id] != null) return depthCache[task.id];
      seen = seen || {};
      if (seen[task.id]) return 0;        // cycle guard
      seen[task.id] = true;

      var deps = resolveDeps(task, kids);
      if (!deps.length) { depthCache[task.id] = 0; return 0; }
      var max = 0;
      for (var k = 0; k < deps.length; k++) {
        var d = byId[deps[k]];
        if (d) max = Math.max(max, depthOf(d, seen) + 1);
      }
      depthCache[task.id] = max;
      return max;
    }

    // group children by depth
    var cols = {};   // depth -> [tasks]
    var maxDepth = 0;
    for (i = 0; i < kids.length; i++) {
      var dpt = depthOf(kids[i], {});
      maxDepth = Math.max(maxDepth, dpt);
      (cols[dpt] = cols[dpt] || []).push(kids[i]);
    }

    return { root: root, kids: kids, cols: cols, maxDepth: maxDepth };
  }

  // Resolve a child's dependency task ids. Uses _depIds when present, otherwise
  // derives from _depIndex (everything with a smaller _depIndex among siblings).
  function resolveDeps(task, sibs) {
    if (Array.isArray(task._depIds) && task._depIds.length) {
      return task._depIds.slice();
    }
    // _depIndex-based fallback: a child depends on all siblings with a strictly
    // smaller _depIndex (matches the sequential dependency convention).
    if (typeof task._depIndex === 'number' && sibs) {
      var ids = [];
      for (var i = 0; i < sibs.length; i++) {
        var s = sibs[i];
        if (s === task) continue;
        if (typeof s._depIndex === 'number' && s._depIndex < task._depIndex) {
          ids.push(s.id);
        }
      }
      return ids;
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // STYLES: injected once. Reuses modal/panel look; adds graph-specific bits.
  // ---------------------------------------------------------------------------
  var STYLE_ID = 'graph-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.graph-wrap{position:relative;width:100%;overflow:auto;background:rgba(10,14,28,.55);',
        'border:1px solid rgba(57,215,255,.18);border-radius:8px;padding:6px;min-height:220px;max-height:60vh}',
      '.graph-canvas{display:block}',
      '.graph-empty{padding:36px 16px;text-align:center;color:#8294c4;font-size:13px;letter-spacing:.04em}',
      '.graph-legend{display:flex;flex-wrap:wrap;gap:10px 16px;margin-top:10px;font-size:11px;color:#8294c4;letter-spacing:.04em}',
      '.graph-legend .lg{display:inline-flex;align-items:center;gap:6px}',
      '.graph-legend .sw{width:11px;height:11px;border-radius:2px;display:inline-block;box-shadow:0 0 6px currentColor}',
      // graph mode tabs (workflow / relationships)
      '.graph-tabs{display:flex;gap:8px;margin:0 0 12px 0}',
      '.graph-tab{cursor:pointer;font:inherit;font-size:11px;letter-spacing:.08em;text-transform:uppercase;',
        'padding:5px 12px;border-radius:6px;border:1px solid rgba(57,215,255,.22);background:rgba(16,22,42,.6);',
        'color:#8294c4}',
      '.graph-tab.is-on{color:#dce6ff;border-color:rgba(57,215,255,.6);box-shadow:0 0 8px rgba(57,215,255,.25)}',
      // whiteboard sticky-note cards
      '.wb-wrap{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;padding:6px 2px}',
      '.wb-card{position:relative;width:248px;max-height:340px;overflow:auto;border-radius:8px;padding:12px 13px;',
        'background:rgba(16,22,42,.92);border:1px solid rgba(57,215,255,.22);box-shadow:0 6px 18px rgba(0,0,0,.35)}',
      '.wb-card .wb-tape{position:absolute;top:-7px;left:50%;width:54px;height:14px;transform:translateX(-50%) rotate(-2deg);',
        'background:rgba(57,215,255,.22);border:1px solid rgba(57,215,255,.35);border-radius:2px}',
      '.wb-card .wb-head{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#39d7ff;',
        'font-family:monospace;margin:2px 0 8px 0;border-bottom:1px solid rgba(57,215,255,.18);padding-bottom:6px}',
      '.wb-card .wb-body{font-size:12px;line-height:1.5;color:#dce6ff}',
      '.wb-card .wb-body .md-body{font-size:12px}',
      '.wb-card.k-plan{border-color:rgba(155,92,255,.4)}',
      '.wb-card.k-plan .wb-head,.wb-card.k-plan .wb-tape{color:#9b5cff;border-color:rgba(155,92,255,.35)}',
      '.wb-card.k-debate{border-color:rgba(93,255,155,.38)}',
      '.wb-card.k-debate .wb-head,.wb-card.k-debate .wb-tape{color:#5dff9b;border-color:rgba(93,255,155,.35)}',
      '.wb-empty{padding:36px 16px;text-align:center;color:#8294c4;font-size:13px;letter-spacing:.04em}'
    ].join('');
    var st = elem('style');
    st.id = STYLE_ID;
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------------------------------------------------------------------------
  // DRAW the graph onto an SVG element. Columns by depth; root on the far left.
  // ---------------------------------------------------------------------------
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    if (attrs) for (var k in attrs) {
      if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    }
    return n;
  }

  function truncate(str, n) {
    str = String(str == null ? '' : str);
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
  }

  function buildGraph(container, layout) {
    container.innerHTML = '';
    var root = layout.root, kids = layout.kids, cols = layout.cols;

    // geometry
    var NW = 168, NH = 52;              // node box
    var COL_GAP = 96, ROW_GAP = 22;     // gaps
    var PAD = 24;
    var nColumns = layout.maxDepth + 2; // +1 for child columns range, +1 for root col
    // Determine the tallest column (in node count) to size canvas height.
    var maxRows = 1;
    for (var d = 0; d <= layout.maxDepth; d++) {
      var arr = cols[d] || [];
      if (arr.length > maxRows) maxRows = arr.length;
    }

    var width = PAD * 2 + nColumns * NW + (nColumns - 1) * COL_GAP;
    var height = PAD * 2 + maxRows * NH + (maxRows - 1) * ROW_GAP;
    height = Math.max(height, NH + PAD * 2);

    var svg = svgEl('svg', {
      'class': 'graph-canvas',
      width: width, height: height,
      viewBox: '0 0 ' + width + ' ' + height
    });

    // position map: taskId -> {x,y,cx,cy}
    var pos = {};

    // ROOT node (column 0, vertically centered)
    var rootX = PAD;
    var rootY = (height - NH) / 2;
    pos[root.id] = { x: rootX, y: rootY, cx: rootX + NW, cy: rootY + NH / 2 };

    // CHILD columns: depth 0 -> column index 1, etc.
    function colX(depth) { return PAD + (depth + 1) * (NW + COL_GAP); }
    for (var depth = 0; depth <= layout.maxDepth; depth++) {
      var list = cols[depth] || [];
      var colH = list.length * NH + (list.length - 1) * ROW_GAP;
      var startY = (height - colH) / 2;
      for (var r = 0; r < list.length; r++) {
        var ty = startY + r * (NH + ROW_GAP);
        var tx = colX(depth);
        pos[list[r].id] = { x: tx, y: ty, cx: tx + NW, cy: ty + NH / 2 };
      }
    }

    // EDGES first (so nodes paint on top). root -> each child with no resolved
    // sibling deps; child -> child for resolved deps.
    var edgeLayer = svgEl('g', {});
    svg.appendChild(edgeLayer);

    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      var deps = resolveDeps(k, kids);
      var to = pos[k.id];
      if (!to) continue;
      if (!deps.length) {
        // connect from root
        drawEdge(edgeLayer, pos[root.id], to, statusColor(k.status));
      } else {
        for (var j = 0; j < deps.length; j++) {
          var from = pos[deps[j]];
          if (from) drawEdge(edgeLayer, from, to, statusColor(k.status));
        }
      }
    }

    // NODES
    drawNode(svg, pos[root.id], NW, NH, root, true);
    for (var m = 0; m < kids.length; m++) {
      var p = pos[kids[m].id];
      if (p) drawNode(svg, p, NW, NH, kids[m], false);
    }

    container.appendChild(svg);
  }

  function drawEdge(layer, from, to, color) {
    // from right-center of source to left-center of target; smooth cubic.
    var x1 = from.cx, y1 = from.cy;
    var x2 = to.x,  y2 = to.cy;
    var mx = (x1 + x2) / 2;
    var d = 'M' + x1 + ',' + y1 +
            ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2;
    var path = svgEl('path', {
      d: d, fill: 'none',
      stroke: color || '#39d7ff',
      'stroke-width': '2',
      'stroke-opacity': '0.55'
    });
    layer.appendChild(path);
  }

  function drawNode(svg, p, w, h, task, isRoot) {
    var color = isRoot ? FALLBACK_STATUS.boss : statusColor(task.status);
    var g = svgEl('g', {});

    var rect = svgEl('rect', {
      x: p.x, y: p.y, width: w, height: h, rx: 7, ry: 7,
      fill: 'rgba(16,22,42,.92)',
      stroke: color, 'stroke-width': isRoot ? '2.4' : '1.6'
    });
    g.appendChild(rect);

    // status dot (top-left inside)
    var dot = svgEl('circle', {
      cx: p.x + 12, cy: p.y + 13, r: 4, fill: color
    });
    g.appendChild(dot);

    // role / kind label (small, top)
    var roleLabel = isRoot ? 'BOSS' : roleText(task.role);
    var kind = svgEl('text', {
      x: p.x + 24, y: p.y + 17,
      fill: color, 'font-size': '9',
      'font-family': 'monospace', 'letter-spacing': '0.08em'
    });
    kind.textContent = String(roleLabel).toUpperCase();
    g.appendChild(kind);

    // title (main)
    var title = svgEl('text', {
      x: p.x + 12, y: p.y + 35,
      fill: '#dce6ff', 'font-size': '12',
      'font-family': 'sans-serif'
    });
    title.textContent = truncate(task.title || task.desc || '(task)', 24);
    g.appendChild(title);

    // status text (bottom)
    var st = svgEl('text', {
      x: p.x + 12, y: p.y + 47,
      fill: '#8294c4', 'font-size': '9',
      'font-family': 'monospace', 'letter-spacing': '0.06em'
    });
    st.textContent = String(task.status || 'queued').toUpperCase();
    g.appendChild(st);

    svg.appendChild(g);
  }

  function roleText(role) {
    var roles = CFG().ROLES || {};
    if (roles[role] && roles[role].label) return roles[role].label;
    return role || 'task';
  }

  // ---------------------------------------------------------------------------
  // RELATIONSHIP GRAPH — agents as nodes (role color); edges weighted by mutual
  // affinity from agent.relationships. Read-only; circular layout. Reuses the
  // same SVG plumbing as the workflow graph.
  // ---------------------------------------------------------------------------
  function agentsArr() {
    var s = STATE();
    return (s && Array.isArray(s.agents)) ? s.agents : [];
  }

  function agentColor(a) {
    if (a && a.color) return a.color;
    var roles = CFG().ROLES || {};
    if (a && roles[a.role] && roles[a.role].color) return roles[a.role].color;
    return FALLBACK_STATUS.boss;
  }

  // Symmetric affinity weight between two agents (average of both directions if
  // present). Returns 0..1 or null when neither side has recorded a relation.
  function pairAffinity(a, b) {
    var ab = (a.relationships && typeof a.relationships[b.id] === 'number')
      ? a.relationships[b.id] : null;
    var ba = (b.relationships && typeof b.relationships[a.id] === 'number')
      ? b.relationships[a.id] : null;
    if (ab == null && ba == null) return null;
    if (ab == null) return ba;
    if (ba == null) return ab;
    return (ab + ba) / 2;
  }

  function buildRelationshipGraph(container) {
    container.innerHTML = '';
    var agents = agentsArr();
    var n = agents.length;
    if (!n) {
      container.appendChild(elem('div', 'graph-empty',
        'No agents yet. Hire a team to see how they get along.'));
      return;
    }

    var size = Math.max(320, Math.min(560, 90 + n * 42));
    var cx = size / 2, cy = size / 2;
    var R = size / 2 - 64;          // ring radius
    var NR = 22;                    // node circle radius

    var svg = svgEl('svg', {
      'class': 'graph-canvas',
      width: size, height: size,
      viewBox: '0 0 ' + size + ' ' + size
    });

    // positions on a circle (single node -> center)
    var pos = {};
    for (var i = 0; i < n; i++) {
      var a = agents[i];
      if (n === 1) { pos[a.id] = { x: cx, y: cy }; continue; }
      var ang = (-Math.PI / 2) + (i / n) * Math.PI * 2;
      pos[a.id] = { x: cx + Math.cos(ang) * R, y: cy + Math.sin(ang) * R };
    }

    // EDGES (under nodes): one per unordered pair that has a recorded affinity.
    var edgeLayer = svgEl('g', {});
    svg.appendChild(edgeLayer);
    for (var u = 0; u < n; u++) {
      for (var v = u + 1; v < n; v++) {
        var aw = pairAffinity(agents[u], agents[v]);
        if (aw == null) continue;
        var pu = pos[agents[u].id], pv = pos[agents[v].id];
        if (!pu || !pv) continue;
        // affinity 0..1 -> width 1..5, opacity .12..0.85
        var w = 1 + aw * 4;
        var op = 0.12 + aw * 0.73;
        edgeLayer.appendChild(svgEl('line', {
          x1: pu.x, y1: pu.y, x2: pv.x, y2: pv.y,
          stroke: aw >= 0.5 ? '#5dff9b' : '#8294c4',
          'stroke-width': w.toFixed(2),
          'stroke-opacity': op.toFixed(2),
          'stroke-linecap': 'round'
        }));
      }
    }

    // NODES
    for (var m = 0; m < n; m++) {
      var ag2 = agents[m];
      var p = pos[ag2.id];
      if (!p) continue;
      var col = agentColor(ag2);
      var g = svgEl('g', {});
      g.appendChild(svgEl('circle', {
        cx: p.x, cy: p.y, r: NR,
        fill: 'rgba(16,22,42,.95)', stroke: col, 'stroke-width': '2.2'
      }));
      // inner glow dot
      g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 5, fill: col }));
      // name below node
      var nm = svgEl('text', {
        x: p.x, y: p.y + NR + 14,
        fill: '#dce6ff', 'font-size': '11', 'font-family': 'sans-serif',
        'text-anchor': 'middle'
      });
      nm.textContent = truncate(ag2.name || roleText(ag2.role), 14);
      g.appendChild(nm);
      // role above node
      var rl = svgEl('text', {
        x: p.x, y: p.y - NR - 6,
        fill: col, 'font-size': '8.5', 'font-family': 'monospace',
        'letter-spacing': '0.08em', 'text-anchor': 'middle'
      });
      rl.textContent = String(roleText(ag2.role)).toUpperCase();
      g.appendChild(rl);
      svg.appendChild(g);
    }

    container.appendChild(svg);
  }

  function relationshipLegend() {
    var wrap = elem('div', 'graph-legend');
    var items = [
      ['Close (>=0.5)', '#5dff9b'],
      ['Distant (<0.5)', '#8294c4']
    ];
    for (var i = 0; i < items.length; i++) {
      var lg = elem('span', 'lg');
      var sw = elem('span', 'sw');
      sw.style.color = items[i][1];
      sw.style.background = items[i][1];
      lg.appendChild(sw);
      lg.appendChild(document.createTextNode(items[i][0]));
      wrap.appendChild(lg);
    }
    var note = elem('span', 'lg');
    note.appendChild(document.createTextNode('Thicker / brighter = closer'));
    wrap.appendChild(note);
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // WHITEBOARD — render the current Boss plan + latest debate/ledger as sticky
  // cards. Uses App.MD.render for the card bodies when available.
  // ---------------------------------------------------------------------------
  function mdRender(text) {
    try {
      if (App.MD && typeof App.MD.render === 'function') return App.MD.render(text);
    } catch (e) {}
    // fallback: escaped plain text with line breaks
    var esc = String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<p>' + esc.replace(/\n/g, '<br>') + '</p>';
  }

  function stickyCard(kind, heading, mdText) {
    var card = elem('div', 'wb-card' + (kind ? (' k-' + kind) : ''));
    card.appendChild(elem('div', 'wb-tape'));
    card.appendChild(elem('div', 'wb-head', heading));
    var bodyWrap = elem('div', 'wb-body');
    var md = elem('div', 'md-body');
    md.innerHTML = mdRender(mdText);
    bodyWrap.appendChild(md);
    card.appendChild(bodyWrap);
    return card;
  }

  // Collect whiteboard cards from current state. Sources (best-effort, guarded):
  //   - root.desc (goal), root._plan.plan[] (planned subtasks), root._plan.final
  //   - root._debateNotes (team critique)
  //   - state._ledger (facts / plan / progress)
  function collectWhiteboardCards() {
    var cards = [];
    var s = STATE();
    var root = latestRoot();

    if (root && (root.desc || root.title)) {
      cards.push(stickyCard('plan', 'Goal',
        truncate(root.desc || root.title, 600)));
    }

    if (root && root._plan && Array.isArray(root._plan.plan) && root._plan.plan.length) {
      var lines = [];
      for (var i = 0; i < root._plan.plan.length; i++) {
        var it = root._plan.plan[i] || {};
        var who = it.role ? (' _(' + roleText(it.role) + ')_') : '';
        lines.push((i + 1) + '. **' + truncate(it.title || firstWordsLocal(it.instruction, 6), 60) + '**' + who);
        if (it.instruction) lines.push('   ' + truncate(it.instruction, 160));
      }
      cards.push(stickyCard('plan', 'Boss Plan', lines.join('\n')));
    }

    // Ledger (Boss's working notes) if present and populated.
    if (s && s._ledger) {
      var lg = s._ledger;
      var lparts = [];
      if (Array.isArray(lg.plan) && lg.plan.length) {
        lparts.push('**Next steps**');
        for (var j = 0; j < lg.plan.length && j < 6; j++) lparts.push('- ' + truncate(lg.plan[j], 120));
      }
      if (Array.isArray(lg.facts) && lg.facts.length) {
        lparts.push('**Facts**');
        for (var f = 0; f < lg.facts.length && f < 6; f++) lparts.push('- ' + truncate(lg.facts[f], 120));
      }
      if (lparts.length) {
        if (lg.progress) lparts.unshift('_status: ' + lg.progress + '_');
        cards.push(stickyCard('', 'Ledger', lparts.join('\n')));
      }
    }

    if (root && root._debateNotes) {
      cards.push(stickyCard('debate', 'Team Critique',
        truncate(String(root._debateNotes), 800)));
    }

    if (root && root._plan && root._plan.final) {
      cards.push(stickyCard('debate', 'Synthesis',
        truncate(String(root._plan.final), 800)));
    }

    return cards;
  }

  function firstWordsLocal(str, n) {
    str = String(str == null ? '' : str).trim();
    if (!str) return '(task)';
    var parts = str.split(/\s+/);
    return parts.slice(0, n).join(' ') + (parts.length > n ? '…' : '');
  }

  function buildWhiteboard(container) {
    container.innerHTML = '';
    var cards = collectWhiteboardCards();
    if (!cards.length) {
      container.appendChild(elem('div', 'wb-empty',
        'The whiteboard is blank. Dispatch a goal so the Boss can sketch a plan.'));
      return;
    }
    var wrap = elem('div', 'wb-wrap');
    for (var i = 0; i < cards.length; i++) wrap.appendChild(cards[i]);
    container.appendChild(wrap);
  }

  // ---------------------------------------------------------------------------
  // MODAL: mount into #modal-root reusing the shared modal/panel classes.
  // ---------------------------------------------------------------------------
  var MODAL_ID = 'modal-graph';

  function closeModal() {
    var m = document.getElementById(MODAL_ID);
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }

  function legend() {
    var wrap = elem('div', 'graph-legend');
    var items = [
      ['queued', 'Queued', statusColor('queued')],
      ['running', 'Running', statusColor('running')],
      ['done', 'Done', statusColor('done')],
      ['error', 'Error', statusColor('error')],
      ['boss', 'Boss', FALLBACK_STATUS.boss]
    ];
    for (var i = 0; i < items.length; i++) {
      var lg = elem('span', 'lg');
      var sw = elem('span', 'sw');
      sw.style.color = items[i][2];
      sw.style.background = items[i][2];
      lg.appendChild(sw);
      lg.appendChild(document.createTextNode(items[i][1]));
      wrap.appendChild(lg);
    }
    return wrap;
  }

  // Modes: 'workflow' (default, original DAG), 'relationships', 'whiteboard'.
  var MODE_META = {
    workflow:      { title: '◇ WORKFLOW FLOW',  tab: 'Workflow' },
    relationships: { title: '◇ RELATIONSHIPS',  tab: 'Relationships' },
    whiteboard:    { title: '◇ WHITEBOARD',     tab: 'Whiteboard' }
  };

  // Fill the modal body for a given mode. Pure render into `body` (cleared first).
  function renderBody(body, mode) {
    body.innerHTML = '';
    if (mode === 'relationships') {
      var rwrap = elem('div', 'graph-wrap');
      buildRelationshipGraph(rwrap);
      body.appendChild(rwrap);
      body.appendChild(relationshipLegend());
      return;
    }
    if (mode === 'whiteboard') {
      buildWhiteboard(body);
      return;
    }
    // default: workflow DAG (original behavior, unchanged)
    var theRoot = latestRoot();
    if (!theRoot) {
      body.appendChild(elem('div', 'graph-empty',
        'No workflow yet. Dispatch a goal to the Boss to see the task graph.'));
      return;
    }
    body.appendChild(elem('div', 'result-goal',
      'GOAL: ' + truncate(theRoot.desc || theRoot.title, 160)));
    var wrap = elem('div', 'graph-wrap');
    var layout = computeLayout(theRoot);
    if (!layout.kids.length) {
      wrap.appendChild(buildSoloRoot(theRoot));
      wrap.appendChild(elem('div', 'graph-empty',
        'Boss is planning… subtasks will appear here.'));
    } else {
      buildGraph(wrap, layout);
    }
    body.appendChild(wrap);
    body.appendChild(legend());
  }

  // open(mode) — opens (or re-renders) the graph modal in the given mode.
  // Default mode 'workflow' preserves the original App.Graph.open() behavior.
  function open(mode) {
    try {
      if (!MODE_META[mode]) mode = 'workflow';
      ensureStyles();
      var root = document.getElementById('modal-root');
      if (!root) return;

      closeModal(); // re-render fresh each open

      var modal = elem('div', 'modal');
      modal.id = MODAL_ID;
      var scrim = elem('div', 'modal-scrim');
      on(scrim, 'click', closeModal);

      var card = elem('div', 'modal-card');
      var accent = elem('div', 'panel-accent');
      card.appendChild(accent);

      var head = elem('header', 'modal-head');
      var title = elem('h2', 'modal-title', MODE_META[mode].title);
      var x = elem('button', 'panel-x', '✕');
      x.type = 'button';
      on(x, 'click', closeModal);
      head.appendChild(title);
      head.appendChild(x);

      var body = elem('div', 'modal-body');

      // content wrapper — renderBody clears ONLY this, so the tabs row survives.
      var content = elem('div');

      // mode tabs (switch in place, no reopen flicker)
      var tabs = elem('div', 'graph-tabs');
      function makeTab(m) {
        var tb = elem('button', 'graph-tab' + (m === mode ? ' is-on' : ''),
          MODE_META[m].tab);
        tb.type = 'button';
        on(tb, 'click', function () {
          if (m === mode) return;
          mode = m;
          title.textContent = MODE_META[m].title;
          var btns = tabs.querySelectorAll('.graph-tab');
          for (var bi = 0; bi < btns.length; bi++) {
            btns[bi].className = 'graph-tab';
          }
          tb.className = 'graph-tab is-on';
          renderBody(content, m);
        });
        return tb;
      }
      tabs.appendChild(makeTab('workflow'));
      tabs.appendChild(makeTab('relationships'));
      tabs.appendChild(makeTab('whiteboard'));
      body.appendChild(tabs);

      body.appendChild(content);
      renderBody(content, mode);

      var foot = elem('footer', 'modal-foot');
      var refresh = elem('button', 'btn', 'Refresh');
      refresh.type = 'button';
      on(refresh, 'click', function () { renderBody(content, mode); });
      var close = elem('button', 'btn btn-primary', 'Close');
      close.type = 'button';
      on(close, 'click', closeModal);
      foot.appendChild(refresh);
      foot.appendChild(close);

      card.appendChild(head);
      card.appendChild(body);
      card.appendChild(foot);
      modal.appendChild(scrim);
      modal.appendChild(card);
      root.appendChild(modal);
    } catch (e) {
      // never throw out of a UI action
      try { if (App.UI && App.UI.toast) App.UI.toast('Flow view unavailable'); } catch (e2) {}
    }
  }

  // Public entry points for the alternate views.
  function openRelationships() { open('relationships'); }
  function openWhiteboard()   { open('whiteboard'); }

  // renderWhiteboard(root?) — render the sticky-note whiteboard into an arbitrary
  // host element (e.g. a UI-provided overlay). When `root` is omitted, opens the
  // graph modal in whiteboard mode instead. Never throws.
  // (The legacy first-arg `ctx` from the contract is accepted but ignored; this
  //  whiteboard is DOM/SVG-based, not canvas-based.)
  function renderWhiteboard(rootOrCtx, maybeRoot) {
    try {
      ensureStyles();
      var host = maybeRoot || rootOrCtx;
      // If we got a real DOM element to render into, use it; otherwise open modal.
      if (host && host.nodeType === 1) {
        buildWhiteboard(host);
        return host;
      }
      openWhiteboard();
      return null;
    } catch (e) {
      try { if (App.UI && App.UI.toast) App.UI.toast('Whiteboard unavailable'); } catch (e2) {}
      return null;
    }
  }

  // Draw just the root node when there are no children yet.
  function buildSoloRoot(root) {
    var w = 168, h = 52, pad = 16;
    var width = w + pad * 2, height = h + pad * 2;
    var svg = svgEl('svg', {
      'class': 'graph-canvas', width: width, height: height,
      viewBox: '0 0 ' + width + ' ' + height
    });
    var p = { x: pad, y: pad, cx: pad + w, cy: pad + h / 2 };
    drawNode(svg, p, w, h, root, true);
    return svg;
  }

  // ---------------------------------------------------------------------------
  // SELF-INSTALL: inject a HUD button into #hud-controls.
  // ---------------------------------------------------------------------------
  function installButton() {
    try {
      var controls = document.getElementById('hud-controls');
      if (!controls) return false;
      if (document.getElementById('btn-graph')) return true; // already installed
      var btn = elem('button', 'btn');
      btn.id = 'btn-graph';
      btn.type = 'button';
      btn.title = 'Workflow graph of the current Boss task';
      var ico = elem('span', 'btn-ico', '◇'); // diamond
      var lbl = elem('span', 'btn-lbl', 'Flow');
      btn.appendChild(ico);
      btn.appendChild(lbl);
      on(btn, 'click', function () { open(); });
      // Insert near the Tasks/Artifacts cluster: append before cost-meter if present.
      var costMeter = document.getElementById('btn-cost-meter');
      if (costMeter && costMeter.parentNode === controls) {
        controls.insertBefore(btn, costMeter);
      } else {
        controls.appendChild(btn);
      }
      return true;
    } catch (e) { return false; }
  }

  function selfInstall() {
    if (installButton()) return;
    // HUD not ready yet; retry shortly (a few attempts), then give up quietly.
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (installButton() || tries > 20) clearInterval(timer);
    }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', selfInstall, false);
  } else {
    selfInstall();
  }

  // public API
  App.Graph = {
    open: open,
    openRelationships: openRelationships,
    openWhiteboard: openWhiteboard,
    renderWhiteboard: renderWhiteboard,
    _installButton: installButton,
    _latestRoot: latestRoot,
    _computeLayout: computeLayout
  };
})();
