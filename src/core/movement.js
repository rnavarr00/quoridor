import { DIRECTIONS } from './constants.js';
import {
  activePlayerAt,
  cellKey,
  inBounds,
  isEdgeBlocked,
  sameCell,
} from './board.js';

function computeBaseMoves(state, player) {
  const { size } = state.config;
  const moves = new Map();
  for (const dir of DIRECTIONS) {
    const to = { r: player.pos.r + dir.dr, c: player.pos.c + dir.dc };
    if (!inBounds(to, size)) continue;
    if (isEdgeBlocked(state.walls, player.pos, to)) continue;
    if (activePlayerAt(state.players, to, player.id)) continue;
    moves.set(cellKey(to), { to, kind: 'step', over: [], via: null });
  }
  return moves;
}

function activePlayers(state) {
  return state.players
    .filter((player) => !player.ghost && player.connected !== false)
    .sort((a, b) => a.colorIndex - b.colorIndex);
}

function adjacentPlayers(state, player, players, size) {
  const neighbors = [];
  for (const dir of DIRECTIONS) {
    const cell = { r: player.pos.r + dir.dr, c: player.pos.c + dir.dc };
    if (!inBounds(cell, size)) continue;
    const neighbor = players.find((entry) => entry.id !== player.id && sameCell(entry.pos, cell));
    if (neighbor) neighbors.push(neighbor);
  }
  return neighbors;
}

function computeSharedMoves(state) {
  const { size } = state.config;
  const players = activePlayers(state);
  const movesByPlayer = new Map();
  const neighborsByPlayer = new Map();

  for (const player of players) {
    movesByPlayer.set(player.id, computeBaseMoves(state, player));
    neighborsByPlayer.set(player.id, adjacentPlayers(state, player, players, size));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const player of players) {
      const own = movesByPlayer.get(player.id);
      for (const neighbor of neighborsByPlayer.get(player.id)) {
        for (const [key, move] of movesByPlayer.get(neighbor.id)) {
          if (own.has(key)) continue;
          own.set(key, { to: move.to, kind: 'inherited', over: [], via: neighbor.id });
          changed = true;
        }
      }
    }
  }

  return movesByPlayer;
}

function toMoveList(moves, playerId) {
  return [...moves.values()].map((move) => ({ ...move, playerId }));
}

export function computeLegalMoves(state, playerId, options = {}) {
  const player = state.players.find((entry) => entry.id === playerId);
  if (!player || player.ghost || state.status !== 'playing') return [];
  if (state.turnPlayerId && state.turnPlayerId !== playerId) return [];
  if (options.simple) return toMoveList(computeBaseMoves(state, player), playerId);
  return toMoveList(computeSharedMoves(state).get(playerId) || new Map(), playerId);
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
