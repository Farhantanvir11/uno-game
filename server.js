const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static("public"));

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const TURN_DURATION_MS = 15000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;
const DEFAULT_HAND_SIZE = 7;
const rooms = {};

function createPlayer(socket, name) {
  return {
    id: socket.id,
    name: (name || "Player").trim().slice(0, 20) || "Player",
    cards: [],
    calledUNO: false
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
      cardCount: player.cards.length
    })),
    started: room.started,
    turn: room.turn,
    direction: room.direction,
    discard: room.discard,
    stackCount: room.stackCount,
    handSize: room.handSize,
    turnEndsAt: room.turnEndsAt || null,
    awaitingDeckDecision: Boolean(room.deckDecision),
    canShuffleDeck: room.discard.length > 1
  };
}

function emitLobby(roomCode) {
  io.to(roomCode).emit("lobbyUpdated", getSafeRoom(roomCode));
}

function emitGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room) {
    return;
  }

  room.players.forEach((player) => {
    io.to(player.id).emit("yourCards", player.cards);
  });

  io.to(roomCode).emit("updateGame", getSafeRoom(roomCode));
}

function sendError(socket, message) {
  socket.emit("roomError", message);
}

function reshuffleDeck(room) {
  if (room.deck.length > 0 || room.discard.length <= 1) {
    return;
  }

  const topCard = room.discard.pop();
  room.deck = shuffle([...room.discard]);
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

function advanceTurn(roomCode, extraSteps = 1) {
  const room = rooms[roomCode];
  if (!room || room.players.length === 0) {
    return;
  }

  room.turn =
    (room.turn + extraSteps * room.direction + room.players.length) %
    room.players.length;
}

function scheduleTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.started || room.deckDecision) {
    return;
  }

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

function isPlayableCard(card, topCard, stackCount) {
  if (!topCard) {
    return true;
  }

  if (stackCount > 0) {
    return card.value === "+2" || card.value === "+4";
  }

  if (card.color === "black") {
    return true;
  }

  return card.color === topCard.color || card.value === topCard.value;
}

function finishGame(roomCode, winnerName) {
  const room = rooms[roomCode];
  if (!room) {
    return;
  }

  room.started = false;
  stopTurnTimer(room);
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

  room.players.splice(index, 1);

  if (room.players.length === 0) {
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
  socket.on("createRoom", (playerName) => {
    const roomCode = generateRoomCode();

    rooms[roomCode] = {
      hostId: socket.id,
      players: [createPlayer(socket, playerName)],
      started: false,
      handSize: DEFAULT_HAND_SIZE,
      turn: 0,
      direction: 1,
      stackCount: 0,
      deck: [],
      discard: [],
      timer: null,
      turnEndsAt: null,
      deckDecision: null
    };

    socket.join(roomCode);
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
      sendError(socket, "That game has already started.");
      return;
    }

    if (room.players.length >= MAX_PLAYERS) {
      sendError(socket, "That room is already full.");
      return;
    }

    room.players.push(createPlayer(socket, playerName));
    socket.join(normalizedCode);
    socket.emit("joinedRoom", normalizedCode);
    emitLobby(normalizedCode);
  });

  socket.on("startGame", ({ roomCode, cards }) => {
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

    const handSize = Number.parseInt(cards, 10);
    room.handSize = Number.isInteger(handSize) ? handSize : DEFAULT_HAND_SIZE;
    room.started = true;
    room.turn = 0;
    room.direction = 1;
    room.stackCount = 0;
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

    const drawCount = room.stackCount > 0 ? room.stackCount : 1;
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
    if (!isPlayableCard(card, topCard, room.stackCount)) {
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
    } else if (playedCard.value === "+4") {
      room.stackCount += 4;
    } else {
      room.stackCount = 0;
    }

    if (playedCard.value === "reverse") {
      room.direction *= -1;
    }

    const shouldSkip = playedCard.value === "skip";
    advanceToNextTurn(roomCode, shouldSkip ? 2 : 1);
  });

  socket.on("disconnect", () => {
    removePlayerFromRoom(socket.id);
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

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
