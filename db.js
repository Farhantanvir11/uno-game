/* ============================================================
   db.js — persistence layer (libsql / Turso)
   ============================================================
   - In production on Render: uses Turso via TURSO_DATABASE_URL +
     TURSO_AUTH_TOKEN environment variables (free forever tier).
   - Locally: falls back to an on-disk SQLite file under ./data/
     so developer flow is unchanged.
   All exported functions are async. The server awaits them.
   ============================================================ */

"use strict";

const path   = require("node:path");
const fs     = require("node:fs");
const { createClient } = require("@libsql/client");

const DEFAULT_AVATAR = "default";
const MAX_NAME_LEN   = 24;
const MIN_NAME_LEN   = 2;
const VALID_AVATARS  = new Set([
  "default", "fox", "panda", "tiger", "lion", "robot", "wizard", "ninja"
]);

function buildClient() {
  const url   = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (url) {
    return createClient({ url, authToken: token });
  }
  // Local dev fallback: on-disk SQLite file.
  const dir = process.env.DATA_DIR || path.join(__dirname, "data");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const file = path.join(dir, "lcb.sqlite");
  return createClient({ url: `file:${file}` });
}

const db = buildClient();

async function init() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       device_id   TEXT UNIQUE NOT NULL,
       name        TEXT NOT NULL,
       avatar      TEXT NOT NULL DEFAULT 'default',
       created_at  INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS user_stats (
       user_id         INTEGER PRIMARY KEY,
       wins            INTEGER NOT NULL DEFAULT 0,
       losses          INTEGER NOT NULL DEFAULT 0,
       games_played    INTEGER NOT NULL DEFAULT 0,
       cards_played    INTEGER NOT NULL DEFAULT 0,
       current_streak  INTEGER NOT NULL DEFAULT 0,
       best_streak     INTEGER NOT NULL DEFAULT 0,
       last_result_at  INTEGER,
       FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
     )`
  ], "write");
}

// Kick off schema creation immediately; server awaits ready().
const readyPromise = init().catch((err) => {
  console.error("[db] init failed:", err);
  throw err;
});
function ready() { return readyPromise; }

/* ---------- helpers ---------- */

function sanitizeName(raw, fallback = "Player") {
  const cleaned = String(raw || "").trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LEN);
  if (cleaned.length < MIN_NAME_LEN) return fallback;
  return cleaned;
}

function sanitizeAvatar(raw) {
  const v = String(raw || "").trim();
  return VALID_AVATARS.has(v) ? v : DEFAULT_AVATAR;
}

function isValidDeviceId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{6,128}$/.test(id);
}

function rowToUser(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    deviceId: r.device_id,
    name: r.name,
    avatar: r.avatar,
    createdAt: Number(r.created_at)
  };
}

function rowToStats(r) {
  if (!r) return {
    wins: 0, losses: 0, gamesPlayed: 0, cardsPlayed: 0,
    currentStreak: 0, bestStreak: 0, lastResultAt: null
  };
  return {
    wins: Number(r.wins),
    losses: Number(r.losses),
    gamesPlayed: Number(r.games_played),
    cardsPlayed: Number(r.cards_played),
    currentStreak: Number(r.current_streak),
    bestStreak: Number(r.best_streak),
    lastResultAt: r.last_result_at != null ? Number(r.last_result_at) : null
  };
}

async function firstRow(sql, args) {
  const res = await db.execute({ sql, args });
  return res.rows[0] || null;
}

/* ---------- public API ---------- */

async function getUser(userId) {
  const row = await firstRow("SELECT * FROM users WHERE id = ?", [userId]);
  return rowToUser(row);
}

async function getStats(userId) {
  const row = await firstRow("SELECT * FROM user_stats WHERE user_id = ?", [userId]);
  return rowToStats(row);
}

async function loginDevice(deviceId, suggestedName) {
  if (!isValidDeviceId(deviceId)) {
    throw new Error("invalid_device_id");
  }
  await ready();

  const existing = await firstRow("SELECT * FROM users WHERE device_id = ?", [deviceId]);
  if (existing) {
    const user  = rowToUser(existing);
    const stats = await getStats(user.id);
    return { user, stats, created: false };
  }

  const name = sanitizeName(suggestedName, `Player${Math.floor(Math.random() * 9000) + 1000}`);
  const now = Date.now();
  const ins = await db.execute({
    sql: "INSERT INTO users (device_id, name, avatar, created_at) VALUES (?, ?, ?, ?)",
    args: [deviceId, name, DEFAULT_AVATAR, now]
  });
  const id = Number(ins.lastInsertRowid);
  await db.execute({
    sql: "INSERT INTO user_stats (user_id) VALUES (?)",
    args: [id]
  });
  const user  = { id, deviceId, name, avatar: DEFAULT_AVATAR, createdAt: now };
  const stats = rowToStats(null);
  return { user, stats, created: true };
}

async function updateProfile(userId, { name, avatar } = {}) {
  const current = await getUser(userId);
  if (!current) return null;

  const nextName   = name   != null ? sanitizeName(name, current.name) : current.name;
  const nextAvatar = avatar != null ? sanitizeAvatar(avatar)           : current.avatar;

  if (nextName === current.name && nextAvatar === current.avatar) return current;

  await db.execute({
    sql: "UPDATE users SET name = ?, avatar = ? WHERE id = ?",
    args: [nextName, nextAvatar, userId]
  });
  return { ...current, name: nextName, avatar: nextAvatar };
}

async function recordGameResult(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return;
  await ready();

  const now = Date.now();
  const stmts = [];
  for (const o of outcomes) {
    if (!o || !o.userId) continue;
    const cards = Math.max(0, Math.min(200, Number(o.cardsPlayed) || 0));
    if (o.won) {
      stmts.push({
        sql: `UPDATE user_stats
                 SET wins           = wins + 1,
                     games_played   = games_played + 1,
                     cards_played   = cards_played + ?,
                     current_streak = current_streak + 1,
                     best_streak    = MAX(best_streak, current_streak + 1),
                     last_result_at = ?
               WHERE user_id = ?`,
        args: [cards, now, o.userId]
      });
    } else {
      stmts.push({
        sql: `UPDATE user_stats
                 SET losses         = losses + 1,
                     games_played   = games_played + 1,
                     cards_played   = cards_played + ?,
                     current_streak = 0,
                     last_result_at = ?
               WHERE user_id = ?`,
        args: [cards, now, o.userId]
      });
    }
  }
  if (stmts.length > 0) await db.batch(stmts, "write");
}

async function getLeaderboard(limit = 20) {
  await ready();
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const res = await db.execute({
    sql: `SELECT u.id AS id, u.name AS name, u.avatar AS avatar,
                 s.wins AS wins, s.losses AS losses,
                 s.games_played AS games_played,
                 s.best_streak AS best_streak,
                 s.current_streak AS current_streak
            FROM user_stats s
            JOIN users u ON u.id = s.user_id
           WHERE s.games_played > 0
           ORDER BY s.wins DESC, s.best_streak DESC, s.games_played ASC
           LIMIT ?`,
    args: [n]
  });
  return res.rows.map((r, i) => ({
    rank: i + 1,
    userId: Number(r.id),
    name: r.name,
    avatar: r.avatar,
    wins: Number(r.wins),
    losses: Number(r.losses),
    gamesPlayed: Number(r.games_played),
    bestStreak: Number(r.best_streak),
    currentStreak: Number(r.current_streak)
  }));
}

module.exports = {
  ready,
  loginDevice,
  getLeaderboard,
  getUser,
  getStats,
  updateProfile,
  recordGameResult,
  sanitizeName,
  isValidDeviceId
};
