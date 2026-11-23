import crypto from 'node:crypto';
import { CASUAL_CONFIG } from '../src/core/constants.js';
import {
  MAX_QUEUE,
  ProtocolError,
  send,
} from './protocol.js';

export class Matchmaking {
  constructor(manager) {
    this.manager = manager;
    this.queue = [];
  }

  isQueued(playerId) {
    return this.queue.some((entry) => entry.playerId === playerId);
  }

  queueIndex(playerId) {
    return this.queue.findIndex((entry) => entry.playerId === playerId);
  }

  searchingPayload(entry) {
    return {
      position: this.queueIndex(entry.playerId) + 1,
      queueSize: this.queue.length,
      config: { ...CASUAL_CONFIG },
    };
  }

  quickPlay(session, requestId = undefined) {
    if (session.roomCode) {
      const room = this.manager.rooms.get(session.roomCode);
      if (room && room.players.has(session.playerId)) throw new ProtocolError('ALREADY_IN_ROOM');
      session.roomCode = null;
    }

    const existing = this.queue.find((entry) => entry.playerId === session.playerId);
    if (existing) {
      send(session.socket, 'server.matchSearching', this.searchingPayload(existing), requestId);
      return;
    }

    if (this.queue.length >= MAX_QUEUE) throw new ProtocolError('QUEUE_FULL');

    const entry = { playerId: session.playerId, joinedAt: Date.now() };
    this.queue.push(entry);
    send(session.socket, 'server.matchSearching', this.searchingPayload(entry), requestId);
    this.tryMatch();
  }

  cancelQuickPlay(session, requestId = undefined) {
    const index = this.queueIndex(session.playerId);
    if (index < 0) throw new ProtocolError('NOT_IN_QUEUE');
    this.queue.splice(index, 1);
    send(session.socket, 'server.matchCancelled', { queueSize: this.queue.length }, requestId);
  }

  handleDisconnect(playerId) {
    const index = this.queueIndex(playerId);
    if (index >= 0) this.queue.splice(index, 1);
  }

  validEntries(entries) {
    const valid = [];
    for (const entry of entries) {
      const session = this.manager.sessions.get(entry.playerId);
      if (!session) continue;
      if (session.roomCode) {
        const room = this.manager.rooms.get(session.roomCode);
        if (room && room.players.has(session.playerId)) continue;
        session.roomCode = null;
      }
      valid.push(entry);
    }
    return valid;
  }

  tryMatch() {
    while (this.queue.length >= 2) {
      const group = this.queue.splice(0, Math.min(8, this.queue.length));
      const valid = this.validEntries(group);

      if (valid.length < 2) {
        if (valid.length === 1) this.queue.unshift(valid[0]);
        break;
      }

      let room = null;
      try {
        room = this.manager.createRoomForMatch(valid, CASUAL_CONFIG);
      } catch (error) {
        this.queue.unshift(...valid);
        this.manager.logError('matchmaking:create', error);
        break;
      }

      if (room.players.size < 2) {
        this.manager.deleteRoom(room.code);
        this.queue.unshift(...valid);
        break;
      }

      const gameId = crypto.randomUUID();
      try {
        room.startGame(null, { gameId, broadcast: false });
      } catch (error) {
        this.manager.deleteRoom(room.code);
        this.queue.unshift(...valid);
        this.manager.logError('matchmaking:start', error);
        break;
      }

      const playerIds = [...room.players.keys()];
      const payload = {
        roomCode: room.code,
        gameId,
        playerIds,
        config: { ...room.config },
      };
      for (const player of room.players.values()) {
        send(player.socket, 'server.matchFound', payload);
      }
      room.emitGameStarted();
    }
  }
}
