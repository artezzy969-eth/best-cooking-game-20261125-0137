// Sizzle Station — orders.js
// The order board: spawning tickets, draining patience, expiring walk-outs,
// and turning a finished dish into score, coins, stars and combo.
// Pure logic only — no DOM, no canvas, no network. Time moves only when
// tick() is called, which is what makes the day deterministic for a seed.

(function (root) {
  'use strict';

  var Sizzle = root.Sizzle || (root.Sizzle = {});
  var CFG = null; // bound lazily so file load order never matters

  function cfg() {
    if (!CFG) { CFG = Sizzle.config; }
    return CFG;
  }

  // ---------------------------------------------------------- small helpers
  function clamp(value, low, high) {
    return value < low ? low : (value > high ? high : value);
  }

  // Tiny deterministic RNG (mulberry32) so a seeded day replays the same
  // ticket order. The seed lives on the day object, never in a global.
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pickFrom(list, rng) {
    return list[Math.floor(rng() * list.length)];
  }

  // ------------------------------------------------------------ ticket shape
  // { id, recipeId, recipeName, needs: [ingredient ids, sorted],
  //   patience, patienceMax, state, stars, servedAt, bornAt }
  // state: 'waiting' | 'assembling' | 'cooking' | 'ready' | 'served' | 'failed'
  // Only 'waiting' tickets can be served; the other mid-kitchen states live
  // on the plate / burners in kitchen.js, not on the ticket itself.

  var nextOrderId = 1;

  function newOrder(recipeId, elapsedSeconds, rng) {
    var c = cfg();
    var recipe = c.recipeById(recipeId);
    if (!recipe) { return null; }
    var act = c.difficultyFor(elapsedSeconds);
    var patienceMax = Math.round(recipe.patienceSeconds * act.patienceScale);
    return {
      id: nextOrderId++,
      recipeId: recipe.id,
      recipeName: recipe.name,
      needs: recipe.ingredients.slice().sort(),
      patience: patienceMax,
      patienceMax: patienceMax,
      state: 'waiting',
      stars: 0,
      servedAt: null,
      bornAt: elapsedSeconds
    };
  }

  // Spawn the next ticket for this moment of the day: the act's recipe pool
  // decides which dishes customers are asking for right now.
  function spawnOrder(day) {
    var c = cfg();
    if (day.orders.length >= c.orderBoardMax) { return null; }
    var act = c.difficultyFor(day.elapsed);
    var recipeId = pickFrom(act.recipePool, day.rng);
    var order = newOrder(recipeId, day.elapsed, day.rng);
    if (order) { day.orders.push(order); }
    return order;
  }

  // -------------------------------------------------------------- patience
  // Drain every waiting ticket by dt seconds. A ticket that hits zero has
  // walked out: mark it failed, charge the walk-out penalty, break the
  // combo, and return it so the caller can flash it on the board.
  function tickOrders(day, dt) {
    var c = cfg();
    var expired = [];
    for (var i = 0; i < day.orders.length; i++) {
      var order = day.orders[i];
      if (order.state !== 'waiting') { continue; }
      order.patience -= dt;
      if (order.patience <= 0) {
        order.patience = 0;
        order.state = 'failed';
        day.stars = Math.max(0, day.stars - c.patience.expireStarLoss);
        day.coins = Math.max(0, day.coins - c.patience.expireCoinLoss);
        day.combo = 0;
        day.comboStreak = 0;
        expired.push(order);
      }
    }
    return expired;
  }

  function waitingOrders(day) {
    return day.orders.filter(function (o) { return o.state === 'waiting'; });
  }

  function findOrder(day, orderId) {
    for (var i = 0; i < day.orders.length; i++) {
      if (day.orders[i].id === orderId) { return day.orders[i]; }
    }
    return null;
  }

  // --------------------------------------------------------- stars & score
  // Stars come from how much patience was left at the handover: a fast
  // serve earns three, a last-second one earns one. Never zero — a serve
  // that lands at all is worth at least one star.
  function starRating(order) {
    var c = cfg();
    var left = order.patienceMax > 0 ? order.patience / order.patienceMax : 0;
    for (var i = 0; i < c.starThresholds.length; i++) {
      if (left >= c.starThresholds[i].patienceLeftFraction) {
        return c.starThresholds[i].stars;
      }
    }
    return 1;
  }

  // Score for handing a finished dish over. Base dish value, plus a bonus
  // that shrinks as patience runs down, plus a per-star kicker, all scaled
  // by the current combo multiplier. Coins are flat per recipe.
  function scoreServe(day, order, recipe) {
    var c = cfg();
    var left = order.patienceMax > 0 ? order.patience / order.patienceMax : 0;
    var timeBonus = Math.round(c.scoring.timeBonusMax * left);
    var stars = starRating(order);
    var raw = recipe.baseScore + timeBonus + stars * c.scoring.starServeBonus;
    var multiplier = comboMultiplier(day);
    var gained = Math.round(raw * multiplier);
    return {
      stars: stars,
      base: recipe.baseScore,
      timeBonus: timeBonus,
      multiplier: multiplier,
      score: gained,
      coins: recipe.coins
    };
  }

  function comboMultiplier(day) {
    var c = cfg();
    var step = c.scoring.comboStep * Math.max(0, day.comboStreak);
    return Math.min(c.scoring.comboCap, 1 + step);
  }

  // Record a successful serve on the day: bump score/coins/stars, grow the
  // streak, and refresh the combo window. Returns the score breakdown.
  function applyServe(day, order, recipe) {
    var result = scoreServe(day, order, recipe);
    order.state = 'served';
    order.stars = result.stars;
    order.servedAt = day.elapsed;
    day.score += result.score;
    day.coins += result.coins;
    day.stars += result.stars;
    day.servedCount += 1;
    day.comboStreak += 1;
    day.combo = comboMultiplier(day);
    day.comboTimer = cfg().scoring.comboWindowSeconds;
    return result;
  }

  // ------------------------------------------------------------ day object
  // A day is the whole mutable game state the orders module owns: the
  // clock, the ticket list, the spawn timer, and the running totals.
  function newDayState(seed) {
    var c = cfg();
    return {
      seed: seed,
      rng: makeRng(seed),
      elapsed: 0,
      remaining: c.dayLengthSeconds,
      orders: [],
      spawnIn: 2.5, // first customer walks in quickly so the board is alive
      score: 0,
      coins: 0,
      stars: 0,
      servedCount: 0,
      failedCount: 0,
      combo: 1,
      comboStreak: 0,
      comboTimer: 0,
      over: false
    };
  }

  // Advance the order side of the day by dt: spawn on schedule, drain
  // patience, cool the combo window down. Returns { spawned, expired }.
  function tickDayOrders(day, dt) {
    var c = cfg();
    var spawned = null;
    var expired = [];
    if (day.over) { return { spawned: null, expired: expired }; }

    day.elapsed += dt;
    day.remaining = Math.max(0, c.dayLengthSeconds - day.elapsed);
    if (day.remaining <= 0) { day.over = true; }

    day.spawnIn -= dt;
    if (day.spawnIn <= 0 && day.remaining > 15) {
      // No new tickets in the final 15 seconds: a fresh ticket needs at
      // least ~40s of patience, so spawning one now would only guarantee
      // a walk-out and a star loss the player can do nothing about.
      spawned = spawnOrder(day);
      var act = c.difficultyFor(day.elapsed);
      // A little jitter keeps tickets from arriving on a metronome.
      day.spawnIn = act.spawnEverySeconds * (0.85 + day.rng() * 0.3);
    } else if (day.spawnIn <= 0) {
      day.spawnIn = 999; // closing time — no more customers
    }

    expired = tickOrders(day, dt);
    day.failedCount += expired.length;

    if (day.comboTimer > 0) {
      day.comboTimer -= dt;
      if (day.comboTimer <= 0) {
        day.comboStreak = 0;
        day.combo = 1;
      }
    }
    return { spawned: spawned, expired: expired };
  }

  // Three-star rating for the whole day, from served vs failed tickets.
  // Used by the end-of-day summary screen.
  function dayRating(day) {
    var total = day.servedCount + day.failedCount;
    if (total === 0) { return 0; }
    var ratio = day.servedCount / total;
    if (ratio >= 0.9 && day.failedCount === 0) { return 3; }
    if (ratio >= 0.7) { return 2; }
    if (ratio >= 0.4) { return 1; }
    return 0;
  }

  Sizzle.orders = {
    makeRng: makeRng,
    newOrder: newOrder,
    spawnOrder: spawnOrder,
    tickOrders: tickOrders,
    tickDayOrders: tickDayOrders,
    waitingOrders: waitingOrders,
    findOrder: findOrder,
    starRating: starRating,
    scoreServe: scoreServe,
    applyServe: applyServe,
    comboMultiplier: comboMultiplier,
    newDayState: newDayState,
    dayRating: dayRating,
    clamp: clamp
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Sizzle;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
