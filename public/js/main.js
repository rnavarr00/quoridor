import { net } from './net.js';
import { ui } from './ui.js';
import { app } from './state.js';
import { GameEngine, generateSpawnsAndGoals } from '/core/index.js';

const LOCAL_TURN_MS = 30000;
const LOCAL_TURN_SECONDS = 30;
let localTimer = null;

function getMyId() {
  return app.myId || net.getIdentity().playerId;
}

function showScreen(name, options = {}) {
  app.screen = name;
  ui.showScreen(name, { focus: false, push: false, ...options });
}

function clearPending() {
  app.pending = null;
  ui.setCreatePending(false);
  ui.setJoinPending(false);
  ui.setQueuePending(false);
  ui.board?.setPending(false);
}

function setPending(action) {
  app.pending = { action };
  if (action === 'createRoom') ui.setCreatePending(true);
  else if (action === 'joinRoom') ui.setJoinPending(true);
  else if (action === 'quickPlay' || action === 'cancelQuickPlay') ui.setQueuePending(true);
  else if (action === 'rematch') ui.setGameOverPending(true, 'online');
  else if (action === 'move' || action === 'placeWall') ui.board?.setPending(true);
}

function goalPublic(goal, size) {
  if (!goal) return { side: 'any', index: 0, x: 0, y: 0 };
  if (Number.isInteger(goal.x) && Number.isInteger(goal.y)) {
    let side = 'any';
    if (goal.y === 0) side = 'top';
    else if (goal.y === size - 1) side = 'bottom';
    else if (goal.x === 0) side = 'left';
    else if (goal.x === size - 1) side = 'right';
    return { side, index: side === 'left' || side === 'right' ? goal.y : goal.x, x: goal.x, y: goal.y };
  }
  return { ...goal };
}

function localView(engine, remaining = LOCAL_TURN_SECONDS) {
  const state = engine.getState();
  const size = state.config.size;
  return {
    board: { size },
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      colorIndex: player.colorIndex,
      pos: { x: player.pos.c, y: player.pos.r },
      spawn: { x: player.spawn.c, y: player.spawn.r },
      goal: goalPublic(player.goal, size),
      wallsLeft: player.wallsLeft,
      camping: player.camping ? { ...player.camping } : null,
      ghost: Boolean(player.ghost),
      connected: player.connected !== false,
      isTurn: state.turnPlayerId === player.id,
    })),
    walls: {
      H: state.walls.filter((wall) => wall.orientation === 'H').map((wall) => ({ x: wall.x, y: wall.y })),
      V: state.walls.filter((wall) => wall.orientation === 'V').map((wall) => ({ x: wall.x, y: wall.y })),
    },
    turnPlayerId: state.status === 'finished' ? null : state.turnPlayerId,
    remainingSeconds: remaining,
    turnNumber: state.turnNumber,
    status: state.status,
    winnerId: state.winnerId || null,
    config: { ...state.config },
  };
}

function stopLocalTimer() {
  if (localTimer !== null) {
    clearInterval(localTimer);
    localTimer = null;
  }
}

function startLocalTimer() {
  stopLocalTimer();
  const deadline = Date.now() + LOCAL_TURN_MS;
  ui.updateTimer(LOCAL_TURN_SECONDS);
  localTimer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    ui.updateTimer(remaining);
    if (remaining > 0) return;
    stopLocalTimer();
    const engine = app.local?.engine;
    const playerId = engine?.state?.turnPlayerId;
    if (!playerId) return;
    const result = engine.autoMove(playerId);
    if (!result.ok) {
      showLocalTurn();
      return;
    }
    completeLocalAction();
  }, 200);
}

function renderGame(view, options = {}) {
  if (!view) return;
  app.game = view;
  app.screen = 'game';
  const renderOptions = {
    myId: options.myId || getMyId(),
    roomCode: options.roomCode || app.room?.roomCode || '',
    mode: app.mode === 'local' ? 'local' : 'online',
    canAct: options.canAct !== false,
    pending: Boolean(options.pending),
    waiting: Boolean(options.waiting),
  };
  ui.renderGame(view, renderOptions);
  ui.board?.render(view, renderOptions);
  if (Number.isFinite(view.remainingSeconds)) ui.updateTimer(view.remainingSeconds);
}

function renderLobby(room, options = {}) {
  if (!room) return;
  app.room = room;
  app.screen = 'lobby';
  ui.renderLobby(room, {
    myId: getMyId(),
    pending: Boolean(options.pending),
    pendingAction: options.pendingAction || app.pending?.action || '',
  });
}

function resetOnlineView() {
  clearPending();
  app.room = null;
  app.game = null;
  app.gameOver = null;
  app.queue = null;
  app.mode = null;
  ui.hideHandoff();
}

function abandonLocal() {
  stopLocalTimer();
  ui.hideHandoff();
  clearPending();
  app.local = null;
  app.game = null;
  app.gameOver = null;
  app.queue = null;
  app.room = null;
  app.mode = null;
  ui.setLocalDefaults();
  showScreen('local');
}

function showLocalTurn() {
  stopLocalTimer();
  ui.setTimerStatic('—');
  const engine = app.local?.engine;
  if (!engine) return;
  const state = engine.getState();
  const current = state.players.find((player) => player.id === state.turnPlayerId) || state.players[0];
  if (!current) return;
  ui.showHandoff(
    { name: current.name, colorIndex: current.colorIndex },
    {
      onContinue: () => {
        renderGame(localView(engine), { myId: current.id, roomCode: 'LOCAL' });
        startLocalTimer();
      },
      onAbandon: () => abandonLocal(),
    },
  );
}

function completeLocalAction() {
  const engine = app.local?.engine;
  if (!engine) return;
  const state = engine.getState();
  const view = localView(engine, state.status === 'finished' ? 0 : LOCAL_TURN_SECONDS);
  renderGame(view, { myId: state.turnPlayerId, roomCode: 'LOCAL', canAct: false });
  if (state.status !== 'finished') {
    showLocalTurn();
    return;
  }
  const winner = state.players.find((player) => player.id === state.winnerId) || null;
  const payload = {
    roomCode: 'LOCAL',
    gameId: 'local',
    winnerId: state.winnerId || null,
    winnerName: winner?.name || null,
    reason: 'goal',
    state: view,
  };
  app.gameOver = payload;
  app.screen = 'gameover';
  stopLocalTimer();
  ui.setTimerStatic('—');
  ui.renderGameOver(payload, { myId: null, mode: 'local', pending: false });
}

function startLocalGame(setup) {
  stopLocalTimer();
  ui.hideHandoff();
  clearPending();
  const players = setup.players.map((player) => ({
    id: player.id,
    name: player.name,
    colorIndex: player.colorIndex,
  }));
  let engine;
  try {
    const spawns = generateSpawnsAndGoals({
      size: setup.config.size,
      playerCount: players.length,
      mode: setup.config.spawnMode,
      seed: null,
    });
    engine = GameEngine.create(setup.config, players, spawns);
  } catch (error) {
    ui.setLocalError('No se pudo generar la partida con esa configuración.');
    return;
  }
  app.mode = 'local';
  app.room = null;
  app.game = null;
  app.gameOver = null;
  app.queue = null;
  app.local = { setup, engine };
  ui.setLocalPlayers(setup.players.map((player) => player.name));
  ui.setLocalError(null);
  showLocalTurn();
}

function leaveCurrentRoom() {
  if (app.queue) {
    setPending('cancelQuickPlay');
    net.send('client.cancelQuickPlay', {});
    return;
  }
  if (app.game && app.game.status === 'playing') {
    setPending('leaveGame');
    net.send('client.leaveGame', {});
    return;
  }
  if (app.room) {
    setPending('leaveLobby');
    net.send('client.leaveRoom', {});
  }
}

app.myId = net.getIdentity().playerId;
net.setToastSink((message, level, code) => ui.toast(message, level, code));

net.onStatus((status, info) => {
  app.connection = status;
  ui.setConnection(status, info);
});

ui.init({
  onAliasChange: (value) => {
    net.setAlias(value);
    app.myId = getMyId();
  },
  onNavigate: (target) => {
    if (target !== 'home') return;
    if (app.mode === 'local') {
      stopLocalTimer();
      ui.hideHandoff();
      resetOnlineView();
      showScreen('home');
      return;
    }
    leaveCurrentRoom();
    resetOnlineView();
    showScreen('home');
  },
  onHomeAction: (action) => {
    if (action === 'local') {
      app.mode = null;
      showScreen('local');
      return;
    }
    app.mode = 'online';
    if (action === 'create') {
      ui.setCreateError(null);
      showScreen('create');
    } else if (action === 'join') {
      ui.setJoinError(null);
      showScreen('join');
    } else if (action === 'casual') {
      app.queue = {};
      app.screen = 'queue';
      ui.renderQueue({});
      setPending('quickPlay');
      net.send('client.quickPlay', {});
    }
  },
  onCreate: (config) => {
    setPending('createRoom');
    net.send('client.createRoom', { config, alias: net.alias || net.getIdentity().alias });
  },
  onJoin: (code) => {
    setPending('joinRoom');
    net.send('client.joinRoom', { code, alias: net.alias || net.getIdentity().alias });
  },
  onLocalStart: (setup) => {
    if (!setup.ok) {
      ui.setLocalError(setup.error);
      return;
    }
    startLocalGame(setup);
  },
  onCancelQueue: () => {
    setPending('cancelQuickPlay');
    net.send('client.cancelQuickPlay', {});
  },
  onLobbyReset: () => {
    setPending('resetConfig');
    net.send('client.resetConfig', {});
    renderLobby(app.room, { pending: true, pendingAction: 'resetConfig' });
  },
  onStartGame: () => {
    setPending('startGame');
    net.send('client.startGame', {});
    renderLobby(app.room, { pending: true, pendingAction: 'startGame' });
  },
  onLobbyConfig: (config) => {
    setPending('updateConfig');
    net.send('client.updateConfig', { config });
    renderLobby(app.room, { pending: true, pendingAction: 'updateConfig' });
  },
  onBoardMove: ({ x, y }) => {
    if (app.mode === 'local') {
      const engine = app.local?.engine;
      if (!engine) return;
      const result = engine.move(engine.state.turnPlayerId, { x, y });
      if (!result.ok) {
        ui.toast('Movimiento no válido.', 'error');
        return;
      }
      completeLocalAction();
      return;
    }
    setPending('move');
    net.send('client.move', { to: { x, y } });
  },
  onBoardWall: ({ orientation, x, y }) => {
    if (app.mode === 'local') {
      const engine = app.local?.engine;
      if (!engine) return;
      const result = engine.placeWall(engine.state.turnPlayerId, orientation, x, y);
      if (!result.ok) {
        ui.toast('Pared no válida.', 'error');
        return;
      }
      completeLocalAction();
      return;
    }
    setPending('placeWall');
    net.send('client.placeWall', { orientation, x, y });
  },
  onLeaveLobby: () => {
    setPending('leaveLobby');
    net.send('client.leaveRoom', {});
  },
  onLeaveGame: () => {
    if (app.mode === 'local') {
      abandonLocal();
      return;
    }
    setPending('leaveGame');
    net.send('client.leaveGame', {});
    ui.toast('Has salido de la partida como fantasma.', 'info');
  },
  onLeaveGameOver: () => {
    if (app.mode === 'local') {
      abandonLocal();
      return;
    }
    setPending('leaveLobby');
    net.send('client.leaveRoom', {});
    resetOnlineView();
    showScreen('home');
  },
  onRematch: () => {
    if (app.mode === 'local') {
      if (app.local?.setup) startLocalGame(app.local.setup);
      else abandonLocal();
      return;
    }
    setPending('rematch');
    net.send('client.rematch', {});
  },
  getMyId,
  onTimerExpired: () => {},
});

ui.setAlias(net.getIdentity().alias || '');
app.screen = 'home';
ui.showScreen('home', { focus: false, push: false });

net.on('server.welcome', (payload) => {
  if (payload?.playerId) app.myId = payload.playerId;
});

net.on('server.roomCreated', (payload) => handleRoomSnapshot(payload));
net.on('server.roomJoined', (payload) => handleRoomSnapshot(payload));
net.on('server.roomUpdate', (payload) => {
  if (app.mode === 'local') return;
  clearPending();
  renderLobby(payload);
});

net.on('server.leftRoom', () => {
  if (app.mode === 'local') return;
  resetOnlineView();
  showScreen('home');
});

net.on('server.hostChanged', (payload) => {
  if (app.mode === 'local' || !app.room) return;
  app.room.hostPlayerId = payload.hostPlayerId;
  if (app.screen === 'lobby') renderLobby(app.room);
});

net.on('server.gameStarted', (payload) => {
  clearPending();
  app.mode = 'online';
  app.gameOver = null;
  app.queue = null;
  app.room = {
    ...(app.room || {}),
    roomCode: payload.roomCode,
    status: 'playing',
    config: payload.config || app.room?.config,
  };
  ui.setGameRoomCode(payload.roomCode || '');
  renderGame(payload.state, { roomCode: payload.roomCode });
});

net.on('server.gameState', (payload) => {
  if (!payload?.state) return;
  clearPending();
  app.mode = 'online';
  app.gameOver = null;
  app.room = {
    ...(app.room || {}),
    roomCode: payload.roomCode || app.room?.roomCode || '',
    status: payload.state.status === 'finished' ? 'finished' : 'playing',
  };
  renderGame(payload.state, { roomCode: payload.roomCode });
});

net.on('server.tick', (payload) => {
  if (app.mode === 'local') return;
  if (app.game) {
    app.game.turnPlayerId = payload.turnPlayerId;
    app.game.turnNumber = payload.turnNumber;
    app.game.remainingSeconds = payload.remainingSeconds;
  }
  if (Number.isFinite(payload.remainingSeconds)) ui.updateTimer(payload.remainingSeconds);
});

net.on('server.gameOver', (payload) => {
  clearPending();
  app.mode = 'online';
  app.game = payload.state || app.game;
  app.gameOver = payload;
  app.screen = 'gameover';
  ui.renderGameOver(payload, { myId: getMyId(), mode: 'online', pending: false });
});

net.on('server.actionRejected', () => {
  if (app.mode === 'local') return;
  clearPending();
  if (app.game && app.screen === 'game') renderGame(app.game, { roomCode: app.room?.roomCode });
});

net.on('server.toast', () => {});
net.on('server.pong', () => {});

net.on('server.playerDisconnected', (payload) => {
  if (!app.game) return;
  const player = app.game.players?.find((entry) => entry.id === payload.playerId);
  if (!player) return;
  player.ghost = Boolean(payload.ghost);
  player.connected = !payload.ghost;
});

net.on('server.playerReconnected', (payload) => {
  if (app.room && payload.hostPlayerId) app.room.hostPlayerId = payload.hostPlayerId;
  if (!app.game) return;
  const player = app.game.players?.find((entry) => entry.id === payload.playerId);
  if (player) {
    player.ghost = false;
    player.connected = true;
  }
});

net.on('server.matchSearching', (payload) => {
  clearPending();
  app.mode = 'online';
  app.queue = payload;
  app.screen = 'queue';
  ui.renderQueue(payload);
});

net.on('server.matchFound', (payload) => {
  clearPending();
  app.queue = null;
  app.room = {
    roomCode: payload.roomCode,
    status: 'playing',
    config: payload.config,
    players: [],
    hostPlayerId: null,
  };
  ui.setMatchFound();
});

net.on('server.matchCancelled', () => {
  clearPending();
  app.queue = null;
  showScreen('home');
  ui.toast('Búsqueda cancelada.', 'info');
});

net.on('server.rematchLobby', (payload) => {
  clearPending();
  app.mode = 'online';
  app.game = null;
  app.gameOver = null;
  ui.setGameOverPending(false, 'online');
  renderLobby(payload);
});

net.on('server.roomExpired', (payload) => {
  ui.toast(payload?.message || 'La sala ha caducado.', 'error', payload?.code || 'ROOM_EXPIRED');
  if (app.mode === 'local') return;
  resetOnlineView();
  showScreen('home');
});

net.on('server.error', (payload) => {
  if (app.mode === 'local') return;
  const code = payload?.code || '';
  if (code === 'ROOM_EXPIRED') {
    resetOnlineView();
    showScreen('home');
    return;
  }
  clearPending();
  if (code === 'NOT_IN_QUEUE' && app.queue) {
    app.queue = null;
    showScreen('home');
  }
});

function handleRoomSnapshot(payload) {
  if (!payload) return;
  clearPending();
  app.mode = 'online';
  app.queue = null;
  app.game = null;
  app.gameOver = null;
  renderLobby(payload);
}

net.connect();
