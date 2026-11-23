export const STORAGE_KEYS = Object.freeze({
  playerId: 'quoridor.playerId',
  sessionToken: 'quoridor.sessionToken',
  alias: 'quoridor.alias',
  prefs: 'quoridor.prefs',
});

export const SCREENS = Object.freeze([
  'home',
  'create',
  'join',
  'local',
  'queue',
  'lobby',
  'game',
  'gameover',
]);

export const LIMITS = Object.freeze({
  size: { min: 8, max: 20 },
  players: { min: 2, max: 8 },
  walls: { min: 0, max: 20 },
  alias: { min: 2, max: 16 },
  codeLength: 6,
});

export const CREATE_DEFAULT_CONFIG = Object.freeze({
  size: 9,
  maxPlayers: 2,
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

export const SERVER_RESET_CONFIG = Object.freeze({
  size: 12,
  maxPlayers: 4,
  wallsPerPlayer: 10,
  spawnMode: 'random',
  turnSeconds: 30,
});

export const ROOM_CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const ALIAS_REGEX = /^[\p{L}\p{N}](?:[\p{L}\p{N} _-]{0,14}[\p{L}\p{N}])?$/u;
const ALIAS_ALLOWED = /^[\p{L}\p{N} _-]*$/u;
const HEX64 = /^[0-9a-f]{64}$/i;

export const SPAWN_MODE_LABELS = Object.freeze({
  random: 'Aleatorio',
  central: 'Central',
  perimeter: 'Perímetro',
});

export const GOAL_SIDE_LABELS = Object.freeze({
  top: 'lado superior',
  bottom: 'lado inferior',
  left: 'lado izquierdo',
  right: 'lado derecho',
});

export const PLAYER_COLORS = Object.freeze([
  '#B91C1C',
  '#1D4ED8',
  '#166534',
  '#A16207',
  '#6D28D9',
  '#C2410C',
  '#0F766E',
  '#9D174D',
]);

export function colorVar(colorIndex) {
  const index = Number.isInteger(colorIndex) && colorIndex >= 0 && colorIndex <= 7 ? colorIndex : 0;
  return `var(--color-player-${index})`;
}

export function colorHex(colorIndex) {
  const index = Number.isInteger(colorIndex) && colorIndex >= 0 && colorIndex <= 7 ? colorIndex : 0;
  return PLAYER_COLORS[index];
}

export function playerInitial(name) {
  const text = typeof name === 'string' ? [...name.trim()] : [];
  return text.length ? text[0].toLocaleUpperCase('es') : '?';
}

export function normalizeAlias(raw) {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function validateAlias(raw) {
  const value = normalizeAlias(raw);
  const length = [...value].length;
  if (!value) return { ok: false, value, error: 'Escribe un alias para continuar.' };
  if (length < LIMITS.alias.min || length > LIMITS.alias.max) {
    return { ok: false, value, error: 'El alias debe tener entre 2 y 16 caracteres.' };
  }
  if (!ALIAS_ALLOWED.test(value)) {
    return { ok: false, value, error: 'Usa letras, números, espacios, guion o guion bajo.' };
  }
  const first = [...value][0];
  const last = [...value][length - 1];
  const edgeOk = /^[\p{L}\p{N}]$/u.test(first) && /^[\p{L}\p{N}]$/u.test(last);
  if (!edgeOk) {
    return { ok: false, value, error: 'El alias debe empezar y terminar con letra o número.' };
  }
  if (!ALIAS_REGEX.test(value)) {
    return { ok: false, value, error: 'Usa letras, números, espacios, guion o guion bajo.' };
  }
  return { ok: true, value, error: null };
}

export function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\s-]/g, '').toUpperCase().slice(0, LIMITS.codeLength);
}

export function validateRoomCode(raw) {
  const value = normalizeRoomCode(raw);
  if (!ROOM_CODE_REGEX.test(value)) {
    return { ok: false, value, error: 'El código debe tener 6 caracteres válidos.' };
  }
  return { ok: true, value, error: null };
}

export function clampInteger(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function sanitizeConfig(input, fallback = CREATE_DEFAULT_CONFIG) {
  const source = input && typeof input === 'object' ? input : {};
  const modes = ['random', 'central', 'perimeter'];
  return {
    size: clampInteger(source.size, LIMITS.size.min, LIMITS.size.max, fallback.size),
    maxPlayers: clampInteger(source.maxPlayers, LIMITS.players.min, LIMITS.players.max, fallback.maxPlayers),
    wallsPerPlayer: clampInteger(source.wallsPerPlayer, LIMITS.walls.min, LIMITS.walls.max, fallback.wallsPerPlayer),
    spawnMode: modes.includes(source.spawnMode) ? source.spawnMode : fallback.spawnMode,
    turnSeconds: 30,
  };
}

export function sameConfig(a, b) {
  if (!a || !b) return false;
  return a.size === b.size
    && a.maxPlayers === b.maxPlayers
    && a.wallsPerPlayer === b.wallsPerPlayer
    && a.spawnMode === b.spawnMode;
}

export function configSummary(config, playerCount = null) {
  const safe = sanitizeConfig(config);
  const players = Number.isInteger(playerCount) ? playerCount : safe.maxPlayers;
  return `Tablero ${safe.size} × ${safe.size} · ${players} jugadores · ${safe.wallsPerPlayer} paredes · Spawn ${SPAWN_MODE_LABELS[safe.spawnMode] || safe.spawnMode}`;
}

export function normalizeGoalCell(goal, size) {
  if (!goal || typeof goal !== 'object') return null;
  if (Number.isInteger(goal.x) && Number.isInteger(goal.y)) return { r: goal.y, c: goal.x };
  if (Number.isInteger(goal.r) && Number.isInteger(goal.c)) return { r: goal.r, c: goal.c };
  if (typeof goal.side === 'string' && Number.isInteger(goal.index)) {
    if (goal.side === 'top') return { r: 0, c: goal.index };
    if (goal.side === 'bottom') return { r: size - 1, c: goal.index };
    if (goal.side === 'left') return { r: goal.index, c: 0 };
    if (goal.side === 'right') return { r: goal.index, c: size - 1 };
  }
  return null;
}

export function goalSideFromCell(cell, size) {
  if (!cell) return null;
  if (cell.r === 0) return 'top';
  if (cell.r === size - 1) return 'bottom';
  if (cell.c === 0) return 'left';
  if (cell.c === size - 1) return 'right';
  return null;
}

export function goalSideLabel(goal, size) {
  if (!goal) return 'Meta';
  if (typeof goal.side === 'string' && GOAL_SIDE_LABELS[goal.side]) {
    return `Meta: ${GOAL_SIDE_LABELS[goal.side]}`;
  }
  const cell = normalizeGoalCell(goal, size);
  const side = goalSideFromCell(cell, size);
  if (side) return `Meta: ${GOAL_SIDE_LABELS[side]}`;
  if (cell) return `Meta: ${coordinateLabel(cell.r, cell.c)}`;
  return 'Meta';
}

export function coordinateLabel(row, col) {
  const letter = String.fromCharCode(65 + (col % 26));
  return `${letter}${row + 1}`;
}

export function cellKeyXY(x, y) {
  return `${x},${y}`;
}

export function sameCellXY(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y);
}

export function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // Persistencia no disponible: la sesión sigue funcionando en memoria.
  }
}

export function readString(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch (error) {
    return '';
  }
}

export function writeString(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    // Persistencia no disponible.
  }
}

export function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    // Persistencia no disponible.
  }
}

function randomHex(bytes) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function uuidFallback() {
  const data = new Uint8Array(16);
  crypto.getRandomValues(data);
  data[6] = (data[6] & 0x0f) | 0x40;
  data[8] = (data[8] & 0x3f) | 0x80;
  const hex = Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function loadIdentity() {
  let playerId = readString(STORAGE_KEYS.playerId);
  if (!playerId) {
    playerId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : uuidFallback();
    writeString(STORAGE_KEYS.playerId, playerId);
  }

  let sessionToken = readString(STORAGE_KEYS.sessionToken);
  if (!HEX64.test(sessionToken)) {
    sessionToken = randomHex(32);
    writeString(STORAGE_KEYS.sessionToken, sessionToken);
  }

  const aliasResult = validateAlias(readString(STORAGE_KEYS.alias));
  const alias = aliasResult.ok ? aliasResult.value : '';
  if (!alias) removeKey(STORAGE_KEYS.alias);

  return { playerId, sessionToken, alias };
}

export function clearIdentity() {
  removeKey(STORAGE_KEYS.playerId);
  removeKey(STORAGE_KEYS.sessionToken);
}

export function loadPrefs() {
  const prefs = readJSON(STORAGE_KEYS.prefs, {});
  return {
    patterns: Boolean(prefs && prefs.patterns),
    highContrast: Boolean(prefs && prefs.highContrast),
  };
}

export function savePrefs(prefs) {
  writeJSON(STORAGE_KEYS.prefs, {
    patterns: Boolean(prefs.patterns),
    highContrast: Boolean(prefs.highContrast),
  });
}

export const app = {
  screen: 'home',
  mode: null,
  connection: 'offline',
  room: null,
  game: null,
  local: null,
  myId: null,
  pending: null,
  queue: null,
  gameOver: null,
  prefs: loadPrefs(),
};

export function setPending(pending) {
  app.pending = pending || null;
}

export function isPending(action = null) {
  if (!app.pending) return false;
  return action ? app.pending.action === action : true;
}
