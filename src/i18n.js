// =============================================================================
// i18n.js  ->  App.I18n
// PIXEL AI COMPANY ("NEON//WORKS") — lightweight, dependency-free UI i18n.
//
// LOAD ORDER: right after config.js (module #2). NO deps on other App modules
//   except (optionally) App.Store for persistence and App.state for the current
//   language. Everything is guarded; nothing throws at load.
//
// CONTRACT (Wave B — Korean UI toggle):
//   App.I18n.STRINGS = { en:{...}, ko:{...} }   // UI label dictionaries
//   App.I18n.t(key, vars?)   -> translated string for current lang.
//                               Fallback chain: current -> en -> key.
//                               vars: {name:'x'} replaces "{name}" tokens.
//   App.I18n.getLang()       -> 'en' | 'ko'  (from settings.lang, default 'en')
//   App.I18n.setLang(l)      -> set + persist (App.Store.save) + re-apply DOM,
//                               then notify App.UI to re-render dynamic bits.
//   App.I18n.apply(root?)    -> translate every element under root (default
//                               document) carrying:
//                                 [data-i18n]        -> textContent
//                                 [data-i18n-ph]     -> placeholder attr
//                                 [data-i18n-title]  -> title attr
//                                 [data-i18n-html]   -> innerHTML (TRUSTED keys)
//                               Missing keys are LEFT ALONE (additive — never
//                               blanks out existing text).
//   App.I18n.langs()         -> ['en','ko']  (available languages)
//
// SELF-INSTALL: on DOMContentLoaded (or immediately if DOM is ready) call
//   apply(document) so static shell.html labels translate on first paint.
//
// ASCII-only source (Korean strings live inside string literals, which is
// allowed). No raw control bytes. Classic <script>; no import/export.
// =============================================================================
window.App = window.App || {};

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // STRING DICTIONARIES.
  // Keys are dotted namespaces grouped by surface. en is the canonical set;
  // ko mirrors it. If a ko key is missing, t() falls back to en, then the key.
  // Korean text is intentionally inside string literals (UTF-8) — the rest of
  // the source stays ASCII per project hygiene rules.
  // ---------------------------------------------------------------------------
  var STRINGS = {
    en: {
      // --- brand / hud header ---
      'brand.tagline': 'AI AGENT COLLECTIVE',

      // --- hud buttons (labels) ---
      'hud.dispatch': 'DISPATCH',
      'hud.tasks': 'Tasks',
      'hud.agent': 'Agent',
      'hud.layout': 'Layout',
      'hud.settings': 'Settings',
      'hud.artifacts': 'Artifacts',
      'hud.newco': 'New Co.',
      'hud.sessions': 'Sessions',
      'hud.flow': 'Flow',

      // --- hud button titles (tooltips) ---
      'hud.dispatch.title': 'Dispatch to Boss',
      'hud.tasks.title': 'Task board / New Boss task',
      'hud.agent.title': 'Add a new agent',
      'hud.layout.title': 'Toggle layout edit',
      'hud.settings.title': 'Settings',
      'hud.artifacts.title': 'Artifacts produced by agents',
      'hud.newco.title': 'Start a preset company',
      'hud.sessions.title': 'Save / load company sessions',
      'hud.cost.title': 'Running session cost - click for breakdown',
      'hud.zoomout.title': 'Zoom out',
      'hud.zoomin.title': 'Zoom in',
      'hud.reset.title': 'Reset view',
      'hud.pause.title': 'Pause / resume',
      'hud.flow.title': 'Workflow graph',

      // --- task input placeholder ---
      'hud.task.ph': 'Give the Boss a goal...  (Enter to dispatch)',

      // --- rails ---
      'rail.crew': 'CREW',
      'rail.activity': 'ACTIVITY',

      // --- agent panel ---
      'agent.title': 'Agent',
      'agent.subtitle': 'role / state / model',
      'agent.persona': 'PERSONA & MEMORY',
      'agent.mood': 'MOOD & RELATIONSHIPS',
      'agent.terminal': 'TERMINAL / LOG',
      'agent.customize': 'CUSTOMIZE',
      'agent.send': 'SEND',
      'agent.chat.ph': 'Message this agent directly...  (Enter to send)',

      // --- task board ---
      'board.title': 'TASK BOARD',
      'board.dispatch': 'DISPATCH',
      'board.queued': 'QUEUED',
      'board.running': 'RUNNING',
      'board.done': 'DONE',
      'board.task.ph': 'Give a big goal to the Boss - it will decompose & delegate...',

      // --- layout / furniture palette ---
      'layout.place': 'PLACE FURNITURE',
      'layout.desk': 'Desk',
      'layout.chair': 'Chair',
      'layout.server': 'Server',
      'layout.table': 'Table',
      'layout.plant': 'Plant',
      'layout.coffee': 'Coffee',
      'layout.sign': 'Sign',
      'layout.board': 'Board',
      'layout.done': 'DONE',

      // --- add-agent modal ---
      'add.name': 'NAME',
      'add.role': 'ROLE',
      'add.model': 'MODEL',
      'add.color': 'NEON COLOR',
      'add.system': 'SYSTEM PROMPT',
      'add.preview': 'PREVIEW',
      'add.create': 'CREATE AGENT',
      'add.name.ph': 'e.g. Nova',
      'add.system.ph': "Leave blank to use the role's default prompt...",

      // --- settings modal ---
      'set.title': 'SETTINGS',
      'set.apikey': 'ANTHROPIC API KEY',
      'set.worker': 'WORKER MODEL',
      'set.boss': 'BOSS MODEL',
      'set.websearch': 'WEB SEARCH',
      'set.language': 'LANGUAGE',
      'set.audio': 'AUDIO',
      'set.sound': 'SOUND EFFECTS',
      'set.bgm': 'AMBIENT MUSIC',
      'set.tools': 'TOOLS',
      'set.toolsEnabled': 'ENABLE TOOLS',
      'set.corsProxy': 'CORS PROXY',
      'set.httpAllowlist': 'HTTP ALLOWLIST',
      'set.toolGhPush': 'GH PUSH',
      'share.loaded': 'State loaded.',
      'set.data': 'DATA',
      'set.save': 'SAVE',
      'set.apikey.ph': 'sk-ant-...  (stored locally only)',
      'set.geminikey': 'GEMINI API KEY',
      'set.geminikey.ph': 'AIza...  (stored locally only)',
      'set.safeMode': 'SAFE MODE',
      'set.safeMode.hint': 'Serialize requests + wider gaps to avoid rate-limit/overload (slower, keeps Opus).',
      'set.distribute': 'Distribute models by role',
      'set.distribute.hint': 'Keep Boss on Opus; spread workers across Haiku/Sonnet/Gemini/GPT by your keys.',
      'set.distribute.done': 'Distributed worker models across providers.',
      'set.distribute.nokey': 'Add an API key first.',

      // --- generic actions ---
      'btn.close': 'Close',
      'btn.cancel': 'Cancel',
      'btn.ok': 'OK',
      'btn.next': 'Next',
      'btn.skip': 'Skip',
      'btn.back': 'Back',
      'btn.done': 'Done',
      'btn.approve': 'Approve',
      'btn.revise': 'Revise',
      'btn.reject': 'Reject',

      // --- command palette ---
      'palette.title': 'COMMAND PALETTE',
      'palette.ph': 'Type a command...',

      // --- workflow graph ---
      'graph.title': 'WORKFLOW',
      'graph.empty': 'No active tasks to graph yet.',

      // --- onboarding / tour ---
      'tour.help': 'Help / Tour',
      'tour.skip': 'Skip',
      'tour.next': 'Next',
      'tour.done': 'Done',
      'tour.settings.title': 'Set your API key',
      'tour.settings.body': 'Open Settings to add your Anthropic or OpenAI API key. Agents need it to think.',
      'tour.dispatch.title': 'Dispatch a goal',
      'tour.dispatch.body': 'Type a goal here and hit Dispatch. The Boss breaks it into subtasks for the crew.',
      'tour.watch.title': 'Watch the agents',
      'tour.watch.body': 'Workers walk the office, collaborate, take breaks, and stream their results live.',
      'tour.artifacts.title': 'Collect artifacts',
      'tour.artifacts.body': 'Finished outputs land in Artifacts with a formatted preview.',
      'tour.sessions.title': 'Save sessions',
      'tour.sessions.body': 'Save and reload entire company states from Sessions whenever you like.',

      // --- extra hud buttons (referenced by shell) ---
      'hud.build': 'Build',
      'hud.files': 'Files',
      'hud.run': 'Run',
      'hud.metrics': 'Metrics',
      'hud.graph': 'Graph',
      'hud.whiteboard': 'Board',
      'hud.shop': 'Shop',

      // --- ledger / add-agent / github (referenced by shell) ---
      'ledger.title': 'TASK LEDGER',
      'add.title': '+ NEW AGENT',
      'set.github': 'GITHUB (PUSH PROJECT)',

      // --- files panel / save-to-folder (contract F) ---
      'files.saveFolder': 'Save to Folder',
      'files.saveFolder.hint': 'Write every workspace file to a folder on your computer.',
      'files.saved': 'Saved {count} file(s) to {dir}.',
      'files.saveUnsupported': 'Folder save is not supported in this browser - a ZIP was downloaded instead.',

      // --- attachments (contract F) ---
      'attach.btn': 'Attach',
      'attach.title': 'Attach files for the Boss to read',
      'attach.clear': 'Clear',
      'attach.count': '{count} file(s) attached',

      // --- share / export (contract F) ---
      'share.title': 'SHARE',
      'share.copyLink': 'Copy Link',
      'share.copied': 'Link copied to clipboard.',
      'share.openLink': 'Open Link',
      'share.fromLink': 'Load from Link',
      'share.download': 'Download State',
      'share.load': 'Load State File',
      'share.preset.export': 'Export Preset',
      'share.preset.import': 'Import Preset',

      // --- companion server (contract F) ---
      'companion.label': 'Mac Companion',
      'companion.on': 'On',
      'companion.off': 'Off',
      'companion.hint': 'Run the local mac-companion server to read your files and run your tools.',

      // --- common state words ---
      'state.queued': 'queued',
      'state.running': 'running',
      'state.done': 'done',
      'state.error': 'error',

      // --- overload / rate-limit UX (v7) ---
      'overload.banner': 'API overloaded - auto-retrying...',
      'overload.retry': 'Retry',
      'overload.useHaiku': 'Switch worker + boss to Haiku',
      'overload.failed': 'Hit a rate limit / overload. Retry shortly, switch to Haiku, or use a smaller goal.',

      // --- self-improve (human-in-the-loop) ---
      'selfimprove.title': 'SELF-IMPROVE',
      'selfimprove.btn': 'Self-Improve',
      'selfimprove.run': 'Propose Improvement',
      'selfimprove.analyzing': 'Reading source & proposing an improvement...',
      'selfimprove.proposal': 'PROPOSAL',
      'selfimprove.deploy': 'Deploy & Reload',
      'selfimprove.deployed': 'Deployed. Reloading...',
      'selfimprove.needServed': 'Self-improve needs a served context (GitHub Pages or localhost), not file://.',
      'selfimprove.needGithub': 'Set a GitHub token, owner, and repo in Settings to deploy.',
      'selfimprove.invalid': 'A proposed edit failed validation - deploy is blocked.',
      'selfimprove.hint.ph': 'Optional: hint what to improve (e.g. accessibility, a bug)...'
    },

    ko: {
      'brand.tagline': 'AI 에이전트 컬렉티브',

      'hud.dispatch': '지시',
      'hud.tasks': '작업',
      'hud.agent': '에이전트',
      'hud.layout': '배치',
      'hud.settings': '설정',
      'hud.artifacts': '산출물',
      'hud.newco': '새 회사',
      'hud.sessions': '세션',
      'hud.flow': '흐름',

      'hud.dispatch.title': '보스에게 지시',
      'hud.tasks.title': '작업 보드 / 새 보스 작업',
      'hud.agent.title': '새 에이전트 추가',
      'hud.layout.title': '배치 편집 전환',
      'hud.settings.title': '설정',
      'hud.artifacts.title': '에이전트가 만든 산출물',
      'hud.newco.title': '프리셋 회사 시작',
      'hud.sessions.title': '회사 세션 저장 / 불러오기',
      'hud.cost.title': '현재 세션 비용 - 클릭하면 내역',
      'hud.zoomout.title': '축소',
      'hud.zoomin.title': '확대',
      'hud.reset.title': '화면 초기화',
      'hud.pause.title': '일시정지 / 재개',
      'hud.flow.title': '워크플로 그래프',

      'hud.task.ph': '보스에게 목표를 지시하세요...  (Enter로 전송)',

      'rail.crew': '직원',
      'rail.activity': '활동',

      'agent.title': '에이전트',
      'agent.subtitle': '역할 / 상태 / 모델',
      'agent.persona': '성격 & 기억',
      'agent.mood': '기분 & 관계',
      'agent.terminal': '터미널 / 로그',
      'agent.customize': '꾸미기',
      'agent.send': '전송',
      'agent.chat.ph': '이 에이전트에게 직접 메시지...  (Enter로 전송)',

      'board.title': '작업 보드',
      'board.dispatch': '지시',
      'board.queued': '대기',
      'board.running': '진행 중',
      'board.done': '완료',
      'board.task.ph': '보스에게 큰 목표를 지시하세요 - 분해하고 위임합니다...',

      'layout.place': '가구 배치',
      'layout.desk': '책상',
      'layout.chair': '의자',
      'layout.server': '서버',
      'layout.table': '테이블',
      'layout.plant': '화분',
      'layout.coffee': '커피',
      'layout.sign': '간판',
      'layout.board': '보드',
      'layout.done': '완료',

      'add.name': '이름',
      'add.role': '역할',
      'add.model': '모델',
      'add.color': '네온 색상',
      'add.system': '시스템 프롬프트',
      'add.preview': '미리보기',
      'add.create': '에이전트 생성',
      'add.name.ph': '예: Nova',
      'add.system.ph': '비워두면 역할 기본 프롬프트를 사용합니다...',

      'set.title': '설정',
      'set.apikey': 'ANTHROPIC API 키',
      'set.worker': '워커 모델',
      'set.boss': '보스 모델',
      'set.websearch': '웹 검색',
      'set.language': '언어',
      'set.audio': '오디오',
      'set.sound': '효과음',
      'set.bgm': '배경음악',
      'set.tools': '도구',
      'set.toolsEnabled': '도구 사용',
      'set.corsProxy': 'CORS 프록시',
      'set.httpAllowlist': 'HTTP 허용목록',
      'set.toolGhPush': 'GitHub 푸시',
      'share.loaded': '상태를 불러왔습니다.',
      'set.data': '데이터',
      'set.save': '저장',
      'set.apikey.ph': 'sk-ant-...  (로컬에만 저장됨)',
      'set.geminikey': 'GEMINI API 키',
      'set.geminikey.ph': 'AIza...  (로컬에만 저장됨)',
      'set.safeMode': '안전 모드',
      'set.safeMode.hint': '요청을 1개씩 순차 처리하고 간격을 넓혀 rate-limit/과부하를 피합니다 (느려지지만 Opus 유지).',
      'set.distribute': '역할별 모델 분산',
      'set.distribute.hint': 'Boss는 Opus 유지, 워커는 보유 키에 따라 Haiku/Sonnet/Gemini/GPT로 분산.',
      'set.distribute.done': '워커 모델을 프로바이더별로 분산했습니다.',
      'set.distribute.nokey': 'API 키를 먼저 넣어주세요.',

      'btn.close': '닫기',
      'btn.cancel': '취소',
      'btn.ok': '확인',
      'btn.next': '다음',
      'btn.skip': '건너뛰기',
      'btn.back': '이전',
      'btn.done': '완료',
      'btn.approve': '승인',
      'btn.revise': '수정 요청',
      'btn.reject': '거부',

      'palette.title': '명령 팔레트',
      'palette.ph': '명령을 입력하세요...',

      'graph.title': '워크플로',
      'graph.empty': '아직 그릴 활성 작업이 없습니다.',

      'tour.help': '도움말 / 둘러보기',
      'tour.skip': '건너뛰기',
      'tour.next': '다음',
      'tour.done': '완료',
      'tour.settings.title': 'API 키 설정',
      'tour.settings.body': '설정을 열어 Anthropic 또는 OpenAI API 키를 추가하세요. 에이전트가 사고하려면 키가 필요합니다.',
      'tour.dispatch.title': '목표 지시',
      'tour.dispatch.body': '여기에 목표를 입력하고 지시를 누르세요. 보스가 이를 하위 작업으로 나눠 직원에게 맡깁니다.',
      'tour.watch.title': '에이전트 관찰',
      'tour.watch.body': '직원들이 사무실을 돌아다니며 협업하고, 휴식하고, 결과를 실시간으로 보여줍니다.',
      'tour.artifacts.title': '산출물 모으기',
      'tour.artifacts.body': '완성된 결과물이 산출물에 정리된 미리보기와 함께 쌓입니다.',
      'tour.sessions.title': '세션 저장',
      'tour.sessions.body': '세션에서 회사 전체 상태를 언제든 저장하고 다시 불러올 수 있습니다.',

      'hud.build': '빌드',
      'hud.files': '파일',
      'hud.run': '실행',
      'hud.metrics': '지표',
      'hud.graph': '그래프',
      'hud.whiteboard': '보드',
      'hud.shop': '상점',

      'ledger.title': '작업 원장',
      'add.title': '+ 새 에이전트',
      'set.github': 'GITHUB (프로젝트 푸시)',

      'files.saveFolder': '폴더에 저장',
      'files.saveFolder.hint': '모든 작업 공간 파일을 내 컴퓨터의 폴더에 저장합니다.',
      'files.saved': '{count}개 파일을 {dir}에 저장했습니다.',
      'files.saveUnsupported': '이 브라우저에서는 폴더 저장을 지원하지 않아 대신 ZIP을 내려받았습니다.',

      'attach.btn': '첨부',
      'attach.title': '보스가 읽을 파일 첨부',
      'attach.clear': '지우기',
      'attach.count': '{count}개 파일 첨부됨',

      'share.title': '공유',
      'share.copyLink': '링크 복사',
      'share.copied': '링크를 클립보드에 복사했습니다.',
      'share.openLink': '링크 열기',
      'share.fromLink': '링크에서 불러오기',
      'share.download': '상태 내려받기',
      'share.load': '상태 파일 불러오기',
      'share.preset.export': '프리셋 내보내기',
      'share.preset.import': '프리셋 가져오기',

      'companion.label': '맥 컴패니언',
      'companion.on': '켜짐',
      'companion.off': '꺼짐',
      'companion.hint': '로컬 mac-companion 서버를 실행하면 내 파일을 읽고 내 도구를 실행할 수 있습니다.',

      'state.queued': '대기',
      'state.running': '진행 중',
      'state.done': '완료',
      'state.error': '오류',

      // --- overload / rate-limit UX (v7) ---
      'overload.banner': 'API 과부하 - 자동 재시도 중...',
      'overload.retry': '재시도',
      'overload.useHaiku': '워커·보스를 Haiku로 전환',
      'overload.failed': 'API 한도·과부하로 실패했어요. 잠시 후 재시도하거나 Haiku로 바꾸거나 목표를 작게 나눠보세요.',

      // --- self-improve (human-in-the-loop) ---
      'selfimprove.title': '자가 개선',
      'selfimprove.btn': '자가 개선',
      'selfimprove.run': '개선안 제안',
      'selfimprove.analyzing': '소스를 읽고 개선안을 제안하는 중...',
      'selfimprove.proposal': '제안',
      'selfimprove.deploy': '배포 후 새로고침',
      'selfimprove.deployed': '배포 완료. 새로고침 중...',
      'selfimprove.needServed': '자가 개선은 file://이 아니라 서버 환경(GitHub Pages 또는 localhost)이 필요합니다.',
      'selfimprove.needGithub': '배포하려면 설정에서 GitHub 토큰·소유자·저장소를 입력하세요.',
      'selfimprove.invalid': '제안된 수정이 검증을 통과하지 못해 배포가 차단되었습니다.',
      'selfimprove.hint.ph': '선택: 개선 방향 힌트 (예: 접근성, 버그)...'
    }
  };

  // ---------------------------------------------------------------------------
  // Available languages — derived from the dictionary keys (en is canonical).
  // ---------------------------------------------------------------------------
  function langs() {
    try {
      var ks = Object.keys(STRINGS);
      return ks.length ? ks : ['en'];
    } catch (e) { return ['en']; }
  }

  function isLang(l) {
    return !!(l && Object.prototype.hasOwnProperty.call(STRINGS, l));
  }

  // ---------------------------------------------------------------------------
  // Current language — sourced from App.state.settings.lang, default 'en'.
  // We never throw if App.state isn't ready yet.
  // ---------------------------------------------------------------------------
  function getLang() {
    try {
      var s = App.state && App.state.settings;
      var l = s && s.lang;
      if (isLang(l)) return l;
    } catch (e) {}
    return 'en';
  }

  function setLang(l) {
    if (!isLang(l)) return getLang();
    try {
      App.state = App.state || {};
      App.state.settings = App.state.settings || {};
      App.state.settings.lang = l;
    } catch (e) {}
    // persist (guarded — Store may not be loaded in isolation)
    try {
      if (App.Store && typeof App.Store.save === 'function') App.Store.save();
    } catch (e) {}
    // reflect in DOM immediately
    try { apply(document); } catch (e) {}
    // let the UI layer re-render any dynamic (JS-built) strings
    try {
      if (App.UI && typeof App.UI.onLangChange === 'function') App.UI.onLangChange(l);
    } catch (e) {}
    // mark <html lang> for a11y / CSS hooks (best-effort)
    try {
      if (document && document.documentElement) document.documentElement.setAttribute('lang', l);
    } catch (e) {}
    return l;
  }

  // ---------------------------------------------------------------------------
  // t(key, vars) — fallback chain: current lang -> en -> key.
  // vars: { name: 'x' } substitutes occurrences of "{name}".
  // ---------------------------------------------------------------------------
  function lookup(lang, key) {
    var d = STRINGS[lang];
    if (d && Object.prototype.hasOwnProperty.call(d, key)) return d[key];
    return undefined;
  }

  function interpolate(str, vars) {
    if (!vars || typeof str !== 'string') return str;
    return str.replace(/\{([a-zA-Z0-9_]+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
    });
  }

  function t(key, vars) {
    if (typeof key !== 'string' || !key) return '';
    var lang = getLang();
    var v = lookup(lang, key);
    if (typeof v === 'undefined' && lang !== 'en') v = lookup('en', key);
    if (typeof v === 'undefined') v = key; // last resort: return the key itself
    return interpolate(v, vars);
  }

  // Like t(), but returns undefined when the key is unknown (so apply() can
  // LEAVE existing DOM text untouched rather than overwriting it with the key).
  function tOrNull(key) {
    if (typeof key !== 'string' || !key) return undefined;
    var lang = getLang();
    var v = lookup(lang, key);
    if (typeof v === 'undefined' && lang !== 'en') v = lookup('en', key);
    return v; // may be undefined
  }

  // ---------------------------------------------------------------------------
  // apply(root) — translate marked elements. ADDITIVE: unknown keys are skipped
  // so we never blank out text we don't have a translation for.
  // ---------------------------------------------------------------------------
  function each(list, fn) {
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { fn(list[i]); } catch (e) {}
    }
  }

  function apply(root) {
    var scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return;

    // textContent
    each(scope.querySelectorAll('[data-i18n]'), function (el) {
      var key = el.getAttribute('data-i18n');
      var v = tOrNull(key);
      if (typeof v === 'string') el.textContent = v;
    });

    // placeholder
    each(scope.querySelectorAll('[data-i18n-ph]'), function (el) {
      var key = el.getAttribute('data-i18n-ph');
      var v = tOrNull(key);
      if (typeof v === 'string') el.setAttribute('placeholder', v);
    });

    // title
    each(scope.querySelectorAll('[data-i18n-title]'), function (el) {
      var key = el.getAttribute('data-i18n-title');
      var v = tOrNull(key);
      if (typeof v === 'string') el.setAttribute('title', v);
    });

    // innerHTML (only for keys WE author — values are trusted dictionary text)
    each(scope.querySelectorAll('[data-i18n-html]'), function (el) {
      var key = el.getAttribute('data-i18n-html');
      var v = tOrNull(key);
      if (typeof v === 'string') el.innerHTML = v;
    });

    // aria-label (a11y convenience)
    each(scope.querySelectorAll('[data-i18n-aria]'), function (el) {
      var key = el.getAttribute('data-i18n-aria');
      var v = tOrNull(key);
      if (typeof v === 'string') el.setAttribute('aria-label', v);
    });
  }

  // ---------------------------------------------------------------------------
  // SELF-INSTALL — translate the static shell once the DOM exists.
  // ---------------------------------------------------------------------------
  function boot() {
    try {
      if (document && document.documentElement) {
        document.documentElement.setAttribute('lang', getLang());
      }
    } catch (e) {}
    try { apply(document); } catch (e) {}
  }

  try {
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
      } else {
        // DOM already parsed (script appended late) — apply now.
        boot();
      }
    }
  } catch (e) {}

  // ---------------------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------------------
  App.I18n = {
    STRINGS: STRINGS,
    t: t,
    getLang: getLang,
    setLang: setLang,
    apply: apply,
    langs: langs,
    has: function (key) { return typeof tOrNull(key) === 'string'; }
  };

})();
