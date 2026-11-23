import { DIRECTIONS } from './constants.js';
import {
  activePlayerAt,
  cellKey,
  inBounds,
  isEdgeBlocked,
  sameCell,
} from './board.js';

const PERPENDICULAR = {
  N: ['E', 'W'],
  S: ['E', 'W'],
  E: ['N', 'S'],
  W: ['N', 'S'],
};

const DIRECTION_BY_NAME = Object.fromEntries(DIRECTIONS.map((dir) => [dir.name, dir]));

function addMove(moves, seen, playerId, to, kind, over) {
  const key = cellKey(to);
  if (seen.has(key)) return;
  seen.add(key);
  moves.push({ to, kind, over, playerId });
}

function computeSimpleMoves(state, player, moves, seen) {
  const { size } = state.config;
  for (const dir of DIRECTIONS) {
    const to = { r: player.pos.r + dir.dr, c: player.pos.c + dir.dc };
    if (!inBounds(to, size)) continue;
    if (isEdgeBlocked(state.walls, player.pos, to)) continue;
    if (activePlayerAt(state.players, to, player.id)) continue;
    addMove(moves, seen, player.id, to, 'step', []);
  }
}

function tryStraightChain(state, player, dir) {
  const { size } = state.config;
  let current = player.pos;
  const over = [];
  for (;;) {
    const next = { r: current.r + dir.dr, c: current.c + dir.dc };
    if (!inBounds(next, size)) return { over, landing: null, reason: 'boundary' };
    if (isEdgeBlocked(state.walls, current, next)) return { over, landing: null, reason: 'wall' };
    const occupant = activePlayerAt(state.players, next, player.id);
    if (occupant) {
      over.push(next);
      current = next;
      continue;
    }
    return { over, landing: next, reason: null };
  }
}

function tryLJump(state, player, firstPawn, dir) {
  const { size } = state.config;
  const results = [];
  const perpendicular = PERPENDICULAR[dir.name];
  for (const perpendicularName of perpendicular) {
    const pdir = DIRECTION_BY_NAME[perpendicularName];
    const corner = { r: player.pos.r + pdir.dr, c: player.pos.c + pdir.dc };
    const target = { r: firstPawn.r + pdir.dr, c: firstPawn.c + pdir.dc };
    if (!inBounds(corner, size) || !inBounds(target, size)) continue;
    if (activePlayerAt(state.players, corner, player.id)) continue;
    if (activePlayerAt(state.players, target, player.id)) continue;
    if (isEdgeBlocked(state.walls, player.pos, corner)) continue;
    if (isEdgeBlocked(state.walls, corner, target)) continue;
    results.push(target);
  }
  return results;
}

function computeJumpMoves(state, player, moves, seen) {
  const { size } = state.config;
  for (const dir of DIRECTIONS) {
    const first = { r: player.pos.r + dir.dr, c: player.pos.c + dir.dc };
    if (!inBounds(first, size)) continue;
    const firstPawn = activePlayerAt(state.players, first, player.id);
    if (!firstPawn) continue;
    if (isEdgeBlocked(state.walls, player.pos, first)) continue;

    const chain = tryStraightChain(state, player, dir);
    if (chain.landing) {
      addMove(
        moves,
        seen,
        player.id,
        chain.landing,
        chain.over.length > 1 ? 'chain' : 'straight',
        chain.over,
      );
      continue;
    }

    if (chain.over.length === 1 && (chain.reason === 'wall' || chain.reason === 'boundary')) {
      for (const target of tryLJump(state, player, first, dir)) {
        addMove(moves, seen, player.id, target, 'L', [first]);
      }
    }
  }
}

export function computeLegalMoves(state, playerId, options = {}) {
  const player = state.players.find((entry) => entry.id === playerId);
  if (!player || player.ghost || state.status !== 'playing') return [];
  if (state.turnPlayerId && state.turnPlayerId !== playerId) return [];
  const moves = [];
  const seen = new Set();
  computeSimpleMoves(state, player, moves, seen);
  if (!options.simple) computeJumpMoves(state, player, moves, seen);
  return moves;
}

export function findMove(state, playerId, to, options = {}) {
  return computeLegalMoves(state, playerId, options)
    .find((move) => sameCell(move.to, to)) || null;
}

export function pickRandom(items, rng) {
  if (!items.length) return null;
  let value;
  if (typeof rng === 'function') {
    value = rng();
  } else if (rng && typeof rng.int === 'function') {
    return items[rng.int(items.length)];
  } else if (rng && typeof rng.next === 'function') {
    value = rng.next();
  } else {
    value = Math.random();
  }
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(value * items.length)));
  return items[index];
}
