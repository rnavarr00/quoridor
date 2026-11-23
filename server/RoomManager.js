import crypto from 'node:crypto';
import { DEFAULT_CONFIG } from '../src/core/constants.js';
import { Room } from './Room.js';
import {
  EXPIRED_ROOM_TTL_MS,
  MAX_ROOMS,
  ProtocolError,
  SESSION_IDLE_MS,
  generateRoomCode,
  normalizeRoomCode,
  nowIso,
  randomToken,
  secureCompare,
  send,
  validateAlias,
  validateConfig,
  validateHelloPayload,
} from './protocol.js';

export class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.expiredRooms = new Map();
    this.sessions = new Map();
    this.matchmaking = null;
    this.maintenanceTimer = null;
  }

  logError(scope, error) {
    if (process.env.NODE_ENV === 'test') return;
    console.error(`[server:${scope}]`, error && error.message ? error.message : error);
  }

  setMatchmaking(matchmaking) {
    this.matchmaking = matchmaking;
  }

  generateUniqueCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = generateRoomCode();
      if (!this.rooms.has(code)) return code;
    }
    throw new ProtocolError('ROOM_CODE_EXHAUSTED');
  }

  getRoom(code) {
    return this.rooms.get(code) || null;
  }

  markRoomExpired(code) {
    this.expiredRooms.set(code, Date.now());
  }

  rejectExpiredRoom(session, code, requestId = undefined) {
    send(session.socket, 'server.toast', {
      level: 'warning',
      code: 'ROOM_EXPIRED',
      message: 'La sala ha caducado.',
    }, requestId);
    throw new ProtocolError('ROOM_EXPIRED');
  }

  getRoomForSession(session) {
    if (!session || !session.roomCode) return null;
    const room = this.rooms.get(session.roomCode);
    if (!room || !room.players.has(session.playerId)) {
      session.roomCode = null;
      return null;
    }
    return room;
  }

  assertSessionFree(session) {
    if (session.roomCode) {
      const room = this.rooms.get(session.roomCode);
      if (room && room.players.has(session.playerId)) throw new ProtocolError('ALREADY_IN_ROOM');
      session.roomCode = null;
    }
    if (this.matchmaking && this.matchmaking.isQueued(session.playerId)) {
      throw new ProtocolError('ALREADY_IN_ROOM');
    }
  }

  handleHello(socket, payload) {
    const parsed = validateHelloPayload(payload);
    let { playerId, sessionToken, alias } = parsed;

    if (playerId) {
      const existing = this.sessions.get(playerId);
      if (existing) {
        if (!sessionToken || !secureCompare(sessionToken, existing.sessionToken)) {
          throw new ProtocolError('SESSION_INVALID', null, null, 4001);
        }
        const oldSocket = existing.socket;
        if (oldSocket && oldSocket !== socket) {
          try {
            oldSocket.close(1000, 'Sesión reemplazada por una conexión nueva');
          } catch {
            try {
              oldSocket.terminate();
            } catch {
              // ignore
            }
          }
        }
        this.clearSessionExpiry(existing);
        existing.socket = socket;
        existing.connected = true;
        existing.lastSeen = Date.now();
        if (alias) existing.alias = alias;

        let room = this.getRoomForSession(existing);
        let resumed = false;
        let status = null;
        if (room) {
          room.reconnectPlayer(existing.playerId, socket);
          resumed = true;
          status = room.status;
        }
        return { session: existing, resumed, room, status };
      }
    }

    const newId = playerId || crypto.randomUUID();
    const token = sessionToken || randomToken();
    const session = {
      playerId: newId,
      sessionToken: token,
      socket,
      roomCode: null,
      alias: alias || null,
      connected: true,
      lastSeen: Date.now(),
      createdAt: nowIso(),
      cleanupTimer: null,
    };
    this.sessions.set(newId, session);
    return { session, resumed: false, room: null, status: null };
  }

  createRoom(session, configInput, aliasInput) {
    this.assertSessionFree(session);
    if (this.rooms.size >= MAX_ROOMS) {
      throw new ProtocolError('ROOM_CODE_EXHAUSTED', 'Se alcanzó el límite de salas activas.');
    }

    const checked = validateConfig(configInput ?? {}, {
      currentPlayers: 0,
      base: DEFAULT_CONFIG,
    });
    if (!checked.ok) throw new ProtocolError('INVALID_CONFIG', checked.message);

    const alias = validateAlias(aliasInput ?? session.alias);
    if (!alias) throw new ProtocolError('INVALID_ALIAS');

    const code = this.generateUniqueCode();
    const room = new Room(code, checked.config, this);
    this.rooms.set(code, room);
    this.expiredRooms.delete(code);
    room.addPlayer(session, alias);
    return room;
  }

  joinRoom(session, codeInput, aliasInput) {
    this.assertSessionFree(session);

    const code = normalizeRoomCode(codeInput);
    if (!code) throw new ProtocolError('INVALID_CODE');

    const room = this.rooms.get(code);
    if (room?.expired) this.rejectExpiredRoom(session, code);
    if (!room) {
      if (this.expiredRooms.has(code)) this.rejectExpiredRoom(session, code);
      throw new ProtocolError('ROOM_NOT_FOUND');
    }
    if (room.status !== 'lobby') throw new ProtocolError('GAME_STARTED');

    const alias = validateAlias(aliasInput ?? session.alias);
    if (!alias) throw new ProtocolError('INVALID_ALIAS');
    if (room.players.size >= room.config.maxPlayers) throw new ProtocolError('ROOM_FULL');

    room.addPlayer(session, alias);
    this.clearSessionExpiry(session);
    return room;
  }

  createRoomForMatch(entries, config) {
    const checked = validateConfig(config, { currentPlayers: 0, base: config });
    if (!checked.ok) throw new ProtocolError('INVALID_CONFIG', checked.message);

    const code = this.generateUniqueCode();
    const room = new Room(code, checked.config, this);
    this.rooms.set(code, room);
    this.expiredRooms.delete(code);

    for (const entry of entries) {
      const session = this.sessions.get(entry.playerId);
      if (!session || session.roomCode) continue;
      const alias = validateAlias(session.alias || 'Jugador') || 'Jugador';
      room.addPlayer(session, alias);
    }
    return room;
  }

  deleteRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    const playerIds = new Set(room.players.keys());
    room.destroy();
    this.rooms.delete(code);
    for (const session of this.sessions.values()) {
      if (session.roomCode === code || playerIds.has(session.playerId)) {
        session.roomCode = null;
        if (!session.connected) this.scheduleSessionExpiry(session);
      }
    }
  }

  handleSocketClose(socket) {
    const playerId = socket.context?.playerId;
    if (!playerId) return;
    const session = this.sessions.get(playerId);
    if (!session || session.socket !== socket) return;

    session.socket = null;
    session.connected = false;
    session.lastSeen = Date.now();

    if (this.matchmaking) this.matchmaking.handleDisconnect(playerId);

    const room = this.getRoomForSession(session);
    if (room) {
      room.handleSocketDisconnect(playerId, 'socket');
    }

    if (!session.roomCode) this.scheduleSessionExpiry(session);
  }

  getSession(playerId) {
    return this.sessions.get(playerId) || null;
  }

  clearSessionExpiry(session) {
    if (session?.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
  }

  scheduleSessionExpiry(session) {
    if (!session) return;
    this.clearSessionExpiry(session);
    session.cleanupTimer = setTimeout(() => {
      const current = this.sessions.get(session.playerId);
      if (!current) return;
      if (!current.roomCode && !current.connected) {
        this.sessions.delete(current.playerId);
      }
    }, SESSION_IDLE_MS);
    session.cleanupTimer.unref?.();
  }

  startMaintenance() {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      try {
        this.expireRooms();
      } catch (error) {
        this.logError('maintenance', error);
      }
    }, 60000);
    this.maintenanceTimer.unref?.();
  }

  expireRooms() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      const connected = room.players.size > 0
        && [...room.players.values()].some((player) => player.connected && player.socket);

      if (room.status === 'lobby' && now - room.lastActivityAt > 1800000) {
        room.expired = true;
        room.broadcast('server.toast', {
          level: 'warning',
          code: 'ROOM_EXPIRED',
          message: 'La sala ha expirado por inactividad.',
        });
        this.markRoomExpired(room.code);
        for (const socket of room.getSockets()) {
          try {
            socket.close(1001, 'Sala expirada');
          } catch {
            // ignore
          }
        }
        this.deleteRoom(room.code);
        continue;
      }

      if (room.status === 'playing' && !connected && now - room.lastActivityAt > 1800000) {
        this.deleteRoom(room.code);
        continue;
      }

      if (room.status === 'finished') {
        const idle = now - room.lastActivityAt;
        if ((!connected && idle > 300000) || idle > 600000) {
          this.deleteRoom(room.code);
        }
      }
    }

    for (const [code, at] of this.expiredRooms) {
      if (now - at > EXPIRED_ROOM_TTL_MS) this.expiredRooms.delete(code);
    }

    for (const session of [...this.sessions.values()]) {
      if (!session.roomCode && !session.connected && now - session.lastSeen > SESSION_IDLE_MS) {
        this.clearSessionExpiry(session);
        this.sessions.delete(session.playerId);
      }
    }
  }

  closeAll() {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    for (const session of this.sessions.values()) this.clearSessionExpiry(session);
    for (const code of [...this.rooms.keys()]) this.deleteRoom(code);
    this.expiredRooms.clear();
    this.sessions.clear();
  }
}
