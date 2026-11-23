import crypto from 'node:crypto';
import { DEFAULT_CONFIG, ROOM_CODE_ALPHABET, ROOM_CODE_REGEX, SPAWN_MODES } from '../src/core/constants.js';

export const PROTOCOL_VERSION = '1.0';
export const TURN_SECONDS = 30;
export const TICK_INTERVAL_MS = 1000;
export const HEARTBEAT_INTERVAL_MS = 20000;
export const HEARTBEAT_TIMEOUT_MS = 45000;
export const HELLO_TIMEOUT_MS = 10000;
export const MAX_MESSAGE_BYTES = 8192;
export const HARD_MESSAGE_LIMIT_BYTES = 65536;
export const RATE_LIMIT_MESSAGES = 40;
export const RATE_LIMIT_WINDOW_MS = 10000;
export const RATE_LIMIT_CLOSE_THRESHOLD = 60;
export const RATE_REFILL_PER_SECOND = 4;
export const RATE_VIOLATION_LIMIT = 5;
export const MAX_CONNECTIONS_PER_IP = 20;
export const HELLO_LIMIT_PER_IP = 5;
export const HELLO_LIMIT_WINDOW_MS = 10000;
export const EXPIRED_ROOM_TTL_MS = 600000;
export const ALIAS_MAX = 20;
export const ROOM_CODE_LENGTH = 6;
export const MAX_ROOMS = 10000;
export const MAX_QUEUE = 5000;
export const SESSION_IDLE_MS = 600000;

export const ERROR_MESSAGES = Object.freeze({
  INVALID_PAYLOAD: 'Mensaje o estructura inválida.',
  UNKNOWN_TYPE: 'Tipo de mensaje desconocido.',
  MSG_TOO_LARGE: 'El mensaje supera el tamaño máximo permitido.',
  RATE_LIMITED: 'Demasiados mensajes; espera un momento.',
  NOT_IDENTIFIED: 'Debes identificarte antes de realizar esta acción.',
  ALREADY_IDENTIFIED: 'Este socket ya está identificado.',
  SESSION_INVALID: 'La sesión no es válida.',
  INVALID_CODE: 'El código de sala no es válido.',
  ROOM_NOT_FOUND: 'La sala no existe o ha expirado.',
  ROOM_FULL: 'La sala ya está completa.',
  ALREADY_IN_ROOM: 'Ya estás en una sala o en la cola.',
  NOT_IN_ROOM: 'No perteneces a ninguna sala.',
  INVALID_ALIAS: 'El alias no es válido.',
  INVALID_CONFIG: 'La configuración no es válida.',
  NOT_HOST: 'Solo el host puede realizar esta acción.',
  WRONG_STATE: 'La acción no está permitida en este estado.',
  GAME_STARTED: 'La partida ya ha empezado.',
  GAME_NOT_STARTED: 'La partida todavía no ha empezado.',
  GAME_ALREADY_FINISHED: 'La partida ya ha terminado.',
  NOT_ENOUGH_PLAYERS: 'Se necesitan al menos dos jugadores conectados.',
  NOT_YOUR_TURN: 'No es tu turno.',
  PLAYER_GHOST: 'No puedes actuar mientras estás desconectado de la partida.',
  INVALID_MOVE: 'El movimiento no es válido.',
  CAMPING_MUST_MOVE: 'Debes moverte fuera de la meta ocupada.',
  INVALID_WALL: 'La pared no es válida.',
  INVALID_ORIENTATION: 'La orientación debe ser H o V.',
  INVALID_COORDINATES: 'Las coordenadas no son válidas.',
  WALL_OUT_OF_BOUNDS: 'La pared está fuera del tablero.',
  WALL_OVERLAP: 'Ya hay una pared en esa posición.',
  NO_WALLS_LEFT: 'No te quedan paredes.',
  PATH_BLOCKED: 'La pared dejaría a un jugador sin camino a su meta.',
  REMATCH_NOT_AVAILABLE: 'La revancha no está disponible.',
  NOT_IN_QUEUE: 'No estás en la cola.',
  QUEUE_FULL: 'La cola de emparejamiento está llena.',
  ROOM_EXPIRED: 'La sala ha expirado por inactividad.',
  ROOM_CODE_EXHAUSTED: 'No se pudo generar un código de sala único.',
  INTERNAL_ERROR: 'Error interno del servidor.',
});

export class ProtocolError extends Error {
  constructor(code, message = null, details = null, closeCode = null) {
    super(message || ERROR_MESSAGES[code] || 'Error.');
    this.name = 'ProtocolError';
    this.code = code;
    this.details = details;
    this.closeCode = closeCode;
  }
}

export const CLIENT_TYPES = new Set([
  'client.hello',
  'client.createRoom',
  'client.joinRoom',
  'client.updateConfig',
  'client.resetConfig',
  'client.leaveRoom',
  'client.startGame',
  'client.quickPlay',
  'client.cancelQuickPlay',
  'client.move',
  'client.placeWall',
  'client.leaveGame',
  'client.rematch',
  'client.ping',
]);

const ENGINE_ERROR_MAP = Object.freeze({
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  GAME_FINISHED: 'GAME_ALREADY_FINISHED',
  GAME_NOT_STARTED: 'GAME_NOT_STARTED',
  PLAYER_GHOST: 'PLAYER_GHOST',
  OUT_OF_BOARD: 'INVALID_MOVE',
  NOT_ADJACENT: 'INVALID_MOVE',
  CELL_OCCUPIED: 'INVALID_MOVE',
  INVALID_MOVE: 'INVALID_MOVE',
  CAMPING_FORCED_MOVE: 'CAMPING_MUST_MOVE',
  CAMPING_NO_WALL: 'CAMPING_MUST_MOVE',
  NO_WALLS_LEFT: 'NO_WALLS_LEFT',
  WALL_OUT_OF_BOUNDS: 'WALL_OUT_OF_BOUNDS',
  WALL_OVERLAP: 'WALL_OVERLAP',
  WALL_CROSS: 'INVALID_WALL',
  NO_PATH: 'PATH_BLOCKED',
  INVALID_ORIENTATION: 'INVALID_ORIENTATION',
  INVALID_ACTION: 'INVALID_MOVE',
});

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function nowIso() {
  return new Date().toISOString();
}

export function send(ws, type, payload = {}, requestId = undefined) {
  if (!ws || ws.readyState !== 1 || typeof ws.send !== 'function') return false;
  const envelope = { type, payload };
  if (requestId !== undefined && requestId !== null) envelope.requestId = requestId;
  try {
    ws.send(JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

export function broadcast(sockets, type, payload = {}, requestId = undefined) {
  for (const socket of sockets || []) send(socket, type, payload, requestId);
}

export function sendError(ws, code, requestId = undefined, details = null, message = null) {
  const payload = {
    code,
    message: message || ERROR_MESSAGES[code] || 'Error.',
  };
  if (details !== null && details !== undefined) payload.details = details;
  return send(ws, 'server.error', payload, requestId);
}

export function normalizeRoomCode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (!ROOM_CODE_REGEX.test(normalized)) return null;
  return normalized;
}

export function generateRoomCode() {
  let code = '';
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_ALPHABET[crypto.randomInt(0, ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export function validateAlias(value) {
  if (typeof value !== 'string') return null;
  const alias = value.normalize('NFC').trim();
  const codePoints = [...alias];
  if (codePoints.length < 1 || codePoints.length > ALIAS_MAX) return null;
  if (/[\u0000-\u001F\u007F]/u.test(alias)) return null;
  return alias;
}

export function sanitizeName(value, fallback = 'Jugador') {
  return validateAlias(value) || fallback;
}

export function aliasKey(value) {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validatePlayerId(value) {
  return typeof value === 'string' && value.length <= 64 && UUID_RE.test(value);
}

export function validateSessionToken(value) {
  if (typeof value !== 'string') return false;
  if (value.length < 16 || value.length > 128) return false;
  return /^[\x20-\x7E]+$/u.test(value);
}

export function secureCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const CONFIG_FIELDS = new Set(['size', 'maxPlayers', 'wallsPerPlayer', 'spawnMode', 'turnSeconds']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function validateConfig(input = {}, options = {}) {
  const {
    currentPlayers = 0,
    base = DEFAULT_CONFIG,
    requireObject = false,
  } = options;

  if (input === undefined || input === null) {
    if (requireObject) return { ok: false, code: 'INVALID_CONFIG', message: ERROR_MESSAGES.INVALID_CONFIG };
    input = {};
  }
  if (!isPlainObject(input)) {
    return { ok: false, code: 'INVALID_CONFIG', message: ERROR_MESSAGES.INVALID_CONFIG };
  }

  for (const key of Object.keys(input)) {
    if (FORBIDDEN_KEYS.has(key) || !CONFIG_FIELDS.has(key)) {
      return { ok: false, code: 'INVALID_CONFIG', message: `Campo de configuración no permitido: ${key}.` };
    }
  }

  const config = {
    size: base.size,
    maxPlayers: base.maxPlayers,
    wallsPerPlayer: base.wallsPerPlayer,
    spawnMode: base.spawnMode,
    turnSeconds: base.turnSeconds,
  };

  if (Object.hasOwn(input, 'size')) {
    if (!Number.isInteger(input.size) || input.size < 8 || input.size > 20) {
      return { ok: false, code: 'INVALID_CONFIG', message: 'El tamaño debe ser un entero entre 8 y 20.' };
    }
    config.size = input.size;
  }
  if (Object.hasOwn(input, 'maxPlayers')) {
    if (!Number.isInteger(input.maxPlayers) || input.maxPlayers < 2 || input.maxPlayers > 8) {
      return { ok: false, code: 'INVALID_CONFIG', message: 'maxPlayers debe ser un entero entre 2 y 8.' };
    }
    if (input.maxPlayers < currentPlayers) {
      return { ok: false, code: 'INVALID_CONFIG', message: 'maxPlayers no puede ser menor que los jugadores actuales.' };
    }
    config.maxPlayers = input.maxPlayers;
  }
  if (Object.hasOwn(input, 'wallsPerPlayer')) {
    if (!Number.isInteger(input.wallsPerPlayer) || input.wallsPerPlayer < 0 || input.wallsPerPlayer > 20) {
      return { ok: false, code: 'INVALID_CONFIG', message: 'wallsPerPlayer debe ser un entero entre 0 y 20.' };
    }
    config.wallsPerPlayer = input.wallsPerPlayer;
  }
  if (Object.hasOwn(input, 'spawnMode')) {
    if (typeof input.spawnMode !== 'string' || !SPAWN_MODES.includes(input.spawnMode)) {
      return { ok: false, code: 'INVALID_CONFIG', message: 'spawnMode debe ser random, central o perimeter.' };
    }
    config.spawnMode = input.spawnMode;
  }
  if (Object.hasOwn(input, 'turnSeconds')) {
    if (!Number.isInteger(input.turnSeconds) || input.turnSeconds !== TURN_SECONDS) {
      return { ok: false, code: 'INVALID_CONFIG', message: 'turnSeconds es fijo y debe ser 30.' };
    }
    config.turnSeconds = TURN_SECONDS;
  }

  if (config.maxPlayers < currentPlayers) {
    return { ok: false, code: 'INVALID_CONFIG', message: 'maxPlayers no puede ser menor que los jugadores actuales.' };
  }

  return { ok: true, config };
}

export function mapEngineError(error) {
  if (!error) return 'INVALID_MOVE';
  return ENGINE_ERROR_MAP[error] || 'INTERNAL_ERROR';
}

export function parseEnvelope(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProtocolError('INVALID_PAYLOAD');
  }

  if (!isPlainObject(data)) throw new ProtocolError('INVALID_PAYLOAD');
  const { type, payload, requestId } = data;

  if (typeof type !== 'string' || type.length === 0) throw new ProtocolError('INVALID_PAYLOAD');
  if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 64)) {
    throw new ProtocolError('INVALID_PAYLOAD');
  }
  if (!isPlainObject(payload)) throw new ProtocolError('INVALID_PAYLOAD');
  if (!CLIENT_TYPES.has(type)) throw new ProtocolError('UNKNOWN_TYPE');

  return { type, payload, requestId };
}

export function validatePingPayload(payload) {
  if (payload.t === undefined) return { t: undefined };
  if (typeof payload.t !== 'number' || !Number.isFinite(payload.t)) {
    throw new ProtocolError('INVALID_PAYLOAD');
  }
  return { t: payload.t };
}

export function validateHelloPayload(payload) {
  let playerId;
  let sessionToken;
  let alias = null;

  if (payload.playerId !== undefined) {
    if (!validatePlayerId(payload.playerId)) throw new ProtocolError('INVALID_PAYLOAD');
    playerId = payload.playerId;
  }
  if (payload.sessionToken !== undefined) {
    if (!validateSessionToken(payload.sessionToken)) throw new ProtocolError('INVALID_PAYLOAD');
    sessionToken = payload.sessionToken;
  }
  if (payload.alias !== undefined) {
    alias = validateAlias(payload.alias);
    if (!alias) throw new ProtocolError('INVALID_ALIAS');
  }

  return { playerId, sessionToken, alias };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function randomSeed() {
  return crypto.randomInt(0, 0x100000000);
}

export function cryptoRng() {
  return crypto.randomInt(0, 0x1000000) / 0x1000000;
}

export { crypto };
