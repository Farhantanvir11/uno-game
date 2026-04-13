const { io } = require("socket.io-client");

const SERVER_URL = "http://127.0.0.1:3000";
const STARTING_CARDS = 10;
const TURN_WAIT_MS = 3000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(check, timeoutMs, label) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check();
      if (value) {
        resolve(value);
        return;
      }

      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }

      setTimeout(poll, 25);
    };

    poll();
  });
}

function createClient(name) {
  const socket = io(SERVER_URL, {
    forceNew: true
  });

  const state = {
    name,
    socket,
    cards: [],
    room: null,
    penalties: 0,
    errors: [],
    deckEmptyEvents: 0,
    winner: null
  };

  socket.on("connect_error", (error) => {
    state.errors.push(`connect_error:${error.message}`);
  });

  socket.on("yourCards", (cards) => {
    state.cards = cards;
  });

  socket.on("lobbyUpdated", (room) => {
    state.room = room;
  });

  socket.on("updateGame", (room) => {
    state.room = room;
  });

  socket.on("penalty", () => {
    state.penalties += 1;
  });

  socket.on("roomError", (message) => {
    state.errors.push(message);
  });

  socket.on("deckEmpty", () => {
    state.deckEmptyEvents += 1;
  });

  socket.on("gameOver", (winnerName) => {
    state.winner = winnerName;
  });

  return state;
}

function isPlayable(card, topCard, stackCount) {
  if (!topCard) {
    return true;
  }

  if (stackCount > 0) {
    return card.value === "+2" || card.value === "+4";
  }

  if (card.color === "black") {
    return topCard.value !== "+2" && topCard.value !== "+4";
  }

  return card.color === topCard.color || card.value === topCard.value;
}

async function connectClient(client) {
  await waitFor(() => {
    if (client.errors.length > 0) {
      throw new Error(`${client.name} ${client.errors[0]}`);
    }

    return client.socket.connected;
  }, 4000, `${client.name} connection`);
}

async function startTwoPlayerGame(host, guest, roundName) {
  host.socket.emit("createRoom", `${roundName}-Host`);

  const roomCode = await waitFor(
    () => host.room?.roomCode,
    4000,
    `${roundName} room creation`
  );

  guest.socket.emit("joinRoom", {
    roomCode,
    playerName: `${roundName}-Guest`
  });

  await waitFor(
    () => host.room?.players?.length === 2 && guest.room?.players?.length === 2,
    4000,
    `${roundName} guest join`
  );

  host.socket.emit("startGame", { roomCode, cards: STARTING_CARDS });

  await waitFor(
    () =>
      host.room?.started &&
      guest.room?.started &&
      host.cards.length === STARTING_CARDS &&
      guest.cards.length === STARTING_CARDS,
    4000,
    `${roundName} game start`
  );

  return roomCode;
}

function getClientById(clients, socketId) {
  return clients.find((client) => client.socket.id === socketId);
}

async function takeTurn(clients, options = {}) {
  const room = clients[0].room;
  const activePlayer = room.players[room.turn];
  const client = getClientById(clients, activePlayer.id);

  if (!client) {
    throw new Error("Could not find active client.");
  }

  const topCard = room.discard[room.discard.length - 1];
  const playableCard = options.forceDraw
    ? null
    : client.cards.find((card) => isPlayable(card, topCard, room.stackCount));

  const beforeSnapshot = JSON.stringify({
    turn: room.turn,
    discardSize: room.discard.length,
    stackCount: room.stackCount,
    turnEndsAt: room.turnEndsAt,
    cardCounts: room.players.map((player) => player.cardCount)
  });

  if (playableCard) {
    if (playableCard.color === "black") {
      client.socket.emit("playCard", {
        roomCode: room.roomCode,
        card: playableCard,
        chosenColor: "red"
      });
    } else {
      client.socket.emit("playCard", {
        roomCode: room.roomCode,
        card: playableCard
      });
    }
  } else {
    client.socket.emit("drawCard", room.roomCode);
  }

  await waitFor(() => {
    const nextRoom = clients[0].room;
    return (
      nextRoom?.awaitingDeckDecision ||
      JSON.stringify({
        turn: nextRoom?.turn,
        discardSize: nextRoom?.discard?.length,
        stackCount: nextRoom?.stackCount,
        turnEndsAt: nextRoom?.turnEndsAt,
        cardCounts: nextRoom?.players?.map((player) => player.cardCount)
      }) !== beforeSnapshot ||
      clients.some((entry) => entry.winner)
    );
  }, TURN_WAIT_MS, "turn resolution");
}

async function forceDeckDecision(clients) {
  let turns = 0;

  while (!clients[0].room?.awaitingDeckDecision) {
    await takeTurn(clients, { forceDraw: true });
    turns += 1;

    if (turns > 300) {
      throw new Error("Deck empty state did not occur within 300 turns.");
    }
  }

  return turns;
}

async function buildDiscardPile(clients, minDiscardSize = 4) {
  let attempts = 0;

  while ((clients[0].room?.discard?.length || 0) < minDiscardSize) {
    await takeTurn(clients);
    attempts += 1;

    if (clients.some((entry) => entry.winner)) {
      throw new Error("A player won before the discard pile was built.");
    }

    if (attempts > 40) {
      throw new Error("Could not build enough discard cards for shuffle testing.");
    }
  }
}

async function runRound(roundName, hostAction) {
  const host = createClient("host");
  const guest = createClient("guest");
  const clients = [host, guest];

  try {
    await Promise.all(clients.map(connectClient));
    const roomCode = await startTwoPlayerGame(host, guest, roundName);

    await buildDiscardPile(clients);
    const turnsToDecision = await forceDeckDecision(clients);

    await waitFor(
      () => host.deckEmptyEvents > 0 && guest.deckEmptyEvents > 0,
      3000,
      `${roundName} deckEmpty broadcast`
    );

    host.socket.emit("resolveDeckDecision", {
      roomCode,
      action: hostAction
    });

    if (hostAction === "shuffle") {
      await waitFor(
        () => !host.room?.awaitingDeckDecision && !guest.room?.awaitingDeckDecision,
        4000,
        `${roundName} shuffle resume`
      );

      await takeTurn(clients, { forceDraw: true });
    } else {
      await waitFor(
        () => host.winner && guest.winner,
        4000,
        `${roundName} winner declaration`
      );
    }

    return {
      roomCode,
      turnsToDecision,
      hostPenalties: host.penalties,
      guestPenalties: guest.penalties,
      hostErrors: host.errors,
      guestErrors: guest.errors,
      winner: host.winner || guest.winner || null
    };
  } finally {
    clients.forEach((client) => client.socket.close());
    await delay(100);
  }
}

async function main() {
  const shuffleRound = await runRound("ShuffleRound", "shuffle");
  const declareRound = await runRound("DeclareRound", "declareWinner");

  console.log(
    JSON.stringify(
      {
        ok: true,
        shuffleRound,
        declareRound
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error.message
      },
      null,
      2
    )
  );
  process.exit(1);
});
