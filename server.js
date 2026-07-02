const express = require("express");
const crypto = require("crypto");
const { createServer } = require("http");
const { Server } = require("socket.io");
const dbApi = require("./db");

const app = express();
// Behind Render/Fly's single TLS-terminating proxy — trust one X-Forwarded-*
// hop so proxy-supplied headers (proto, for) are honored by Express logic.
app.set("trust proxy", 1);
const httpServer = createServer(app);
const io = new Server(httpServer, {
  // Cap per-message payload size (default 1e6) to limit per-connection memory.
  maxHttpBufferSize: 1e5,
  cors: { origin: allowOrigin, methods: ["GET", "POST"] }
});

app.use(setSecurityHeaders);
app.use(express.static("public"));

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const TURN_DURATION_MS = 20000;
const LAST_CARD_BONUS_MS = 60000; // Once per UNO call, the NEXT player gets 60s to plan a counter.
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;
const DEFAULT_HAND_SIZE = 7;
// Reconnect grace: how long a dropped player keeps their seat before being removed.
const RECONNECT_GRACE_MS  = 30 * 1000;
// Lobby drop is more lenient: waiting players can refresh / change network freely.
const LOBBY_GRACE_MS      = 60 * 1000;
// Host reconnect reservation: if the host drops, the host role is held for them
// for this long before transferring to anyone else (configurable, ~2-5 min).
const HOST_RECONNECT_GRACE_MS = Number(process.env.HOST_RECONNECT_GRACE_MS) || 180000;
// Idle-room garbage collection interval and threshold.
const ROOM_GC_INTERVAL_MS = 5  * 60 * 1000;
const ROOM_IDLE_LIMIT_MS  = 60 * 60 * 1000;
// Fallback for the empty-deck decision: if the host never acts (AFK, left, or got
// converted to a bot), auto-resolve so the game can't freeze on the modal forever.
const DECK_DECISION_TIMEOUT_MS = process.env.DECK_DECISION_TIMEOUT_MS ? Number(process.env.DECK_DECISION_TIMEOUT_MS) : 30 * 1000;
const rooms = {};

// ---------------------------------------------------------------------------
// Security & abuse-limiting configuration (audit: L1 headers/CSP, M3 socket
// limits, M4 CORS, M1/M2 rate limiting, H5 room cap).
// ---------------------------------------------------------------------------
const DEPLOY_ORIGIN = (process.env.DEPLOY_ORIGIN || "https://last-card-battle.onrender.com").replace(/\/+$/, "");
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
// Origins allowed to open a Socket.IO connection / load the app.
const ORIGIN_ALLOWLIST = new Set([
  DEPLOY_ORIGIN,
  "https://localhost",        // Capacitor bundled content (androidScheme: https)
  "http://localhost",
  "http://localhost:3000",    // local dev
  "http://127.0.0.1:3000",
  "capacitor://localhost",    // legacy Capacitor scheme
  ...EXTRA_ORIGINS
]);
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 250;
// High default on purpose: mobile carriers use CGNAT, so many real players can
// share one public IP. This is a backstop against blatant floods, not a tight
// per-user cap — tune via MAX_SOCKETS_PER_IP if needed.
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP) || 50;
// IP-independent hard backstop on total concurrent sockets, so connection
// exhaustion can't happen even if per-IP limits are evaded by rotating or
// spoofing addresses.
const MAX_TOTAL_SOCKETS = Number(process.env.MAX_TOTAL_SOCKETS) || 1000;
// Cap spectators per room: each one receives full game-state broadcasts every
// turn, so an unbounded audience on a public room amplifies outbound traffic.
const MAX_SPECTATORS = Number(process.env.MAX_SPECTATORS) || 20;
const CSP_DISABLED = process.env.CSP_DISABLED === "1";

// Client IP. Behind Render/Fly's TLS-terminating proxy the real client IP is
// the RIGHTMOST X-Forwarded-For hop (the proxy appends it; the client controls
// only the leftmost, which we must NOT trust — else spoofing XFF defeats every
// IP-based limit). Falls back to the raw peer when no XFF is present.
function ipOf(socket) {
  const h = (socket && socket.handshake) || {};
  const xff = h.headers && h.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return h.address || (socket && socket.conn && socket.conn.remoteAddress) || "unknown";
}

// Socket.IO CORS gate: allow listed origins; non-browser clients (no Origin)
// are accepted (server-side tooling/tests). Browsers always send Origin.
function allowOrigin(origin, cb) {
  if (!origin) return cb(null, true);
  cb(null, ORIGIN_ALLOWLIST.has(origin));
}

// Security headers + CSP. script-src/style-src keep 'unsafe-inline' because
// index.html uses inline onclick handlers (a strict CSP would break the UI) —
// but connect-src is pinned to known origins, so any injected script still
// can't exfiltrate the device id / session token to an attacker's domain.
// Set CSP_DISABLED=1 to drop the CSP header only (other headers stay).
function setSecurityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  if (req.secure || String(req.headers["x-forwarded-proto"] || "").includes("https")) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000");
  }
  if (!CSP_DISABLED) {
    const host = DEPLOY_ORIGIN.replace(/^https?:\/\//, "");
    res.setHeader("Content-Security-Policy", [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https://api.dicebear.com",
      "media-src 'self' data: blob:",
      `connect-src 'self' ${DEPLOY_ORIGIN} wss://${host} ws://localhost:3000 ws://127.0.0.1:3000`,
      "frame-ancestors 'none'"
    ].join("; "));
  }
  next();
}

// Fixed-window, per-(ip+action) rate limiter.
function makeRateLimiter() {
  const buckets = new Map();
  return function allow(socket, action, max, windowMs) {
    const now = Date.now();
    const key = `${ipOf(socket)}|${action}`;
    let b = buckets.get(key);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (buckets.size > 8000) {          // lazy sweep so the map can't grow forever
      for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
      // Hard ceiling: if still too large (e.g. a flood of distinct in-window
      // keys), drop the oldest buckets outright so memory stays bounded.
      if (buckets.size > 16000) {
        const oldest = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
        for (let i = 0; i < 4000 && i < oldest.length; i++) buckets.delete(oldest[i][0]);
      }
    }
    return b.count <= max;
  };
}
const rateAllow = makeRateLimiter();
function rateLimited(socket, action, max, windowMs) {
  if (!rateAllow(socket, action, max, windowMs)) {
    sendError(socket, "Too many requests — please slow down.");
    return true;
  }
  return false;
}

// Per-IP live-socket counter for the connection-flood cap.
const socketsByIp = new Map();

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
    avatar: (socket.data && socket.data.avatar) || "big-smile",
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

// Unambiguous alphabet — drops 0/O, 1/I, 2/Z, 5/S so shared codes can't be mistyped.
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateRoomCode() {
  let roomCode = "";

  do {
    roomCode = "";
    for (let i = 0; i < 5; i += 1) {
      roomCode += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
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
      disconnected: !!player.disconnected,
      avatar: player.avatar || "big-smile"
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
    visibility: room.visibility || "private",
    spectatorCount: room.spectators ? room.spectators.size : 0,
    turnEndsAt: room.turnEndsAt || null,
    turnDuration: room.currentTurnDuration || TURN_DURATION_MS,
    awaitingDeckDecision: Boolean(room.deckDecision),
    canShuffleDeck: room.discard.length > 1,
    deckCount: room.deck ? room.deck.length : 0
  };
}

// Public projection of current spectators (names only — socket ids stay
// server-side so they are never leaked to clients).
function spectatorList(room) {
  if (!room.spectators || !room.spectators.size) return [];
  return [...room.spectators.values()].map((name) => ({ name }));
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

  // Bonus time applies to the first turn that isn't the player who just called UNO,
  // so the threatened opponents get a real chance to plan and chat a counter.
  const currentPlayer = room.players[room.turn];
  let duration = TURN_DURATION_MS;
  if (room.unoTurnBonus && currentPlayer && currentPlayer.id !== room.unoCallerId) {
    duration = LAST_CARD_BONUS_MS;
    room.unoTurnBonus = false;
    room.unoCallerId = null;
  }
  room.currentTurnDuration = duration;
  room.turnEndsAt = Date.now() + duration;

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
  }, duration);
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

async function finishGame(roomCode, winner) {
  const room = rooms[roomCode];
  if (!room) {
    return;
  }

  const winnerId = winner && winner.id ? winner.id : null;
  const winnerName = winner && winner.name ? winner.name : String(winner || "No winner");

  room.started = false;
  room.rematchVotes = new Set();
  stopBotTurn(room);
  stopTurnTimer(room);

  // Persist stats for every authenticated human player in this game.
  // Await the DB write so any leaderboard/stats request triggered by
  // the gameOver event sees the new counts (no stale "stuck" trophies).
  try {
    const outcomes = [];
    for (const p of room.players) {
      // Pure bot seats are never recorded. A human who disconnected and was
      // temp-converted to an AI seat (wasHuman) still played — credit them.
      if (p.isBot && !p.wasHuman) continue;
      // userId normally lives on the seat. But if the seat was created before
      // loginDevice finished (e.g. joining via an invite link right after app
      // open), the seat-level back-fill can lag the record — so also read it
      // from the still-connected socket. Without this the result is silently
      // dropped, which is why a session's first match sometimes fails to count.
      const sock = io.sockets.sockets.get(p.id);
      const uid = p.userId || (sock && sock.data && sock.data.userId) || null;
      if (!uid) {
        console.warn(
          `[stats] dropped unattributed result: room=${roomCode} name="${p.name}" ` +
          `seatUserId=${p.userId != null ? p.userId : null} ` +
          `socketLoggedIn=${!!(sock && sock.data && sock.data.userId)} ` +
          `wasHuman=${!!p.wasHuman} disconnected=${!!p.disconnected}`
        );
        continue;
      }
      outcomes.push({
        userId: uid,
        won: winnerId ? p.id === winnerId : p.name === winnerName,
        mode: "human",
        cardsPlayed: p.cardsPlayed || 0
      });
    }
    if (outcomes.length > 0) {
      await dbApi.recordGameResult(outcomes);
    }
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
  room.unoCallerId = null;
  room.unoTurnBonus = false;
  room.deck = createUnoDeck();
  room.discard = [];

  room.players.forEach((player) => {
    player.cards = [];
    player.calledUNO = false;
    player.cardsPlayed = 0;
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

  if (player.cards.length === 1 && room.players.length >= 3) {
    // Whoever drops to 1 card is now the threat — give the next player a 60s
    // planning window so opponents can coordinate a counter. Skipped in 2-player
    // games since there's no one else to discuss strategy with.
    room.unoCallerId = player.id;
    room.unoTurnBonus = true;
  }

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

  const shouldSkip =
    playedCard.value === "skip" ||
    (playedCard.value === "reverse" && room.players.length === 2);
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

// Auto-resolve a pending deck decision using the non-destructive default:
// reshuffle and keep playing when possible, otherwise declare the leader winner.
function autoResolveDeckDecision(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.deckDecision) {
    return;
  }
  resolveDeckDecision(roomCode, room.discard.length > 1 ? "shuffle" : "declareWinner");
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

  // Safety net: if the host never decides (AFK, left, or converted to a bot),
  // auto-resolve so the match can't freeze on this modal forever.
  if (room.deckDecisionTimer) clearTimeout(room.deckDecisionTimer);
  room.deckDecisionTimer = setTimeout(() => {
    autoResolveDeckDecision(roomCode);
  }, DECK_DECISION_TIMEOUT_MS);

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

  if (room.deckDecisionTimer) {
    clearTimeout(room.deckDecisionTimer);
    room.deckDecisionTimer = null;
  }

  if (action === "declareWinner") {
    const leader = getLeadingPlayer(room);
    finishGame(roomCode, leader || "No winner");
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
      io.to(code).emit("spectators", spectatorList(room));
    }
  });
}

function assignHostIfNeeded(roomCode, previousHostId) {
  const room = rooms[roomCode];
  if (!room) return;
  if (room.hostId !== previousHostId) {
    return;
  }

  const newHost =
    room.players.find((p) => !p.isBot && !p.disconnected) ||
    room.players.find((p) => !p.isBot) ||
    room.players[0];

  if (!newHost) {
    return;
  }

  room.hostId = newHost.id;
  // During an active host reservation the creator may still reclaim, so the
  // promoted player is only a deputy (acting host) — keep hostToken on the
  // creator. Once the reservation has lapsed this is a permanent transfer.
  if (!room.hostReservedUntil || Date.now() > room.hostReservedUntil) {
    room.hostToken = newHost.token;
    room.hostReservedUntil = 0;
  }
  if (!newHost.isBot) {
    io.to(roomCode).emit("hostChanged", {
      hostId: newHost.id,
      name: newHost.name,
      playerName: newHost.name
    });
  }

  // If an empty-deck decision is pending and the new host can't make it (a bot or
  // a disconnected seat), auto-resolve so the game doesn't freeze on the modal.
  if (room.deckDecision && (newHost.isBot || newHost.disconnected)) {
    autoResolveDeckDecision(roomCode);
  }
}

function attachUserIdToActiveSeats(socket, userId) {
  if (!socket || !socket.id || !userId) {
    return;
  }

  Object.keys(rooms).forEach((code) => {
    const room = rooms[code];
    if (!room) {
      return;
    }

    const player = room.players.find((p) => p.id === socket.id && !p.isBot);
    if (!player || player.userId === userId) {
      return;
    }

    player.userId = userId;
  });
}

// Re-evaluate a pending rematch after membership changes (a vote, a leave, or a
// disconnect): start the game if the remaining connected humans have all voted,
// or expire it if too few humans remain to play. Idempotent (clears votes first).
function recheckRematch(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.started || !room.rematchVotes || room.rematchVotes.size === 0) {
    return;
  }
  const humans = room.players.filter((p) => !p.isBot && !p.disconnected);
  const votes = humans.filter((p) => room.rematchVotes.has(p.token)).length;
  if (humans.length < MIN_PLAYERS) {
    room.rematchVotes = new Set();
    io.to(roomCode).emit("rematchUpdate", { votes: 0, required: humans.length, expired: true });
  } else if (votes >= humans.length) {
    room.rematchVotes = new Set();
    startRoomGame(roomCode, room.handSize);
  } else {
    io.to(roomCode).emit("rematchUpdate", { votes, required: humans.length });
  }
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

  // The creator's seat is gone (intentional leave or reservation lapse) — release
  // the reservation and make the acting host (deputy) the permanent host.
  if (removed && room.hostToken === removed.token) {
    room.hostReservedUntil = 0;
    const actingHost = room.players.find((p) => p.id === room.hostId);
    if (actingHost) room.hostToken = actingHost.token;
  }

  if (room.players.length === 0 || room.players.every((player) => player.isBot)) {
    stopBotTurn(room);
    stopTurnTimer(room);
    delete rooms[roomCode];
    return;
  }

  assignHostIfNeeded(roomCode, socketId);

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
    recheckRematch(roomCode);
  }
}

io.on("connection", (socket) => {
  // Global connection backstop (IP-independent): bounds total memory/fd use
  // even if per-IP limits are evaded by rotating or spoofing addresses.
  if (io.engine.clientsCount > MAX_TOTAL_SOCKETS) {
    socket.disconnect(true);
    return;
  }
  // Per-IP concurrent-connection cap (DoS backstop). See MAX_SOCKETS_PER_IP.
  const connIp = ipOf(socket);
  const connIpCount = (socketsByIp.get(connIp) || 0) + 1;
  if (connIpCount > MAX_SOCKETS_PER_IP) {
    socket.disconnect(true);
    return;
  }
  socketsByIp.set(connIp, connIpCount);
  socket.on("disconnect", () => {
    const c = socketsByIp.get(connIp);
    if (c === undefined) return;
    if (c <= 1) socketsByIp.delete(connIp); else socketsByIp.set(connIp, c - 1);
  });

  // ----- Anonymous device login -----
  // Establishes a stable userId for this socket; required for stats persistence.
  socket.on("loginDevice", async ({ deviceId, name, deviceLabel } = {}) => {
    if (rateLimited(socket, "login", 6, 60000)) return;
    if (!dbApi.isValidDeviceId(deviceId)) {
      socket.emit("loginError", "invalid_device_id");
      return;
    }
    try {
      const { user, stats, created } = await dbApi.loginDevice(deviceId, name);
      const devShort = String(deviceId).slice(0, 8);
      const label = (typeof deviceLabel === "string" ? deviceLabel : "").slice(0, 60) || "unknown";
      console.log(`[auth] user ${user.id} name="${user.name}" device=${devShort}… label="${label}" created=${created}`);
      // If the client supplied a name and this is an existing account whose name
      // doesn't match, update it (lets users change their name from the menu).
      let final = user;
      if (!created && typeof name === "string") {
        const cleaned = dbApi.sanitizeName(name, user.name);
        if (cleaned !== user.name) {
          final = (await dbApi.updateProfile(user.id, { name: cleaned })) || user;
        }
      }
      socket.data.userId = final.id;
      socket.data.avatar = final.avatar;
      attachUserIdToActiveSeats(socket, final.id);
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

  socket.on("updateProfile", async ({ name, avatar } = {}) => {
    if (rateLimited(socket, "profile", 10, 60000)) return;
    const userId = socket.data && socket.data.userId;
    if (!userId) {
      socket.emit("loginError", "not_logged_in");
      return;
    }
    const user = await dbApi.updateProfile(userId, { name, avatar });
    if (!user) {
      socket.emit("loginError", "user_not_found");
      return;
    }
    // Reflect the new name in any active room the user happens to be in.
    Object.keys(rooms).forEach((code) => {
      const player = rooms[code].players.find((p) => p.userId === userId);
      if (!player) return;
      player.name = user.name;
      player.avatar = user.avatar;
      if (rooms[code].started) emitGameState(code); else emitLobby(code);
    });
    socket.emit("profileUpdated", {
      userId: user.id,
      name: user.name,
      avatar: user.avatar
    });
  });

  socket.on("requestStats", async () => {
    if (rateLimited(socket, "stats", 20, 60000)) return;
    const userId = socket.data && socket.data.userId;
    if (!userId) return;
    try {
      const stats = await dbApi.getStats(userId);
      socket.emit("stats", stats);
    } catch (err) {
      console.error("[stats] requestStats:", err);
    }
  });

  // Persist a single offline-bot game result for the authenticated user.
  // Bot games run client-side, so the server never sees finishGame() for them —
  // the client posts the result here so leaderboard/stats stay accurate.
  socket.on("recordBotResult", async ({ won, cardsPlayed } = {}) => {
    if (rateLimited(socket, "botResult", 10, 60000)) return;
    const userId = socket.data && socket.data.userId;
    if (!userId) return;
    try {
      await dbApi.recordGameResult([{
        userId,
        won: !!won,
        mode: "bot",
        cardsPlayed: Math.max(0, Math.min(200, Number(cardsPlayed) || 0))
      }]);
      // Push fresh stats AND leaderboard so the winner modal updates without
      // racing a separate requestLeaderboard call.
      const [stats, rows] = await Promise.all([
        dbApi.getStats(userId),
        dbApi.getLeaderboard(20)
      ]);
      socket.emit("stats", stats);
      socket.emit("leaderboard", { rows, myUserId: userId });
    } catch (err) {
      console.error("[stats] recordBotResult:", err);
    }
  });

  socket.on("requestLeaderboard", async ({ limit } = {}) => {
    if (rateLimited(socket, "leaderboard", 12, 60000)) return;
    try {
      const rows = await dbApi.getLeaderboard(limit);
      socket.emit("leaderboard", { rows, myUserId: socket.data?.userId || null });
    } catch (err) {
      console.error("[leaderboard] failed:", err);
      socket.emit("leaderboard", { rows: [], myUserId: null, error: "server_error" });
    }
  });

  socket.on("listPublicRooms", () => {
    if (rateLimited(socket, "listRooms", 20, 60000)) return;
    const rows = Object.keys(rooms)
      .filter((code) => !rooms[code].soloMode && rooms[code].players.some((p) => !p.isBot)) // never list bot/solo or all-bot rooms
      .map((code) => {
        const r = rooms[code];
        if (r.visibility === "public") {
          const host = r.players.find((p) => p.id === r.hostId);
          return {
            roomCode: code,
            hostName: host ? host.name : "Host",
            playerCount: r.players.length,
            started: !!r.started,
            spectatorCount: r.spectators ? r.spectators.size : 0
          };
        }
        // Private room: opaque card — no code, players, or count.
        return { private: true, started: !!r.started };
      });
    socket.emit("publicRooms", rows);
  });

  socket.on("createRoom", (playerName) => {
    if (rateLimited(socket, "createRoom", 10, 60000)) return;
    if (Object.keys(rooms).length >= MAX_ROOMS) {
      sendError(socket, "Server is full — please try again in a moment.");
      return;
    }
    const roomCode = generateRoomCode();
    const player = createPlayer(socket, playerName);

    rooms[roomCode] = {
      hostId: socket.id,
      hostToken: player.token,        // permanent host identity (stable across reconnects)
      hostReservedUntil: 0,           // 0 = no active host-reconnect reservation
      players: [player],
      started: false,
      handSize: DEFAULT_HAND_SIZE,
      soloMode: false,
      visibility: "private",
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
    if (rateLimited(socket, "joinRoom", 20, 60000)) return;
    const normalizedCode = (roomCode || "").trim().toUpperCase();
    const room = rooms[normalizedCode];

    if (!room) {
      sendError(socket, "Room not found.");
      return;
    }

    // If the game is in progress, check if this player has a disconnected or
    // AI-converted seat they can reclaim — if so, offer both rejoin & spectate.
    if (room.started) {
      const joiningUserId = (socket.data && socket.data.userId) || null;
      // Offer rejoin only to the seat's authenticated owner (userId match), never
      // by display name — names are public and name-matching enabled seat hijack.
      const reclaimable = room.players.find((p) =>
        (p.disconnected || (p.isBot && p.wasHuman)) &&
        joiningUserId && p.userId === joiningUserId
      );

      if (reclaimable) {
        // Offer the player a choice: rejoin their seat OR spectate.
        socket.emit("reconnectOffered", { roomCode: normalizedCode, canRejoin: true });
        return;
      }

      // No seat to reclaim. Private rooms reject; public rooms may spectate.
      if (room.visibility === "private") {
        sendError(socket, "This room is private.");
        return;
      }
      socket.emit("reconnectOffered", { roomCode: normalizedCode, canRejoin: false });
      return;
    }

    if (room.players.length >= MAX_PLAYERS) {
      if (room.visibility === "private") {
        sendError(socket, "Room is full.");
        return;
      }
      socket.emit("spectateOffered", { roomCode: normalizedCode, reason: "full" });
      return;
    }

    const player = createPlayer(socket, playerName);
    // If they were spectating (e.g. declined a rematch), drop the spectator entry
    // so they're not double-counted as both player and spectator.
    if (room.spectators) room.spectators.delete(socket.id);
    room.players.push(player);
    touchRoom(room);
    socket.join(normalizedCode);
    socket.emit("session", { token: player.token, roomCode: normalizedCode });
    socket.emit("joinedRoom", normalizedCode);
    // NOTE: joining never transfers host. A disconnected host is reserved (not
    // gone), and a truly-gone host is promoted via removePlayerFromRoom/timeout.
    emitLobby(normalizedCode);
  });

  socket.on("startBotMatch", (payload) => {
    if (rateLimited(socket, "startBot", 10, 60000)) return;
    if (Object.keys(rooms).length >= MAX_ROOMS) {
      sendError(socket, "Server is full — please try again in a moment.");
      return;
    }
    const playerName = typeof payload === "string" ? payload : payload?.name;
    const difficulty = (typeof payload === "object" && payload?.difficulty) || "normal";
    const roomCode = generateRoomCode();
    const humanPlayer = createPlayer(socket, playerName);

    rooms[roomCode] = {
      hostId: socket.id,
      hostToken: humanPlayer.token,
      hostReservedUntil: 0,
      players: [humanPlayer, createBotPlayer(roomCode, difficulty)],
      started: false,
      handSize: DEFAULT_HAND_SIZE,
      soloMode: true,
      visibility: "private",
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

  socket.on("setRoomVisibility", ({ roomCode, visibility } = {}) => {
    if (rateLimited(socket, "setVisibility", 20, 60000)) return;
    const code = (roomCode || "").trim().toUpperCase();
    const room = rooms[code];
    if (!room || room.started) return;      // no toggling mid-match
    if (room.hostId !== socket.id) return;   // host-only
    if (room.soloMode) return;               // bot rooms can never be public
    room.visibility = visibility === "public" ? "public" : "private";
    emitLobby(code);
  });

  socket.on("addLobbyBot", ({ roomCode } = {}) => {
    if (rateLimited(socket, "lobbyBot", 10, 60000)) return;
    const code = (roomCode || "").trim().toUpperCase();
    const room = rooms[code];
    if (!room || room.started || room.soloMode) return;
    if (room.hostId !== socket.id) return;
    if (room.players.length >= MAX_PLAYERS) return;
    if (room.players.some((p) => p.isBot)) return;
    room.players.push(createBotPlayer(code, "hard"));
    emitLobby(code);
  });

  socket.on("removeLobbyBot", ({ roomCode } = {}) => {
    if (rateLimited(socket, "lobbyBot", 10, 60000)) return;
    const code = (roomCode || "").trim().toUpperCase();
    const room = rooms[code];
    if (!room || room.started) return;
    if (room.hostId !== socket.id) return;
    const botIdx = room.players.findIndex((p) => p.isBot);
    if (botIdx === -1) return;
    room.players.splice(botIdx, 1);
    emitLobby(code);
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
      // Manual UNO press only marks the call (avoids penalty). The 60s bonus
      // for the next player was already armed by applyCardPlay when the card
      // count dropped to 1; do NOT re-arm it here or it would fire a turn late.
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
    // Cannot finish the game with a power card, even if the card would also
    // be illegal against the current top card. This penalty takes precedence:
    // draw 10 penalty cards AND lose the turn.
    if (player.cards.length === 1 && isPowerCard(card)) {
      emitInvalidMove(socket, "You cannot finish with a power card. Draw 10 penalty cards.");
      const drawResult = drawCards(room, player, 10);

      if (drawResult.drawnCount > 0) {
        io.to(player.id).emit("penalty");
      }

      if (drawResult.needsDeckDecision) {
        requestDeckDecision(roomCode, {
          playerId: player.id,
          remainingDraws: drawResult.remainingCount,
          advanceSteps: 1,
          clearStackOnResume: false,
          showPenalty: false
        });
        return;
      }

      advanceToNextTurn(roomCode);
      return;
    }

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
        // Advance turn after the deck-reshuffle decision resolves so the
        // misplaying player cannot keep trying cards until one is playable.
        requestDeckDecision(roomCode, {
          playerId: player.id,
          remainingDraws: drawResult.remainingCount,
          advanceSteps: 1,
          clearStackOnResume: false,
          showPenalty: false
        });
        return;
      }

      // Penalty for an illegal play: take the draw AND lose the turn.
      advanceToNextTurn(roomCode);
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

      // Arm the last-card bonus: the NEXT player gets 60s to plan a counter.
      // Mirrors the same logic in applyCardPlay() used by the bot turn path.
      if (room.players.length >= 3) {
        room.unoCallerId = player.id;
        room.unoTurnBonus = true;
      }

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
      finishGame(roomCode, player);
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

    const shouldSkip =
      playedCard.value === "skip" ||
      (playedCard.value === "reverse" && room.players.length === 2);
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

    const isHostDrop = room.hostId === player.id;
    // If the host drops, reserve the ROLE (reclaimable via token on reconnect)
    // but still promote a deputy immediately so the room stays usable.
    if (isHostDrop) {
      room.hostReservedUntil = Date.now() + (room.started ? HOST_RECONNECT_GRACE_MS : LOBBY_GRACE_MS);
    }
    // Promote a deputy/acting host right away (no-op for a non-host drop). The
    // host's SEAT uses the normal grace below (becomes a bot/is removed at the
    // same pace as anyone else's) — the role reservation is decoupled (F2).
    assignHostIfNeeded(code, player.id);
    if (!room.started) {
      // A disconnecting player may unblock (or expire) a pending rematch (R2).
      recheckRematch(code);
    }

    const grace = room.started ? RECONNECT_GRACE_MS : LOBBY_GRACE_MS;
    const lostTokenId = player.token; // capture before any reassignment
    player.disconnectTimer = setTimeout(() => {
      const r = rooms[code];
      if (!r) return;
      // If they reconnected meanwhile, the timer was cleared. Defensive recheck:
      const stillThere = r.players.find((p) => p.token === lostTokenId);
      if (!stillThere || !stillThere.disconnected) return;

      // In-progress game: convert the dropped seat to an AI bot so the match
      // continues smoothly. The original player can still reclaim the seat
      // by resuming with their session token (see `resumeSession`).
      if (r.started) {
        stillThere.isBot = true;
        stillThere.wasHuman = true;
        stillThere.difficulty = stillThere.difficulty || "normal";
        stillThere.disconnected = false;
        stillThere.disconnectTimer = null;
        stillThere.originalName = stillThere.originalName || stillThere.name;
        stillThere.name = `${stillThere.originalName} (AI)`;

        io.to(code).emit("playerReplacedByAI", {
          playerName: stillThere.originalName,
          name: stillThere.originalName
        });

        // The deputy was promoted at disconnect-time; the host ROLE stays reserved
        // for HOST_RECONNECT_GRACE_MS (independent of this 30s seat grace), so the
        // creator can still reclaim. No promotion or reservation-clear needed here.

        // If it's currently this player's turn, drop the auto-draw turn timer
        // and let the bot scheduler take over.
        if (r.players[r.turn] && r.players[r.turn].token === lostTokenId) {
          stopTurnTimer(r);
          queueBotTurnIfNeeded(code);
        }
        emitGameState(code);
        return;
      }

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

    // If the grace window already expired and the seat was converted to an AI
    // bot, hand control back to the returning human player.
    if (player.isBot && player.wasHuman) {
      const wasBotsTurn =
        room.players[room.turn] && room.players[room.turn].token === token;
      player.isBot = false;
      if (player.originalName) {
        player.name = player.originalName;
      }
      if (wasBotsTurn) {
        stopBotTurn(room);
        scheduleTurn(code);
      }
      io.to(code).emit("playerReclaimedSeat", {
        playerName: player.name,
        name: player.name
      });
    }

    // Restore host to the creator on reconnect if this is their seat and they're
    // within the reservation window (works in lobby AND in-game), or if their seat
    // is still the nominal host. Repoint hostId to the new socket id either way.
    const wasHost = room.hostId === player.id;
    const isReservedHost = token === room.hostToken &&
      room.hostReservedUntil && Date.now() <= room.hostReservedUntil;
    player.id = socket.id;
    if ((wasHost || isReservedHost) && room.hostId !== socket.id) {
      room.hostId = socket.id;
      room.hostReservedUntil = 0;
      io.to(code).emit("hostChanged", {
        hostId: socket.id,
        name: player.name,
        playerName: player.name
      });
    }
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

  // Whitelisted preset messages — clients send an index; server picks the payload.
  // Using an index (not free text) keeps the chat safe from abuse/flooding.
  // Entries with `color` render as a colored swatch bubble on the client.
  const QUICK_MESSAGES = [
    { text: "Play red!",         color: "red" },
    { text: "Play yellow!",      color: "yellow" },
    { text: "Play green!",       color: "green" },
    { text: "Play blue!",        color: "blue" },
    { text: "Play +2 red!",      color: "red" },
    { text: "Play +2 yellow!",   color: "yellow" },
    { text: "Play +2 green!",    color: "green" },
    { text: "Play +2 blue!",     color: "blue" },
    { text: "Play wild red!",    color: "red" },
    { text: "Play wild yellow!", color: "yellow" },
    { text: "Play wild green!",  color: "green" },
    { text: "Play wild blue!",   color: "blue" },
    { text: "Play reverse red!",    color: "red" },
    { text: "Play reverse yellow!", color: "yellow" },
    { text: "Play reverse green!",  color: "green" },
    { text: "Play reverse blue!",   color: "blue" },
    { text: "I have 🎨" },
    { text: "I have 🔄" },
    { text: "I have +2" },
    { text: "I have +4" },
    { text: "No match!" },
    { text: "Keep it going!" },
    { text: "Got a match?" },
    { text: "Play Fast!" }
  ];

  socket.on("sendQuickMsg", (index) => {
    const now = Date.now();
    if (now - lastReactionAt < 600) return;
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= QUICK_MESSAGES.length) return;
    lastReactionAt = now;
    const roomCode = Array.from(socket.rooms).find(
      (r) => r !== socket.id && rooms[r]
    );
    if (!roomCode) return;
    io.to(roomCode).emit("quickMsg", {
      playerId: socket.id,
      ...QUICK_MESSAGES[i]
    });
  });

  socket.on("sendReaction", (emoji) => {
    const now = Date.now();
    if (now - lastReactionAt < 600) return;
    lastReactionAt = now;

    const allowed = ["❤️", "🧠", "😂", "😘", "😱", "😭"];
    if (typeof emoji !== "string" || !allowed.includes(emoji)) return;
    const roomCode = Object.keys(rooms).find((code) =>
      rooms[code].players.some((p) => p.id === socket.id) ||
      (rooms[code].spectators && rooms[code].spectators.has(socket.id))
    );
    if (!roomCode) return;

    io.to(roomCode).emit("reaction", { playerId: socket.id, emoji });
  });

  // Free-text chat: max 30 chars (post-trim), single line, Unicode-safe (Bangla/English).
  // Per-socket cooldown prevents spam. Broadcast to everyone in the room.
  let lastChatAt = 0;
  socket.on("chatMessage", (raw) => {
    const now = Date.now();
    if (now - lastChatAt < 1000) return;
    if (typeof raw !== "string") return;
    let text = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return;
    // Cap to 30 *code points* so multi-byte Bangla characters aren't sliced mid-codepoint.
    const cps = Array.from(text);
    if (cps.length > 30) text = cps.slice(0, 30).join("");
    lastChatAt = now;

    const roomCode = Object.keys(rooms).find((code) =>
      rooms[code].players.some((p) => p.id === socket.id) ||
      (rooms[code].spectators && rooms[code].spectators.has(socket.id))
    );
    if (!roomCode) return;

    io.to(roomCode).emit("chatMessage", { playerId: socket.id, text });
  });

  socket.on("requestRematch", () => {
    const roomCode = Object.keys(rooms).find((code) =>
      rooms[code].players.some((p) => p.id === socket.id)
    );
    if (!roomCode) return;
    const room = rooms[roomCode];
    if (room.started) return;

    const voter = room.players.find((p) => p.id === socket.id);
    if (!voter) return;

    if (!room.rematchVotes) room.rematchVotes = new Set();
    // Key votes by the stable session token, not socket.id — socket.id changes on
    // reconnect, which would otherwise orphan an already-cast vote (R1).
    room.rematchVotes.add(voter.token);

    const humanPlayers = room.players.filter((p) => !p.isBot && !p.disconnected);
    const required = humanPlayers.length;
    const votes = humanPlayers.filter((p) => room.rematchVotes.has(p.token)).length;

    io.to(roomCode).emit("rematchUpdate", { votes, required });

    if (votes >= required && humanPlayers.length >= MIN_PLAYERS) {
      room.rematchVotes = new Set();
      startRoomGame(roomCode, room.handSize);
    }
  });

  socket.on("joinAsSpectator", ({ roomCode, spectatorName } = {}) => {
    if (rateLimited(socket, "spectate", 20, 60000)) return;
    const code = (roomCode || "").trim().toUpperCase();
    const room = rooms[code];
    if (!room) {
      sendError(socket, "Room not found.");
      return;
    }
    // Private rooms cannot be spectated — even with the code. Mask as "not found"
    // so a code-guesser can't confirm a private room exists via this path.
    if (room.visibility === "private") {
      sendError(socket, "Room not found.");
      return;
    }
    // Cap the audience: each spectator receives full game-state broadcasts.
    const curCount = room.spectators ? room.spectators.size : 0;
    if (curCount >= MAX_SPECTATORS) {
      sendError(socket, "Spectator limit reached for this room.");
      return;
    }

    const safeName = dbApi.sanitizeName(
      spectatorName,
      `Spectator${Math.floor(Math.random() * 9000) + 1000}`
    );
    if (!room.spectators) room.spectators = new Map();
    room.spectators.set(socket.id, safeName);
    socket.join(code);
    socket.emit("spectatorJoined", code);
    if (room.started) {
      socket.emit("updateGame", getSafeRoom(code));
    }
    // Broadcast the updated count + name list to everyone in the room
    // (emitLobby also delivers lobbyUpdated to the joiner, who is now in the room).
    emitLobby(code);
    io.to(code).emit("spectators", spectatorList(room));
  });

  socket.on("reclaimSeat", ({ roomCode } = {}) => {
    const code = (roomCode || "").trim().toUpperCase();
    const room = rooms[code];
    if (!room || !room.started) {
      sendError(socket, "Room not found or game not in progress.");
      return;
    }

    const joiningUserId = (socket.data && socket.data.userId) || null;
    // Authorize reclaim only by the seat's authenticated userId — never by
    // display name. Names are public (broadcast to the whole room), so matching
    // on them let any peer steal a disconnected player's seat, hand, turn, and
    // host status. Anonymous sockets (no loginDevice) have no userId and cannot
    // reclaim here; they reconnect via resumeSession (token) instead.
    const reclaimable = room.players.find((p) =>
      (p.disconnected || (p.isBot && p.wasHuman)) &&
      joiningUserId && p.userId === joiningUserId
    );

    if (!reclaimable) {
      sendError(socket, "No reclaimable seat found. Join as spectator instead.");
      return;
    }

    // Clear any grace timer still running.
    if (reclaimable.disconnectTimer) {
      clearTimeout(reclaimable.disconnectTimer);
      reclaimable.disconnectTimer = null;
    }

    // If the seat was converted to AI, revert it back to human.
    if (reclaimable.isBot && reclaimable.wasHuman) {
      const wasBotsTurn =
        room.players[room.turn] && room.players[room.turn].token === reclaimable.token;
      reclaimable.isBot = false;
      delete reclaimable.wasHuman;
      if (reclaimable.originalName) {
        reclaimable.name = reclaimable.originalName;
        delete reclaimable.originalName;
      }
      if (wasBotsTurn) {
        stopBotTurn(room);
        scheduleTurn(code);
      }
    }

    // Notify the room that the player has reclaimed their seat.
    io.to(code).emit("playerReclaimedSeat", {
      playerName: reclaimable.name,
      name: reclaimable.name
    });

    // Re-point the seat to the new socket, restoring host if this is the reserved
    // creator reconnecting (lobby or in-game) or the nominal host reclaiming.
    const wasHost = room.hostId === reclaimable.id;
    const isReservedHost = reclaimable.token === room.hostToken &&
      room.hostReservedUntil && Date.now() <= room.hostReservedUntil;
    reclaimable.id = socket.id;
    if ((wasHost || isReservedHost) && room.hostId !== socket.id) {
      room.hostId = socket.id;
      room.hostReservedUntil = 0;
      io.to(code).emit("hostChanged", {
        hostId: socket.id,
        name: reclaimable.name,
        playerName: reclaimable.name
      });
    }
    reclaimable.disconnected = false;
    if (reclaimable.userId) socket.data.userId = reclaimable.userId;

    socket.join(code);
    touchRoom(room);
    socket.emit("session", { token: reclaimable.token, roomCode: code });
    socket.emit("joinedRoom", code);

    // Replay game state so the client renders the in-game view.
    socket.emit("gameStarted");
    io.to(socket.id).emit("yourCards", reclaimable.cards);
    emitGameState(code);
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

    // Don't reap while the host role is reserved (the creator may still reconnect
    // and reclaim); the next sweep after the reservation lapses handles it.
    const hostReserved = room.hostReservedUntil && now <= room.hostReservedUntil;
    if (!hostReserved && (idle || onlyBots || everyoneDropped)) {
      stopBotTurn(room);
      stopTurnTimer(room);
      if (room.deckDecisionTimer) clearTimeout(room.deckDecisionTimer);
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
