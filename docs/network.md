# Documento de red y protocolo

**Proyecto:** juego web tipo Quoridor, 2–8 jugadores  
**Arquitectura:** servidor autoritativo Node.js + `ws`, cliente HTML/CSS/JS vanilla  
**Versión del protocolo:** 1.0  
**Estado:** contrato implementable

## Decisiones canonicas v1

- WebSocket en /ws.
- Código de sala de 6 caracteres.
- Temporizador fijo de 30 segundos.
- Antifraude con 2 acciones inválidas.
- Fantasmas transitables.
- Fin con rematch al lobby.

---

## 1. Alcance, topología y responsabilidades

### 1.1 Alcance

Este documento define la comunicación entre el cliente web y el servidor autoritativo:

- Ciclo de vida de la conexión WebSocket.
- Identidad anónima de jugador, sesión y reconexión.
- Salas, lobby, configuración y códigos de sala.
- Matchmaking casual.
- Protocolo JSON completo, validaciones y códigos de error.
- Estado público de partida.
- Turnos, temporizador, timeout y movimiento automático.
- Anti-griefing/AFK, desconexiones, fantasmas y reconexión.
- Fin de partida y revancha.
- Seguridad, robustez, pruebas de integración y contrato con el motor.

El motor de reglas (`src/core`) es puro y no conoce red, sockets, timers ni persistencia. El servidor es la única autoridad sobre el estado de la partida.

### 1.2 Topología

```text
 Navegador A ──┐
 Navegador B ──┼── WSS/WS ──► Node.js (HTTP + ws) ──► RoomManager ──► Room ──► GameEngine (src/core)
 Navegador N ──┘                 │                                      │
                                 ├── matchmaking (cola FIFO)            ├── timers autoritativos
                                 └── protocol (validación/serialización)└── estado público
```

- Un único proceso Node.js en la versión inicial.
- Estado en memoria; no hay base de datos.
- El servidor HTTP sirve el cliente estático y acepta el upgrade WebSocket en `/ws`.
- No se soporta escalado horizontal sin sesiones sticky y un bus de salas. Fuera del alcance de v1.
- En producción se recomienda TLS/WSS detrás de un reverse proxy.

### 1.3 Autoridad y modelo de confianza

- **Servidor autoritativo:** decide configuración válida, pertenencia a sala, turno, legalidad de movimientos y paredes, timeout, fantasmas, ganador y revancha.
- **Cliente no confiable:** solo envía intenciones (`client.*`) y renderiza el estado recibido. Nunca muta el estado autoritativo.
- **Toda acción se valida** en el servidor: tipo, tamaño, forma, estado de sala, pertenencia, turno, reglas del motor y límites de tasa.
- **Los timers del cliente no son autoridad.** El cliente puede mostrar una cuenta atrás, pero el servidor rechaza cualquier acción fuera de plazo.
- **Secretos:** el `sessionToken` y los contadores internos nunca se envían a otros jugadores ni se incluyen en el estado público.
- **Autenticación:** anónima mediante `playerId` + `sessionToken` generados por el cliente y registrados por el servidor al entrar en una sala. No hay cuentas de usuario.
- **Aislamiento por mensaje:** una excepción al procesar un mensaje se captura, se registra y se responde con `INTERNAL_ERROR`; nunca debe tumbar el proceso ni la sala.

### 1.4 Módulos del servidor

| Módulo | Responsabilidad |
|---|---|
| `server/index.js` | Arranque HTTP/WS, upgrade, heartbeat, límite de conexiones, despacho de mensajes, cierre limpio (SIGINT/SIGTERM), manejo global de errores. |
| `server/protocol.js` | Definición de tipos de mensaje, esquemas de validación, serialización JSON, códigos de error estables y mapeo de errores del motor al protocolo. |
| `server/RoomManager.js` | Registro de salas activas, generación y unicidad de códigos, asociación `playerId`/token/socket/sala, creación/borrado de salas, expiración y transferencia de host. |
| `server/Room.js` | Máquina de estados de una sala (`lobby`/`playing`/`finished`), jugadores, configuración, host, timers de turno, contadores AFK, fantasmas, reconexión, fin de partida y revancha. |
| `server/matchmaking.js` | Cola FIFO de emparejamiento casual, cancelación, emparejamiento en grupos de 2..8 y creación de salas internas a través de `RoomManager`. |
| `server/rateLimit.js` (opcional, recomendado) | Token bucket por socket y por IP para mensajes y handshakes. |
| `src/core/GameEngine.js` | Reglas puras: tablero, movimientos propios y heredados, paredes, caminos, metas, turnos, ganador y estado público. Sin I/O ni timers. |

Nombres adicionales permitidos si mantienen esta separación: `server/validation.js`, `server/session.js`, `server/constants.js`. No se deben mezclar reglas de juego con gestión de sockets.

### 1.5 Constantes del sistema

| Constante | Valor | Notas |
|---|---:|---|
| `TURN_SECONDS` | 30 | Fijo; no editable por el host. |
| `TICK_INTERVAL_MS` | 1000 | Emisión de `server.tick`. |
| `HEARTBEAT_INTERVAL_MS` | 20000 | Ping WS del servidor. |
| `HEARTBEAT_TIMEOUT_MS` | 45000 | Sin pong/frame → conexión muerta. |
| `HELLO_TIMEOUT_MS` | 10000 | Sin `client.hello` → cierre 4001. |
| `MAX_MESSAGE_BYTES` | 8192 | Payload JSON máximo aceptado. |
| `HARD_MESSAGE_LIMIT_BYTES` | 65536 | Frame mayor → cierre 1009. |
| `RATE_LIMIT_MESSAGES` | 40 | Por socket. |
| `RATE_LIMIT_WINDOW_MS` | 10000 | Ventana deslizante. |
| `RATE_LIMIT_CLOSE_THRESHOLD` | 60 | Mensajes en 10 s que provocan cierre 1008. |
| `ALIAS_MAX` | 20 | Caracteres Unicode (code points). |
| `ROOM_CODE_LENGTH` | 6 | Alfabeto sin ambigüedad. |
| `LOBBY_IDLE_MS` | 1800000 | 30 min sin actividad en lobby. |
| `FINISHED_IDLE_MS` | 600000 | 10 min tras `gameOver` sin actividad. |
| `ABANDONED_GAME_MS` | 1800000 | 30 min de partida sin sockets conectados. |
| `MAX_ROOMS` | 10000 | Límite global configurable. |
| `MAX_QUEUE` | 5000 | Cola casual máxima. |
| `MAX_CONNECTIONS_PER_IP` | 20 | Configurable. |

---

## 2. Ciclo de vida de la conexión

### 2.1 Estados de conexión

```text
NEW ──hello válido──► IDENTIFIED ──create/join/quickPlay──► IN_ROOM | IN_QUEUE
  │                        │                                     │
  │                        └──────────leaveRoom/leaveGame────────┘
  └──timeout/error/close──► CLOSED
```

- `NEW`: socket abierto, sin `playerId` asociado. Solo se acepta `client.hello` (y `client.ping`).
- `IDENTIFIED`: `playerId` validado y socket enlazado. Puede crear/unirse a sala o entrar en cola.
- `IN_ROOM`: pertenece a una sala (`lobby`, `playing` o `finished`).
- `IN_QUEUE`: esperando matchmaking casual.
- `CLOSED`: socket cerrado; si estaba en partida, el jugador pasa a fantasma.

### 2.2 Conexión WebSocket

1. El cliente abre `ws(s)://<host>/ws`.
2. El servidor acepta el upgrade, crea el contexto de conexión y arranca el temporizador de `hello` (10 s).
3. El servidor aplica límites de conexiones por IP y, opcionalmente, validación de `Origin`.
4. El cliente debe enviar `client.hello` como primer mensaje útil.
5. Si no llega `hello` en 10 s, se cierra con código `4001`.

### 2.3 `client.hello` e identificación

El cliente genera y conserva:

- `playerId`: UUID v4/RFC 4122.
- `sessionToken`: cadena aleatoria criptográfica de 32–128 caracteres imprimibles (recomendado: 32 bytes en base64url o 64 hex).

`client.hello` payload:

```json
{
  "playerId": "8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d",
  "sessionToken": "q7T3m9Kp2sV8xL1nR6wY4zB0cD5fH7jN",
  "alias": "Ana"
}
```

Reglas:

- `playerId` obligatorio, formato UUID, longitud máxima 64.
- `sessionToken` obligatorio, 16..128 caracteres imprimibles, sin caracteres de control.
- `alias` opcional en `hello`; si se envía, se valida (1..20 tras `trim`, sin caracteres de control). Puede enviarse también en `createRoom`/`joinRoom`.
- Un mismo socket no puede enviar `hello` dos veces → `ALREADY_IDENTIFIED`.
- El servidor asocia `playerId` ↔ token ↔ socket. El token se guarda para validar reconexiones y **nunca se difunde**.

Detección de reconexión:

- Si el `playerId` ya existe en una sala activa y el token coincide, se reenlaza el socket (ver §2.5).
- Si el `playerId` existe pero el token no coincide → `SESSION_INVALID` y cierre `4001`.
- Si el `playerId` no existe o su sala ya no existe, se responde `server.welcome` con `resumed:false`.

Respuesta `server.welcome`:

```json
{
  "type": "server.welcome",
  "requestId": "req-1",
  "payload": {
    "playerId": "8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d",
    "serverTime": "2026-11-13T16:00:00.000Z",
    "connectionId": "c-7f2a",
    "resumed": false
  }
}
```

Con reconexión:

```json
{
  "type": "server.welcome",
  "requestId": "req-2",
  "payload": {
    "playerId": "8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d",
    "serverTime": "2026-11-13T16:05:12.000Z",
    "connectionId": "c-7f2a",
    "resumed": true,
    "roomCode": "AB12CD",
    "status": "playing"
  }
}
```

### 2.4 Heartbeat y liveness

- El servidor envía un frame WS `ping` cada 20 s.
- Se considera viva cualquier conexión que responda `pong` o envíe cualquier frame dentro de 45 s desde el último ping.
- Si no hay respuesta en 45 s, el servidor termina el socket, lo trata como desconexión (§9) y cierra con código `4000`.
- El cliente puede enviar `client.ping` cuando quiera (sujeto a rate limit); el servidor responde `server.pong` con el `t` recibido y su hora.
- `server.tick` no sustituye al heartbeat; son mecanismos independientes.

### 2.5 Reconexión

La reconexión se permite mientras la sala siga existiendo, tanto en `playing` como en `finished`:

1. El cliente abre un socket nuevo y envía `client.hello` con el mismo `playerId` y `sessionToken`.
2. El servidor valida token y sala.
3. Si el jugador estaba marcado como fantasma, se rebindea el socket, se limpia `ghost`, se marca `connected:true` y se resuelve su posición si su celda fue ocupada (§9).
4. Se envía `server.welcome` (`resumed:true`) y el estado completo (`server.gameState` o `server.roomUpdate`, según estado).
5. Se difunde `server.playerReconnected` al resto de la sala.

Si la sala fue borrada o expiró, no hay reconexión: `server.welcome` con `resumed:false`; el cliente debe crear o unirse de nuevo. Si el jugador fue eliminado en lobby, tampoco se reanuda automáticamente.

### 2.6 Cierres

| Código | Motivo |
|---:|---|
| `1000` | Cierre normal solicitado por el cliente. |
| `1001` | Servidor apagándose o sala eliminada. |
| `1008` | Violación de política: rate limit, token inválido reiterado, protocolo abusivo. |
| `1009` | Frame demasiado grande (> 64 KiB). |
| `1011` | Error interno no recuperable del servidor. |
| `4000` | Timeout de heartbeat. |
| `4001` | Falta de `hello`, `hello` inválido o sesión inválida. |
| `4002` | Violación de protocolo (mensaje no JSON, estructura inválida reiterada). |
| `4003` | Jugador marcado como fantasma por AFK. |

Antes de cerrar por `1001`, `1008` o `4003`, el servidor envía, si es posible, un `server.error` o `server.toast` explicativo.

### 2.7 Expiración de salas y sesiones

| Situación | Regla |
|---|---|
| Lobby sin actividad | 30 min desde `lastActivityAt` → `server.toast` `ROOM_EXPIRED`, cierre `1001` y borrado. |
| Lobby sin jugadores | Se borra inmediatamente (no puede quedar host sin reemplazo). |
| Partida activa sin sockets conectados | 30 min → se abandona y se borra. |
| Partida finalizada | 10 min sin actividad o 5 min sin sockets → se borra. |
| Sala en partida mientras haya al menos un socket | No expira por tiempo de pared; solo por abandono. |
| Sesión de jugador eliminado | Se borra junto con la sala o al salir del lobby. |

`lastActivityAt` se actualiza con uniones, salidas, cambios de configuración, inicio, acciones válidas, reconexiones y revancha. Los ticks y timeouts no cuentan como actividad de sala.

## 3. Salas y lobby

### 3.1 Estructura interna de sala

```text
Room {
  code: string                       // 6 chars, único entre salas activas
  createdAt: ISOString
  updatedAt: ISOString
  lastActivityAt: number             // epoch ms
  status: 'lobby' | 'playing' | 'finished'
  hostPlayerId: string
  config: Config
  players: Map<playerId, Player>
  game: null | {
    gameId: string
    engine: GameEngine
    turnDeadline: number             // epoch ms
    turnNumber: number
    tickTimer: Timer
    turnTimer: Timer
    winnerId: string | null
    startedAt: ISOString
  }
  cleanupTimer: Timer | null
}

Player {
  id: string
  alias: string
  colorIndex: number                 // 0..19
  sessionToken: string               // secreto, nunca público
  socket: WebSocket | null
  connected: boolean
  ghost: boolean
  isHost: boolean
  joinedAt: ISOString
  invalidTurnCount: number           // interno
  invalidCountedThisTurn: boolean    // interno
  lastInvalidTurnNumber: number      // interno
}
```

El estado interno no se serializa directamente. `Room.getLobbySnapshot()` y `Room.getGameState()` producen solo los campos permitidos (§5 y §6).

### 3.2 Configuración

`Config`:

```json
{
  "size": 12,
  "maxPlayers": 4,
  "wallsPerPlayer": 10,
  "spawnMode": "random",
  "turnSeconds": 30
}
```

| Campo | Tipo | Default | Rango / valores | Editable por host |
|---|---|---|---:|---|
| `size` | entero | `12` | 8..16 | Sí, solo en lobby |
| `maxPlayers` | entero | `4` | 2..8 | Sí, solo en lobby |
| `wallsPerPlayer` | entero | `10` | 0..20 | Sí, solo en lobby |
| `spawnMode` | string | `"random"` | `random` \| `central` \| `perimeter` | Sí, solo en lobby |
| `turnSeconds` | entero | `30` | fijo `30` | No |

Validaciones:

- Todos los campos deben ser enteros o strings exactos; no se aceptan números en formato string, `NaN`, `Infinity`, `null` ni decimales.
- `size`, `maxPlayers` y `wallsPerPlayer` deben estar dentro de rango.
- `maxPlayers` no puede ser menor que el número actual de jugadores en la sala.
- `turnSeconds` es de solo lectura; si se envía con un valor distinto de 30 → `INVALID_CONFIG`.
- Campos desconocidos en `config` → `INVALID_CONFIG`.
- La configuración se valida de forma atómica: si un campo falla, no se aplica ninguno.

### 3.3 Códigos de sala

- Longitud exacta: 6 caracteres.
- Alfabeto: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (sin `I`, `O`, `0`, `1`).
- Regex canónica: `^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$`.
- Generación criptográfica: `crypto.randomInt(0, alphabet.length)` por carácter, o bytes aleatorios con rechazo de sesgo.
- Unicidad: se comprueba contra todas las salas activas; si colisiona, se regenera (máximo 20 intentos). Si se agota → `ROOM_CODE_EXHAUSTED`.
- Entrada del usuario: `trim` y conversión a mayúsculas antes de comparar. `ab12cd` es equivalente a `AB12CD`.
- Tras normalizar, si no cumple la regex → `INVALID_CODE`.
- Durante la revancha se conserva el mismo código salvo que colisione o la sala se haya recreado; en ese caso se genera uno nuevo y se comunica en `server.rematchLobby`.

### 3.4 Alias

- Obligatorio para crear o unirse a una sala (puede venir en `hello` o en el mensaje de creación/unión).
- `trim` obligatorio; longitud 1..20 code points Unicode tras normalizar a NFC.
- Prohibidos caracteres de control (`U+0000`–`U+001F`, `U+007F`), saltos de línea y tabs.
- Se permite cualquier otro texto, incluidas tildes y emojis, pero el cliente debe renderizarlo con `textContent`, nunca como HTML.
- Unicidad por sala, comparación normalizada (NFC + casefold). Si colisiona, el servidor sufija:
  - `"Ana"` → `"Ana (2)"`, `"Ana (3)"`, ...
  - Se trunca la base para que el alias final no supere 20 caracteres.
  - Máximo 99 sufijos; si se agota → `INVALID_ALIAS`.
- Los alias pueden repetirse entre salas distintas.
- El alias no se puede cambiar durante una partida. En lobby, para cambiarlo se debe salir y volver a entrar.

### 3.5 Asientos y colores

- `colorIndex` ∈ 0..19, asignado al entrar en el lobby al menor índice libre.
- Durante el lobby se compacta al salir un jugador (se libera su índice y puede reutilizarse).
- Al comenzar la partida, los índices quedan congelados y determinan el orden de turno y la paleta.
- Los fantasmas conservan su `colorIndex` y asiento.
- El host no tiene por qué ser `colorIndex:0`; es el creador o el siguiente conectado tras una transferencia.
- Orden de turno: `colorIndex` ascendente entre jugadores activos (`connected && !ghost`).

### 3.6 Unión a sala: validaciones en orden

1. El socket está identificado (`hello` previo) → si no, `NOT_IDENTIFIED`.
2. El jugador no pertenece ya a una sala ni está en cola → si no, `ALREADY_IN_ROOM`.
3. `code` presente, string, normalizado y con formato válido → si no, `INVALID_CODE`.
4. La sala existe y no ha expirado → si no existe, `ROOM_NOT_FOUND`; si existe pero ha caducado, se responde `server.error` con código `ROOM_EXPIRED`.
5. La sala está en `lobby` → si está `playing`/`finished`, `GAME_STARTED` (la reconexión de fantasmas va por `hello`, no por `joinRoom`).
6. `alias` válido → si no, `INVALID_ALIAS`.
7. Hay hueco: `players.size < config.maxPlayers` → si no, `ROOM_FULL`.
8. Se resuelve colisión de alias con sufijo.
9. Se crea el jugador, se asigna asiento, se enlaza token/socket y se responde.

Un `joinRoom` a una partida en curso nunca convierte al jugador en fantasma ni participante: debe reconectar con `hello`.

### 3.7 Cambios de configuración y reset

`client.updateConfig`:

- Solo el host.
- Solo en estado `lobby`.
- `config` debe ser un objeto con un subconjunto de campos editables; se hace merge sobre la configuración actual y se valida el resultado completo.
- Si el nuevo `maxPlayers` es menor que el número actual de jugadores → `INVALID_CONFIG`.
- Si la sala está `playing`/`finished` → `GAME_STARTED`.
- Si no es host → `NOT_HOST`.
- Se difunde `server.roomUpdate` a todos los sockets de la sala.

`client.resetConfig`:

- Solo host y solo en lobby.
- Restablece `size:12`, `wallsPerPlayer:10`, `spawnMode:"random"`, `turnSeconds:30`.
- `maxPlayers` vuelve a `4`, salvo que haya más de 4 jugadores en la sala; en ese caso se fija al número actual de jugadores (5..8) para mantener la configuración válida. El `roomUpdate` refleja el valor efectivo.
- Difunde `server.roomUpdate`.

### 3.8 Inicio de partida

`client.startGame`:

- Solo host.
- Solo en `lobby`.
- Debe haber al menos 2 jugadores conectados y no fantasmas (`connected && !ghost`).
- Si hay menos → `NOT_ENOUGH_PLAYERS`.
- Se crea un `gameId` nuevo, se instancia `GameEngine` con la configuración vigente y los jugadores activos por `colorIndex`.
- Se calculan spawns y metas según `spawnMode` (responsabilidad del motor).
- `status = 'playing'`, `turnNumber = 1`, primer turno para el menor `colorIndex` activo.
- Se arranca el timer de 30 s y el tick de 1 s.
- Se difunde `server.gameStarted` con el estado público completo.

No se puede iniciar si la configuración no es válida o si no hay suficientes jugadores activos.

### 3.9 Salida, host y borrado

En `lobby`:

- `client.leaveRoom` elimina al jugador de inmediato, libera su asiento y su token de sala.
- Si era el host, se transfiere al jugador conectado con menor `colorIndex`; se difunde `server.hostChanged` y `server.roomUpdate`.
- Si no queda nadie, se borra la sala y se cancelan sus timers.
- El socket del jugador que sale sigue abierto y queda `IDENTIFIED`, libre para crear/unirse a otra sala o entrar en cola.

En `playing`:

- `client.leaveRoom` → `GAME_STARTED`; para salir hay que usar `client.leaveGame` (pasa a fantasma).
- El cierre de socket o timeout de heartbeat también convierte al jugador en fantasma.
- El host conserva el rol mientras esté fantasma; no se transfiere durante la partida porque no tiene poderes especiales. Si al volver a lobby por revancha sigue desconectado, se elimina y se transfiere el host.

En `finished`:

- `client.leaveRoom` elimina al jugador y libera su asiento; si no queda nadie, se borra la sala.
- `client.rematch` inicia la transición a lobby (§10).

### 3.10 Límites de sala

- Máximo global de salas activas: 10 000 (configurable).
- Máximo de jugadores por sala: `config.maxPlayers` (2..8).
- Un jugador pertenece como máximo a una sala y a una cola simultáneamente.
- Cola casual máxima: 5 000.
- No se permiten salas con 0 jugadores.
- Los fantasmas cuentan para el tamaño del `players` map y conservan asiento, pero no para iniciar/continuar la partida.

---

## 4. Matchmaking casual

### 4.1 Cola

- Cola FIFO global, con una entrada por `playerId`.
- Solo pueden entrar jugadores `IDENTIFIED`, que no estén en sala ni ya en cola.
- Si están en sala → `ALREADY_IN_ROOM`; si ya están en cola, la operación es idempotente (se responde `server.matchSearching` sin duplicar).
- Si la cola está llena → `QUEUE_FULL`.

### 4.2 Configuración de la partida casual

Aunque el jugador tenga una configuración guardada, la partida casual usa siempre:

```json
{
  "size": 12,
  "maxPlayers": 8,
  "wallsPerPlayer": 10,
  "spawnMode": "random",
  "turnSeconds": 30
}
```

`maxPlayers:8` es específico del matchmaking casual; el default de sala creada manualmente sigue siendo 4.

### 4.3 Emparejamiento

1. Al entrar/salir de la cola, `matchmaking.js` intenta emparejar.
2. Si hay al menos 2 jugadores en cola, se extraen los primeros 8 como máximo.
3. Se crea una sala interna con código generado, `status:'lobby'`, host el primero del grupo y la configuración casual anterior.
4. Se añaden los jugadores en orden FIFO (asientos 0..n-1).
5. Se envía `server.matchFound` a cada emparejado y, a continuación, `server.gameStarted` con el estado inicial. La partida empieza automáticamente.
6. Los jugadores restantes permanecen en la cola y se reevalúan si siguen siendo ≥2.

No hay tiempo de espera máximo: un jugador puede permanecer en cola hasta que se empareje o cancele. Si se queda solo, sigue esperando.

### 4.4 Cancelación

- `client.cancelQuickPlay` solo es válido en estado `IN_QUEUE`; si no, `NOT_IN_QUEUE`.
- Elimina la entrada y responde `server.matchCancelled` (extensión del protocolo) con el tamaño actual de la cola.
- Si el jugador se desconecta estando en cola, se elimina automáticamente sin notificar a nadie.
- Si es emparejado justo antes de cancelar, gana la carrera el servidor: recibirá `matchFound` y ya no estará en cola; la cancelación devuelve `NOT_IN_QUEUE`.

### 4.5 Mensajes de matchmaking

| Mensaje | Dirección | Payload |
|---|---|---|
| `client.quickPlay` | C→S | `{}` |
| `client.cancelQuickPlay` | C→S | `{}` |
| `server.matchSearching` | S→C | `{ "position": 2, "queueSize": 3, "config": Config }` |
| `server.matchFound` | S→C | `{ "roomCode": "AB12CD", "gameId": "uuid", "playerIds": ["..."], "config": Config }` |
| `server.matchCancelled` | S→C | `{ "queueSize": 1 }` |

`position` es 1-based y puede variar con el tiempo; el cliente no debe usarlo para lógica crítica.

---

## 5. Protocolo

### 5.1 Sobre y reglas generales

Todos los mensajes son texto JSON con esta forma:

```json
{
  "type": "client.move",
  "requestId": "req-42",
  "payload": { "to": { "x": 6, "y": 10 } }
}
```

- `type`: obligatorio, string, uno de los definidos en este documento.
- `requestId`: opcional, string de 1..64 caracteres. Si está presente y el mensaje genera una respuesta directa, el servidor lo replica.
- `payload`: obligatorio, objeto JSON. Para mensajes sin datos, `{}`.
- Tamaño máximo del frame: 8 192 bytes. Entre 8 192 y 65 536 → `MSG_TOO_LARGE` y se descarta. Por encima de 65 536 → cierre `1009`.
- JSON inválido, raíz no objeto, `type` ausente o `payload` no objeto → `INVALID_PAYLOAD` (o cierre `4002` si es reiterado/abusivo).
- `type` desconocido → `UNKNOWN_TYPE`, sin cerrar la conexión.
- Campos extra en `payload`: se ignoran salvo que el mensaje exija validación estricta; los campos extra en `config` sí se rechazan.
- Los broadcasts no llevan `requestId` salvo que se indique lo contrario; cuando un broadcast es consecuencia directa de una petición, puede incluir el `requestId` del emisor (no es un secreto).

### 5.2 Mensajes cliente → servidor

| `type` | Payload | Estado / rol requerido | Validaciones principales | Respuesta / difusión |
|---|---|---|---|---|
| `client.hello` | `{ playerId, sessionToken, alias? }` | `NEW` | UUID, token 16..128, alias válido si existe; token correcto si el jugador ya existe | `server.welcome`; si reconecta, `server.playerReconnected` + estado |
| `client.createRoom` | `{ config?: Partial<Config>, alias?: string }` | `IDENTIFIED`, sin sala ni cola | Config válida y completa tras defaults; alias válido; límites globales | `server.roomCreated` |
| `client.joinRoom` | `{ code, alias? }` | `IDENTIFIED`, sin sala ni cola | §3.6 completo | `server.roomJoined` + `server.roomUpdate` a los demás |
| `client.updateConfig` | `{ config: Partial<Config> }` | Lobby, host | §3.7; solo campos editables; `maxPlayers >= players.size` | `server.roomUpdate` a todos |
| `client.resetConfig` | `{}` | Lobby, host | §3.7 | `server.roomUpdate` a todos |
| `client.leaveRoom` | `{}` | Lobby o finished | Si `playing` → `GAME_STARTED`; debe estar en sala | `server.leftRoom` al jugador + `server.roomUpdate`/`server.hostChanged` |
| `client.startGame` | `{}` | Lobby, host | ≥2 conectados no fantasmas; config válida; sala no vacía | `server.gameStarted` a todos |
| `client.quickPlay` | `{}` | `IDENTIFIED`, sin sala ni cola | §4; cola no llena | `server.matchSearching`; luego `server.matchFound` + `server.gameStarted` |
| `client.cancelQuickPlay` | `{}` | `IN_QUEUE` | Estar en cola | `server.matchCancelled` |
| `client.move` | `{ to: { x, y } }` | `playing`, turno del jugador, activo (no fantasma) | Enteros en tablero; destino ≠ posición actual; reglas del motor (movimiento propio/heredado/pared) | `server.gameState` a todos; posible `server.gameOver` |
| `client.placeWall` | `{ orientation, x, y }` | `playing`, turno del jugador, activo | `H`/`V`; enteros 0..size-2; pared no solapada; camino válido; `wallsLeft > 0` | `server.gameState` a todos; posible `server.gameOver` |
| `client.leaveGame` | `{}` | `playing`, jugador activo | Pasar a fantasma; si solo queda 1 activo, fin de partida | `server.playerDisconnected` a todos + `server.gameState`; posible `server.gameOver` |
| `client.rematch` | `{}` | `finished`, conectado | Sala finalizada; eliminar fantasmas; reiniciar lobby | `server.rematchLobby` a todos |
| `client.ping` | `{ t?: number }` | Cualquiera | `t` numérico si existe | `server.pong` |

Notas:

- `client.leaveRoom` durante `playing` se rechaza con `GAME_STARTED`; el cliente debe usar `client.leaveGame`.
- `client.leaveRoom` en `finished` elimina al jugador (no crea fantasma).
- `client.createRoom` y `client.joinRoom` requieren alias: si no se envió en `hello`, debe venir en el payload; si no, `INVALID_ALIAS`.
- Un mensaje de juego (`move`/`placeWall`) fuera de `playing` → `GAME_NOT_STARTED` o `GAME_ALREADY_FINISHED`.
- Un jugador fantasma que envíe `move`/`placeWall` → `PLAYER_GHOST` (no cuenta como acción inválida AFK, porque ya es fantasma).

### 5.3 Mensajes servidor → cliente

| `type` | Payload | Cuándo se envía |
|---|---|---|
| `server.welcome` | `{ playerId, serverTime, connectionId, resumed, roomCode?, status? }` | Respuesta a `client.hello` |
| `server.roomCreated` | `{ roomCode, hostPlayerId, config, players, status, createdAt, updatedAt }` | Tras crear sala |
| `server.roomJoined` | `{ roomCode, hostPlayerId, config, players, status, createdAt, updatedAt }` | Al jugador que se une; snapshot del lobby |
| `server.roomUpdate` | `{ roomCode, hostPlayerId, config, players, status, updatedAt }` | Cambios de lobby (entradas, salidas, config, host) |
| `server.leftRoom` | `{ roomCode, playerId, reason }` | Confirmación al jugador que sale de lobby/finished |
| `server.gameStarted` | `{ roomCode, gameId, config, state }` | Inicio de partida (manual o casual) |
| `server.gameState` | `{ roomCode, gameId, state }` | Tras cada acción aceptada, cambio de turno, fin y reconexión |
| `server.tick` | `{ roomCode, gameId, turnPlayerId, turnNumber, remainingSeconds, timestamp }` | Cada segundo mientras `playing` |
| `server.actionRejected` | `{ code, message, playerId, turnNumber, warning, invalidTurnCount, ghosted }` | Acción de juego ilegal (move/wall) |
| `server.toast` | `{ level, code?, message, target? }` | Avisos informativos, advertencias AFK, expiraciones |
| `server.playerDisconnected` | `{ playerId, name, reason, ghost, timestamp }` | Cierre de socket, timeout, `leaveGame` o AFK |
| `server.playerReconnected` | `{ playerId, name, hostPlayerId, timestamp }` | Reconexión válida |
| `server.hostChanged` | `{ previousHostPlayerId, hostPlayerId, reason }` | Transferencia de host en lobby o al volver de partida |
| `server.matchSearching` | `{ position, queueSize, config }` | Entrada/actualización en cola |
| `server.matchFound` | `{ roomCode, gameId, playerIds, config }` | Grupo emparejado |
| `server.matchCancelled` | `{ queueSize }` | Cancelación de cola (extensión) |
| `server.gameOver` | `{ roomCode, gameId, winnerId, winnerName, reason, state }` | Fin de partida |
| `server.rematchLobby` | `{ roomCode, hostPlayerId, config, players, status }` | Transición de `finished` a `lobby` |
| `server.error` | `{ code, message, details? }` | Error de protocolo, sala, permisos o estado |
| `server.pong` | `{ t?, serverTime }` | Respuesta a `client.ping` |

Los mensajes `server.roomCreated`, `server.roomJoined`, `server.roomUpdate`, `server.rematchLobby` y `server.gameOver` incluyen el snapshot completo necesario para que el cliente no dependa de mensajes previos perdidos.

### 5.4 Tipos reutilizables

```text
Config = {
  size: integer 8..16,
  maxPlayers: integer 2..8,
  wallsPerPlayer: integer 0..20,
  spawnMode: "random" | "central" | "perimeter",
  turnSeconds: 30
}

RoomPlayer = {
  id: string,
  name: string,
  colorIndex: integer 0..19,
  isHost: boolean,
  connected: boolean,
  ghost: boolean
}

PublicGameState = ver §6
```

### 5.5 Ejemplos

**Crear sala**

```json
{
  "type": "client.createRoom",
  "requestId": "req-10",
  "payload": {
    "config": { "size": 12, "maxPlayers": 4, "wallsPerPlayer": 10, "spawnMode": "random" },
    "alias": "Ana"
  }
}
```

```json
{
  "type": "server.roomCreated",
  "requestId": "req-10",
  "payload": {
    "roomCode": "AB12CD",
    "hostPlayerId": "8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d",
    "config": { "size": 12, "maxPlayers": 4, "wallsPerPlayer": 10, "spawnMode": "random", "turnSeconds": 30 },
    "players": [
      { "id": "8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d", "name": "Ana", "colorIndex": 0, "isHost": true, "connected": true, "ghost": false }
    ],
    "status": "lobby",
    "createdAt": "2026-11-13T16:00:00.000Z",
    "updatedAt": "2026-11-13T16:00:00.000Z"
  }
}
```

**Unirse con código en minúsculas**

```json
{ "type": "client.joinRoom", "requestId": "req-11", "payload": { "code": "ab12cd", "alias": "Luis" } }
```

```json
{
  "type": "server.roomJoined",
  "requestId": "req-11",
  "payload": {
    "roomCode": "AB12CD",
    "hostPlayerId": "8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d",
    "config": { "size": 12, "maxPlayers": 4, "wallsPerPlayer": 10, "spawnMode": "random", "turnSeconds": 30 },
    "players": [
      { "id": "8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d", "name": "Ana", "colorIndex": 0, "isHost": true, "connected": true, "ghost": false },
      { "id": "2b7c9d10-3f4a-4b5c-8d6e-7f8091a2b3c4", "name": "Luis", "colorIndex": 1, "isHost": false, "connected": true, "ghost": false }
    ],
    "status": "lobby",
    "createdAt": "2026-11-13T16:00:00.000Z",
    "updatedAt": "2026-11-13T16:00:08.000Z"
  }
}
```

**Configuración rechazada por no ser host**

```json
{ "type": "client.updateConfig", "requestId": "req-12", "payload": { "config": { "size": 16 } } }
```

```json
{
  "type": "server.error",
  "requestId": "req-12",
  "payload": { "code": "NOT_HOST", "message": "Solo el host puede cambiar la configuración." }
}
```

Si el host la envía, se difunde `server.roomUpdate` con el snapshot completo del lobby y la nueva `config`.

**Inicio de partida y estado**

```json
{ "type": "client.startGame", "requestId": "req-13", "payload": {} }
```

```json
{
  "type": "server.gameStarted",
  "requestId": "req-13",
  "payload": {
    "roomCode": "AB12CD",
    "gameId": "5d0f1e2a-3b4c-4d5e-8f90-1a2b3c4d5e6f",
    "config": { "size": 16, "maxPlayers": 4, "wallsPerPlayer": 8, "spawnMode": "random", "turnSeconds": 30 },
    "state": { }
  }
}
```

`state` cumple exactamente el esquema de §6.

**Movimiento**

```json
{ "type": "client.move", "requestId": "req-14", "payload": { "to": { "x": 7, "y": 14 } } }
```

```json
{
  "type": "server.gameState",
  "payload": {
    "roomCode": "AB12CD",
    "gameId": "5d0f1e2a-3b4c-4d5e-8f90-1a2b3c4d5e6f",
    "state": { }
  }
}
```

**Pared rechazada con advertencia AFK**

```json
{ "type": "client.placeWall", "requestId": "req-15", "payload": { "orientation": "H", "x": 3, "y": 4 } }
```

```json
{
  "type": "server.actionRejected",
  "requestId": "req-15",
  "payload": {
    "code": "PATH_BLOCKED",
    "message": "La pared dejaría a un jugador sin camino a su meta.",
    "playerId": "2b7c9d10-3f4a-4b5c-8d6e-7f8091a2b3c4",
    "turnNumber": 7,
    "warning": true,
    "invalidTurnCount": 1,
    "ghosted": false
  }
}
```

En el segundo turno inválido acumulado se envía además `server.toast` y `server.playerDisconnected` con `reason:"afk"` (§8).

**Tick**

```json
{
  "type": "server.tick",
  "payload": {
    "roomCode": "AB12CD",
    "gameId": "5d0f1e2a-3b4c-4d5e-8f90-1a2b3c4d5e6f",
    "turnPlayerId": "2b7c9d10-3f4a-4b5c-8d6e-7f8091a2b3c4",
    "turnNumber": 7,
    "remainingSeconds": 23,
    "timestamp": "2026-11-13T16:01:07.000Z"
  }
}
```

**Matchmaking casual**

```json
{ "type": "client.quickPlay", "requestId": "req-20", "payload": {} }
```

```json
{
  "type": "server.matchSearching",
  "requestId": "req-20",
  "payload": {
    "position": 1,
    "queueSize": 1,
    "config": { "size": 12, "maxPlayers": 8, "wallsPerPlayer": 10, "spawnMode": "random", "turnSeconds": 30 }
  }
}
```

```json
{
  "type": "server.matchFound",
  "payload": {
    "roomCode": "K7M2PQ",
    "gameId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "playerIds": ["8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d", "2b7c9d10-3f4a-4b5c-8d6e-7f8091a2b3c4"],
    "config": { "size": 12, "maxPlayers": 8, "wallsPerPlayer": 10, "spawnMode": "random", "turnSeconds": 30 }
  }
}
```

**Desconexión, reconexión y revancha**

```json
{
  "type": "server.playerDisconnected",
  "payload": {
    "playerId": "2b7c9d10-3f4a-4b5c-8d6e-7f8091a2b3c4",
    "name": "Luis",
    "reason": "socket",
    "ghost": true,
    "timestamp": "2026-11-13T16:02:30.000Z"
  }
}
```

```json
{
  "type": "client.hello",
  "requestId": "req-30",
  "payload": {
    "playerId": "2b7c9d10-3f4a-4b5c-8d6e-7f8091a2b3c4",
    "sessionToken": "q7T3m9Kp2sV8xL1nR6wY4zB0cD5fH7jN"
  }
}
```

```json
{
  "type": "server.playerReconnected",
  "payload": {
    "playerId": "2b7c9d10-3f4a-4b5c-8d6e-7f8091a2b3c4",
    "name": "Luis",
    "hostPlayerId": "8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d",
    "timestamp": "2026-11-13T16:03:05.000Z"
  }
}
```

```json
{ "type": "client.rematch", "requestId": "req-40", "payload": {} }
```

```json
{
  "type": "server.rematchLobby",
  "requestId": "req-40",
  "payload": {
    "roomCode": "AB12CD",
    "hostPlayerId": "8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d",
    "config": { "size": 16, "maxPlayers": 4, "wallsPerPlayer": 8, "spawnMode": "random", "turnSeconds": 30 },
    "players": [
      { "id": "8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d", "name": "Ana", "colorIndex": 0, "isHost": true, "connected": true, "ghost": false },
      { "id": "2b7c9d10-3f4a-4b5c-8d6e-7f8091a2b3c4", "name": "Luis", "colorIndex": 1, "isHost": false, "connected": true, "ghost": false }
    ],
    "status": "lobby"
  }
}
```

**Ping y error**

```json
{ "type": "client.ping", "requestId": "req-50", "payload": { "t": 1763049600000 } }
```

```json
{ "type": "server.pong", "requestId": "req-50", "payload": { "t": 1763049600000, "serverTime": "2026-11-13T16:00:00.012Z" } }
```

```json
{
  "type": "server.error",
  "requestId": "req-51",
  "payload": {
    "code": "ROOM_FULL",
    "message": "La sala ya está completa.",
    "details": { "roomCode": "AB12CD", "maxPlayers": 4 }
  }
}
```

### 5.6 Códigos de error

| Código | Significado |
|---|---|
| `INVALID_PAYLOAD` | JSON o estructura de mensaje inválida. |
| `UNKNOWN_TYPE` | `type` no reconocido. |
| `MSG_TOO_LARGE` | Payload entre 8 KiB y 64 KiB; se descarta. |
| `RATE_LIMITED` | Se superó 40 mensajes/10 s. |
| `NOT_IDENTIFIED` | Acción antes de `client.hello`. |
| `ALREADY_IDENTIFIED` | Segundo `hello` en el mismo socket. |
| `SESSION_INVALID` | Token no coincide con el `playerId`; cierre 4001. |
| `INVALID_CODE` | Código de sala con formato inválido. |
| `ROOM_NOT_FOUND` | Sala inexistente o expirada. |
| `ROOM_FULL` | Sala en `maxPlayers`. |
| `ALREADY_IN_ROOM` | Ya está en una sala o en cola. |
| `NOT_IN_ROOM` | Acción de sala sin pertenecer a una. |
| `INVALID_ALIAS` | Alias vacío, demasiado largo o con caracteres prohibidos. |
| `INVALID_CONFIG` | Configuración fuera de rango o con campos inválidos. |
| `NOT_HOST` | Acción reservada al host. |
| `WRONG_STATE` | Mensaje no permitido en el estado actual de la sala. |
| `GAME_STARTED` | La partida ya empezó (o la sala está finalizada) y la acción requiere lobby. |
| `GAME_NOT_STARTED` | Acción de juego sin partida activa. |
| `GAME_ALREADY_FINISHED` | Acción de juego con partida finalizada. |
| `NOT_ENOUGH_PLAYERS` | Menos de 2 jugadores conectados no fantasmas. |
| `NOT_YOUR_TURN` | Acción de juego fuera de turno. |
| `PLAYER_GHOST` | Acción de un jugador fantasma. |
| `INVALID_MOVE` | Movimiento ilegal (no alcanzable, ocupado o fuera de tablero). |
| `CAMPING_FORCED_MOVE` | `client.move` con destino igual a la posición actual; no se permite pasar. |
| `INVALID_WALL` | Pared ilegal no cubierta por un código más específico. |
| `INVALID_ORIENTATION` | Orientación distinta de `H` o `V`. |
| `INVALID_COORDINATES` | Coordenadas no enteras o fuera del rango de anclas. |
| `WALL_OUT_OF_BOUNDS` | Pared sobre el borde o fuera del tablero. |
| `WALL_OVERLAP` | Pared de la misma orientación ya colocada en el mismo ancla. |
| `NO_WALLS_LEFT` | El jugador no tiene paredes restantes. |
| `PATH_BLOCKED` | La pared dejaría a algún jugador activo sin camino a su meta. |
| `REMATCH_NOT_AVAILABLE` | Revancha solicitada fuera de `finished`. |
| `QUEUE_FULL` | Cola casual llena. |
| `NOT_IN_QUEUE` | Cancelación sin estar en cola. |
| `ROOM_EXPIRED` | Sala expirada por inactividad; al intentar `joinRoom` se devuelve `server.error` con este código. |
| `ROOM_CODE_EXHAUSTED` | No se pudo generar un código único. |
| `INTERNAL_ERROR` | Error inesperado del servidor; no se muta el estado. |

---

## 6. Estado público de partida

### 6.1 Esquema exacto

`server.gameStarted` y `server.gameState` envían este objeto en `payload.state`:

```json
{
  "board": { "size": 16 },
  "players": [
    {
      "id": "8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d",
      "name": "Ana",
      "colorIndex": 0,
      "pos": { "x": 7, "y": 15 },
      "goal": { "side": "top", "index": 0 },
      "spawn": { "x": 7, "y": 15 },
      "wallsLeft": 7,
      "ghost": false,
      "connected": true,
      "isTurn": true
    },
    {
      "id": "2b7c9d10-3f4a-4b5c-8d6e-7f8091a2b3c4",
      "name": "Luis",
      "colorIndex": 1,
      "pos": { "x": 8, "y": 0 },
      "goal": { "side": "bottom", "index": 15 },
      "spawn": { "x": 8, "y": 0 },
      "wallsLeft": 8,
      "ghost": false,
      "connected": true,
      "isTurn": false
    }
  ],
  "walls": {
    "H": [{ "x": 3, "y": 4, "playerId": "8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d" }],
    "V": [{ "x": 5, "y": 8, "playerId": "2b7c9d10-3f4a-4b5c-8d6e-7f8091a2b3c4" }]
  },
  "turnPlayerId": "8f14e45f-ceea-4e7c-9a0e-6b1d2f3a4c5d",
  "remainingSeconds": 23,
  "turnNumber": 7,
  "status": "playing",
  "winnerId": null,
  "config": { "size": 16, "maxPlayers": 4, "wallsPerPlayer": 8, "spawnMode": "random", "turnSeconds": 30 }
}
```

### 6.2 Campos

| Campo | Tipo | Descripción |
|---|---|---|
| `board.size` | entero 8..16 | Tamaño del tablero cuadrado. |
| `players` | array | Todos los jugadores históricos de la partida, ordenados por `colorIndex`; incluye fantasmas. |
| `players[].id` | UUID | Identificador del jugador. |
| `players[].name` | string | Alias efectivo (con sufijo si hubo colisión). |
| `players[].colorIndex` | 0..19 | Asiento/color; congelado al iniciar. |
| `players[].pos` | `{x,y}` | Posición actual o última posición conocida si es fantasma. |
| `players[].goal` | `{side,index,x,y}` | Meta: lado (`top`/`bottom`/`left`/`right`) o `any` si es interior; `index` de fila/columna y coordenadas `x`/`y` de la celda. |
| `players[].spawn` | `{x,y}` | Celda de origen asignada por el motor. |
| `players[].wallsLeft` | entero | Paredes restantes. Los fantasmas conservan las ya colocadas y su contador. |
| `players[].ghost` | boolean | `true` si está desconectado, salió o fue marcado AFK. |
| `players[].connected` | boolean | `true` si hay socket activo. |
| `players[].isTurn` | boolean | `true` solo para el jugador del turno actual y activo. |
| `walls.H` | array de `{x,y,playerId}` | Anclas de paredes horizontales colocadas; `playerId` identifica al autor para colorearla. |
| `walls.V` | array de `{x,y,playerId}` | Anclas de paredes verticales colocadas; `playerId` identifica al autor para colorearla. |
| `turnPlayerId` | UUID \| null | Jugador del turno; `null` si `finished`. |
| `remainingSeconds` | entero 0..30 | Tiempo restante del turno, calculado en servidor. |
| `turnNumber` | entero ≥1 | Número de turno global; empieza en 1 y se incrementa al avanzar. |
| `status` | `playing` \| `finished` | Estado de la partida. |
| `winnerId` | UUID \| null | Ganador si `finished`; `null` si no hay ganador. |
| `config` | Config | Configuración efectiva de la partida. |

### 6.3 Coordenadas

- Origen `(0,0)` en la esquina superior izquierda.
- `x` = columna, `y` = fila, ambas 0..size-1.
- Pared horizontal `H` en ancla `(x,y)`: bloquea el paso entre `(x,y)` y `(x,y+1)`. Válida para `x` 0..size-2, `y` 0..size-2.
- Pared vertical `V` en ancla `(x,y)`: bloquea el paso entre `(x,y)` y `(x+1,y)`. Válida para `x` 0..size-2, `y` 0..size-2.
- Una `H` y una `V` en la misma ancla pueden cruzarse; solo se considera solapamiento si coinciden orientación y ancla.
- Meta: `top` = fila 0, `bottom` = fila size-1, `left` = columna 0, `right` = columna size-1. `index` repite el valor de fila/columna de la meta. Si la meta no está en un borde, `side = any`, `index = 0` y `x`/`y` identifican la celda interior.

### 6.4 Qué NO se envía

- `sessionToken`, tokens de sesión de cualquier jugador.
- Referencias a sockets, `connectionId` ajenos, IP, `User-Agent`.
- `invalidTurnCount`, `invalidCountedThisTurn`, `lastInvalidTurnNumber` y cualquier contador interno.
- Estado del rate limiter, timestamps internos de deadline absoluto, timers.
- Semilla del RNG, historial completo de movimientos, eventos de dominio internos.
- Identificadores internos de paredes, flags de sala, `lastActivityAt`, tokens de host.
- Cualquier dato que permita predecir el RNG o suplantar una sesión.

El cliente solo debe usar `remainingSeconds` como referencia visual; la autoridad temporal es el servidor.

---

## 7. Turnos y temporizador

### 7.1 Inicio y avance

- Al empezar la partida, el turno 1 corresponde al menor `colorIndex` activo.
- Al inicio de cada turno: `turnNumber` se incrementa (excepto el primero), se fija `turnDeadline = now + 30 000 ms`, se resetea `invalidCountedThisTurn` del jugador entrante y se arranca/renueva el timer.
- Un turno termina por acción válida, por timeout, por conversión del jugador en fantasma o por fin de partida.
- Cada acción válida avanza inmediatamente al siguiente jugador activo; no se espera al siguiente tick.
- El tick de 1 s se emite mientras `status === 'playing'` y contiene `turnPlayerId`, `turnNumber` y `remainingSeconds`.

### 7.2 Cálculo de tiempo

- `remainingSeconds = clamp(ceil((turnDeadline - Date.now()) / 1000), 0, 30)`.
- El deadline absoluto vive solo en el servidor.
- El tick se programa con corrección de deriva (no acumular `setInterval` sin control); a `remainingSeconds === 0` se procesa el timeout como máximo una vez.
- Un mensaje que llega después del deadline pero antes de que el servidor procese el timeout se trata así: primero se ejecuta el timeout (autoridad), después se evalúa el mensaje, que probablemente recibirá `NOT_YOUR_TURN`.
- Los timers se cancelan al cambiar de turno, al finalizar la partida, al borrar la sala y al apagar el servidor.

### 7.3 Timeout y movimiento automático

Al expirar el turno, el servidor actúa por el jugador:

1. Obtener movimientos legales simples ortogonales propios (adyacentes, sin herencia) del jugador actual.
2. Si hay al menos uno, elegir uno al azar de forma criptográfica y aplicarlo.
3. Si no hay simples, obtener cualquier movimiento legal (incluidos los heredados) y elegir uno al azar.
4. Si no hay ningún movimiento legal, pasar turno sin mover.
5. El servidor puede colocar paredes automáticamente solo si una regla futura lo define; en esta versión **nunca** coloca paredes por timeout.

Tras el auto-move o el pase:

- Se emite `server.toast` informativo con código `TURN_TIMEOUT` al jugador afectado y, opcionalmente, a la sala.
- Se difunde `server.gameState` con el estado resultante y el nuevo turno.
- El auto-move no cuenta como acción inválida AFK.

### 7.4 Turnos de fantasmas

- Si el siguiente jugador es fantasma, su turno se omite inmediatamente: no se esperan 30 s ni se emite tick con él como `turnPlayerId`.
- Se incrementa `turnNumber` y se avanza al siguiente activo.
- Si al avanzar no queda ningún jugador activo, se termina la partida (§9.7).
- La omisión de turnos de fantasmas no genera toasts repetitivos; como máximo un aviso agregado al detectar el fantasma.

### 7.5 Sincronización de reloj

- `server.welcome`, `server.tick` y `server.pong` incluyen hora del servidor (`serverTime`/`timestamp`).
- El cliente puede estimar el offset con `client.ping`/`server.pong` y mostrar una cuenta atrás suavizada.
- El cliente nunca decide el fin de turno ni envía acciones basándose en su propio reloj; si la cuenta local llega a 0, debe esperar el `server.gameState`/`server.tick` autoritativo.
- Diferencias de reloj, suspensión de pestaña o latencia no afectan al servidor: el deadline es monotónico respecto al reloj del servidor.

---

## 8. AFK y anti-griefing

### 8.1 Acciones inválidas contabilizadas

Se considera acción inválida contabilizable:

- `client.move` rechazado por el motor o por el servidor (fuera de turno, destino igual, movimiento ilegal, jugador fantasma ya no cuenta, etc.).
- `client.placeWall` rechazado (orientación, coordenadas, solapamiento, camino, sin paredes, fuera de turno).

No se contabilizan:

- Errores de sobre/protocolo (`INVALID_PAYLOAD`, `UNKNOWN_TYPE`, `MSG_TOO_LARGE`, `RATE_LIMITED`).
- Acciones de lobby (`updateConfig`, `startGame`, etc.).
- Mensajes de un jugador ya fantasma.
- Acciones válidas.

### 8.2 Contador exacto

- Cada jugador tiene `invalidTurnCount` acumulado durante la partida.
- Un `Set`/flag `invalidCountedThisTurn` evita contar más de una vez por jugador y `turnNumber` actual.
- La primera acción inválida en un turno incrementa `invalidTurnCount` en 1 y marca el turno como contabilizado.
- Acciones inválidas adicionales en el mismo `turnNumber` se rechazan pero **no** incrementan el contador.
- El contador no se reduce por acciones válidas ni por pasar de turno.
- Se reinicia a 0 al reconectar el jugador y al comenzar una revancha.

### 8.3 Efectos

| `invalidTurnCount` | Efecto |
|---:|---|
| 1 | `server.actionRejected` con `warning:true`, `invalidTurnCount:1`, `ghosted:false` + `server.toast` de advertencia al jugador. |
| 2 o más | El jugador pasa a fantasma inmediatamente: `ghost=true`, `connected=false`, cierre del socket con código `4003` (si existe), `server.playerDisconnected` con `reason:"afk"`, `server.toast` a toda la sala y `server.gameState`. Se resetea su contador a 0 tras la conversión. |

La conversión a fantasma por AFK sigue exactamente las reglas de §9: paredes permanentes, celda transitable, turnos omitidos, posible fin de partida y reconexión permitida con el mismo token. Al reconectar se limpia `ghost`, `connected=true` y `invalidTurnCount=0`.

---

## 9. Desconexiones, reconexión y fantasmas

### 9.1 Detección

Se marca al jugador como fantasma inmediatamente (gracia 0 s) cuando:

- Se cierra el socket durante `playing`.
- Expira el heartbeat (45 s sin actividad) durante `playing`.
- El jugador envía `client.leaveGame` durante `playing`.
- El jugador alcanza el segundo turno inválido (AFK).

En `lobby`, el cierre de socket elimina al jugador de la sala (no hay fantasmas en lobby). En `finished`, el cierre se trata igual que en `playing` a efectos de reconexión, pero los fantasmas se eliminan al solicitar revancha.

### 9.2 Efecto del fantasma

- `ghost=true`, `connected=false`.
- La ficha se desvanece visualmente en el cliente.
- Sus paredes ya colocadas permanecen para siempre; no se retiran.
- Su celda es **transitable**: no bloquea el paso ni cuenta como ocupada para movimientos.
- El fantasma no transmite movimientos a sus vecinos; simplemente se entra en su celda como celda libre.
- Sus turnos se omiten automáticamente (§7.4).
- Conserva `wallsLeft`, `colorIndex`, posición histórica y alias.
- Si era el host, conserva el rol durante la partida; no se transfiere hasta volver a lobby.
- No puede actuar (`move`/`placeWall` → `PLAYER_GHOST`), pero puede reconectar.

### 9.3 Paredes y camino

- Las paredes del fantasma siguen afectando a todos los jugadores activos.
- La validación `PATH_BLOCKED` solo exige camino para jugadores activos (`connected && !ghost`). Al convertir a un jugador en fantasma, no es necesario recalcular caminos para él.
- Si al reconectar vuelve a estar activo, el estado actual del tablero debe ofrecerle un camino; si no lo hubiera por una colocación posterior, el servidor debe haber impedido esa colocación en su momento. En caso defensivo, el motor puede rechazar la reincorporación y devolver `PATH_BLOCKED`, tratándose como error interno controlado.

### 9.4 Reconexión

1. `client.hello` con el mismo `playerId` y `sessionToken`.
2. Validar que la sala sigue existiendo y que el jugador pertenece a ella.
3. Rebindear el socket, marcar `connected=true`, `ghost=false`, resetear contadores AFK.
4. Resolver posición si la celda histórica está ocupada por un jugador activo:
   - Intentar la celda libre más cercana en dirección a su meta.
   - Si no hay, usar su `spawn` si está libre.
   - Si tampoco, la primera celda libre en orden determinista (BFS desde la posición histórica).
5. Enviar `server.welcome` con `resumed:true`, seguido del snapshot completo (`server.gameState` si `playing`/`finished`, `server.roomUpdate` si `lobby`).
6. Difundir `server.playerReconnected` y, si cambió algo, `server.gameState` o `server.roomUpdate`.

La reconexión no consume un turno ni reinicia el temporizador. Si el jugador reconecta durante su propio turno y el salto por fantasma aún no se ha procesado, se cancela el salto y conserva el tiempo restante. Si el turno ya fue omitido, no lo recupera; participará en su siguiente turno.

### 9.5 Salida voluntaria

- `client.leaveGame` durante `playing`: convierte en fantasma y deja el socket abierto.
- El jugador sigue asociado a la sala como fantasma y no puede unirse a otra sala hasta que la partida termine y la revancha lo elimine o haga `leaveRoom` en `finished`.
- Puede reconectar con `hello` mientras la sala exista.
- En `finished`, `client.leaveRoom` elimina al jugador definitivamente.

### 9.6 Host

- En lobby, al desconectarse o salir el host, se transfiere al conectado con menor `colorIndex` y se difunde `server.hostChanged`.
- Si no queda nadie, se borra la sala.
- Durante la partida, el host fantasma conserva el rol; no hay acciones exclusivas de host en `playing`.
- Al volver a lobby por revancha, si el host sigue fantasma/desconectado se elimina y se asigna host al menor `colorIndex` conectado.

### 9.7 Fin por inactividad de jugadores

- Si tras una desconexión o salida queda exactamente 1 jugador activo, ese jugador gana y la partida termina inmediatamente (`reason:"last_active"`).
- Si quedan 0 activos, la partida termina sin ganador (`winnerId:null`, `reason:"no_active"`).
- Los fantasmas no impiden el fin de partida; no se les puede declarar ganadores.
- El estado final se difunde a todos los sockets conectados y se conserva para la revancha.

### 9.8 Casos límite

- Token incorrecto → `SESSION_INVALID`, cierre 4001; no se filtra si el `playerId` existe.
- Sala eliminada → `server.welcome` con `resumed:false`; cualquier acción posterior de sala dará `ROOM_NOT_FOUND`.
- Doble socket con el mismo `playerId`: gana el más reciente; el anterior se cierra con `1000` o `4001` y se trata como reemplazo, no como fantasma.
- Reconexión después de `gameOver` en `finished`: permitida; el jugador recibe el estado final y puede solicitar revancha si está conectado.
- Cierre del servidor: se notifica `1001`, se cancelan timers y no se persiste nada.

## 10. Rematch y fin de partida

### 10.1 Fin de partida

La partida termina cuando:

- Un jugador activo alcanza su meta → gana (`reason:"goal"`).
- Solo queda un jugador activo tras desconexiones, salidas o AFK → gana (`reason:"last_active"`).
- No queda ningún jugador activo → `winnerId:null` (`reason:"no_active"`).

Al terminar:

1. Se cancela el timer de turno y el tick.
2. `status = 'finished'`, `turnPlayerId = null`, `remainingSeconds = 0`, `isTurn=false` para todos.
3. Se difunde `server.gameOver` con el estado final completo.
4. La sala permanece en memoria para permitir reconexiones y revancha.
5. Si no hay ningún socket conectado, se programa el borrado según §2.7.

### 10.2 Solicitud de revancha

- `client.rematch` es válido en `finished` para cualquier jugador conectado, no solo el host.
- Es idempotente durante la transición: varias solicitudes simultáneas producen una sola transición.
- Si la sala ya volvió a `lobby` pero aún no empezó una nueva partida, se responde con el snapshot actual `server.rematchLobby` (no se duplica el reset).
- Si ya hay una partida nueva en curso → `REMATCH_NOT_AVAILABLE`.
- Un fantasma/desconectado no puede solicitar revancha (no tiene socket).

### 10.3 Transición a lobby

En la primera solicitud válida:

1. Se eliminan todos los jugadores con `ghost=true` o `connected=false`.
2. Se cancelan timers y se descarta el motor anterior.
3. Se resetean contadores AFK y `winnerId`.
4. `status = 'lobby'`; se conserva la `config` actual (no se restablecen defaults).
5. Se conservan los `colorIndex` de los jugadores que quedan; los asientos liberados pueden reutilizarse en futuras uniones.
6. Si el host fue eliminado, se asigna host al conectado con menor `colorIndex`.
7. Se conserva el mismo `roomCode` salvo colisión o recreación; si cambia, se informa en el payload.
8. Se difunde `server.rematchLobby` con el snapshot completo del lobby.
9. Se requiere `client.startGame` de nuevo y al menos 2 jugadores conectados. La revancha no auto-inicia.

Si tras eliminar fantasmas quedan menos de 2 jugadores, la sala sigue en lobby esperando nuevas uniones. Si no queda ninguno, se borra la sala.

### 10.4 Configuración y código en revancha

- Se mantiene la configuración vigente de la partida, incluido `maxPlayers`. Si al eliminar fantasmas el número de jugadores queda por debajo de 2, no se altera la config.
- El host puede editarla o restablecerla ya en lobby con las reglas de §3.7.
- El código se conserva para que los jugadores puedan volver a compartirlo; si por alguna razón ya no es único, se genera uno nuevo y `server.rematchLobby` lo comunica.

---

## 11. Seguridad y robustez

### 11.1 Validación

- Validar tipo, estructura, longitudes, rangos y pertenencia antes de tocar estado.
- Rechazar `__proto__`, `prototype` y `constructor` en objetos de configuración y payloads para evitar prototype pollution.
- No usar `eval`, `Function` ni deserialización distinta de `JSON.parse`.
- Usar comparación de tokens en tiempo constante cuando sea posible.
- No confiar en el orden, temporización ni unicidad de mensajes del cliente.
- Validar de nuevo el estado en el momento de aplicar la acción; el estado puede haber cambiado entre mensajes.

### 11.2 Rate limiting y tamaño

- Token bucket por socket: capacidad 40, recarga 4 mensajes/s (ventana equivalente de 10 s).
- Al superar 40/10 s: `server.error` `RATE_LIMITED`, se descarta el mensaje y no se procesa.
- Al superar 60 mensajes/10 s o 5 violaciones en la ventana: cierre `1008`.
- Handshake: máximo 5 `client.hello` por IP y 10 s; exceso → cierre `1008`.
- Conexiones concurrentes por IP: 20 por defecto.
- Frame > 8 KiB → `MSG_TOO_LARGE`; > 64 KiB → cierre `1009`.
- Los límites de sala, jugadores y cola se comprueban antes de crear estructuras.

### 11.3 Sanitización de alias

- `trim`, normalización NFC y validación de longitud 1..20 code points.
- Rechazo de caracteres de control, saltos de línea y tabs.
- No se interpreta HTML ni Markdown en el servidor; el cliente renderiza con `textContent`.
- El sufijo de colisión se aplica después de la sanitización y respetando el límite de 20.
- Los alias no se usan como claves internas; las claves son `playerId`.

### 11.4 Prevención por estado

| Mensaje | Estados permitidos |
|---|---|
| `client.createRoom`, `client.joinRoom`, `client.quickPlay` | `IDENTIFIED`, sin sala ni cola |
| `client.updateConfig`, `client.resetConfig`, `client.startGame` | `lobby` + host |
| `client.leaveRoom` | `lobby` o `finished` |
| `client.move`, `client.placeWall`, `client.leaveGame` | `playing` + jugador activo |
| `client.rematch` | `finished` + conectado |
| `client.cancelQuickPlay` | `IN_QUEUE` |
| `client.ping` | Cualquiera |

Cualquier combinación fuera de tabla devuelve `WRONG_STATE`, `GAME_STARTED`, `GAME_NOT_STARTED`, `GAME_ALREADY_FINISHED` o `REMATCH_NOT_AVAILABLE` según corresponda, sin mutar estado.

En particular, una acción de partida (`client.move`, `client.placeWall` o `client.leaveGame`) recibida durante la fase `lobby`, o una acción de lobby (`client.updateConfig`, `client.resetConfig` o `client.startGame`) recibida durante la fase `playing`, debe responder con `WRONG_STATE`.

### 11.5 Aislamiento de errores

- Cada mensaje se procesa dentro de `try/catch`; un fallo inesperado se registra con `requestId`, `playerId` y tipo, y responde `INTERNAL_ERROR`.
- Los callbacks de timers también se envuelven; un error en un turno no debe detener el bucle de la sala ni el proceso.
- Se instalan manejadores de `uncaughtException` y `unhandledRejection` que registran y mantienen el servicio en la medida de lo posible; si el estado es irrecuperable, se hace cierre ordenado.
- Nunca se envían stacks ni rutas internas al cliente.
- Un mensaje inválido no cierra la conexión salvo abuso reiterado, frame excesivo, fallo de autenticación o rate limit grave.

### 11.6 Cierre limpio

- `SIGINT`/`SIGTERM`: dejar de aceptar conexiones, enviar `server.toast`/`server.error` y cerrar sockets con `1001`, cancelar todos los timers, vaciar salas y salir con código 0.
- Al borrar una sala: cancelar `turnTimer`, `tickTimer` y `cleanupTimer`, cerrar sockets asociados si procede y eliminar tokens del registro.
- Al cerrar un socket: eliminar listeners, desasociar del contexto y aplicar la transición de lobby o fantasma una sola vez (idempotente).

### 11.7 Límites de confianza y privacidad

- El servidor no revela si un `playerId` existe cuando el token es incorrecto.
- No se envían tokens, IPs ni identificadores de conexión a otros jugadores.
- No se registran tokens en logs; si se registra `playerId`, que sea truncado o hasheado.
- Los mensajes de error no incluyen datos de otros jugadores salvo los públicos (alias, asiento).
- El estado público se construye por lista blanca de campos, nunca por eliminación de campos internos.

---

## 12. Diagramas y pruebas de integración

### 12.1 Crear, unirse y empezar

```text
A (host)             Servidor                 B
   |--hello------------>|                      |
   |<--welcome----------|                      |
   |--createRoom------->|                      |
   |<--roomCreated------|                      |
   |                    |<-------hello---------|
   |                    |-------welcome------->|
   |                    |<-------joinRoom------|
   |<--roomUpdate-------|-------roomJoined---->|
   |--updateConfig----->|                      |
   |<--roomUpdate-------|-------roomUpdate---->|
   |--startGame-------->|                      |
   |<--gameStarted------|-------gameStarted--->|
   |<--tick-------------|-------tick---------->|
```

### 12.2 Turno, tick y timeout

```text
A (turno)            Servidor                 B
   |--move------------->|                      |
   |<--gameState--------|-------gameState----->|
   |<--tick 30----------|-------tick 30------->|
   |                    |  [30 s sin acción de B]
   |<--tick 0-----------|-------tick 0-------->|
   |                    |  [auto-move de B]    |
   |<--gameState--------|-------gameState----->|
   |<--tick 30----------|-------tick 30------->|
```

### 12.3 Desconexión y reconexión

```text
A                    Servidor                 B
   |---socket close---->|                      |
   |                    | [A fantasma; paredes permanecen]
   |                    |------playerDisconnected----->|
   |                    |------toast----------------->|
   |                    | [turnos de A omitidos]      |
   |--hello(id+token)--->|                      |
   |<--welcome resumed---|                      |
   |<--gameState---------|------playerReconnected---->|
```

### 12.4 Revancha

```text
A / B                Servidor
   |--rematch----------->|
   |                     | [elimina fantasmas; status=lobby;
   |                     |  conserva config y conectados]
   |<--rematchLobby------|------rematchLobby----> (todos)
   |--startGame--------->|
   |<--gameStarted-------|------gameStarted-----> (todos)
```

### 12.5 Pruebas de integración con dos clientes WS

| ID | Objetivo | Precondiciones y pasos | Resultado esperado |
|---|---|---|---|
| T01 | Crear y unirse con código en minúsculas | A crea sala; B se une con `code` en minúsculas | B recibe `roomJoined`; `roomCode` normalizado; ambos ven 2 jugadores |
| T02 | Código inexistente | B intenta unirse a `ZZZZZZ` | `server.error` `ROOM_NOT_FOUND`; sin cambios |
| T03 | Sala llena | `maxPlayers:2`; A y B dentro; C intenta unirse | C recibe `ROOM_FULL`; A/B no cambian |
| T04 | Alias duplicado | Dos clientes usan `"Ana"` en la misma sala | El segundo recibe `name` `"Ana (2)"`; único |
| T05 | Config solo host | B (no host) envía `updateConfig` | `NOT_HOST`; config intacta |
| T06 | Config inválida | Host envía `size:7`, luego `maxPlayers:1` con 2 jugadores | `INVALID_CONFIG` en ambos; sin cambios |
| T07 | Inicio con pocos jugadores | Solo A en lobby; `startGame` | `NOT_ENOUGH_PLAYERS`; sigue lobby |
| T08 | Inicio válido | A y B en lobby; host inicia | Ambos reciben `gameStarted`; turno del menor `colorIndex`; tick activo |
| T09 | Acción fuera de turno | A mueve cuando el turno es de B | `actionRejected` `NOT_YOUR_TURN`; estado intacto |
| T10 | Pared solapada y fuera de rango | Colocar misma `H` dos veces; colocar `x=size-1` | `WALL_OVERLAP` y `WALL_OUT_OF_BOUNDS`; estado intacto |
| T11 | Pared bloquea camino | Colocar pared que encierra a un jugador activo | `actionRejected` `PATH_BLOCKED`; pared no añadida |
| T12 | Sin paredes | `wallsPerPlayer:0`; intentar `placeWall` | `NO_WALLS_LEFT`; turno continúa |
| T13 | Timeout y auto-move | A no actúa durante 30 s | Ticks llegan a 0; servidor auto-mueve a A; nuevo `gameState`; sigue el turno |
| T14 | AFK primer y segundo turno inválido | A hace un movimiento ilegal en dos turnos distintos | Primero: `warning:true` + toast; segundo: A fantasma, `playerDisconnected`, cierre 4003 |
| T15 | Desconexión en partida | B cierra socket en su turno | B fantasma; paredes permanecen; su turno se omite; A recibe estado actualizado |
| T16 | Reconexión | B reconecta con mismo `playerId`/token | `welcome resumed:true`, `playerReconnected`, B vuelve a jugar en su siguiente turno |
| T17 | Host sale en lobby | Host cierra socket en lobby | Se transfiere host al siguiente conectado; `hostChanged`; jugador eliminado |
| T18 | Revancha | Partida termina; A envía `rematch` | Fantasmas eliminados; `rematchLobby`; A y B conservan config y asientos; deben reiniciar |
| T19 | Quick match y cancelación | A y B en cola; C entra y cancela | A/B reciben `matchFound` y `gameStarted`; C recibe `matchCancelled` |
| T20 | Rate limit | Un cliente envía más de 40 mensajes en 10 s | `RATE_LIMITED`; mensajes descartados; abuso grave cierra 1008 |
| T21 | Fin por último activo | B se desconecta cuando solo quedan A y B | `gameOver` con `winnerId` de A y `reason:"last_active"` |
| T22 | Salir en partida | A envía `leaveGame` | A fantasma; no puede `move`; puede reconectar; no puede unirse a otra sala |

Las pruebas deben automatizarse con dos o más clientes `ws` reales contra un servidor efímero en puerto aleatorio, usando `requestId` para correlacionar respuestas y esperando eventos con timeout. Para los tests de timeout, inyectar un reloj/funciones de timer falsas o configurar una duración de turno de prueba solo en el entorno de test, sin cambiar el valor de producción.

---

## 13. Contrato de integración con el motor

### 13.1 Principios

- `src/core` es puro, determinista y sin I/O, red, timers ni conocimiento de sockets.
- El servidor (`Room.js`) es el dueño de la sesión, los timers, el AFK, los fantasmas, la reconexión, el estado de sala y la revancha.
- El motor es el dueño de las reglas: tablero, movimientos propios y heredados, paredes, caminos, metas, turno y ganador.
- El servidor nunca implementa reglas duplicadas; el motor nunca envía mensajes ni muta el estado de sala.

### 13.2 API real del motor

```text
GameEngine.create(config, playersInput, spawnResult, seed = 0) -> engine
new GameEngine(state)
engine.getState() -> copia del estado interno
engine.getPublicState(viewerId = null) -> estado público sin seed
engine.getPlayer(playerId) -> jugador | null
engine.isFinished() -> boolean
engine.getWinner() -> winnerId | null
engine.getLegalMoves(playerId, options = {}) -> movimientos legales
engine.getLegalWallPlacements(playerId) -> paredes legales
engine.wallError(wall) -> código de error | null
engine.move(playerId, destination) -> ActionResult
engine.stayInCamping(player) -> ActionResult
engine.applyMove(player, move) -> eventos
engine.placeWall(playerId, orientation, x, y) -> ActionResult
engine.autoMove(playerId, rng = Math.random) -> ActionResult
engine.setGhost(playerId, ghost) -> ActionResult
engine.findReachableFreeCell(goal, occupied) -> celda | null
engine.advanceTurn(events) -> void
engine.finish(winnerId, events = []) -> void
engine.getDistances() -> array

createGame(config, players, spawnResult, seed = 0) -> engine
getTurnState(engine, playerId) -> { turnPlayerId, turnNumber, legalMoves, legalSimpleMoves, legalWalls }
```

`ActionResult`:

```text
{
  ok: boolean,
  error?: string,              // código del motor, mapeable a §5.6
  state?: InternalState,
  events: DomainEvent[],
  finished?: boolean,
  winnerId?: string | null
}
```

El servidor puede añadir `name` a los jugadores del estado público después de `getPublicState()`, porque el motor solo conoce `id` y `colorIndex`. El alias es metadato de sala.

### 13.3 Eventos de dominio

| Evento | Payload | Uso en el servidor |
|---|---|---|
| `game.started` | `{ gameId, turnPlayerId, turnNumber }` | Arrancar timers y emitir `gameStarted` |
| `turn.started` | `{ playerId, turnNumber, deadline? }` | Renovar timer y difundir tick |
| `piece.moved` | `{ playerId, from, to, jump? }` | Actualizar estado y broadcast |
| `wall.placed` | `{ playerId, orientation, x, y, wallsLeft }` | Actualizar estado y broadcast |
| `action.rejected` | `{ playerId, code, details? }` | Mapear a `actionRejected` y contar AFK |
| `turn.timeout` | `{ playerId, turnNumber }` | Aplicar auto-move/pase y broadcast |
| `player.reachedGoal` | `{ playerId }` | Preparar `gameOver` |
| `game.finished` | `{ winnerId, reason }` | Detener timers, emitir `gameOver` |
| `ghost.updated` | `{ playerId, ghost }` | Actualizar transitabilidad/estado |
| `player.reconnected` | `{ playerId, pos }` | Reinsertar ficha y broadcast |

El servidor puede ignorar eventos que ya haya provocado directamente, pero debe mantener el orden: acción → eventos → serialización → broadcast.

### 13.4 Mapeo de errores del motor

| Error del motor | Código de protocolo |
|---|---|
| `NOT_YOUR_TURN` | `NOT_YOUR_TURN` |
| `GAME_NOT_STARTED` | `GAME_NOT_STARTED` |
| `GAME_ALREADY_FINISHED` | `GAME_ALREADY_FINISHED` |
| `INVALID_MOVE` | `INVALID_MOVE` |
| `CAMPING_FORCED_MOVE` | `CAMPING_FORCED_MOVE` |
| `INVALID_WALL` | `INVALID_WALL` |
| `INVALID_ORIENTATION` | `INVALID_ORIENTATION` |
| `INVALID_COORDINATES` | `INVALID_COORDINATES` |
| `WALL_OUT_OF_BOUNDS` | `WALL_OUT_OF_BOUNDS` |
| `WALL_OVERLAP` | `WALL_OVERLAP` |
| `NO_WALLS_LEFT` | `NO_WALLS_LEFT` |
| `PATH_BLOCKED` | `PATH_BLOCKED` |
| `PLAYER_GHOST` | `PLAYER_GHOST` |
| Desconocido | `INTERNAL_ERROR` |

El motor nunca debe lanzar excepciones por acciones ilegales; devuelve `ok:false` con `error`. Las excepciones inesperadas se capturan en el servidor y se traducen a `INTERNAL_ERROR` sin mutar estado.

### 13.5 Flujo de una acción en el servidor

1. Validar sobre, tamaño, rate limit y `type` (`protocol.js`).
2. Resolver socket → `playerId` → sala (`RoomManager`).
3. Validar estado de sala, pertenencia, turno y que el jugador no es fantasma.
4. Llamar al motor (`engine.move` o `engine.placeWall`).
5. Si `ok:false`: mapear error, contar AFK si aplica y responder `actionRejected`.
6. Si `ok:true`: actualizar deadline/turno con los eventos, comprobar fin, difundir `gameState` y `tick`.
7. Si hay ganador: detener timers, `status='finished'`, difundir `gameOver`.
8. Cualquier excepción: `INTERNAL_ERROR`, log y estado intacto.

### 13.6 Ghosts, spawns y metas

- `setGhost(playerId, true)` debe hacer la celda transitable y excluir al jugador del bloqueo de ocupación y de los requisitos de camino.
- `setGhost(playerId, false)` debe reinsertar la ficha; si la celda está ocupada, el servidor puede pedir al motor una celda libre determinista o resolverlo antes de llamar.
- `spawnMode` y la asignación de spawns/metas son responsabilidad del motor, usando `colorIndex` y `config`; deben ser deterministas con la semilla inyectada.
- Los fantasmas conservan `wallsLeft` y sus paredes; no se eliminan del estado público.
- `getLegalMoves(playerId, {simple:true})` se usa para el auto-move por timeout; `getLegalMoves` sin opciones incluye los movimientos heredados.
- El motor debe exponer `goal` en el estado público según §6 para que el cliente pueda renderizar la meta sin duplicar reglas.

### 13.7 Rematch

- La revancha crea una instancia nueva de `GameEngine` con la configuración vigente y los jugadores conectados que quedan.
- No se reutiliza el estado interno del motor anterior.
- El servidor conserva `roomCode`, configuración y asientos; el motor recibe de nuevo `players` con `id` y `colorIndex`.
- El nuevo `gameId` y la nueva semilla se generan al iniciar la nueva partida.

### 13.8 Pruebas del contrato

- El motor debe poder probarse sin red: crear partida, mover, colocar paredes, timeout simulado, fantasmas y fin.
- Las pruebas del servidor pueden usar un motor real o un doble controlado; el contrato es el mismo.
- Cualquier cambio en `PublicGameState` o en los códigos de error debe actualizar este documento y las pruebas de integración (§12.5).

---

**Fin del documento.**

