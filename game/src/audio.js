// Sizzle Station — WebAudio synth sound effects.
// No audio files: every sound is synthesized with oscillators and filtered
// noise. init() must be called from a user gesture (click / keypress) because
// browsers block AudioContext before one. Every method is guarded so the
// game keeps running silently when AudioContext is unavailable.
(function () {
  'use strict';
  var Sizzle = window.Sizzle = window.Sizzle || {};

  var ctx = null;        // AudioContext, created lazily in init()
  var master = null;     // master gain node
  var sizzleNodes = null; // { source, gain, filter } while food is cooking
  var muted = false;
  var ready = false;

  function audioContextClass() {
    return window.AudioContext || window.webkitAudioContext || null;
  }

  function makeNoiseBuffer(seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Short oscillator blip: freq slides from `from` to `to` over `dur` seconds.
  function blip(type, from, to, dur, vol, when) {
    if (!ready || !ctx) return;
    var t0 = ctx.currentTime + (when || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  var audio = {
    init: function () {
      if (ready) return true;
      var AC = audioContextClass();
      if (!AC) return false;
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : 0.5;
        master.connect(ctx.destination);
        ready = true;
      } catch (e) {
        ctx = null; master = null; ready = false;
      }
      return ready;
    },

    resume: function () {
      if (ctx && ctx.state === 'suspended') {
        try { ctx.resume(); } catch (e) { /* stay silent */ }
      }
    },

    setMuted: function (m) {
      muted = !!m;
      if (master) master.gain.value = muted ? 0 : 0.5;
      return muted;
    },

    isMuted: function () { return muted; },
    isReady: function () { return ready; },

    // Continuous frying hiss while at least one dish is on the stove.
    // A looped noise buffer through a band-pass filter, gently wobbling.
    setSizzle: function (on) {
      if (!ready || !ctx) return;
      if (on && !sizzleNodes) {
        try {
          var source = ctx.createBufferSource();
          source.buffer = makeNoiseBuffer(2);
          source.loop = true;
          var filter = ctx.createBiquadFilter();
          filter.type = 'bandpass';
          filter.frequency.value = 5200;
          filter.Q.value = 0.6;
          var gain = ctx.createGain();
          gain.gain.value = 0.045;
          var lfo = ctx.createOscillator();
          var lfoGain = ctx.createGain();
          lfo.frequency.value = 9;
          lfoGain.gain.value = 0.018;
          lfo.connect(lfoGain);
          lfoGain.connect(gain.gain);
          source.connect(filter);
          filter.connect(gain);
          gain.connect(master);
          source.start();
          lfo.start();
          sizzleNodes = { source: source, gain: gain, lfo: lfo };
        } catch (e) { sizzleNodes = null; }
      } else if (!on && sizzleNodes) {
        try {
          sizzleNodes.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
          var nodes = sizzleNodes;
          sizzleNodes = null;
          setTimeout(function () {
            try { nodes.source.stop(); nodes.lfo.stop(); } catch (e2) { /* already stopped */ }
          }, 250);
        } catch (e) { sizzleNodes = null; }
      }
    },

    play: function (name) {
      if (!ready || !ctx || muted) return;
      try {
        if (ctx.state === 'suspended') ctx.resume();
        if (name === 'ding') {
          // Order arrives: bright two-note bell.
          blip('sine', 880, 880, 0.35, 0.25);
          blip('sine', 1318, 1318, 0.4, 0.18, 0.09);
        } else if (name === 'pop') {
          // Ingredient placed on the plate.
          blip('square', 320, 640, 0.09, 0.16);
        } else if (name === 'chime') {
          // Successful serve: rising major arpeggio.
          blip('sine', 523, 523, 0.18, 0.22);
          blip('sine', 659, 659, 0.18, 0.22, 0.09);
          blip('sine', 784, 784, 0.3, 0.24, 0.18);
        } else if (name === 'buzzer') {
          // Burnt dish / order expired: low sawtooth growl.
          blip('sawtooth', 180, 110, 0.45, 0.2);
          blip('sawtooth', 140, 90, 0.45, 0.14, 0.05);
        } else if (name === 'click') {
          blip('sine', 700, 500, 0.05, 0.12);
        } else if (name === 'trash') {
          blip('triangle', 400, 120, 0.18, 0.15);
        } else if (name === 'start') {
          blip('sine', 392, 392, 0.15, 0.2);
          blip('sine', 523, 523, 0.15, 0.2, 0.1);
          blip('sine', 659, 659, 0.25, 0.22, 0.2);
        }
      } catch (e) {
        // Never let a sound error break the game loop.
      }
    }
  };

  Sizzle.audio = audio;
})();
