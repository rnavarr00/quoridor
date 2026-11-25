import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { createServer } from '../server/index.js';
import { TICK_INTERVAL_MS } from '../server/protocol.js';
import { createIpLimiters, createRateLimiter } from '../server/rateLimit.js';

function waitForMessage(ws, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout esperando mensaje del servidor'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    }
    function onMessage(data) {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    }
    function onClose() {
      cleanup();
      reject(new Error('Socket cerrado mientras se esperaba un mensaje'));
    }
    function onError(error) {
      cleanup();
      reject(error);
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

function send(ws, type, payload = {}, requestId = undefined) {
  const envelope = { type, payload };
  if (requestId) envelope.requestId = requestId;
  ws.send(JSON.stringify(envelope));
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function findStep(state, playerId) {
  const { size } = state.board;
  const player = state.players.find((entry) => entry.id === playerId);
  const occupied = new Set(
    state.players
      .filter((entry) => !entry.ghost && entry.id !== playerId)
      .map((entry) => `${entry.pos.x},${entry.pos.y}`),
  );
  const candidates = [
    { x: player.pos.x, y: player.pos.y - 1 },
    { x: player.pos.x, y: player.pos.y + 1 },
    { x: player.pos.x - 1, y: player.pos.y },
    { x: player.pos.x + 1, y: player.pos.y },
  ];
  return candidates.find((cell) => (
    cell.x >= 0 && cell.x < size && cell.y >= 0 && cell.y < size
    && !occupied.has(`${cell.x},${cell.y}`)
  ));
}

test('la CSP se entrega como cabecera HTTP y no como meta', async (t) => {
  const app = createServer();
  t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1');

  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.doesNotMatch(await response.text(), /http-equiv="Content-Security-Policy"/i);
});

test('sala, partida, rechazo, desconexión y reconexión', { timeout: 20000 }, async (t) => {
  const app = createServer();
  const sockets = [];

  t.after(async () => {
    for (const ws of sockets) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    await app.close();
  });

  const address = await app.listen(0, '127.0.0.1');
  const port = address.port;

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const playerA = crypto.randomUUID();
  const tokenA = crypto.randomBytes(32).toString('hex');
  const playerB = crypto.randomUUID();
  const tokenB = crypto.randomBytes(32).toString('hex');

  const wsA = await connect(port);
  sockets.push(wsA);
  const welcomeA = waitForMessage(wsA, (msg) => msg.type === 'server.welcome');
  send(wsA, 'client.hello', { playerId: playerA, sessionToken: tokenA, alias: 'Ana' }, 'hello-a');
  const welcomeAMessage = await welcomeA;
  assert.equal(welcomeAMessage.payload.playerId, playerA);
  assert.equal(welcomeAMessage.payload.resumed, false);

  const wsB = await connect(port);
  sockets.push(wsB);
  const welcomeB = waitForMessage(wsB, (msg) => msg.type === 'server.welcome');
  send(wsB, 'client.hello', { playerId: playerB, sessionToken: tokenB, alias: 'Luis' }, 'hello-b');
  await welcomeB;

  const created = waitForMessage(
    wsA,
    (msg) => msg.type === 'server.roomCreated' && msg.requestId === 'create-1',
  );
  send(wsA, 'client.createRoom', {
    config: { size: 8, maxPlayers: 2 },
    alias: 'Ana',
  }, 'create-1');
  const createdMessage = await created;
  const roomCode = createdMessage.payload.roomCode;
  assert.equal(roomCode.length, 6);
  assert.equal(createdMessage.payload.config.turnSeconds, 30);
  assert.equal(createdMessage.payload.players.length, 1);

  const joined = waitForMessage(
    wsB,
    (msg) => msg.type === 'server.roomJoined' && msg.requestId === 'join-1',
  );
  const updateForA = waitForMessage(
    wsA,
    (msg) => msg.type === 'server.roomUpdate' && msg.payload.players.length === 2,
  );
  send(wsB, 'client.joinRoom', { code: roomCode.toLowerCase(), alias: 'Luis' }, 'join-1');
  const joinedMessage = await joined;
  await updateForA;
  assert.equal(joinedMessage.payload.roomCode, roomCode);
  assert.equal(joinedMessage.payload.players.length, 2);

  const startedA = waitForMessage(wsA, (msg) => msg.type === 'server.gameStarted');
  const startedB = waitForMessage(wsB, (msg) => msg.type === 'server.gameStarted');
  send(wsA, 'client.startGame', {}, 'start-1');
  const startedMessage = await startedA;
  await startedB;

  const gameState = startedMessage.payload.state;
  assert.equal(gameState.status, 'playing');
  assert.equal(gameState.board.size, 8);
  assert.equal(gameState.players.length, 2);
  assert.ok(gameState.config.turnSeconds === 30);
  assert.ok(gameState.turnPlayerId);
  assert.ok(gameState.remainingSeconds <= 30 && gameState.remainingSeconds >= 0);
  for (const player of gameState.players) {
    assert.ok(Number.isInteger(player.pos.x));
    assert.ok(Number.isInteger(player.pos.y));
    assert.ok(Number.isInteger(player.goal.x));
    assert.ok(Number.isInteger(player.goal.y));
    assert.ok(Number.isInteger(player.spawn.x));
  }

  const turnPlayerId = gameState.turnPlayerId;
  const wsTurn = turnPlayerId === playerA ? wsA : wsB;
  const destination = findStep(gameState, turnPlayerId);
  assert.ok(destination);

  const stateAfterMove = waitForMessage(
    wsA,
    (msg) => msg.type === 'server.gameState' && msg.payload.state.turnPlayerId !== turnPlayerId,
  );
  send(wsTurn, 'client.move', { to: destination }, 'move-1');
  const moveMessage = await stateAfterMove;
  assert.equal(moveMessage.payload.state.turnNumber, gameState.turnNumber + 1);

  const currentPlayerId = moveMessage.payload.state.turnPlayerId;
  const wsCurrent = currentPlayerId === playerA ? wsA : wsB;
  const rejected = waitForMessage(
    wsCurrent,
    (msg) => msg.type === 'server.actionRejected' && msg.requestId === 'wall-bad',
  );
  send(wsCurrent, 'client.placeWall', { orientation: 'X', x: 0, y: 0 }, 'wall-bad');
  const rejectedMessage = await rejected;
  assert.equal(rejectedMessage.payload.code, 'INVALID_ORIENTATION');
  assert.equal(rejectedMessage.payload.ghosted, false);

  const disconnected = waitForMessage(
    wsA,
    (msg) => msg.type === 'server.playerDisconnected' && msg.payload.playerId === playerB,
  );
  const gameOver = waitForMessage(wsA, (msg) => msg.type === 'server.gameOver');
  wsB.close();
  const disconnectedMessage = await disconnected;
  assert.equal(disconnectedMessage.payload.ghost, true);
  const gameOverMessage = await gameOver;
  assert.equal(gameOverMessage.payload.winnerId, playerA);
  assert.equal(gameOverMessage.payload.reason, 'last_active');
  assert.equal(gameOverMessage.payload.state.status, 'finished');

  const wsB2 = await connect(port);
  sockets.push(wsB2);
  const welcomeB2 = waitForMessage(wsB2, (msg) => msg.type === 'server.welcome');
  const resumedState = waitForMessage(wsB2, (msg) => msg.type === 'server.gameState');
  send(wsB2, 'client.hello', { playerId: playerB, sessionToken: tokenB }, 'hello-b2');
  const welcomeB2Message = await welcomeB2;
  assert.equal(welcomeB2Message.payload.resumed, true);
  assert.equal(welcomeB2Message.payload.roomCode, roomCode);
  assert.equal(welcomeB2Message.payload.status, 'finished');
  const resumedStateMessage = await resumedState;
  assert.equal(resumedStateMessage.payload.state.status, 'finished');
  assert.equal(resumedStateMessage.payload.state.winnerId, playerA);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function watch(ws) {
  const messages = [];
  const onMessage = (data) => {
    try {
      messages.push(JSON.parse(data.toString()));
    } catch {
      // ignore
    }
  };
  ws.on('message', onMessage);
  return {
    messages,
    stop() {
      ws.off('message', onMessage);
    },
  };
}

async function expectMessage(watcher, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = watcher.messages.find(predicate);
    if (found) return found;
    await delay(10);
  }
  assert.fail('No se recibió el mensaje esperado');
}

function waitForClose(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout esperando cierre del socket'));
    }, timeoutMs);
    const onClose = (code) => {
      cleanup();
      resolve(code);
    };
    const onError = () => {};
    function cleanup() {
      clearTimeout(timer);
      ws.off('close', onClose);
      ws.off('error', onError);
    }
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

function connectWith(port, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function setup(t, options = {}) {
  const app = createServer(options);
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    await app.close();
  });
  const address = await app.listen(0, '127.0.0.1');
  return {
    app,
    port: address.port,
    sockets,
    track(ws) {
      sockets.push(ws);
      return ws;
    },
  };
}

async function hello(ctx, alias, requestId = `hello-${alias}`) {
  const ws = ctx.track(await connect(ctx.port));
  const playerId = crypto.randomUUID();
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const welcome = waitForMessage(ws, (msg) => msg.type === 'server.welcome' && msg.requestId === requestId);
  send(ws, 'client.hello', { playerId, sessionToken, alias }, requestId);
  await welcome;
  return { ws, playerId, sessionToken };
}

async function createRoom(ws, alias, config = {}, requestId = 'create') {
  const created = waitForMessage(ws, (msg) => msg.type === 'server.roomCreated' && msg.requestId === requestId);
  send(ws, 'client.createRoom', { config, alias }, requestId);
  return (await created).payload;
}

async function joinRoom(ws, code, alias, requestId = 'join') {
  const joined = waitForMessage(ws, (msg) => msg.type === 'server.roomJoined' && msg.requestId === requestId);
  send(ws, 'client.joinRoom', { code, alias }, requestId);
  return (await joined).payload;
}

async function startGame(ws, requestId = 'start') {
  const started = waitForMessage(ws, (msg) => msg.type === 'server.gameStarted' && msg.requestId === requestId);
  send(ws, 'client.startGame', {}, requestId);
  return (await started).payload.state;
}

function forceTimeout(app, code) {
  const room = app.manager.rooms.get(code);
  assert.ok(room && room.game, 'sala con partida activa');
  room.game.turnDeadline = Date.now() - 1;
  room.processExpiredTurn();
}

test('NOT_ENOUGH_PLAYERS y contrato de identidad sin filtrar sessionToken', { timeout: 10000 }, async (t) => {
  const ctx = await setup(t);
  const ws = ctx.track(await connect(ctx.port));
  const playerId = crypto.randomUUID();
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const watched = watch(ws);
  send(ws, 'client.hello', { playerId, sessionToken, alias: 'Ana' }, 'hello-main');
  const welcome = await expectMessage(watched, (msg) => msg.type === 'server.welcome' && msg.requestId === 'hello-main');
  assert.equal(welcome.payload.playerId, playerId);
  assert.equal(welcome.payload.sessionToken, undefined);
  assert.ok(!JSON.stringify(welcome).includes(sessionToken));

  const created = await createRoom(ws, 'Ana', { size: 8 }, 'create-main');
  assert.ok(!JSON.stringify(created).includes(sessionToken));
  const errorWatcher = watch(ws);
  send(ws, 'client.startGame', {}, 'start-alone');
  const error = await expectMessage(errorWatcher, (msg) => msg.type === 'server.error' && msg.requestId === 'start-alone');
  assert.equal(error.payload.code, 'NOT_ENOUGH_PLAYERS');
  assert.equal(ctx.app.manager.rooms.get(created.roomCode).status, 'lobby');

  const generatedWs = ctx.track(await connect(ctx.port));
  send(generatedWs, 'client.hello', {}, 'hello-generated');
  const generated = await waitForMessage(generatedWs, (msg) => msg.type === 'server.welcome' && msg.requestId === 'hello-generated');
  assert.match(generated.payload.playerId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(generated.payload.sessionToken, undefined);

  const badWs = ctx.track(await connect(ctx.port));
  const badWatcher = watch(badWs);
  const badClose = waitForClose(badWs);
  send(badWs, 'client.hello', { playerId, sessionToken: 'token-incorrecto-123456' }, 'hello-bad');
  const badError = await expectMessage(badWatcher, (msg) => msg.type === 'server.error' && msg.requestId === 'hello-bad');
  assert.equal(badError.payload.code, 'SESSION_INVALID');
  assert.equal(await badClose, 4001);
});

test('updateConfig y resetConfig', { timeout: 10000 }, async (t) => {
  const ctx = await setup(t);
  const a = await hello(ctx, 'Ana');
  const b = await hello(ctx, 'Luis');
  const created = await createRoom(a.ws, 'Ana', { maxPlayers: 4 }, 'create-cfg');
  const code = created.roomCode;
  await joinRoom(b.ws, code, 'Luis', 'join-cfg');

  const watcherA = watch(a.ws);
  const watcherB = watch(b.ws);
  send(a.ws, 'client.updateConfig', { config: { size: 16, wallsPerPlayer: 8, maxPlayers: 2 } }, 'cfg-1');
  const updatedA = await expectMessage(watcherA, (msg) => msg.type === 'server.roomUpdate' && msg.payload.config.size === 16);
  const updatedB = await expectMessage(watcherB, (msg) => msg.type === 'server.roomUpdate' && msg.payload.config.size === 16);
  assert.equal(updatedA.payload.config.wallsPerPlayer, 8);
  assert.equal(updatedB.payload.config.maxPlayers, 2);
  assert.equal(updatedB.payload.config.turnSeconds, 30);

  const errors = watch(b.ws);
  const errorsA = watch(a.ws);
  send(b.ws, 'client.updateConfig', { config: { size: 9 } }, 'cfg-nohost');
  const notHost = await expectMessage(errors, (msg) => msg.type === 'server.error' && msg.requestId === 'cfg-nohost');
  assert.equal(notHost.payload.code, 'NOT_HOST');

  send(a.ws, 'client.updateConfig', { config: { size: 7 } }, 'cfg-bad');
  const invalid = await expectMessage(errorsA, (msg) => msg.type === 'server.error' && msg.requestId === 'cfg-bad');
  assert.equal(invalid.payload.code, 'INVALID_CONFIG');

  send(a.ws, 'client.updateConfig', { config: { size: 17 } }, 'cfg-too-big');
  const tooBig = await expectMessage(errorsA, (msg) => msg.type === 'server.error' && msg.requestId === 'cfg-too-big');
  assert.equal(tooBig.payload.code, 'INVALID_CONFIG');
  assert.equal(ctx.app.manager.rooms.get(code).config.size, 16);

  send(a.ws, 'client.resetConfig', {}, 'cfg-reset');
  const resetA = await expectMessage(watcherA, (msg) => msg.type === 'server.roomUpdate' && msg.payload.config.size === 12);
  const resetB = await expectMessage(watcherB, (msg) => msg.type === 'server.roomUpdate' && msg.payload.config.size === 12);
  assert.equal(resetA.payload.config.wallsPerPlayer, 10);
  assert.equal(resetA.payload.config.spawnMode, 'random');
  assert.equal(resetA.payload.config.turnSeconds, 30);
  assert.equal(resetB.payload.config.maxPlayers, 4);
});

test('WRONG_STATE por fase y GAME_STARTED en sus casos propios', { timeout: 10000 }, async (t) => {
  const ctx = await setup(t);
  const a = await hello(ctx, 'Ana');
  const b = await hello(ctx, 'Luis');
  const code = (await createRoom(a.ws, 'Ana', { size: 8 }, 'create-state')).roomCode;
  await joinRoom(b.ws, code, 'Luis', 'join-state');

  const errorsA = watch(a.ws);
  send(a.ws, 'client.move', { to: { x: 0, y: 0 } }, 'move-lobby');
  const inLobby = await expectMessage(errorsA, (msg) => msg.type === 'server.error' && msg.requestId === 'move-lobby');
  assert.equal(inLobby.payload.code, 'WRONG_STATE');

  await startGame(a.ws, 'start-state');
  send(b.ws, 'client.updateConfig', { config: { size: 9 } }, 'cfg-playing');
  const errorsB = watch(b.ws);
  const wrongConfig = await expectMessage(errorsB, (msg) => msg.type === 'server.error' && msg.requestId === 'cfg-playing');
  assert.equal(wrongConfig.payload.code, 'WRONG_STATE');

  send(b.ws, 'client.resetConfig', {}, 'reset-playing');
  const wrongReset = await expectMessage(errorsB, (msg) => msg.type === 'server.error' && msg.requestId === 'reset-playing');
  assert.equal(wrongReset.payload.code, 'WRONG_STATE');

  send(b.ws, 'client.startGame', {}, 'start-playing');
  const wrongStart = await expectMessage(errorsB, (msg) => msg.type === 'server.error' && msg.requestId === 'start-playing');
  assert.equal(wrongStart.payload.code, 'WRONG_STATE');

  const c = await hello(ctx, 'Cara');
  send(c.ws, 'client.joinRoom', { code, alias: 'Cara' }, 'join-playing');
  const errorsC = watch(c.ws);
  const started = await expectMessage(errorsC, (msg) => msg.type === 'server.error' && msg.requestId === 'join-playing');
  assert.equal(started.payload.code, 'GAME_STARTED');

  send(a.ws, 'client.leaveRoom', {}, 'leave-playing');
  const leaveError = await expectMessage(errorsA, (msg) => msg.type === 'server.error' && msg.requestId === 'leave-playing');
  assert.equal(leaveError.payload.code, 'GAME_STARTED');
});

test('ROOM_EXPIRED al intentar unirse a una sala caducada', { timeout: 10000 }, async (t) => {
  const ctx = await setup(t);
  const a = await hello(ctx, 'Ana');
  const b = await hello(ctx, 'Luis');
  const code = (await createRoom(a.ws, 'Ana', { size: 8 }, 'create-expired')).roomCode;
  await joinRoom(b.ws, code, 'Luis', 'join-expired');

  const watcherA = watch(a.ws);
  const room = ctx.app.manager.rooms.get(code);
  room.lastActivityAt = Date.now() - 2000000;
  ctx.app.manager.expireRooms();
  const toastA = await expectMessage(watcherA, (msg) => msg.type === 'server.toast' && msg.payload.code === 'ROOM_EXPIRED');
  assert.equal(toastA.payload.level, 'warning');
  assert.equal(ctx.app.manager.rooms.get(code), undefined);
  assert.equal(ctx.app.manager.expiredRooms.has(code), true);

  const c = await hello(ctx, 'Cara');
  const watcherC = watch(c.ws);
  send(c.ws, 'client.joinRoom', { code, alias: 'Cara' }, 'join-gone');
  const expired = await expectMessage(watcherC, (msg) => msg.type === 'server.error' && msg.requestId === 'join-gone');
  assert.equal(expired.payload.code, 'ROOM_EXPIRED');
  const expiredToast = await expectMessage(watcherC, (msg) => msg.type === 'server.toast' && msg.payload.code === 'ROOM_EXPIRED');
  assert.ok(expiredToast);

  send(c.ws, 'client.joinRoom', { code: 'ZZZZZZ', alias: 'Cara' }, 'join-missing');
  const missing = await expectMessage(watcherC, (msg) => msg.type === 'server.error' && msg.requestId === 'join-missing');
  assert.equal(missing.payload.code, 'ROOM_NOT_FOUND');
});

test('timeout de 30 s con auto-move mantiene el bucle de turno', { timeout: 10000 }, async (t) => {
  assert.equal(TICK_INTERVAL_MS, 1000);
  const ctx = await setup(t);
  const a = await hello(ctx, 'Ana');
  const b = await hello(ctx, 'Luis');
  const code = (await createRoom(a.ws, 'Ana', { size: 16 }, 'create-timeout')).roomCode;
  await joinRoom(b.ws, code, 'Luis', 'join-timeout');
  const initial = await startGame(a.ws, 'start-timeout');
  const room = ctx.app.manager.rooms.get(code);
  const remaining = room.game.turnDeadline - Date.now();
  assert.ok(remaining > 29000 && remaining <= 30000, `deadline inesperado: ${remaining}`);

  const watcherA = watch(a.ws);
  forceTimeout(ctx.app, code);
  const timeoutToast = await expectMessage(watcherA, (msg) => msg.type === 'server.toast' && msg.payload.code === 'TURN_TIMEOUT');
  assert.equal(timeoutToast.payload.level, 'info');
  const state = await expectMessage(watcherA, (msg) => msg.type === 'server.gameState' && msg.payload.state.turnNumber === initial.turnNumber + 1);
  assert.notEqual(state.payload.state.turnPlayerId, initial.turnPlayerId);
  assert.ok(room.game.tickTimer && room.game.turnTimer, 'los timers siguen activos');
  const nextRemaining = room.game.turnDeadline - Date.now();
  assert.ok(nextRemaining > 29000 && nextRemaining <= 30000, `deadline reiniciado inesperado: ${nextRemaining}`);
});

test('AFK: dos acciones inválidas en turnos distintos convierten en fantasma', { timeout: 10000 }, async (t) => {
  const ctx = await setup(t);
  const a = await hello(ctx, 'Ana');
  const b = await hello(ctx, 'Luis');
  const code = (await createRoom(a.ws, 'Ana', { size: 16 }, 'create-afk')).roomCode;
  await joinRoom(b.ws, code, 'Luis', 'join-afk');
  const initial = await startGame(a.ws, 'start-afk');
  const targetId = initial.turnPlayerId;
  const targetWs = targetId === a.playerId ? a.ws : b.ws;
  const targetPlayer = initial.players.find((player) => player.id === targetId);
  const invalidMove = { to: { x: targetPlayer.pos.x, y: targetPlayer.pos.y } };
  const targetWatcher = watch(targetWs);

  send(targetWs, 'client.move', invalidMove, 'afk-first');
  const first = await expectMessage(targetWatcher, (msg) => msg.type === 'server.actionRejected' && msg.requestId === 'afk-first');
  assert.equal(first.payload.warning, true);
  assert.equal(first.payload.invalidTurnCount, 1);
  assert.equal(first.payload.ghosted, false);

  forceTimeout(ctx.app, code);
  forceTimeout(ctx.app, code);
  const room = ctx.app.manager.rooms.get(code);
  assert.equal(room.game.engine.state.turnPlayerId, targetId);
  const movedPlayer = room.game.engine.state.players.find((player) => player.id === targetId);
  const secondInvalidMove = { to: { x: movedPlayer.pos.c, y: movedPlayer.pos.r } };

  const otherWatcher = watch(targetId === a.playerId ? b.ws : a.ws);
  const closePromise = waitForClose(targetWs);
  send(targetWs, 'client.move', secondInvalidMove, 'afk-second');
  const second = await expectMessage(targetWatcher, (msg) => msg.type === 'server.actionRejected' && msg.requestId === 'afk-second');
  assert.equal(second.payload.ghosted, true);
  assert.equal(second.payload.invalidTurnCount, 2);
  const disconnected = await expectMessage(otherWatcher, (msg) => msg.type === 'server.playerDisconnected' && msg.payload.playerId === targetId);
  assert.equal(disconnected.payload.reason, 'afk');
  assert.equal(disconnected.payload.ghost, true);
  assert.equal(await closePromise, 4003);
});

test('leaveGame crea fantasma y mantiene la partida con tres jugadores', { timeout: 10000 }, async (t) => {
  const ctx = await setup(t);
  const a = await hello(ctx, 'Ana');
  const b = await hello(ctx, 'Luis');
  const c = await hello(ctx, 'Cara');
  const code = (await createRoom(a.ws, 'Ana', { size: 16, maxPlayers: 3 }, 'create-leave')).roomCode;
  await joinRoom(b.ws, code, 'Luis', 'join-leave-b');
  await joinRoom(c.ws, code, 'Cara', 'join-leave-c');
  const initial = await startGame(a.ws, 'start-leave');
  const targetId = initial.turnPlayerId;
  const target = [a, b, c].find((entry) => entry.playerId === targetId);
  const others = [a, b, c].filter((entry) => entry.playerId !== targetId);

  const watcher = watch(target.ws);
  const otherWatcher = watch(others[0].ws);
  send(target.ws, 'client.leaveGame', {}, 'leave-game');
  const disconnected = await expectMessage(otherWatcher, (msg) => msg.type === 'server.playerDisconnected' && msg.payload.playerId === targetId);
  assert.equal(disconnected.payload.reason, 'leave');
  assert.equal(disconnected.payload.ghost, true);
  const state = await expectMessage(otherWatcher, (msg) => msg.type === 'server.gameState' && msg.payload.state.players.some((player) => player.id === targetId && player.ghost));
  assert.equal(state.payload.state.status, 'playing');

  send(target.ws, 'client.move', { to: { x: 0, y: 0 } }, 'move-ghost');
  const ghostRejection = await expectMessage(watcher, (msg) => msg.type === 'server.actionRejected' && msg.requestId === 'move-ghost');
  assert.equal(ghostRejection.payload.code, 'PLAYER_GHOST');

  const d = await hello(ctx, 'Dani');
  const secondCode = (await createRoom(d.ws, 'Dani', { size: 8 }, 'create-other')).roomCode;
  const errors = watch(target.ws);
  send(target.ws, 'client.joinRoom', { code: secondCode, alias: 'Ana' }, 'join-while-ghost');
  const already = await expectMessage(errors, (msg) => msg.type === 'server.error' && msg.requestId === 'join-while-ghost');
  assert.equal(already.payload.code, 'ALREADY_IN_ROOM');

  const reconnectWs = ctx.track(await connect(ctx.port));
  const reconnectWatcher = watch(reconnectWs);
  send(reconnectWs, 'client.hello', { playerId: target.playerId, sessionToken: target.sessionToken }, 'hello-rejoin');
  const welcome = await expectMessage(reconnectWatcher, (msg) => msg.type === 'server.welcome' && msg.requestId === 'hello-rejoin');
  assert.equal(welcome.payload.resumed, true);
  assert.equal(ctx.app.manager.rooms.get(code).players.get(targetId).ghost, false);
});

test('rematch vuelve a lobby y conserva la configuración', { timeout: 10000 }, async (t) => {
  const ctx = await setup(t);
  const a = await hello(ctx, 'Ana');
  const b = await hello(ctx, 'Luis');
  const code = (await createRoom(a.ws, 'Ana', { size: 16, wallsPerPlayer: 8 }, 'create-rematch')).roomCode;
  await joinRoom(b.ws, code, 'Luis', 'join-rematch');
  await startGame(a.ws, 'start-rematch');

  const errors = watch(a.ws);
  send(a.ws, 'client.rematch', {}, 'rematch-playing');
  const unavailable = await expectMessage(errors, (msg) => msg.type === 'server.error' && msg.requestId === 'rematch-playing');
  assert.equal(unavailable.payload.code, 'REMATCH_NOT_AVAILABLE');

  const watcherA = watch(a.ws);
  b.ws.close();
  const gameOver = await expectMessage(watcherA, (msg) => msg.type === 'server.gameOver');
  assert.equal(gameOver.payload.reason, 'last_active');

  send(a.ws, 'client.rematch', {}, 'rematch-1');
  const lobby = await expectMessage(watcherA, (msg) => msg.type === 'server.rematchLobby' && msg.requestId === 'rematch-1');
  assert.equal(lobby.payload.roomCode, code);
  assert.equal(lobby.payload.status, 'lobby');
  assert.equal(lobby.payload.config.size, 16);
  assert.equal(lobby.payload.config.wallsPerPlayer, 8);
  assert.equal(lobby.payload.players.length, 1);
  assert.equal(ctx.app.manager.rooms.get(code).game, null);

  send(a.ws, 'client.rematch', {}, 'rematch-2');
  const again = await expectMessage(watcherA, (msg) => msg.type === 'server.rematchLobby' && msg.requestId === 'rematch-2');
  assert.equal(again.payload.status, 'lobby');
});

test('matchmaking: emparejamiento y cancelación de cola', { timeout: 10000 }, async (t) => {
  const ctx = await setup(t);
  const a = await hello(ctx, 'Ana');
  const b = await hello(ctx, 'Luis');
  const c = await hello(ctx, 'Cara');

  const watcherA = watch(a.ws);
  const watcherB = watch(b.ws);
  const watcherC = watch(c.ws);
  send(a.ws, 'client.quickPlay', {}, 'quick-a');
  const searchingA = await expectMessage(watcherA, (msg) => msg.type === 'server.matchSearching' && msg.requestId === 'quick-a');
  assert.equal(searchingA.payload.config.maxPlayers, 8);
  assert.equal(searchingA.payload.config.size, 12);

  send(b.ws, 'client.quickPlay', {}, 'quick-b');
  const foundA = await expectMessage(watcherA, (msg) => msg.type === 'server.matchFound');
  const foundB = await expectMessage(watcherB, (msg) => msg.type === 'server.matchFound');
  assert.deepEqual(foundA.payload.playerIds, [a.playerId, b.playerId]);
  assert.equal(foundB.payload.roomCode, foundA.payload.roomCode);
  const startedA = await expectMessage(watcherA, (msg) => msg.type === 'server.gameStarted');
  const startedB = await expectMessage(watcherB, (msg) => msg.type === 'server.gameStarted');
  assert.equal(startedA.payload.gameId, startedB.payload.gameId);

  send(c.ws, 'client.quickPlay', {}, 'quick-c');
  const searchingC = await expectMessage(watcherC, (msg) => msg.type === 'server.matchSearching' && msg.requestId === 'quick-c');
  assert.equal(searchingC.payload.queueSize, 1);

  send(c.ws, 'client.cancelQuickPlay', {}, 'cancel-c');
  const cancelled = await expectMessage(watcherC, (msg) => msg.type === 'server.matchCancelled' && msg.requestId === 'cancel-c');
  assert.equal(cancelled.payload.queueSize, 0);

  send(c.ws, 'client.cancelQuickPlay', {}, 'cancel-again');
  const missing = await expectMessage(watcherC, (msg) => msg.type === 'server.error' && msg.requestId === 'cancel-again');
  assert.equal(missing.payload.code, 'NOT_IN_QUEUE');
});

test('rate limiting: token bucket, violaciones y fábricas reutilizables', () => {
  const limiter = createRateLimiter();
  const start = 1000000;
  for (let index = 0; index < 40; index += 1) {
    assert.equal(limiter.hit(start).allowed, true);
  }
  for (let violation = 1; violation < 5; violation += 1) {
    const decision = limiter.hit(start);
    assert.equal(decision.allowed, false);
    assert.equal(decision.violations, violation);
    assert.equal(decision.close, false);
  }
  const fatal = limiter.hit(start);
  assert.equal(fatal.allowed, false);
  assert.equal(fatal.violations, 5);
  assert.equal(fatal.close, true);

  const refill = createRateLimiter();
  for (let index = 0; index < 40; index += 1) refill.hit(0);
  for (let index = 0; index < 4; index += 1) assert.equal(refill.hit(1000).allowed, true);
  assert.equal(refill.hit(1000).allowed, false);

  const ips = createIpLimiters({ maxConnections: 2 });
  assert.equal(ips.acquireConnection('1.2.3.4'), true);
  assert.equal(ips.acquireConnection('1.2.3.4'), true);
  assert.equal(ips.acquireConnection('1.2.3.4'), false);
  ips.releaseConnection('1.2.3.4');
  assert.equal(ips.acquireConnection('1.2.3.4'), true);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(ips.allowHello('5.6.7.8', 0).allowed, true);
  }
  assert.equal(ips.allowHello('5.6.7.8', 0).close, true);
});

test('rate limiting en WS: RATE_LIMITED y cierre 1008', { timeout: 10000 }, async (t) => {
  const ctx = await setup(t);
  const ws = ctx.track(await connect(ctx.port));
  send(ws, 'client.hello', { playerId: crypto.randomUUID(), sessionToken: crypto.randomBytes(32).toString('hex') }, 'hello-rate');
  await waitForMessage(ws, (msg) => msg.type === 'server.welcome' && msg.requestId === 'hello-rate');

  const watcher = watch(ws);
  const closePromise = waitForClose(ws);
  for (let index = 0; index < 50; index += 1) send(ws, 'client.ping', {}, `ping-${index}`);
  const limited = await expectMessage(watcher, (msg) => msg.type === 'server.error' && msg.payload.code === 'RATE_LIMITED');
  assert.ok(limited);
  assert.equal(await closePromise, 1008);
  assert.equal(ctx.app.ipLimiters.connections.size, 0);
});

test('seguridad en upgrade: Origin y límite de conexiones por IP', { timeout: 10000 }, async (t) => {
  const ctx = await setup(t, { allowedOrigins: ['https://permitido.example'] });
  const sameHost = ctx.track(await connectWith(ctx.port, { origin: `http://127.0.0.1:${ctx.port}` }));
  assert.equal(sameHost.readyState, WebSocket.OPEN);
  const configured = ctx.track(await connectWith(ctx.port, { origin: 'https://permitido.example' }));
  assert.equal(configured.readyState, WebSocket.OPEN);
  await assert.rejects(
    () => connectWith(ctx.port, { origin: 'https://malicioso.example' }),
    /403/,
  );

  const limited = await setup(t, { maxConnectionsPerIp: 2 });
  const first = limited.track(await connect(limited.port));
  limited.track(await connect(limited.port));
  assert.equal(first.readyState, WebSocket.OPEN);
  await assert.rejects(() => connect(limited.port));
});
