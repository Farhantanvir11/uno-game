const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));

let rooms = {};

// ✅ SAFE DATA FUNCTION (TOP LEVEL)
function getSafeRoom(room) {
  return {
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      cardCount: p.cards.length
    })),
    turn: room.turn,
    discard: room.discard,
    stackCount: room.stackCount || 0 // ✅ ADD THIS
  };
}
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// 🔄 TURN SYSTEM
function nextTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // 🔁 NEXT PLAYER
  room.turn =
    (room.turn + room.direction + room.players.length) %
    room.players.length;


  room.players.forEach(p => {
    if (!p.isAI) {
      io.to(p.id).emit("yourCards", p.cards);
    }
  });

  // 🔄 UPDATE GAME STATE
  io.to(roomCode).emit("updateGame", getSafeRoom(room));



  // ⛔ CLEAR OLD TIMER (OUTSIDE LOOP)
  clearTimeout(room.timer);

  // ⏱ START NEW TIMER
  room.timer = setTimeout(() => {
    const player = room.players[room.turn];

    // ⏳ AUTO DRAW
    reshuffleDeck(room);
    player.cards.push(room.deck.pop());

    // 🔄 UPDATE UI
    io.to(roomCode).emit("updateGame", getSafeRoom(room));

    room.players.forEach(p => {
      if (!p.isAI) {
        io.to(p.id).emit("yourCards", p.cards);
      }
    });

    // 🔁 NEXT TURN AGAIN
    nextTurn(roomCode);

  }, 10000); // 10 sec
}

//CREATE UNO DECK
function createUnoDeck() {
  const colors = ["red", "green", "blue", "yellow"];
  let deck = [];

  colors.forEach(color => {
    deck.push({ color, value: 0 });

    for (let i = 1; i <= 9; i++) {
      deck.push({ color, value: i });
      deck.push({ color, value: i });
    }

    for (let i = 0; i < 2; i++) {
      deck.push({ color, value: "skip" });
      deck.push({ color, value: "reverse" });
      deck.push({ color, value: "+2" });
    }
  });

  // 🌈 wild cards
  for (let i = 0; i < 4; i++) {
    deck.push({ color: "black", value: "wild" });
    deck.push({ color: "black", value: "+4" });
  }

  return shuffle(deck);
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

//Reshuffle Deck

function reshuffleDeck(room) {
  if (room.deck.length > 0) return;

  const topCard = room.discard.pop(); // keep last card

  // shuffle remaining discard
  room.deck = shuffle(room.discard);

  room.discard = [topCard];

  console.log("♻️ Deck reshuffled!");
}

// 🔌 CONNECTION
io.on("connection", (socket) => {

  socket.on("createRoom", (playerName) => {
    const roomCode = generateRoomCode();

    rooms[roomCode] = {
    players: [],
    turn: 0,
    deck: [],
    discard: [],
    direction: 1,   // ✅ ADD THIS
    stackCount: 0   // ✅ ALSO ADD
  };

    rooms[roomCode].players.push({
      id: socket.id,
      name: playerName,
      cards: [],
      isAI: false
    });

    socket.join(roomCode);
    socket.emit("roomCreated", roomCode);
  });

  socket.on("joinRoom", ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.players.push({
      id: socket.id,
      name: playerName,
      cards: [],
      isAI: false
    });

    socket.join(roomCode);
    io.to(roomCode).emit("updatePlayers", room.players);
  });



// START GAME 
socket.on("startGame", ({ roomCode, players, cards }) => {
  const room = rooms[roomCode];
  if (!room) return;

  let deck = createUnoDeck();
  room.deck = deck;

  console.log("TOTAL CARDS:", deck.length);

  // 🎴 distribute cards
  room.players.forEach(p => {
    p.cards = deck.splice(0, parseInt(cards));
  });

  // 🎴 send cards
  room.players.forEach(p => {
    if (!p.isAI) {
      io.to(p.id).emit("yourCards", p.cards);
    }
  });

  // 🎴 first card
  room.discard = [deck.pop()];

  io.to(roomCode).emit("gameStarted");

  setTimeout(() => {
    nextTurn(roomCode);
  }, 1000);
});



// UNO 
socket.on("uno", (roomCode) => {
  const room = rooms[roomCode];
  if (!room) return;

  const player = room.players.find(p => p.id === socket.id);
  if (!player) return;

  player.calledUNO = true;
});



//DRAW CARD 
socket.on("drawCard", (roomCode) => {
  const room = rooms[roomCode];
  if (!room) return;

  const player = room.players[room.turn];
  if (player.id !== socket.id) return;

  let drawCount = room.stackCount > 0 ? room.stackCount : 1;

  for (let i = 0; i < drawCount; i++) {
    if (room.deck.length === 0) reshuffleDeck(room);
    player.cards.push(room.deck.pop());
  }

  room.stackCount = 0; // 🔥 reset stack

  io.to(player.id).emit("yourCards", player.cards);

  nextTurn(roomCode);



  // reset stack
  room.stackCount = 0;

  // ✅ send updated cards
  io.to(player.id).emit("yourCards", player.cards);



  // ✅ update game for everyone
  io.to(roomCode).emit("updateGame", getSafeRoom(room));
});

//PLAY CARD
socket.on("playCard", ({ roomCode, card, chosenColor }) => {
  const room = rooms[roomCode];
  if (!room) return;

  const player = room.players[room.turn];
  if (player.id !== socket.id) return;

  const top = room.discard[room.discard.length - 1];

  // 🔒 ensure stackCount exists
  room.stackCount = room.stackCount || 0;

  let isValid = false;

  // 🔥 STACK MODE
  if (room.stackCount > 0) {
    if (card.value === "+2" || card.value === "+4") {
      isValid = true;
    }
  } else {
    // normal rules
    if (card.color === top.color) isValid = true;
    if (card.value === top.value) isValid = true;

    if (card.value === "wild" || card.value === "+4") {
      if (top.value !== "+2" && top.value !== "+4") {
        isValid = true;
      }
    }
  }

  if (!isValid) {
    reshuffleDeck(room);
    player.cards.push(room.deck.pop());
    io.to(player.id).emit("penalty");
    return;
  }

  // 🚫 LAST CARD RULE
  if (player.cards.length === 1) {
    if (["wild", "+4", "+2", "skip", "reverse"].includes(card.value)) {
      reshuffleDeck(room);
      player.cards.push(room.deck.pop());
      io.to(player.id).emit("penalty");
      return;
    }
  }

  // remove card
  const index = player.cards.findIndex(
    c => c.color === card.color && c.value === card.value
  );

  if (index !== -1) {
    player.cards.splice(index, 1);
  }

  // UNO check
  // UNO check
  if (player.cards.length === 1) {
    player.calledUNO = false;

    setTimeout(() => {
      if (!player.calledUNO) {
        // penalty
        for (let i = 0; i < 2; i++) {
          if (room.deck.length === 0) reshuffleDeck(room);
          player.cards.push(room.deck.pop());
        }

        io.to(player.id).emit("penalty");
        io.to(player.id).emit("yourCards", player.cards);

        // 🔥 update everyone
        io.to(roomCode).emit("updateGame", getSafeRoom(room));
      }
    }, 3000);
  }

  // 🌈 HANDLE WILD
  if ((card.value === "wild" || card.value === "+4") && !chosenColor) {
    return;
  }

  if (card.value === "wild" || card.value === "+4") {
    card.color = chosenColor;
  }

  room.discard.push(card);
  // 🏆 WIN CHECK
if (player.cards.length === 0) {
  io.to(roomCode).emit("gameOver", player.name);

  // stop timer
  clearTimeout(room.timer);

  return;
}

  // 🔥 STACK SYSTEM
  if (card.value === "+2") {
    room.stackCount += 2;
  } 
  else if (card.value === "+4") {
    room.stackCount += 4;
  } 
  else {
    room.stackCount = 0;
  }

  // 🔁 REVERSE (FIXED)
  if (card.value === "reverse") {
    room.direction *= -1;
  }

  // ⏭ SKIP (FIXED WITH DIRECTION)
  if (card.value === "skip") {
    room.turn =
      (room.turn + room.direction + room.players.length) %
      room.players.length;
  }

  nextTurn(roomCode); // ✅ ONLY THIS (no extra updateGame)
});

});

http.listen(3000, "0.0.0.0", () => {
  console.log("Server running on http://localhost:3000");
});