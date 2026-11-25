// Sizzle Station — mouse + keyboard input.
// Hit-testing reads station rectangles from Sizzle.config (config.js) when
// present and falls back to the same 1280x860 layout render.js uses, so
// clicks keep working even if config.js has not loaded yet. Pantry slots
// come from config.stations.counterSlots, burners from
// config.stations.burners, and order tickets from
// Sizzle.orderTicketRects() in render.js — one click on a pantry slot grabs
// that ingredient, one click on a burner cooks or lifts, one click on a
// ticket aims the plate. The only public entry point is
// Sizzle.bindInput(canvas, callbacks); it returns an unbind function.
(function () {
  'use strict';
  var Sizzle = window.Sizzle = window.Sizzle || {};

  // Fallback only — the live path reads Sizzle.config.stations. Kept in
  // sync with config.js STATIONS (FX 2026-11-25: above the y702 HUD bar).
  var FALLBACK_STATIONS = {
    orderBoard: { x: 40, y: 30, w: 1200, h: 150 },
    counter: { x: 40, y: 400, w: 560, h: 204 },
    plate: { x: 640, y: 400, w: 220, h: 180 },
    stove: { x: 900, y: 400, w: 340, h: 180 },
    trash: { x: 1150, y: 300, w: 90, h: 90 },
    serveHatch: { x: 1000, y: 200, w: 220, h: 90 }
  };

  var FALLBACK_INGREDIENTS = [
    { id: 'rice', key: '1' }, { id: 'noodle', key: '2' }, { id: 'egg', key: '3' },
    { id: 'chicken', key: '4' }, { id: 'tomato', key: '5' }, { id: 'lettuce', key: '6' },
    { id: 'cheese', key: '7' }, { id: 'bun', key: '8' }, { id: 'broth', key: '9' },
    { id: 'chili', key: '0' }
  ];

  function stations() {
    var fromConfig = (Sizzle.config && Sizzle.config.stations) || {};
    var out = {};
    Object.keys(FALLBACK_STATIONS).forEach(function (key) {
      out[key] = fromConfig[key] || FALLBACK_STATIONS[key];
    });
    if (fromConfig.counterSlots) out.counterSlots = fromConfig.counterSlots;
    if (fromConfig.burners) out.burners = fromConfig.burners;
    return out;
  }

  function ingredientDefs() {
    var list = (Sizzle.config && Sizzle.config.ingredients) || null;
    return (list && list.length) ? list : FALLBACK_INGREDIENTS;
  }

  function ingredientByKey(key) {
    var list = ingredientDefs();
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) return list[i].id;
    }
    return null;
  }

  function inside(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  // Pantry slot rectangles mirror render.js: config.stations.counterSlots.
  function crateRects() {
    if (typeof Sizzle.crateRects === 'function') return Sizzle.crateRects();
    var st = stations();
    var c = st.counter;
    if (st.counterSlots) {
      return st.counterSlots.map(function (s) {
        return { id: s.ingredient, x: s.x, y: s.y, w: s.w, h: s.h };
      });
    }
    var ids = ingredientDefs().map(function (d) { return d.id; });
    var slotW = (c.w - 24) / 5;
    return ids.map(function (id, i) {
      var col = i % 5, row = Math.floor(i / 5);
      return { id: id, x: c.x + 20 + col * 108, y: c.y + 20 + row * 88, w: 92, h: 72 };
    });
  }

  function orderTicketRects() {
    if (typeof Sizzle.orderTicketRects === 'function') return Sizzle.orderTicketRects();
    var b = stations().orderBoard;
    var max = 5, gap = 10;
    var tw = (b.w - 20 - (max - 1) * gap) / max;
    var list = [];
    for (var i = 0; i < max; i++) {
      list.push({ x: b.x + 10 + i * (tw + gap), y: b.y + 38, w: tw, h: b.h - 48 });
    }
    return list;
  }

  function burnerRects() {
    if (typeof Sizzle.burnerRects === 'function') return Sizzle.burnerRects();
    var st = stations();
    if (st.burners) return st.burners;
    return [0, 1, 2, 3].map(function (i) {
      return { index: i, x: 912 + i * 82, y: 428, w: 70, h: 120 };
    });
  }

  // Convert a pointer event to canvas coordinates, honouring CSS scaling.
  function toCanvas(canvas, ev) {
    var box = canvas.getBoundingClientRect();
    var scaleX = canvas.width / Math.max(1, box.width);
    var scaleY = canvas.height / Math.max(1, box.height);
    return {
      x: (ev.clientX - box.left) * scaleX,
      y: (ev.clientY - box.top) * scaleY
    };
  }

  // Decide what a click means. Order matters: pantry slots first (they sit
  // inside the counter rectangle), then the named stations.
  function classifyClick(px, py) {
    var crates = crateRects();
    for (var i = 0; i < crates.length; i++) {
      if (inside(px, py, crates[i])) {
        return { type: 'ingredient', id: crates[i].id, index: i };
      }
    }
    var st = stations();
    if (inside(px, py, st.serveHatch)) return { type: 'serve' };
    if (inside(px, py, st.trash)) return { type: 'trash' };
    if (inside(px, py, st.plate)) return { type: 'plate' };
    var burners = burnerRects();
    for (var b = 0; b < burners.length; b++) {
      if (inside(px, py, burners[b])) {
        return { type: 'stove', index: burners[b].index != null ? burners[b].index : b };
      }
    }
    if (inside(px, py, st.stove)) return { type: 'stove', index: 0 };
    var tickets = orderTicketRects();
    for (var t = 0; t < tickets.length; t++) {
      if (inside(px, py, tickets[t])) return { type: 'order', index: t };
    }
    if (inside(px, py, st.orderBoard)) return { type: 'board' };
    if (inside(px, py, st.counter)) return { type: 'counter' };
    return { type: 'none' };
  }

  Sizzle.bindInput = function (canvas, callbacks) {
    callbacks = callbacks || {};
    var on = function (name, arg) {
      if (typeof callbacks[name] === 'function') callbacks[name](arg);
    };

    function onClick(ev) {
      var p = toCanvas(canvas, ev);
      var hit = classifyClick(p.x, p.y);
      if (hit.type === 'ingredient') {
        on('onIngredient', hit.id);
        on('onStation', 'counter');
      } else if (hit.type === 'serve') {
        on('onServe');
        on('onStation', 'serveHatch');
      } else if (hit.type === 'trash') {
        on('onTrash');
        on('onStation', 'trash');
      } else if (hit.type === 'plate') {
        on('onPlate');
        on('onStation', 'plate');
      } else if (hit.type === 'stove') {
        on('onStove', hit.index);
        on('onStation', 'stove');
      } else if (hit.type === 'order') {
        on('onOrder', hit.index);
        on('onStation', 'orderBoard');
      }
    }

    function onKey(ev) {
      var key = ev.key;
      // Pantry keys come from config: 1-9 and 0 for the ten ingredients.
      var byKey = ingredientByKey(key);
      if (byKey) { on('onIngredient', byKey); ev.preventDefault(); return; }
      if (key === ' ' || key === 'Spacebar') {
        on('onServe'); ev.preventDefault();
      } else if (key === 't' || key === 'T') {
        on('onTrash');
      } else if (key === 'p' || key === 'P' || key === 'Escape') {
        on('onPause');
      } else if (key === 'Enter') {
        on('onStart');
      } else if (key === 'm' || key === 'M') {
        on('onMute');
      }
    }

    canvas.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);

    // Detach both listeners; main.js calls this on teardown/restart.
    return function unbind() {
      canvas.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  };

  // Exposed for tests / the play-tester: pure hit classification.
  Sizzle.classifyClick = classifyClick;
})();
