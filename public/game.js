/* ---------- Transport bus ----------
   Wraps Socket.IO so bot matches can run fully offline via LCB_LocalGame.
   `socket` is a stable reference whose .emit/.on/.id route to either the
   real cloud server or a local in-browser game runner. */
const _realSocket = io({ autoConnect: true, reconnection: true });
const _busListeners = Object.create(null);

function _busOn(event, handler) {
  (_busListeners[event] = _busListeners[event] || []).push(handler);
}
function _busDispatch(event, ...args) {
  const list = _busListeners[event];
  if (list) list.forEach((h) => { try { h(...args); } catch (e) { console.error(e); } });
}
// Forward every real-socket event into the bus.
_realSocket.onAny((event, ...args) => _busDispatch(event, ...args));
// onAny() skips Socket.IO lifecycle events (connect/disconnect/connect_error/reconnect).
// Forward them explicitly so bus listeners (login, reconnect UI) see them.
_realSocket.on("connect",       (...a) => _busDispatch("connect", ...a));
_realSocket.on("disconnect",    (...a) => _busDispatch("disconnect", ...a));
_realSocket.on("connect_error", (...a) => _busDispatch("connect_error", ...a));
_realSocket.on("reconnect",     (...a) => _busDispatch("reconnect", ...a));

// Local-game instance is created lazily on first bot match.
let _localGame = null;
function _ensureLocalGame() {
  if (_localGame) return _localGame;
  if (!window.LCB_LocalGame) {
    console.error("[LCB] LocalGame module missing");
    return null;
  }
  _localGame = window.LCB_LocalGame.create((event, payload) => _busDispatch(event, payload));
  return _localGame;
}

// Mode: "remote" (default) or "local" (offline bot match).
let _transportMode = "remote";

function setTransportLocal() {
  _ensureLocalGame();
  _transportMode = "local";
}
function setTransportRemote() {
  if (_localGame) _localGame.shutdown();
  _transportMode = "remote";
}

// Polymorphic socket facade — same shape the rest of game.js already uses.
const socket = {
  get id() {
    return _transportMode === "local"
      ? (_localGame ? _localGame.id : "local-self")
      : _realSocket.id;
  },
  get connected() {
    return _transportMode === "local" ? true : _realSocket.connected;
  },
  on: (event, handler) => _busOn(event, handler),
  off: (event, handler) => {
    const list = _busListeners[event];
    if (!list) return;
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  },
  emit: (event, payload) => {
    if (_transportMode === "local" && _localGame) {
      _localGame.handle(event, payload);
    } else {
      _realSocket.emit(event, payload);
    }
  }
};

/* ---- Anonymous device login ---- */
const DEVICE_ID_KEY = "lcb-device-id-v1";
const PROFILE_KEY   = "lcb-profile-v1";

function ensureDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (id && /^[a-zA-Z0-9_-]{8,64}$/.test(id)) return id;
    // crypto.randomUUID is available in modern browsers.
    id = (crypto.randomUUID && crypto.randomUUID()) ||
         Math.random().toString(36).slice(2) + Date.now().toString(36);
    id = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    if (id.length < 8) id = (id + "00000000").slice(0, 8);
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return "anon-" + Date.now();
  }
}

function readProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "null"); } catch { return null; }
}
function writeProfile(p) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {}
}

let userProfile = readProfile(); // { userId, name, avatar, stats }

socket.on("loggedIn", (payload) => {
  userProfile = payload;
  writeProfile(payload);

  // Pre-fill the name input if empty.
  const nameInput = document.getElementById("name");
  if (nameInput && !nameInput.value && payload.name) nameInput.value = payload.name;

  renderProfileSummary();
});

socket.on("profileUpdated", (payload) => {
  userProfile = { ...(userProfile || {}), ...payload };
  writeProfile(userProfile);
  renderProfileSummary();
});

socket.on("stats", (stats) => {
  if (!userProfile) return;
  userProfile = { ...userProfile, stats };
  writeProfile(userProfile);
  renderProfileSummary();
});

socket.on("loginError", (code) => {
  console.warn("[auth]", code);
});

function renderProfileSummary() {
  if (!userProfile) return;

  const chip      = document.getElementById("profileChip");
  const nameEl    = document.getElementById("profileChipName");
  const statsEl   = document.getElementById("profileStats");
  if (!chip) return;

  if (nameEl && userProfile.name) nameEl.textContent = userProfile.name;

  const s = userProfile.stats;
  if (statsEl) {
    if (s && s.games_played > 0) {
      const rate = Math.round((s.games_won / s.games_played) * 100);
      statsEl.textContent = `${s.games_won}W · ${s.games_lost}L · ${rate}% · streak ${s.best_streak}`;
    } else {
      statsEl.textContent = "No games yet";
    }
  }

  chip.hidden = false;
}

/* ---- Session persistence + reconnect ---- */
const SESSION_KEY = "lcb-session-v1";

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.token !== "string" || typeof obj.roomCode !== "string") return null;
    return obj;
  } catch { return null; }
}

function writeSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

socket.on("session", ({ token, roomCode: code }) => {
  if (typeof token === "string" && typeof code === "string") {
    writeSession({ token, roomCode: code });
  }
});

socket.on("sessionExpired", () => {
  clearSession();
});

socket.on("sessionResumed", ({ roomCode: code }) => {
  // Server has put us back in the room — DOM state will follow via lobbyUpdated/updateGame.
  showToast("Reconnected", 1200);
});

/* ---------- Haptics (native Android/iOS via Capacitor; browser fallback) ---------- */
const _CapHaptics = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
const HapticsImpact = { light: "LIGHT", medium: "MEDIUM", heavy: "HEAVY" };
const HapticsNotif  = { success: "SUCCESS", warning: "WARNING", error: "ERROR" };

function haptic(kind = "light") {
  // Respect the master mute — users who mute sound usually don't want vibration either.
  if (isMuted) return;
  try {
    if (_CapHaptics) {
      if (kind === "success" || kind === "warning" || kind === "error") {
        _CapHaptics.notification({ type: HapticsNotif[kind] });
      } else if (kind === "selection") {
        _CapHaptics.selectionStart();
        setTimeout(() => _CapHaptics.selectionEnd(), 40);
      } else {
        _CapHaptics.impact({ style: HapticsImpact[kind] || HapticsImpact.light });
      }
      return;
    }
  } catch { /* plugin not available — fall through */ }
  if (navigator.vibrate) {
    const ms = kind === "heavy" ? 35 : kind === "medium" ? 20 : kind === "success" ? [0, 30, 60, 30] : kind === "warning" ? [0, 40, 80, 40] : 12;
    try { navigator.vibrate(ms); } catch {}
  }
}

/* ---------- Connection-status overlay (cold-start + reconnect) ---------- */
const _connOverlay = document.getElementById("connOverlay");
const _connTitle   = document.getElementById("connTitle");
const _connSub     = document.getElementById("connSub");
let _hasEverConnected = false;
let _connShowTimer   = null;

function showConnOverlay({ reconnect = false } = {}) {
  if (!_connOverlay) return;
  _connOverlay.classList.toggle("is-reconnect", reconnect);
  if (reconnect) {
    _connTitle.textContent = "Reconnecting…";
    _connSub.textContent   = "You went offline. Trying to rejoin the game.";
  } else {
    _connTitle.textContent = "Connecting to game server…";
    _connSub.textContent   = "First connection can take up to 30 seconds on free hosting. Hang tight!";
  }
  _connOverlay.style.display = "flex";
}
function hideConnOverlay() {
  if (!_connOverlay) return;
  _connOverlay.style.display = "none";
}

// On cold start, show the overlay only if the socket hasn't connected within 1.2s
// (avoids a flash on fast networks). Skipped entirely when bot-mode transport is active.
_connShowTimer = setTimeout(() => {
  if (!_hasEverConnected && _transportMode !== "local") showConnOverlay();
}, 1200);

_realSocket.on("connect", () => {
  _hasEverConnected = true;
  if (_connShowTimer) { clearTimeout(_connShowTimer); _connShowTimer = null; }
  hideConnOverlay();
});
_realSocket.on("disconnect", (reason) => {
  // Don't show overlay on intentional client-side disconnects (e.g. leaving).
  if (reason === "io client disconnect") return;
  showConnOverlay({ reconnect: true });
});
_realSocket.on("reconnect", () => hideConnOverlay());

// On (re)connect, login by device id, then try to resume any stored session.
socket.on("connect", () => {
  const deviceId = ensureDeviceId();
  const cachedName = userProfile && userProfile.name;
  socket.emit("loginDevice", { deviceId, name: cachedName });

  const session = readSession();
  if (session) {
    socket.emit("resumeSession", session);
  }
});

// On any connect attempt, prefill UI from cached profile so the menu doesn't look empty.
window.addEventListener("DOMContentLoaded", () => {
  if (userProfile && userProfile.name) {
    const nameInput = document.getElementById("name");
    if (nameInput && !nameInput.value) nameInput.value = userProfile.name;
  }
  renderProfileSummary();
});

let roomCode = "";
let myCards = [];
let currentRoom = null;
let pendingCard = null;
let timerInterval = null;
let toastTimeout = null;
let previousRoomSnapshot = null;
let previousCardCount = 0;
let previousHandLength = 0;
let lastTopCardKey = "";
let lastTurnPlayerId = "";
let pendingCardElement = null;
let pendingCardRect = null;
let suppressNextDrawFlight = false;
let audioUnlocked = false;
let pendingDrawSound = false;
let isPlayingCard = false;
let isMuted = false;
let lastTickSecond = -1;
const MUTE_STORAGE_KEY = "last-card-battle-muted";

const menuScreen = document.getElementById("menu");
const lobbyScreen = document.getElementById("lobby");
const gameScreen = document.getElementById("game");
const handElement = document.getElementById("hand");
const roomTitle = document.getElementById("roomTitle");
const roomStatus = document.getElementById("roomStatus");
const roomLabel = document.getElementById("roomLabel");
const lobbyPlayers = document.getElementById("lobbyPlayers");
const startButton = document.getElementById("startBtn");
const cardCountSelect = document.getElementById("cardCount");
const timerLabel = document.getElementById("timer");
const topCardElement = document.getElementById("topCard");
const playersElement = document.getElementById("players");
const stackInfo = document.getElementById("stackInfo");
const unoButton = document.getElementById("unoBtn");
const drawButton = document.getElementById("drawBtn");
const muteButton = document.getElementById("muteBtn");
const colorPicker = document.getElementById("colorPicker");
const deckElement = document.getElementById("deck");
const stackClearedHint = document.getElementById("stackClearedHint");
const CARD_GLOW_COLORS = {
  red: "rgba(216, 67, 21, 0.7)",
  green: "rgba(46, 125, 50, 0.7)",
  blue: "rgba(21, 101, 192, 0.7)",
  yellow: "rgba(249, 168, 37, 0.8)",
  black: "rgba(255, 213, 79, 0.7)"
};
let stackClearedTopKey = null;
const toast = document.getElementById("toast");
const deckDecisionModal = document.getElementById("deckDecisionModal");
const deckDecisionText = document.getElementById("deckDecisionText");
const deckDecisionActions = document.getElementById("deckDecisionActions");
const shuffleDeckBtn = document.getElementById("shuffleDeckBtn");
const winnerModal = document.getElementById("winnerModal");
const winnerNameElement = document.getElementById("winnerName");

const soundEffects = {
  buttonPress: new Audio("/sounds/button-press.mp3"),
  cardPlay: new Audio("/sounds/card-play.mp3"),
  drawCard: new Audio("/sounds/draw-card.mp3"),
  invalidMove: new Audio("/sounds/invalid-move.mp3"),
  timerTick: new Audio("/sounds/timer-tick.mp3"),
  win: new Audio("/sounds/win.mp3"),
  unoCall: new Audio("/sounds/uno-call.mp3"),
  penalty: new Audio("/sounds/penalty.mp3"),
  power: new Audio("/sounds/power.mp3"),
  intro: new Audio("/sounds/intro.mp3")
};

let introPlayed = false;

Object.values(soundEffects).forEach((audio) => {
  audio.preload = "auto";
});

// Try to play the intro the moment the page is ready. In the Android APK
// (where MediaPlaybackRequiresUserGesture is disabled) this succeeds. In
// regular browsers the .play() promise is rejected by the autoplay policy,
// in which case the first-interaction unlockAudio() path still triggers it.
window.addEventListener("DOMContentLoaded", () => {
  const intro = soundEffects.intro;
  if (!intro || introPlayed) return;
  const p = intro.play();
  if (p && typeof p.then === "function") {
    p.then(() => {
      introPlayed = true;
      audioUnlocked = true;
      updateBgmPlayback();
    }).catch(() => { /* autoplay blocked — wait for first tap */ });
  }
});

function getNameValue() {
  return document.getElementById("name").value.trim();
}

// If the user has typed a different name from the persisted profile,
// push it to the server so future logins (and stats) match.
function syncProfileNameIfChanged() {
  const typed = getNameValue();
  if (!typed || !userProfile || !userProfile.userId) return;
  if (typed !== userProfile.name) {
    socket.emit("updateProfile", { name: typed });
  }
}

function setScreen(screen) {
  menuScreen.style.display = screen === "menu" ? "block" : "none";
  lobbyScreen.style.display = screen === "lobby" ? "block" : "none";
  gameScreen.style.display = screen === "game" ? "block" : "none";
  // Friends sub-screen is auxiliary — always hide on lobby/game,
  // and also when explicitly returning to menu.
  const friendsScreen = document.getElementById("friendsMenu");
  if (friendsScreen) friendsScreen.style.display = "none";
  document.body.dataset.screen = screen;
}

const bgm = new Audio("/sounds/bgm.mp3");
bgm.loop = true;
bgm.volume = 0.35;
bgm.preload = "auto";

const MUSIC_STORAGE_KEY = "lcb-music-muted";
const BGM_BY_MASTER_KEY = "lcb-bgm-muted-by-master";
let isMusicMuted = false;
let bgmMutedByMaster = false;
try {
  isMusicMuted = window.localStorage.getItem(MUSIC_STORAGE_KEY) === "true";
  bgmMutedByMaster = window.localStorage.getItem(BGM_BY_MASTER_KEY) === "true";
} catch {}

function updateBgmPlayback() {
  if (!audioUnlocked || isMusicMuted) {
    bgm.pause();
    return;
  }
  if (bgm.paused) {
    bgm.play().catch(() => {});
  }
}

function updateMusicButton() {
  const label = document.getElementById("musicToggleLabel");
  const btn = document.getElementById("musicToggleBtn");
  if (label) label.innerText = isMusicMuted ? "🔇" : "♪";
  if (btn) {
    btn.classList.toggle("is-off", isMusicMuted);
    btn.title = isMusicMuted ? "Music off" : "Music on";
    btn.setAttribute("aria-label", isMusicMuted ? "Turn music on" : "Turn music off");
  }
}

function toggleMusic() {
  unlockAudio();
  isMusicMuted = !isMusicMuted;
  bgmMutedByMaster = false; // direct control resets the master link
  try {
    window.localStorage.setItem(MUSIC_STORAGE_KEY, String(isMusicMuted));
    window.localStorage.setItem(BGM_BY_MASTER_KEY, "false");
  } catch {}
  updateMusicButton();
  updateBgmPlayback();
}

function unlockAudio() {
  if (audioUnlocked) {
    return;
  }
  audioUnlocked = true;
  updateBgmPlayback();
  // One-shot intro sting on the user's very first interaction with the app.
  if (!introPlayed) {
    introPlayed = true;
    playSound("intro");
  }
}

function loadMutePreference() {
  try {
    isMuted = window.localStorage.getItem(MUTE_STORAGE_KEY) === "true";
  } catch {
    isMuted = false;
  }
}

function saveMutePreference() {
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, String(isMuted));
  } catch {
    // Ignore storage errors and keep the current in-memory preference.
  }
}

function updateMuteButton() {
  // Legacy <button id="muteBtn"> was removed; sound state is now shown in the
  // settings panel via updateSettingsSwitches(). Keep a no-op for backwards
  // compatibility with existing callsites.
  if (muteButton) muteButton.innerText = isMuted ? "Sound: Off" : "Sound: On";
  updateSettingsSwitches();
}

function toggleMute() {
  isMuted = !isMuted;
  saveMutePreference();
  updateMuteButton();

  let bgmChanged = false;
  if (isMuted) {
    // Turning Sound OFF: also mute BGM if it's currently playing.
    if (!isMusicMuted) {
      isMusicMuted = true;
      bgmMutedByMaster = true;
      bgmChanged = true;
    }
  } else {
    // Turning Sound ON: restore BGM only if WE were the one that muted it.
    if (isMusicMuted && bgmMutedByMaster) {
      isMusicMuted = false;
      bgmMutedByMaster = false;
      bgmChanged = true;
    }
  }

  if (bgmChanged) {
    try {
      window.localStorage.setItem(MUSIC_STORAGE_KEY, String(isMusicMuted));
      window.localStorage.setItem(BGM_BY_MASTER_KEY, String(bgmMutedByMaster));
    } catch {}
    updateMusicButton();
    updateBgmPlayback();
  }
}

// Track active clones per sound so stopSound() can actually silence them.
const activeSoundInstances = {};

function playSound(name) {
  const audio = soundEffects[name];
  if (!audio || !audioUnlocked || isMuted) {
    return;
  }

  // Clone the audio node so overlapping plays don't abort each other.
  // Single-instance <audio> elements silently drop a second play() while
  // the first is still resolving, which caused missed SFX.
  const instance = audio.cloneNode(true);
  instance.volume = audio.volume;

  if (!activeSoundInstances[name]) activeSoundInstances[name] = new Set();
  activeSoundInstances[name].add(instance);

  const cleanup = () => activeSoundInstances[name]?.delete(instance);
  instance.addEventListener("ended", cleanup);
  instance.addEventListener("pause", cleanup);

  instance.play().catch(cleanup);
}

function stopSound(name) {
  const audio = soundEffects[name];
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }

  const active = activeSoundInstances[name];
  if (active) {
    active.forEach((instance) => {
      instance.pause();
      instance.currentTime = 0;
    });
    active.clear();
  }
}

function closeWinnerModal() {
  winnerModal.style.display = "none";
  // Game is over — drop the session so a refresh doesn't try to resume a finished match.
  clearSession();
  setScreen("lobby");
}

function showToast(message, duration = 1000) {
  clearTimeout(toastTimeout);
  toast.innerText = message;
  toast.classList.add("show");

  toastTimeout = setTimeout(() => {
    toast.classList.remove("show");
  }, duration);
}

function renderDeckDecision(room) {
  if (!room?.awaitingDeckDecision) {
    deckDecisionModal.style.display = "none";
    return;
  }

  const isHost = socket.id === room.hostId;
  deckDecisionModal.style.display = "flex";
  deckDecisionActions.style.display = isHost ? "flex" : "none";

  if (isHost) {
    deckDecisionText.innerText = "Choose whether to reshuffle the used cards or declare the current leader the winner.";
    shuffleDeckBtn.disabled = !room.canShuffleDeck;
  } else {
    deckDecisionText.innerText = "The host is deciding what to do because the main deck is empty.";
  }
}

function createRoom() {
  unlockAudio();
  const name = getNameValue();
  if (!name) {
    alert("Enter your name first.");
    return;
  }
  syncProfileNameIfChanged();
  playSound("buttonPress");
  socket.emit("createRoom", name);
}

function joinRoom() {
  unlockAudio();
  const name = getNameValue();
  const code = document.getElementById("roomCode").value.trim().toUpperCase();

  if (!name || !code) {
    alert("Enter your name and room code.");
    return;
  }

  syncProfileNameIfChanged();
  playSound("buttonPress");
  roomCode = code;
  socket.emit("joinRoom", { roomCode: code, playerName: name });
}

let isSpectator = false;

socket.on("spectateOffered", ({ roomCode: code, reason }) => {
  const reasonText = reason === "started"
    ? "That match is already in progress."
    : "That room is already full.";
  if (!confirm(`${reasonText}\n\nJoin as spectator?`)) return;
  socket.emit("joinAsSpectator", { roomCode: code });
});

socket.on("spectatorJoined", (code) => {
  isSpectator = true;
  roomCode = code;
  myCards = [];
  document.body.classList.add("is-spectator");
  setScreen("lobby");
});

socket.on("leftRoom", () => {
  isSpectator = false;
  document.body.classList.remove("is-spectator");
});

const BOT_DIFFICULTY_KEY = "lcb-bot-difficulty";

function openBotDifficulty() {
  unlockAudio();
  const name = getNameValue();
  if (!name) {
    alert("Please enter your name to start a match.");
    return;
  }
  const modal = document.getElementById("botDifficultyModal");
  const saved = (() => { try { return localStorage.getItem(BOT_DIFFICULTY_KEY); } catch { return null; } })();
  modal.querySelectorAll(".bot-diff-option").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.difficulty === (saved || "normal"));
  });
  modal.style.display = "flex";
}

function closeBotDifficulty() {
  document.getElementById("botDifficultyModal").style.display = "none";
}

function confirmBotDifficulty(difficulty) {
  // Update the visual selection immediately so user sees which was chosen.
  const modal = document.getElementById("botDifficultyModal");
  modal.querySelectorAll(".bot-diff-option").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.difficulty === difficulty);
  });
  try { localStorage.setItem(BOT_DIFFICULTY_KEY, difficulty); } catch {}
  closeBotDifficulty();
  startBotMatch(difficulty);
}

function leaveRoom() {
  socket.emit("leaveRoom");
  // If we were in a local bot match, tear it down and return to cloud transport.
  if (_transportMode === "local") setTransportRemote();
}

function requestRematch() {
  const btn = document.getElementById("rematchBtn");
  if (btn.disabled) return;
  btn.disabled = true;
  document.getElementById("rematchLabel").innerText = "Waiting...";
  socket.emit("requestRematch");
}

function resetRematchButton() {
  const btn = document.getElementById("rematchBtn");
  if (!btn) return;
  btn.disabled = false;
  document.getElementById("rematchLabel").innerText = "Rematch";
}

function confirmLeaveRoom() {
  if (currentRoom?.started && !confirm("Leave the current match? You won't be able to rejoin.")) return;
  leaveRoom();
  // Close the settings modal if it was used to trigger this.
  closeSettings();
}

function startBotMatch(difficulty = "normal") {
  unlockAudio();
  const name = getNameValue();
  if (!name) {
    alert("Enter your name first.");
    return;
  }

  syncProfileNameIfChanged();
  playSound("buttonPress");
  // Bot matches always run locally — no network needed, works offline.
  setTransportLocal();
  const rules = {
    stacking:          document.getElementById("soloRuleStacking")?.checked  ?? true,
    drawUntilPlayable: document.getElementById("soloRuleDrawUntil")?.checked ?? false,
    challengePlusFour: document.getElementById("soloRuleChallenge")?.checked ?? false
  };
  socket.emit("startBotMatch", { name, difficulty, rules });
}

function startGame() {
  unlockAudio();
  if (!roomCode) {
    return;
  }

  playSound("buttonPress");
  socket.emit("startGame", {
    roomCode,
    cards: cardCountSelect.value,
    rules: {
      stacking:          document.getElementById("ruleStacking")?.checked  ?? true,
      drawUntilPlayable: document.getElementById("ruleDrawUntil")?.checked ?? false,
      challengePlusFour: document.getElementById("ruleChallenge")?.checked ?? false
    }
  });
}

function drawCard() {
  if (!currentRoom || currentRoom.players[currentRoom.turn]?.id !== socket.id) {
    showToast("Not your turn", 900);
    playSound("invalidMove");
    return;
  }

  pendingDrawSound = true;
  playSound("drawCard");
  socket.emit("drawCard", roomCode);
}

function callUNO() {
  socket.emit("uno", roomCode);
  unoButton.style.display = "none";
  playSound("unoCall");
  haptic("heavy");
}

function chooseColor(color) {
  colorPicker.style.display = "none";

  if (!pendingCard) {
    return;
  }

  playSound("cardPlay");
  haptic("light");
  isPlayingCard = true;

  const card = pendingCard;
  const sourceEl = pendingCardElement;
  const sourceRect = pendingCardRect;
  pendingCard = null;
  pendingCardElement = null;
  pendingCardRect = null;

  const emit = () => {
    socket.emit("playCard", { roomCode, card, chosenColor: color });
    isPlayingCard = false;
  };

  // Use stored rect if sourceEl was detached from DOM by renderHand.
  if (sourceRect) {
    animatePlayFlightFromRect(sourceRect, { ...card, color }, emit);
  } else if (sourceEl && document.body.contains(sourceEl)) {
    animatePlayFlight(sourceEl, { ...card, color }, emit);
  } else {
    emit();
  }
}

function cancelColorPicker() {
  if (colorPicker.style.display === "none") return;
  colorPicker.style.display = "none";
  // Restore the wild/+4 card we optimistically hid in playCard().
  if (pendingCardElement && document.body.contains(pendingCardElement)) {
    pendingCardElement.style.visibility = "";
  }
  pendingCard = null;
  pendingCardElement = null;
  pendingCardRect = null;
}

function updateLobby(room) {
  currentRoom = room;
  roomCode = room.roomCode;
  roomTitle.innerText = room.roomCode;
  const specs = room.spectatorCount || 0;
  roomStatus.innerText = `${room.players.length}/5 Players` + (specs > 0 ? ` · ${specs} 👀` : "");
  roomLabel.innerText = `Room ${room.roomCode}`;
  startButton.disabled = socket.id !== room.hostId || room.players.length < 2;

  // Only the host can change house rules / starting cards.
  const isHost = socket.id === room.hostId;
  ["ruleStacking", "ruleDrawUntil", "ruleChallenge"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !isHost;
  });
  document.getElementById("cardCountPills")?.classList.toggle("is-locked", !isHost);

  // Live-sync settings from the host so every member sees the same rules.
  if (!isHost) {
    if (room.rules) {
      const sync = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.checked = !!value;
      };
      sync("ruleStacking",  room.rules.stacking !== false);
      sync("ruleDrawUntil", room.rules.drawUntilPlayable === true);
      sync("ruleChallenge", room.rules.challengePlusFour === true);
    }
    if (room.handSize) {
      if (cardCountSelect) cardCountSelect.value = String(room.handSize);
      const pills = document.querySelectorAll("#cardCountPills .lobby-pill");
      pills.forEach((p) => {
        p.classList.toggle("is-active", String(p.dataset.value) === String(room.handSize));
      });
    }
  }

  lobbyPlayers.innerHTML = "";

  const MAX_SLOTS = 5;
  for (let i = 0; i < MAX_SLOTS; i += 1) {
    const player = room.players[i];
    const slot = document.createElement("div");
    slot.className = "lobby-slot";

    if (player) {
      const isHost = player.id === room.hostId;
      const isMe = player.id === socket.id;
      const { url, color } = getAvatarFor(player);
      slot.classList.add("is-filled");
      if (isHost) slot.classList.add("is-host");
      slot.innerHTML = `
        <div class="slot-avatar" style="--avatar-bg:${color};">
          <img src="${url}" alt="" />
          ${isHost ? '<span class="slot-crown" title="Host">\u2605</span>' : ""}
        </div>
        <div class="slot-name">${player.name}${isMe ? " (You)" : ""}</div>
        <div class="slot-tag">${isHost ? "Host" : "Ready"}</div>
      `;
    } else {
      slot.classList.add("is-empty");
      slot.innerHTML = `
        <div class="slot-avatar slot-avatar-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </div>
        <div class="slot-name">Waiting&hellip;</div>
        <div class="slot-tag">Open slot</div>
      `;
    }

    lobbyPlayers.appendChild(slot);
  }
}

function copyRoomCode() {
  if (!roomCode) return;
  try {
    navigator.clipboard.writeText(roomCode);
    showToast("Room code copied", 900);
  } catch {
    showToast(roomCode, 1200);
  }
  flashCopiedState();
}

function flashCopiedState() {
  const btn = document.getElementById("copyCodeBtn");
  if (!btn) return;
  if (btn._copyResetTimer) clearTimeout(btn._copyResetTimer);
  btn.classList.add("copied");
  btn._copyResetTimer = setTimeout(() => {
    btn.classList.remove("copied");
    btn._copyResetTimer = null;
  }, 1100);
}

document.addEventListener("click", (e) => {
  const pill = e.target.closest("#cardCountPills .lobby-pill");
  if (!pill) return;
  const group = pill.parentElement;
  group.querySelectorAll(".lobby-pill").forEach((p) => p.classList.remove("is-active"));
  pill.classList.add("is-active");
  const select = document.getElementById("cardCount");
  if (select) select.value = pill.dataset.value;
  broadcastLobbySettings();
});

function broadcastLobbySettings() {
  if (!roomCode) return;
  if (!currentRoom || currentRoom.hostId !== socket.id) return;
  socket.emit("updateLobbyRules", {
    roomCode,
    handSize: cardCountSelect?.value,
    rules: {
      stacking:          document.getElementById("ruleStacking")?.checked  ?? true,
      drawUntilPlayable: document.getElementById("ruleDrawUntil")?.checked ?? false,
      challengePlusFour: document.getElementById("ruleChallenge")?.checked ?? false
    }
  });
}

["ruleStacking", "ruleDrawUntil", "ruleChallenge"].forEach((id) => {
  document.addEventListener("change", (e) => {
    if (e.target && e.target.id === id) broadcastLobbySettings();
  });
});

function startTurnTimer(turnEndsAt) {
  clearInterval(timerInterval);
  lastTickSecond = -1;
  stopSound("timerTick");

  if (!turnEndsAt) {
    timerLabel.innerText = "Time: -";
    return;
  }

  const renderTime = () => {
    const secondsLeft = Math.max(0, Math.ceil((turnEndsAt - Date.now()) / 1000));
    timerLabel.innerText = `Time: ${secondsLeft}`;
    updateActiveTimerRing();

    if (secondsLeft === 5 && lastTickSecond !== 5) {
      playSound("timerTick");
      lastTickSecond = 5;
    }

    if (secondsLeft === 0) {
      clearInterval(timerInterval);
    }
  };

  renderTime();
  timerInterval = setInterval(renderTime, 80);
}

function playCard(card, sourceEl) {
  if (!currentRoom || currentRoom.players[currentRoom.turn]?.id !== socket.id) {
    return;
  }
  if (isPlayingCard) return; // guard against rapid double-taps during flight

  if (card.value === "wild" || card.value === "+4") {
    // If a previous wild/+4 tap is still awaiting color choice, restore that
    // card's visibility before we overwrite the pending refs (else it stays
    // invisible until the next renderHand).
    if (pendingCardElement && pendingCardElement !== sourceEl &&
        document.body.contains(pendingCardElement)) {
      pendingCardElement.style.visibility = "";
    }
    pendingCard = card;
    pendingCardElement = sourceEl || null;
    // Capture rect NOW before renderHand can wipe the DOM.
    pendingCardRect = getElementRect(sourceEl);
    if (sourceEl) sourceEl.style.visibility = "hidden";
    // Player chose to stack — close any open challenge prompt so the two modals never overlap.
    dismissChallengeModal();
    const reopen = document.getElementById("challengeReopen");
    if (reopen) reopen.style.display = "none";
    colorPicker.style.display = "flex";
    return;
  }

  playSound("cardPlay");
  haptic("light");
  isPlayingCard = true;

  // Capture rect NOW — local-game fires yourCards synchronously which wipes
  // #hand before the animation finishes, detaching sourceEl mid-flight.
  const capturedRect = getElementRect(sourceEl);
  if (sourceEl) sourceEl.style.visibility = "hidden";

  const emit = () => {
    socket.emit("playCard", { roomCode, card });
    isPlayingCard = false;
  };

  if (capturedRect) {
    animatePlayFlightFromRect(capturedRect, card, emit);
  } else {
    emit();
  }
}

function getCardLabel(card) {
  return card.value;
}

function buildReverseIcon(size = "large") {
  const stroke = size === "small" ? 2.4 : 2.8;
  return (
    `<svg class="reverse-icon ${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">` +
    `<polyline points="17 2 21 6 17 10"/>` +
    `<path d="M3 12V10a4 4 0 0 1 4-4h14"/>` +
    `<polyline points="7 22 3 18 7 14"/>` +
    `<path d="M21 12v2a4 4 0 0 1-4 4H3"/>` +
    `</svg>`
  );
}

function buildCardInnerHTML(card) {
  const isReverse = card.value === "reverse";
  const label = isReverse ? buildReverseIcon("large") : getCardLabel(card);
  const corner = isReverse ? buildReverseIcon("small") : label;
  const isLong = !isReverse && !/^\d$/.test(String(label));
  const longAttr = isLong ? " data-long" : "";
  const reverseAttr = isReverse ? " data-reverse" : "";
  return (
    `<span class="card-corner tl">${corner}</span>` +
    `<span class="card-value"${longAttr}${reverseAttr}>${label}</span>` +
    `<span class="card-corner br">${corner}</span>`
  );
}

function buildCardFaceHTML(card) {
  return `<div class="card ${card.color}">${buildCardInnerHTML(card)}</div>`;
}

function buildCardBackHTML() {
  return `<div class="card card-back"></div>`;
}

function getElementRect(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return r;
}

function animateDrawFlight(newCards) {
  const deckRect = getElementRect(deckElement);
  if (!deckRect || !newCards.length) return;

  newCards.forEach((card, i) => {
    setTimeout(() => {
      const handCards = handElement.querySelectorAll(".card");
      const targetEl = handCards[handCards.length - newCards.length + i];
      const targetRect = getElementRect(targetEl) || {
        left: window.innerWidth / 2 - 37,
        top: window.innerHeight - 120,
        width: 74,
        height: 108
      };

      if (targetEl) targetEl.style.visibility = "hidden";

      const flying = document.createElement("div");
      flying.className = "flying-card";
      flying.style.left = `${deckRect.left}px`;
      flying.style.top = `${deckRect.top}px`;
      flying.innerHTML = `
        <div class="flip-inner">
          <div class="flip-face back">${buildCardBackHTML()}</div>
          <div class="flip-face front">${buildCardFaceHTML(card)}</div>
        </div>`;
      document.body.appendChild(flying);

      const dx = targetRect.left - deckRect.left;
      const dy = targetRect.top - deckRect.top;
      const spin = (Math.random() * 10 - 5).toFixed(1);
      const duration = 480;

      // Use WAAPI — reliable on Android WebView (CSS transitions from mount are not).
      const anim = flying.animate(
        [
          { transform: "translate(0px,0px) rotate(0deg) scale(1)", opacity: 1 },
          { transform: `translate(${dx}px,${dy}px) rotate(${spin}deg) scale(1)`, opacity: 1, offset: 0.75 },
          { transform: `translate(${dx}px,${dy}px) rotate(${spin}deg) scale(1)`, opacity: 0 }
        ],
        { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }
      );

      // Flip to face-up halfway through flight.
      setTimeout(() => flying.classList.add("flipped"), duration * 0.55);

      const reveal = () => {
        if (targetEl) targetEl.style.visibility = "";
        flying.remove();
      };
      if (anim && anim.finished) {
        anim.finished.then(reveal).catch(reveal);
      } else {
        setTimeout(reveal, duration + 40);
      }
    }, i * 110);
  });
}

/* Fly a card from an opponent's tile to the discard pile (no source element to hide). */
function animateOpponentPlayFlight(playerId, card) {
  const anchor = getPlayerAnchor(playerId);
  const topRect = getElementRect(topCardElement) || {
    left: window.innerWidth / 2 - 42,
    top: 72,
    width: 84,
    height: 120
  };

  const startLeft = anchor.x - 37;
  const startTop  = anchor.y - 54;

  const flying = document.createElement("div");
  flying.className = "flying-card-simple";
  flying.style.cssText = [
    `position:fixed`,
    `left:${startLeft}px`,
    `top:${startTop}px`,
    `width:74px`,
    `height:106px`,
    `z-index:2000`,
    `pointer-events:none`,
    `border-radius:14px`,
    `overflow:hidden`
  ].join(";");
  flying.innerHTML = buildCardFaceHTML(card);
  const innerCard = flying.firstElementChild;
  if (innerCard) innerCard.setAttribute("style", "width:100%;height:100%;");
  document.body.appendChild(flying);

  const dx = topRect.left - startLeft;
  const dy = topRect.top  - startTop;
  const spin = (Math.random() * 30 - 15).toFixed(1);
  const duration = 480;

  const anim = flying.animate(
    [
      { transform: "translate(0px,0px) rotate(0deg) scale(1)" },
      { transform: `translate(${dx}px,${dy}px) rotate(${spin}deg) scale(1.08)` }
    ],
    { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }
  );

  const cleanup = () => flying.remove();
  if (anim && anim.finished) {
    anim.finished.then(cleanup).catch(cleanup);
  } else {
    setTimeout(cleanup, duration + 40);
  }
}

/* Same as animatePlayFlight but takes a pre-captured DOMRect (for wild/+4
   where the source element may be detached by the time color is picked). */
function animatePlayFlightFromRect(startRect, card, onComplete) {
  const topRect = getElementRect(topCardElement) || {
    left: window.innerWidth / 2 - 42,
    top: 72,
    width: 84,
    height: 120
  };

  const flying = document.createElement("div");
  flying.className = "flying-card-simple";
  flying.style.cssText = [
    `position:fixed`,
    `left:${startRect.left}px`,
    `top:${startRect.top}px`,
    `width:${startRect.width || 72}px`,
    `height:${startRect.height || 102}px`,
    `z-index:2000`,
    `pointer-events:none`,
    `border-radius:14px`,
    `overflow:hidden`
  ].join(";");
  flying.innerHTML = buildCardFaceHTML(card);
  // Force the inner .card to fill the wrapper so it works at any viewport size.
  const innerCard = flying.firstElementChild;
  if (innerCard) innerCard.setAttribute("style", "width:100%;height:100%;");
  document.body.appendChild(flying);

  const dx = topRect.left - startRect.left;
  const dy = topRect.top  - startRect.top;
  const spin = (Math.random() * 20 - 10).toFixed(1);
  const duration = 480;

  const anim = flying.animate(
    [
      { transform: "translate(0px, 0px) rotate(0deg) scale(1)",    opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) rotate(${spin}deg) scale(1.05)`, opacity: 1 }
    ],
    { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }
  );

  const cleanup = () => { flying.remove(); onComplete(); };
  if (anim && anim.finished) {
    anim.finished.then(cleanup).catch(cleanup);
  } else {
    setTimeout(cleanup, duration + 40);
  }
}

function animatePlayFlight(sourceEl, card, onComplete) {
  const startRect = getElementRect(sourceEl);
  if (!startRect) { onComplete(); return; }
  animatePlayFlightFromRect(startRect, card, onComplete);
}

function _animatePlayFlight_unused(sourceEl, card, onComplete) {
  const startRect = getElementRect(sourceEl);
  const topRect = getElementRect(topCardElement) || {
    left: window.innerWidth / 2 - 37,
    top: window.innerHeight * 0.46 - 54,
    width: 74,
    height: 108
  };

  if (!startRect) {
    onComplete();
    return;
  }

  sourceEl.style.visibility = "hidden";

  const flying = document.createElement("div");
  flying.className = "flying-card play-flight flipped";
  flying.style.left = `${startRect.left}px`;
  flying.style.top = `${startRect.top}px`;
  flying.style.transition = "none"; // we drive animation via WAAPI below
  flying.innerHTML = `
    <div class="flip-inner">
      <div class="flip-face back">${buildCardBackHTML()}</div>
      <div class="flip-face front">${buildCardFaceHTML(card)}</div>
    </div>`;
  document.body.appendChild(flying);

  const dx = topRect.left - startRect.left;
  const dy = topRect.top - startRect.top;
  const spin = (Math.random() * 30 - 15).toFixed(1);
  const duration = 520;

  // Web Animations API — works reliably across mobile WebViews
  // (CSS transition-from-mount is flaky on Android Chromium WebView).
  const anim = flying.animate(
    [
      { transform: "translate(0px, 0px) rotate(0deg) scale(1)" },
      { transform: `translate(${dx}px, ${dy}px) rotate(${spin}deg) scale(1.08)` }
    ],
    { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }
  );

  const cleanup = () => {
    flying.remove();
    onComplete();
  };
  if (anim && anim.finished) {
    anim.finished.then(cleanup).catch(cleanup);
  } else {
    setTimeout(cleanup, duration + 40);
  }
}

function isCardPlayable(card, top, stackCount, rules) {
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

function renderHand(room) {
  handElement.innerHTML = "";
  const isMyTurn = room.players[room.turn]?.id === socket.id && !room.awaitingDeckDecision;
  const top = room.discard[room.discard.length - 1];
  const playableCards = [];

  myCards.forEach((card, idx) => {
    const cardElement = document.createElement("button");
    cardElement.className = `card ${card.color}`;
    cardElement.innerHTML = buildCardInnerHTML(card);
    cardElement.disabled = !isMyTurn;

    const playable = isMyTurn && isCardPlayable(card, top, room.stackCount, room.rules);
    if (playable) {
      cardElement.classList.add("playable");
      playableCards.push({ idx, el: cardElement });
    }

    if (isMyTurn) {
      cardElement.addEventListener("click", () => playCard(card, cardElement));
    }

    handElement.appendChild(cardElement);
  });

  previousHandLength = myCards.length;

  unoButton.style.display = myCards.length === 1 ? "inline-block" : "none";
  if (drawButton) drawButton.disabled = !isMyTurn;
  if (deckElement) deckElement.classList.toggle("is-drawable", isMyTurn);

  // Challenge +4: drive modal + reopen pill from server's canChallenge flag.
  syncChallengeUi(room, isMyTurn);

  maybeShowFirstPlayHint(isMyTurn, playableCards);
}

/* ---- Challenge +4 modal ---- */
let _challengeWasAvailable = false;
let _challengeDismissed   = false;

function syncChallengeUi(room, isMyTurn) {
  const modal  = document.getElementById("challengeModal");
  const reopen = document.getElementById("challengeReopen");
  const available = !!(isMyTurn && room && room.canChallenge);

  if (!available) {
    if (modal)  modal.style.display = "none";
    if (reopen) reopen.style.display = "none";
    _challengeWasAvailable = false;
    _challengeDismissed   = false;
    return;
  }

  // Refresh dynamic content
  const stack = room.stackCount || 4;
  const offenderName = (() => {
    const top = room.discard[room.discard.length - 1];
    // The +4's color belongs to whoever played it; we don't track player names per card,
    // so derive offender from the player NOT on turn whose last action made the stack.
    // Simplest: show the player just before us in play direction.
    const idx = room.turn;
    const prev = (idx - room.direction + room.players.length) % room.players.length;
    return room.players[prev]?.name || "Opponent";
  })();
  const offenderEl = document.getElementById("challengeOffender");
  const penEl      = document.getElementById("challengePenalty");
  const accCount   = document.getElementById("challengeAcceptCount");
  if (offenderEl) offenderEl.textContent = offenderName;
  if (penEl)      penEl.textContent      = stack;
  if (accCount)   accCount.textContent   = stack;

  // Auto-open the first time it becomes available, unless user dismissed.
  if (!_challengeWasAvailable && !_challengeDismissed && modal) {
    modal.style.display = "flex";
    playSound("invalidMove"); // alert ping; reuse existing sound
  }
  _challengeWasAvailable = true;

  // Reopen pill visible only when modal is closed
  if (reopen) {
    const modalOpen = modal && modal.style.display !== "none";
    reopen.style.display = modalOpen ? "none" : "inline-flex";
  }
}

function openChallengeModal() {
  const modal  = document.getElementById("challengeModal");
  const reopen = document.getElementById("challengeReopen");
  if (modal)  modal.style.display = "flex";
  if (reopen) reopen.style.display = "none";
  _challengeDismissed = false;
}

function dismissChallengeModal() {
  const modal  = document.getElementById("challengeModal");
  const reopen = document.getElementById("challengeReopen");
  if (modal)  modal.style.display = "none";
  if (reopen && currentRoom?.canChallenge) reopen.style.display = "inline-flex";
  _challengeDismissed = true;
}

function challengePlusFour() {
  if (!currentRoom || !currentRoom.canChallenge) return;
  if (currentRoom.players[currentRoom.turn]?.id !== socket.id) return;
  unlockAudio();
  playSound("buttonPress");
  socket.emit("challengePlusFour", roomCode);
  dismissChallengeModal();
}

function acceptChallenge() {
  // Accept = same as pressing Draw under penalty: server draws the full stack.
  dismissChallengeModal();
  drawCard();
}

socket.on("challengeResolved", ({ challengerId, offenderId, success, drawn }) => {
  const me = socket.id;
  let msg;
  if (success) {
    msg = challengerId === me
      ? `Challenge won — opponent drew ${drawn}`
      : (offenderId === me
          ? `You were challenged — drew ${drawn}`
          : `Challenge succeeded — ${drawn} cards`);
  } else {
    msg = challengerId === me
      ? `Challenge failed — you drew ${drawn}`
      : (offenderId === me
          ? `Challenge dismissed`
          : `Challenge failed — ${drawn} cards`);
  }
  showToast(msg, 1800);
});

/* ---- First-time turn hint ---- */
const HINT_PLAY_KEY  = "lcb-hint-firstplay-v1";
const HINT_DRAW_KEY  = "lcb-hint-firstdraw-v1";

function maybeShowFirstPlayHint(isMyTurn, playableCards) {
  if (!isMyTurn) return;
  let seenPlay = false, seenDraw = false;
  try {
    seenPlay = localStorage.getItem(HINT_PLAY_KEY) === "1";
    seenDraw = localStorage.getItem(HINT_DRAW_KEY) === "1";
  } catch {}

  if (playableCards.length > 0 && !seenPlay) {
    playableCards[0].el.classList.add("hint-pulse");
    const dismiss = () => {
      try { localStorage.setItem(HINT_PLAY_KEY, "1"); } catch {}
      playableCards[0].el.classList.remove("hint-pulse");
    };
    playableCards[0].el.addEventListener("click", dismiss, { once: true });
  } else if (playableCards.length === 0 && !seenDraw) {
    deckElement.classList.add("hint-pulse");
    const dismiss = () => {
      try { localStorage.setItem(HINT_DRAW_KEY, "1"); } catch {}
      deckElement.classList.remove("hint-pulse");
    };
    deckElement.addEventListener("click", dismiss, { once: true });
  }
}

function renderTopCard(room) {
  const top = room.discard[room.discard.length - 1];
  if (!top) {
    topCardElement.innerHTML = "";
    return;
  }

  const topKey = `${top.color}:${top.value}`;
  lastTopCardKey = topKey;

  topCardElement.innerHTML = buildCardFaceHTML(top);
}

// Five illustrated avatars (DiceBear "big-smile" + "personas" mix).
const AVATAR_URLS = [
  "https://api.dicebear.com/7.x/big-smile/svg?seed=Atlas&backgroundColor=b6e3f4",
  "https://api.dicebear.com/7.x/big-smile/svg?seed=Nova&backgroundColor=ffdfbf",
  "https://api.dicebear.com/7.x/big-smile/svg?seed=Zara&backgroundColor=ffd5dc",
  "https://api.dicebear.com/7.x/big-smile/svg?seed=Kai&backgroundColor=c0aede",
  "https://api.dicebear.com/7.x/big-smile/svg?seed=Milo&backgroundColor=d1d4f9"
];
const BOT_AVATAR_URL = "https://api.dicebear.com/7.x/bottts/svg?seed=LastCardBot&backgroundColor=37474f";

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function getAvatarFor(player) {
  if (player.isBot || (player.id && (player.id.startsWith("bot:") || player.id.startsWith("local-bot")))) {
    return { url: BOT_AVATAR_URL, color: "#37474f" };
  }
  const seed = hashString(player.id || player.name || "player");
  const url = AVATAR_URLS[seed % AVATAR_URLS.length];
  return { url, color: "#1f2d25" };
}

function buildTimerRing() {
  // r=46, circumference ~= 289
  return (
    `<svg class="timer-ring" viewBox="0 0 100 100" aria-hidden="true">` +
    `<circle class="track" cx="50" cy="50" r="46"/>` +
    `<circle class="progress" cx="50" cy="50" r="46" pathLength="100" />` +
    `</svg>`
  );
}

// Seat positions as % of the viewport. Deck + discard live at the top-center,
// so opponents in 2-player rooms sit just below/beside them, never centered.
const OPPONENT_SEATS = {
  1: [{ xPct: 80, yPct: 26 }],
  2: [{ xPct: 18, yPct: 26 }, { xPct: 82, yPct: 26 }],
  3: [{ xPct: 14, yPct: 28 }, { xPct: 86, yPct: 28 }, { xPct: 86, yPct: 68 }],
  4: [
    { xPct: 12, yPct: 28 }, { xPct: 88, yPct: 28 },
    { xPct: 16, yPct: 66 }, { xPct: 84, yPct: 66 }
  ]
};
// Anchor the player's own tile to the bottom-LEFT, beside the hand strip,
// so it stays visible on every viewport regardless of how tall the hand gets.
const ME_SEAT = { xPct: 8, yPct: 88 };

function renderPlayers(room) {
  playersElement.innerHTML = "";
  const W = window.innerWidth;
  const H = window.innerHeight;

  const opponents = room.players.filter((p) => p.id !== socket.id);
  const seats = OPPONENT_SEATS[opponents.length] || [];

  room.players.forEach((player, index) => {
    const isMe = player.id === socket.id;
    let x;
    let y;

    if (isMe) {
      // Side-anchored: hugs the bottom-left corner so cards never cover it.
      // On narrow phones, push slightly inward so the tile isn't clipped.
      const minX = 70;          // tile half-width (~70px)
      x = Math.max(minX, (ME_SEAT.xPct / 100) * W);
      // Use visualViewport height when available — unaffected by URL-bar resize.
      const stableH = (window.visualViewport ? window.visualViewport.height : H);
      y = stableH - 110;
    } else {
      const oppIdx = opponents.findIndex((p) => p.id === player.id);
      const seat = seats[oppIdx] || { xPct: 50, yPct: 20 };
      x = (seat.xPct / 100) * W;
      y = (seat.yPct / 100) * H;
    }

    const item = document.createElement("div");
    item.className = "player";
    if (isMe) item.classList.add("is-me");
    item.style.left = `${x}px`;
    item.style.top = `${y}px`;
    item.dataset.playerId = player.id;

    const isActive = index === room.turn && !room.awaitingDeckDecision;
    const { url, color } = getAvatarFor(player);

    item.innerHTML = `
      <div class="player-name">${player.name}${isMe ? " (You)" : ""}</div>
      <div class="player-avatar" style="--avatar-bg:${color};">
        ${buildTimerRing()}
        <img class="avatar-face" src="${url}" alt="" />
        <span class="player-cards" title="cards in hand">${player.cardCount}</span>
      </div>
    `;

    if (isActive) item.classList.add("active");
    if (player.disconnected) item.classList.add("is-disconnected");

    playersElement.appendChild(item);
  });
}

socket.on("playerDropped", ({ playerName }) => {
  if (playerName) showToast(`${playerName} disconnected`, 1400);
});

function updateActiveTimerRing() {
  const activeAvatar = playersElement.querySelector(".player.active .timer-ring .progress");
  if (!activeAvatar) return;
  const endsAt = currentRoom?.turnEndsAt;
  if (!endsAt) {
    activeAvatar.style.strokeDashoffset = "0";
    return;
  }
  const total = 15000; // matches server TURN_DURATION_MS
  const remaining = Math.max(0, endsAt - Date.now());
  const progress = Math.min(1, remaining / total);
  // pathLength=100 → full ring when progress=1, empty when 0
  activeAvatar.style.strokeDashoffset = String(100 - progress * 100);
}

function render(room) {
  const prevTurnId = previousRoomSnapshot?.players?.[previousRoomSnapshot.turn]?.id;
  const curTurnId  = room.players?.[room.turn]?.id;
  currentRoom = room;
  roomLabel.innerText = `Room ${room.roomCode}`;
  startTurnTimer(room.turnEndsAt);
  renderHand(room);
  renderTopCard(room);
  renderPlayers(room);
  stackInfo.innerText = room.stackCount > 0 ? `Draw stack: +${room.stackCount}` : "";
  updateStackEffects(room);
  updateDirectionIndicator(room);
  announceCardEffect(room);
  renderDeckDecision(room);

  if (curTurnId === socket.id && curTurnId !== prevTurnId && room.started) {
    showYourTurnBanner();
  }

  previousRoomSnapshot = room;
}

function showYourTurnBanner() {
  let el = document.getElementById("yourTurnBanner");
  if (!el) {
    el = document.createElement("div");
    el.id = "yourTurnBanner";
    el.className = "your-turn-banner";
    el.innerHTML = `<span class="ytb-bolt">⚡</span><span>Your Turn!</span>`;
    document.body.appendChild(el);
  }
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
}

function updateDirectionIndicator(room) {
  const badge = document.getElementById("directionBadge");
  if (!badge) return;
  const dir = room.direction === -1 ? "ccw" : "cw";
  badge.dataset.direction = dir;
  if (previousRoomSnapshot && previousRoomSnapshot.direction !== room.direction) {
    restartAnimation(badge, "flipped");
    setTimeout(() => badge.classList.remove("flipped"), 620);
  }
}

let lastAnnouncedDiscardLen = 0;
function announceCardEffect(room) {
  const top = room.discard[room.discard.length - 1];
  if (!top) return;
  const len = room.discard.length;
  if (len <= lastAnnouncedDiscardLen) return; // only on genuinely new plays
  lastAnnouncedDiscardLen = len;
  if (!["reverse", "skip", "+2", "+4", "wild"].includes(top.value)) return;
  playSound("power");
  showPowerCardEffect(top);
}

function showPowerCardEffect(card) {
  const host = document.getElementById("powerEffect");
  if (!host) return;
  // Build a fresh child wrapper each call so its CSS animations always
  // (re)start from frame 0 — toggling classes on a recycled host is flaky
  // when two power cards land in quick succession.
  host.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "power-effect-instance show";
  wrap.style.cssText =
    "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;";
  wrap.innerHTML = buildPowerEffectHTML(card);
  host.classList.add("show"); // keeps backwards-compat with descendant `.power-effect.show .fx-*` selectors
  host.appendChild(wrap);
  setTimeout(() => {
    wrap.remove();
    if (!host.children.length) host.classList.remove("show");
  }, 1200);
}

function buildPowerEffectHTML(card) {
  const palette = {
    red: "#e53935", green: "#43a047", blue: "#1e88e5",
    yellow: "#fbc02d", black: "#222"
  };
  const color = palette[card.color] || "#ffd54f";

  if (card.value === "skip") {
    return `
      <div class="fx fx-skip">
        <svg viewBox="0 0 160 160">
          <circle cx="80" cy="80" r="62" fill="none" stroke="${color}" stroke-width="14"/>
          <line x1="36" y1="36" x2="124" y2="124" stroke="${color}" stroke-width="14" stroke-linecap="round"/>
        </svg>
        <div class="fx-label">Skipped!</div>
      </div>`;
  }

  if (card.value === "reverse") {
    return `
      <div class="fx fx-reverse">
        <svg viewBox="0 0 160 160">
          <path d="M40 60 A40 40 0 0 1 120 60" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"/>
          <polygon points="120,60 110,46 130,46" fill="${color}"/>
          <path d="M120 100 A40 40 0 0 1 40 100" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"/>
          <polygon points="40,100 50,114 30,114" fill="${color}"/>
        </svg>
        <div class="fx-label">Reverse!</div>
      </div>`;
  }

  if (card.value === "+2") {
    return `
      <div class="fx fx-plus2" style="--fx-color:${color};">
        <div class="mini-card mc1"></div>
        <div class="mini-card mc2"></div>
        <div class="fx-big">+2</div>
        <div class="fx-label">Draw Two!</div>
      </div>`;
  }

  if (card.value === "+4") {
    return `
      <div class="fx fx-plus4">
        <div class="color-burst">
          <span style="background:#e53935"></span>
          <span style="background:#fbc02d"></span>
          <span style="background:#43a047"></span>
          <span style="background:#1e88e5"></span>
        </div>
        <div class="fx-big">+4</div>
        <div class="fx-label">Draw Four!</div>
      </div>`;
  }

  if (card.value === "wild") {
    return `
      <div class="fx fx-wild">
        <svg viewBox="0 0 160 160" class="wild-wheel">
          <path d="M80 80 L80 10 A70 70 0 0 1 150 80 Z" fill="#e53935"/>
          <path d="M80 80 L150 80 A70 70 0 0 1 80 150 Z" fill="#fbc02d"/>
          <path d="M80 80 L80 150 A70 70 0 0 1 10 80 Z" fill="#43a047"/>
          <path d="M80 80 L10 80 A70 70 0 0 1 80 10 Z" fill="#1e88e5"/>
          <circle cx="80" cy="80" r="14" fill="#111"/>
        </svg>
        <div class="fx-label">Wild!</div>
      </div>`;
  }

  return "";
}

function restartAnimation(el, className) {
  if (!el) return;
  el.classList.remove(className);
  // force reflow so animation restarts
  void el.offsetWidth;
  el.classList.add(className);
}

function updateStackEffects(room) {
  const prevStack = previousRoomSnapshot?.stackCount || 0;
  const curStack = room.stackCount || 0;
  const top = room.discard[room.discard.length - 1];
  const topKey = top ? `${top.color}:${top.value}` : "";
  const topIsPower = top && (top.value === "+2" || top.value === "+4");

  // Stack grew → pulse the counter and shake the top card
  if (curStack > prevStack) {
    restartAnimation(stackInfo, "pulse");
    restartAnimation(topCardElement, "shake");
  }

  // Stack just went from >0 to 0, and top card is still a power card
  // → tell the next player to play by color
  if (prevStack > 0 && curStack === 0 && topIsPower) {
    stackClearedTopKey = topKey;
  }

  // Clear the hint as soon as a new card is placed on top
  if (stackClearedTopKey && stackClearedTopKey !== topKey) {
    stackClearedTopKey = null;
  }

  const showCleared = Boolean(stackClearedTopKey);
  topCardElement.classList.toggle("stack-cleared", showCleared);
  stackClearedHint.classList.toggle("show", showCleared);

  if (showCleared && top) {
    const glow = CARD_GLOW_COLORS[top.color] || CARD_GLOW_COLORS.black;
    topCardElement.style.setProperty("--glow", glow);
    stackClearedHint.style.setProperty("--glow", glow);
  } else {
    topCardElement.style.removeProperty("--glow");
    stackClearedHint.style.removeProperty("--glow");
  }
}

function resolveDeckDecision(action) {
  if (!currentRoom?.awaitingDeckDecision) {
    return;
  }

  socket.emit("resolveDeckDecision", { roomCode, action });
}

socket.on("connect", () => {
  updateMuteButton();

  if (currentRoom) {
    updateLobby(currentRoom);
    render(currentRoom);
  }
});

socket.on("roomCreated", (code) => {
  roomCode = code;
  setScreen("lobby");
});

socket.on("joinedRoom", (code) => {
  roomCode = code;
  setScreen("lobby");
});

socket.on("lobbyUpdated", (room) => {
  updateLobby(room);

  if (!room.started) {
    setScreen("lobby");
  }
});

socket.on("gameStarted", () => {
  colorPicker.style.display = "none";
  deckDecisionModal.style.display = "none";
  winnerModal.style.display = "none";
  previousRoomSnapshot = null;
  lastAnnouncedDiscardLen = 0;
  previousCardCount = 0;
  previousHandLength = 0;
  lastTopCardKey = "";
  lastTurnPlayerId = "";
  stackClearedTopKey = null;
  lastTickSecond = -1;
  pendingCard = null;
  pendingCardElement = null;
  pendingDrawSound = false;
  isPlayingCard = false;
  suppressNextDrawFlight = true;
  setScreen("game");
});

socket.on("yourCards", (cards) => {
  const cardDelta = cards.length - previousCardCount;
  const drawnCards = cardDelta > 0 ? cards.slice(cards.length - cardDelta) : [];
  myCards = cards;
  previousCardCount = cards.length;

  if (pendingDrawSound && cardDelta > 0) {
    pendingDrawSound = false;
  } else if (currentRoom?.started && cardDelta > 0 && currentRoom.players[currentRoom.turn]?.id === socket.id) {
    playSound("drawCard");
  }

  if (currentRoom?.started) {
    render(currentRoom);
    if (drawnCards.length && !suppressNextDrawFlight) {
      animateDrawFlight(drawnCards);
    }
    suppressNextDrawFlight = false;
  }
});

socket.on("updateGame", (room) => {
  // Detect an opponent card play: top card changed AND it wasn't our own play.
  // lastTurnPlayerId = active player from PREVIOUS update.
  // After a play, turn has already advanced, so previous-update's active was the player who just played.
  if (room.started && room.discard && room.discard.length > 0) {
    const newTop = room.discard[room.discard.length - 1];
    const newKey = `${newTop.color}:${newTop.value}`;
    const isOpponentPlay =
      newKey !== lastTopCardKey &&
      !isPlayingCard &&
      lastTurnPlayerId &&
      lastTurnPlayerId !== socket.id;

    if (isOpponentPlay) {
      animateOpponentPlayFlight(lastTurnPlayerId, newTop);
    }
  }

  // Record who is active on THIS update so the next update knows who played.
  if (room.started && room.players && room.players[room.turn]) {
    lastTurnPlayerId = room.players[room.turn].id;
  } else {
    lastTurnPlayerId = "";
  }

  currentRoom = room;
  roomCode = room.roomCode;
  setScreen("game");
  render(room);
});

socket.on("penalty", () => {
  playSound("penalty");
  haptic("medium");
  showToast("Penalty applied");
});

socket.on("deckEmpty", () => {
  showToast("Main deck is empty", 1200);
});

socket.on("invalidMove", (message) => {
  playSound("invalidMove");
  haptic("warning");
  showToast(message || "Invalid move", 1200);
  // Restore any card hidden by the optimistic play-flight animation
  if (pendingCardElement) {
    pendingCardElement.style.visibility = "";
    pendingCardElement = null;
  }
  pendingCardRect = null;
  handElement.querySelectorAll(".card").forEach((el) => {
    el.style.visibility = "";
  });
  pendingCard = null;
  isPlayingCard = false;
  pendingDrawSound = false;
});

socket.on("leftRoom", () => {
  clearSession();
  clearInterval(timerInterval);
  stopSound("timerTick");
  currentRoom = null;
  roomCode = null;
  myCards = [];
  pendingCard = null;
  pendingCardElement = null;
  pendingCardRect = null;
  isPlayingCard = false;
  colorPicker.style.display = "none";
  deckDecisionModal.style.display = "none";
  winnerModal.style.display = "none";
  setScreen("menu");
});

socket.on("unoCalled", ({ playerName }) => {
  playSound("unoCall");

  if (playerName) {
    showToast(`${playerName} called Last Card!`, 1000);
  }
});

socket.on("roomError", (message) => {
  showToast(message || "Room error", 1600);
  playSound("invalidMove");
});

socket.on("rematchUpdate", ({ votes, required }) => {
  const label = document.getElementById("rematchLabel");
  if (!label) return;
  if (votes < required) {
    label.innerText = `Waiting (${votes}/${required})`;
  }
});

socket.on("gameOver", (winnerName) => {
  clearInterval(timerInterval);
  stopSound("timerTick");
  pendingCard = null;
  pendingCardElement = null;
  pendingCardRect = null;
  isPlayingCard = false;
  colorPicker.style.display = "none";
  deckDecisionModal.style.display = "none";
  playSound("win");
  haptic("success");
  winnerNameElement.innerText = winnerName;
  winnerModal.style.display = "flex";
  resetRematchButton();
  burstConfetti();

  // Refresh stats so the menu reflects the result the next time the player goes back.
  if (userProfile && userProfile.userId) socket.emit("requestStats");
});

/* ----------------------- Emoji reactions ----------------------- */
function toggleReactionPopover(event) {
  if (event) event.stopPropagation();
  const pop = document.getElementById("reactionPopover");
  const fab = document.getElementById("emojiFab");
  if (!pop) return;

  if (pop.hidden && fab) {
    const rect = fab.getBoundingClientRect();
    pop.style.position = "fixed";
    // Open upward, right-aligned with the FAB.
    pop.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    pop.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    pop.style.top = "auto";
    pop.style.left = "auto";
  }

  pop.hidden = !pop.hidden;
}

function sendReaction(emoji) {
  socket.emit("sendReaction", emoji);
  document.getElementById("reactionPopover").hidden = true;
  // Show locally too for instant feedback
  spawnReactionAt(emoji, getOwnAnchor());
}

function getOwnAnchor() {
  // Anchor below the hand for own reactions; near the player avatar for others.
  return { x: window.innerWidth / 2, y: window.innerHeight - 180 };
}

function getPlayerAnchor(playerId) {
  const el = document.querySelector(`.player[data-player-id="${playerId}"]`);
  if (!el) return getOwnAnchor();
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function spawnReactionAt(emoji, anchor) {
  // Floating emoji
  const el = document.createElement("div");
  el.className = "reaction-float";
  el.textContent = emoji;
  const drift = (Math.random() * 80) - 40;
  const tilt  = (Math.random() * 30) - 15;
  el.style.left = `${anchor.x}px`;
  el.style.top = `${anchor.y}px`;
  el.style.setProperty("--rx", `${drift}px`);
  el.style.setProperty("--rot", `${tilt}deg`);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);

  // Burst ring
  const ring = document.createElement("div");
  ring.className = "reaction-ring";
  ring.style.left = `${anchor.x}px`;
  ring.style.top = `${anchor.y}px`;
  document.body.appendChild(ring);
  setTimeout(() => ring.remove(), 700);

  // Mini sparkles
  for (let i = 0; i < 4; i += 1) {
    const dot = document.createElement("div");
    dot.className = "reaction-spark";
    dot.textContent = emoji;
    const angle = (Math.PI * 2 * i) / 4 + Math.random() * 0.6;
    const dist = 40 + Math.random() * 24;
    dot.style.left = `${anchor.x}px`;
    dot.style.top = `${anchor.y}px`;
    dot.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    dot.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 900);
  }
}

document.addEventListener("click", (e) => {
  const pop = document.getElementById("reactionPopover");
  const fab = document.getElementById("emojiFab");
  if (!pop || pop.hidden) return;
  if (pop.contains(e.target) || (fab && fab.contains(e.target))) return;
  pop.hidden = true;
});

socket.on("reaction", ({ playerId, emoji }) => {
  if (playerId === socket.id) return; // already shown locally
  spawnReactionAt(emoji, getPlayerAnchor(playerId));
});

function burstConfetti() {
  const host = document.createElement("div");
  host.className = "confetti-burst";
  document.body.appendChild(host);

  const colors = ["#e53935", "#fbc02d", "#43a047", "#1e88e5", "#ffe680", "#ff7043", "#ab47bc"];
  const count = 80;
  for (let i = 0; i < count; i += 1) {
    const piece = document.createElement("span");
    const color = colors[Math.floor(Math.random() * colors.length)];
    const angle = Math.random() * Math.PI * 2;
    const dist = 200 + Math.random() * 320;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 80; // bias upward
    const rot = Math.random() * 720 - 360;
    const dur = 1200 + Math.random() * 900;
    piece.style.cssText =
      `background:${color};` +
      `--dx:${dx}px;--dy:${dy}px;--rot:${rot}deg;` +
      `animation-duration:${dur}ms;` +
      `animation-delay:${Math.random() * 120}ms;`;
    host.appendChild(piece);
  }

  setTimeout(() => host.remove(), 2400);
}

["click", "touchstart", "keydown"].forEach((eventName) => {
  window.addEventListener(eventName, unlockAudio, { once: true });
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancelColorPicker();
});

loadMutePreference();
updateMuteButton();
updateMusicButton();

/* ----------------------- How to Play tutorial ----------------------- */
const TUTORIAL_KEY = "lcb-tutorial-seen-v1";
const tutorialModal = document.getElementById("tutorialModal");
const tutorialStage = document.getElementById("tutorialStage");
const tutorialDots = document.getElementById("tutorialDots");
const tutorialNextBtn = document.getElementById("tutorialNext");
const tutorialBackBtn = document.getElementById("tutorialBack");
let tutorialStep = 0;

const tutorialSteps = [
  {
    title: "Welcome to Last Card Battle",
    body: "A fast-paced card duel for 2–5 players. Be the first to empty your hand to win.",
    art: `
      <div class="tut-stack">
        <div class="tut-card red">7</div>
        <div class="tut-card yellow">4</div>
        <div class="tut-card blue">2</div>
      </div>`
  },
  {
    title: "Match color or value",
    body: "On your turn, play one card from your hand that matches the top card's <b>color</b> or <b>value</b>. If you can't, draw one.",
    art: `
      <div class="tut-row">
        <div class="tut-card blue tut-top">5</div>
        <div class="tut-arrow">→</div>
        <div class="tut-card-group">
          <div class="tut-card blue">8</div>
          <div class="tut-card red">5</div>
        </div>
      </div>
      <p class="tut-caption">Same color (blue) or same value (5) is playable.</p>`
  },
  {
    title: "Tap the deck to draw",
    body: "No playable card? <b>Tap the deck</b> in the center of the table to draw. The drawn card auto-plays if it's playable; otherwise it stays in your hand and the turn passes.",
    art: `
      <div class="tut-row tut-deck-demo">
        <div class="tut-deck">
          <div class="tut-deck-card"></div>
          <div class="tut-deck-card"></div>
          <div class="tut-deck-card tut-deck-top">?</div>
        </div>
        <div class="tut-arrow">↑</div>
      </div>
      <p class="tut-caption">Tap to draw — no Draw button needed.</p>`
  },
  {
    title: "Power cards",
    body: `
      <ul class="tut-list">
        <li><b>Skip</b> — next player loses their turn</li>
        <li><b>Reverse</b> — flips turn direction</li>
        <li><b>+2</b> — next player draws 2</li>
        <li><b>Wild</b> — choose any color</li>
        <li><b>+4</b> — choose color, next draws 4</li>
      </ul>`,
    art: `
      <div class="tut-row">
        <div class="tut-card red tut-power">⊘</div>
        <div class="tut-card green tut-power">⟲</div>
        <div class="tut-card yellow tut-power">+2</div>
        <div class="tut-card black tut-power">+4</div>
      </div>`
  },
  {
    title: "Stacking +2 and +4",
    body: "If a +2 or +4 lands on you, you can <b>stack another +2/+4</b> to pass the penalty along — otherwise you must draw the full stack.",
    art: `
      <div class="tut-row">
        <div class="tut-card red">+2</div>
        <div class="tut-arrow">+</div>
        <div class="tut-card blue">+2</div>
        <div class="tut-arrow">=</div>
        <div class="tut-card-stack">+4 to next!</div>
      </div>`
  },
  {
    title: "Last Card!",
    body: "When you have <b>one card left</b>, the game auto-calls Last Card. If you forget the call before someone else does, you draw 2 as penalty.",
    art: `
      <div class="tut-row tut-uno">
        <div class="tut-card yellow">3</div>
        <div class="tut-shout">LAST<br/>CARD!</div>
      </div>`
  },
  {
    title: "You're ready!",
    body: "Create a room to invite friends, join with a code, or practice against the bot. Good luck out there.",
    art: `
      <div class="tut-trophy">🏆</div>`
  }
];

function renderTutorialStep() {
  const step = tutorialSteps[tutorialStep];
  tutorialStage.innerHTML = `
    <div class="tut-art">${step.art || ""}</div>
    <h3 class="tut-title">${step.title}</h3>
    <div class="tut-body">${step.body}</div>
  `;

  tutorialDots.innerHTML = tutorialSteps
    .map((_, i) => `<span class="tut-dot${i === tutorialStep ? " active" : ""}"></span>`)
    .join("");

  tutorialBackBtn.style.display = tutorialStep === 0 ? "none" : "";
  tutorialNextBtn.innerText = tutorialStep === tutorialSteps.length - 1 ? "Got it" : "Next";
}

function openTutorial() {
  tutorialStep = 0;
  tutorialModal.style.display = "flex";
  renderTutorialStep();
}

function closeTutorial() {
  tutorialModal.style.display = "none";
  try { localStorage.setItem(TUTORIAL_KEY, "1"); } catch {}
}

function tutorialNext() {
  if (tutorialStep >= tutorialSteps.length - 1) {
    closeTutorial();
    return;
  }
  tutorialStep += 1;
  renderTutorialStep();
}

function tutorialPrev() {
  if (tutorialStep === 0) return;
  tutorialStep -= 1;
  renderTutorialStep();
}

// (Tutorial auto-opens on first gameStarted instead of on page load — see below)

window.addEventListener("resize", () => {
  if (currentRoom?.started) {
    renderPlayers(currentRoom);
  }
});

/* ============================================================
   Landing v2 — routing, settings, leaderboard, name prompt
   ============================================================ */

const LANDING_EL    = document.getElementById("menu");
const FRIENDS_EL    = document.getElementById("friendsMenu");
const SETTINGS_EL   = document.getElementById("settingsModal");
const LEADERBD_EL   = document.getElementById("leaderboardModal");
const NAME_PROMPT   = document.getElementById("namePromptModal");

let pendingFlow = null; // "friends" | "bots" — set when name prompt opens

/* ---------- Sync hidden #name with profile / friendsName input ---------- */
function syncNameField() {
  const hidden = document.getElementById("name");
  if (!hidden) return;
  const fromFriends = document.getElementById("friendsName")?.value?.trim();
  if (fromFriends) {
    hidden.value = fromFriends;
    return;
  }
  if (userProfile && userProfile.name) hidden.value = userProfile.name;
}

/* Pre-fill friendsName from saved profile */
window.addEventListener("DOMContentLoaded", () => {
  const friendsInput = document.getElementById("friendsName");
  if (friendsInput && userProfile && userProfile.name) {
    friendsInput.value = userProfile.name;
  }
  syncNameField();
  updateSettingsSwitches();
});

/* ---------- Routing ---------- */
function goToLanding() {
  if (FRIENDS_EL) FRIENDS_EL.style.display = "none";
  if (LANDING_EL) LANDING_EL.style.display = "";
}

function goToFriends() {
  unlockAudio();
  if (LANDING_EL) LANDING_EL.style.display = "none";
  if (FRIENDS_EL) FRIENDS_EL.style.display = "";
  // Pre-fill name from profile
  const friendsInput = document.getElementById("friendsName");
  if (friendsInput && !friendsInput.value && userProfile?.name) {
    friendsInput.value = userProfile.name;
  }
  syncNameField();
}

function goToBots() {
  unlockAudio();
  // If no name set, prompt first
  const haveName = (userProfile && userProfile.name) ||
                   document.getElementById("name")?.value?.trim();
  if (!haveName) {
    pendingFlow = "bots";
    openNamePrompt();
    return;
  }
  syncNameField();
  openBotDifficulty();
}

function persistTypedName(name) {
  if (!name) return;
  // Persist locally
  if (userProfile) {
    if (userProfile.name !== name) {
      userProfile.name = name;
      writeProfile(userProfile);
    }
  } else {
    writeProfile({ name });
  }
  // Push to server so the leaderboard reflects the real name
  try { socket.emit("updateProfile", { name }); } catch {}
}

function createRoomFromFriends() {
  syncNameField();
  const name = document.getElementById("friendsName")?.value?.trim();
  if (!name) {
    pendingFlow = "create";
    openNamePrompt();
    return;
  }
  persistTypedName(name);
  // Hidden #name is now in sync; reuse existing logic
  createRoom();
}

function joinRoomFromFriends() {
  syncNameField();
  const name = document.getElementById("friendsName")?.value?.trim();
  if (!name) {
    pendingFlow = "join";
    openNamePrompt();
    return;
  }
  persistTypedName(name);
  joinRoom();
}

/* ---------- Name prompt (first-time) ---------- */
function openNamePrompt() {
  if (!NAME_PROMPT) return;
  NAME_PROMPT.style.display = "flex";
  const input = document.getElementById("namePromptInput");
  if (input) {
    input.value = userProfile?.name || "";
    setTimeout(() => input.focus(), 50);
  }
}

function closeNamePrompt() {
  if (NAME_PROMPT) NAME_PROMPT.style.display = "none";
}

function submitNamePrompt() {
  const input = document.getElementById("namePromptInput");
  const value = (input?.value || "").trim();
  if (!value) {
    input?.focus();
    return;
  }
  // Sync into hidden #name + friendsName + persist via existing profile flow
  const hidden = document.getElementById("name");
  if (hidden) hidden.value = value;
  const friends = document.getElementById("friendsName");
  if (friends) friends.value = value;
  // Persist locally so future visits skip the prompt
  if (userProfile) {
    userProfile.name = value;
    writeProfile(userProfile);
  } else {
    writeProfile({ name: value });
  }
  // Inform server too if connected
  try { socket.emit("updateProfile", { name: value }); } catch {}

  closeNamePrompt();

  // Continue the flow the user picked
  const flow = pendingFlow;
  pendingFlow = null;
  if (flow === "bots")   { openBotDifficulty(); return; }
  if (flow === "create") { createRoom();        return; }
  if (flow === "join")   { joinRoom();          return; }
}

/* ---------- Settings panel ---------- */
function openSettings() {
  unlockAudio();
  if (!SETTINGS_EL) return;
  SETTINGS_EL.style.display = "flex";
  // Show "Leave Room" only when actually in a room
  const leaveBtn = document.getElementById("leaveRoomSetting");
  if (leaveBtn) {
    leaveBtn.style.display = currentRoom ? "" : "none";
  }
  updateSettingsSwitches();
}

function closeSettings() {
  if (SETTINGS_EL) SETTINGS_EL.style.display = "none";
}

function updateSettingsSwitches() {
  const sfx = document.getElementById("sfxToggle");
  if (sfx) {
    const on = !isMuted;
    sfx.classList.toggle("is-on", on);
    sfx.setAttribute("aria-checked", String(on));
  }
  const music = document.getElementById("musicToggle");
  if (music) {
    const on = !isMusicMuted;
    music.classList.toggle("is-on", on);
    music.setAttribute("aria-checked", String(on));
  }
}

function toggleSfx() {
  // Reuse existing toggleMute (which handles SFX + linked BGM logic).
  toggleMute();
  updateSettingsSwitches();
}

function toggleMusicV2() {
  // Reuse existing toggleMusic (handles unlock + persistence).
  toggleMusic();
  updateSettingsSwitches();
}

/* ---------- Leaderboard ---------- */
function openLeaderboard() {
  unlockAudio();
  if (!LEADERBD_EL) return;
  LEADERBD_EL.style.display = "flex";

  const list = document.getElementById("leaderboardList");
  if (list) list.innerHTML = '<div class="lb-empty">Loading leaderboard…</div>';

  try { socket.emit("requestLeaderboard", { limit: 20 }); } catch {}
}

function closeLeaderboard() {
  if (LEADERBD_EL) LEADERBD_EL.style.display = "none";
}

function _escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

socket.on("leaderboard", ({ rows, myUserId, error } = {}) => {
  const list = document.getElementById("leaderboardList");
  if (!list) return;
  if (error) {
    list.innerHTML = '<div class="lb-empty">Couldn\'t load leaderboard. Try again later.</div>';
    return;
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    list.innerHTML = '<div class="lb-empty">No games played yet. Be the first to win!</div>';
    return;
  }
  const html = rows.map((r) => {
    const isMe = myUserId && r.userId === myUserId;
    const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `#${r.rank}`;
    return `
      <div class="lb-row${isMe ? " is-me" : ""}">
        <span class="lb-col-rank">${medal}</span>
        <span class="lb-col-name">${_escapeHtml(r.name)}${isMe ? ' <em class="lb-you">you</em>' : ""}</span>
        <span class="lb-col-wins">${r.wins}</span>
        <span class="lb-col-losses">${r.losses}</span>
        <span class="lb-col-streak">${r.bestStreak}</span>
      </div>`;
  }).join("");
  list.innerHTML = html;
});

/* ---------- Auto-tutorial on first gameStarted ---------- */
const FIRST_GAME_KEY = "lcb-tutorial-shown-v1";
socket.on("gameStarted", () => {
  try {
    if (!localStorage.getItem(FIRST_GAME_KEY) && !localStorage.getItem(TUTORIAL_KEY)) {
      // Slight delay so the deal animation can settle first
      setTimeout(() => {
        openTutorial();
        localStorage.setItem(FIRST_GAME_KEY, "1");
      }, 600);
    }
  } catch {}
});

/* Keyboard: Enter inside name prompt submits */
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && NAME_PROMPT && NAME_PROMPT.style.display === "flex") {
    e.preventDefault();
    submitNamePrompt();
  }
});

/* ---------- Android hardware back button (Capacitor) ----------
   Step-by-step back: close any open modal first, otherwise navigate
   one screen back. Exits app only when on the landing page. */
function handleHardwareBack() {
  const isVisible = (el) => {
    if (!el) return false;
    // Use computed style — inline style.display="" is treated as visible.
    return getComputedStyle(el).display !== "none";
  };

  // 1. Close top-most modal/overlay if open
  const overlays = [
    { el: document.getElementById("settingsModal"),     close: () => closeSettings()    },
    { el: document.getElementById("tutorialModal"),     close: () => closeTutorial()    },
    { el: document.getElementById("botDifficultyModal"),close: () => closeBotDifficulty()},
    { el: document.getElementById("leaderboardModal"),  close: () => closeLeaderboard() },
    { el: document.getElementById("colorPicker"),       close: () => {
        document.getElementById("colorPicker").style.display = "none";
        // Reset pending wild-card state so the card returns to hand cleanly.
        if (pendingCardElement && document.body.contains(pendingCardElement)) {
          pendingCardElement.style.visibility = "";
        }
        pendingCard = null;
        pendingCardElement = null;
        pendingCardRect = null;
      } },
    { el: document.getElementById("winnerModal"),       close: () => { document.getElementById("winnerModal").style.display = "none"; } },
    { el: document.getElementById("namePromptModal"),   close: () => { /* keep — required */ } },
    { el: document.getElementById("challengeModal"),    close: () => { document.getElementById("challengeModal").style.display = "none"; } },
    { el: document.getElementById("deckDecisionModal"), close: () => { document.getElementById("deckDecisionModal").style.display = "none"; } },
  ];
  for (const o of overlays) {
    if (isVisible(o.el)) { o.close(); return true; }
  }

  // 2. Screen-level back navigation
  const screen = document.body.dataset.screen;
  const friends = document.getElementById("friendsMenu");
  if (isVisible(friends)) { goToLanding(); return true; }
  if (screen === "lobby" || screen === "game") {
    if (confirm("Leave the current room?")) leaveRoom();
    return true;
  }
  // 3. On the landing page → let OS handle (exit app)
  return false;
}

document.addEventListener("DOMContentLoaded", () => {
  const Cap = window.Capacitor;
  if (Cap && Cap.Plugins && Cap.Plugins.App) {
    Cap.Plugins.App.addListener("backButton", () => {
      const handled = handleHardwareBack();
      if (!handled) Cap.Plugins.App.exitApp();
    });
  }
});
