// =============================================================================
// markdown.js  ->  App.MD
// PIXEL AI COMPANY ("NEON//WORKS") — pure, synchronous, dependency-free,
// XSS-safe Markdown renderer + light syntax highlighter for artifact previews.
//
// LOAD ORDER: after config.js, before ui.js. NO deps on any other App module.
//
// CONTRACT:
//   App.MD.escape(s)                  -> HTML-escaped string
//   App.MD.render(text)               -> SAFE HTML string (markdown -> HTML)
//   App.MD.highlight(code, lang)      -> HTML with <span class="tok-*"> tokens
//   App.MD.previewable(type, name)    -> 'html' | 'markdown' | 'code' | 'text'
//   App.MD.htmlPreviewSrcdoc(content) -> string for a SANDBOXED <iframe srcdoc>
//
// SECURITY: always escape() first, then transform. Raw user HTML is never
// injected; links are restricted to http/https/mailto. Uses a private-use
// sentinel (U+E000) — NEVER raw control bytes — to protect code spans.
// =============================================================================
window.App = window.App || {};

(function () {
  'use strict';

  var SENT = "ZZMDXSENTZZ"; // private-use sentinel marking a protected (already-final) segment

  // ---------------------------------------------------------------------------
  // escape
  // ---------------------------------------------------------------------------
  function escapeHtml(s) {
    s = (s == null) ? '' : String(s);
    return s.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
  }

  function safeUrl(url) {
    url = String(url == null ? '' : url).trim();
    if (/^(https?:|mailto:)/i.test(url)) return url;
    return null;
  }

  // ---------------------------------------------------------------------------
  // highlight — light generic tokenizer (comments, strings, numbers, keywords).
  // Tokenizes RAW source, escapes each token, wraps in spans. Never throws.
  // ---------------------------------------------------------------------------
  var KEYWORDS = {
    js: wordSet('var let const function return if else for while do switch case break continue new this typeof instanceof in of class extends super import export default try catch finally throw delete void yield async await null true false undefined NaN'),
    py: wordSet('def return if elif else for while in is not and or class import from as try except finally raise with lambda None True False pass break continue global nonlocal yield async await assert del'),
    json: wordSet('true false null'),
    _default: wordSet('function return if else for while class import export const let var public private static void int float double string bool true false null None nil')
  };
  function wordSet(s) {
    var o = {}, a = s.split(' ');
    for (var i = 0; i < a.length; i++) o[a[i]] = true;
    return o;
  }
  function normLang(lang) {
    lang = String(lang || '').toLowerCase();
    if (lang === 'javascript' || lang === 'ts' || lang === 'typescript' || lang === 'jsx' || lang === 'tsx') return 'js';
    if (lang === 'python') return 'py';
    if (KEYWORDS[lang]) return lang;
    return '_default';
  }

  function highlight(code, lang) {
    try {
      code = String(code == null ? '' : code);
      var kw = KEYWORDS[normLang(lang)] || KEYWORDS._default;
      var out = '';
      // comment | string("...",'...',`...`) | number | identifier
      var re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)/g;
      var last = 0, m;
      while ((m = re.exec(code)) !== null) {
        out += escapeHtml(code.slice(last, m.index));
        if (m[1]) out += '<span class="tok-com">' + escapeHtml(m[1]) + '</span>';
        else if (m[2]) out += '<span class="tok-str">' + escapeHtml(m[2]) + '</span>';
        else if (m[3]) out += '<span class="tok-num">' + escapeHtml(m[3]) + '</span>';
        else if (m[4]) {
          out += kw[m[4]] ? ('<span class="tok-kw">' + escapeHtml(m[4]) + '</span>') : escapeHtml(m[4]);
        }
        last = re.lastIndex;
        if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
      }
      out += escapeHtml(code.slice(last));
      return out;
    } catch (e) {
      return escapeHtml(code);
    }
  }

  // ---------------------------------------------------------------------------
  // inline markdown (applied to ALREADY-ESCAPED text): bold, italic, strike,
  // links. Code spans are pre-protected via sentinels before escaping.
  // ---------------------------------------------------------------------------
  function inline(s) {
    // links [text](url) — url validated; text already escaped
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, text, url) {
      var u = safeUrl(url);
      if (!u) return text;
      return '<a href="' + escapeHtml(u) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s;
  }

  // ---------------------------------------------------------------------------
  // render
  // ---------------------------------------------------------------------------
  function render(text) {
    try {
      text = String(text == null ? '' : text);
      var blocks = [];
      function protect(html) { blocks.push(html); return SENT + (blocks.length - 1) + SENT; }

      // 1) fenced code blocks -> protected <pre><code> (highlighted)
      text = text.replace(/```[ \t]*([^\n`]*)\n([\s\S]*?)```/g, function (_, info, body) {
        var lang = (info || '').trim().split(/\s+/)[0] || '';
        var inner = highlight(body.replace(/\n$/, ''), lang);
        return '\n' + protect('<pre class="md-pre"><code class="md-code' + (lang ? (' lang-' + escapeHtml(lang)) : '') + '">' + inner + '</code></pre>') + '\n';
      });
      // 2) inline code -> protected
      text = text.replace(/`([^`\n]+)`/g, function (_, c) {
        return protect('<code class="md-inline">' + escapeHtml(c) + '</code>');
      });

      // 3) escape the remaining text (sentinels are U+E000+digits, survive intact)
      text = escapeHtml(text);

      // 4) block parse, line by line
      var lines = text.split('\n');
      var html = [], i = 0;
      var listStack = [];
      function closeList() { while (listStack.length) html.push(listStack.pop() === 'ul' ? '</ul>' : '</ol>'); }

      while (i < lines.length) {
        var line = lines[i];

        // blank
        if (/^\s*$/.test(line)) { closeList(); i++; continue; }

        // horizontal rule
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { closeList(); html.push('<hr class="md-hr">'); i++; continue; }

        // heading
        var h = line.match(/^\s*(#{1,6})\s+(.*)$/);
        if (h) { closeList(); var lvl = h[1].length; html.push('<h' + lvl + ' class="md-h md-h' + lvl + '">' + inline(h[2]) + '</h' + lvl + '>'); i++; continue; }

        // blockquote (collect consecutive; '>' is escaped to &gt;)
        if (/^\s*&gt;\s?/.test(line)) {
          closeList();
          var buf = [];
          while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*&gt;\s?/, '')); i++; }
          html.push('<blockquote class="md-quote">' + inline(buf.join('<br>')) + '</blockquote>');
          continue;
        }

        // table: header row |...| then a |---|--- separator
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
          closeList();
          var head = splitRow(line);
          i += 2;
          var rows = [];
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
          var t = '<table class="md-table"><thead><tr>';
          for (var c = 0; c < head.length; c++) t += '<th>' + inline(head[c]) + '</th>';
          t += '</tr></thead><tbody>';
          for (var r = 0; r < rows.length; r++) {
            t += '<tr>';
            for (var cc = 0; cc < rows[r].length; cc++) t += '<td>' + inline(rows[r][cc]) + '</td>';
            t += '</tr>';
          }
          t += '</tbody></table>';
          html.push(t);
          continue;
        }

        // unordered list
        var ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
        if (ul) {
          if (!listStack.length || listStack[listStack.length - 1] !== 'ul') { closeList(); html.push('<ul class="md-ul">'); listStack.push('ul'); }
          html.push('<li>' + inline(ul[2]) + '</li>'); i++; continue;
        }
        // ordered list
        var ol = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
        if (ol) {
          if (!listStack.length || listStack[listStack.length - 1] !== 'ol') { closeList(); html.push('<ol class="md-ol">'); listStack.push('ol'); }
          html.push('<li>' + inline(ol[2]) + '</li>'); i++; continue;
        }

        // a line that is solely a protected block (fenced code) -> emit verbatim
        if (/^\d+$/.test(line.trim())) { closeList(); html.push(line.trim()); i++; continue; }

        // paragraph (collect consecutive non-special lines)
        closeList();
        var para = [line];
        i++;
        while (i < lines.length && !/^\s*$/.test(lines[i]) &&
               !/^\s*#{1,6}\s+/.test(lines[i]) &&
               !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) &&
               !/^\s*&gt;\s?/.test(lines[i]) &&
               !/^\s*[-*+]\s+/.test(lines[i]) &&
               !/^\s*\d+[.)]\s+/.test(lines[i]) &&
               lines[i].indexOf(SENT) === -1) {
          para.push(lines[i]); i++;
        }
        html.push('<p class="md-p">' + inline(para.join('\n').replace(/\n/g, '<br>')) + '</p>');
      }
      closeList();

      var result = html.join('\n');
      // 5) restore protected blocks
      result = result.replace(new RegExp(SENT + '(\\d+)' + SENT, 'g'), function (_, n) {
        var b = blocks[+n];
        return (b == null) ? '' : b;
      });
      return result;
    } catch (e) {
      return '<pre class="md-pre">' + escapeHtml(text) + '</pre>';
    }
  }

  function splitRow(line) {
    var s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return s.split('|').map(function (c) { return c.trim(); });
  }

  // ---------------------------------------------------------------------------
  // previewable — choose a render mode for an artifact.
  // ---------------------------------------------------------------------------
  function previewable(type, name) {
    var ext = String(name || '').toLowerCase().split('.').pop();
    if (type === 'html' || ext === 'html' || ext === 'htm' || ext === 'svg') return 'html';
    if (type === 'markdown' || ext === 'md' || ext === 'markdown') return 'markdown';
    if (type === 'code') return 'code';
    var codeExts = { js: 1, ts: 1, jsx: 1, tsx: 1, py: 1, json: 1, css: 1, java: 1, c: 1, cpp: 1, go: 1, rs: 1, rb: 1, sh: 1, yml: 1, yaml: 1, xml: 1, sql: 1 };
    if (codeExts[ext]) return 'code';
    return 'text';
  }

  // ---------------------------------------------------------------------------
  // htmlPreviewSrcdoc — verbatim string for a SANDBOXED iframe (caller sets
  // sandbox="" so scripts are disabled — the sandbox is the security boundary).
  // ---------------------------------------------------------------------------
  function htmlPreviewSrcdoc(content) {
    try { return (content == null) ? '' : String(content); }
    catch (e) { return ''; }
  }

  // ---------------------------------------------------------------------------
  // PUBLIC SURFACE
  // ---------------------------------------------------------------------------
  App.MD = {
    escape: function (s) { try { return escapeHtml(s); } catch (e) { return ''; } },
    render: render,
    highlight: highlight,
    previewable: previewable,
    htmlPreviewSrcdoc: htmlPreviewSrcdoc
  };

})();
