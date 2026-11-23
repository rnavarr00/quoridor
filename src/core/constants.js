export const DEFAULT_CONFIG = Object.freeze({
  size: 12,
  maxPlayers: 4,
  wallsPerPlayer: 10,
  spawnMode: 'random',
  turnSeconds: 30,
});

export const LOCAL_DEFAULT_CONFIG = Object.freeze({
  size: 9,
  maxPlayers: 2,
  wallsPerPlayer: 10,
  spawnMode: 'random',
  turnSeconds: 30,
});

export const CASUAL_CONFIG = Object.freeze({
  size: 12,
  maxPlayers: 8,
  wallsPerPlayer: 10,
  spawnMode: 'random',
  turnSeconds: 30,
});

export const LIMITS = Object.freeze({
  size: { min: 8, max: 20 },
  players: { min: 2, max: 8 },
  walls: { min: 0, max: 20 },
  turnSeconds: 30,
});

export const SPAWN_MODES = Object.freeze(['random', 'central', 'perimeter']);

export const ORIENTATIONS = Object.freeze(['H', 'V']);

export const PLAYER_COLORS = Object.freeze([
  { name: 'Rojo', hex: '#B91C1C', soft: '#FCA5A5', dark: '#7F1D1D' },
  { name: 'Azul', hex: '#1D4ED8', soft: '#93C5FD', dark: '#1E3A8A' },
  { name: 'Verde', hex: '#166534', soft: '#86EFAC', dark: '#14532D' },
  { name: 'Ámbar', hex: '#A16207', soft: '#FDE68A', dark: '#713F12' },
  { name: 'Violeta', hex: '#6D28D9', soft: '#C4B5FD', dark: '#4C1D95' },
  { name: 'Naranja', hex: '#C2410C', soft: '#FDBA74', dark: '#7C2D12' },
  { name: 'Turquesa', hex: '#0F766E', soft: '#99F6E4', dark: '#115E59' },
  { name: 'Magenta', hex: '#9D174D', soft: '#F9A8D4', dark: '#831843' },
]);

export const ENGINE_ERRORS = Object.freeze([
  'NOT_YOUR_TURN',
  'GAME_FINISHED',
  'PLAYER_GHOST',
  'OUT_OF_BOARD',
  'NOT_ADJACENT',
  'CELL_OCCUPIED',
  'NO_WALLS_LEFT',
  'WALL_OUT_OF_BOUNDS',
  'WALL_OVERLAP',
  'WALL_CROSS',
  'NO_PATH',
  'CAMPING_FORCED_MOVE',
  'CAMPING_NO_WALL',
  'INVALID_ACTION',
  'INVALID_ORIENTATION',
]);

export const DIRECTIONS = Object.freeze([
  { dr: -1, dc: 0, name: 'N' },
  { dr: 1, dc: 0, name: 'S' },
  { dr: 0, dc: 1, name: 'E' },
  { dr: 0, dc: -1, name: 'W' },
]);

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeConfig(input = {}, fallback = DEFAULT_CONFIG) {
  const base = isPlainObject(input) ? input : {};
  const config = {
    size: Number.isInteger(base.size) ? base.size : fallback.size,
    maxPlayers: Number.isInteger(base.maxPlayers) ? base.maxPlayers : fallback.maxPlayers,
    wallsPerPlayer: Number.isInteger(base.wallsPerPlayer) ? base.wallsPerPlayer : fallback.wallsPerPlayer,
    spawnMode: typeof base.spawnMode === 'string' ? base.spawnMode : fallback.spawnMode,
    turnSeconds: Number.isInteger(base.turnSeconds) ? base.turnSeconds : fallback.turnSeconds,
  };
  return config;
}

export function validateConfig(config, currentPlayers = 0) {
  if (!isPlainObject(config)) return { ok: false, code: 'INVALID_CONFIG', message: 'Configuración inválida.' };
  if (!Number.isInteger(config.size) || config.size < LIMITS.size.min || config.size > LIMITS.size.max) {
    return { ok: false, code: 'INVALID_CONFIG', message: `El tamaño debe ser un entero entre ${LIMITS.size.min} y ${LIMITS.size.max}.` };
  }
  if (!Number.isInteger(config.maxPlayers) || config.maxPlayers < LIMITS.players.min || config.maxPlayers > LIMITS.players.max) {
    return { ok: false, code: 'INVALID_CONFIG', message: `El número de jugadores debe ser un entero entre ${LIMITS.players.min} y ${LIMITS.players.max}.` };
  }
  if (config.maxPlayers < currentPlayers) {
    return { ok: false, code: 'INVALID_CONFIG', message: 'No puedes reducir la sala por debajo de los jugadores actuales.' };
  }
  if (!Number.isInteger(config.wallsPerPlayer) || config.wallsPerPlayer < LIMITS.walls.min || config.wallsPerPlayer > LIMITS.walls.max) {
    return { ok: false, code: 'INVALID_CONFIG', message: `Las paredes deben ser un entero entre ${LIMITS.walls.min} y ${LIMITS.walls.max}.` };
  }
  if (!SPAWN_MODES.includes(config.spawnMode)) {
    return { ok: false, code: 'INVALID_CONFIG', message: 'Modo de spawn desconocido.' };
  }
  if (config.turnSeconds !== LIMITS.turnSeconds) {
    return { ok: false, code: 'INVALID_CONFIG', message: 'El temporizador de turno es fijo de 30 segundos.' };
  }
  return { ok: true, config };
}
