const socket = io();
let roomCode = "";
let myId = "";
let myCards = [];
let timeLeft = 10;
let timerInterval;
let currentRoom = null;
let pendingCard = null;

// CREATE ROOM
function createRoom() {
  const name = document.getElementById("name").value;
  socket.emit("createRoom", name);
}

// JOIN ROOM
function joinRoom() {
  const name = document.getElementById("name").value;
  const code = document.getElementById("roomCode").value;

  roomCode = code.toUpperCase();
  socket.emit("joinRoom", { roomCode, playerName: name });
}

// ADD AI
function addAI() {
  socket.emit("addAI", roomCode);
  
}
//DRAW CARD 
function drawCard() {
  if (currentRoom.players[currentRoom.turn].id !== myId) {
    alert("Not your turn!");
    return;
  }

  // 🎴 create fake card animation
  const deck = document.getElementById("topCard");
  const hand = document.getElementById("hand");

  const rect = deck.getBoundingClientRect();

  const fakeCard = document.createElement("div");
  fakeCard.className = "card back"; // backside look
  fakeCard.style.position = "fixed";
  fakeCard.style.left = rect.left + "px";
  fakeCard.style.top = rect.top + "px";
  fakeCard.style.width = "70px";
  fakeCard.style.height = "100px";
  fakeCard.style.zIndex = 999;
  fakeCard.style.transition = "all 0.4s ease";

  document.body.appendChild(fakeCard);

  // 🎯 move to bottom (hand area)
  setTimeout(() => {
    fakeCard.style.top = (window.innerHeight - 120) + "px";
    fakeCard.style.left = (window.innerWidth / 2 - 35) + "px";
  }, 10);

  // 🧹 remove animation
  setTimeout(() => {
    fakeCard.remove();
  }, 400);

  // 🚀 THEN request real card
  setTimeout(() => {
    socket.emit("drawCard", roomCode);
  }, 300);
}
//CALL UNO 
function callUNO() {
  socket.emit("uno", roomCode);
}

//Choose COlor 
function chooseColor(color) {
  document.getElementById("colorPicker").style.display = "none";

  if (!pendingCard) return;

  socket.emit("playCard", {
    roomCode,
    card: pendingCard,
    chosenColor: color
  });

  pendingCard = null;
}

// ROOM CREATED
socket.on("roomCreated", (code) => {
  roomCode = code;

  document.getElementById("menu").style.display = "none";
  document.getElementById("lobby").style.display = "block";

  document.getElementById("roomTitle").innerText = "Room: " + code;
});

// START GAME
function startGame() {
  const players = document.getElementById("playerCount").value;
  const cards = document.getElementById("cardCount").value;

  socket.emit("startGame", {
    roomCode,
    players,
    cards
  });
}

// RECEIVE PLAYER CARDS
socket.on("yourCards", (cards) => {
  myCards = cards;

  // ✅ re-render using current room
  if (currentRoom) {
    render(currentRoom);
  }
});

// GAME UPDATE
socket.on("updateGame", (room) => {
  myId = socket.id;
  currentRoom = room;

  // ⏱ TIMER
  clearInterval(timerInterval);
  timeLeft = 10;

  document.getElementById("timer").innerText = "Time: " + timeLeft;

  timerInterval = setInterval(() => {
    timeLeft--;
    document.getElementById("timer").innerText = "Time: " + timeLeft;

    if (timeLeft <= 0) {
      clearInterval(timerInterval);
    }
  }, 1000);

  render(room); // ✅ ONLY ONCE
});


// GAME START (SCREEN SWITCH)
socket.on("gameStarted", () => {  
  document.getElementById("lobby").style.display = "none";  
  document.getElementById("game").style.display = "block";  
});

// PENALTY
socket.on("penalty", () => {
  alert("Wrong card! +1 penalty");
});


socket.on("gameOver", (winnerName) => {
  alert("🏆 Winner: " + winnerName);

  // reset UI
  document.getElementById("game").style.display = "none";
  document.getElementById("menu").style.display = "block";
});

// 🎮 RENDER FUNCTION (VERY IMPORTANT)
function render(room) {
  const hand = document.getElementById("hand");
  hand.innerHTML = "";

  // render MY cards
  myCards.forEach(card => {
  const div = document.createElement("div");
  div.className = "card " + card.color;
  div.innerText = card.value;

  // ✅ CHECK TURN
  if (room.players[room.turn].id === myId) {

    div.onclick = () => {
  console.log("CLICKED CARD:", card);

  // 🎞 animation
  div.onclick = () => {
  console.log("CLICKED CARD:", card);

  const rect = div.getBoundingClientRect();
  const clone = div.cloneNode(true);
  clone.style.boxShadow = "0 0 20px white";


  // 🔥 make floating clone
  clone.style.position = "fixed";
  clone.style.left = rect.left + "px";
  clone.style.top = rect.top + "px";
  clone.style.width = rect.width + "px";
  clone.style.height = rect.height + "px";
  clone.style.zIndex = 999;
  clone.style.transition = "all 0.4s ease";

  document.body.appendChild(clone);

  // 🎯 target = center (top card)
  const target = document.getElementById("topCard").getBoundingClientRect();

  setTimeout(() => {
    clone.style.left = target.left + "px";
    clone.style.top = target.top + "px";
    clone.style.transform = "scale(1.2)";
  }, 10);

  // 🧹 remove clone after animation
  setTimeout(() => {
    clone.remove();
  }, 400);

  // ✅ remove from hand instantly
  myCards = myCards.filter(
    c => !(c.color === card.color && c.value === card.value)
  );

  render(room);

  // 🚀 send to server AFTER animation
  setTimeout(() => {
    socket.emit("playCard", { roomCode, card });
  }, 300);
};

  // ✅ REMOVE CARD INSTANTLY FROM UI
  myCards = myCards.filter(
    c => !(c.color === card.color && c.value === card.value)
  );

  render(room); // refresh instantly
  // 🔥 SHOW UNO BUTTON
  const me = room.players.find(p => p.id === myId);

  if (me && me.cardCount === 1) {
    document.getElementById("unoBtn").style.display = "block";
  } else {
    document.getElementById("unoBtn").style.display = "none";
  }
  
  // send to server
  setTimeout(() => {

  // 🌈 if wild or +4 → ask color
  if (card.value === "wild" || card.value === "+4") {

  pendingCard = card;

  document.getElementById("colorPicker").style.display = "flex";

  } else {
    socket.emit("playCard", { roomCode, card });
  }

}, 100);
};


  } else {
    // ❌ disable if not your turn
    div.style.opacity = "0.5";
    div.onclick = null;
  }

  hand.appendChild(div);
});

  // TOP CARD
  const top = room.discard[room.discard.length - 1];
  document.getElementById("topCard").innerHTML =
    `<div class="card ${top.color}">${top.value}</div>`;


  const stackDiv = document.getElementById("stackInfo");

  if (room.stackCount > 0) {
    stackDiv.innerText = "Stack: +" + room.stackCount;
  } else {
    stackDiv.innerText = "";
  }

  // PLAYERS LIST
  const playersDiv = document.getElementById("players");
  playersDiv.innerHTML = "";

  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2 - 150; // 🔥 THIS LINE FIXES YOUR ISSUE
  const radius = 200;
  

  room.players.forEach((p, i) => {
  const angle = (i / room.players.length) * 2 * Math.PI;

  const x = centerX + radius * Math.cos(angle);
  const y = centerY + radius * Math.sin(angle);

  const div = document.createElement("div");
  div.className = "player";

  div.style.left = x + "px";
  div.style.top = y + "px";

  div.innerText = p.name + " (" + p.cardCount + ")";

  if (i === room.turn) {
    div.style.color = "yellow";
    div.style.fontWeight = "bold";
  }

  playersDiv.appendChild(div);
});
}