// Sizzle Station — kitchen.js
// The kitchen floor: hands, assembly plate, stove burners, trash and serve.
//
// PUBLIC API (the only surface B3's main loop needs — keep it small):
//   Sizzle.newDay(seed)            -> start a fresh day, returns the day state
//   Sizzle.tick(dt)                -> advance clock, cooking and patience by dt seconds
//   Sizzle.pickIngredient(name)    -> take one item from the counter into a hand
//   Sizzle.placeOnPlate(name)      -> drop a carried item onto the assembly plate
//   Sizzle.moveToStove(burner)     -> slide the assembled plate onto a burner
//   Sizzle.serve(orderId)          -> hand a finished dish to a waiting order
//   Sizzle.trash()                 -> bin whatever is on the plate / in hand
//   Sizzle.aimPlate(orderId)       -> point the empty plate at a chosen ticket
//   Sizzle.getState()              -> read-only snapshot for the renderer
//   Sizzle.takeFromBurner(burner)  -> lift a finished dish off a burner to serve
// Every call returns { ok, reason?, ... } so input.js can show a hint
// instead of guessing why a tap did nothing. No DOM, no network, no assets:
// the renderer reads state through getState() and draws it.
//
// How "wrong ingredient" is decided: the plate works on ONE ticket at a
// time — by default the oldest waiting order, or the ticket named by
// aimPlate() while the plate is empty. An item that is not in that
// ticket's recipe (or a duplicate of one already placed) is wrong: it
// still lands on the plate, costs points, and shakes the plate. Trash the
// plate to switch to a different ticket. This keeps "wrong" unambiguous:
// without a target ticket, rice on a half-built noodle dish could just as
// well be the start of a rice dish.

(function (root) {
  'use strict';

  var Sizzle = root.Sizzle || (root.Sizzle = {});
  var CFG = null;

  function cfg() {
    if (!CFG) { CFG = Sizzle.config; }
    return CFG;
  }

  // ------------------------------------------------------------ day state
  // One object holds everything the kitchen owns. `day` is the orders-side
  // state from orders.js; the kitchen fields hang off the same object so
  // B3 only ever passes one state around.
  var current = null;

  function newDay(seed) {
    var c = cfg();
    var day = Sizzle.orders.newDayState(
      typeof seed === 'number' ? seed : 1
    );
    day.hands = [];            // ingredient ids carried, max HANDS.maxCarry
    day.plate = {
      items: [], wrong: 0, shakeUntil: 0,
      targetRecipeId: null, targetOrderId: null
    }; // assembling dish; target = ticket the plate is cooking for
    day.burners = [0, 1, 2, 3].map(function (i) {
      return { index: i, dish: null }; // dish: { recipeId, items, cooked, burnt }
    });
    day.readyTray = null;      // finished dish lifted off a burner, awaiting serve
    day.shakeUntil = 0;        // plate shake clock (seconds of day time)
    day.lastEvent = 'day-started';
    day.log = [];              // short human-readable event feed for the HUD
    current = day;
    return day;
  }

  function getState() {
    return current;
  }

  function note(day, text) {
    day.lastEvent = text;
    day.log.push({ at: day.elapsed, text: text });
    if (day.log.length > 12) { day.log.shift(); }
  }

  // ------------------------------------------------------------ ingredients
  // Pick an item off the counter. Hands hold at most two; a third grab is
  // refused with a reason instead of silently dropping something.
  function pickIngredient(name) {
    var c = cfg();
    if (!current) { return { ok: false, reason: 'no-day' }; }
    if (!c.ingredientById(name)) {
      return { ok: false, reason: 'unknown-ingredient' };
    }
    if (current.hands.length >= c.hands.maxCarry) {
      return { ok: false, reason: 'hands-full' };
    }
    current.hands.push(name);
    note(current, 'Picked up ' + name);
    return { ok: true, hands: current.hands.slice() };
  }

  // Point the empty plate at a chosen waiting ticket. Refused once any
  // item is already on the plate — trash it first to switch tickets.
  function aimPlate(orderId) {
    if (!current) { return { ok: false, reason: 'no-day' }; }
    if (current.plate.items.length) {
      return { ok: false, reason: 'plate-not-empty' };
    }
    var order = Sizzle.orders.findOrder(current, orderId);
    if (!order) { return { ok: false, reason: 'unknown-order' }; }
    if (order.state !== 'waiting') {
      return { ok: false, reason: 'order-not-waiting' };
    }
    current.plate.targetOrderId = order.id;
    current.plate.targetRecipeId = order.recipeId;
    note(current, 'Plate aimed at ' + order.recipeName);
    return { ok: true, recipeId: order.recipeId };
  }

  // Pick the ticket an empty plate should cook for: the oldest ticket
  // still waiting, so the cook is always working on the most urgent order
  // unless they aimed elsewhere first.
  function defaultTarget() {
    var waiting = Sizzle.orders.waitingOrders(current);
    if (waiting.length) {
      return { orderId: waiting[0].id, recipeId: waiting[0].recipeId };
    }
    return null;
  }

  // Drop a carried item onto the plate. Items land in any order — the dish
  // is a set, not a sequence. An item outside the target ticket's recipe,
  // or a duplicate of one already placed, is wrong: it still lands (the
  // cook sees the mistake), costs points, and shakes the plate.
  function placeOnPlate(name) {
    var c = cfg();
    if (!current) { return { ok: false, reason: 'no-day' }; }
    var handAt = current.hands.indexOf(name);
    if (handAt < 0) { return { ok: false, reason: 'not-carried' }; }
    if (current.readyTray) { return { ok: false, reason: 'tray-busy' }; }

    // First item onto an empty plate locks the target ticket in.
    if (!current.plate.items.length && !current.plate.targetRecipeId) {
      var target = defaultTarget();
      if (target) {
        current.plate.targetOrderId = target.orderId;
        current.plate.targetRecipeId = target.recipeId;
      } else {
        // No ticket waiting: fall back to the first recipe using this item.
        for (var r = 0; r < c.recipes.length; r++) {
          if (c.recipes[r].ingredients.indexOf(name) >= 0) {
            current.plate.targetRecipeId = c.recipes[r].id;
            break;
          }
        }
      }
    }

    current.hands.splice(handAt, 1);
    current.plate.items.push(name);

    var targetRecipe = current.plate.targetRecipeId
      ? c.recipeById(current.plate.targetRecipeId) : null;
    var isDuplicate = current.plate.items.indexOf(name) !==
      current.plate.items.lastIndexOf(name);
    var isWrong = isDuplicate ||
      (targetRecipe && targetRecipe.ingredients.indexOf(name) < 0);
    var result = {
      ok: true, items: current.plate.items.slice(), wrong: false,
      recipeGuess: targetRecipe ? targetRecipe.id : null
    };
    if (isWrong) {
      current.plate.wrong += 1;
      current.score = Math.max(0, current.score - c.scoring.wrongIngredientPenalty);
      current.shakeUntil = current.elapsed + c.cook.shakeSeconds;
      note(current, 'Wrong ingredient: ' + name + ' (-' +
        c.scoring.wrongIngredientPenalty + ')');
      result.wrong = true;
      result.penalty = c.scoring.wrongIngredientPenalty;
    } else {
      note(current, 'Added ' + name + ' to the plate');
    }
    return result;
  }

  // Empty the plate and release its target ticket, ready for the next dish.
  function clearPlate() {
    current.plate.items = [];
    current.plate.wrong = 0;
    current.plate.targetRecipeId = null;
    current.plate.targetOrderId = null;
  }

  // Which recipe best explains the items on the plate? The one sharing the
  // most placed ingredients; ties break towards the fewest missing items.
  // Returns null on an empty plate.
  function bestRecipeMatch(items) {
    var c = cfg();
    if (!items.length) { return null; }
    var best = null;
    for (var i = 0; i < c.recipes.length; i++) {
      var recipe = c.recipes[i];
      var shared = 0;
      for (var j = 0; j < items.length; j++) {
        if (recipe.ingredients.indexOf(items[j]) >= 0) { shared += 1; }
      }
      if (shared === 0) { continue; }
      var missing = recipe.ingredients.length - shared;
      if (!best || shared > best.shared ||
          (shared === best.shared && missing < best.missing)) {
        best = { recipe: recipe, shared: shared, missing: missing };
      }
    }
    return best;
  }

  // Is the plate a complete, correct dish? Every recipe ingredient present,
  // no extras, no wrong items. A salad (cookSeconds 0) is done at once.
  function plateStatus() {
    var c = cfg();
    if (!current) { return { complete: false, recipe: null }; }
    var items = current.plate.items.slice().sort();
    for (var i = 0; i < c.recipes.length; i++) {
      var recipe = c.recipes[i];
      var need = recipe.ingredients.slice().sort();
      if (items.length === need.length &&
          items.every(function (v, k) { return v === need[k]; })) {
        return { complete: true, recipe: recipe, needsCooking: recipe.cookSeconds > 0 };
      }
    }
    return { complete: false, recipe: bestRecipeMatch(current.plate.items) };
  }

  // -------------------------------------------------------------- the stove
  // Slide the assembled plate onto a burner. Only a complete dish may go
  // on; a half-built plate stays put with a reason. A no-cook dish (salad)
  // never needs the stove — it goes straight to the ready tray.
  function moveToStove(burnerIndex) {
    var c = cfg();
    if (!current) { return { ok: false, reason: 'no-day' }; }
    var status = plateStatus();
    if (!status.complete) {
      return { ok: false, reason: 'plate-incomplete' };
    }
    var recipe = status.recipe;
    if (recipe.cookSeconds <= 0) {
      current.readyTray = {
        recipeId: recipe.id, items: current.plate.items.slice(),
        cooked: true, burnt: false
      };
      clearPlate();
      note(current, recipe.name + ' is ready — no cooking needed');
      return { ok: true, ready: true, recipeId: recipe.id };
    }
    if (burnerIndex < 0 || burnerIndex > 3) {
      return { ok: false, reason: 'bad-burner' };
    }
    var burner = current.burners[burnerIndex];
    if (burner.dish) { return { ok: false, reason: 'burner-busy' }; }
    burner.dish = {
      recipeId: recipe.id,
      items: current.plate.items.slice(),
      cookLeft: recipe.cookSeconds,
      burnLeft: recipe.burnSeconds,
      cooked: false,
      burnt: false
    };
    clearPlate();
    note(current, recipe.name + ' on burner ' + (burnerIndex + 1));
    return { ok: true, burner: burnerIndex, recipeId: recipe.id };
  }

  // Lift a finished dish off a burner into the ready tray. A dish still
  // cooking, or one already burnt, cannot be lifted for serving.
  function takeFromBurner(burnerIndex) {
    if (!current) { return { ok: false, reason: 'no-day' }; }
    if (burnerIndex < 0 || burnerIndex > 3) {
      return { ok: false, reason: 'bad-burner' };
    }
    var burner = current.burners[burnerIndex];
    if (!burner.dish) { return { ok: false, reason: 'burner-empty' }; }
    if (current.readyTray) { return { ok: false, reason: 'tray-busy' }; }
    if (burner.dish.burnt) { return { ok: false, reason: 'dish-burnt' }; }
    if (!burner.dish.cooked) { return { ok: false, reason: 'not-cooked' }; }
    current.readyTray = burner.dish;
    burner.dish = null;
    note(current, 'Dish off the burner, ready to serve');
    return { ok: true, recipeId: current.readyTray.recipeId };
  }

  // ------------------------------------------------------------------ tick
  // One heartbeat for the whole kitchen: the order board, the burners, and
  // the plate shake. Cooking counts down first, then the burn grace; a dish
  // past its burn time is burnt and can only be trashed.
  function tick(dt) {
    var c = cfg();
    if (!current) { return null; }
    if (dt <= 0) { return current; }

    var board = Sizzle.orders.tickDayOrders(current, dt);

    for (var i = 0; i < current.burners.length; i++) {
      var dish = current.burners[i].dish;
      if (!dish || dish.burnt) { continue; }
      if (!dish.cooked) {
        dish.cookLeft -= dt;
        if (dish.cookLeft <= 0) {
          dish.cookLeft = 0;
          dish.cooked = true;
          note(current, 'Dish on burner ' + (i + 1) + ' is cooked!');
        }
      } else {
        dish.burnLeft -= dt;
        if (dish.burnLeft <= 0) {
          dish.burnLeft = 0;
          dish.burnt = true;
          current.score = Math.max(
            0, current.score - c.scoring.burntDishPenalty);
          note(current, 'Dish on burner ' + (i + 1) + ' burnt! (-' +
            c.scoring.burntDishPenalty + ')');
        }
      }
    }
    return { day: current, spawned: board.spawned, expired: board.expired };
  }

  // ------------------------------------------------------------------ serve
  // Hand the ready dish to a waiting order. Only an exact match counts:
  // the tray's recipe must equal the ticket's recipe, and the ticket must
  // still be waiting. Anything else is refused with a reason — a wrong
  // dish is never served by accident.
  function serve(orderId) {
    var c = cfg();
    if (!current) { return { ok: false, reason: 'no-day' }; }
    if (!current.readyTray) { return { ok: false, reason: 'nothing-ready' }; }
    var order = Sizzle.orders.findOrder(current, orderId);
    if (!order) { return { ok: false, reason: 'unknown-order' }; }
    if (order.state !== 'waiting') {
      return { ok: false, reason: 'order-not-waiting' };
    }
    if (order.recipeId !== current.readyTray.recipeId) {
      return { ok: false, reason: 'wrong-dish' };
    }
    var recipe = c.recipeById(order.recipeId);
    var result = Sizzle.orders.applyServe(current, order, recipe);
    note(current, 'Served ' + recipe.name + ' +' + result.score +
      ' (' + result.stars + ' stars)');
    current.readyTray = null;
    return {
      ok: true, orderId: orderId, recipeId: recipe.id,
      score: result.score, coins: result.coins, stars: result.stars,
      multiplier: result.multiplier, combo: current.combo
    };
  }

  // ------------------------------------------------------------------ trash
  // Bin the plate, the carried items, a burnt burner dish, or the ready
  // tray — whichever the cook points at. Binning costs a little score so
  // trashing is a recovery move, not a free reset. Hands are only binned
  // when the plate is empty, so a stray tap never wipes a good assembly.
  function trash(target) {
    var c = cfg();
    if (!current) { return { ok: false, reason: 'no-day' }; }
    var cleared = null;

    if (target && target.burner != null) {
      var burner = current.burners[target.burner];
      if (!burner || !burner.dish) { return { ok: false, reason: 'burner-empty' }; }
      burner.dish = null;
      cleared = 'burner ' + (target.burner + 1);
    } else if (current.plate.items.length) {
      clearPlate();
      cleared = 'plate';
    } else if (current.readyTray) {
      current.readyTray = null;
      cleared = 'ready tray';
    } else if (current.hands.length) {
      current.hands = [];
      cleared = 'hands';
    } else {
      return { ok: false, reason: 'nothing-to-trash' };
    }
    current.score = Math.max(0, current.score - c.scoring.trashPenalty);
    note(current, 'Trashed ' + cleared + ' (-' + c.scoring.trashPenalty + ')');
    return { ok: true, cleared: cleared, penalty: c.scoring.trashPenalty };
  }

  // ------------------------------------------------------- read-only helpers
  function waitingOrders() {
    if (!current) { return []; }
    return Sizzle.orders.waitingOrders(current);
  }

  Sizzle.newDay = newDay;
  Sizzle.tick = tick;
  Sizzle.pickIngredient = pickIngredient;
  Sizzle.placeOnPlate = placeOnPlate;
  Sizzle.aimPlate = aimPlate;
  Sizzle.moveToStove = moveToStove;
  Sizzle.takeFromBurner = takeFromBurner;
  Sizzle.serve = serve;
  Sizzle.trash = trash;
  Sizzle.getState = getState;
  Sizzle.plateStatus = plateStatus;
  Sizzle.waitingOrders = waitingOrders;
  Sizzle.bestRecipeMatch = bestRecipeMatch;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Sizzle;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
