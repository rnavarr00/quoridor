import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './RoomManager.js';
import { Matchmaking } from './matchmaking.js';
import { RateLimiter, createIpLimiters } from './rateLimit.js';
import {
  HARD_MESSAGE_LIMIT_BYTES,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  HELLO_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  ProtocolError,
  nowIso,
  parseEnvelope,
  send,
  sendError,
  validatePingPayload,
} from './protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const coreDir = path.join(projectRoot, 'src', 'core');
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
});

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function resolveInside(root, relative) {
  if (typeof relative !== 'string' || relative.length === 0) return null;
  if (relative.includes('\0')) return null;
  const rootResolved = path.resolve(root);
  const candidate = path.resolve(rootResolved, `.${path.sep}${relative}`);
  if (candidate !== rootResolved && !candidate.startsWith(`${rootResolved}${path.sep}`)) return null;
  return candidate;
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isOriginAllowed(originHeader, hostHeader, allowedOrigins) {
  if (!originHeader) return true;
  if (originHeader === 'null') return allowedOrigins.has('null');
  const origin = normalizeOrigin(originHeader);
  if (!origin) return false;
  if (allowedOrigins.has(origin)) return true;
  if (!hostHeader) return false;
  return new URL(origin).host.toLowerCase() === hostHeader.toLowerCase();
}

function clientIp(req) {
  const raw = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function serveFile(req, res, filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeFor(filePath),
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function createRequestHandler() {
  return async function handleHttp(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
        res.end('Method not allowed');
        return;
      }

      let pathname;
      try {
        const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        pathname = decodeURIComponent(parsed.pathname);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad request');
        return;
      }

      if (pathname === '/health') {
        writeJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/core' || pathname.startsWith('/core/')) {
        const relative = pathname.slice('/core/'.length);
        const filePath = resolveInside(coreDir, relative);
        if (!filePath) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }
        await serveFile(req, res, filePath);
        return;
      }

      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = resolveInside(publicDir, relative);
      if (!filePath) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      await serveFile(req, res, filePath);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Internal error');
    }
  };
}

export function createServer(options = {}) {
  const manager = new RoomManager();
  const matchmaking = new Matchmaking(manager);
  manager.setMatchmaking(matchmaking);

  const configuredOrigins = Array.isArray(options.allowedOrigins)
    ? options.allowedOrigins
    : options.allowedOrigins
      ? [options.allowedOrigins]
      : [];
  const allowedOrigins = new Set(configuredOrigins.map(normalizeOrigin).filter(Boolean));
  const ipLimiters = createIpLimiters({ maxConnections: options.maxConnectionsPerIp });

  const httpServer = http.createServer(createRequestHandler());
  const wss = new WebSocketServer({ noServer: true, maxPayload: HARD_MESSAGE_LIMIT_BYTES });

  function safeHandle(scope, fn) {
    try {
      fn();
    } catch (error) {
      manager.logError(scope, error);
    }
  }

  function closeSocket(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
  }

  function handleEnvelope(ws, envelope) {
    const { type, payload, requestId } = envelope;

    if (type === 'client.hello') {
      const helloDecision = ipLimiters.allowHello(ws.context.ip);
      if (!helloDecision.allowed) {
        sendError(ws, 'RATE_LIMITED', requestId);
        if (helloDecision.close) closeSocket(ws, 1008, 'Límite de hello excedido');
        return;
      }
      if (ws.context.identified) throw new ProtocolError('ALREADY_IDENTIFIED');
      const result = manager.handleHello(ws, payload);
      const { session, resumed, room, status } = result;
      ws.context.playerId = session.playerId;
      ws.context.identified = true;
      if (ws.helloTimer) {
        clearTimeout(ws.helloTimer);
        ws.helloTimer = null;
      }

      send(ws, 'server.welcome', {
        playerId: session.playerId,
        serverTime: nowIso(),
        connectionId: ws.context.connectionId,
        resumed,
        roomCode: room ? room.code : null,
        status: room ? status : null,
      }, requestId);

      if (room) room.notifyReconnected(session.playerId);
      return;
    }

    if (type === 'client.ping') {
      const { t } = validatePingPayload(payload);
      const pong = { serverTime: nowIso() };
      if (t !== undefined) pong.t = t;
      send(ws, 'server.pong', pong, requestId);
      return;
    }

    if (!ws.context.identified) throw new ProtocolError('NOT_IDENTIFIED');
    const session = manager.sessions.get(ws.context.playerId);
    if (!session) throw new ProtocolError('NOT_IDENTIFIED');

    const requireRoom = () => {
      const room = manager.getRoomForSession(session);
      if (!room) throw new ProtocolError('NOT_IN_ROOM');
      return room;
    };

    switch (type) {
      case 'client.createRoom': {
        const room = manager.createRoom(session, payload.config, payload.alias);
        send(session.socket, 'server.roomCreated', room.getLobbySnapshot(), requestId);
        break;
      }
      case 'client.joinRoom': {
        const room = manager.joinRoom(session, payload.code, payload.alias);
        send(session.socket, 'server.roomJoined', room.getLobbySnapshot(), requestId);
        room.broadcastExcept(session.playerId, 'server.roomUpdate', room.getLobbySnapshot());
        break;
      }
      case 'client.updateConfig': {
        requireRoom().updateConfig(session.playerId, payload.config);
        break;
      }
      case 'client.resetConfig': {
        requireRoom().resetConfig(session.playerId);
        break;
      }
      case 'client.startGame': {
        requireRoom().startGame(session.playerId, { requestId, broadcast: true });
        break;
      }
      case 'client.leaveRoom': {
        requireRoom().leaveRoom(session.playerId, { requestId, reason: 'leave' });
        break;
      }
      case 'client.leaveGame': {
        requireRoom().leaveGame(session.playerId, { requestId, reason: 'leave' });
        break;
      }
      case 'client.rematch': {
        requireRoom().rematch(session.playerId, { requestId });
        break;
      }
      case 'client.move': {
        requireRoom().handleMove(session.playerId, payload.to, requestId);
        break;
      }
      case 'client.placeWall': {
        requireRoom().handlePlaceWall(
          session.playerId,
          payload.orientation,
          payload.x,
          payload.y,
          requestId,
        );
        break;
      }
      case 'client.quickPlay': {
        matchmaking.quickPlay(session, requestId);
        break;
      }
      case 'client.cancelQuickPlay': {
        matchmaking.cancelQuickPlay(session, requestId);
        break;
      }
      default:
        throw new ProtocolError('UNKNOWN_TYPE');
    }
  }

  function handleRawMessage(ws, data) {
    const isBuffer = Buffer.isBuffer(data);
    const buffer = isBuffer ? data : Buffer.from(data);
    const size = buffer.length;

    if (size > HARD_MESSAGE_LIMIT_BYTES) {
      closeSocket(ws, 1009, 'Frame demasiado grande');
      return;
    }
    if (size > MAX_MESSAGE_BYTES) {
      sendError(ws, 'MSG_TOO_LARGE');
      return;
    }

    const rate = ws.rateLimiter.hit();
    if (!rate.allowed) {
      sendError(ws, 'RATE_LIMITED');
      if (rate.close) closeSocket(ws, 1008, 'Rate limit excedido');
      return;
    }

    let envelope;
    try {
      envelope = parseEnvelope(buffer.toString('utf8'));
    } catch (error) {
      if (error instanceof ProtocolError) {
        sendError(ws, error.code);
        if (error.closeCode) closeSocket(ws, error.closeCode, error.code);
        return;
      }
      sendError(ws, 'INVALID_PAYLOAD');
      return;
    }

    try {
      handleEnvelope(ws, envelope);
    } catch (error) {
      if (error instanceof ProtocolError) {
        sendError(ws, error.code, envelope.requestId, error.details, error.message);
        if (error.closeCode) closeSocket(ws, error.closeCode, error.code);
        return;
      }
      manager.logError(`message:${envelope.type}`, error);
      sendError(ws, 'INTERNAL_ERROR', envelope.requestId);
    }
  }

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    ws.isAlive = true;
    ws.lastSeen = Date.now();
    ws.rateLimiter = new RateLimiter();
    ws.context = {
      playerId: null,
      identified: false,
      ip,
      connectionId: `c-${crypto.randomUUID().slice(0, 8)}`,
    };

    ws.helloTimer = setTimeout(() => {
      if (!ws.context.identified) closeSocket(ws, 4001, 'Hello requerido');
    }, HELLO_TIMEOUT_MS);
    ws.helloTimer.unref?.();

    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastSeen = Date.now();
    });

    ws.on('message', (data) => {
      ws.lastSeen = Date.now();
      try {
        handleRawMessage(ws, data);
      } catch (error) {
        manager.logError('rawMessage', error);
        sendError(ws, 'INTERNAL_ERROR');
      }
    });

    ws.on('close', () => {
      if (ws.helloTimer) {
        clearTimeout(ws.helloTimer);
        ws.helloTimer = null;
      }
      try {
        manager.handleSocketClose(ws);
      } catch (error) {
        manager.logError('socketClose', error);
      }
      ipLimiters.releaseConnection(ip);
    });

    ws.on('error', () => {
      // The close event performs the cleanup.
    });
  });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = null;
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      pathname = null;
    }
    const rejectUpgrade = (status, reason) => {
      try {
        socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } catch {
        // ignore
      }
      socket.destroy();
    };
    if (pathname !== '/ws') {
      rejectUpgrade(404, 'Not Found');
      return;
    }
    if (!isOriginAllowed(req.headers.origin, req.headers.host, allowedOrigins)) {
      rejectUpgrade(403, 'Forbidden');
      return;
    }
    if (!ipLimiters.acquireConnection(clientIp(req))) {
      rejectUpgrade(429, 'Too Many Requests');
      return;
    }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      ipLimiters.releaseConnection(clientIp(req));
      rejectUpgrade(400, 'Bad Request');
    }
  });

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (now - (ws.lastSeen || 0) > HEARTBEAT_TIMEOUT_MS) {
        closeSocket(ws, 4000, 'Heartbeat timeout');
        const fallback = setTimeout(() => {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
        }, 1000);
        fallback.unref?.();
        continue;
      }
      try {
        ws.ping();
      } catch {
        closeSocket(ws, 4000, 'Heartbeat timeout');
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  manager.startMaintenance();

  let closing = false;

  function listen(port = 0, host = undefined) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        httpServer.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off('error', onError);
        resolve(httpServer.address());
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(port, host);
    });
  }

  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(heartbeatTimer);
    manager.closeAll();
    for (const ws of wss.clients) {
      try {
        ws.close(1001, 'Servidor apagándose');
      } catch {
        // ignore
      }
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => {
      wss.close(() => resolve());
    });
    if (httpServer.listening) {
      await new Promise((resolve) => {
        httpServer.close(() => resolve());
      });
    }
  }

  return {
    httpServer,
    wss,
    manager,
    matchmaking,
    ipLimiters,
    listen,
    close,
    safeHandle,
    projectRoot,
    publicDir,
    coreDir,
  };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const port = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
  const app = createServer();

  app.listen(port).then((address) => {
    const resolvedPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Quoridor Arena escuchando en http://localhost:${resolvedPort}`);
  }).catch((error) => {
    console.error('No se pudo arrancar el servidor:', error);
    process.exitCode = 1;
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Recibido ${signal}; cerrando servidor...`);
    try {
      await app.close();
    } catch (error) {
      console.error('Error durante el cierre:', error);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('uncaughtException', (error) => {
    console.error('Excepción no capturada:', error);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Promesa rechazada sin manejar:', reason);
  });
}

export default createServer;
