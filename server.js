const express = require("express");
const crypto = require("crypto");
const { createServer } = require("http");
const { Server } = require("socket.io");
const dbApi = require("./db");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static("public"));

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const TURN_DURATION_MS = 15000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;
const DEFAULT_HAND_SIZE = 7;
// Reconnect grace: how long a dropped player keeps their seat before being removed.
const RECONNECT_GRACE_MS  = 30 * 1000;
// Lobby drop is more lenient: waiting players can refresh / change network freely.
const LOBBY_GRACE_MS      = 60 * 1000;
// Idle-room garbage collection interval and threshold.
const ROOM_GC_INTERVAL_MS = 5  * 60 * 1000;
const ROOM_IDLE_LIMIT_MS  = 60 * 60 * 1000;
const rooms = {};

function makeToken() {
  return crypto.randomBytes(16).toString("hex");
}

function createPlayer(socket, name) {
  // Attach the authenticated userId (from socket.data.userId, set on loginDevice).
  // Anonymous sockets are still allowed; their stats simply won't be persisted.
  return {
    id: socket.id,
    token: makeToken(),
    userId: (socket.data && socket.data.userId) || null,
    name: dbApi.sanitizeName(name),
    cards: [],
    calledUNO: false,
    cardsPlayed: 0,
    isBot: false,
    disconnected: false,
    disconnectTimer: null
  };
}

// Mark a player's room as recently active so the GC won't reap it.
function touchRoom(room) {
  if (room) room.lastActivityAt = Date.now();
}

const BOT_DIFFICULTIES = new Set(["easy", "normal", "hard"]);
const BOT_NAMES = { easy: "Rookie Bot", normal: "Robot", hard: "Master Bot" };

function createBotPlayer(roomCode, difficulty = "normal") {
  const level = BOT_DIFFICULTIES.has(difficulty) ? difficulty : "normal";
  return {
    id: `bot:${roomCode}`,
    name: BOT_NAMES[level] || "Robot",
    cards: [],
    calledUNO: false,
    isBot: true,
    difficulty: level
  };
}

function generateRoomCode() {
  let roomCode = "";

  do {
    roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
  } while (rooms[roomCode]);

  return roomCode;
}

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

function getSafeRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) {
    return null;
  }

  return {
    roomCode,
    hostId: room.hostId,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      cardCount: player.cards.length,
      isBot: !!player.isBot,
      disconnected: !!player.disconnected
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
      room.rules &&
      room.rules.challengePlusFour &&
      room.stackCount >= 4 &&
      room.discard.length > 0 &&
      room.discard[room.discard.length - 1].value === "+4" &&
      room.challengeContext &&
      room.challengeContext.playerId
    ),
    spectatorCount: room.spectators ? room.spectators.size : 0,
    turnEndsAt: room.turnEndsAt || null,
    awaitingDeckDecision: Boolean(room.deckDecision),
    canShuffleDeck: room.discard.length > 1
  };
}

function emitLobby(roomCode) {
  touchRoom(rooms[roomCode]);
  io.to(roomCode).emit("lobbyUpdated", getSafeRoom(roomCode));
}

function emitGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room) {
    return;
  }
  touchRoom(room);

  room.players.forEach((player) => {
    if (!player.isBot) {
      io.to(player.id).emit("yourCards", player.cards);
    }
  });

  io.to(roomCode).emit("updateGame", getSafeRoom(roomCode));
  queueBotTurnIfNeeded(roomCode);
}

function sendError(socket, message) {
  socket.emit("roomError", message);
}

function emitInvalidMove(socket, message = "Invalid move.") {
  socket.emit("invalidMove", message);
}

function reshuffleDeck(room) {
  if (room.deck.length > 0 || room.discard.length <= 1) {
    return;
  }

  const topCard = room.discard.pop();
  // Reset wilds back to black so they retain their wild nature when redrawn.
  const recycled = room.discard.map((c) =>
    (c.value === "wild" || c.value === "+4") ? { ...c, color: "black" } : c
  );
  room.deck = shuffle(recycled);
  room.discard = topCard ? [topCard] : [];
}

function drawCards(room, player, count) {
  let drawnCount = 0;

  for (let i = 0; i < count; i += 1) {
    if (room.deck.length === 0) {
      return {
        drawnCount,
        needsDeckDecision: true,
        remainingCount: count - drawnCount
      };
    }

    const nextCard = room.deck.pop();
    if (!nextCard) {
      return {
        drawnCount,
        needsDeckDecision: true,
        remainingCount: count - drawnCount
      };
    }

    player.cards.push(nextCard);
    drawnCount += 1;
  }

  return {
    drawnCount,
    needsDeckDecision: room.deck.length === 0,
    remainingCount: 0
  };
}

function stopTurnTimer(room) {
  clearTimeout(room.timer);
  room.timer = null;
  room.turnEndsAt = null;
}

function stopBotTurn(room) {
  clearTimeout(room.botTurnTimer);
  room.botTurnTimer = null;
}

function advanceTurn(roomCode, extraSteps = 1) {
  const room = rooms[roomCode];
  if (!room || room.players.length === 0) {
    return;
  }

  room.turn =
    (room.turn + extraSteps * room.direction + room.players.length) %
    room.players.length;
  room.drawsThisTurn = 0;
}

function scheduleTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.started || room.deckDecision) {
    return;
  }

  stopBotTurn(room);
  stopTurnTimer(room);
  room.turnEndsAt = Date.now() + TURN_DURATION_MS;

  room.timer = setTimeout(() => {
    const activeRoom = rooms[roomCode];
    if (!activeRoom || !activeRoom.started) {
      return;
    }

    const player = activeRoom.players[activeRoom.turn];
    const drawCount = activeRoom.stackCount > 0 ? activeRoom.stackCount : 1;
    const drawResult = drawCards(activeRoom, player, drawCount);

    if (drawResult.drawnCount > 0) {
      io.to(player.id).emit("penalty");
    }

    if (drawResult.needsDeckDecision) {
      requestDeckDecision(roomCode, {
        playerId: player.id,
        remainingDraws: drawResult.remainingCount,
        advanceSteps: 1,
        clearStackOnResume: true,
        showPenalty: false
      });
      return;
    }

    activeRoom.stackCount = 0;
    activeRoom.challengeContext = null;
    advanceTurn(roomCode);
    scheduleTurn(roomCode);
    emitGameState(roomCode);
  }, TURN_DURATION_MS);
}

function advanceToNextTurn(roomCode, extraSteps = 1) {
  advanceTurn(roomCode, extraSteps);
  scheduleTurn(roomCode);
  emitGameState(roomCode);
}

function isPlayableCard(card, topCard, stackCount, rules) {
  if (!topCard) {
    return true;
  }

  if (stackCount > 0) {
    // House rule: stacking disabled — next player can't pass damage on.
    if (rules && rules.stacking === false) {
      return false;
    }

    if (topCard.value === "+4") {
      return card.value === "+4";
    }

    if (topCard.value === "+2") {
      return card.value === "+2" || card.value === "+4";
    }

    return false;
  }

  if (card.color === "black") {
    return true;
  }

  return card.color === topCard.color || card.value === topCard.value;
}

function isPowerCard(card) {
  return ["+2", "+4", "skip", "reverse", "wild"].includes(card.value);
}

function finishGame(roomCode, winnerName) {
  const room = rooms[roomCode];
  if (!room) {
    return;
  }

  room.started = false;
  room.rematchVotes = new Set();
  stopBotTurn(room);
  stopTurnTimer(room);

  // Persist stats for every authenticated human player in this game.
  try {
    const outcomes = room.players
      .filter((p) => !p.isBot && p.userId)
      .map((p) => ({
        userId: p.userId,
        won: p.name === winnerName,
        cardsPlayed: p.cardsPlayed || 0
      }));
    if (outcomes.length > 0) dbApi.recordGameResult(outcomes);
  } catch (err) {
    console.error("[stats] failed to record game result:", err);
  }

  io.to(roomCode).emit("gameOver", winnerName);
  emitLobby(roomCode);
}

function getLeadingPlayer(room) {
  return room.players.reduce((best, player) => {
    if (!best || player.cards.length < best.cards.length) {
      return player;
    }

    return best;
  }, null);
}

function chooseBotColor(cards, difficulty) {
  const COLORS = ["red", "green", "blue", "yellow"];
  // Easy: pick a color at random — feels less tactical.
  if (difficulty === "easy") {
    return COLORS[Math.floor(Math.random() * COLORS.length)];
  }
  const colorCounts = { red: 0, green: 0, blue: 0, yellow: 0 };
  cards.forEach((card) => {
    if (colorCounts[card.color] !== undefined) {
      colorCounts[card.color] += 1;
    }
  });
  const sorted = Object.entries(colorCounts).sort((a, b) => b[1] - a[1]);
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
  if (difficulty === "easy")  return 900  + Math.floor(Math.random() * 900);
  if (difficulty === "hard")  return 700  + Math.floor(Math.random() * 500);
  return 1000 + Math.floor(Math.random() * 500);
}

function pickBotCard(player, topCard, stackCount, room) {
  const playableCards = player.cards.filter((card) =>
    isPlayableCard(card, topCard, stackCount, room && room.rules) &&
    !(player.cards.length === 1 && isPowerCard(card))
  );

  if (playableCards.length === 0) {
    return null;
  }

  const difficulty = player.difficulty || "normal";

  // EASY: pick a random playable card; mistakes occasionally by skipping power plays.
  if (difficulty === "easy") {
    // 30% chance to prefer a non-power card to feel less aggressive
    const nonPower = playableCards.filter((c) => !isPowerCard(c));
    const pool = (nonPower.length > 0 && Math.random() < 0.5) ? nonPower : playableCards;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // For HARD, find the human opponent with fewest cards (threat detection).
  let opponentLowCount = Infinity;
  if (difficulty === "hard" && room) {
    room.players.forEach((p) => {
      if (p.id !== player.id && p.cards.length < opponentLowCount) {
        opponentLowCount = p.cards.length;
      }
    });
  }
  const opponentInDanger = difficulty === "hard" && opponentLowCount <= 2;

  // Count colors in own hand (used by hard to dump dominant color).
  const colorCounts = { red: 0, green: 0, blue: 0, yellow: 0 };
  player.cards.forEach((c) => {
    if (colorCounts[c.color] !== undefined) colorCounts[c.color] += 1;
  });

  const rankedCards = playableCards.sort((left, right) => {
    const score = (card) => {
      // Stack response: must throw a +2/+4 to pass it on, else 0 (will draw).
      if (stackCount > 0) {
        if (topCard.value === "+4") return card.value === "+4" ? 4 : 0;
        if (card.value === "+4") return 4;
        if (card.value === "+2") return 3;
        return 0;
      }

      // HARD: when opponent is about to win, prioritize attack cards.
      if (opponentInDanger) {
        if (card.value === "+4")     return 100;
        if (card.value === "+2")     return 90;
        if (card.value === "skip")   return 80;
        if (card.value === "reverse" && room && room.players.length === 2) return 78;
      }

      // Match by color (preferred) or value.
      let s = 0;
      if (card.color !== "black" && card.color === topCard.color) s = 4;
      else if (card.color !== "black" && card.value === topCard.value) s = 3;
      else if (card.value === "wild") s = 1;
      else if (card.value === "+4") s = 0;
      else s = 2;

      if (difficulty === "hard") {
        // Prefer dumping cards from the most-held color so we can play them off later.
        if (card.color !== "black") s += colorCounts[card.color] * 0.1;
        // Save wilds/+4 for emergencies — penalize when opponent isn't close.
        if (card.value === "wild" || card.value === "+4") s -= 1.5;
      }

      return s;
    };

    return score(right) - score(left);
  });

  return rankedCards[0];
}

function startRoomGame(roomCode, handSize = DEFAULT_HAND_SIZE) {
  const room = rooms[roomCode];
  if (!room) {
    return false;
  }

  room.handSize = Number.isInteger(handSize) ? handSize : DEFAULT_HAND_SIZE;
  room.started = true;
  room.turn = 0;
  room.direction = 1;
  room.stackCount = 0;
  room.deckDecision = null;
  room.deck = createUnoDeck();
  room.discard = [];

  room.players.forEach((player) => {
    player.cards = [];
    player.calledUNO = false;
    drawCards(room, player, room.handSize);
  });

  let firstCard = room.deck.pop();
  while (firstCard && firstCard.color === "black") {
    room.deck.unshift(firstCard);
    shuffle(room.deck);
    firstCard = room.deck.pop();
  }

  room.discard = firstCard ? [firstCard] : [];

  io.to(roomCode).emit("gameStarted");
  scheduleTurn(roomCode);
  emitGameState(roomCode);
  return true;
}

// Build the legality snapshot used to resolve a Challenge against a +4.
// Must be computed BEFORE the +4 is placed onto the discard so we capture
// the color that was active in play and whether the player had a matching card.
function buildPlusFourContext(player, topCard) {
  const priorColor = topCard ? topCard.color : null;
  const hadMatchingColor = !!(
    priorColor &&
    priorColor !== "black" &&
    player.cards.some((c) => c.color === priorColor)
  );
  return { priorColor, hadMatchingColor };
}

// Plays `card` (a copy already removed from player's hand) on behalf of `player`.
// Handles UNO call, wild color resolution, +2/+4 stacking, reverse, skip, win, and turn advancement.
function applyCardPlay(roomCode, player, playedCard, priorContext) {
  const room = rooms[roomCode];
  if (!room) return;

  player.cardsPlayed = (player.cardsPlayed || 0) + 1;

  if (player.cards.length === 1 && !player.calledUNO) {
    // Humans must press the button; bots auto-call based on difficulty (easy may forget).
    if (!player.isBot || shouldBotCallUno(player.difficulty)) {
      player.calledUNO = true;
      io.to(roomCode).emit("unoCalled", { playerName: player.name });
    } else if (player.isBot) {
      // Bot forgot — penalize after 3s if still at 1 card and still hasn't called.
      setTimeout(() => {
        const activeRoom = rooms[roomCode];
        if (!activeRoom || !activeRoom.started) return;
        const active = activeRoom.players.find((p) => p.id === player.id);
        if (active && active.cards.length === 1 && !active.calledUNO) {
          drawCards(activeRoom, active, 2);
          io.to(roomCode).emit("penalty", { playerName: active.name });
          emitGameState(roomCode);
        }
      }, 3000);
    }
  }

  if (playedCard.color === "black") {
    playedCard.color = chooseBotColor(player.cards, player.difficulty);
  }

  room.discard.push(playedCard);

  if (!player.isBot) {
    io.to(player.id).emit("yourCards", player.cards);
  }

  if (player.cards.length === 0) {
    finishGame(roomCode, player.name);
    return;
  }

  if (playedCard.value === "+2") {
    room.stackCount += 2;
    // +2 cannot be challenged — clear any prior +4 challenge context.
    room.challengeContext = null;
  } else if (playedCard.value === "+4") {
    room.stackCount += 4;
    // Capture the legality info for a possible challenge against THIS +4.
    // priorContext = { priorColor, hadMatchingColor } supplied by caller.
    room.challengeContext = priorContext
      ? {
          playerId: player.id,
          priorColor: priorContext.priorColor || null,
          hadMatchingColor: Boolean(priorContext.hadMatchingColor)
        }
      : null;
  } else {
    room.stackCount = 0;
    room.challengeContext = null;
  }

  if (playedCard.value === "reverse") {
    room.direction *= -1;
  }

  const shouldSkip = playedCard.value === "skip";
  advanceToNextTurn(roomCode, shouldSkip ? 2 : 1);
}

function runBotTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.started || room.deckDecision) {
    return;
  }

  const bot = room.players[room.turn];
  if (!bot || !bot.isBot) {
    return;
  }

    const topCard = getTopCard(room);
    const selectedCard = pickBotCard(bot, topCard, room.stackCount, room);

  if (!selectedCard) {
    const drawCount = room.stackCount > 0 ? room.stackCount : 1;
    const drawResult = drawCards(room, bot, drawCount);

    if (drawResult.needsDeckDecision) {
      requestDeckDecision(roomCode, {
        playerId: bot.id,
        remainingDraws: drawResult.remainingCount,
        advanceSteps: 1,
        clearStackOnResume: true,
        showPenalty: false
      });
      return;
    }

    room.stackCount = 0;
    advanceToNextTurn(roomCode);
    return;
  }

  const handIndex = bot.cards.findIndex(
    (card) => card.color === selectedCard.color && card.value === selectedCard.value
  );

  if (handIndex === -1) {
    return;
  }

  const playedCard = { ...bot.cards[handIndex] };
  const priorContext = playedCard.value === "+4"
    ? buildPlusFourContext(bot, getTopCard(room))
    : null;
  bot.cards.splice(handIndex, 1);
  applyCardPlay(roomCode, bot, playedCard, priorContext);
}

function queueBotTurnIfNeeded(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.started || room.deckDecision) {
    return;
  }

  const activePlayer = room.players[room.turn];
  if (!activePlayer || !activePlayer.isBot) {
    return;
  }

  stopBotTurn(room);
  room.botTurnTimer = setTimeout(() => {
    runBotTurn(roomCode);
  }, botThinkMs(activePlayer.difficulty));
}

function requestDeckDecision(roomCode, decisionState = {}) {
  const room = rooms[roomCode];
  if (!room || room.deckDecision) {
    return;
  }

  room.deckDecision = {
    playerId: decisionState.playerId || null,
    remainingDraws: decisionState.remainingDraws || 0,
    advanceSteps: decisionState.advanceSteps || 0,
    clearStackOnResume: Boolean(decisionState.clearStackOnResume),
    showPenalty: Boolean(decisionState.showPenalty)
  };

  stopTurnTimer(room);
  emitGameState(roomCode);
  io.to(roomCode).emit("deckEmpty", {
    roomCode,
    hostId: room.hostId,
    canShuffle: room.discard.length > 1
  });
}

function resolveDeckDecision(roomCode, action) {
  const room = rooms[roomCode];
  if (!room || !room.deckDecision) {
    return;
  }

  if (action === "declareWinner") {
    const leader = getLeadingPlayer(room);
    finishGame(roomCode, leader ? leader.name : "No winner");
    return;
  }

  if (action !== "shuffle") {
    return;
  }

  if (room.discard.length <= 1) {
    io.to(room.hostId).emit("roomError", "Not enough used cards to shuffle. Declare a winner instead.");
    return;
  }

  reshuffleDeck(room);

  const decisionState = room.deckDecision;
  room.deckDecision = null;

  if (decisionState.playerId && decisionState.remainingDraws > 0) {
    const player = room.players.find((entry) => entry.id === decisionState.playerId);

    if (player) {
      const drawResult = drawCards(room, player, decisionState.remainingDraws);

      if (drawResult.drawnCount > 0 && decisionState.showPenalty) {
        io.to(player.id).emit("penalty");
      }

      if (drawResult.needsDeckDecision) {
        requestDeckDecision(roomCode, {
          ...decisionState,
          remainingDraws: drawResult.remainingCount
        });
        return;
      }
    }
  }

  if (decisionState.clearStackOnResume) {
    room.stackCount = 0;
  }

  if (decisionState.advanceSteps > 0) {
    advanceToNextTurn(roomCode, decisionState.advanceSteps);
    return;
  }

  scheduleTurn(roomCode);
  emitGameState(roomCode);
}

function removeSpectator(socketId) {
  Object.keys(rooms).forEach((code) => {
    const room = rooms[code];
    if (room.spectators && room.spectators.has(socketId)) {
      room.spectators.delete(socketId);
      emitLobby(code);
    }
  });
}

function removePlayerFromRoom(socketId) {
  const roomCode = Object.keys(rooms).find((code) =>
    rooms[code].players.some((player) => player.id === socketId)
  );

  if (!roomCode) {
    return;
  }

  const room = rooms[roomCode];
  const index = room.players.findIndex((player) => player.id === socketId);
  if (index === -1) {
    return;
  }

  // Clear any reconnect-grace timer attached to this player.
  const removed = room.players[index];
  if (removed && removed.disconnectTimer) {
    clearTimeout(removed.disconnectTimer);
    removed.disconnectTimer = null;
  }

  room.players.splice(index, 1);

  if (room.players.length === 0 || room.players.every((player) => player.isBot)) {
    stopBotTurn(room);
    stopTurnTimer(room);
    delete rooms[roomCode];
    return;
  }

  if (room.hostId === socketId) {
    room.hostId = room.players[0].id;
  }

  if (room.started) {
    if (index < room.turn) {
      room.turn -= 1;
    }

    if (room.turn >= room.players.length) {
      room.turn = 0;
    }

    if (room.players.length < MIN_PLAYERS) {
      room.started = false;
      stopTurnTimer(room);
      io.to(roomCode).emit("roomError", "A player left, so the game was stopped.");
      emitLobby(roomCode);
      return;
    }

    scheduleTurn(roomCode);
    emitGameState(roomCode);
  } else {
    emitLobby(roomCode);
  }
}

io.on("connection", (socket) => {
  // ----- Anonymous device login -----
  // Establishes a stable userId for this socket; required for stats persistence.
  socket.on("loginDevice", ({ deviceId, name } = {}) => {
    if (!dbApi.isValidDeviceId(deviceId)) {
      socket.emit("loginError", "invalid_device_id");
      return;
    }
    try {
      const { user, stats, created } = dbApi.loginDevice(deviceId, name);
      // If the client supplied a name and this is an existing account whose name
      // doesn't match, update it (lets users change their name from the menu).
      let final = user;
      if (!created && typeof name === "string") {
        const cleaned = dbApi.sanitizeName(name, user.name);
        if (cleaned !== user.name) {
          final = dbApi.updateProfile(user.id, { name: cleaned }) || user;
        }
      }
      socket.data.userId = final.id;
      socket.emit("loggedIn", {
        userId: final.id,
        name: final.name,
        avatar: final.avatar,
        stats
      });
    } catch (err) {
      console.error("[auth] loginDevice failed:", err);
      socket.emit("loginError", "server_error");
    }
  });

  socket.on("updateProfile", ({ name, avatar } = {}) => {
    const userId = socket.data && socket.data.userId;
    if (!userId) {
      socket.emit("loginError", "not_logged_in");
      return;
    }
    const user = dbApi.updateProfile(userId, { name, avatar });
    if (!user) {
      socket.emit("loginError", "user_not_found");
      return;
    }
    // Reflect the new name in any active room the user happens to be in.
    Object.keys(rooms).forEach((code) => {
      const player = rooms[code].players.find((p) => p.userId === userId);
      if (!player) return;
      player.name = user.name;
      if (rooms[code].started) emitGameState(code); else emitLobby(code);
    });
    socket.emit("profileUpdated", {
      userId: user.id,
      name: user.name,
      avatar: user.avatar
    });
  });

  socket.on("requestStats", () => {
    const userId = socket.data && socket.data.userId;
    if (!userId) return;
    socket.emit("stats", dbApi.getStats(userId));
  });

  socket.on("createRoom", (playerName) => {
    const roomCode = generateRoomCode();
    const player = createPlayer(socket, playerName);

    rooms[roomCode] = {
      hostId: socket.id,
      players: [player],
      started: false,
      handSize: DEFAULT_HAND_SIZE,
      soloMode: false,
      turn: 0,
      direction: 1,
      stackCount: 0,
      deck: [],
      discard: [],
      timer: null,
      botTurnTimer: null,
      turnEndsAt: null,
      deckDecision: null,
      lastActivityAt: Date.now()
    };

    socket.join(roomCode);
    socket.emit("session", { token: player.token, roomCode });
    socket.emit("roomCreated", roomCode);
    emitLobby(roomCode);
  });

  socket.on("joinRoom", ({ roomCode, playerName }) => {
    const normalizedCode = (roomCode || "").trim().toUpperCase();
    const room = rooms[normalizedCode];

    if (!room) {
      sendError(socket, "Room not found.");
      return;
    }

    if (room.started) {
      socket.emit("spectateOffered", { roomCode: normalizedCode, reason: "started" });
      return;
    }

    if (room.players.length >= MAX_PLAYERS) {
      socket.emit("spectateOffered", { roomCode: normalizedCode, reason: "full" });
      return;
    }

    const player = createPlayer(socket, playerName);
    room.players.push(player);
    touchRoom(room);
    socket.join(normalizedCode);
    socket.emit("session", { token: player.token, roomCode: normalizedCode });
    socket.emit("joinedRoom", normalizedCode);
    emitLobby(normalizedCode);
  });

  socket.on("startBotMatch", (payload) => {
    const playerName = typeof payload === "string" ? payload : payload?.name;
    const difficulty = (typeof payload === "object" && payload?.difficulty) || "normal";
    const roomCode = generateRoomCode();
    const humanPlayer = createPlayer(socket, playerName);

    rooms[roomCode] = {
      hostId: socket.id,
      players: [humanPlayer, createBotPlayer(roomCode, difficulty)],
      started: false,
      handSize: DEFAULT_HAND_SIZE,
      soloMode: true,
      lastActivityAt: Date.now(),
      // Defaults match multiplayer; the host can toggle them in the lobby before starting.
      rules: {
        stacking:          true,
        drawUntilPlayable: false,
        challengePlusFour: false
      },
      turn: 0,
      direction: 1,
      stackCount: 0,
      deck: [],
      discard: [],
      timer: null,
      botTurnTimer: null,
      turnEndsAt: null,
      deckDecision: null
    };

    socket.join(roomCode);
    socket.emit("session", { token: humanPlayer.token, roomCode });
    socket.emit("roomCreated", roomCode);
    emitLobby(roomCode);
  });

  socket.on("updateLobbyRules", ({ roomCode, rules, handSize }) => {
    const room = rooms[roomCode];
    if (!room || room.started) return;
    if (room.hostId !== socket.id) return;

    if (rules && typeof rules === "object") {
      room.rules = {
        stacking:          rules.stacking !== false,
        drawUntilPlayable: rules.drawUntilPlayable === true,
        challengePlusFour: rules.challengePlusFour === true
      };
    }
    if (handSize !== undefined) {
      const n = Number.parseInt(handSize, 10);
      if ([5, 7, 10].includes(n)) room.handSize = n;
    }
    emitLobby(roomCode);
  });

  socket.on("startGame", ({ roomCode, cards, rules }) => {
    const room = rooms[roomCode];
    if (!room) {
      sendError(socket, "Room not found.");
      return;
    }

    if (room.hostId !== socket.id) {
      sendError(socket, "Only the host can start the game.");
      return;
    }

    if (room.players.length < MIN_PLAYERS) {
      sendError(socket, "At least 2 players are required.");
      return;
    }

    room.rules = {
      stacking:           rules?.stacking !== false,           // default ON
      drawUntilPlayable:  rules?.drawUntilPlayable === true,   // default OFF
      challengePlusFour:  rules?.challengePlusFour === true    // default OFF
    };

    const handSize = Number.parseInt(cards, 10);
    startRoomGame(roomCode, Number.isInteger(handSize) ? handSize : DEFAULT_HAND_SIZE);
  });

  socket.on("drawCard", (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.started || room.deckDecision) {
      return;
    }

    const player = room.players[room.turn];
    if (!player || player.id !== socket.id) {
      sendError(socket, "It is not your turn.");
      return;
    }

    const isPenalty = room.stackCount > 0;
    const drawCount = isPenalty ? room.stackCount : 1;
    const drawResult = drawCards(room, player, drawCount);

    if (drawResult.needsDeckDecision) {
      requestDeckDecision(roomCode, {
        playerId: player.id,
        remainingDraws: drawResult.remainingCount,
        advanceSteps: 1,
        clearStackOnResume: true,
        showPenalty: false
      });
      return;
    }

    room.stackCount = 0;

    const rules = room.rules || {};
    const DRAW_UNTIL_CAP = 3;

    // House rule: drawUntilPlayable — player draws one card per click, max 3 per turn.
    // The turn stays open between draws so they can choose to play or draw again.
    // No auto-play; turn ends only when they play a card or hit the 3-draw cap.
    if (!isPenalty && rules.drawUntilPlayable) {
      room.drawsThisTurn = (room.drawsThisTurn || 0) + 1;
      if (room.drawsThisTurn < DRAW_UNTIL_CAP) {
        scheduleTurn(roomCode);
        emitGameState(roomCode);
        return;
      }
      // Reached cap: end the turn.
      advanceToNextTurn(roomCode);
      return;
    }

    advanceToNextTurn(roomCode);
  });

  socket.on("uno", (roomCode) => {
    const room = rooms[roomCode];
    if (!room) {
      return;
    }

    const player = room.players.find((entry) => entry.id === socket.id);
    if (player && player.cards.length === 1) {
      player.calledUNO = true;
      io.to(roomCode).emit("unoCalled", { playerName: player.name });
    }
  });

  socket.on("playCard", ({ roomCode, card, chosenColor }) => {
    const room = rooms[roomCode];
    if (!room || !room.started || room.deckDecision) {
      return;
    }

    const player = room.players[room.turn];
    if (!player || player.id !== socket.id) {
      sendError(socket, "It is not your turn.");
      return;
    }

    const handIndex = player.cards.findIndex(
      (entry) => entry.color === card.color && entry.value === card.value
    );

    if (handIndex === -1) {
      sendError(socket, "That card is not in your hand.");
      return;
    }

    const topCard = getTopCard(room);
    if (!isPlayableCard(card, topCard, room.stackCount, room.rules)) {
      // Under PENALTY (+2/+4), a misplay should NOT add an extra punishment card —
      // the player is already paying via the stack. Just reject and let them choose
      // Accept, Stack, or Challenge.
      if (room.stackCount > 0) {
        emitInvalidMove(socket, "Stack a +2/+4 or accept the penalty.");
        return;
      }

      emitInvalidMove(socket, "That card cannot be played right now.");
      const drawResult = drawCards(room, player, 1);

      if (drawResult.drawnCount > 0) {
        io.to(player.id).emit("penalty");
      }

      if (drawResult.needsDeckDecision) {
        requestDeckDecision(roomCode, {
          playerId: player.id,
          remainingDraws: drawResult.remainingCount,
          advanceSteps: 0,
          clearStackOnResume: false,
          showPenalty: false
        });
        return;
      }

      emitGameState(roomCode);
      return;
    }

    if (player.cards.length === 1 && isPowerCard(card)) {
      emitInvalidMove(socket, "You cannot finish the game with a power card.");
      const drawResult = drawCards(room, player, 1);

      if (drawResult.drawnCount > 0) {
        io.to(player.id).emit("penalty");
      }

      if (drawResult.needsDeckDecision) {
        requestDeckDecision(roomCode, {
          playerId: player.id,
          remainingDraws: drawResult.remainingCount,
          advanceSteps: 0,
          clearStackOnResume: false,
          showPenalty: false
        });
        return;
      }

      emitGameState(roomCode);
      return;
    }

    // Snapshot legality info BEFORE the +4 lands (used only if the next player challenges).
    let priorTopColor = null;
    let priorHadMatching = false;
    if (card.value === "+4") {
      const ctx = buildPlusFourContext(player, topCard);
      priorTopColor = ctx.priorColor;
      priorHadMatching = ctx.hadMatchingColor;
    }

    const playedCard = { ...player.cards[handIndex] };
    player.cards.splice(handIndex, 1);

    if (playedCard.color === "black") {
      if (!chosenColor || !["red", "green", "blue", "yellow"].includes(chosenColor)) {
        player.cards.push(playedCard);
        io.to(player.id).emit("yourCards", player.cards);
        sendError(socket, "Choose a color for wild cards.");
        return;
      }

      playedCard.color = chosenColor;
    }

    room.discard.push(playedCard);

    if (player.cards.length === 1) {
      player.calledUNO = false;

      setTimeout(() => {
        const activeRoom = rooms[roomCode];
        if (!activeRoom || !activeRoom.started) {
          return;
        }

        const activePlayer = activeRoom.players.find((entry) => entry.id === player.id);
        if (activePlayer && activePlayer.cards.length === 1 && !activePlayer.calledUNO) {
          const drawResult = drawCards(activeRoom, activePlayer, 2);

          if (drawResult.drawnCount > 0) {
            io.to(activePlayer.id).emit("penalty");
          }

          if (drawResult.needsDeckDecision) {
            requestDeckDecision(roomCode, {
              playerId: activePlayer.id,
              remainingDraws: drawResult.remainingCount,
              advanceSteps: 0,
              clearStackOnResume: false,
              showPenalty: false
            });
            return;
          }

          emitGameState(roomCode);
        }
      }, 3000);
    }

    if (player.cards.length === 0) {
      finishGame(roomCode, player.name);
      return;
    }

    if (playedCard.value === "+2") {
      room.stackCount += 2;
      room.challengeContext = null;
    } else if (playedCard.value === "+4") {
      room.stackCount += 4;
      room.challengeContext = {
        playerId: player.id,
        priorColor: priorTopColor,
        hadMatchingColor: priorHadMatching
      };
    } else {
      room.stackCount = 0;
      room.challengeContext = null;
    }

    if (playedCard.value === "reverse") {
      room.direction *= -1;
    }

    const shouldSkip = playedCard.value === "skip";
    advanceToNextTurn(roomCode, shouldSkip ? 2 : 1);
  });

  socket.on("challengePlusFour", (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.started || room.deckDecision) return;

    // -- State machine guards: penalty must be active, top must be +4, rule must be on. --
    const rules = room.rules || {};
    if (!rules.challengePlusFour) return;
    if (!room.stackCount || room.stackCount < 4) return;

    const topCard = getTopCard(room);
    if (!topCard || topCard.value !== "+4") return;

    // Only the player whose turn it is (the target) can challenge.
    const challenger = room.players[room.turn];
    if (!challenger || challenger.id !== socket.id) {
      sendError(socket, "It is not your turn to challenge.");
      return;
    }

    const ctx = room.challengeContext;
    if (!ctx || !ctx.playerId || ctx.playerId === socket.id) return;

    const offender = room.players.find((p) => p.id === ctx.playerId);
    if (!offender) return;

    // Lock further actions on this penalty: clear stack and context immediately.
    const accumulated = room.stackCount;
    room.stackCount = 0;
    room.challengeContext = null;

    if (ctx.hadMatchingColor) {
      // Successful challenge: offender pays the accumulated draws; challenger keeps their turn.
      const drawResult = drawCards(room, offender, accumulated);
      io.to(offender.id).emit("penalty");
      io.to(roomCode).emit("challengeResolved", {
        challengerId: challenger.id,
        offenderId: offender.id,
        success: true,
        priorColor: ctx.priorColor,
        drawn: drawResult.drawnCount
      });

      if (drawResult.needsDeckDecision) {
        requestDeckDecision(roomCode, {
          playerId: offender.id,
          remainingDraws: drawResult.remainingCount,
          advanceSteps: 0,
          clearStackOnResume: false,
          showPenalty: false
        });
        return;
      }

      // Challenger plays normally now — refresh turn timer, keep current turn.
      scheduleTurn(roomCode);
      emitGameState(roomCode);
      return;
    }

    // Failed challenge: challenger draws accumulated + 2 (standard +6 for a +4),
    // then turn advances past them.
    const penalty = accumulated + 2;
    const drawResult = drawCards(room, challenger, penalty);
    io.to(challenger.id).emit("penalty");
    io.to(roomCode).emit("challengeResolved", {
      challengerId: challenger.id,
      offenderId: offender.id,
      success: false,
      priorColor: ctx.priorColor,
      drawn: drawResult.drawnCount
    });

    if (drawResult.needsDeckDecision) {
      requestDeckDecision(roomCode, {
        playerId: challenger.id,
        remainingDraws: drawResult.remainingCount,
        advanceSteps: 1,
        clearStackOnResume: false,
        showPenalty: false
      });
      return;
    }

    advanceToNextTurn(roomCode);
  });

  socket.on("disconnect", () => {
    // Spectators are stateless — drop them immediately.
    removeSpectator(socket.id);

    // Find the player's room (if any).
    const code = Object.keys(rooms).find((c) =>
      rooms[c].players.some((p) => p.id === socket.id)
    );
    if (!code) return;

    const room = rooms[code];
    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.isBot) return;

    // Mark as disconnected; the game continues. The turn timer auto-accepts/draws
    // for them if it becomes their turn while disconnected.
    player.disconnected = true;
    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);

    const grace = room.started ? RECONNECT_GRACE_MS : LOBBY_GRACE_MS;
    const lostTokenId = player.token; // capture before any reassignment
    player.disconnectTimer = setTimeout(() => {
      const r = rooms[code];
      if (!r) return;
      // If they reconnected meanwhile, the timer was cleared. Defensive recheck:
      const stillThere = r.players.find((p) => p.token === lostTokenId);
      if (!stillThere || !stillThere.disconnected) return;
      removePlayerFromRoom(stillThere.id);
    }, grace);

    io.to(code).emit("playerDropped", { playerName: player.name, name: player.name });
    if (room.started) emitGameState(code);
    else emitLobby(code);
  });

  // ----- Reconnect by token -----
  socket.on("resumeSession", ({ token, roomCode } = {}) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const room = rooms[code];
    if (!room || typeof token !== "string" || token.length !== 32) {
      socket.emit("sessionExpired");
      return;
    }
    const player = room.players.find((p) => p.token === token);
    if (!player) {
      socket.emit("sessionExpired");
      return;
    }

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    player.id = socket.id;
    player.disconnected = false;
    if (player.userId) socket.data.userId = player.userId;
    socket.join(code);
    touchRoom(room);

    socket.emit("session", { token: player.token, roomCode: code });
    socket.emit("sessionResumed", { roomCode: code });

    if (room.started) {
      // Replay the bare minimum the client needs to render the in-game view.
      socket.emit("gameStarted");
      io.to(socket.id).emit("yourCards", player.cards);
      emitGameState(code);
    } else {
      emitLobby(code);
    }
  });

  // Per-socket reaction rate limit: 1 reaction per 600ms.
  let lastReactionAt = 0;
  socket.on("sendReaction", (emoji) => {
    const now = Date.now();
    if (now - lastReactionAt < 600) return;
    lastReactionAt = now;

    const allowed = ["❤️", "🔥", "😂", "👍", "😱", "🤡"];
    if (typeof emoji !== "string" || !allowed.includes(emoji)) return;
    const roomCode = Object.keys(rooms).find((code) =>
      rooms[code].players.some((p) => p.id === socket.id) ||
      (rooms[code].spectators && rooms[code].spectators.has(socket.id))
    );
    if (!roomCode) return;

    io.to(roomCode).emit("reaction", { playerId: socket.id, emoji });
  });

  socket.on("requestRematch", () => {
    const roomCode = Object.keys(rooms).find((code) =>
      rooms[code].players.some((p) => p.id === socket.id)
    );
    if (!roomCode) return;
    const room = rooms[roomCode];
    if (room.started) return;

    if (!room.rematchVotes) room.rematchVotes = new Set();
    room.rematchVotes.add(socket.id);

    const humanPlayers = room.players.filter((p) => !p.isBot);
    const required = humanPlayers.length;
    const votes = humanPlayers.filter((p) => room.rematchVotes.has(p.id)).length;

    io.to(roomCode).emit("rematchUpdate", { votes, required });

    if (votes >= required) {
      room.rematchVotes = new Set();
      startRoomGame(roomCode, room.handSize);
    }
  });

  socket.on("joinAsSpectator", ({ roomCode } = {}) => {
    const code = (roomCode || "").trim().toUpperCase();
    const room = rooms[code];
    if (!room) {
      sendError(socket, "Room not found.");
      return;
    }

    if (!room.spectators) room.spectators = new Set();
    room.spectators.add(socket.id);
    socket.join(code);
    socket.emit("spectatorJoined", code);
    socket.emit("lobbyUpdated", getSafeRoom(code));
    if (room.started) {
      socket.emit("updateGame", getSafeRoom(code));
    }
  });

  socket.on("leaveRoom", () => {
    const roomCode = Object.keys(rooms).find((code) =>
      rooms[code].players.some((p) => p.id === socket.id) ||
      (rooms[code].spectators && rooms[code].spectators.has(socket.id))
    );
    if (roomCode) socket.leave(roomCode);
    removePlayerFromRoom(socket.id);
    removeSpectator(socket.id);
    socket.emit("leftRoom");
  });

  socket.on("resolveDeckDecision", ({ roomCode, action }) => {
    const room = rooms[roomCode];
    if (!room || !room.deckDecision) {
      return;
    }

    if (room.hostId !== socket.id) {
      sendError(socket, "Only the host can decide what happens when the deck is empty.");
      return;
    }

    resolveDeckDecision(roomCode, action);
  });
});

// Idle-room garbage collector — sweeps rooms that have had no activity for a while.
// Active rooms are touched on every meaningful event via emitGameState/emitLobby.
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach((code) => {
    const room = rooms[code];
    if (!room) return;

    const last = room.lastActivityAt || 0;
    const idle = now - last > ROOM_IDLE_LIMIT_MS;
    const onlyBots = room.players.length > 0 && room.players.every((p) => p.isBot);
    const everyoneDropped =
      room.players.length > 0 && room.players.every((p) => p.isBot || p.disconnected);

    if (idle || onlyBots || everyoneDropped) {
      stopBotTurn(room);
      stopTurnTimer(room);
      room.players.forEach((p) => {
        if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
      });
      delete rooms[code];
    }
  });
}, ROOM_GC_INTERVAL_MS).unref?.();

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
