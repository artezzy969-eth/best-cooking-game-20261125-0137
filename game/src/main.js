// Sizzle Station — game loop, state machine and HUD wiring.
// Phases: title -> playing -> paused -> day end (won / lost).
// The loop runs on requestAnimationFrame with a fixed 1/60s timestep and
// hands simulation to kitchen.js: Sizzle.newDay(seed) builds the day,
// Sizzle.tick(dt) advances orders + burners and returns
// { day, spawned, expired }. All player moves go through the kitchen API
// (pickIngredient / placeOnPlate / moveToStove / takeFromBurner / serve /
// trash / aimPlate) and return { ok, reason } — a refusal shows a hint
// instead of guessing. A small local fallback keeps the title screen
// drawable if kitchen.js has not loaded yet.
// Rendering is always Sizzle.render(ctx, state).
//
// HUD ids are exactly the ones B1's index.html defines:
//   canvas #game (1280x860); #hud-orders (ticket container inside
//   #hud-order-board), #hud-timer-fill + #hud-timer-text, #hud-day-fill +
//   #hud-day-text + #hud-day-num, #hud-score / #hud-coins / #hud-combo
//   (each a span holding a <b> value), #hud-toast,
//   overlays #overlay-title / #overlay-pause / #overlay-win / #overlay-lose
//   (shown via the `hidden` attribute), final stats #win-score,
//   #win-coins, #win-served, #win-combo, #lose-score, #lose-coins,
//   #lose-served, #lose-lost, buttons #btn-start, #btn-restart,
//   #btn-restart-lose, #btn-resume, #btn-quit-pause, #btn-pause.
// Every lookup is null-safe: a missing element is skipped, never an error.
(function () {
  'use strict';
  var Sizzle = window.Sizzle = window.Sizzle || {};

  var STEP = 1 / 60;

  var FALLBACK_RECIPES = [
    { id: 'nasi-goreng-kilat', name: 'Nasi Goreng Kilat', ingredients: ['rice', 'egg', 'chicken', 'chili'], cookSeconds: 6, burnSeconds: 9, baseScore: 120, coins: 14 },
    { id: 'mie-sizzle', name: 'Mie Sizzle', ingredients: ['noodle', 'egg', 'chicken', 'chili'], cookSeconds: 5, burnSeconds: 8, baseScore: 110, coins: 12 },
    { id: 'sup-ember', name: 'Sup Ember', ingredients: ['broth', 'chicken', 'tomato'], cookSeconds: 8, burnSeconds: 10, baseScore: 100, coins: 11 },
    { id: 'salad-pelangi', name: 'Salad Pelangi', ingredients: ['lettuce', 'tomato', 'cheese'], cookSeconds: 0, burnSeconds: 0, baseScore: 80, coins: 9 },
    { id: 'burger-lava', name: 'Burger Lava', ingredients: ['bun', 'chicken', 'cheese', 'lettuce'], cookSeconds: 7, burnSeconds: 9, baseScore: 140, coins: 16 }
  ];

  function $(id) { return document.getElementById(id); }
  function recipes() {
    var c = Sizzle.config || {};
    if (c.recipes && c.recipes.length) return c.recipes;
    return FALLBACK_RECIPES;
  }
  function recipeById(id) {
    var c = Sizzle.config || {};
    if (typeof c.recipeById === 'function') return c.recipeById(id);
    var list = recipes();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ---- state ----
  // The day object comes from kitchen.js (Sizzle.newDay). Before the first
  // start it is a fresh day in the title phase; the loop never ticks it
  // until the player starts, so the board stays empty behind the title card.
  function defaultState() {
    var conf = Sizzle.config || {};
    var len = conf.dayLengthSeconds || 180;
    return {
      phase: 'title', elapsed: 0, remaining: len, dayLength: len,
      animT: 0, score: 0, coins: 0, combo: 1, comboStreak: 0,
      servedCount: 0, failedCount: 0, stars: 0,
      orders: [], plate: { items: [], wrong: 0, shakeUntil: 0, targetRecipeId: null, targetOrderId: null },
      burners: [0, 1, 2, 3].map(function (i) { return { index: i, dish: null }; }),
      readyTray: null, hands: [], popups: [], over: false
    };
  }

  function newDay(seed) {
    if (typeof Sizzle.newDay === 'function') return Sizzle.newDay(seed);
    return defaultState();
  }

  function liveSeed() {
    var params = new URLSearchParams(window.location.search || '');
    var s = parseInt(params.get('seed') || '', 10);
    if (s) return s;
    return (Date.now() % 2147483646) + 1;
  }

  var state = newDay(1);
  state.phase = 'title';
  var popups = [];
  var canvas = null;
  var ctx = null;
  var unbindInput = null;
  var lastTime = 0;
  var accumulator = 0;
  var shotMode = null;

  // ---- helpers ----
  function play(name) {
    if (Sizzle.audio && typeof Sizzle.audio.play === 'function') Sizzle.audio.play(name);
  }
  function addPopup(text, x, y, color, size) {
    popups.push({ text: text, x: x, y: y, color: color || '#e4572e', size: size || 18, life: 1 });
    if (popups.length > 8) popups.shift();
  }
  function waitingOrders() {
    return (state.orders || []).filter(function (o) { return o.state === 'waiting'; });
  }
  function showToast(text, bad) {
    var box = $('hud-toast');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'pop' + (bad ? ' bad' : '');
    el.textContent = text;
    box.innerHTML = '';
    box.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1150);
  }

  // ---- player actions (also the input callbacks) ----
  // One click / key grabs an ingredient AND puts it on the plate: pick
  // into a hand, then place immediately. Hands only ever hold an item for
  // a moment unless the place is refused (e.g. the serving tray is busy),
  // in which case the carried item stays visible on the plate panel.
  function pickIngredient(id) {
    if (state.phase !== 'playing') return;
    if (Sizzle.audio) Sizzle.audio.init();
    if (typeof Sizzle.pickIngredient !== 'function') { fallbackPick(id); return; }
    var res = Sizzle.pickIngredient(id);
    if (!res.ok && res.reason === 'hands-full') {
      placeCarried();
      res = Sizzle.pickIngredient(id);
    }
    if (!res.ok) {
      addPopup('Cannot grab that right now', 300, 620, '#8a6d4b', 15);
      return;
    }
    var placed = Sizzle.placeOnPlate(id);
    if (!placed.ok) {
      if (placed.reason === 'tray-busy') {
        addPopup('Serve the ready dish first!', 1010, 400, '#e4572e', 15);
      }
      return;
    }
    state.selected = id;
    play('pop');
    if (placed.wrong) {
      addPopup('Wrong ingredient! -15', 750, 620, '#e4572e', 16);
      play('buzzer');
      return;
    }
    if (typeof Sizzle.plateStatus === 'function') {
      var status = Sizzle.plateStatus();
      if (status && status.complete) {
        addPopup(status.recipe.name + ' — click a burner!', 750, 620, '#5da271', 16);
        play('ding');
      }
    }
  }

  function placeCarried() {
    if (typeof Sizzle.placeOnPlate !== 'function' || typeof Sizzle.getState !== 'function') return;
    var hands = (Sizzle.getState().hands || []).slice();
    hands.forEach(function (h) { Sizzle.placeOnPlate(h); });
  }

  function fallbackPick(id) {
    // Kitchen.js absent: assemble directly on a plain plate array.
    if (!Array.isArray(state.plate)) state.plate = [];
    if (state.plate.indexOf(id) === -1 && state.plate.length < 4) {
      state.plate.push(id);
      state.selected = id;
      play('pop');
    }
  }

  function firstFreeBurner() {
    var burners = state.burners || [];
    for (var i = 0; i < burners.length; i++) {
      if (!burners[i].dish) return i;
    }
    return -1;
  }

  function movePlateToStove(burnerIndex) {
    if (state.phase !== 'playing') return;
    if (typeof Sizzle.moveToStove !== 'function') return;
    var idx = (typeof burnerIndex === 'number') ? burnerIndex : firstFreeBurner();
    if (idx < 0) {
      addPopup('Stove is full!', 1070, 620, '#e4572e', 15);
      return;
    }
    var res = Sizzle.moveToStove(idx);
    if (!res.ok) {
      if (res.reason === 'plate-incomplete') addPopup('Finish the recipe first!', 750, 620, '#8a6d4b', 15);
      else if (res.reason === 'burner-busy') addPopup('That burner is busy!', 1070, 620, '#e4572e', 15);
      return;
    }
    play('pop');
    if (res.ready) {
      addPopup('Ready to serve — SPACE!', 1010, 400, '#5da271', 16);
      play('ding');
    }
  }

  function clickStoveSlot(i) {
    if (state.phase !== 'playing') return;
    if (typeof Sizzle.takeFromBurner !== 'function' || typeof Sizzle.trash !== 'function') {
      movePlateToStove(i);
      return;
    }
    var burner = (state.burners || [])[i];
    if (!burner) { movePlateToStove(i); return; }
    if (!burner.dish) { movePlateToStove(i); return; }
    if (burner.dish.burnt) {
      var trashed = Sizzle.trash({ burner: i });
      if (trashed.ok) {
        addPopup('Burnt dish trashed (-5)', 1070, 620, '#8a6d4b', 15);
        play('trash');
      }
      return;
    }
    if (burner.dish.cooked) {
      var lifted = Sizzle.takeFromBurner(i);
      if (lifted.ok) {
        var recipe = recipeById(lifted.recipeId);
        addPopup((recipe ? recipe.name : 'Dish') + ' ready — SPACE to serve!', 1010, 400, '#5da271', 16);
        play('ding');
      }
      return;
    }
    addPopup('Still cooking…', 1070, 620, '#8a6d4b', 15);
  }

  function serveDish() {
    if (state.phase !== 'playing') return;
    if (typeof Sizzle.serve !== 'function') return;
    var tray = state.readyTray;
    if (!tray) {
      addPopup('Nothing ready to serve yet', 1010, 400, '#8a6d4b', 15);
      return;
    }
    // Serve to the waiting order for this exact dish, most urgent first.
    var match = null;
    waitingOrders().forEach(function (order) {
      if (order.recipeId === tray.recipeId &&
          (!match || order.patience < match.patience)) match = order;
    });
    if (!match) {
      var recipe = recipeById(tray.recipeId);
      addPopup('No order wants ' + (recipe ? recipe.name : 'this dish') + ' yet', 1010, 400, '#e4572e', 15);
      return;
    }
    var res = Sizzle.serve(match.id);
    if (!res.ok) {
      addPopup('Cannot serve: ' + (res.reason || 'no match'), 1010, 400, '#e4572e', 15);
      return;
    }
    var stars = '★'.repeat(res.stars || 1);
    addPopup('+' + res.score + '  ' + stars, 1010, 395, '#5da271', 20);
    showToast('+' + res.score + '  ' + stars + '  ·  +' + res.coins + ' coins', false);
    play('chime');
  }

  function trashPlate() {
    if (state.phase !== 'playing') return;
    if (typeof Sizzle.trash !== 'function') {
      if (Array.isArray(state.plate)) state.plate = [];
      play('trash');
      return;
    }
    var res = Sizzle.trash();
    if (res.ok) {
      addPopup('Trashed ' + res.cleared + ' (-5)', 750, 620, '#8a6d4b', 15);
      play('trash');
    } else {
      addPopup('Nothing to trash', 750, 620, '#8a6d4b', 15);
    }
  }

  function togglePause() {
    if (state.phase === 'playing') { state.phase = 'paused'; play('click'); }
    else if (state.phase === 'paused') { state.phase = 'playing'; play('click'); }
  }

  function startDay() {
    if (Sizzle.audio) { Sizzle.audio.init(); Sizzle.audio.resume(); }
    popups = [];
    state = newDay(liveSeed());
    state.phase = 'playing';
    state.animT = 0;
    play('start');
    updateHUD();
  }

  function endDay() {
    var rating = 0;
    if (typeof Sizzle.orders !== 'undefined' && Sizzle.orders.dayRating) {
      rating = Sizzle.orders.dayRating(state);
    } else if (state.servedCount > 0 && state.servedCount >= state.failedCount) {
      rating = 1;
    }
    state.phase = rating >= 1 ? 'won' : 'lost';
    if (Sizzle.audio) Sizzle.audio.setSizzle(false);
    play(state.phase === 'won' ? 'chime' : 'buzzer');
    showToast(state.phase === 'won' ? 'Day complete!' : 'Rush overwhelmed you', state.phase !== 'won');
    updateHUD();
  }

  // ---- simulation ----
  function tick(dt) {
    if (state.phase !== 'playing') {
      state.animT = (state.animT || 0) + dt; // flames keep moving on title/pause
      return;
    }
    if (typeof Sizzle.tick === 'function') {
      var res = Sizzle.tick(dt);
      state = (res && res.day) || (typeof Sizzle.getState === 'function' ? Sizzle.getState() : state);
      state.animT = (state.animT || 0) + dt;
      if (res) {
        if (res.spawned) play('ding');
        (res.expired || []).forEach(function () {
          addPopup('Order walked out! -5 coins', 190, 90, '#e4572e', 16);
          showToast('A customer walked out!', true);
          play('buzzer');
        });
      }
      // Served / failed tickets stay in day.orders (orders.js keeps them
      // for the record) — prune them from the live board so new tickets
      // can spawn up to the board max and the HUD only shows waiting ones.
      if (Array.isArray(state.orders)) {
        state.orders = state.orders.filter(function (o) { return o.state === 'waiting'; });
      }
      // Sizzle loop while any burner holds a dish.
      var cooking = (state.burners || []).some(function (b) { return b.dish && !b.dish.burnt; });
      if (Sizzle.audio) Sizzle.audio.setSizzle(cooking);
      // Score popups float up and fade.
      popups.forEach(function (p) { p.y -= dt * 28; p.life -= dt * 0.55; });
      popups = popups.filter(function (p) { return p.life > 0; });
      state.popups = popups;
      if (state.over) endDay();
    } else {
      fallbackTick(dt);
    }
  }

  // Local fallback simulation, only when kitchen.js provides no Sizzle.tick.
  // Operates on the plain defaultState shape (plate as an array, timeLeft).
  function fallbackTick(dt) {
    state.elapsed = (state.elapsed || 0) + dt;
    state.animT = (state.animT || 0) + dt;
    state.remaining = Math.max(0, (state.remaining || 0) - dt);
    popups.forEach(function (p) { p.y -= dt * 28; p.life -= dt * 0.55; });
    popups = popups.filter(function (p) { return p.life > 0; });
    state.popups = popups;
    if (state.remaining <= 0 && !state.over) {
      state.over = true;
      endDay();
    }
  }

  // ---- HUD ----
  function fmtTime(sec) {
    var s = Math.max(0, Math.ceil(sec));
    var mm = Math.floor(s / 60);
    var ss = s % 60;
    return mm + ':' + (ss < 10 ? '0' : '') + ss;
  }
  function setValue(id, value) {
    var el = $(id);
    if (!el) return;
    var b = el.querySelector('b');
    if (b) b.textContent = String(value);
    else el.textContent = String(value);
  }

  function updateHUD(st) {
    st = st || state;
    var len = st.dayLength || (Sizzle.config && Sizzle.config.dayLengthSeconds) || 180;
    var remaining = (typeof st.remaining === 'number') ? st.remaining
      : (typeof st.timeLeft === 'number' ? st.timeLeft : len);
    var elapsedSec = st.elapsed || 0;
    var timerText = $('hud-timer-text');
    if (timerText) timerText.textContent = fmtTime(remaining);
    var timerFill = $('hud-timer-fill');
    if (timerFill) {
      timerFill.style.width = (clamp(remaining / len, 0, 1) * 100) + '%';
      if (timerFill.classList) timerFill.classList.toggle('low', remaining < 30);
    }
    var dayFill = $('hud-day-fill');
    if (dayFill) dayFill.style.width = (clamp(elapsedSec / len, 0, 1) * 100) + '%';
    var dayText = $('hud-day-text');
    if (dayText) dayText.textContent = fmtTime(elapsedSec) + ' / ' + fmtTime(len);
    var dayNum = $('hud-day-num');
    if (dayNum) dayNum.textContent = '1';
    setValue('hud-score', st.score || 0);
    setValue('hud-coins', st.coins || 0);
    var combo = st.combo;
    var comboLabel = (typeof combo === 'number') ? 'x' + combo.toFixed(1)
      : ((st.comboStreak || 0) > 1 ? 'x' + (st.comboStreak || 1) : 'x1');
    setValue('hud-combo', comboLabel);

    // Order tickets (B1 markup: .order-ticket > .dish, .needs, .patience>i, .stars).
    var board = $('hud-orders');
    if (board) {
      board.innerHTML = '';
      var orders = (st.orders || []).filter(function (o) { return !o.state || o.state === 'waiting'; });
      if (!orders.length) {
        var empty = document.createElement('div');
        empty.className = 'order-empty';
        empty.textContent = 'No orders yet — the lunch rush is coming…';
        board.appendChild(empty);
      }
      orders.forEach(function (order) {
        var ticket = document.createElement('div');
        ticket.className = 'order-ticket';
        var frac = order.patienceMax ? clamp(order.patience / order.patienceMax, 0, 1) : 0;
        var name = order.recipeName || (order.recipe && order.recipe.name) || 'Dish';
        var needs = order.needs || (order.recipe && order.recipe.ingredients) || [];
        var stars = frac > 0.6 ? '★★★' : (frac > 0.3 ? '★★' : '★');
        var dish = document.createElement('div');
        dish.className = 'dish';
        dish.textContent = name;
        var needEl = document.createElement('div');
        needEl.className = 'needs';
        needEl.textContent = needs.join(' · ');
        var patience = document.createElement('div');
        patience.className = 'patience';
        var bar = document.createElement('i');
        bar.style.width = Math.round(frac * 100) + '%';
        if (order.patience < 15) bar.className = 'low';
        patience.appendChild(bar);
        var starEl = document.createElement('div');
        starEl.className = 'stars';
        starEl.textContent = stars;
        ticket.appendChild(dish);
        ticket.appendChild(needEl);
        ticket.appendChild(patience);
        ticket.appendChild(starEl);
        board.appendChild(ticket);
      });
    }

    // Overlays follow the phase (B1 hides them with the `hidden` attribute).
    var show = function (id, visible) {
      var o = $(id);
      if (!o) return;
      o.hidden = !visible;
    };
    var phase = st.phase || 'title';
    show('overlay-title', phase === 'title');
    show('overlay-pause', phase === 'paused');
    show('overlay-win', phase === 'won');
    show('overlay-lose', phase === 'lost');
    if (phase === 'won') {
      setValue('win-score', st.score || 0);
      setValue('win-coins', st.coins || 0);
      setValue('win-served', st.servedCount || 0);
      setValue('win-combo', 'x' + (st.bestCombo || st.comboStreak || 1));
    }
    if (phase === 'lost') {
      setValue('lose-score', st.score || 0);
      setValue('lose-coins', st.coins || 0);
      setValue('lose-served', st.servedCount || 0);
      setValue('lose-lost', st.failedCount || 0);
    }
  }

  function wireButtons() {
    var bind = function (id, fn) {
      var b = $(id);
      if (b) b.addEventListener('click', function (ev) { ev.preventDefault(); fn(); });
    };
    bind('btn-start', startDay);
    bind('btn-restart', startDay);
    bind('btn-restart-lose', startDay);
    bind('btn-play-again', startDay);
    bind('btn-pause', togglePause);
    bind('btn-resume', togglePause);
    bind('btn-quit-pause', startDay);
    bind('btn-serve', serveDish);
    bind('btn-trash', trashPlate);
    bind('btn-mute', function () {
      if (Sizzle.audio) {
        var m = Sizzle.audio.setMuted(!Sizzle.audio.isMuted());
        var b = $('btn-mute');
        if (b) b.textContent = m ? 'Unmute' : 'Mute';
      }
    });
  }

  // ---- boot ----
  function findCanvas() {
    return $('game') || $('game-canvas') || document.querySelector('canvas');
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!lastTime) lastTime = now;
    var dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    if (shotMode && typeof Sizzle.buildShotState === 'function') {
      // Posed screenshot mode: render the fixed state, never tick.
      var posed = Sizzle.buildShotState(shotMode, Sizzle.shotSeed || 1);
      if (ctx && typeof Sizzle.render === 'function') Sizzle.render(ctx, posed);
      updateHUD(posed);
      return;
    }
    accumulator += dt;
    var steps = 0;
    while (accumulator >= STEP && steps < 5) {
      tick(STEP);
      accumulator -= STEP;
      steps++;
    }
    if (ctx && typeof Sizzle.render === 'function') {
      state.popups = popups;
      Sizzle.render(ctx, state);
    }
    updateHUD();
  }

  function boot() {
    canvas = findCanvas();
    if (!canvas) return; // index.html not present yet; integrator boots later
    var conf = Sizzle.config || {};
    var w = (conf.canvas && conf.canvas.width) || 1280;
    var h = (conf.canvas && conf.canvas.height) || 860;
    if (!canvas.width) canvas.width = w;
    if (!canvas.height) canvas.height = h;
    ctx = canvas.getContext('2d');
    // Posed screenshot mode: ?shot=start|cook|serve&seed=1
    var params = new URLSearchParams(window.location.search || '');
    shotMode = params.get('shot');
    if (shotMode) {
      Sizzle.shotSeed = parseInt(params.get('seed') || '1', 10) || 1;
    }
    if (typeof Sizzle.bindInput === 'function') {
      unbindInput = Sizzle.bindInput(canvas, {
        onIngredient: pickIngredient,
        onServe: serveDish,
        onTrash: trashPlate,
        onPause: togglePause,
        onStart: function () {
          if (state.phase === 'title' || state.phase === 'won' || state.phase === 'lost') startDay();
        },
        onStove: clickStoveSlot,
        onPlate: function () { movePlateToStove(); },
        onOrder: function (i) {
          var order = waitingOrders()[i];
          if (!order) return;
          if (typeof Sizzle.aimPlate === 'function') {
            var res = Sizzle.aimPlate(order.id);
            var name = order.recipeName || 'that dish';
            if (res.ok) addPopup('Plate aimed at ' + name, 640, 100, '#6b4a2f', 14);
            else if (res.reason === 'plate-not-empty') addPopup('Trash the plate first to switch', 640, 100, '#8a6d4b', 14);
          } else {
            addPopup(order.recipeName + ' needs: ' + (order.needs || []).join(', '), 640, 100, '#6b4a2f', 14);
          }
        },
        onMute: function () {
          if (Sizzle.audio) Sizzle.audio.setMuted(!Sizzle.audio.isMuted());
        }
      });
    }
    canvas.addEventListener('click', function () {
      if (Sizzle.audio) { Sizzle.audio.init(); Sizzle.audio.resume(); }
    });
    wireButtons();
    updateHUD();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Public handles for the play-tester and shots.js.
  Sizzle.main = {
    get state() { return state; },
    startDay: startDay,
    serveDish: serveDish,
    trashPlate: trashPlate,
    pickIngredient: pickIngredient,
    clickStoveSlot: clickStoveSlot,
    movePlateToStove: movePlateToStove,
    togglePause: togglePause,
    updateHUD: updateHUD,
    showToast: showToast
  };
})();
