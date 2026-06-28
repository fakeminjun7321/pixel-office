window.App = window.App || {};
/* ===========================================================================
   audio.js -> App.Audio  [Wave 4a: alive office — procedural sound]
   Self-contained Web Audio. ZERO assets. NEVER throws.
   - App.Audio.sfx(name): short procedural blip via a lazily-created
     AudioContext (Oscillator + Gain envelope). Distinct tones for:
       'dispatch','done','qa_fail','coffee','approval','levelup','error','tool'
     Gated by App.state.settings.sound !== false. AudioContext is created/
     resumed only inside this call (a user-gesture-or-later moment); if context
     creation fails, it no-ops.
   - App.Audio.startBgm()/stopBgm()/bgmOn(): a gentle procedural ambient pad
     (a couple of detuned oscillators through a slow LFO-modulated filter) whose
     mood shifts subtly with the hour. Gated by settings.bgm (default OFF);
     startBgm only takes effect after a gesture (i.e. once a context exists).
   Load before ui. Exposes the API for ui (toggles) and orchestrator (sfx hooks).
   =========================================================================== */
(function () {
  'use strict';

  var Audio = {};

  // --- shared lazily-created AudioContext -----------------------------------
  var ctx = null;        // AudioContext | null
  var master = null;     // master GainNode for sfx
  var ctxBroken = false; // set true if creation throws -> permanent no-op

  // --- bgm state ------------------------------------------------------------
  var bgm = null;        // { nodes..., running:true } | null
  var bgmHourTimer = 0;  // setInterval id for slow mood drift

  function CFG() { return (App && App.config) || {}; }

  function soundOn() {
    try {
      var s = App.state && App.state.settings;
      // default ON: only off when explicitly false
      return !s || s.sound !== false;
    } catch (e) { return false; }
  }

  function bgmEnabled() {
    try {
      var s = App.state && App.state.settings;
      // default OFF: only on when explicitly true
      return !!(s && s.bgm === true);
    } catch (e) { return false; }
  }

  // Lazily create (or resume) the AudioContext. Returns ctx | null.
  // Must be called from a user-gesture-or-later moment for autoplay policies.
  function ensureCtx() {
    if (ctxBroken) return null;
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { ctxBroken = true; return null; }
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.0001;
        master.connect(ctx.destination);
        // ramp master up gently to a modest level (avoid harsh clicks)
        try {
          var now0 = ctx.currentTime;
          master.gain.setValueAtTime(0.0001, now0);
          master.gain.exponentialRampToValueAtTime(0.5, now0 + 0.05);
        } catch (e2) { try { master.gain.value = 0.5; } catch (e3) {} }
      }
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        // resume() returns a promise on some browsers; ignore result/errors
        try { var p = ctx.resume(); if (p && p.catch) p.catch(function () {}); } catch (e4) {}
      }
      return ctx;
    } catch (e) {
      ctxBroken = true;
      ctx = null;
      master = null;
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // SFX: small library of {type, freq, freq2?, dur, gain, slide?} recipes.
  // Each plays one (or two) short oscillator notes with a quick AD envelope.
  // ---------------------------------------------------------------------------
  var SFX = {
    // dispatch a task: rising two-note chirp
    dispatch:  { type: 'triangle', freq: 520,  freq2: 720,  dur: 0.12, gain: 0.35 },
    // task done: bright single ping
    done:      { type: 'sine',     freq: 880,               dur: 0.16, gain: 0.40 },
    // QA fail: descending buzzy minor drop
    qa_fail:   { type: 'sawtooth', freq: 360,  freq2: 240,  dur: 0.22, gain: 0.30 },
    // coffee / break: soft mid blip
    coffee:    { type: 'sine',     freq: 440,  freq2: 587,  dur: 0.18, gain: 0.30 },
    // needs-approval: gentle attention double-tone (uses second note as chord)
    approval:  { type: 'triangle', freq: 659,  freq2: 988,  dur: 0.20, gain: 0.34, chord: true },
    // level up: cheerful upward arpeggio (special-cased below)
    levelup:   { type: 'square',   freq: 523,               dur: 0.46, gain: 0.34, arp: [523, 659, 784, 1047] },
    // error: low harsh blip
    error:     { type: 'sawtooth', freq: 196,  freq2: 130,  dur: 0.26, gain: 0.30 },
    // tool call: tiny short tick
    tool:      { type: 'square',   freq: 1320,              dur: 0.05, gain: 0.18 }
  };

  // Play a single oscillator note with AD envelope into master.
  function playNote(type, freq, startAt, dur, peak, slideTo) {
    try {
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(Math.max(20, freq || 440), startAt);
      if (slideTo && slideTo > 0) {
        try { osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), startAt + dur); } catch (e) {}
      }
      var pk = Math.max(0.0001, peak || 0.3);
      g.gain.setValueAtTime(0.0001, startAt);
      g.gain.exponentialRampToValueAtTime(pk, startAt + Math.min(0.02, dur * 0.3));
      g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
      osc.connect(g);
      g.connect(master);
      osc.start(startAt);
      osc.stop(startAt + dur + 0.02);
      // free nodes after stop
      osc.onended = function () {
        try { osc.disconnect(); } catch (e) {}
        try { g.disconnect(); } catch (e) {}
      };
    } catch (e) { /* never throw */ }
  }

  Audio.sfx = function (name) {
    try {
      if (!soundOn()) return;
      var rec = SFX[name];
      if (!rec) return;
      if (!ensureCtx()) return;
      var t0 = ctx.currentTime + 0.001;

      // level-up arpeggio: quick ascending notes
      if (rec.arp && rec.arp.length) {
        var step = rec.dur / rec.arp.length;
        for (var i = 0; i < rec.arp.length; i++) {
          playNote(rec.type, rec.arp[i], t0 + i * step, step * 1.6, rec.gain, 0);
        }
        return;
      }

      // chord: both tones together
      if (rec.chord && rec.freq2) {
        playNote(rec.type, rec.freq, t0, rec.dur, rec.gain, 0);
        playNote(rec.type, rec.freq2, t0, rec.dur, rec.gain * 0.7, 0);
        return;
      }

      // single note, optionally sliding toward freq2
      playNote(rec.type, rec.freq, t0, rec.dur, rec.gain, rec.freq2 || 0);
    } catch (e) { /* never throw */ }
  };

  // ---------------------------------------------------------------------------
  // BGM: gentle ambient pad. A couple of detuned oscillators -> a lowpass
  // filter whose cutoff is slowly modulated by an LFO. The root note + filter
  // brightness drift subtly with the hour of day for a day/night mood.
  // ---------------------------------------------------------------------------

  // Map current hour -> { root(Hz), bright(0..1) }. Calmer/darker at night.
  function hourMood() {
    var h;
    try { h = new Date().getHours(); } catch (e) { h = 12; }
    // root drifts between a low A2 (110) at night and an A2+ (130ish) by day
    var dayness = 1 - Math.abs(13 - h) / 13; // 0 at midnight-ish, ~1 mid-afternoon
    if (dayness < 0) dayness = 0;
    if (dayness > 1) dayness = 1;
    var root = 110 + dayness * 16;          // 110..126 Hz
    var bright = 0.25 + dayness * 0.45;      // duller at night, brighter by day
    return { root: root, bright: bright, dayness: dayness };
  }

  function buildBgm() {
    if (!ensureCtx()) return null;
    try {
      var mood = hourMood();
      var out = ctx.createGain();
      out.gain.value = 0.0001;
      out.connect(ctx.destination); // separate bus from sfx master

      // lowpass filter for warmth
      var filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 300 + mood.bright * 900; // 300..1200ish
      filt.Q.value = 0.7;
      filt.connect(out);

      // two slightly detuned oscillators (root + fifth) = soft pad
      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = mood.root;
      o1.detune.value = -6;

      var o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = mood.root * 1.5; // a fifth above
      o2.detune.value = +6;

      var oGain = ctx.createGain();
      oGain.gain.value = 0.5;
      o1.connect(oGain);
      o2.connect(oGain);
      oGain.connect(filt);

      // slow LFO -> filter cutoff for gentle movement
      var lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.06; // very slow
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 150 + mood.bright * 200;
      lfo.connect(lfoGain);
      lfoGain.connect(filt.frequency);

      // fade the pad in gently
      var now = ctx.currentTime;
      out.gain.setValueAtTime(0.0001, now);
      out.gain.exponentialRampToValueAtTime(0.12, now + 2.0);

      o1.start();
      o2.start();
      lfo.start();

      return { out: out, filt: filt, o1: o1, o2: o2, oGain: oGain, lfo: lfo, lfoGain: lfoGain, running: true };
    } catch (e) {
      return null;
    }
  }

  // Re-tune the running pad toward the current hour's mood (smooth ramps).
  function driftBgmMood() {
    try {
      if (!bgm || !bgm.running || !ctx) return;
      var mood = hourMood();
      var now = ctx.currentTime;
      try { bgm.o1.frequency.linearRampToValueAtTime(mood.root, now + 6); } catch (e) {}
      try { bgm.o2.frequency.linearRampToValueAtTime(mood.root * 1.5, now + 6); } catch (e) {}
      try { bgm.lfoGain.gain.linearRampToValueAtTime(150 + mood.bright * 200, now + 6); } catch (e) {}
    } catch (e) { /* never throw */ }
  }

  Audio.startBgm = function () {
    try {
      if (!bgmEnabled()) return;       // gated by settings.bgm (default off)
      if (bgm && bgm.running) return;  // already playing
      if (!ensureCtx()) return;        // no context yet (needs a gesture) -> no-op
      bgm = buildBgm();
      if (bgm) {
        // slow mood drift every ~2 minutes
        try {
          if (bgmHourTimer) clearInterval(bgmHourTimer);
          bgmHourTimer = setInterval(driftBgmMood, 120000);
        } catch (e) {}
      }
    } catch (e) { /* never throw */ }
  };

  Audio.stopBgm = function () {
    try {
      if (bgmHourTimer) { try { clearInterval(bgmHourTimer); } catch (e) {} bgmHourTimer = 0; }
      if (!bgm) return;
      var b = bgm;
      bgm = null;
      if (ctx) {
        try {
          var now = ctx.currentTime;
          b.out.gain.cancelScheduledValues(now);
          b.out.gain.setValueAtTime(Math.max(0.0001, b.out.gain.value || 0.0001), now);
          b.out.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
        } catch (e) {}
      }
      // stop oscillators after the fade and disconnect
      var stopAt = (ctx ? ctx.currentTime : 0) + 1.4;
      function killOsc(o) {
        try { o.stop(stopAt); } catch (e) {}
        try { o.onended = function () { try { o.disconnect(); } catch (e2) {} }; } catch (e3) {}
      }
      killOsc(b.o1); killOsc(b.o2); killOsc(b.lfo);
      setTimeout(function () {
        try { b.oGain.disconnect(); } catch (e) {}
        try { b.lfoGain.disconnect(); } catch (e) {}
        try { b.filt.disconnect(); } catch (e) {}
        try { b.out.disconnect(); } catch (e) {}
      }, 1600);
      b.running = false;
    } catch (e) { /* never throw */ }
  };

  Audio.bgmOn = function () {
    try { return !!(bgm && bgm.running); } catch (e) { return false; }
  };

  App.Audio = Audio;
})();
