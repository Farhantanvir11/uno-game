const socket = io();

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
let pendingCardElement = null;
let suppressNextDrawFlight = false;
let audioUnlocked = false;
let pendingDrawSound = false;
let isMuted = false;
let timerCountdownPlayed = false;
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
  penalty: new Audio("/sounds/penalty.mp3")
};

Object.values(soundEffects).forEach((audio) => {
  audio.preload = "auto";
});

function getNameValue() {
  return document.getElementById("name").value.trim();
}

function setScreen(screen) {
  menuScreen.style.display = screen === "menu" ? "block" : "none";
  lobbyScreen.style.display = screen === "lobby" ? "block" : "none";
  gameScreen.style.display = screen === "game" ? "block" : "none";
}

function unlockAudio() {
  if (audioUnlocked) {
    return;
  }

  audioUnlocked = true;
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
  muteButton.innerText = isMuted ? "Sound: Off" : "Sound: On";
}

function toggleMute() {
  isMuted = !isMuted;
  saveMutePreference();
  updateMuteButton();
}

function playSound(name) {
  const audio = soundEffects[name];
  if (!audio || !audioUnlocked || isMuted) {
    return;
  }

  audio.currentTime = 0;
  audio.play().catch(() => {});
}

function stopSound(name) {
  const audio = soundEffects[name];
  if (!audio) {
    return;
  }

  audio.pause();
  audio.currentTime = 0;
}

function closeWinnerModal() {
  winnerModal.style.display = "none";
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

  playSound("buttonPress");
  roomCode = code;
  socket.emit("joinRoom", { roomCode: code, playerName: name });
}

function startBotMatch() {
  unlockAudio();
  const name = getNameValue();
  if (!name) {
    alert("Enter your name first.");
    return;
  }

  playSound("buttonPress");
  socket.emit("startBotMatch", name);
}

function startGame() {
  unlockAudio();
  if (!roomCode) {
    return;
  }

  playSound("buttonPress");
  socket.emit("startGame", {
    roomCode,
    cards: cardCountSelect.value
  });
}

function drawCard() {
  if (!currentRoom || currentRoom.players[currentRoom.turn]?.id !== socket.id) {
    alert("It is not your turn.");
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
}

function chooseColor(color) {
  colorPicker.style.display = "none";

  if (!pendingCard) {
    return;
  }

  playSound("cardPlay");

  const card = pendingCard;
  const sourceEl = pendingCardElement;
  pendingCard = null;
  pendingCardElement = null;

  const emit = () => socket.emit("playCard", { roomCode, card, chosenColor: color });

  if (sourceEl && document.body.contains(sourceEl)) {
    animatePlayFlight(sourceEl, { ...card, color }, emit);
  } else {
    emit();
  }
}

function updateLobby(room) {
  currentRoom = room;
  roomCode = room.roomCode;
  roomTitle.innerText = `Room: ${room.roomCode}`;
  roomStatus.innerText = `Players: ${room.players.length}/5`;
  roomLabel.innerText = `Room ${room.roomCode}`;
  startButton.disabled = socket.id !== room.hostId || room.players.length < 2;

  lobbyPlayers.innerHTML = "";

  room.players.forEach((player) => {
    const item = document.createElement("li");
    const hostLabel = player.id === room.hostId ? " (Host)" : "";
    item.innerText = `${player.name}${hostLabel}`;
    lobbyPlayers.appendChild(item);
  });
}

function startTurnTimer(turnEndsAt) {
  clearInterval(timerInterval);
  timerCountdownPlayed = false;
  stopSound("timerTick");

  if (!turnEndsAt) {
    timerLabel.innerText = "Time: -";
    return;
  }

  const renderTime = () => {
    const secondsLeft = Math.max(0, Math.ceil((turnEndsAt - Date.now()) / 1000));
    timerLabel.innerText = `Time: ${secondsLeft}`;
    updateActiveTimerRing();

    const isMyTurn = currentRoom?.players?.[currentRoom.turn]?.id === socket.id;
    if (isMyTurn && secondsLeft === 5 && !timerCountdownPlayed) {
      playSound("timerTick");
      timerCountdownPlayed = true;
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

  if (card.value === "wild" || card.value === "+4") {
    pendingCard = card;
    pendingCardElement = sourceEl || null;
    colorPicker.style.display = "flex";
    return;
  }

  playSound("cardPlay");
  if (sourceEl) {
    animatePlayFlight(sourceEl, card, () => {
      socket.emit("playCard", { roomCode, card });
    });
  } else {
    socket.emit("playCard", { roomCode, card });
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

      requestAnimationFrame(() => {
        flying.style.transform = `translate(${dx}px, ${dy}px) rotate(${
          (Math.random() * 10 - 5).toFixed(1)
        }deg)`;
      });

      // Flip face-up near the end of the flight.
      setTimeout(() => flying.classList.add("flipped"), 360);

      // Settle: reveal the real card, fade out the clone.
      setTimeout(() => {
        if (targetEl) targetEl.style.visibility = "";
        flying.style.transition = "opacity 160ms ease";
        flying.style.opacity = "0";
      }, 640);

      setTimeout(() => flying.remove(), 820);
    }, i * 110);
  });
}

function animatePlayFlight(sourceEl, card, onComplete) {
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
  flying.innerHTML = `
    <div class="flip-inner">
      <div class="flip-face back">${buildCardBackHTML()}</div>
      <div class="flip-face front">${buildCardFaceHTML(card)}</div>
    </div>`;
  document.body.appendChild(flying);

  const dx = topRect.left - startRect.left;
  const dy = topRect.top - startRect.top;
  const spin = (Math.random() * 30 - 15).toFixed(1);

  requestAnimationFrame(() => {
    flying.style.transform = `translate(${dx}px, ${dy}px) rotate(${spin}deg) scale(1.08)`;
  });

  setTimeout(() => {
    flying.remove();
    onComplete();
  }, 460);
}

function renderHand(room) {
  handElement.innerHTML = "";
  const isMyTurn = room.players[room.turn]?.id === socket.id && !room.awaitingDeckDecision;

  myCards.forEach((card) => {
    const cardElement = document.createElement("button");
    cardElement.className = `card ${card.color}`;
    cardElement.innerHTML = buildCardInnerHTML(card);
    cardElement.disabled = !isMyTurn;

    if (isMyTurn) {
      cardElement.addEventListener("click", () => playCard(card, cardElement));
    }

    handElement.appendChild(cardElement);
  });

  previousHandLength = myCards.length;

  unoButton.style.display = myCards.length === 1 ? "inline-block" : "none";
  drawButton.disabled = !isMyTurn;
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
  if (player.id && player.id.startsWith("bot:")) {
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
const ME_SEAT = { xPct: 50, yPct: 80 };

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
      x = (ME_SEAT.xPct / 100) * W;
      // Keep the tile above the hand strip regardless of viewport height
      y = Math.min((ME_SEAT.yPct / 100) * H, H - 200);
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

    playersElement.appendChild(item);
  });
}

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

  previousRoomSnapshot = room;
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

function announceCardEffect(room) {
  const top = room.discard[room.discard.length - 1];
  if (!top) return;
  const prevDiscardLen = previousRoomSnapshot?.discard?.length || 0;
  if (room.discard.length <= prevDiscardLen) return; // only on new plays
  if (!["reverse", "skip", "+2", "+4", "wild"].includes(top.value)) return;
  showPowerCardEffect(top);
}

function showPowerCardEffect(card) {
  const host = document.getElementById("powerEffect");
  if (!host) return;
  host.innerHTML = buildPowerEffectHTML(card);
  host.classList.remove("show");
  void host.offsetWidth;
  host.classList.add("show");
  setTimeout(() => host.classList.remove("show"), 1200);
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
  previousCardCount = 0;
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
  currentRoom = room;
  roomCode = room.roomCode;
  setScreen("game");
  render(room);
});

socket.on("penalty", () => {
  playSound("penalty");
  showToast("Penalty applied");
});

socket.on("deckEmpty", () => {
  showToast("Main deck is empty", 1200);
});

socket.on("invalidMove", (message) => {
  playSound("invalidMove");
  showToast(message || "Invalid move", 1200);
});

socket.on("unoCalled", ({ playerName }) => {
  playSound("unoCall");

  if (playerName) {
    showToast(`${playerName} called Last Card!`, 1000);
  }
});

socket.on("roomError", (message) => {
  alert(message);
});

socket.on("gameOver", (winnerName) => {
  clearInterval(timerInterval);
  stopSound("timerTick");
  pendingCard = null;
  colorPicker.style.display = "none";
  deckDecisionModal.style.display = "none";
  playSound("win");
  winnerNameElement.innerText = winnerName;
  winnerModal.style.display = "flex";
});

["click", "touchstart", "keydown"].forEach((eventName) => {
  window.addEventListener(eventName, unlockAudio, { once: true });
});

loadMutePreference();
updateMuteButton();

window.addEventListener("resize", () => {
  if (currentRoom?.started) {
    renderPlayers(currentRoom);
  }
});
