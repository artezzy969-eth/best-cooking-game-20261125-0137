// Sizzle Station — canvas renderer.
// Every visual is drawn with 2D canvas paths, shapes and text. No images,
// no external assets. The single public entry point is Sizzle.render(ctx, state).
//
// Layout and content come from Sizzle.config (config.js: 1280x860 canvas,
// stations, 10 ingredients, 5 recipes). The renderer reads the live day
// state exactly as kitchen.js shapes it: orders with recipeId/recipeName/
// needs/patience, plate.items, burners[].dish, readyTray. Small fallbacks
// keep the kitchen drawable if a field is missing, but config is the
// authority — hit-testing in input.js uses the same rectangles.
(function () {
  'use strict';
  var Sizzle = window.Sizzle = window.Sizzle || {};

  // ---- fallback layout: the real config values, used only if config.js
  // has not loaded yet. Must match config.js STATIONS (FX 2026-11-25:
  // stations moved above the y702 HUD bar; the old y640 layout is gone).
  var FALLBACK = {
    width: 1280, height: 860,
    orderBoard: { x: 40, y: 30, w: 1200, h: 150 },
    counter: { x: 40, y: 400, w: 560, h: 204 },
    plate: { x: 640, y: 400, w: 220, h: 180 },
    stove: { x: 900, y: 400, w: 340, h: 180 },
    trash: { x: 1150, y: 300, w: 90, h: 90 },
    serveHatch: { x: 1000, y: 200, w: 220, h: 90 },
    counterSlots: null, // built from FALLBACK_INGREDIENTS below
    burners: [0, 1, 2, 3].map(function (i) {
      return { index: i, x: 912 + i * 82, y: 428, w: 70, h: 120 };
    })
  };

  var FALLBACK_INGREDIENTS = [
    { id: 'rice',    label: 'Rice',    key: '1', colour: '#f5efe0' },
    { id: 'noodle',  label: 'Noodle',  key: '2', colour: '#f2c14e' },
    { id: 'egg',     label: 'Egg',     key: '3', colour: '#fff3b0' },
    { id: 'chicken', label: 'Chicken', key: '4', colour: '#e8a87c' },
    { id: 'tomato',  label: 'Tomato',  key: '5', colour: '#e4572e' },
    { id: 'lettuce', label: 'Lettuce', key: '6', colour: '#7bc950' },
    { id: 'cheese',  label: 'Cheese',  key: '7', colour: '#ffc53d' },
    { id: 'bun',     label: 'Bun',     key: '8', colour: '#d9a066' },
    { id: 'broth',   label: 'Broth',   key: '9', colour: '#c98f2d' },
    { id: 'chili',   label: 'Chili',   key: '0', colour: '#c1272d' }
  ];

  var FALLBACK_RECIPES = [
    { id: 'nasi-goreng-kilat', name: 'Nasi Goreng Kilat', ingredients: ['rice', 'egg', 'chicken', 'chili'], cookSeconds: 6, burnSeconds: 9, baseScore: 120, coins: 14 },
    { id: 'mie-sizzle', name: 'Mie Sizzle', ingredients: ['noodle', 'egg', 'chicken', 'chili'], cookSeconds: 5, burnSeconds: 8, baseScore: 110, coins: 12 },
    { id: 'sup-ember', name: 'Sup Ember', ingredients: ['broth', 'chicken', 'tomato'], cookSeconds: 8, burnSeconds: 10, baseScore: 100, coins: 11 },
    { id: 'salad-pelangi', name: 'Salad Pelangi', ingredients: ['lettuce', 'tomato', 'cheese'], cookSeconds: 0, burnSeconds: 0, baseScore: 80, coins: 9 },
    { id: 'burger-lava', name: 'Burger Lava', ingredients: ['bun', 'chicken', 'cheese', 'lettuce'], cookSeconds: 7, burnSeconds: 9, baseScore: 140, coins: 16 }
  ];

  function cfg() { return Sizzle.config || {}; }
  function stations() { return cfg().stations || {}; }

  // Station lookup with aliases for the brief's older names.
  function rect(name) {
    var st = stations();
    var alias = { board: 'orderBoard', serve: 'serveHatch' };
    var key = alias[name] || name;
    if (st[key]) return st[key];
    return FALLBACK[key];
  }
  function ingredients() {
    var list = cfg().ingredients;
    return (list && list.length) ? list : FALLBACK_INGREDIENTS;
  }
  function canvasSize() {
    var c = cfg().canvas || {};
    return { w: c.width || FALLBACK.width, h: c.height || FALLBACK.height };
  }
  function recipeById(id) {
    if (!id) return null;
    var c = cfg();
    if (typeof c.recipeById === 'function') return c.recipeById(id);
    for (var i = 0; i < FALLBACK_RECIPES.length; i++) {
      if (FALLBACK_RECIPES[i].id === id) return FALLBACK_RECIPES[i];
    }
    return null;
  }
  function ingredientDef(id) {
    var c = cfg();
    if (typeof c.ingredientById === 'function') return c.ingredientById(id);
    var list = FALLBACK_INGREDIENTS;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // ---- state normalisation (kitchen.js day shape, with light fallbacks) ----
  function plateItems(state) {
    if (!state) return [];
    if (Array.isArray(state.plate)) return state.plate;
    if (state.plate && Array.isArray(state.plate.items)) return state.plate.items;
    return [];
  }
  function plateTargetRecipe(state) {
    if (state.plate && state.plate.targetRecipeId) return recipeById(state.plate.targetRecipeId);
    if (state.plateRecipe) return state.plateRecipe;
    return null;
  }
  function plateShake(state) {
    if (state.plate && typeof state.plate.shakeUntil === 'number') {
      return state.plate.shakeUntil > (state.elapsed || 0);
    }
    return false;
  }
  function burnerSlots(state) {
    if (Array.isArray(state.burners)) return state.burners;
    if (Array.isArray(state.stove)) {
      return state.stove.map(function (s, i) { return { index: i, dish: s || null }; });
    }
    return [];
  }
  // Normalise one burner slot to {recipe, recipeId, items, cooked, burnt,
  // progress 0..1, burnFrac 0..1|null}.
  function normBurner(slot) {
    if (!slot) return null;
    var dish = (slot.dish !== undefined) ? slot.dish : slot;
    if (!dish) return null;
    var recipe = dish.recipeId ? recipeById(dish.recipeId) : (dish.recipe || null);
    var cookSeconds = recipe ? (recipe.cookSeconds || 1) : (dish.cookMax || 8);
    var burnSeconds = recipe ? (recipe.burnSeconds || 1) : 6;
    var progress = 0;
    if (dish.burnt || dish.cooked || dish.done) progress = 1;
    else if (typeof dish.cookLeft === 'number') progress = 1 - dish.cookLeft / cookSeconds;
    else if (typeof dish.cook === 'number') progress = dish.cook / (dish.cookMax || cookSeconds);
    var burnFrac = null;
    if ((dish.cooked || dish.done) && !dish.burnt && typeof dish.burnLeft === 'number') {
      burnFrac = dish.burnLeft / burnSeconds;
    }
    return {
      recipe: recipe,
      recipeId: dish.recipeId || (recipe && recipe.id) || null,
      items: dish.items || [],
      cooked: !!(dish.cooked || dish.done),
      burnt: !!dish.burnt,
      progress: progress < 0 ? 0 : (progress > 1 ? 1 : progress),
      burnFrac: burnFrac
    };
  }
  function readyTray(state) {
    var t = (state && (state.readyTray || state.readyDish || state.serving)) || null;
    if (!t) return null;
    var recipe = t.recipeId ? recipeById(t.recipeId) : (t.recipe || null);
    return {
      recipe: recipe,
      recipeId: t.recipeId || (recipe && recipe.id) || null,
      items: t.items || (recipe ? recipe.ingredients.slice() : [])
    };
  }
  function timeLeft(state) {
    if (typeof state.remaining === 'number') return state.remaining;
    if (typeof state.timeLeft === 'number') return state.timeLeft;
    return cfg().dayLengthSeconds || 180;
  }
  function dayLength(state) {
    return state.dayLength || cfg().dayLengthSeconds || 180;
  }
  function elapsed(state) { return state.elapsed || 0; }
  function animTime(state) {
    return (typeof state.animT === 'number') ? state.animT : elapsed(state);
  }
  function waitingOrders(state) {
    return (state.orders || []).filter(function (o) { return !o.state || o.state === 'waiting'; });
  }

  // ---- small drawing helpers ----
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function text(ctx, s, x, y, size, color, align, weight) {
    ctx.fillStyle = color || '#2b2118';
    ctx.font = (weight || '700') + ' ' + size + 'px "Trebuchet MS", Verdana, sans-serif';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function fmtClock(sec) {
    var s = Math.max(0, Math.ceil(sec));
    var mm = Math.floor(s / 60);
    var ss = s % 60;
    return mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  // Deterministic flicker: flames wobble from animT (seconds). Posed
  // screenshot states set animT to a fixed number, so flames never jitter
  // between identical screenshot runs.
  function flameHeight(base, t, i) {
    return base * (0.82 + 0.18 * Math.sin(t * 7 + i * 1.7));
  }

  // ---- ingredient icons, drawn per ingredient id ----
  function drawIngredientIcon(ctx, id, cx, cy, r) {
    ctx.save();
    ctx.translate(cx, cy);
    if (id === 'rice') {
      ctx.fillStyle = '#f5efe0';
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#d9cba6';
      for (var i = 0; i < 5; i++) {
        var a = i * 1.256;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.45, r * 0.16, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (id === 'noodle') {
      ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = r * 0.22; ctx.lineCap = 'round';
      for (var k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.arc(0, k * r * 0.32, r * 0.62, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
      }
    } else if (id === 'egg') {
      ctx.fillStyle = '#fff8e6';
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f6b93b';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffe08a';
      ctx.beginPath(); ctx.arc(-r * 0.12, -r * 0.12, r * 0.18, 0, Math.PI * 2); ctx.fill();
    } else if (id === 'chicken') {
      ctx.fillStyle = '#e8a87c';
      ctx.beginPath(); ctx.ellipse(-r * 0.15, 0, r * 0.75, r * 0.55, -0.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff3e0'; ctx.lineWidth = r * 0.22; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(r * 0.45, -r * 0.35); ctx.lineTo(r * 0.95, -r * 0.75); ctx.stroke();
      ctx.fillStyle = '#fff3e0';
      ctx.beginPath(); ctx.arc(r * 0.95, -r * 0.8, r * 0.22, 0, Math.PI * 2); ctx.fill();
    } else if (id === 'tomato') {
      ctx.fillStyle = '#e4572e';
      ctx.beginPath(); ctx.arc(0, r * 0.08, r * 0.85, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#7bc950';
      ctx.beginPath();
      for (var s = 0; s < 5; s++) {
        var ang = -Math.PI / 2 + s * (Math.PI * 2 / 5);
        var px = Math.cos(ang) * r * 0.55, py = -r * 0.55 + Math.sin(ang) * r * 0.3;
        ctx.moveTo(0, -r * 0.55);
        ctx.lineTo(px, py);
      }
      ctx.fill();
    } else if (id === 'lettuce') {
      ctx.fillStyle = '#7bc950';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a5dd85';
      ctx.beginPath(); ctx.arc(-r * 0.3, -r * 0.2, r * 0.45, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.35, r * 0.25, r * 0.4, 0, Math.PI * 2); ctx.fill();
    } else if (id === 'cheese') {
      ctx.fillStyle = '#ffc53d';
      ctx.beginPath();
      ctx.moveTo(-r, r * 0.5); ctx.lineTo(r, r * 0.5); ctx.lineTo(r * 0.4, -r * 0.7); ctx.lineTo(-r, -r * 0.2);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#e8a100';
      ctx.beginPath(); ctx.arc(-r * 0.3, r * 0.1, r * 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.3, -r * 0.1, r * 0.13, 0, Math.PI * 2); ctx.fill();
    } else if (id === 'bun') {
      ctx.fillStyle = '#d9a066';
      ctx.beginPath(); ctx.arc(0, r * 0.15, r * 0.85, Math.PI, 0); ctx.fill();
      ctx.fillRect(-r * 0.85, r * 0.15, r * 1.7, r * 0.3);
      ctx.fillStyle = '#fff3d6';
      ctx.beginPath(); ctx.arc(-r * 0.35, -r * 0.3, r * 0.09, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.2, -r * 0.45, r * 0.09, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.45, -r * 0.15, r * 0.09, 0, Math.PI * 2); ctx.fill();
    } else if (id === 'broth') {
      ctx.strokeStyle = 'rgba(120,90,60,0.7)'; ctx.lineWidth = r * 0.14; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-r * 0.4, -r * 0.9); ctx.quadraticCurveTo(-r * 0.6, -r * 1.2, -r * 0.4, -r * 1.4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r * 0.3, -r * 0.9); ctx.quadraticCurveTo(r * 0.5, -r * 1.2, r * 0.3, -r * 1.4); ctx.stroke();
      ctx.fillStyle = '#c98f2d';
      ctx.beginPath(); ctx.arc(0, r * 0.15, r * 0.85, 0, Math.PI); ctx.fill();
      ctx.fillStyle = '#8b5a2b';
      ctx.fillRect(-r * 0.85, r * 0.1, r * 1.7, r * 0.22);
    } else if (id === 'chili') {
      ctx.fillStyle = '#c1272d';
      ctx.beginPath();
      ctx.moveTo(-r, -r * 0.2);
      ctx.quadraticCurveTo(0, r * 0.9, r * 0.95, -r * 0.55);
      ctx.quadraticCurveTo(r * 0.4, -r * 0.15, -r, -r * 0.2);
      ctx.fill();
      ctx.strokeStyle = '#5da271'; ctx.lineWidth = r * 0.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(r * 0.8, -r * 0.5); ctx.quadraticCurveTo(r * 1.1, -r * 0.9, r * 0.9, -r * 1.05); ctx.stroke();
    } else if (id === 'veg') {
      ctx.fillStyle = '#5da271';
      ctx.beginPath(); ctx.arc(-r * 0.3, 0, r * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#7fc08f';
      ctx.beginPath(); ctx.arc(r * 0.35, -r * 0.15, r * 0.5, 0, Math.PI * 2); ctx.fill();
    } else if (id === 'beef') {
      ctx.fillStyle = '#8b4a2b';
      rr(ctx, -r, -r * 0.6, r * 2, r * 1.2, r * 0.5); ctx.fill();
    } else {
      ctx.fillStyle = '#c9b18c';
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      text(ctx, '?', 0, 1, r, '#5b4636', 'center');
    }
    ctx.restore();
  }

  // ---- scene pieces ----
  function drawRoom(ctx, size, state) {
    // Warm tiled wall down to the floor line, chequered floor below.
    ctx.fillStyle = '#f7e3c3';
    ctx.fillRect(0, 0, size.w, 620);
    ctx.strokeStyle = 'rgba(190,140,90,0.35)';
    ctx.lineWidth = 2;
    for (var y = 0; y <= 620; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size.w, y); ctx.stroke();
    }
    for (var x = 0; x <= size.w; x += 80) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 620); ctx.stroke();
    }
    for (var fy = 620; fy < size.h; fy += 40) {
      for (var fx = 0; fx < size.w; fx += 40) {
        var dark = ((fx / 40) + (fy / 40)) % 2 === 0;
        ctx.fillStyle = dark ? '#b98a5a' : '#e8c795';
        ctx.fillRect(fx, fy, 40, 40);
      }
    }
    // Menu chalkboard on the empty wall between board and serving hatch.
    ctx.fillStyle = '#3a2a1a';
    rr(ctx, 40, 210, 340, 170, 10); ctx.fill();
    ctx.strokeStyle = '#c9a06a'; ctx.lineWidth = 3;
    rr(ctx, 40, 210, 340, 170, 10); ctx.stroke();
    text(ctx, 'MENU', 210, 232, 18, '#ffd23d', 'center');
    var menu = (cfg().recipes || FALLBACK_RECIPES).slice();
    menu.forEach(function (r, i) {
      text(ctx, r.name, 60, 262 + i * 24, 14, '#ffe9b0', 'left');
      text(ctx, (r.coins || 0) + ' coins', 360, 262 + i * 24, 13, '#ffd23d', 'right');
    });
    // Hanging pans on the wall, right of the menu and clear of the title.
    [420, 490, 560].forEach(function (px, i) {
      ctx.strokeStyle = '#6b4a2f'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(px, 210); ctx.lineTo(px, 232); ctx.stroke();
      ctx.fillStyle = i === 1 ? '#8a8f96' : '#5b4636';
      ctx.beginPath(); ctx.arc(px, 258, 26, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2b2118';
      ctx.beginPath(); ctx.arc(px, 258, 18, 0, Math.PI * 2); ctx.fill();
    });
    text(ctx, 'SIZZLE STATION', 840, 250, 26, '#8a5a2b', 'center', '900');
    text(ctx, 'fast-fire kitchen — assemble, cook, serve!', 840, 282, 15, '#a98f6d', 'center');
    void state;
  }

  // One order ticket rectangle, laid out horizontally across the board.
  function ticketRects() {
    var b = rect('orderBoard');
    var max = 5;
    var gap = 10;
    var tw = (b.w - 20 - (max - 1) * gap) / max;
    var list = [];
    for (var i = 0; i < max; i++) {
      list.push({
        x: b.x + 10 + i * (tw + gap),
        y: b.y + 38,
        w: tw,
        h: b.h - 48
      });
    }
    return list;
  }

  function drawOrderBoard(ctx, state) {
    var b = rect('orderBoard');
    ctx.fillStyle = '#6b4a2f';
    rr(ctx, b.x - 6, b.y - 6, b.w + 12, b.h + 12, 10); ctx.fill();
    ctx.fillStyle = '#fff6e3';
    rr(ctx, b.x, b.y, b.w, b.h, 8); ctx.fill();
    text(ctx, 'ORDERS', b.x + 14, b.y + 20, 16, '#6b4a2f', 'left');
    // Day clock inside the board header (the DOM HUD shows it too).
    var left = timeLeft(state);
    var total = dayLength(state);
    var frac = clamp(left / total, 0, 1);
    text(ctx, 'TIME  ' + fmtClock(left), b.x + b.w - 16, b.y + 18, 16,
      frac < 0.2 ? '#c0392b' : '#6b4a2f', 'right');
    ctx.fillStyle = '#e0cba8';
    rr(ctx, b.x + b.w - 216, b.y + 30, 200, 6, 3); ctx.fill();
    ctx.fillStyle = frac < 0.2 ? '#e4572e' : '#5da271';
    if (frac > 0) { rr(ctx, b.x + b.w - 216, b.y + 30, 200 * frac, 6, 3); ctx.fill(); }

    var orders = waitingOrders(state);
    var rects = ticketRects();
    if (!orders.length) {
      text(ctx, 'No orders yet — breathe!', b.x + 14, b.y + 90, 15, '#8a6d4b', 'left');
      return;
    }
    orders.slice(0, 5).forEach(function (order, i) {
      var t = rects[i];
      var ofrac = order.patienceMax ? clamp(order.patience / order.patienceMax, 0, 1) : 0;
      var urgent = ofrac < 0.35;
      ctx.fillStyle = urgent ? '#fde8e0' : '#fdf3dd';
      rr(ctx, t.x, t.y, t.w, t.h, 8); ctx.fill();
      ctx.strokeStyle = urgent ? '#e4572e' : '#d9a441'; ctx.lineWidth = 2;
      rr(ctx, t.x, t.y, t.w, t.h, 8); ctx.stroke();
      var name = order.recipeName || (order.recipe && order.recipe.name) || 'Dish';
      text(ctx, name, t.x + 10, t.y + 16, 14, urgent ? '#c0392b' : '#2b2118', 'left');
      // Stars the serve could still earn, from patience left.
      var stars = ofrac > 0.6 ? '★★★' : (ofrac > 0.3 ? '★★' : '★');
      text(ctx, stars, t.x + t.w - 10, t.y + 16, 12, '#e8a100', 'right');
      // Ingredient dots for the recipe.
      var needs = order.needs || (order.recipe && order.recipe.ingredients) || [];
      needs.forEach(function (ing, j) {
        drawIngredientIcon(ctx, ing, t.x + 18 + j * 26, t.y + 44, 9);
      });
      text(ctx, Math.ceil(Math.max(0, order.patience)) + 's',
        t.x + t.w - 10, t.y + 44, 12, urgent ? '#c0392b' : '#6b4a2f', 'right');
      // Patience bar.
      ctx.fillStyle = '#e0cba8';
      rr(ctx, t.x + 10, t.y + 64, t.w - 20, 8, 4); ctx.fill();
      ctx.fillStyle = urgent ? '#e4572e' : (ofrac < 0.65 ? '#f2a541' : '#5da271');
      if (ofrac > 0) { rr(ctx, t.x + 10, t.y + 64, (t.w - 20) * ofrac, 8, 4); ctx.fill(); }
      text(ctx, 'click ticket to aim the plate', t.x + 10, t.y + 88, 10, '#a98f6d', 'left');
    });
  }

  function drawCounter(ctx, state) {
    var c = rect('counter');
    ctx.fillStyle = '#8b5a2b';
    rr(ctx, c.x, c.y, c.w, c.h, 10); ctx.fill();
    ctx.fillStyle = '#a9713d';
    rr(ctx, c.x, c.y, c.w, 14, 7); ctx.fill();
    text(ctx, 'PANTRY — click or press the key', c.x + 12, c.y + 28, 12, '#ffe9c4', 'left');
    var slots = counterSlots();
    var hands = state.hands || [];
    slots.forEach(function (slot) {
      var def = ingredientDef(slot.ingredient);
      var label = def ? (def.label || def.name || slot.ingredient) : slot.ingredient;
      var key = def ? (def.key || '') : '';
      var carried = hands.indexOf(slot.ingredient) >= 0;
      var selected = state.selected === slot.ingredient;
      ctx.fillStyle = carried ? '#ffe08a' : '#fff6e3';
      rr(ctx, slot.x, slot.y, slot.w, slot.h, 8); ctx.fill();
      if (carried || selected) {
        ctx.strokeStyle = carried ? '#e4572e' : '#f6b93b'; ctx.lineWidth = 3;
        rr(ctx, slot.x, slot.y, slot.w, slot.h, 8); ctx.stroke();
      }
      drawIngredientIcon(ctx, slot.ingredient, slot.x + slot.w / 2, slot.y + 26, 15);
      text(ctx, label, slot.x + slot.w / 2, slot.y + 56, 11, '#5b4636', 'center');
      if (key !== '') {
        ctx.fillStyle = '#6b4a2f';
        rr(ctx, slot.x + 4, slot.y + 4, 16, 16, 4); ctx.fill();
        text(ctx, key, slot.x + 12, slot.y + 12, 11, '#fff', 'center');
      }
    });
  }

  function counterSlots() {
    var st = stations();
    if (st.counterSlots && st.counterSlots.length) return st.counterSlots;
    var list = ingredients();
    return list.map(function (item, i) {
      var col = i % 5;
      var row = Math.floor(i / 5);
      return {
        ingredient: item.id,
        x: 60 + col * 108, y: 444 + row * 80, w: 92, h: 72
      };
    });
  }

  function burnerRects() {
    var st = stations();
    if (st.burners && st.burners.length) return st.burners;
    return FALLBACK.burners;
  }

  function drawStove(ctx, state) {
    var s = rect('stove');
    ctx.fillStyle = '#3d3d3d';
    rr(ctx, s.x, s.y, s.w, s.h, 10); ctx.fill();
    ctx.fillStyle = '#555';
    rr(ctx, s.x, s.y, s.w, 12, 6); ctx.fill();
    text(ctx, 'STOVE — click a burner to cook / lift', s.x + 12, s.y + 28, 12, '#f5f5f5', 'left');
    var t = animTime(state);
    var slots = burnerSlots(state);
    var rects = burnerRects();
    for (var i = 0; i < 4; i++) {
      var br = rects[i];
      var bcx = br.x + br.w / 2;
      var slot = slots[i];
      var dish = slot ? normBurner(slot) : null;
      // Burner ring.
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.ellipse(bcx, br.y + 82, 32, 10, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#777'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(bcx, br.y + 82, 32, 10, 0, 0, Math.PI * 2); ctx.stroke();
      if (dish) {
        var name = (dish.recipe && dish.recipe.name) || dish.recipeId || 'Dish';
        text(ctx, name, bcx, br.y + 12, 10, '#fff', 'center');
        if (!dish.cooked && !dish.burnt) {
          ctx.fillStyle = '#ff7b2e';
          for (var f = -1; f <= 1; f++) {
            var fh = flameHeight(14, t, i * 3 + f);
            ctx.beginPath();
            ctx.moveTo(bcx + f * 10 - 6, br.y + 78);
            ctx.quadraticCurveTo(bcx + f * 10, br.y + 78 - fh, bcx + f * 10 + 6, br.y + 78);
            ctx.closePath(); ctx.fill();
          }
        }
        // Pot with the cooking dish.
        ctx.fillStyle = dish.burnt ? '#2b2b2b' : '#dfe6ea';
        ctx.beginPath(); ctx.ellipse(bcx, br.y + 58, 28, 12, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = dish.burnt ? '#1a1a1a' : '#f2c14e';
        ctx.beginPath(); ctx.ellipse(bcx, br.y + 56, 23, 8, 0, 0, Math.PI * 2); ctx.fill();
        // Progress bar: cooking progress, then burn countdown once done.
        ctx.fillStyle = '#111';
        rr(ctx, br.x, br.y + 98, br.w, 6, 3); ctx.fill();
        if (dish.burnt) {
          ctx.fillStyle = '#e4572e';
          rr(ctx, br.x, br.y + 98, br.w, 6, 3); ctx.fill();
        } else if (dish.cooked && dish.burnFrac != null) {
          ctx.fillStyle = '#e4572e';
          rr(ctx, br.x, br.y + 98, br.w * dish.burnFrac, 6, 3); ctx.fill();
        } else {
          ctx.fillStyle = dish.cooked ? '#5da271' : '#f6b93b';
          rr(ctx, br.x, br.y + 98, br.w * dish.progress, 6, 3); ctx.fill();
        }
        text(ctx, dish.burnt ? 'BURNT! click to trash' : (dish.cooked ? 'READY! click to lift' : 'cooking…'),
          bcx, br.y + 114, 10, dish.burnt ? '#ff8a70' : '#fff', 'center');
      } else {
        text(ctx, 'empty', bcx, br.y + 12, 10, '#999', 'center');
      }
    }
  }

  function drawPlateArea(ctx, state) {
    var p = rect('plate');
    var shake = plateShake(state) ? Math.sin(animTime(state) * 40) * 4 : 0;
    ctx.save();
    ctx.translate(shake, 0);
    ctx.fillStyle = 'rgba(255,246,227,0.92)';
    rr(ctx, p.x, p.y, p.w, p.h, 10); ctx.fill();
    ctx.strokeStyle = '#c9a06a'; ctx.lineWidth = 2;
    rr(ctx, p.x, p.y, p.w, p.h, 10); ctx.stroke();
    text(ctx, 'ASSEMBLY PLATE', p.x + p.w / 2, p.y + 16, 12, '#6b4a2f', 'center');
    var placed = plateItems(state);
    // Plate ellipse.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.ellipse(p.x + p.w / 2, p.y + 92, 84, 40, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#d9cba6'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(p.x + p.w / 2, p.y + 92, 84, 40, 0, 0, Math.PI * 2); ctx.stroke();
    if (!placed.length) {
      text(ctx, 'pick ingredients', p.x + p.w / 2, p.y + 88, 12, '#a98f6d', 'center');
      text(ctx, 'from the pantry', p.x + p.w / 2, p.y + 106, 12, '#a98f6d', 'center');
    } else {
      placed.forEach(function (ing, i) {
        var px = p.x + p.w / 2 + (i - (placed.length - 1) / 2) * 36;
        drawIngredientIcon(ctx, ing, px, p.y + 92, 15);
      });
    }
    var target = plateTargetRecipe(state);
    if (target) {
      var need = target.ingredients || [];
      var missing = need.filter(function (ing) { return placed.indexOf(ing) < 0; }).length;
      text(ctx, target.name + (missing ? '  (' + missing + ' to go)' : '  — complete!'),
        p.x + p.w / 2, p.y + 150, 12, '#2b2118', 'center');
    } else if (placed.length) {
      text(ctx, placed.length + ' item(s) on the plate', p.x + p.w / 2, p.y + 150, 12, '#2b2118', 'center');
    }
    // Carried items (in hand, not yet placed).
    var hands = state.hands || [];
    if (hands.length) {
      text(ctx, 'Carrying:', p.x + 12, p.y + 36, 11, '#8a5a00', 'left');
      hands.forEach(function (ing, i) {
        drawIngredientIcon(ctx, ing, p.x + 78 + i * 30, p.y + 36, 11);
      });
    }
    ctx.restore();
  }

  function drawServeWindow(ctx, state) {
    var s = rect('serveHatch');
    var tray = readyTray(state);
    var t = animTime(state);
    if (tray) {
      ctx.save();
      var glow = 0.55 + 0.35 * Math.sin(t * 4);
      ctx.shadowColor = '#f6b93b';
      ctx.shadowBlur = 22 + 10 * glow;
      ctx.fillStyle = '#fff3cf';
      rr(ctx, s.x, s.y, s.w, s.h, 10); ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = 'rgba(255,246,227,0.85)';
      rr(ctx, s.x, s.y, s.w, s.h, 10); ctx.fill();
    }
    ctx.strokeStyle = tray ? '#e8a33d' : '#c9a06a'; ctx.lineWidth = 2;
    rr(ctx, s.x, s.y, s.w, s.h, 10); ctx.stroke();
    text(ctx, tray ? 'READY TO SERVE  ★' : 'SERVING HATCH', s.x + s.w / 2, s.y + 15, 12,
      tray ? '#8a5a00' : '#6b4a2f', 'center');
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.ellipse(s.x + 62, s.y + 56, 46, 24, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#d9cba6'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(s.x + 62, s.y + 56, 46, 24, 0, 0, Math.PI * 2); ctx.stroke();
    if (tray) {
      tray.items.forEach(function (ing, i) {
        var px = s.x + 62 + (i - (tray.items.length - 1) / 2) * 20;
        drawIngredientIcon(ctx, ing, px, s.y + 56, 10);
      });
      var name = (tray.recipe && tray.recipe.name) || tray.recipeId || 'Dish';
      text(ctx, name, s.x + 128, s.y + 44, 13, '#2b2118', 'left');
      text(ctx, 'SPACE to serve', s.x + 128, s.y + 66, 12, '#8a5a00', 'left');
    } else {
      text(ctx, 'finished dishes', s.x + 128, s.y + 44, 12, '#a98f6d', 'left');
      text(ctx, 'land here', s.x + 128, s.y + 64, 12, '#a98f6d', 'left');
    }
  }

  function drawTrash(ctx) {
    var tr = rect('trash');
    ctx.fillStyle = '#7d8a96';
    rr(ctx, tr.x, tr.y, tr.w, tr.h, 8); ctx.fill();
    ctx.fillStyle = '#5b6b78';
    rr(ctx, tr.x + 10, tr.y + 12, tr.w - 20, tr.h - 20, 4); ctx.fill();
    text(ctx, 'TRASH', tr.x + tr.w / 2, tr.y + tr.h / 2 - 8, 12, '#fff', 'center');
    text(ctx, '[T]', tr.x + tr.w / 2, tr.y + tr.h / 2 + 12, 11, '#dfe6ea', 'center');
  }

  function drawPopups(ctx, state) {
    (state.popups || []).forEach(function (pop) {
      var alpha = clamp(pop.life == null ? 1 : pop.life, 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      text(ctx, pop.text, pop.x, pop.y, pop.size || 18, pop.color || '#e4572e', 'center');
      ctx.restore();
    });
  }

  function drawPhaseBanner(ctx, state, size) {
    if (state.phase === 'paused') {
      ctx.fillStyle = 'rgba(43,33,24,0.55)';
      ctx.fillRect(0, 0, size.w, size.h);
      text(ctx, 'PAUSED — press P to resume', size.w / 2, size.h / 2, 28, '#fff', 'center');
    } else if (state.phase === 'title') {
      ctx.fillStyle = 'rgba(43,33,24,0.45)';
      ctx.fillRect(0, 0, size.w, size.h);
      text(ctx, 'SIZZLE STATION', size.w / 2, size.h / 2 - 90, 44, '#fff', 'center');
      text(ctx, 'Fast-fire kitchen: assemble, cook, serve before patience runs out!',
        size.w / 2, size.h / 2 - 48, 16, '#ffe9c4', 'center');
      text(ctx, 'Click ingredients or press 1–0  •  SPACE serves  •  T trashes  •  ENTER starts',
        size.w / 2, size.h / 2 - 20, 14, '#fff', 'center');
    }
  }

  // ---- public entry point ----
  Sizzle.render = function (ctx, state) {
    state = state || {};
    var size = canvasSize();
    ctx.clearRect(0, 0, size.w, size.h);
    drawRoom(ctx, size, state);
    drawOrderBoard(ctx, state);
    drawTrash(ctx);
    drawPlateArea(ctx, state);
    drawServeWindow(ctx, state);
    drawCounter(ctx, state);
    drawStove(ctx, state);
    drawPopups(ctx, state);
    drawPhaseBanner(ctx, state, size);
  };

  // Exposed for input.js / tests: pantry slot rectangles per ingredient.
  Sizzle.crateRects = function () {
    return counterSlots().map(function (slot) {
      return { id: slot.ingredient, x: slot.x, y: slot.y, w: slot.w, h: slot.h };
    });
  };
  Sizzle.orderTicketRects = ticketRects;
  Sizzle.burnerRects = burnerRects;
  Sizzle.stationRects = function () {
    return {
      orderBoard: rect('orderBoard'),
      counter: rect('counter'),
      stove: rect('stove'),
      plate: rect('plate'),
      serveHatch: rect('serveHatch'),
      trash: rect('trash')
    };
  };
})();
