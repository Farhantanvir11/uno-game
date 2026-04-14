const socket = io();

let roomCode = "";
let myCards = [];
let currentRoom = null;
let pendingCard = null;
let timerInterval = null;
let toastTimeout = null;
let previousRoomSnapshot = null;
let previousCardCount = 0;
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
  socket.emit("playCard", {
    roomCode,
    card: pendingCard,
    chosenColor: color
  });

  pendingCard = null;
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
  timerInterval = setInterval(renderTime, 250);
}

function playCard(card) {
  if (!currentRoom || currentRoom.players[currentRoom.turn]?.id !== socket.id) {
    return;
  }

  if (card.value === "wild" || card.value === "+4") {
    pendingCard = card;
    colorPicker.style.display = "flex";
    return;
  }

  playSound("cardPlay");
  socket.emit("playCard", { roomCode, card });
}

function getCardLabel(card) {
  return card.value === "reverse" ? "🔁" : card.value;
}

function renderHand(room) {
  handElement.innerHTML = "";
  const isMyTurn = room.players[room.turn]?.id === socket.id && !room.awaitingDeckDecision;

  myCards.forEach((card) => {
    const cardElement = document.createElement("button");
    cardElement.className = `card ${card.color}`;
    cardElement.innerText = getCardLabel(card);
    cardElement.disabled = !isMyTurn;

    if (isMyTurn) {
      cardElement.addEventListener("click", () => playCard(card));
    }

    handElement.appendChild(cardElement);
  });

  unoButton.style.display = myCards.length === 1 ? "inline-block" : "none";
  drawButton.disabled = !isMyTurn;
}

function renderTopCard(room) {
  const top = room.discard[room.discard.length - 1];
  if (!top) {
    topCardElement.innerHTML = "";
    return;
  }

  topCardElement.innerHTML = `<div class="card ${top.color}">${getCardLabel(top)}</div>`;
}

function renderPlayers(room) {
  playersElement.innerHTML = "";
  const totalPlayers = room.players.length;
  const radius = 180;
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2 - 90;

  room.players.forEach((player, index) => {
    const angle = (index / totalPlayers) * Math.PI * 2 - Math.PI / 2;
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;

    const item = document.createElement("div");
    item.className = "player";
    item.style.left = `${x}px`;
    item.style.top = `${y}px`;

    const isActive = index === room.turn;
    const isMe = player.id === socket.id;
    const meLabel = isMe ? " (You)" : "";

    item.innerText = `${player.name}${meLabel}\n${player.cardCount} cards`;

    if (isActive) {
      item.classList.add("active");
    }

    playersElement.appendChild(item);
  });
}

function render(room) {
  currentRoom = room;
  roomLabel.innerText = `Room ${room.roomCode}`;
  startTurnTimer(room.turnEndsAt);
  renderHand(room);
  renderTopCard(room);
  renderPlayers(room);
  stackInfo.innerText = room.stackCount > 0 ? `Draw stack: +${room.stackCount}` : "";
  renderDeckDecision(room);

  previousRoomSnapshot = room;
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
  myCards = cards;
  previousCardCount = cards.length;

  if (pendingDrawSound && cardDelta > 0) {
    pendingDrawSound = false;
  } else if (currentRoom?.started && cardDelta > 0 && currentRoom.players[currentRoom.turn]?.id === socket.id) {
    playSound("drawCard");
  }

  if (currentRoom?.started) {
    render(currentRoom);
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
    showToast(`${playerName} called UNO!`, 1000);
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
