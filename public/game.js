const socket = io();

let roomCode = "";
let myCards = [];
let currentRoom = null;
let pendingCard = null;
let timerInterval = null;
let toastTimeout = null;

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
const colorPicker = document.getElementById("colorPicker");
const toast = document.getElementById("toast");
const deckDecisionModal = document.getElementById("deckDecisionModal");
const deckDecisionText = document.getElementById("deckDecisionText");
const deckDecisionActions = document.getElementById("deckDecisionActions");
const shuffleDeckBtn = document.getElementById("shuffleDeckBtn");
const winnerModal = document.getElementById("winnerModal");
const winnerNameElement = document.getElementById("winnerName");

function getNameValue() {
  return document.getElementById("name").value.trim();
}

function setScreen(screen) {
  menuScreen.style.display = screen === "menu" ? "block" : "none";
  lobbyScreen.style.display = screen === "lobby" ? "block" : "none";
  gameScreen.style.display = screen === "game" ? "block" : "none";
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
  const name = getNameValue();
  if (!name) {
    alert("Enter your name first.");
    return;
  }

  socket.emit("createRoom", name);
}

function joinRoom() {
  const name = getNameValue();
  const code = document.getElementById("roomCode").value.trim().toUpperCase();

  if (!name || !code) {
    alert("Enter your name and room code.");
    return;
  }

  roomCode = code;
  socket.emit("joinRoom", { roomCode: code, playerName: name });
}

function startGame() {
  if (!roomCode) {
    return;
  }

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

  socket.emit("drawCard", roomCode);
}

function callUNO() {
  socket.emit("uno", roomCode);
  unoButton.style.display = "none";
}

function chooseColor(color) {
  colorPicker.style.display = "none";

  if (!pendingCard) {
    return;
  }

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

  if (!turnEndsAt) {
    timerLabel.innerText = "Time: -";
    return;
  }

  const renderTime = () => {
    const secondsLeft = Math.max(0, Math.ceil((turnEndsAt - Date.now()) / 1000));
    timerLabel.innerText = `Time: ${secondsLeft}`;

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
}

function resolveDeckDecision(action) {
  if (!currentRoom?.awaitingDeckDecision) {
    return;
  }

  socket.emit("resolveDeckDecision", { roomCode, action });
}

socket.on("connect", () => {
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
  setScreen("game");
});

socket.on("yourCards", (cards) => {
  myCards = cards;

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
  showToast("Penalty applied");
});

socket.on("deckEmpty", () => {
  showToast("Main deck is empty", 1200);
});

socket.on("roomError", (message) => {
  alert(message);
});

socket.on("gameOver", (winnerName) => {
  clearInterval(timerInterval);
  pendingCard = null;
  colorPicker.style.display = "none";
  deckDecisionModal.style.display = "none";
  winnerNameElement.innerText = winnerName;
  winnerModal.style.display = "flex";
});

window.addEventListener("resize", () => {
  if (currentRoom?.started) {
    renderPlayers(currentRoom);
  }
});
