/* Last Card Battle — local (offline) bot game runner.
   Implements the same event API as the Socket.IO server so the existing
   client UI can talk to it without changes.
   Browser-only (uses setTimeout). Depends on LCB_Engine. */
(function (global) {
  "use strict";
  const E = global.LCB_Engine;

  const TURN_DURATION_MS = 15000;

  function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 5; i += 1) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function createLocalGame(emit) {
    // emit(event, payload) — dispatches an "incoming" event to the UI bus.
    let room = null;
    const SELF_ID = "local-self";

    /* ---------- helpers ---------- */
    function emitLobby() {
      emit("lobbyUpdated", E.safeRoom(room));
    }
    function emitGame() {
      const human = room.players.find((p) => p.id === SELF_ID);
      if (human) emit("yourCards", human.cards);
      emit("updateGame", E.safeRoom(room));
      queueBotIfNeeded();
    }
    function emitGameOver(winnerName) {
      room.started = false;
      stopTurnTimer();
      stopBotTurn();
      emit("gameOver", winnerName);
      emitLobby();
    }

    function stopTurnTimer() {
      if (room && room._timer) { clearTimeout(room._timer); room._timer = null; }
      if (room) room.turnEndsAt = null;
    }
    function stopBotTurn() {
      if (room && room._botTimer) { clearTimeout(room._botTimer); room._botTimer = null; }
    }

    /* Deck decision: when the deck is empty AND discard is too small to reshuffle,
       prompt the host (player) to either Shuffle or Declare a winner. Mirrors server. */
    function requestDeckDecision(decisionState) {
      if (!room || room.deckDecision) return;
      room.deckDecision = {
        playerId: decisionState.playerId || null,
        remainingDraws: decisionState.remainingDraws || 0,
        advanceSteps: decisionState.advanceSteps || 0,
        clearStackOnResume: !!decisionState.clearStackOnResume,
        showPenalty: !!decisionState.showPenalty
      };
      stopTurnTimer();
      stopBotTurn();
      emit("updateGame", E.safeRoom(room));
      emit("deckEmpty", { roomCode: room.roomCode, hostId: room.hostId, canShuffle: room.discard.length > 1 });
    }

    /* Wraps E.drawCards: if it returns needsDeckDecision, raise a request and
       return null so the caller can stop. Otherwise returns the result. */
    function drawOrPrompt(player, count, decisionState) {
      const res = E.drawCards(room, player, count);
      if (res.needsDeckDecision) {
        requestDeckDecision({ ...decisionState, playerId: player.id, remainingDraws: res.remainingCount });
        return null;
      }
      return res;
    }

    function scheduleTurn() {
      if (!room || !room.started || room.deckDecision) return;
      stopBotTurn();
      stopTurnTimer();
      room.turnEndsAt = Date.now() + TURN_DURATION_MS;
      room._timer = setTimeout(() => {
        if (!room || !room.started) return;
        const player = room.players[room.turn];
        const drawCount = room.stackCount > 0 ? room.stackCount : 1;
        const r = drawOrPrompt(player, drawCount, { advanceSteps: 1, clearStackOnResume: true });
        if (!r) return; // deck decision pending
        room.stackCount = 0;
        room.challengeContext = null;
        E.advanceTurn(room, 1);
        scheduleTurn();
        emitGame();
      }, TURN_DURATION_MS);
    }

    function advanceAndSchedule(extra = 1) {
      E.advanceTurn(room, extra);
      scheduleTurn();
      emitGame();
    }

    function applyCardPlay(player, playedCard, priorContext) {
      player.cardsPlayed = (player.cardsPlayed || 0) + 1;

      if (playedCard.color === "black") {
        // For human, color was set via chosenColor before this point.
        // For bots, pick most-held color from remaining hand.
        if (!playedCard._userColor) playedCard.color = E.chooseBotColor(player.cards, player.difficulty);
        delete playedCard._userColor;
      }

      room.discard.push(playedCard);

      if (player.cards.length === 0) {
        emitGameOver(player.name);
        return;
      }

      // UNO penalty window: if player is now at 1 card and hasn't called UNO,
      // give them 3 seconds before drawing 2 (mirrors server logic exactly).
      if (player.cards.length === 1) {
        // Bots auto-call UNO based on difficulty (easy may forget).
        player.calledUNO = player.isBot ? E.shouldBotCallUno(player.difficulty) : false;
        if (player.isBot && player.calledUNO) emit("unoCalled", { playerName: player.name });
        const snap = player;
        setTimeout(() => {
          if (!room || !room.started) return;
          if (snap.cards.length === 1 && !snap.calledUNO) {
            E.drawCards(room, snap, 2);
            emit("penalty");
            emitGame();
          }
        }, 3000);
      }

      if (playedCard.value === "+2") {
        room.stackCount += 2;
        room.challengeContext = null;
      } else if (playedCard.value === "+4") {
        room.stackCount += 4;
        room.challengeContext = priorContext
          ? { playerId: player.id,
              priorColor: priorContext.priorColor || null,
              hadMatchingColor: !!priorContext.hadMatchingColor }
          : null;
      } else {
        room.stackCount = 0;
        room.challengeContext = null;
      }

      if (playedCard.value === "reverse") room.direction *= -1;

      const skip = playedCard.value === "skip";
      advanceAndSchedule(skip ? 2 : 1);
    }

    function runBotTurn() {
      if (!room || !room.started) return;
      const bot = room.players[room.turn];
      if (!bot || !bot.isBot) return;

      const top = E.getTopCard(room);
      const card = E.pickBotCard(bot, top, room.stackCount, room);

      if (!card) {
        const drawCount = room.stackCount > 0 ? room.stackCount : 1;
        const r = drawOrPrompt(bot, drawCount, { advanceSteps: 1, clearStackOnResume: true });
        if (!r) return;
        room.stackCount = 0;
        room.challengeContext = null;
        advanceAndSchedule(1);
        return;
      }

      const idx = bot.cards.findIndex((c) => c.color === card.color && c.value === card.value);
      if (idx === -1) return;
      const played = { ...bot.cards[idx] };
      const prior = played.value === "+4" ? E.buildPlusFourContext(bot, top) : null;
      bot.cards.splice(idx, 1);
      applyCardPlay(bot, played, prior);
    }

    function queueBotIfNeeded() {
      if (!room || !room.started || room.deckDecision) return;
      const active = room.players[room.turn];
      if (!active || !active.isBot) return;
      stopBotTurn();
      room._botTimer = setTimeout(runBotTurn, E.botThinkMs(active.difficulty));
    }

    /* ---------- public event handler (mirrors socket.on) ---------- */
    function handle(event, payload) {
      switch (event) {
        case "startBotMatch": {
          const name = (typeof payload === "string" ? payload : payload && payload.name) || "Player";
          const difficulty = (payload && payload.difficulty) || "normal";
          const userRules = (payload && payload.rules) || {};
          const botName = difficulty === "easy" ? "Rookie Bot"
                        : difficulty === "hard" ? "Master Bot" : "Robot";
          const code = generateRoomCode();
          room = {
            roomCode: code,
            hostId: SELF_ID,
            players: [
              { id: SELF_ID, name, cards: [], cardsPlayed: 0, calledUNO: false, isBot: false },
              { id: "local-bot", name: botName, cards: [], cardsPlayed: 0, calledUNO: false,
                isBot: true, difficulty }
            ],
            started: false, turn: 0, direction: 1, stackCount: 0,
            deck: [], discard: [], handSize: 7,
            rules: {
              stacking:          userRules.stacking !== false,
              drawUntilPlayable: userRules.drawUntilPlayable === true,
              challengePlusFour: userRules.challengePlusFour === true,
              speedSeven: false, jumpIn: false
            },
            soloMode: true, deckDecision: null, challengeContext: null
          };
          emit("session", { token: "local", roomCode: code });
          emit("roomCreated", code);
          // Skip lobby — start immediately with default rules.
          startGame(7, room.rules);
          break;
        }

        case "startGame": {
          if (!room) return;
          const { handSize, cards, rules } = payload || {};
          if (rules) Object.assign(room.rules, rules);
          startGame(handSize || cards || 7, room.rules);
          break;
        }

        case "updateLobbyRules": {
          if (!room) return;
          if (payload && payload.rules) Object.assign(room.rules, payload.rules);
          if (payload && Number.isInteger(payload.handSize)) room.handSize = payload.handSize;
          emitLobby();
          break;
        }

        case "playCard": {
          if (!room || !room.started) return;
          const { card, chosenColor } = payload || {};
          const player = room.players[room.turn];
          if (!player || player.id !== SELF_ID) return;
          const idx = player.cards.findIndex((c) => c.color === card.color && c.value === card.value);
          if (idx === -1) return;
          const top = E.getTopCard(room);
          if (!E.isPlayableCard(card, top, room.stackCount, room.rules)) {
            // Match server: stack-active rejects without extra punishment.
            if (room.stackCount > 0) {
              emit("invalidMove", "Stack a +2/+4 or accept the penalty.");
              return;
            }
            // Illegal: draw 1 penalty, KEEP the same player's turn (parity with server).
            emit("invalidMove", "That card cannot be played right now.");
            E.drawCards(room, player, 1);
            emit("penalty");
            emitGame();
            return;
          }
          // Cannot finish the game with a power card (parity with server line 1138).
          if (player.cards.length === 1 && E.isPowerCard(card)) {
            emit("invalidMove", "You cannot finish the game with a power card.");
            E.drawCards(room, player, 1);
            emit("penalty");
            emitGame();
            return;
          }
          const played = { ...player.cards[idx] };
          if (played.color === "black" && chosenColor) {
            played.color = chosenColor;
            played._userColor = true;
          }
          const prior = card.value === "+4" ? E.buildPlusFourContext(player, top) : null;
          player.cards.splice(idx, 1);
          applyCardPlay(player, played, prior);
          break;
        }

        case "drawCard": {
          if (!room || !room.started) return;
          const player = room.players[room.turn];
          if (!player || player.id !== SELF_ID) return;
          const isPenalty = room.stackCount > 0;
          const drawCount = isPenalty ? room.stackCount : 1;
          const r = drawOrPrompt(player, drawCount, { advanceSteps: 1, clearStackOnResume: true });
          if (!r) break;
          room.stackCount = 0;
          room.challengeContext = null;

          // House rule: drawUntilPlayable — keep turn open up to 3 draws (parity with server).
          const DRAW_UNTIL_CAP = 3;
          if (!isPenalty && room.rules && room.rules.drawUntilPlayable) {
            room.drawsThisTurn = (room.drawsThisTurn || 0) + 1;
            if (room.drawsThisTurn < DRAW_UNTIL_CAP) {
              scheduleTurn();
              emitGame();
              break;
            }
          }
          advanceAndSchedule(1);
          break;
        }

        case "uno": {
          if (!room || !room.started) return;
          const player = room.players.find((p) => p.id === SELF_ID);
          if (player && player.cards.length === 1) {
            player.calledUNO = true;
            emit("unoCalled", { playerName: player.name });
          }
          break;
        }

        case "challengePlusFour": {
          if (!room || !room.started || !room.challengeContext) return;
          const ctx = room.challengeContext;
          const challenger = room.players[room.turn];
          const offender = room.players.find((p) => p.id === ctx.playerId);
          if (!challenger || !offender) return;
          const accumulated = room.stackCount;
          room.stackCount = 0;
          room.challengeContext = null;
          if (ctx.hadMatchingColor) {
            // offender bluffed → they draw the full accumulated stack
            E.drawCards(room, offender, accumulated);
            emit("challengeResolved", { challengerId: challenger.id, offenderId: offender.id, success: true, drawn: accumulated });
            // Challenger keeps their turn — reschedule without advancing
            scheduleTurn();
            emitGame();
          } else {
            // legit +4 → challenger draws accumulated + 2
            const penalty = accumulated + 2;
            E.drawCards(room, challenger, penalty);
            emit("challengeResolved", { challengerId: challenger.id, offenderId: offender.id, success: false, drawn: penalty });
            advanceAndSchedule(1);
          }
          break;
        }

        case "resolveDeckDecision": {
          if (!room || !room.deckDecision) return;
          const action = (payload && payload.action) || "shuffle";
          if (action === "declareWinner") {
            const leader = room.players.reduce((best, p) =>
              !best || p.cards.length < best.cards.length ? p : best, null);
            emitGameOver(leader ? leader.name : "No winner");
            return;
          }
          if (action !== "shuffle") return;
          if (room.discard.length <= 1) {
            emit("roomError", "Not enough used cards to shuffle. Declare a winner instead.");
            return;
          }
          E.reshuffleDeck(room);
          const ds = room.deckDecision;
          room.deckDecision = null;
          // Resume the interrupted draw if any.
          if (ds.playerId && ds.remainingDraws > 0) {
            const p = room.players.find((x) => x.id === ds.playerId);
            if (p) {
              const r = E.drawCards(room, p, ds.remainingDraws);
              if (r.drawnCount > 0 && ds.showPenalty) emit("penalty");
              if (r.needsDeckDecision) {
                requestDeckDecision({ ...ds, remainingDraws: r.remainingCount });
                return;
              }
            }
          }
          if (ds.clearStackOnResume) {
            room.stackCount = 0;
            room.challengeContext = null;
          }
          if (ds.advanceSteps > 0) {
            E.advanceTurn(room, ds.advanceSteps);
          }
          scheduleTurn();
          emitGame();
          break;
        }

        case "leaveRoom": {
          stopTurnTimer();
          stopBotTurn();
          room = null;
          emit("leftRoom");
          break;
        }

        case "requestRematch": {
          if (!room) return;
          room.players.forEach((p) => { p.cards = []; p.calledUNO = false; p.cardsPlayed = 0; });
          startGame(room.handSize || 7, room.rules);
          break;
        }

        default:
          // Silently ignore unsupported events (loginDevice, requestStats, etc.)
          break;
      }
    }

    function startGame(handSize, rules) {
      room.handSize = Number.isInteger(handSize) ? handSize : 7;
      if (rules) room.rules = rules;
      room.started = true;
      room.turn = 0;
      room.direction = 1;
      room.stackCount = 0;
      room.deckDecision = null;
      room.challengeContext = null;
      room.deck = E.createUnoDeck();
      room.discard = [];
      room.players.forEach((p) => {
        p.cards = []; p.calledUNO = false; p.cardsPlayed = 0;
        E.drawCards(room, p, room.handSize);
      });
      let first = room.deck.pop();
      while (first && first.color === "black") {
        room.deck.unshift(first);
        E.shuffle(room.deck);
        first = room.deck.pop();
      }
      room.discard = first ? [first] : [];
      emit("gameStarted");
      scheduleTurn();
      emitGame();
    }

    return {
      id: SELF_ID,
      handle,
      isActive: () => !!room,
      shutdown: () => { stopTurnTimer(); stopBotTurn(); room = null; }
    };
  }

  global.LCB_LocalGame = { create: createLocalGame };
})(typeof self !== "undefined" ? self : this);
