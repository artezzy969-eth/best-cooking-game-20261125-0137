// Sizzle Station — posed screenshot states.
// ?shot=start|cook|serve&seed=1 builds a fixed, deterministic day state in
// exactly the shape kitchen.js produces (orders with recipeId/recipeName/
// needs/patience, plate.items, burners[].dish with cookLeft/burnLeft,
// readyTray) and hands it to Sizzle.render, so screenshots are
// reproducible: the only randomness is a seeded mulberry32 generator, never
// Date.now or Math.random inside a posed state. main.js renders the posed
// state when a shot query is present and never ticks it.
// The `serve` shot is the cover: it shows ALL of the kitchen, the order
// board, ingredients on the counter, one dish mid-assembly, a timer, and a
// plate ready to serve.
(function () {
  'use strict';
  var Sizzle = window.Sizzle = window.Sizzle || {};

  // mulberry32 — small deterministic PRNG, seeded from the URL.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Real recipes from config.js (ids, ingredients, cook/burn times).
  var SHOT_RECIPES = [
    { id: 'nasi-goreng-kilat', name: 'Nasi Goreng Kilat', ingredients: ['rice', 'egg', 'chicken', 'chili'], cookSeconds: 6, burnSeconds: 9, baseScore: 120, coins: 14, patienceSeconds: 52 },
    { id: 'mie-sizzle', name: 'Mie Sizzle', ingredients: ['noodle', 'egg', 'chicken', 'chili'], cookSeconds: 5, burnSeconds: 8, baseScore: 110, coins: 12, patienceSeconds: 48 },
    { id: 'sup-ember', name: 'Sup Ember', ingredients: ['broth', 'chicken', 'tomato'], cookSeconds: 8, burnSeconds: 10, baseScore: 100, coins: 11, patienceSeconds: 55 },
    { id: 'salad-pelangi', name: 'Salad Pelangi', ingredients: ['lettuce', 'tomato', 'cheese'], cookSeconds: 0, burnSeconds: 0, baseScore: 80, coins: 9, patienceSeconds: 42 }
  ];

  function order(recipe, patience, patienceMax, id) {
    return {
      id: id || ('shot-' + recipe.id),
      recipeId: recipe.id,
      recipeName: recipe.name,
      needs: recipe.ingredients.slice().sort(),
      patience: patience,
      patienceMax: patienceMax,
      state: 'waiting',
      stars: 0,
      servedAt: null,
      bornAt: 0
    };
  }

  function emptyBurners() {
    return [0, 1, 2, 3].map(function (i) { return { index: i, dish: null }; });
  }

  // Base day in the kitchen.js shape. animT is fixed so flames and the
  // serve glow render identically on every run of the same seed.
  function baseDay(seed) {
    return {
      seed: seed,
      rng: null,
      phase: 'playing',
      elapsed: 38,
      remaining: 142,
      dayLength: 180,
      animT: 1.25 + (seed % 5) * 0.13,
      orders: [],
      spawnIn: 5,
      score: 240,
      coins: 75,
      stars: 7,
      servedCount: 3,
      failedCount: 0,
      combo: 1.2,
      comboStreak: 2,
      comboTimer: 10,
      over: false,
      hands: [],
      plate: { items: [], wrong: 0, shakeUntil: 0, targetRecipeId: null, targetOrderId: null },
      burners: emptyBurners(),
      readyTray: null,
      shakeUntil: 0,
      lastEvent: 'shot',
      log: [],
      popups: []
    };
  }

  Sizzle.buildShotState = function (shot, seed) {
    seed = parseInt(seed, 10) || 1;
    var rng = mulberry32(seed);
    var s = baseDay(seed);
    var jitter = function (v) { return Math.round(v + (rng() - 0.5) * 4); };

    if (shot === 'start') {
      // Title overlay over the full kitchen: 2 orders, ingredients waiting.
      s.phase = 'title';
      s.elapsed = 0;
      s.remaining = 180;
      s.score = 0; s.coins = 0; s.stars = 0;
      s.combo = 1; s.comboStreak = 0; s.servedCount = 0;
      s.orders = [
        order(SHOT_RECIPES[3], jitter(40), 42, 'shot-1'),
        order(SHOT_RECIPES[1], jitter(44), 48, 'shot-2')
      ];
      s.plate.targetRecipeId = 'salad-pelangi';
      s.plate.targetOrderId = 'shot-1';
      s.hands = [];
      s.popups = [];
    } else if (shot === 'cook') {
      // One dish mid-assembly on the plate (noodle + egg of Mie Sizzle),
      // one dish cooking on burner 1 with its timer part-filled, two
      // orders waiting, the day clock running.
      s.orders = [
        order(SHOT_RECIPES[1], jitter(28), 48, 'shot-1'),
        order(SHOT_RECIPES[2], jitter(36), 55, 'shot-2')
      ];
      s.plate.items = ['noodle', 'egg'];
      s.plate.targetRecipeId = 'mie-sizzle';
      s.plate.targetOrderId = 'shot-1';
      s.burners[0].dish = {
        recipeId: 'nasi-goreng-kilat',
        items: ['rice', 'egg', 'chicken', 'chili'],
        cookLeft: 2.5, burnLeft: 9, cooked: false, burnt: false
      };
      s.hands = ['chicken'];
      s.selected = 'chicken';
      s.popups = [{ text: 'Mie Sizzle — one more!', x: 750, y: 620, color: '#5da271', size: 16, life: 1 }];
    } else {
      // `serve` (default): the cover frame. Everything visible at once:
      // kitchen + order board + ingredients on the counter + one dish
      // mid-assembly on the plate (rice + egg of Nasi Goreng Kilat) + the
      // day timer + a finished Nasi Goreng Kilat glowing in the serving
      // hatch, with a second dish cooked and waiting on burner 2.
      s.elapsed = 49;
      s.remaining = 131;
      s.orders = [
        order(SHOT_RECIPES[2], jitter(18), 55, 'shot-1'),
        order(SHOT_RECIPES[0], jitter(33), 52, 'shot-2')
      ];
      s.plate.items = ['rice', 'egg'];
      s.plate.targetRecipeId = 'nasi-goreng-kilat';
      s.plate.targetOrderId = 'shot-2';
      s.burners[1].dish = {
        recipeId: 'mie-sizzle',
        items: ['noodle', 'egg', 'chicken', 'chili'],
        cookLeft: 0, burnLeft: 6, cooked: true, burnt: false
      };
      s.readyTray = {
        recipeId: 'nasi-goreng-kilat',
        items: ['rice', 'egg', 'chicken', 'chili'],
        cooked: true, burnt: false
      };
      s.hands = [];
      s.selected = 'chili';
      s.popups = [{ text: '+100  ★★★', x: 1010, y: 395, color: '#5da271', size: 20, life: 1 }];
    }
    return s;
  };

  // Standalone render: only draws when main.js never booted (no Sizzle.main
  // loop running), so a screenshot URL still produces the frame if the
  // scripts load in an unexpected order.
  function renderStandalone() {
    if (typeof Sizzle.render !== 'function') return;
    if (Sizzle.main) return; // main.js owns the loop and the posed states
    var params = new URLSearchParams(window.location.search || '');
    var shot = params.get('shot');
    if (!shot) return;
    var canvas = document.getElementById('game') || document.getElementById('game-canvas') ||
      document.querySelector('canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var seed = parseInt(params.get('seed') || '1', 10) || 1;
    Sizzle.render(ctx, Sizzle.buildShotState(shot, seed));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderStandalone);
  } else {
    renderStandalone();
  }
})();
