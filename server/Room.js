import crypto from 'node:crypto';
import {
  GameEngine,
  generateSpawnsAndGoals,
  mulberry32,
} from '../src/core/index.js';
import {
  ALIAS_MAX,
  ProtocolError,
  TICK_INTERVAL_MS,
  TURN_SECONDS,
  aliasKey,
  broadcast,
  clamp,
  cryptoRng,
  isPlainObject,
  mapEngineError,
  nowIso,
  randomSeed,
  send,
  validateAlias,
  validateConfig,
} from './protocol.js';

function sortedByColor(players) {
  return [...players].sort((a, b) => a.colorIndex - b.colorIndex);
}

function truncateCodePoints(value, max) {
  const points = [...value];
  return points.slice(0, max).join('');
}

export class Room {
  constructor(code, config, manager) {
    this.code = code;
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    this.lastActivityAt = Date.now();
    this.status = 'lobby';
    this.hostPlayerId = null;
    this.config = { ...config };
    this.players = new Map();
    this.game = null;
    this.manager = manager;
    this.closed = false;
    this.expired = false;
  }

  touch() {
    this.lastActivityAt = Date.now();
    this.updatedAt = nowIso();
  }

  getSockets(excludePlayerId = null) {
    const sockets = [];
    for (const player of this.players.values()) {
      if (excludePlayerId && player.id === excludePlayerId) continue;
      if (player.socket && player.socket.readyState === 1) sockets.push(player.socket);
    }
    return sockets;
  }

  broadcast(type, payload, requestId = undefined) {
    broadcast(this.getSockets(), type, payload, requestId);
  }

  broadcastExcept(playerId, type, payload, requestId = undefined) {
    broadcast(this.getSockets(playerId), type, payload, requestId);
  }

  getLobbySnapshot() {
    return {
      roomCode: this.code,
      hostPlayerId: this.hostPlayerId,
      config: { ...this.config },
      players: sortedByColor(this.players.values()).map((player) => ({
        id: player.id,
        name: player.name,
        colorIndex: player.colorIndex,
        isHost: player.id === this.hostPlayerId,
        connected: Boolean(player.connected && player.socket),
        ghost: Boolean(player.ghost),
      })),
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  lowestFreeColor() {
    const used = new Set([...this.players.values()].map((player) => player.colorIndex));
    for (let index = 0; index < 8; index += 1) {
      if (!used.has(index)) return index;
    }
    throw new ProtocolError('ROOM_FULL');
  }

  uniqueAlias(base, excludePlayerId = null) {
    const used = new Set();
    for (const player of this.players.values()) {
      if (player.id === excludePlayerId) continue;
      used.add(aliasKey(player.name));
    }
    if (!used.has(aliasKey(base))) return base;

    for (let suffixNumber = 2; suffixNumber <= 99; suffixNumber += 1) {
      const suffix = ` (${suffixNumber})`;
      const candidate = `${truncateCodePoints(base, ALIAS_MAX - suffix.length)}${suffix}`;
      if (!used.has(aliasKey(candidate))) return candidate;
    }
    throw new ProtocolError('INVALID_ALIAS');
  }

  addPlayer(session, aliasInput, options = {}) {
    if (this.status !== 'lobby') throw new ProtocolError('GAME_STARTED');
    if (this.players.has(session.playerId)) throw new ProtocolError('ALREADY_IN_ROOM');
    if (this.players.size >= this.config.maxPlayers) throw new ProtocolError('ROOM_FULL');

    const baseAlias = validateAlias(aliasInput ?? session.alias ?? 'Jugador');
    if (!baseAlias) throw new ProtocolError('INVALID_ALIAS');

    const name = this.uniqueAlias(baseAlias);
    const colorIndex = Number.isInteger(options.colorIndex)
      ? options.colorIndex
      : this.lowestFreeColor();

    if (colorIndex < 0 || colorIndex > 7 || [...this.players.values()].some((p) => p.colorIndex === colorIndex)) {
      throw new ProtocolError('ROOM_FULL');
    }

    const player = {
      id: session.playerId,
      alias: name,
      name,
      colorIndex,
      sessionToken: session.sessionToken,
      socket: session.socket,
      connected: Boolean(session.socket),
      ghost: false,
      isHost: false,
      joinedAt: nowIso(),
      invalidTurnCount: 0,
      invalidCountedThisTurn: false,
      lastInvalidTurnNumber: 0,
    };

    this.players.set(player.id, player);
    session.roomCode = this.code;
    session.alias = name;
    session.connected = player.connected;

    if (!this.hostPlayerId) {
      this.hostPlayerId = player.id;
    }
    this.refreshHostFlags();
    this.touch();
    return player;
  }

  refreshHostFlags() {
    for (const player of this.players.values()) {
      player.isHost = player.id === this.hostPlayerId;
    }
  }

  transferHost(reason = 'left') {
    const previousHostPlayerId = this.hostPlayerId;
    const candidates = sortedByColor(this.players.values());
    const next = candidates.find((player) => !player.ghost && player.connected && player.socket)
      || candidates[0]
      || null;
    this.hostPlayerId = next ? next.id : null;
    this.refreshHostFlags();
    if (previousHostPlayerId !== this.hostPlayerId) {
      this.broadcast('server.hostChanged', {
        previousHostPlayerId,
        hostPlayerId: this.hostPlayerId,
        reason,
      });
    }
    return this.hostPlayerId;
  }

  removePlayer(playerId, reason = 'leave') {
    const player = this.players.get(playerId);
    if (!player) return { removed: false, roomDeleted: false };

    const wasHost = player.id === this.hostPlayerId;
    this.players.delete(playerId);
    const session = this.manager.sessions.get(playerId);
    if (session && session.roomCode === this.code) session.roomCode = null;

    if (this.players.size === 0) {
      this.manager.deleteRoom(this.code);
      return { removed: true, roomDeleted: true };
    }

    if (wasHost) this.transferHost(reason);
    else this.refreshHostFlags();
    this.touch();
    return { removed: true, roomDeleted: false };
  }

  broadcastRoomUpdate(requestId = undefined) {
    if (this.closed) return;
    this.broadcast('server.roomUpdate', this.getLobbySnapshot(), requestId);
  }

  assertLobbyPhase() {
    if (this.status === 'playing') throw new ProtocolError('WRONG_STATE');
    if (this.status !== 'lobby') throw new ProtocolError('GAME_STARTED');
  }

  updateConfig(playerId, input) {
    this.assertLobbyPhase();
    if (playerId !== this.hostPlayerId) throw new ProtocolError('NOT_HOST');
    const result = validateConfig(input, {
      currentPlayers: this.players.size,
      base: this.config,
      requireObject: true,
    });
    if (!result.ok) throw new ProtocolError('INVALID_CONFIG', result.message);
    this.config = result.config;
    this.touch();
    this.broadcastRoomUpdate();
    return this.config;
  }

  resetConfig(playerId) {
    this.assertLobbyPhase();
    if (playerId !== this.hostPlayerId) throw new ProtocolError('NOT_HOST');
    this.config = {
      size: 12,
      maxPlayers: Math.max(4, this.players.size),
      wallsPerPlayer: 10,
      spawnMode: 'random',
      turnSeconds: TURN_SECONDS,
    };
    this.touch();
    this.broadcastRoomUpdate();
    return this.config;
  }

  startGame(actorId = null, options = {}) {
    this.assertLobbyPhase();
    if (actorId && actorId !== this.hostPlayerId) throw new ProtocolError('NOT_HOST');

    const active = sortedByColor(this.players.values())
      .filter((player) => player.connected && !player.ghost && player.socket);
    if (active.length < 2) throw new ProtocolError('NOT_ENOUGH_PLAYERS');

    const checked = validateConfig(this.config, { currentPlayers: 0, base: this.config });
    if (!checked.ok) throw new ProtocolError('INVALID_CONFIG', checked.message);
    const config = checked.config;

    const gameId = options.gameId || crypto.randomUUID();
    const seed = randomSeed();
    const rng = mulberry32(seed);
    let spawnResult;
    let engine;
    try {
      spawnResult = generateSpawnsAndGoals({
        size: config.size,
        playerCount: active.length,
        mode: config.spawnMode,
        rng,
        seed,
        maxAttempts: 64,
        nodeBudget: 50000,
      });
    } catch (error) {
      this.manager.logError?.('generateSpawnsAndGoals', error);
      throw new ProtocolError('INVALID_CONFIG', 'No se pudieron generar salidas y metas con la configuración actual.');
    }

    const enginePlayers = active.map((player) => ({
      id: player.id,
      name: player.name,
      colorIndex: player.colorIndex,
    }));
    try {
      engine = GameEngine.create(config, enginePlayers, spawnResult, seed);
    } catch (error) {
      this.manager.logError?.('GameEngine.create', error);
      throw new ProtocolError('INVALID_CONFIG', 'No se pudo crear la partida con la configuración actual.');
    }

    this.game = {
      gameId,
      engine,
      turnDeadline: 0,
      turnNumber: engine.state.turnNumber,
      tickTimer: null,
      turnTimer: null,
      winnerId: null,
      startedAt: nowIso(),
    };
    this.status = 'playing';
    this.touch();

    for (const player of this.players.values()) {
      player.invalidTurnCount = 0;
      player.invalidCountedThisTurn = false;
      player.lastInvalidTurnNumber = 0;
    }

    this.scheduleTurnTimers();

    if (options.broadcast !== false) this.emitGameStarted(options.requestId);
    return { gameId, config: { ...engine.state.config }, state: this.getGameState() };
  }

  emitGameStarted(requestId = undefined) {
    if (!this.game) return;
    const payload = {
      roomCode: this.code,
      gameId: this.game.gameId,
      config: { ...this.game.engine.state.config },
      state: this.getGameState(),
    };
    this.broadcast('server.gameStarted', payload, requestId);
  }

  goalPublic(goal, size) {
    let side = 'any';
    let index = 0;
    if (goal.r === 0) {
      side = 'top';
      index = goal.c;
    } else if (goal.r === size - 1) {
      side = 'bottom';
      index = goal.c;
    } else if (goal.c === 0) {
      side = 'left';
      index = goal.c;
    } else if (goal.c === size - 1) {
      side = 'right';
      index = goal.c;
    }
    return { side, index, x: goal.c, y: goal.r };
  }

  getGameState() {
    if (!this.game) return null;
    const engineState = this.game.engine.getState();
    const size = engineState.config.size;
    const playing = engineState.status === 'playing';
    const remainingSeconds = playing
      ? clamp(Math.ceil((this.game.turnDeadline - Date.now()) / 1000), 0, TURN_SECONDS)
      : 0;

    const players = sortedByColor(engineState.players).map((player) => {
      const connected = player.connected !== false;
      const ghost = Boolean(player.ghost);
      return {
        id: player.id,
        name: player.name,
        colorIndex: player.colorIndex,
        pos: { x: player.pos.c, y: player.pos.r },
        goal: this.goalPublic(player.goal, size),
        spawn: { x: player.spawn.c, y: player.spawn.r },
        wallsLeft: player.wallsLeft,
        camping: player.camping ? { ...player.camping } : null,
        ghost,
        connected,
        isTurn: playing
          && engineState.turnPlayerId === player.id
          && !ghost
          && connected,
      };
    });

    const horizontal = [];
    const vertical = [];
    for (const wall of engineState.walls) {
      if (wall.orientation === 'H') horizontal.push({ x: wall.x, y: wall.y });
      else vertical.push({ x: wall.x, y: wall.y });
    }

    return {
      board: { size },
      players,
      walls: { H: horizontal, V: vertical },
      turnPlayerId: playing ? engineState.turnPlayerId : null,
      remainingSeconds,
      turnNumber: this.game.turnNumber ?? engineState.turnNumber,
      status: engineState.status,
      winnerId: engineState.winnerId ?? null,
      config: { ...engineState.config },
    };
  }

  broadcastGameState() {
    if (!this.game) return;
    const payload = {
      roomCode: this.code,
      gameId: this.game.gameId,
      state: this.getGameState(),
    };
    this.broadcast('server.gameState', payload);
  }

  sendTick() {
    if (this.status !== 'playing' || !this.game || this.game.engine.isFinished()) return;
    const engineState = this.game.engine.state;
    const remainingSeconds = clamp(
      Math.ceil((this.game.turnDeadline - Date.now()) / 1000),
      0,
      TURN_SECONDS,
    );
    this.broadcast('server.tick', {
      roomCode: this.code,
      gameId: this.game.gameId,
      turnPlayerId: engineState.turnPlayerId,
      turnNumber: this.game.turnNumber,
      remainingSeconds,
      timestamp: nowIso(),
    });
  }

  clearTimers() {
    if (!this.game) return;
    if (this.game.tickTimer) clearInterval(this.game.tickTimer);
    if (this.game.turnTimer) clearTimeout(this.game.turnTimer);
    this.game.tickTimer = null;
    this.game.turnTimer = null;
  }

  scheduleTurnTimers() {
    this.clearTimers();
    if (this.status !== 'playing' || !this.game || this.game.engine.isFinished()) return;

    const engine = this.game.engine;
    let playerId = engine.state.turnPlayerId;
    if (!playerId) return;

    let player = this.players.get(playerId);
    if (!player || player.ghost || !player.connected) {
      engine.advanceTurn([]);
      this.game.turnNumber = engine.state.turnNumber;
      if (engine.isFinished()) {
        this.broadcastGameState();
        this.finishGame(this.activeCount() === 0 ? 'no_active' : 'last_active');
        return;
      }
      this.scheduleTurnTimers();
      return;
    }

    playerId = engine.state.turnPlayerId;
    player = this.players.get(playerId);
    if (player) {
      player.invalidCountedThisTurn = false;
      player.lastInvalidTurnNumber = this.game.turnNumber;
    }

    this.game.turnDeadline = Date.now() + TURN_SECONDS * 1000;
    this.game.turnNumber = engine.state.turnNumber;
    const token = { gameId: this.game.gameId, turnNumber: this.game.turnNumber };

    this.game.tickTimer = setInterval(() => {
      try {
        this.sendTick();
      } catch (error) {
        this.manager.logError?.('tick', error);
      }
    }, TICK_INTERVAL_MS);

    this.game.turnTimer = setTimeout(() => {
      try {
        this.handleTurnTimeout(token);
      } catch (error) {
        this.manager.logError?.('turnTimeout', error);
      }
    }, TURN_SECONDS * 1000);
  }

  activeCount() {
    let count = 0;
    for (const player of this.players.values()) {
      if (!player.ghost && player.connected) count += 1;
    }
    return count;
  }

  handleTurnTimeout(token = null) {
    if (this.status !== 'playing' || !this.game) return;
    const game = this.game;
    if (token && (token.gameId !== game.gameId || token.turnNumber !== game.turnNumber)) return;
    if (game.turnDeadline && Date.now() + 100 < game.turnDeadline) return;

    const engine = game.engine;
    if (engine.isFinished()) return;

    const playerId = engine.state.turnPlayerId;
    if (!playerId) {
      this.broadcastGameState();
      this.finishGame(this.activeCount() === 0 ? 'no_active' : 'last_active');
      return;
    }

    const player = this.players.get(playerId);
    if (!player || player.ghost || !player.connected) {
      engine.advanceTurn([]);
      game.turnNumber = engine.state.turnNumber;
      if (engine.isFinished()) {
        this.broadcastGameState();
        this.finishGame(this.activeCount() === 0 ? 'no_active' : 'last_active');
      } else {
        this.scheduleTurnTimers();
        this.broadcastGameState();
      }
      return;
    }

    const result = engine.autoMove(playerId, cryptoRng);
    if (!result.ok) {
      if (result.error === 'NOT_YOUR_TURN' || result.error === 'GAME_FINISHED') {
        if (engine.isFinished()) {
          this.broadcastGameState();
          this.finishGame('goal');
        } else {
          this.scheduleTurnTimers();
          this.broadcastGameState();
        }
        return;
      }
      engine.advanceTurn([]);
    }

    if (player.socket) {
      send(player.socket, 'server.toast', {
        level: 'info',
        code: 'TURN_TIMEOUT',
        message: 'Se agotó el tiempo; se ha realizado un movimiento automático.',
        target: playerId,
      });
    }

    game.turnNumber = engine.state.turnNumber;
    if (engine.isFinished()) {
      this.broadcastGameState();
      this.finishGame('goal');
    } else {
      this.scheduleTurnTimers();
      this.broadcastGameState();
    }
  }

  processExpiredTurn() {
    if (this.status !== 'playing' || !this.game) return;
    if (this.game.turnDeadline && Date.now() >= this.game.turnDeadline) {
      this.handleTurnTimeout({ gameId: this.game.gameId, turnNumber: this.game.turnNumber });
    }
  }

  finishGame(reason) {
    if (!this.game || this.status !== 'playing') return;
    this.clearTimers();
    const winnerId = this.game.engine.getWinner();
    this.game.winnerId = winnerId;
    this.game.turnDeadline = 0;
    this.game.turnNumber = this.game.engine.state.turnNumber;
    this.status = 'finished';
    this.touch();

    const winner = winnerId ? this.players.get(winnerId) : null;
    const payload = {
      roomCode: this.code,
      gameId: this.game.gameId,
      winnerId,
      winnerName: winner ? winner.name : null,
      reason,
      state: this.getGameState(),
    };
    this.broadcast('server.gameOver', payload);
  }

  assertPlaying(playerId) {
    if (this.status === 'lobby' || (!this.game && this.status !== 'finished')) {
      throw new ProtocolError('WRONG_STATE');
    }
    if (this.status === 'finished' || this.game.engine.isFinished()) {
      throw new ProtocolError('GAME_ALREADY_FINISHED');
    }
    const player = this.players.get(playerId);
    if (!player) throw new ProtocolError('NOT_IN_ROOM');
    return player;
  }

  sendActionRejected(player, code, requestId, options = {}) {
    const payload = {
      code,
      message: options.message || this.actionMessage(code),
      playerId: player.id,
      turnNumber: options.turnNumber ?? this.game?.engine.state.turnNumber ?? 0,
      warning: Boolean(options.warning),
      invalidTurnCount: options.invalidTurnCount ?? player.invalidTurnCount,
      ghosted: Boolean(options.ghosted),
    };
    send(player.socket, 'server.actionRejected', payload, requestId);
  }

  actionMessage(code) {
    const messages = {
      NOT_YOUR_TURN: 'No es tu turno.',
      PLAYER_GHOST: 'Estás desconectado de la partida.',
      INVALID_MOVE: 'El movimiento no es válido.',
      CAMPING_MUST_MOVE: 'Debes moverte fuera de la meta ocupada.',
      INVALID_WALL: 'La pared no es válida.',
      INVALID_ORIENTATION: 'La orientación debe ser H o V.',
      INVALID_COORDINATES: 'Las coordenadas no son válidas.',
      WALL_OUT_OF_BOUNDS: 'La pared está fuera del tablero.',
      WALL_OVERLAP: 'Ya hay una pared en esa posición.',
      NO_WALLS_LEFT: 'No te quedan paredes.',
      PATH_BLOCKED: 'La pared dejaría a un jugador sin camino a su meta.',
    };
    return messages[code] || 'Acción rechazada.';
  }

  sendGhostRejection(player, requestId) {
    this.sendActionRejected(player, 'PLAYER_GHOST', requestId, {
      warning: false,
      invalidTurnCount: player.invalidTurnCount,
      ghosted: true,
    });
  }

  rejectAction(player, code, requestId) {
    if (this.closed) return;
    const turnNumber = this.game?.engine.state.turnNumber ?? 0;
    let incremented = false;

    if (!player.invalidCountedThisTurn || player.lastInvalidTurnNumber !== turnNumber) {
      player.invalidCountedThisTurn = true;
      player.lastInvalidTurnNumber = turnNumber;
      player.invalidTurnCount += 1;
      incremented = true;
    }

    const willGhost = player.invalidTurnCount >= 2;
    this.sendActionRejected(player, code, requestId, {
      warning: incremented && !willGhost,
      turnNumber,
      invalidTurnCount: player.invalidTurnCount,
      ghosted: willGhost,
    });

    if (willGhost) {
      this.broadcast('server.toast', {
        level: 'warning',
        code: 'PLAYER_AFK',
        message: `${player.name} ha sido marcado como ausente.`,
        target: player.id,
      });
      this.convertToGhost(player.id, { reason: 'afk', closeSocket: true });
      return;
    }

    if (incremented) {
      send(player.socket, 'server.toast', {
        level: 'warning',
        code: 'AFK_WARNING',
        message: 'Acción inválida. Si vuelves a fallar en otro turno serás marcado como ausente.',
        target: player.id,
      });
    }
  }

  handleMove(playerId, to, requestId) {
    this.assertPlaying(playerId);
    this.processExpiredTurn();
    if (this.status !== 'playing' || this.game.engine.isFinished()) {
      throw new ProtocolError('GAME_ALREADY_FINISHED');
    }

    const player = this.players.get(playerId);
    if (!player) throw new ProtocolError('NOT_IN_ROOM');
    if (player.ghost) {
      this.sendGhostRejection(player, requestId);
      return;
    }
    if (this.game.engine.state.turnPlayerId !== playerId) {
      this.rejectAction(player, 'NOT_YOUR_TURN', requestId);
      return;
    }
    if (!isPlainObject(to) || !Number.isInteger(to.x) || !Number.isInteger(to.y)) {
      this.rejectAction(player, 'INVALID_MOVE', requestId);
      return;
    }

    const pos = this.game.engine.getPlayer(playerId).pos;
    if (to.x === pos.c && to.y === pos.r) {
      this.rejectAction(player, 'CAMPING_MUST_MOVE', requestId);
      return;
    }

    const result = this.game.engine.move(playerId, { r: to.y, c: to.x });
    if (!result.ok) {
      const code = mapEngineError(result.error);
      this.rejectAction(player, code, requestId);
      return;
    }
    this.applySuccessfulAction();
  }

  handlePlaceWall(playerId, orientation, x, y, requestId) {
    this.assertPlaying(playerId);
    this.processExpiredTurn();
    if (this.status !== 'playing' || this.game.engine.isFinished()) {
      throw new ProtocolError('GAME_ALREADY_FINISHED');
    }

    const player = this.players.get(playerId);
    if (!player) throw new ProtocolError('NOT_IN_ROOM');
    if (player.ghost) {
      this.sendGhostRejection(player, requestId);
      return;
    }
    if (this.game.engine.state.turnPlayerId !== playerId) {
      this.rejectAction(player, 'NOT_YOUR_TURN', requestId);
      return;
    }
    if (orientation !== 'H' && orientation !== 'V') {
      this.rejectAction(player, 'INVALID_ORIENTATION', requestId);
      return;
    }
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      this.rejectAction(player, 'INVALID_COORDINATES', requestId);
      return;
    }

    const result = this.game.engine.placeWall(playerId, orientation, x, y);
    if (!result.ok) {
      const code = mapEngineError(result.error);
      this.rejectAction(player, code, requestId);
      return;
    }
    this.applySuccessfulAction();
  }

  applySuccessfulAction() {
    if (!this.game) return;
    this.touch();
    const engine = this.game.engine;
    this.game.turnNumber = engine.state.turnNumber;
    if (engine.isFinished()) {
      this.broadcastGameState();
      this.finishGame('goal');
      return;
    }
    this.scheduleTurnTimers();
    this.broadcastGameState();
  }

  convertToGhost(playerId, options = {}) {
    const player = this.players.get(playerId);
    if (!player) return false;
    const reason = options.reason || 'socket';
    const alreadyGhost = player.ghost;

    const socket = player.socket;
    player.ghost = true;
    player.connected = false;
    player.invalidTurnCount = 0;
    player.invalidCountedThisTurn = false;
    player.lastInvalidTurnNumber = 0;

    if (this.game) {
      const engine = this.game.engine;
      const previousTurnPlayerId = engine.state.turnPlayerId;
      const previousTurnNumber = engine.state.turnNumber;
      try {
        engine.setGhost(playerId, true);
      } catch (error) {
        this.manager.logError?.('setGhost', error);
      }
      this.game.turnNumber = engine.state.turnNumber;

      if (!alreadyGhost) {
        this.broadcast('server.playerDisconnected', {
          playerId,
          name: player.name,
          reason,
          ghost: true,
          timestamp: nowIso(),
        });
      }

      if (engine.isFinished()) {
        this.broadcastGameState();
        if (this.status === 'playing') {
          this.finishGame(this.activeCount() === 0 ? 'no_active' : 'last_active');
        }
      } else {
        const turnChanged = engine.state.turnPlayerId !== previousTurnPlayerId
          || engine.state.turnNumber !== previousTurnNumber;
        if (turnChanged) this.scheduleTurnTimers();
        this.broadcastGameState();
      }
    }

    if (options.closeSocket && socket) {
      try {
        socket.close(4003, 'Jugador marcado como ausente');
      } catch {
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }
    }
    return true;
  }

  handleSocketDisconnect(playerId, reason = 'socket') {
    const player = this.players.get(playerId);
    if (!player) return;
    player.socket = null;
    player.connected = false;

    if (this.status === 'lobby') {
      const wasHost = player.id === this.hostPlayerId;
      const result = this.removePlayer(playerId, wasHost ? 'disconnected' : 'disconnected');
      if (!result.roomDeleted && !this.closed) this.broadcastRoomUpdate();
      return;
    }

    const session = this.manager.sessions.get(playerId);
    if (session) session.connected = false;

    if (!player.ghost) {
      this.convertToGhost(playerId, { reason });
    }
  }

  leaveRoom(playerId, options = {}) {
    if (this.status === 'playing') throw new ProtocolError('GAME_STARTED');
    const player = this.players.get(playerId);
    if (!player) throw new ProtocolError('NOT_IN_ROOM');

    send(player.socket, 'server.leftRoom', {
      roomCode: this.code,
      playerId,
      reason: options.reason || 'leave',
    }, options.requestId);

    this.removePlayer(playerId, options.reason || 'leave');
    if (!this.closed) this.broadcastRoomUpdate();
  }

  leaveGame(playerId, options = {}) {
    this.assertPlaying(playerId);
    const player = this.players.get(playerId);
    if (!player) throw new ProtocolError('NOT_IN_ROOM');
    if (player.ghost) throw new ProtocolError('PLAYER_GHOST');
    this.convertToGhost(playerId, { reason: options.reason || 'leave', closeSocket: false });
  }

  reconnectPlayer(playerId, socket) {
    const player = this.players.get(playerId);
    if (!player) return null;

    player.socket = socket;
    player.connected = true;
    player.ghost = false;
    player.invalidTurnCount = 0;
    player.invalidCountedThisTurn = false;
    player.lastInvalidTurnNumber = 0;

    if (this.game) {
      try {
        this.game.engine.setGhost(playerId, false);
      } catch (error) {
        this.manager.logError?.('reconnectSetGhost', error);
      }
      this.game.turnNumber = this.game.engine.state.turnNumber;
    }

    const session = this.manager.sessions.get(playerId);
    if (session) {
      session.socket = socket;
      session.connected = true;
      session.roomCode = this.code;
      session.alias = player.name;
    }
    this.touch();
    return player;
  }

  notifyReconnected(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;

    if (this.status === 'lobby') {
      this.broadcastRoomUpdate();
      return;
    }

    const payload = {
      roomCode: this.code,
      gameId: this.game.gameId,
      state: this.getGameState(),
    };
    send(player.socket, 'server.gameState', payload);
    this.broadcastExcept(playerId, 'server.playerReconnected', {
      playerId,
      name: player.name,
      hostPlayerId: this.hostPlayerId,
      timestamp: nowIso(),
    });
    this.broadcastExcept(playerId, 'server.gameState', payload);
  }

  rematch(playerId, options = {}) {
    const player = this.players.get(playerId);
    if (!player) throw new ProtocolError('NOT_IN_ROOM');
    if (player.ghost || !player.connected) throw new ProtocolError('REMATCH_NOT_AVAILABLE');

    if (this.status === 'lobby') {
      send(player.socket, 'server.rematchLobby', this.getLobbySnapshot(), options.requestId);
      return;
    }
    if (this.status === 'playing') throw new ProtocolError('REMATCH_NOT_AVAILABLE');

    this.clearTimers();
    const removed = [];
    for (const entry of [...this.players.values()]) {
      if (entry.ghost || !entry.connected || !entry.socket) {
        this.players.delete(entry.id);
        removed.push(entry.id);
        const session = this.manager.sessions.get(entry.id);
        if (session && session.roomCode === this.code) {
          session.roomCode = null;
          if (!session.connected) this.manager.scheduleSessionExpiry(session);
        }
      }
    }

    this.game = null;
    this.status = 'lobby';
    for (const entry of this.players.values()) {
      entry.invalidTurnCount = 0;
      entry.invalidCountedThisTurn = false;
      entry.lastInvalidTurnNumber = 0;
    }

    if (this.players.size === 0) {
      this.manager.deleteRoom(this.code);
      return;
    }

    const host = this.players.get(this.hostPlayerId);
    if (!host || !host.connected) {
      this.hostPlayerId = null;
      this.transferHost('rematch');
    } else {
      this.refreshHostFlags();
    }

    this.touch();
    this.broadcast('server.rematchLobby', this.getLobbySnapshot(), options.requestId);
    return removed;
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    for (const player of this.players.values()) {
      const session = this.manager.sessions.get(player.id);
      if (session && session.roomCode === this.code) session.roomCode = null;
    }
    this.players.clear();
  }
}
