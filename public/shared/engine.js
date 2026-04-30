/* Last Card Battle — pure game engine.
   No socket / no DOM. Works in browser and Node. */
(function (global) {
  "use strict";

  function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  function createUnoDeck() {
    const colors = ["red", "green", "blue", "yellow"];
    const deck = [];
    colors.forEach((color) => {
      deck.push({ color, value: 0 });
      for (let i = 1; i <= 9; i += 1) {
        deck.push({ color, value: i });
        deck.push({ color, value: i });
      }
      for (let i = 0; i < 2; i += 1) {
        deck.push({ color, value: "skip" });
        deck.push({ color, value: "reverse" });
        deck.push({ color, value: "+2" });
      }
    });
    for (let i = 0; i < 4; i += 1) {
      deck.push({ color: "black", value: "wild" });
      deck.push({ color: "black", value: "+4" });
    }
    return shuffle(deck);
  }

  function getTopCard(room) {
    return room.discard[room.discard.length - 1];
  }

  function reshuffleDeck(room) {
    if (room.deck.length > 0 || room.discard.length <= 1) return;
    const top = room.discard.pop();
    // Reset wilds back to black so they retain their wild nature when redrawn.
    const recycled = room.discard.map((c) =>
      (c.value === "wild" || c.value === "+4") ? { ...c, color: "black" } : c
    );
    room.deck = shuffle(recycled);
    room.discard = top ? [top] : [];
  }

  function drawCards(room, player, count) {
    let drawn = 0;
    for (let i = 0; i < count; i += 1) {
      if (room.deck.length === 0) {
        return { drawnCount: drawn, needsDeckDecision: true, remainingCount: count - drawn };
      }
      const next = room.deck.pop();
      player.cards.push(next);
      drawn += 1;
    }
    return { drawnCount: drawn, needsDeckDecision: false, remainingCount: 0 };
  }

  function isPlayableCard(card, top, stackCount, rules) {
    if (!top) return true;
    if (stackCount > 0) {
      if (rules && rules.stacking === false) return false;
      if (top.value === "+4") return card.value === "+4";
      if (top.value === "+2") return card.value === "+2" || card.value === "+4";
      return false;
    }
    if (card.color === "black") return true;
    return card.color === top.color || card.value === top.value;
  }

  function isPowerCard(card) {
    return ["+2", "+4", "skip", "reverse", "wild"].includes(card.value);
  }

  function chooseBotColor(cards, difficulty) {
    const COLORS = ["red", "green", "blue", "yellow"];
    // Easy: pick a color at random — feels less tactical.
    if (difficulty === "easy") {
      return COLORS[Math.floor(Math.random() * COLORS.length)];
    }
    // Normal/Hard: pick the color we hold most of.
    const counts = { red: 0, green: 0, blue: 0, yellow: 0 };
    cards.forEach((c) => { if (counts[c.color] !== undefined) counts[c.color] += 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    // If we have no colored cards at all, pick randomly to avoid always returning red.
    if (sorted[0][1] === 0) return COLORS[Math.floor(Math.random() * COLORS.length)];
    return sorted[0][0];
  }

  // Easy bots forget to call UNO ~50% of the time; normal/hard always call.
  function shouldBotCallUno(difficulty) {
    if (difficulty === "easy") return Math.random() < 0.5;
    return true;
  }

  // Random think time per difficulty for personality.
  function botThinkMs(difficulty) {
    if (difficulty === "easy")  return 900  + Math.floor(Math.random() * 900);  //  900-1800ms (sometimes slow)
    if (difficulty === "hard")  return 700  + Math.floor(Math.random() * 500);  //  700-1200ms (decisive)
    return 1000 + Math.floor(Math.random() * 500);                              // 1000-1500ms (normal)
  }

  function pickBotCard(player, top, stackCount, room) {
    const playable = player.cards.filter((c) =>
      isPlayableCard(c, top, stackCount, room && room.rules) &&
      !(player.cards.length === 1 && isPowerCard(c))
    );
    if (playable.length === 0) return null;
    const difficulty = player.difficulty || "normal";

    if (difficulty === "easy") {
      const nonPower = playable.filter((c) => !isPowerCard(c));
      const pool = (nonPower.length > 0 && Math.random() < 0.5) ? nonPower : playable;
      return pool[Math.floor(Math.random() * pool.length)];
    }

    let oppLow = Infinity;
    if (difficulty === "hard" && room) {
      room.players.forEach((p) => {
        if (p.id !== player.id && p.cards.length < oppLow) oppLow = p.cards.length;
      });
    }
    const oppDanger = difficulty === "hard" && oppLow <= 2;

    const colorCounts = { red: 0, green: 0, blue: 0, yellow: 0 };
    player.cards.forEach((c) => {
      if (colorCounts[c.color] !== undefined) colorCounts[c.color] += 1;
    });

    return playable.sort((a, b) => {
      const score = (card) => {
        if (stackCount > 0) {
          if (top.value === "+4") return card.value === "+4" ? 4 : 0;
          if (card.value === "+4") return 4;
          if (card.value === "+2") return 3;
          return 0;
        }
        if (oppDanger) {
          if (card.value === "+4") return 100;
          if (card.value === "+2") return 90;
          if (card.value === "skip") return 80;
          if (card.value === "reverse" && room && room.players.length === 2) return 78;
        }
        let s = 0;
        if (card.color !== "black" && card.color === top.color) s = 4;
        else if (card.color !== "black" && card.value === top.value) s = 3;
        else if (card.value === "wild") s = 1;
        else if (card.value === "+4") s = 0;
        else s = 2;
        if (difficulty === "hard") {
          if (card.color !== "black") s += colorCounts[card.color] * 0.1;
          if (card.value === "wild" || card.value === "+4") s -= 1.5;
        }
        return s;
      };
      return score(b) - score(a);
    })[0];
  }

  function buildPlusFourContext(player, top) {
    const priorColor = top ? top.color : null;
    const hadMatchingColor = !!(
      priorColor && priorColor !== "black" &&
      player.cards.some((c) => c.color === priorColor)
    );
    return { priorColor, hadMatchingColor };
  }

  function advanceTurn(room, extra = 1) {
    if (!room.players.length) return;
    room.turn = (room.turn + extra * room.direction + room.players.length) % room.players.length;
    room.drawsThisTurn = 0;
  }

  /* Build "safe" room snapshot for client (mirrors server's getSafeRoom).
     `selfId` is the id whose privileged hand is allowed in `yourCards`. */
  function safeRoom(room) {
    return {
      roomCode: room.roomCode,
      hostId: room.hostId,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        cardCount: p.cards.length,
        isBot: !!p.isBot,
        disconnected: false
      })),
      started: room.started,
      turn: room.turn,
      direction: room.direction,
      discard: room.discard,
      stackCount: room.stackCount,
      handSize: room.handSize,
      rules: room.rules || null,
      soloMode: !!room.soloMode,
      canChallenge: Boolean(
        room.rules && room.rules.challengePlusFour &&
        room.stackCount >= 4 && room.discard.length > 0 &&
        room.discard[room.discard.length - 1].value === "+4" &&
        room.challengeContext && room.challengeContext.playerId
      ),
      spectatorCount: 0,
      turnEndsAt: room.turnEndsAt || null,
      awaitingDeckDecision: !!room.deckDecision,
      canShuffleDeck: room.discard.length > 1
    };
  }

  const api = {
    shuffle, createUnoDeck, getTopCard, reshuffleDeck, drawCards,
    isPlayableCard, isPowerCard, chooseBotColor, pickBotCard,
    shouldBotCallUno, botThinkMs,
    buildPlusFourContext, advanceTurn, safeRoom
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.LCB_Engine = api;
})(typeof self !== "undefined" ? self : this);
