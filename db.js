// Lightweight SQLite persistence for users + stats.
// Designed to be process-local; for multi-instance deployments swap in a managed DB later.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "lcb.sqlite");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    avatar      TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stats (
    user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    games_played   INTEGER NOT NULL DEFAULT 0,
    games_won      INTEGER NOT NULL DEFAULT 0,
    games_lost     INTEGER NOT NULL DEFAULT 0,
    cards_played   INTEGER NOT NULL DEFAULT 0,
    win_streak     INTEGER NOT NULL DEFAULT 0,
    best_streak    INTEGER NOT NULL DEFAULT 0,
    last_played_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_users_device_id ON users(device_id);
`);

// --- Validation helpers ---
const NAME_MAX_LEN = 20;
function sanitizeName(raw, fallback = "Player") {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim().slice(0, NAME_MAX_LEN);
  return s.length === 0 ? fallback : s;
}

function isValidDeviceId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

// --- Prepared statements ---
const stmtFindUserByDevice = db.prepare(`SELECT * FROM users WHERE device_id = ?`);
const stmtFindUserById     = db.prepare(`SELECT * FROM users WHERE id = ?`);
const stmtInsertUser       = db.prepare(`
  INSERT INTO users (id, device_id, name, avatar, created_at, updated_at)
  VALUES (@id, @device_id, @name, @avatar, @created_at, @updated_at)
`);
const stmtInsertStats      = db.prepare(`INSERT INTO stats (user_id) VALUES (?)`);
const stmtUpdateProfile    = db.prepare(`
  UPDATE users SET name = @name, avatar = @avatar, updated_at = @updated_at WHERE id = @id
`);
const stmtFindStats        = db.prepare(`SELECT * FROM stats WHERE user_id = ?`);
const stmtBumpWin = db.prepare(`
  UPDATE stats SET
    games_played = games_played + 1,
    games_won    = games_won + 1,
    cards_played = cards_played + @cards_played,
    win_streak   = win_streak + 1,
    best_streak  = MAX(best_streak, win_streak + 1),
    last_played_at = @now
  WHERE user_id = @user_id
`);
const stmtBumpLoss = db.prepare(`
  UPDATE stats SET
    games_played = games_played + 1,
    games_lost   = games_lost + 1,
    cards_played = cards_played + @cards_played,
    win_streak   = 0,
    last_played_at = @now
  WHERE user_id = @user_id
`);

// --- Public API ---

/**
 * Create a user for a device id, or return the existing one.
 * Always returns { user, stats }.
 */
function loginDevice(deviceId, requestedName) {
  if (!isValidDeviceId(deviceId)) {
    throw new Error("invalid_device_id");
  }
  const existing = stmtFindUserByDevice.get(deviceId);
  if (existing) {
    return { user: existing, stats: stmtFindStats.get(existing.id), created: false };
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const user = {
    id,
    device_id: deviceId,
    name: sanitizeName(requestedName),
    avatar: null,
    created_at: now,
    updated_at: now
  };

  const tx = db.transaction(() => {
    stmtInsertUser.run(user);
    stmtInsertStats.run(id);
  });
  tx();

  return { user, stats: stmtFindStats.get(id), created: true };
}

function getUser(userId) {
  return stmtFindUserById.get(userId) || null;
}

function getStats(userId) {
  return stmtFindStats.get(userId) || null;
}

function updateProfile(userId, { name, avatar } = {}) {
  const user = stmtFindUserById.get(userId);
  if (!user) return null;

  const next = {
    id: userId,
    name: typeof name === "string" ? sanitizeName(name, user.name) : user.name,
    avatar: typeof avatar === "string" ? avatar.slice(0, 64) : user.avatar,
    updated_at: Date.now()
  };
  stmtUpdateProfile.run(next);
  return stmtFindUserById.get(userId);
}

/**
 * Record the result of a finished game.
 * `outcomes` is an array of { userId, won: boolean, cardsPlayed: number }.
 * Bots / unauthenticated players should be omitted by the caller.
 */
function recordGameResult(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return;
  const now = Date.now();
  const tx = db.transaction(() => {
    outcomes.forEach((o) => {
      if (!o || typeof o.userId !== "string") return;
      // Make sure a stats row exists for this user (defensive).
      const exists = stmtFindStats.get(o.userId);
      if (!exists) {
        try { stmtInsertStats.run(o.userId); } catch { /* user row missing — skip */ return; }
      }
      const cards = Math.max(0, Math.min(200, Number(o.cardsPlayed) || 0));
      const stmt = o.won ? stmtBumpWin : stmtBumpLoss;
      stmt.run({ user_id: o.userId, cards_played: cards, now });
    });
  });
  tx();
}

module.exports = {
  loginDevice,
  getUser,
  getStats,
  updateProfile,
  recordGameResult,
  sanitizeName,
  isValidDeviceId
};
