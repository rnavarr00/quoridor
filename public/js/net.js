import { clearIdentity, loadIdentity, readString, writeString, STORAGE_KEYS } from './state.js';

const MAX_QUEUE = 20;
const PING_INTERVAL_MS = 20000;
const JOIN_TIMEOUT_MS = 10000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const NON_IDEMPOTENT_TYPES = new Set(['client.move', 'client.placeWall', 'client.startGame']);

class NetworkClient {
  constructor() {
    const identity = loadIdentity();
    this.playerId = identity.playerId;
    this.sessionToken = identity.sessionToken;
    this.alias = identity.alias;
    this.socket = null;
    this.status = 'offline';
    this.queue = [];
    this.requestTimeouts = new Map();
    this.handlers = new Map();
    this.statusHandlers = new Set();
    this.requestCounter = 0;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.manualClose = false;
    this.serverOffsetMs = 0;
    this.toastSink = null;
    this.started = false;
    this.boundVisibility = () => {
      if (document.visibilityState === 'visible' && this.status === 'online') {
        this.sendPing();
      }
    };
    this.boundOnline = () => {
      if (this.status !== 'online') this.connect();
    };
    this.boundOffline = () => {
      this.setStatus('offline');
    };
  }

  setToastSink(fn) {
    this.toastSink = typeof fn === 'function' ? fn : null;
  }

  toast(message, level = 'info', code = '') {
    if (this.toastSink) this.toastSink(message, level, code);
  }

  setAlias(alias) {
    this.alias = typeof alias === 'string' ? alias : '';
    if (this.alias) writeString(STORAGE_KEYS.alias, this.alias);
  }

  getIdentity() {
    return {
      playerId: this.playerId,
      sessionToken: this.sessionToken,
      alias: this.alias || readString(STORAGE_KEYS.alias),
    };
  }

  getStatus() {
    return this.status;
  }

  getServerNow() {
    return Date.now() + this.serverOffsetMs;
  }

  getServerOffset() {
    return this.serverOffsetMs;
  }

  on(type, handler) {
    if (typeof handler !== 'function') return () => {};
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  onStatus(handler) {
    if (typeof handler !== 'function') return () => {};
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  setStatus(status, info = {}) {
    if (this.status === status && !info.force) return;
    this.status = status;
    for (const handler of this.statusHandlers) {
      try {
        handler(status, info);
      } catch (error) {
        console.error('Error en manejador de estado de red', error);
      }
    }
  }

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.started) {
      this.started = true;
      window.addEventListener('online', this.boundOnline);
      window.addEventListener('offline', this.boundOffline);
      document.addEventListener('visibilitychange', this.boundVisibility);
      window.addEventListener('beforeunload', () => {
        this.manualClose = true;
        this.stopPing();
        if (this.socket) this.socket.close(1000, 'page-unload');
      });
    }

    this.manualClose = false;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${location.host}/ws`;
    this.setStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting', {
      attempt: this.reconnectAttempt,
      retryInMs: 0,
    });

    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.setStatus('online', { force: true });
      const identity = this.getIdentity();
      const payload = {
        playerId: identity.playerId,
        sessionToken: identity.sessionToken,
      };
      if (identity.alias) payload.alias = identity.alias;
      this.transmit({ type: 'client.hello', payload });
      this.flushQueue();
      this.startPing();
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.handleMessage(event.data);
    });

    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPing();
      if (this.manualClose || event.code === 1000) {
        this.setStatus('offline');
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (this.socket !== socket) return;
      // El evento close programa el reintento con backoff.
      this.setStatus('reconnecting', { attempt: this.reconnectAttempt, retryInMs: this.nextBackoff() });
    });
  }

  scheduleReconnect() {
    if (this.manualClose) {
      this.setStatus('offline');
      return;
    }
    this.stopPing();
    if (this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const delay = this.nextBackoff();
    this.setStatus('reconnecting', { attempt: this.reconnectAttempt, retryInMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  nextBackoff() {
    const base = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)];
    const jitter = base * (Math.random() * 0.4 - 0.2);
    return Math.max(500, Math.round(base + jitter));
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) this.sendPing();
    }, PING_INTERVAL_MS);
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  sendPing() {
    const envelope = {
      type: 'client.ping',
      requestId: this.nextRequestId(),
      payload: { t: Date.now() },
    };
    this.transmit(envelope);
  }

  nextRequestId() {
    this.requestCounter += 1;
    return `req-${Date.now().toString(36)}-${this.requestCounter}`;
  }

  startJoinTimeout(requestId) {
    const timer = setTimeout(() => {
      this.requestTimeouts.delete(requestId);
      this.handleMessage(JSON.stringify({
        type: 'server.error',
        requestId,
        payload: {
          code: 'JOIN_TIMEOUT',
          message: 'Tiempo de espera agotado al unirse a la sala.',
        },
      }));
    }, JOIN_TIMEOUT_MS);
    this.requestTimeouts.set(requestId, timer);
  }

  clearRequestTimeout(requestId) {
    const timer = this.requestTimeouts.get(requestId);
    if (!timer) return;
    clearTimeout(timer);
    this.requestTimeouts.delete(requestId);
  }

  send(type, payload = {}) {
    const envelope = {
      type,
      requestId: this.nextRequestId(),
      payload: payload && typeof payload === 'object' ? payload : {},
    };
    if (type === 'client.joinRoom') this.startJoinTimeout(envelope.requestId);
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.transmit(envelope);
    } else {
      if (this.queue.length >= MAX_QUEUE) {
        this.queue.shift();
        this.toast('Hay demasiados mensajes pendientes. Se ha descartado el más antiguo.', 'warning');
      }
      this.queue.push(envelope);
      if (this.status === 'offline') this.connect();
    }
    return envelope.requestId;
  }

  transmit(envelope) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(envelope));
    } catch (error) {
      this.toast('No se pudo enviar el mensaje.', 'error');
    }
  }

  flushQueue() {
    const pending = this.queue;
    this.queue = [];
    const replayable = [];
    let discarded = 0;
    for (const envelope of pending) {
      if (NON_IDEMPOTENT_TYPES.has(envelope.type)) discarded += 1;
      else replayable.push(envelope);
    }
    for (const envelope of replayable) this.transmit(envelope);
    if (discarded) {
      this.toast(
        `Se han descartado ${discarded} acción${discarded === 1 ? '' : 'es'} pendiente${discarded === 1 ? '' : 's'} (movimientos, paredes o inicio de partida) porque no se pueden reenviar tras reconectar.`,
        'warning',
        'QUEUE_DISCARDED',
      );
    }
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      return;
    }
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('server.')) return;
    if (message.requestId) this.clearRequestTimeout(message.requestId);
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};

    if (message.type === 'server.welcome') {
      this.updateOffset(payload.serverTime);
      if (payload.playerId && typeof payload.playerId === 'string') this.playerId = payload.playerId;
    } else if (message.type === 'server.pong') {
      this.updateOffset(payload.serverTime);
    } else if (message.type === 'server.tick') {
      this.updateOffset(payload.timestamp);
    } else if (message.type === 'server.error') {
      if (payload.code === 'SESSION_INVALID') {
        clearIdentity();
        this.toast('Tu sesión no es válida. Vuelve a empezar.', 'error', 'SESSION_INVALID');
        setTimeout(() => location.reload(), 350);
        return;
      }
      const text = typeof payload.message === 'string' && payload.message
        ? payload.message
        : this.errorMessage(payload.code);
      this.toast(text, 'error', payload.code);
    } else if (message.type === 'server.actionRejected') {
      const text = typeof payload.message === 'string' && payload.message
        ? payload.message
        : this.errorMessage(payload.code);
      if (payload.warning) {
        this.toast(`${text} Si vuelve a ocurrir, pasarás a fantasma.`, 'warning', payload.code);
      } else {
        this.toast(text, 'error', payload.code);
      }
    } else if (message.type === 'server.toast') {
      const level = ['info', 'warning', 'error', 'success'].includes(payload.level) ? payload.level : 'info';
      const text = typeof payload.message === 'string' ? payload.message : this.errorMessage(payload.code);
      this.toast(text, level, payload.code);
    }

    const set = this.handlers.get(message.type);
    if (set) {
      for (const handler of set) {
        try {
          handler(payload, message);
        } catch (error) {
          console.error(`Error al manejar ${message.type}`, error);
        }
      }
    }
  }

  updateOffset(serverTime) {
    if (typeof serverTime !== 'string') return;
    const timestamp = Date.parse(serverTime);
    if (!Number.isFinite(timestamp)) return;
    const sample = timestamp - Date.now();
    if (!Number.isFinite(this.serverOffsetMs) || Math.abs(this.serverOffsetMs) < 1) {
      this.serverOffsetMs = sample;
    } else {
      this.serverOffsetMs = this.serverOffsetMs * 0.8 + sample * 0.2;
    }
  }

  errorMessage(code) {
    const messages = {
      ROOM_NOT_FOUND: 'No existe ninguna sala con ese código.',
      ROOM_FULL: 'La sala está completa.',
      GAME_STARTED: 'La partida ya ha empezado.',
      INVALID_CODE: 'El código no es válido.',
      ROOM_EXPIRED: 'La sala ha caducado.',
      NOT_ENOUGH_PLAYERS: 'Faltan jugadores conectados.',
      NOT_HOST: 'Solo el host puede realizar esa acción.',
      INVALID_CONFIG: 'La configuración no es válida; revísala.',
      ALREADY_IN_ROOM: 'Ya estás en una sala.',
      NOT_IN_QUEUE: 'No estás en la cola.',
      QUEUE_FULL: 'La cola está llena. Inténtalo más tarde.',
      JOIN_TIMEOUT: 'Tiempo de espera agotado al unirse a la sala.',
    };
    return messages[code] || 'No se pudo completar la acción.';
  }
}

export const net = new NetworkClient();
