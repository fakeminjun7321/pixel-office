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
      '.graph-legend .sw{width:11px;height:11px;border-radius:2px;display:inline-block;box-shadow:0 0 6px currentColor}'
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

  function open() {
    try {
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
      var title = elem('h2', 'modal-title', '◇ WORKFLOW FLOW');
      var x = elem('button', 'panel-x', '✕');
      x.type = 'button';
      on(x, 'click', closeModal);
      head.appendChild(title);
      head.appendChild(x);

      var body = elem('div', 'modal-body');

      var theRoot = latestRoot();
      if (!theRoot) {
        var empty = elem('div', 'graph-empty',
          'No workflow yet. Dispatch a goal to the Boss to see the task graph.');
        body.appendChild(empty);
      } else {
        var goal = elem('div', 'result-goal',
          'GOAL: ' + truncate(theRoot.desc || theRoot.title, 160));
        body.appendChild(goal);

        var wrap = elem('div', 'graph-wrap');
        var layout = computeLayout(theRoot);
        if (!layout.kids.length) {
          // root exists but no children planned yet: draw root alone.
          var solo = elem('div', 'graph-empty',
            'Boss is planning… subtasks will appear here.');
          // still show the single root node above the message
          wrap.appendChild(buildSoloRoot(theRoot));
          wrap.appendChild(solo);
        } else {
          buildGraph(wrap, layout);
        }
        body.appendChild(wrap);
        body.appendChild(legend());
      }

      var foot = elem('footer', 'modal-foot');
      var refresh = elem('button', 'btn', 'Refresh');
      refresh.type = 'button';
      on(refresh, 'click', function () { open(); });
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
    _installButton: installButton,
    _latestRoot: latestRoot,
    _computeLayout: computeLayout
  };
})();
