// Sizzle Station — config.js
// All tuning numbers for the game live here and nowhere else. B3's renderer
// and main loop read from Sizzle.config; they never hard-code a timer, a
// price, or a station position of their own. No DOM, no network, no assets.

(function (root) {
  'use strict';

  var Sizzle = root.Sizzle || (root.Sizzle = {});

  // ---------------------------------------------------------------- canvas
  var CANVAS = { width: 1280, height: 860 };

  // ------------------------------------------------------------- day & time
  // One working day is three minutes of real play. The clock counts down;
  // when it hits zero the day ends and the shift summary is shown.
  var DAY_LENGTH_SECONDS = 180;
  var ORDER_BOARD_MAX = 5; // never more than five tickets pinned at once

  // ------------------------------------------------------------ ingredients
  // Ten pantry items. Every recipe below is built only from this set, so
  // the counter never needs a new slot when a recipe is added later.
  var INGREDIENTS = [
    { id: 'rice',    label: 'Rice',    key: '1', colour: '#f5efe0', shelf: 0 },
    { id: 'noodle',  label: 'Noodle',  key: '2', colour: '#f2c14e', shelf: 0 },
    { id: 'egg',     label: 'Egg',     key: '3', colour: '#fff3b0', shelf: 0 },
    { id: 'chicken', label: 'Chicken', key: '4', colour: '#e8a87c', shelf: 1 },
    { id: 'tomato',  label: 'Tomato',  key: '5', colour: '#e4572e', shelf: 1 },
    { id: 'lettuce', label: 'Lettuce', key: '6', colour: '#7bc950', shelf: 1 },
    { id: 'cheese',  label: 'Cheese',  key: '7', colour: '#ffc53d', shelf: 2 },
    { id: 'bun',     label: 'Bun',     key: '8', colour: '#d9a066', shelf: 2 },
    { id: 'broth',   label: 'Broth',   key: '9', colour: '#c98f2d', shelf: 2 },
    { id: 'chili',   label: 'Chili',   key: '0', colour: '#c1272d', shelf: 2 }
  ];

  var INGREDIENT_IDS = INGREDIENTS.map(function (item) { return item.id; });

  function ingredientById(id) {
    for (var i = 0; i < INGREDIENTS.length; i++) {
      if (INGREDIENTS[i].id === id) { return INGREDIENTS[i]; }
    }
    return null;
  }

  // --------------------------------------------------------------- recipes
  // Five original dishes. cookSeconds is how long the plate must sit on a
  // burner before it is done; burnSeconds is the grace after "done" before
  // the dish is ruined. A dish that needs no stove work has cookSeconds 0
  // and is servable straight off the plate.
  var RECIPES = [
    {
      id: 'nasi-goreng-kilat', name: 'Nasi Goreng Kilat',
      ingredients: ['rice', 'egg', 'chicken', 'chili'],
      cookSeconds: 6, burnSeconds: 9,
      baseScore: 120, coins: 14, patienceSeconds: 52
    },
    {
      id: 'mie-sizzle', name: 'Mie Sizzle',
      ingredients: ['noodle', 'egg', 'chicken', 'chili'],
      cookSeconds: 5, burnSeconds: 8,
      baseScore: 110, coins: 12, patienceSeconds: 48
    },
    {
      id: 'sup-ember', name: 'Sup Ember',
      ingredients: ['broth', 'chicken', 'tomato'],
      cookSeconds: 8, burnSeconds: 10,
      baseScore: 100, coins: 11, patienceSeconds: 55
    },
    {
      id: 'salad-pelangi', name: 'Salad Pelangi',
      ingredients: ['lettuce', 'tomato', 'cheese'],
      cookSeconds: 0, burnSeconds: 0,
      baseScore: 80, coins: 9, patienceSeconds: 42
    },
    {
      id: 'burger-lava', name: 'Burger Lava',
      ingredients: ['bun', 'chicken', 'cheese', 'lettuce'],
      cookSeconds: 7, burnSeconds: 9,
      baseScore: 140, coins: 16, patienceSeconds: 58
    }
  ];

  function recipeById(id) {
    for (var i = 0; i < RECIPES.length; i++) {
      if (RECIPES[i].id === id) { return RECIPES[i]; }
    }
    return null;
  }

  // --------------------------------------------------------------- stations
  // Layout coordinates in canvas pixels. The renderer draws exactly these
  // boxes; input hit-testing uses the same numbers, so a click and a drawing
  // can never disagree about where a station is.
  //
  // FX 2026-11-25: the DOM HUD bar covers canvas y702-860, so every station
  // must end at or above y700. The previous layout (counter/plate/stove at
  // y640-820) sat under the HUD bar: the pantry's second row, the plate
  // ellipse and the stove pots were hidden. Stations now live in the
  // y400-604 band — below the menu chalkboard (ends y380) and above the
  // HUD bar. The stove moving up to y400 forced the serving hatch and the
  // trash bin up too: the hatch sits clear of the wall title (ends ~x940)
  // and the bin sits between hatch and stove.
  var STATIONS = {
    // Three counter shelves, five tubs on the bottom two rows.
    counter: { x: 40, y: 400, w: 560, h: 204 },
    counterSlots: INGREDIENTS.map(function (item, i) {
      var col = i % 5;
      var row = Math.floor(i / 5);
      return {
        ingredient: item.id,
        x: 60 + col * 108, y: 444 + row * 80, w: 92, h: 72
      };
    }),
    // The assembly plate sits centre-bottom, between counter and stove.
    plate: { x: 640, y: 400, w: 220, h: 180 },
    // Four burners in a row on the right.
    stove: { x: 900, y: 400, w: 340, h: 180 },
    burners: [0, 1, 2, 3].map(function (i) {
      return { index: i, x: 912 + i * 82, y: 428, w: 70, h: 120 };
    }),
    // Trash bin and the serving hatch, now above the stove.
    trash: { x: 1150, y: 300, w: 90, h: 90 },
    serveHatch: { x: 1000, y: 200, w: 220, h: 90 },
    // Order board along the top of the screen.
    orderBoard: { x: 40, y: 30, w: 1200, h: 150 }
  };

  // ------------------------------------------------------- patience & score
  var PATIENCE = {
    baseSeconds: 50,     // fallback when a recipe has no own patience
    warnAtSeconds: 15,   // ticket turns red / flashes below this
    hurryAtSeconds: 8,   // ticket pulses urgently below this
    expireStarLoss: 1,   // stars lost when one order walks out
    expireCoinLoss: 5    // coins lost when one order walks out
  };

  var SCORING = {
    timeBonusMax: 60,       // fastest possible serve adds this much
    wrongIngredientPenalty: 15, // score lost per wrong item on the plate
    burntDishPenalty: 20,       // score lost when a dish burns
    trashPenalty: 5,            // score lost for binning a plate
    comboStep: 0.1,             // each consecutive good serve adds +10%
    comboCap: 2.0,              // combo multiplier never passes x2.0
    comboWindowSeconds: 25,     // serve within this of the last to keep it
    starServeBonus: 25          // extra score per star earned on a serve
  };

  // Three-star bands, as a fraction of the order's patience still left
  // when the dish is handed over. Serve with >60% left: 3 stars.
  var STAR_THRESHOLDS = [
    { stars: 3, patienceLeftFraction: 0.60 },
    { stars: 2, patienceLeftFraction: 0.30 },
    { stars: 1, patienceLeftFraction: 0.0 }
  ];

  // --------------------------------------------------------- difficulty ramp
  // The day is split into three acts. Later acts spawn tickets faster,
  // shrink patience, and unlock the heavier recipes. `elapsed` is seconds
  // since the day started (0..DAY_LENGTH_SECONDS).
  var DIFFICULTY_ACTS = [
    { until: 60,  spawnEverySeconds: 14, patienceScale: 1.00,
      recipePool: ['salad-pelangi', 'mie-sizzle', 'sup-ember'] },
    { until: 120, spawnEverySeconds: 11, patienceScale: 0.88,
      recipePool: ['salad-pelangi', 'mie-sizzle', 'sup-ember',
                   'nasi-goreng-kilat'] },
    { until: 180, spawnEverySeconds: 8,  patienceScale: 0.75,
      recipePool: ['salad-pelangi', 'mie-sizzle', 'sup-ember',
                   'nasi-goreng-kilat', 'burger-lava'] }
  ];

  function difficultyFor(elapsedSeconds) {
    var t = Math.max(0, Math.min(DAY_LENGTH_SECONDS, elapsedSeconds));
    for (var i = 0; i < DIFFICULTY_ACTS.length; i++) {
      if (t < DIFFICULTY_ACTS[i].until) { return DIFFICULTY_ACTS[i]; }
    }
    return DIFFICULTY_ACTS[DIFFICULTY_ACTS.length - 1];
  }

  // ------------------------------------------------------------- hands/misc
  var HANDS = { maxCarry: 2 }; // the cook can hold at most two items at once
  var COOK = {
    shakeSeconds: 0.45,   // plate shake after a wrong ingredient
    serveAnimSeconds: 0.6
  };

  Sizzle.config = {
    canvas: CANVAS,
    dayLengthSeconds: DAY_LENGTH_SECONDS,
    orderBoardMax: ORDER_BOARD_MAX,
    ingredients: INGREDIENTS,
    ingredientIds: INGREDIENT_IDS,
    ingredientById: ingredientById,
    recipes: RECIPES,
    recipeById: recipeById,
    stations: STATIONS,
    patience: PATIENCE,
    scoring: SCORING,
    starThresholds: STAR_THRESHOLDS,
    difficultyActs: DIFFICULTY_ACTS,
    difficultyFor: difficultyFor,
    hands: HANDS,
    cook: COOK
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Sizzle;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
