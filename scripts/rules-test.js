/* Engine-level rules test. Verifies each UNO rule using the shared engine. */
const E = require("../public/shared/engine.js");

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass += 1; console.log("\u2713", label); }
  else      { fail += 1; console.log("\u2717", label); }
}

const C = (color, value) => ({ color, value });

/* 1. Color match */
assert( E.isPlayableCard(C("red", 5),    C("red", 9),  0), "color match plays");
assert(!E.isPlayableCard(C("blue", 5),   C("red", 9),  0), "wrong color blocks");

/* 2. Value match */
assert( E.isPlayableCard(C("blue", 5),   C("red", 5),  0), "value match plays");

/* 3. Wild always playable when no stack */
assert( E.isPlayableCard(C("black","wild"), C("red", 5), 0), "wild plays anytime");
assert( E.isPlayableCard(C("black","+4"),   C("red", 5), 0), "+4 plays anytime");

/* 4. +2 stacking: stacking allowed only with +2 or +4 */
assert(!E.isPlayableCard(C("red", 5),     C("red","+2"), 2, { stacking: true }), "regular card cannot clear +2 stack");
assert( E.isPlayableCard(C("blue","+2"),  C("red","+2"), 2, { stacking: true }), "+2 stacks on +2");
assert( E.isPlayableCard(C("black","+4"), C("red","+2"), 2, { stacking: true }), "+4 stacks on +2");

/* 5. +4 stacking: only +4 */
assert(!E.isPlayableCard(C("blue","+2"),  C("black","+4"), 4, { stacking: true }), "+2 cannot stack on +4");
assert( E.isPlayableCard(C("black","+4"), C("black","+4"), 4, { stacking: true }), "+4 stacks on +4");

/* 6. Stacking off (rule disabled) */
assert(!E.isPlayableCard(C("blue","+2"),  C("red","+2"), 2, { stacking: false }), "no-stacking rule blocks +2 chain");

/* 7. Power card identification */
["+2","+4","skip","reverse","wild"].forEach((v) => assert(E.isPowerCard(C("red", v)), `${v} is power`));
assert(!E.isPowerCard(C("red", 5)), "5 is not power");

/* 8. Bot color choice — easy random over many trials, normal/hard most-held */
{
  const hand = [C("red",1), C("red",2), C("blue",3)];
  const colors = new Set();
  for (let i = 0; i < 50; i += 1) colors.add(E.chooseBotColor(hand, "easy"));
  assert(colors.size > 1, "easy bot picks varied wild colors");
  assert(E.chooseBotColor(hand, "normal") === "red", "normal bot picks most-held color");
  assert(E.chooseBotColor(hand, "hard")   === "red", "hard bot picks most-held color");
}

/* 9. UNO call probability */
{
  let easyCalled = 0, hardCalled = 0;
  for (let i = 0; i < 200; i += 1) {
    if (E.shouldBotCallUno("easy")) easyCalled += 1;
    if (E.shouldBotCallUno("hard")) hardCalled += 1;
  }
  assert(easyCalled > 50 && easyCalled < 150, `easy bot forgets UNO sometimes (called ${easyCalled}/200)`);
  assert(hardCalled === 200, "hard bot always calls UNO");
}

/* 10. Bot think time ranges */
{
  for (let i = 0; i < 50; i += 1) {
    const e = E.botThinkMs("easy"), n = E.botThinkMs("normal"), h = E.botThinkMs("hard");
    if (e < 900 || e > 1800) { fail++; console.log("\u2717 easy think out of range:", e); return; }
    if (n < 1000 || n > 1500) { fail++; console.log("\u2717 normal think out of range:", n); return; }
    if (h < 700 || h > 1200) { fail++; console.log("\u2717 hard think out of range:", h); return; }
  }
  pass += 1; console.log("\u2713 think times within difficulty bands");
}

/* 11. Bot picks playable card and avoids dumping power on last card */
{
  const top = C("red", 5);
  const bot = { cards: [C("red","skip")], difficulty: "normal" };
  const room = { players: [bot, { id: "h", cards: [C("red",1)] }], rules: {} };
  // Bot has 1 card and only a power card → must draw (returns null).
  assert(E.pickBotCard(bot, top, 0, room) === null, "bot won't dump power as last card");

  bot.cards = [C("red", 5), C("red","skip")];
  const pick = E.pickBotCard(bot, top, 0, room);
  assert(pick !== null && pick.value === 5, "bot picks normal card over power when possible");
}

/* 12. Bot follows stack: must throw +2/+4 or pass */
{
  const top = C("red","+2");
  const bot = { cards: [C("red", 5), C("blue","+2")], difficulty: "normal" };
  const room = { players: [bot, { id: "h", cards: [] }], rules: { stacking: true } };
  const pick = E.pickBotCard(bot, top, 2, room);
  assert(pick && pick.value === "+2", "bot stacks +2 over a regular card");

  const bot2 = { cards: [C("red", 5)], difficulty: "normal" };
  assert(E.pickBotCard(bot2, top, 2, { players:[bot2], rules:{stacking:true} }) === null,
         "bot draws when no +2/+4 to stack");
}

/* 13. Hard bot: opponent in danger → uses +4 aggressively */
{
  const top = C("red", 5);
  const bot = { id: "b", cards: [C("red", 3), C("black","+4")], difficulty: "hard" };
  const opp = { id: "h", cards: [C("blue",1), C("blue",2)] }; // 2 cards = danger
  const room = { players: [bot, opp], rules: {} };
  const pick = E.pickBotCard(bot, top, 0, room);
  assert(pick && pick.value === "+4", "hard bot drops +4 when opponent has \u22642 cards");
}

/* 14b. Reshuffle resets wilds back to black */
{
  const room = {
    deck: [],
    discard: [
      C("red", 5),                  // first played
      { color: "red",   value: "wild" },  // wild that was set to red
      { color: "blue",  value: "+4"   },  // +4 set to blue
      C("green", 7)                 // current top
    ]
  };
  E.reshuffleDeck(room);
  // Top stays as green-7
  assert(room.discard.length === 1 && room.discard[0].value === 7, "reshuffle keeps only top card on discard");
  // The two wilds in the deck must have black color again
  const wilds = room.deck.filter((c) => c.value === "wild" || c.value === "+4");
  assert(wilds.length === 2 && wilds.every((c) => c.color === "black"),
    "reshuffle resets wild/+4 back to black");
  // The non-wild red 5 keeps its red color
  const red5 = room.deck.find((c) => c.value === 5);
  assert(red5 && red5.color === "red", "reshuffle preserves regular card colors");
}

/* 14. Deck creation: 108 cards */
{
  const deck = E.createUnoDeck();
  assert(deck.length === 108, `standard deck has 108 cards (got ${deck.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
