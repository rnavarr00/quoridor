import { InvalidConfigError, SpawnGenerationError, invariant } from './errors.js';
import { cellKey, inBounds, manhattan } from './board.js';
import { SPAWN_MODES } from './constants.js';

export const DEFAULT_MAX_ATTEMPTS = 32;
export const DEFAULT_NODE_BUDGET = 20000;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function goalDistance(size) {
  return Math.min(2 * (size - 1), Math.max(2, Math.round(0.6 * size)));
}

export function sampleWithoutReplacement(universe, count, rng) {
  if (!Number.isInteger(count) || count < 0) {
    throw new SpawnGenerationError('INSUFFICIENT_CANDIDATES', { count });
  }
  if (count > universe.length) {
    throw new SpawnGenerationError('INSUFFICIENT_CANDIDATES', {
      requested: count,
      available: universe.length,
    });
  }
  const pool = universe.slice();
  for (let i = 0; i < count; i += 1) {
    const span = pool.length - i;
    const j = i + Math.min(span - 1, Math.floor(rng() * span));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

function allCells(size) {
  const cells = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) cells.push({ r, c });
  }
  return cells;
}

export class RandomSpawnStrategy {
  constructor() {
    this.mode = 'random';
  }

  generateCandidates(size, count, rng) {
    return sampleWithoutReplacement(allCells(size), count, rng);
  }
}

export class CentralSpawnStrategy {
  constructor() {
    this.mode = 'central';
  }

  generateCandidates(size, count, rng) {
    const lo = Math.floor(size * 0.25);
    const hi = Math.ceil(size * 0.75) - 1;
    const candidates = [];
    for (let r = lo; r <= hi; r += 1) {
      for (let c = lo; c <= hi; c += 1) candidates.push({ r, c });
    }
    return sampleWithoutReplacement(candidates, count, rng);
  }
}

export class PerimeterSpawnStrategy {
  constructor() {
    this.mode = 'perimeter';
  }

  generateCandidates(size, count, rng) {
    const candidates = [];
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        const onBorder = r === 0 || c === 0 || r === size - 1 || c === size - 1;
        const corner = (r === 0 || r === size - 1) && (c === 0 || c === size - 1);
        if (onBorder && !corner) candidates.push({ r, c });
      }
    }
    return sampleWithoutReplacement(candidates, count, rng);
  }
}

const STRATEGIES = new Map([
  ['random', new RandomSpawnStrategy()],
  ['central', new CentralSpawnStrategy()],
  ['perimeter', new PerimeterSpawnStrategy()],
]);

export function getSpawnStrategy(mode) {
  const strategy = STRATEGIES.get(mode);
  if (!strategy) throw new InvalidConfigError('UNKNOWN_MODE', { mode });
  return strategy;
}

export function registerSpawnStrategy(mode, strategy) {
  if (typeof mode !== 'string' || !strategy || typeof strategy.generateCandidates !== 'function') {
    throw new InvalidConfigError('INVALID_STRATEGY', { mode });
  }
  STRATEGIES.set(mode, strategy);
}

function validDistanceOrder(size) {
  const base = goalDistance(size);
  const max = 2 * (size - 1);
  const order = [base];
  for (let delta = 1; delta <= max; delta += 1) {
    const lower = base - delta;
    const upper = base + delta;
    if (lower >= 2) order.push(lower);
    if (upper <= max) order.push(upper);
  }
  return [...new Set(order)];
}

function candidatesAtDistance(spawn, distance, size, spawnSet) {
  const cells = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      const candidate = { r, c };
      if (!inBounds(candidate, size)) continue;
      if (manhattan(spawn, candidate) !== distance) continue;
      if (spawnSet.has(cellKey(candidate))) continue;
      cells.push(candidate);
    }
  }
  return cells;
}

function assignGoals(spawns, distance, size, nodeBudget) {
  const spawnSet = new Set(spawns.map(cellKey));
  const candidates = spawns.map((spawn) => candidatesAtDistance(spawn, distance, size, spawnSet));
  if (candidates.some((list) => list.length === 0)) return null;

  const goals = new Array(spawns.length).fill(null);
  const used = new Set();
  let nodes = 0;
  let exhausted = false;

  function search(remaining) {
    if (!remaining.length) return true;
    nodes += 1;
    if (nodes > nodeBudget) {
      exhausted = true;
      return false;
    }

    let chosenIndex = -1;
    let chosenOptions = null;
    for (const index of remaining) {
      const options = candidates[index].filter((goal) => !used.has(cellKey(goal)));
      if (options.length === 0) return false;
      if (!chosenOptions || options.length < chosenOptions.length) {
        chosenIndex = index;
        chosenOptions = options;
      }
    }

    const nextRemaining = remaining.filter((index) => index !== chosenIndex);
    for (const option of chosenOptions) {
      const key = cellKey(option);
      used.add(key);
      goals[chosenIndex] = option;
      if (search(nextRemaining)) return true;
      goals[chosenIndex] = null;
      used.delete(key);
      if (exhausted) return false;
    }
    return false;
  }

  const indices = spawns.map((_, index) => index);
  const ok = search(indices);
  return ok && !exhausted ? goals : null;
}

export function generateSpawnsAndGoals(options = {}) {
  const {
    size,
    playerCount,
    mode = 'random',
    rng = Math.random,
    seed = null,
  } = options;
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : DEFAULT_MAX_ATTEMPTS;
  const nodeBudget = Number.isInteger(options.nodeBudget) && options.nodeBudget > 0
    ? options.nodeBudget
    : DEFAULT_NODE_BUDGET;

  if (!Number.isInteger(size) || size < 8 || size > 20) {
    throw new InvalidConfigError('INVALID_SIZE', { size });
  }
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 8) {
    throw new InvalidConfigError('INVALID_PLAYER_COUNT', { playerCount });
  }
  if (!SPAWN_MODES.includes(mode)) {
    throw new InvalidConfigError('UNKNOWN_MODE', { mode });
  }
  if (typeof rng !== 'function') {
    throw new InvalidConfigError('INVALID_RNG');
  }
  const strategy = getSpawnStrategy(mode);
  const baseDistance = goalDistance(size);
  const distanceOrder = validDistanceOrder(size);
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const spawns = strategy.generateCandidates(size, playerCount, rng);
    invariant(new Set(spawns.map(cellKey)).size === spawns.length, 'duplicate spawn generated');
    invariant(spawns.every((spawn) => inBounds(spawn, size)), 'spawn out of bounds');

    for (const distance of distanceOrder) {
      const goals = assignGoals(spawns, distance, size, nodeBudget);
      if (!goals) continue;

      const spawnSet = new Set(spawns.map(cellKey));
      const goalSet = new Set(goals.map(cellKey));
      invariant(spawnSet.size === spawns.length, 'duplicate spawn');
      invariant(goalSet.size === goals.length, 'duplicate goal');
      invariant(![...goalSet].some((key) => spawnSet.has(key)), 'goal collides with spawn');
      invariant(goals.every((goal, index) => manhattan(spawns[index], goal) === distance), 'distance mismatch');

      return {
        spawns,
        goals,
        meta: {
          mode,
          seed,
          goalDistance: distance,
          attempts,
          relaxed: distance !== baseDistance,
        },
      };
    }
  }

  throw new SpawnGenerationError('RETRY_EXHAUSTED', {
    size,
    playerCount,
    mode,
    maxAttempts,
    baseDistance,
  });
}

export function attachSpawnsToPlayers(players, result) {
  return players.map((player, index) => ({
    ...player,
    spawn: result.spawns[index],
    goal: result.goals[index],
  }));
}
