import { DIRECTIONS, SPAWN_MODES } from './constants.js';
import {
  activePlayerAt,
  allActivePlayersHavePath,
  cellKey,
  goalOwner,
  hasPath,
  inBounds,
  isCell,
  isWallInBounds,
  manhattan,
  nearestFreeCell,
  sameCell,
  shortestPathDistance,
  wallEdgeKeys,
  hasWallConflict,
} from './board.js';
import { computeLegalMoves, pickRandom } from './movement.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(error) {
  return { ok: false, error };
}

function normalizeCell(value) {
  if (isCell(value)) return { r: value.r, c: value.c };
  if (value && Number.isInteger(value.x) && Number.isInteger(value.y)) {
    return { r: value.y, c: value.x };
  }
  return null;
}

function nonGhostActive(players) {
  return players.filter((player) => !player.ghost && player.connected !== false);
}

export class GameEngine {
  constructor(state) {
    this.state = state;
  }

  static create(config, playersInput, spawnResult, seed = 0) {
    if (!config || !Number.isInteger(config.size)) throw new Error('INVALID_CONFIG');
    const size = config.size;
    if (!Number.isInteger(size) || size < 8 || size > 20) throw new Error('INVALID_SIZE');
    if (!Array.isArray(playersInput) || playersInput.length < 2 || playersInput.length > 8) {
      throw new Error('INVALID_PLAYER_COUNT');
    }
    const spawns = spawnResult?.spawns || playersInput.map((player) => player.spawn);
    const goals = spawnResult?.goals || playersInput.map((player) => player.goal);
    if (!Array.isArray(spawns) || !Array.isArray(goals) || spawns.length !== playersInput.length || goals.length !== playersInput.length) {
      throw new Error('INVALID_SPAWNS');
    }

    const seenSpawns = new Set();
    const seenGoals = new Set();
    for (let i = 0; i < playersInput.length; i += 1) {
      const spawn = normalizeCell(spawns[i]);
      const goal = normalizeCell(goals[i]);
      if (!inBounds(spawn, size) || !inBounds(goal, size)) throw new Error('INVALID_SPAWNS');
      if (seenSpawns.has(cellKey(spawn)) || seenGoals.has(cellKey(goal))) throw new Error('DUPLICATE_SPAWN_OR_GOAL');
      if (seenSpawns.has(cellKey(goal))) throw new Error('GOAL_ON_SPAWN');
      seenSpawns.add(cellKey(spawn));
      seenGoals.add(cellKey(goal));
    }
    for (const goal of goals) {
      if (seenSpawns.has(cellKey(normalizeCell(goal)))) throw new Error('GOAL_ON_SPAWN');
    }

    const players = playersInput
      .map((player, index) => ({
        id: String(player.id),
        name: String(player.name || `Jugador ${index + 1}`),
        colorIndex: Number.isInteger(player.colorIndex) ? player.colorIndex : index,
        spawn: normalizeCell(spawns[index]),
        goal: normalizeCell(goals[index]),
        pos: normalizeCell(spawns[index]),
        wallsLeft: Number.isInteger(player.wallsLeft) ? player.wallsLeft : (config.wallsPerPlayer ?? 10),
        ghost: false,
        connected: true,
        camping: null,
      }))
      .sort((a, b) => a.colorIndex - b.colorIndex);

    const state = {
      config: {
        size,
        maxPlayers: Number.isInteger(config.maxPlayers) ? config.maxPlayers : players.length,
        wallsPerPlayer: Number.isInteger(config.wallsPerPlayer) ? config.wallsPerPlayer : 10,
        spawnMode: SPAWN_MODES.includes(config.spawnMode) ? config.spawnMode : 'random',
        turnSeconds: 30,
      },
      players,
      walls: [],
      turnPlayerId: players[0]?.id || null,
      turnNumber: 1,
      status: 'playing',
      winnerId: null,
      seed: Number.isInteger(seed) ? seed : 0,
    };
    return new GameEngine(state);
  }

  getState() {
    return clone(this.state);
  }

  confirmed(mutator) {
    const snapshot = clone(this.state);
    const result = mutator();
    if (!allActivePlayersHavePath(this.state.players, this.state.walls, this.state.config.size)) {
      this.state = snapshot;
      return fail('INVALID_ACTION');
    }
    return result;
  }

  getPublicState(viewerId = null) {
    const state = clone(this.state);
    delete state.seed;
    return { ...state, viewerId };
  }

  getPlayer(playerId) {
    return this.state.players.find((player) => player.id === playerId) || null;
  }

  isFinished() {
    return this.state.status === 'finished';
  }

  getWinner() {
    return this.state.winnerId;
  }

  getLegalMoves(playerId, options = {}) {
    return computeLegalMoves(this.state, playerId, options);
  }

  getLegalWallPlacements(playerId) {
    const player = this.getPlayer(playerId);
    if (!player || player.ghost || player.wallsLeft <= 0) return [];
    if (this.state.status !== 'playing' || this.state.turnPlayerId !== playerId) return [];
    if (player.camping) return [];
    const placements = [];
    const { size } = this.state.config;
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        for (const orientation of ['H', 'V']) {
          const wall = { orientation, x, y };
          if (!this.wallError(wall)) placements.push(wall);
        }
      }
    }
    return placements;
  }

  wallError(wall) {
    if (!wall || (wall.orientation !== 'H' && wall.orientation !== 'V')) return 'INVALID_ORIENTATION';
    if (!Number.isInteger(wall.x) || !Number.isInteger(wall.y)) return 'INVALID_ACTION';
    if (!isWallInBounds(wall, this.state.config.size)) return 'WALL_OUT_OF_BOUNDS';
    const conflict = hasWallConflict(this.state.walls, wall);
    if (conflict) return conflict;
    const tentative = [...this.state.walls, wall];
    for (const player of this.state.players) {
      if (player.ghost || player.connected === false) continue;
      if (!hasPath(player.pos, player.goal, tentative, this.state.config.size)) return 'NO_PATH';
    }
    return null;
  }

  move(playerId, destination) {
    const to = normalizeCell(destination);
    if (!to) return fail('INVALID_ACTION');
    if (this.state.status === 'finished') return fail('GAME_FINISHED');
    if (this.state.turnPlayerId !== playerId) return fail('NOT_YOUR_TURN');
    const player = this.getPlayer(playerId);
    if (!player) return fail('INVALID_ACTION');
    if (player.ghost) return fail('PLAYER_GHOST');
    if (!inBounds(to, this.state.config.size)) return fail('OUT_OF_BOARD');

    if (sameCell(to, player.pos)) {
      if (player.camping) {
        const moves = computeLegalMoves(this.state, playerId);
        if (moves.length === 0) {
          return this.confirmed(() => this.stayInCamping(this.getPlayer(playerId)));
        }
        return fail('CAMPING_FORCED_MOVE');
      }
      return fail('NOT_ADJACENT');
    }

    if (activePlayerAt(this.state.players, to, playerId)) return fail('CELL_OCCUPIED');

    const move = computeLegalMoves(this.state, playerId).find((entry) => sameCell(entry.to, to));
    if (!move) return fail('NOT_ADJACENT');

    return this.confirmed(() => ({ ok: true, events: this.applyMove(this.getPlayer(playerId), move) }));
  }

  stayInCamping(player) {
    const events = [];
    if (!player.camping) return fail('CAMPING_FORCED_MOVE');
    player.camping.turnsOnGoal += 1;
    events.push({
      type: 'CAMPING_FORCED',
      playerId: player.id,
      pos: { ...player.pos },
      hadLegalExit: false,
    });
    this.advanceTurn(events);
    return { ok: true, events };
  }

  applyMove(player, move) {
    const events = [];
    const from = { ...player.pos };
    const previousCamping = player.camping;
    player.pos = { ...move.to };

    if (move.kind === 'step') {
      events.push({ type: 'MOVE', playerId: player.id, from, to: { ...player.pos }, path: [from, { ...player.pos }] });
    } else {
      events.push({
        type: 'JUMP',
        playerId: player.id,
        from,
        to: { ...player.pos },
        over: move.over.map((entry) => ({ ...entry })),
        kind: move.kind,
      });
    }

    if (sameCell(player.pos, player.goal)) {
      player.camping = null;
      this.finish(player.id, events);
      return events;
    }

    if (previousCamping) {
      player.camping = null;
      events.push({
        type: 'CAMPING_FORCED',
        playerId: player.id,
        pos: { ...player.pos },
        hadLegalExit: true,
      });
    }

    const owner = goalOwner(this.state.players, player.pos);
    if (owner && owner.id !== player.id) {
      player.camping = { goalOwnerId: owner.id, turnsOnGoal: 1 };
      events.push({
        type: 'CAMPING_ENTERED',
        playerId: player.id,
        goalOwnerId: owner.id,
        pos: { ...player.pos },
      });
    }

    this.advanceTurn(events);
    return events;
  }

  placeWall(playerId, orientation, x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || typeof orientation === 'string' === false) {
      return fail('INVALID_ACTION');
    }
    if (this.state.status === 'finished') return fail('GAME_FINISHED');
    if (this.state.turnPlayerId !== playerId) return fail('NOT_YOUR_TURN');
    const player = this.getPlayer(playerId);
    if (!player) return fail('INVALID_ACTION');
    if (player.ghost) return fail('PLAYER_GHOST');
    if (player.camping) return fail('CAMPING_NO_WALL');
    if (orientation !== 'H' && orientation !== 'V') return fail('INVALID_ORIENTATION');
    if (player.wallsLeft <= 0) return fail('NO_WALLS_LEFT');

    const wall = { orientation, x, y };
    const error = this.wallError(wall);
    if (error) return fail(error);

    return this.confirmed(() => {
      const active = this.getPlayer(playerId);
      active.wallsLeft -= 1;
      this.state.walls.push(wall);
      const events = [{
        type: 'WALL_PLACED',
        playerId,
        wall: { ...wall },
        wallsLeft: active.wallsLeft,
      }];
      this.advanceTurn(events);
      return { ok: true, events };
    });
  }

  autoMove(playerId, rng = Math.random) {
    if (this.state.status === 'finished') return fail('GAME_FINISHED');
    if (this.state.turnPlayerId !== playerId) return fail('NOT_YOUR_TURN');
    const player = this.getPlayer(playerId);
    if (!player) return fail('INVALID_ACTION');
    if (player.ghost) return fail('PLAYER_GHOST');

    if (player.camping) {
      const allMoves = computeLegalMoves(this.state, playerId);
      if (!allMoves.length) {
        return this.confirmed(() => this.stayInCamping(this.getPlayer(playerId)));
      }
      const simple = computeLegalMoves(this.state, playerId, { simple: true });
      const chosen = pickRandom(simple.length ? simple : allMoves, rng);
      return this.confirmed(() => ({ ok: true, events: this.applyMove(this.getPlayer(playerId), chosen) }));
    }

    const simple = computeLegalMoves(this.state, playerId, { simple: true });
    if (simple.length) {
      const chosen = pickRandom(simple, rng);
      return this.confirmed(() => ({ ok: true, events: this.applyMove(this.getPlayer(playerId), chosen) }));
    }
    const allMoves = computeLegalMoves(this.state, playerId);
    if (allMoves.length) {
      const chosen = pickRandom(allMoves, rng);
      return this.confirmed(() => ({ ok: true, events: this.applyMove(this.getPlayer(playerId), chosen) }));
    }
    return this.confirmed(() => {
      const events = [];
      this.advanceTurn(events);
      return { ok: true, events };
    });
  }

  setGhost(playerId, ghost) {
    if (this.state.status === 'finished') return fail('GAME_FINISHED');
    const player = this.getPlayer(playerId);
    if (!player) return fail('INVALID_ACTION');
    const events = [];
    if (ghost) {
      if (player.ghost) return { ok: true, events };
      player.ghost = true;
      player.connected = false;
      player.camping = null;
      events.push({ type: 'GHOST_SET', playerId, ghost: true });
      if (this.state.status === 'playing') {
        const active = nonGhostActive(this.state.players);
        if (active.length === 0) {
          this.state.turnPlayerId = null;
          return { ok: true, events };
        }
        if (active.length === 1) {
          this.finish(active[0].id, events);
          return { ok: true, events };
        }
        if (this.state.turnPlayerId === playerId) this.advanceTurn(events);
      }
      return { ok: true, events };
    }

    if (!player.ghost && player.connected) return { ok: true, events };
    return this.confirmed(() => {
      const target = this.getPlayer(playerId);
      const occupied = this.state.players
        .filter((other) => other.id !== playerId && !other.ghost && other.connected !== false)
        .map((other) => other.pos);
      let position = { ...target.pos };
      if (occupied.some((entry) => sameCell(entry, position))) {
        position = nearestFreeCell(target.pos, this.state.walls, this.state.config.size, occupied, target.goal)
          || nearestFreeCell(target.spawn, this.state.walls, this.state.config.size, occupied, target.goal);
      }
      if (position) target.pos = position;
      if (!hasPath(target.pos, target.goal, this.state.walls, this.state.config.size)) {
        const free = this.findReachableFreeCell(target.goal, occupied);
        if (free) target.pos = free;
      }
      target.ghost = false;
      target.connected = true;
      if (this.state.turnPlayerId === null) this.state.turnPlayerId = target.id;
      events.push({ type: 'GHOST_SET', playerId, ghost: false });
      return { ok: true, events };
    });
  }

  findReachableFreeCell(goal, occupied) {
    const { size } = this.state.config;
    const occupiedKeys = new Set(occupied.map(cellKey));
    const candidates = [];
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        const position = { r, c };
        if (occupiedKeys.has(cellKey(position))) continue;
        if (!hasPath(position, goal, this.state.walls, size)) continue;
        candidates.push({ position, distance: manhattan(position, goal) });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0]?.position || null;
  }

  advanceTurn(events) {
    const active = nonGhostActive(this.state.players).sort((a, b) => a.colorIndex - b.colorIndex);
    if (active.length === 0) {
      this.state.turnPlayerId = null;
      return;
    }
    const ordered = [...this.state.players].sort((a, b) => a.colorIndex - b.colorIndex);
    const currentIndex = ordered.findIndex((player) => player.id === this.state.turnPlayerId);
    let next = null;
    for (let offset = 1; offset <= ordered.length; offset += 1) {
      const candidate = ordered[(currentIndex + offset + ordered.length) % ordered.length];
      if (!candidate.ghost && candidate.connected !== false) {
        next = candidate;
        break;
      }
    }
    if (!next) next = active[0];
    this.state.turnPlayerId = next.id;
    this.state.turnNumber += 1;
    events.push({
      type: 'TURN_CHANGED',
      fromPlayerId: currentIndex >= 0 ? ordered[currentIndex].id : null,
      toPlayerId: next.id,
      turnNumber: this.state.turnNumber,
    });
  }

  finish(winnerId, events = []) {
    if (typeof winnerId !== 'string' || !winnerId) return;
    this.state.status = 'finished';
    this.state.winnerId = winnerId;
    this.state.turnPlayerId = null;
    events.push({ type: 'PLAYER_WON', playerId: winnerId });
  }

  getDistances() {
    const { size } = this.state.config;
    return this.state.players.map((player) => ({
      id: player.id,
      distance: shortestPathDistance(player.pos, player.goal, this.state.walls, size),
    }));
  }
}

export function createGame(config, players, spawnResult, seed = 0) {
  return GameEngine.create(config, players, spawnResult, seed);
}

export function getTurnState(engine, playerId) {
  return {
    turnPlayerId: engine.state.turnPlayerId,
    turnNumber: engine.state.turnNumber,
    legalMoves: engine.getLegalMoves(playerId),
    legalSimpleMoves: engine.getLegalMoves(playerId, { simple: true }),
    legalWalls: engine.getLegalWallPlacements(playerId),
  };
}

export { DIRECTIONS, allActivePlayersHavePath, inBounds, isCell, isWallInBounds, wallEdgeKeys };
