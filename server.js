const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const contentType = contentTypes[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// Rooms: { roomId: { players: [{id, name, ws, hand, passed}], deck, board, started, turn, gameOver } }
const rooms = {};

function createDeck() {
  const suits = ['\u2660', '\u2665', '\u2666', '\u2663'];
  const deck = [];
  // فقط 7-8-9-10-J-Q-K-A (7 إلى 14، حيث A=14)
  for (let s of suits) for (let v = 7; v <= 14; v++) deck.push({ suit: s, value: v });
  // shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function initBoard() {
  // board: { '♠': {low:6, high:8}, ... } means 6 down to A, 8 up to K placed
  // We track min and max placed for each suit
  // Start: nothing placed, 7s will be placed first
  return { '♠': null, '♥': null, '♦': null, '♣': null };
}

function dealCards(deck, numPlayers) {
  const hands = Array.from({ length: numPlayers }, () => []);
  deck.forEach((card, i) => hands[i % numPlayers].push(card));
  return hands;
}

function getValidMoves(hand, board) {
  const moves = [];
  for (const card of hand) {
    const b = board[card.suit];
    if (card.value === 7) {
      if (!b) moves.push(card); // يجب وضع 7 أولاً
    } else if (b) {
      // فقط لأعلى: 8-9-10-J-Q-K-A (max=14)
      if (card.value === b.high + 1 && b.high < 14) moves.push(card);
    }
  }
  return moves;
}

function broadcast(room, msg) {
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }
}

function sendGameState(room) {
  for (const p of room.players) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const validMoves = room.started && room.players[room.turn]?.id === p.id
      ? getValidMoves(p.hand, room.board)
      : [];
    
    p.ws.send(JSON.stringify({
      type: 'game_state',
      board: room.board,
      players: room.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        cardCount: pl.hand.length,
        passed: pl.passed,
        isOut: pl.isOut
      })),
      myHand: p.hand,
      turn: room.turn,
      currentPlayerId: room.players[room.turn]?.id,
      validMoves,
      gameOver: room.gameOver,
      loser: room.loser,
      started: room.started
    }));
  }
}

function nextTurn(room) {
  let next = (room.turn + 1) % room.players.length;
  let count = 0;
  while (room.players[next].isOut && count < room.players.length) {
    next = (next + 1) % room.players.length;
    count++;
  }
  room.turn = next;
}

function checkGameOver(room) {
  const activePlayers = room.players.filter(p => !p.isOut);
  if (activePlayers.length <= 1) {
    room.gameOver = true;
    room.loser = activePlayers[0]?.name || 'آخر لاعب';
    return true;
  }
  return false;
}

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  ws.clientId = clientId;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'create_room') {
      const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
      rooms[roomId] = {
        players: [],
        deck: null,
        board: initBoard(),
        started: false,
        turn: 0,
        gameOver: false,
        loser: null
      };
      const player = { id: clientId, name: msg.name, ws, hand: [], passed: false, isOut: false };
      rooms[roomId].players.push(player);
      ws.roomId = roomId;
      ws.send(JSON.stringify({ type: 'room_created', roomId, playerId: clientId }));
      broadcast(rooms[roomId], { type: 'player_list', players: rooms[roomId].players.map(p => ({ id: p.id, name: p.name })) });
    }

    else if (msg.type === 'join_room') {
      const room = rooms[msg.roomId];
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'الغرفة غير موجودة' })); return; }
      if (room.started) { ws.send(JSON.stringify({ type: 'error', msg: 'اللعبة بدأت بالفعل' })); return; }
      if (room.players.length >= 4) { ws.send(JSON.stringify({ type: 'error', msg: 'الغرفة ممتلئة' })); return; }
      
      const player = { id: clientId, name: msg.name, ws, hand: [], passed: false, isOut: false };
      room.players.push(player);
      ws.roomId = msg.roomId;
      ws.send(JSON.stringify({ type: 'joined_room', roomId: msg.roomId, playerId: clientId }));
      broadcast(room, { type: 'player_list', players: room.players.map(p => ({ id: p.id, name: p.name })) });
    }

    else if (msg.type === 'start_game') {
      const room = rooms[ws.roomId];
      if (!room) return;
      if (room.players[0].id !== clientId) { ws.send(JSON.stringify({ type: 'error', msg: 'فقط المضيف يمكنه البدء' })); return; }
      if (room.players.length < 2) { ws.send(JSON.stringify({ type: 'error', msg: 'يلزم لاعبان على الأقل' })); return; }
      
      room.deck = createDeck();
      const hands = dealCards(room.deck, room.players.length);
      room.players.forEach((p, i) => { p.hand = hands[i]; p.isOut = false; p.passed = false; });
      room.board = initBoard();
      room.started = true;
      room.gameOver = false;
      room.loser = null;
      
      // Find who has 7 of spades, they go first
      let firstPlayer = 0;
      for (let i = 0; i < room.players.length; i++) {
        if (room.players[i].hand.find(c => c.suit === '♠' && c.value === 7)) {
          firstPlayer = i;
          break;
        }
      }
      room.turn = firstPlayer;
      
      broadcast(room, { type: 'game_started' });
      sendGameState(room);
    }

    else if (msg.type === 'play_card') {
      const room = rooms[ws.roomId];
      if (!room || !room.started || room.gameOver) return;
      const player = room.players[room.turn];
      if (!player || player.id !== clientId) return;

      const card = msg.card;
      const validMoves = getValidMoves(player.hand, room.board);
      const isValid = validMoves.find(c => c.suit === card.suit && c.value === card.value);
      if (!isValid) { ws.send(JSON.stringify({ type: 'error', msg: 'حركة غير صالحة' })); return; }

      // Remove card from hand
      player.hand = player.hand.filter(c => !(c.suit === card.suit && c.value === card.value));
      
      // Update board - فقط لأعلى
      if (card.value === 7) {
        room.board[card.suit] = { low: 7, high: 7 };
      } else {
        const b = room.board[card.suit];
        if (card.value === b.high + 1) b.high = card.value;
      }

      player.passed = false;

      // Check if player finished their cards
      if (player.hand.length === 0) {
        player.isOut = true;
        broadcast(room, { type: 'player_out', playerName: player.name });
        if (checkGameOver(room)) {
          sendGameState(room);
          return;
        }
      }

      nextTurn(room);
      sendGameState(room);
    }

    else if (msg.type === 'pass') {
      const room = rooms[ws.roomId];
      if (!room || !room.started || room.gameOver) return;
      const player = room.players[room.turn];
      if (!player || player.id !== clientId) return;
      
      const validMoves = getValidMoves(player.hand, room.board);
      if (validMoves.length > 0) { ws.send(JSON.stringify({ type: 'error', msg: 'لا يمكنك التمرير، لديك حركات صالحة' })); return; }
      
      player.passed = true;
      nextTurn(room);
      sendGameState(room);
    }

    else if (msg.type === 'restart') {
      const room = rooms[ws.roomId];
      if (!room) return;
      if (room.players[0].id !== clientId) return;
      
      room.deck = createDeck();
      const hands = dealCards(room.deck, room.players.length);
      room.players.forEach((p, i) => { p.hand = hands[i]; p.isOut = false; p.passed = false; });
      room.board = initBoard();
      room.started = true;
      room.gameOver = false;
      room.loser = null;
      
      let firstPlayer = 0;
      for (let i = 0; i < room.players.length; i++) {
        if (room.players[i].hand.find(c => c.suit === '♠' && c.value === 7)) {
          firstPlayer = i;
          break;
        }
      }
      room.turn = firstPlayer;
      broadcast(room, { type: 'game_started' });
      sendGameState(room);
    }
  });

  ws.on('close', () => {
    const room = rooms[ws.roomId];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== clientId);
    if (room.players.length === 0) {
      delete rooms[ws.roomId];
    } else {
      broadcast(room, { type: 'player_list', players: room.players.map(p => ({ id: p.id, name: p.name })) });
      if (room.started && !room.gameOver) {
        // Adjust turn if needed
        if (room.turn >= room.players.length) room.turn = 0;
        sendGameState(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
