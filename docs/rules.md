# Reglas del motor de Quoridor (2–8 jugadores)

> Documento normativo y autosuficiente. Describe el **motor puro** (sin red, sin timers,
> sin sockets) de una variante de Quoridor para 2 a 8 jugadores sobre tableros de 8x8 a 20x20.
> Los identificadores de código están en inglés; la prosa, en español. Cualquier implementación
> que cumpla este contrato debe producir exactamente los mismos estados, eventos y errores.

Este contrato es la fuente de verdad de la lógica de juego. Los documentos
[`docs/network.md`](./network.md), [`docs/spawns.md`](./spawns.md) y [`docs/ui.md`](./ui.md)
describen transporte, generación de posiciones iniciales y presentación; **no** duplican las
reglas aquí definidas.

## Índice

1. [Alcance, terminología, coordenadas y configuración](#1-alcance-terminología-coordenadas-y-configuración)
2. [Estado serializable `GameState` y `PublicGameState`](#2-estado-serializable-gamestate-y-publicgamestate)
3. [Turnos y acciones](#3-turnos-y-acciones)
4. [Movimiento ortogonal](#4-movimiento-ortogonal)
5. [Saltos](#5-saltos)
6. [Metas y camping](#6-metas-y-camping)
7. [Paredes](#7-paredes)
8. [Pathfinding](#8-pathfinding)
9. [Auto-move y timeout](#9-auto-move-y-timeout)
10. [Fin y rematch](#10-fin-y-rematch)
11. [API del motor](#11-api-del-motor)
12. [Matriz de pruebas](#12-matriz-de-pruebas)
13. [Glosario y referencias](#13-glosario-y-referencias)

### Decisiones canónicas (v1)

Resumen para los subagentes de código. Ante cualquier discrepancia, prevalece la sección
correspondiente de este documento.

| Decisión | Valor canónico | Referencia |
|---|---|---|
| `size` | entero `8 .. 20` (default `9`) | §1.3, §1.5 |
| `playerCount` | entero `2 .. 8` (default `2`) | §1.5 |
| `wallsPerPlayer` | `10` por defecto | §1.5 |
| `turnSeconds` | entero fijo `30`; otro valor => `INVALID_CONFIG` | §1.5, §9 |
| `spawnMode` | `'random' \| 'central' \| 'perimeter'` | §1.5, [`spawns.md`](./spawns.md) |
| `WALL_CROSS` | H y V con **mismo ancla** `(x, y)`; tabla de colisiones canónica | §7.3 |
| Fantasma | transitable y excluido del anti-encierro; también lo está `connected === false` | §1.2, §7.4 |
| Meta | distancia Manhattan `round(0.6 * size)`, clamp `2 .. 2*(size-1)` | [`spawns.md`](./spawns.md) |
| Pathfinding | **BFS obligatorio** para validar caminos; resultado booleano | §8.1 |

---

## 1. Alcance, terminología, coordenadas y configuración

### 1.1 Alcance

El motor **no** conoce sockets, temporizadores, reconexiones ni persistencia. Recibe acciones
puras y devuelve un nuevo estado (o el mismo estado con eventos). El temporizador de turno
(`turnSeconds`) es un dato de configuración que el servidor usa, pero **el motor nunca cuenta
tiempo**: no hay timers dentro del motor. El tiempo se resuelve llamando a `autoMove` desde
fuera (ver §9).

### 1.2 Terminología

| Término | Definición |
|---|---|
| `size` | Lado del tablero. Hay `size × size` celdas. |
| Celda | Posición de una ficha. Se indexa `(r, c)`, fila `r` y columna `c`, ambas 0-indexadas. |
| Intersección | Esquina de la cuadrícula donde pueden anclarse paredes. Se indexa `(x, y)` con `x = columna`, `y = fila`. |
| Pared | Segmento de longitud 2 que bloquea dos aristas ortogonales. Tiene orientación `H` o `V`. |
| Ficha activa | Jugador conectado y no fantasma (`ghost === false` y `connected === true`). |
| Fantasma | Ficha desconectada. Es **transitable** y no bloquea movimientos ni pathfinding. |
| Goal (meta) | Celda objetivo propia de cada jugador. Alcanzarla gana. |
| Camping | Situación de un jugador que está sobre la meta de otro jugador. |
| Arista | Borde entre dos celdas ortogonalmente adyacentes. Puede estar bloqueada por una pared. |
| Adyacencia | Dos celdas son adyacentes si difieren en exactamente una unidad en una sola coordenada. |
| Distancia Manhattan | `abs(r1 - r2) + abs(c1 - c2)`. |

### 1.3 Sistema de coordenadas

- Celdas: `(r, c)` con `0 <= r < size` y `0 <= c < size`.
- Intersecciones (anclas de pared): `(x, y)` con `0 <= x < size - 1` y `0 <= y < size - 1`.
  `x` es la **columna** e `y` es la **fila**.
- `size = 9` es el valor por defecto, equivalente al Quoridor clásico 9x9 (8x8 huecos internos).
- Los cuatro vecinos ortogonales de `(r, c)` son:
  - Norte: `(r - 1, c)`
  - Sur: `(r + 1, c)`
  - Oeste: `(r, c - 1)`
  - Este: `(r, c + 1)`

```text
Vista esquematica (size = 4). Las "o" son intersecciones; las cajas son celdas.

        x=0     x=1     x=2
   y=0  o-------o-------o-------o
        | (0,0) | (0,1) | (0,2) |
   y=1  o-------o-------o-------o
        | (1,0) | (1,1) | (1,2) |
   y=2  o-------o-------o-------o
        | (2,0) | (2,1) | (2,2) |
        +-------+-------+-------+
```

### 1.4 Convención de paredes (H y V)

Una pared bloquea **exactamente dos aristas** ortogonales contiguas. Se ancla en una
intersección `(x, y)` y su orientación decide qué par de aristas bloquea.

**Convención adoptada (recomendada y usada en todo el motor):**

| Pared | Bloquea la arista entre | Y la arista entre |
|---|---|---|
| `H(x, y)` | `(y, x)` – `(y + 1, x)` | `(y, x + 1)` – `(y + 1, x + 1)` |
| `V(x, y)` | `(y, x)` – `(y, x + 1)` | `(y + 1, x)` – `(y + 1, x + 1)` |

Es decir:

- Una pared **H** (horizontal) separa la fila `y` de la fila `y + 1` en las columnas `x` y `x + 1`.
  Bloquea movimiento **Norte↔Sur**.
- Una pared **V** (vertical) separa la columna `x` de la columna `x + 1` en las filas `y` e `y + 1`.
  Bloquea movimiento **Este↔Oeste**.

**Justificación.** Con esta convención, el ancla `(x, y)` corresponde a la esquina superior
izquierda del bloque de 2x2 celdas `{(y,x), (y,x+1), (y+1,x), (y+1,x+1)}`. H bloquea el par de
aristas inferiores del bloque y V bloquea el par de aristas derechas del bloque. Esto produce una
regla de colisión limpia y determinista (ver §7.3) y hace que las dos aristas de una pared sean
siempre contiguas y colineales, formando un segmento recto de longitud 2.

**Notación de aristas.** Para razonar sin ambigüedad definimos dos tipos de arista:

- `NSEdge(r, c)`: arista entre `(r, c)` y `(r + 1, c)` (movimiento vertical). Bloqueada por una H.
- `EWEdge(r, c)`: arista entre `(r, c)` y `(r, c + 1)` (movimiento horizontal). Bloqueada por una V.

```text
Figura: H(0,1) y V(1,0) en un tablero size = 4.
"==" arista bloqueada por H, "|" arista bloqueada por V.

        x=0     x=1     x=2
   y=0  o-------o-------o-------o
        | (0,0) | (0,1) | (0,2) |
   y=1  o=======o=======o-------o   <- H(0,1): bloquea (1,0)-(2,0) y (1,1)-(2,1)
        | (1,0) | (1,1) | (1,2) |
   y=2  o---|--+o-------+-------o   <- V(1,0): bloquea (0,1)-(0,2) y (1,1)-(1,2)
        | (2,0) | (2,1) | (2,2) |
        +-------+-------+-------+
```

**Ejemplos de `blocksEdge`:**

- `H(0, 1)` bloquea `NSEdge(1, 0)` y `NSEdge(1, 1)`.
- `V(1, 0)` bloquea `EWEdge(0, 1)` y `EWEdge(1, 1)`.
- Una ficha en `(1, 0)` **no** puede ir a `(2, 0)` si existe `H(0, 1)`, porque `NSEdge(1, 0)`
  está bloqueada.
- Una ficha en `(0, 1)` **no** puede ir a `(0, 2)` si existe `V(1, 0)`, porque `EWEdge(0, 1)`
  está bloqueada.

### 1.5 Configuración

```ts
type SpawnMode = 'random' | 'central' | 'perimeter';

interface GameConfig {
  size: number;           // lado del tablero
  playerCount: number;    // numero de jugadores
  wallsPerPlayer: number; // inventario inicial de paredes por jugador
  spawnMode: SpawnMode;   // como se generan spawn/goal (ver docs/spawns.md)
  turnSeconds: number;    // tiempo de turno para el servidor; el motor lo ignora
}
```

**Valores por defecto:**

| Campo | Por defecto | Rango válido |
|---|---|---|
| `size` | `9` | `8 .. 20` |
| `playerCount` | `2` | `2 .. 8` |
| `wallsPerPlayer` | `10` | `0 .. 20` |
| `spawnMode` | `'random'` | `'random' | 'central' | 'perimeter'` |
| `turnSeconds` | `30` | entero, fijo 30; Value distinto => `INVALID_CONFIG` |

Configuración inválida (fuera de rango) produce `INVALID_ACTION` en `createGame` y el motor
no crea partida. `spawnMode` se resuelve fuera del motor (`spawnResult`); ver §11 y
`docs/spawns.md`.

---

## 2. Estado serializable `GameState` y `PublicGameState`

El motor trabaja con estructuras **planas, serializables a JSON** y sin referencias cíclicas.
Toda mutación produce un nuevo `GameState` inmutable (copy-on-write) o una copia profunda.

### 2.1 Tipos base

```ts
type Orientation = 'H' | 'V';
type GameStatus = 'lobby' | 'playing' | 'finished';

interface Cell {
  r: number; // fila,   0 <= r < size
  c: number; // columna,0 <= c < size
}

interface Wall {
  orientation: Orientation;
  x: number; // interseccion columna, 0 <= x < size - 1
  y: number; // interseccion fila,    0 <= y < size - 1
  playerId: string; // jugador que coloco la pared
}

interface CampingState {
  goalOwnerId: string; // dueno de la meta ajena ocupada
  turnsOnGoal: number; // turnos consecutivos sobre meta ajena (empieza en 1)
}

interface PlayerState {
  id: string;
  name: string;
  colorIndex: number;      // orden de asiento / color, 0..playerCount-1
  spawn: Cell;             // celda inicial
  goal: Cell;              // meta propia asignada a igual distancia Manhattan del spawn
  pos: Cell;               // posicion actual
  wallsLeft: number;       // paredes restantes
  ghost: boolean;          // true = desconectado / transitable
  connected: boolean;      // true = conexion activa
  camping: CampingState | null;
}
```

### 2.2 `GameState` (privado, fuente de verdad)

```ts
interface GameState {
  config: GameConfig;
  players: PlayerState[];   // ordenado por colorIndex
  walls: Wall[];            // todas las paredes colocadas, en orden de colocacion
  turnPlayerId: string;
  turnNumber: number;       // empieza en 1, se incrementa por cada turno completado
  status: GameStatus;
  winnerId: string | null;
  seed: number;             // semilla inyectada (solo la usa autoMove)
  startedAtTurn: number;    // turnNumber en que arranco 'playing'
}
```

### 2.3 `PublicGameState` (proyección pública)

Es una proyección de `GameState` que **oculta** `seed` y cualquier caché interna. No oculta
posiciones (son públicas), pero sí cualquier dato de azar reutilizable.

```ts
interface PublicPlayerState {
  id: string;
  name: string;
  colorIndex: number;
  spawn: Cell;
  goal: Cell;
  pos: Cell;
  wallsLeft: number;
  ghost: boolean;
  connected: boolean;
  camping: { goalOwnerId: string; turnsOnGoal: number } | null;
}

interface PublicGameState {
  config: GameConfig;
  players: PublicPlayerState[];
  walls: Wall[];
  turnPlayerId: string;
  turnNumber: number;
  status: GameStatus;
  winnerId: string | null;
  viewerId: string | null; // identifica al observador; null = espectador
}
```

**Diferencias público/privado:**

| Campo | `GameState` | `PublicGameState` |
|---|---|---|
| `seed` | sí | no |
| `startedAtTurn` | sí | no |
| `viewerId` | no | sí |
| resto de campos | sí | sí (misma forma pública) |

`walls[].playerId` se conserva en la proyección pública para atribuir el color de cada pared.

El motor **no conoce sockets ni timers**: `viewerId` solo sirve para etiquetar la vista; no
cambia la lógica de juego.

---

## 3. Turnos y acciones

### 3.1 Regla de turno

- En cada turno, el jugador activo (`turnPlayerId`) ejecuta **exactamente una** acción:
  **mover** o **colocar una pared**.
- El orden de turnos sigue `colorIndex` ascendente (orden de asiento). Al terminar el turno del
  último `colorIndex` se vuelve al primero.
- Los turnos **saltan** jugadores que son fantasmas (`ghost === true`) o desconectados
  (`connected === false`). `turnNumber` se incrementa una vez por cada jugador que realmente juega.
- `turnPlayerId` siempre apunta a un jugador no fantasma (o `null` cuando `status === 'finished'`).

```text
Secuencia con 4 jugadores, B fantasma:
  A (ci=0) -> C (ci=2) -> D (ci=3) -> A -> C -> D -> ...
  B (ci=1) se salta siempre.
```

### 3.2 API de acciones

```ts
function move(playerId: string, to: Cell): ActionResult;
function placeWall(playerId: string, orientation: Orientation, x: number, y: number): ActionResult;
```

**Nunca lanzan excepciones por jugadas ilegales.** Devuelven un resultado discriminado:

```ts
type ActionResult =
  | { ok: true; events: GameEvent[] }
  | { ok: false; error: ErrorCode };
```

- En éxito, `events` contiene al menos un `MOVE`/`JUMP` o `WALL_PLACED` y termina con
  `TURN_CHANGED` (o `PLAYER_WON` sin `TURN_CHANGED`).
- En fallo, el estado **no cambia** (ni posiciones, ni inventario, ni turno).
- Solo errores de programación (p. ej. `playerId` inexistente) pueden lanzar; se documentan como
  `INVALID_ACTION` cuando son detectables.

### 3.3 Códigos de error (estables)

| Código | Significado |
|---|---|
| `NOT_YOUR_TURN` | La acción la intenta un jugador que no es `turnPlayerId`. |
| `GAME_FINISHED` | `status === 'finished'`; no se aceptan acciones. |
| `PLAYER_GHOST` | El jugador es fantasma; no puede actuar. |
| `OUT_OF_BOARD` | Destino fuera del tablero. |
| `NOT_ADJACENT` | Destino no alcanzable por paso simple ni salto válido. |
| `CELL_OCCUPIED` | Destino ocupado por una ficha **activa**. |
| `NO_WALLS_LEFT` | `wallsLeft === 0`. |
| `WALL_OUT_OF_BOUNDS` | Ancla `(x, y)` fuera de `0 .. size-2`. |
| `WALL_OVERLAP` | Solape con pared existente (misma orientación, arista compartida). |
| `WALL_CROSS` | Cruce físico entre una H y una V (mismo ancla; ver §7.3). |
| `NO_PATH` | La pared dejaría sin camino a algún jugador activo (anti-encierro). |
| `CAMPING_FORCED_MOVE` | El jugador en camping intenta una acción prohibida por camping. |
| `CAMPING_NO_WALL` | El jugador en camping intenta colocar una pared. |
| `INVALID_ACTION` | Acción malformada o parámetros inválidos. |
| `INVALID_ORIENTATION` | `orientation` distinta de `'H'` o `'V'`. |

### 3.4 Orden de validación

El orden es **normativo**: el primer error que se cumple es el que se devuelve.

**`move`:**

1. `INVALID_ACTION` (parámetros malformados: `to` no es `Cell` finita entera).
2. `GAME_FINISHED`.
3. `NOT_YOUR_TURN`.
4. `PLAYER_GHOST`.
5. `OUT_OF_BOARD`.
6. `CELL_OCCUPIED` (destino con ficha activa; los fantasmas no cuentan).
7. `NOT_ADJACENT` (no es paso simple ni salto válido, ver §4 y §5).
8. `CAMPING_FORCED_MOVE` (jugador en camping intentando terminar en la misma meta ajena).

**`placeWall`:**

1. `INVALID_ACTION` (parámetros malformados: `x`, `y` no enteros).
2. `GAME_FINISHED`.
3. `NOT_YOUR_TURN`.
4. `PLAYER_GHOST`.
5. `CAMPING_NO_WALL` (el jugador está en camping y debe mover).
6. `INVALID_ORIENTATION`.
7. `NO_WALLS_LEFT`.
8. `WALL_OUT_OF_BOUNDS`.
9. `WALL_OVERLAP`.
10. `WALL_CROSS`.
11. `NO_PATH` (anti-encierro, ver §7.4).

> Nota: `NO_WALLS_LEFT` se evalúa **antes** que `WALL_OUT_OF_BOUNDS` para dar un error más
> informativo cuando el jugador simplemente se quedó sin paredes.

### 3.5 Eventos

```ts
type GameEvent =
  | { type: 'MOVE';          playerId: string; from: Cell; to: Cell; path: Cell[] }
  | { type: 'JUMP';          playerId: string; from: Cell; to: Cell; over: Cell[]; kind: 'straight' | 'chain' | 'L' }
  | { type: 'WALL_PLACED';   playerId: string; wall: Wall; wallsLeft: number }
  | { type: 'CAMPING_ENTERED'; playerId: string; goalOwnerId: string; pos: Cell }
  | { type: 'CAMPING_FORCED'; playerId: string; pos: Cell; hadLegalExit: boolean }
  | { type: 'PLAYER_WON';    playerId: string }
  | { type: 'TURN_CHANGED';  fromPlayerId: string; toPlayerId: string; turnNumber: number }
  | { type: 'GHOST_SET';     playerId: string; ghost: boolean };
```

| Evento | Cuándo se emite |
|---|---|
| `MOVE` | Paso ortogonal simple. `path` = `[from, to]`. |
| `JUMP` | Salto recto, cadena recta o salto en L. `over` = fichas saltadas. |
| `WALL_PLACED` | Pared válida colocada. `wallsLeft` es el inventario resultante. |
| `CAMPING_ENTERED` | El jugador aterriza en la meta de otro. |
| `CAMPING_FORCED` | En el turno forzado de un camper; `hadLegalExit` indica si tenía salida. |
| `PLAYER_WON` | Un jugador alcanza su meta propia. |
| `TURN_CHANGED` | Fin de turno; apunta al siguiente jugador no fantasma. |
| `GHOST_SET` | Cambia el estado fantasma de un jugador (desconexión/reconexión). |

---

## 4. Movimiento ortogonal

### 4.1 Regla de paso simple

Desde `pos = (r, c)` un jugador puede mover a un vecino ortogonal `to` si y solo si:

1. `to` está dentro del tablero (`0 <= r,c < size`).
2. La arista entre `pos` y `to` **no** está bloqueada por ninguna pared:
   - Norte/Sur requiere `NSEdge` libre.
   - Este/Oeste requiere `EWEdge` libre.
3. `to` **no** contiene una ficha **activa** (no fantasma).
   - Los fantasmas son **transitables**: se puede mover a su celda.

```ts
function isEdgeBlocked(state: GameState, a: Cell, b: Cell): boolean {
  const dr = b.r - a.r, dc = b.c - a.c;
  if (dr === -1 && dc === 0) return blocksNSEdge(state, a.r - 1, a.c); // a -> norte
  if (dr === 1  && dc === 0) return blocksNSEdge(state, a.r, a.c);     // a -> sur
  if (dr === 0  && dc === -1) return blocksEWEdge(state, a.r, a.c - 1); // a -> oeste
  if (dr === 0  && dc === 1) return blocksEWEdge(state, a.r, a.c);     // a -> este
  throw new Error('not adjacent');
}

function blocksNSEdge(state: GameState, r: number, c: number): boolean {
  // NSEdge(r,c) separa (r,c) de (r+1,c). La bloquea H(x, r) con x = c-1 o x = c.
  return state.walls.some(w => w.orientation === 'H' && w.y === r && (w.x === c || w.x === c - 1));
}

function blocksEWEdge(state: GameState, r: number, c: number): boolean {
  // EWEdge(r,c) separa (r,c) de (r,c+1). La bloquea V(c, y) con y = r-1 o y = r.
  return state.walls.some(w => w.orientation === 'V' && w.x === c && (w.y === r || w.y === r - 1));
}
```

### 4.2 Destino y consecuencias

Al aterrizar en `to`:

| Condición de `to` | Consecuencia |
|---|---|
| `to === goal` propio | **Victoria inmediata**: `status = 'finished'`, `winnerId = playerId`, evento `PLAYER_WON`. No hay `TURN_CHANGED`. |
| `to` es meta de **otro** jugador (activo o fantasma) | Entra en **camping** (ver §6), evento `CAMPING_ENTERED`. |
| `to` es celda normal | Movimiento normal. |

- "Meta de otro" incluye la meta de un jugador fantasma: el dueño es `goalOwnerId` de ese
  jugador, aunque esté desconectado.
- Nunca se gana por pisar la meta ajena.

---

## 5. Saltos

Los saltos permiten superar fichas **activas** adyacentes. Los **fantasmas no se saltan**:
se atraviesan como celda libre (es decir, nunca participan como obstáculo de salto).

### 5.1 Salto recto

Desde `pos = P`, dirección `d` (N/S/E/O). Sea `O = P + d` la celda adyacente.

Salto recto a `L = O + d` es legal si:

1. `O` contiene una ficha **activa**.
2. `L` está dentro del tablero.
3. `NSEdge`/`EWEdge` entre `P` y `O` **no** está bloqueada.
4. `NSEdge`/`EWEdge` entre `O` y `L` **no** está bloqueada.
5. `L` **no** contiene una ficha activa (los fantasmas sí se permiten como aterrizaje).

Cuenta como **un solo movimiento** (evento `JUMP`, `kind: 'straight'`).

### 5.2 Cadena de saltos rectos

Si `L` contiene **otra** ficha activa, la cadena continúa en la misma dirección:

```text
CHAIN_STRAIGHT(state, P, d):
  cur  = P
  over = []
  loop:
    nxt = cur + d
    if nxt fuera del tablero:            return NO_LANDING
    if edge(cur, nxt) bloqueada:         return NO_LANDING
    if cell(nxt) tiene ficha ACTIVA:
        over.push(nxt)
        cur = nxt
        continue
    else:
        // nxt libre (o fantasma): aterrizaje
        if over.length == 0: return STEP(nxt)   // no era salto
        return CHAIN(landing = nxt, over)       // aterriza en la primera celda libre
```

- **Sin límite artificial** de longitud.
- Se **detiene en la primera celda libre**.
- Si antes de encontrar una celda libre aparece borde o pared, la cadena **no tiene aterrizaje**
  (falla en esa dirección). En tal caso puede aplicar el salto en L (§5.3).
- La cadena cuenta como **un solo movimiento** (`JUMP`, `kind: 'chain'`).

### 5.3 Salto en L

Si el **salto recto** está bloqueado **por pared o borde** (y **no** por otra ficha), se
permiten las **dos celdas perpendiculares laterales** a la ficha saltada.

Desde `P`, dirección `d`, `O = P + d` con ficha activa. Sean `p1`, `p2` las dos direcciones
perpendiculares a `d`. La celda lateral es `Lk = O + pk` (`k = 1, 2`).

Salto en L a `Lk` es legal si:

1. `O` contiene una ficha **activa**.
2. El salto recto `P -> O + d` está bloqueado por **pared o borde** (no por otra ficha).
3. `Lk` está dentro del tablero.
4. `Lk` **no** contiene ficha activa (fantasma permitido).
5. Es **accesible desde `P` sin cruzar pared** por el camino que rodea a `O`:
   sea `Mk = P + pk` (celda perpendicular a `P`). Deben estar libres:
   - `EWEdge`/`NSEdge` entre `P` y `Mk`, y
   - `EWEdge`/`NSEdge` entre `Mk` y `Lk`.

> Justificación de (5): el salto en L es un rodeo físico por la esquina compartida por
> `P, O, Mk, Lk`. Como `O` está ocupada, el único corredor posible es `P -> Mk -> Lk`, luego
> ambas aristas deben estar libres. (Se documenta explícitamente porque es la condición que
> más variantes implementan de forma distinta.)

El salto en L cuenta como **un único movimiento** (`JUMP`, `kind: 'L'`) y **no** se combina con
la cadena recta (aunque `Lk` contenga otra ficha activa, no se encadena).

```ts
function perpendicular(dir: 'N'|'S'|'E'|'W'): ['N'|'S'|'E'|'W', 'N'|'S'|'E'|'W'] {
  if (dir === 'N' || dir === 'S') return ['E', 'W'];
  return ['N', 'S'];
}
```

### 5.4 Escenarios (ASCII)

Leyenda: `P` = saltador, `O` = ficha activa saltada, `g` = fantasma, `.` = libre,
`X` = arista bloqueada por pared, `#` = borde.

**Escenario 1 — Salto recto libre.** `P(1,1)`, `O(1,2)`. Aterriza en `(1,3)`.

```text
        c0  c1  c2  c3  c4
   r0    .   .   .   .   .
   r1    .   P   O   .   .     -> JUMP straight  P(1,1) -> (1,3)
   r2    .   .   .   .   .
```

**Escenario 2 — Recto bloqueado por pared -> L.** Pared bloquea `O(1,2)-(1,3)`.
Laterales `(0,2)` y `(2,2)`.

```text
        c0  c1  c2  c3  c4
   r0    .   .   a   .   .     a = (0,2) candidato L
   r1    .   P   O   X   .     X bloquea O->(1,3)
   r2    .   .   b   .   .     b = (2,2) candidato L
```

Si `EWEdge(1,2)` (entre `(1,2)` y `(1,3)`) está bloqueada, el salto recto falla por pared y
se permiten `(0,2)` y `(2,2)` (sujeto a las condiciones 3–5).

**Escenario 3 — Recto bloqueado por borde -> L.** `P(1,size-2)`, `O(1,size-1)` en el borde este.

```text
        c...  c(size-2)  c(size-1)   #
   r0    .      .          a
   r1    .      P          O          #     salto recto -> fuera del tablero
   r2    .      .          b
```

El salto recto queda fuera del tablero, luego se permiten los laterales `a` y `b`.

**Escenario 4 — Lateral ocupada.** Igual que el escenario 2, pero `(0,2)` tiene ficha activa.

```text
        c0  c1  c2  c3
   r0    .   .   O   .     (0,2) ocupada -> no valida como L
   r1    .   P   O   X
   r2    .   .   b   .     solo (2,2) es candidato valido
```

**Escenario 5 — Cadena de dos fichas.** `P(1,1)`, `O1(1,2)`, `O2(1,3)`, libre `(1,4)`.

```text
        c0  c1  c2  c3  c4
   r1    .   P   O1  O2  .     -> JUMP chain  P(1,1) -> (1,4), over=[(1,2),(1,3)]
```

**Escenario 6 — Fantasma intermedio.** `P(1,1)`, `g(1,2)` fantasma. No hay salto: el fantasma
es transitable, así que es un **paso simple** a `(1,2)`.

```text
        c0  c1  c2  c3
   r1    .   P   g   .     -> MOVE simple  P(1,1) -> (1,2)   (no JUMP)
```

**Escenario 7 — Aterrizaje en meta propia.** `P(1,1)`, `O(1,2)`, meta propia `(1,3)`.

```text
        c0  c1  c2  c3
   r1    .   P   O   G     G = goal propio -> JUMP straight y PLAYER_WON
```

**Escenario 8 — Aterrizaje en meta ajena.** `P(1,1)`, `O(1,2)`, meta ajena `(1,3)`.

```text
        c0  c1  c2  c3
   r1    .   P   O   E     E = meta ajena -> JUMP straight y CAMPING_ENTERED
```

---

## 6. Metas y camping

### 6.1 Meta propia

Al aterrizar en la meta propia (`to === goal`), el jugador **gana inmediatamente**. No importa
si llegó por paso simple o por salto. `status = 'finished'`, `winnerId = playerId`, evento
`PLAYER_WON`. No se emite `TURN_CHANGED`.

### 6.2 Meta ajena y camping

Si un jugador aterriza en la meta de **otro** jugador (activo o fantasma), entra en **camping**:

```ts
camping = { goalOwnerId, turnsOnGoal: 1 }
```

y se emite `CAMPING_ENTERED`. No se gana. El camping **no** es una victoria.

### 6.3 Máquina de estados de camping

Estados: `NONE` (sin camping) y `ON_GOAL` (sobre meta ajena, obligado a salir).

```text
                    aterriza en meta ajena (owner != self)
        NONE -------------------------------------------------> ON_GOAL
          ^                                                       |
          |  sale a celda no-meta                                 | inicio del siguiente turno:
          |  (evento CAMPING_FORCED hadLegalExit=true)            | MOVE forzado (no pared)
          +-------------------------------------------------------+
                                                                  |
          |  sin salida legal: permanece, turnsOnGoal++           |
          |  (evento CAMPING_FORCED hadLegalExit=false)           |
          +-------------------------------------------------------
```

Reglas precisas:

1. **Entrada.** Aterrizar en cualquier meta ajena establece `camping` con `turnsOnGoal = 1`
   (se **reinicia** el contador al volver a entrar, aunque sea la misma meta tras haber salido).
2. **Turno forzado.** En el siguiente turno del camper:
   - **Debe mover** (no puede colocar pared: `placeWall` devuelve `CAMPING_NO_WALL`).
   - **No puede terminar en la misma meta ajena** que ocupa: `move` a esa celda devuelve
     `CAMPING_FORCED_MOVE`.
   - Puede moverse a cualquier otra celda legal (incluida otra meta ajena, que reinicia el
     camping con `turnsOnGoal = 1`).
3. **Salida con éxito.** Si mueve a una celda no-meta: `camping = null`, evento
   `CAMPING_FORCED` con `hadLegalExit = true`.
4. **Sin salida legal.** Si no existe ningún movimiento legal que no sea la meta actual:
   - Se permite **permanecer** en la meta (`move` a la propia celda actual se acepta como
     "quedarse"), `turnsOnGoal++`, evento `CAMPING_FORCED` con `hadLegalExit = false` (aviso).
   - Sigue sin poder colocar pared y sigue obligado a mover el siguiente turno.
5. **Sin victoria por meta ajena.** Estar en camping nunca concede la victoria.

> El "movimiento de quedarse" solo se admite como último recurso cuando no hay salida; en
> cualquier otro caso, moverse a la meta actual es `CAMPING_FORCED_MOVE`.

### 6.4 Interacción con auto-move / timeout

- El **auto-move** de un camper elige, si existe, un movimiento simple legal que **salga** de
  la meta (preferencia). Si no hay salida, elige permanecer (quedarse), generando
  `CAMPING_FORCED hadLegalExit=false`.
- El servidor temporiza `turnSeconds`; al expirar llama a `autoMove` (ver §9). El motor no
  cuenta el tiempo.
- El contador `turnsOnGoal` se **reinicia** al volver a entrar (regla 1) y no se usa para
  eliminar jugadores en esta variante; solo es informativo y de presentación.

---

## 7. Paredes

### 7.1 Inventario

- Cada jugador empieza con `wallsLeft = config.wallsPerPlayer`.
- Solo se descuenta cuando la colocación es **válida** (no en intentos fallidos).
- `NO_WALLS_LEFT` cuando `wallsLeft === 0` (evaluado antes que los errores geométricos, §3.4).

### 7.2 Anclaje y validez

```ts
function isWallInBounds(w: Wall, size: number): boolean {
  return w.x >= 0 && w.x <= size - 2 && w.y >= 0 && w.y <= size - 2;
}
```

Una pared es válida si:

1. Orientación `'H'` o `'V'`.
2. Ancla dentro de `0 .. size-2` en ambas coordenadas.
3. No produce `WALL_OVERLAP`.
4. No produce `WALL_CROSS`.
5. No produce `NO_PATH` (anti-encierro).

### 7.3 Tabla de colisiones

Sea `edges(w)` el conjunto de aristas que bloquea `w`:

```ts
function edges(w: Wall): string[] {
  if (w.orientation === 'H') return [`NS:${w.y}:${w.x}`, `NS:${w.y}:${w.x + 1}`];
  else                       return [`EW:${w.y}:${w.x}`, `EW:${w.y + 1}:${w.x}`];
}
```

**`WALL_OVERLAP`** si dos paredes de la **misma** orientación comparten al menos una arista:

```ts
function overlaps(a: Wall, existing: Wall[]): boolean {
  const ea = new Set(edges(a));
  return existing.some(w => w.orientation === a.orientation && edges(w).some(e => ea.has(e)));
}
```

**`WALL_CROSS`** si una H y una V comparten ancla. Con la convención de §1.4, la H `(x,y)` ocupa
el segmento horizontal cuyo punto medio es la esquina común de las cuatro celdas del bloque
`{(y,x),(y,x+1),(y+1,x),(y+1,x+1)}`, y la V `(x,y)` ocupa el segmento vertical con el **mismo**
punto medio. Por tanto:

```ts
function crosses(a: Wall, b: Wall): boolean {
  return a.orientation !== b.orientation && a.x === b.x && a.y === b.y;
}
```

**Tabla de colisiones (ejemplos):**

| Pared A | Pared B | Resultado | Motivo |
|---|---|---|---|
| `H(0,0)` | `H(0,0)` | `WALL_OVERLAP` | Aristas idénticas. |
| `H(0,0)` | `H(1,0)` | `WALL_OVERLAP` | Comparten `NS:0:1`. |
| `H(0,0)` | `H(2,0)` | permitido | No comparten aristas (contiguas sin solape). |
| `V(0,0)` | `V(0,1)` | `WALL_OVERLAP` | Comparten `EW:1:0`. |
| `H(0,0)` | `V(0,0)` | `WALL_CROSS` | Mismo ancla; cruce en el punto medio. |
| `H(0,0)` | `V(1,0)` | permitido | Anclas distintas; solo se tocan en extremo. |
| `H(0,1)` | `V(0,1)` | `WALL_CROSS` | Mismo ancla `(0,1)`. |
| `H(0,0)` | `V(0,1)` | permitido | Sin cruce ni solape. |

```text
Cruce en el punto medio: H(0,0) + V(0,0) en size = 3.

        x=0     x=1     x=2
   y=0  o-------o-------o
        | (0,0) | (0,1) |
   y=1  o=======#=======o   <- H(0,0) horizontal (==) y V(0,0) vertical (|)
        | (1,0) | (1,1) |      se cruzan en la esquina central (#)
        o-------o-------o
```

### 7.4 Anti-encierro (`NO_PATH`)

Una pared se rechaza si deja a **cualquier** jugador **activo** (no fantasma y con
`connected === true`) sin camino a su propio goal. La comprobación:

```ts
function wouldEnclose(state: GameState, w: Wall): boolean {
  const tentative = [...state.walls, w];
  for (const p of state.players) {
    if (p.ghost || !p.connected) continue; // excluye fantasmas y desconectados
    if (!hasPath(p.pos, p.goal, tentative, state.config.size)) return true;
  }
  return false;
}
```

- El BFS de validación **ignora las fichas** (activas o fantasmas): solo importan paredes y bordes.
  Es decir, las fichas **no** bloquean el pathfinding de validación.
- Los fantasmas y los jugadores con `connected === false` **tampoco** cuentan para el
  anti-encierro (ni como jugadores a comprobar).

### 7.5 Comprobación global tras movimiento

Aunque un movimiento **no puede** romper caminos (no añade paredes), el motor mantiene el
invariante `allActivePlayersHavePath(state)` tras **cada** acción como verificación defensiva.
Si el invariante fallara (indica un bug), el motor debe reportarlo como error interno y **no**
confirmar el movimiento; en producción esto nunca debe ocurrir si §7.4 es correcta.

---

## 8. Pathfinding

### 8.1 Algoritmo obligatorio

El pathfinding de validación es **BFS** sobre la rejilla, coste `O(size^2)`. Un A* equivalente
es opcional y debe producir el **mismo** resultado booleano.

```ts
function hasPath(from: Cell, goal: Cell, walls: Wall[], size: number): boolean {
  if (from.r === goal.r && from.c === goal.c) return true;
  const visited = new Uint8Array(size * size);
  const queue: number[] = [from.r * size + from.c];
  visited[from.r * size + from.c] = 1;
  const blocked = buildEdgeIndex(walls, size); // indices rapidos de aristas bloqueadas
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const r = (cur / size) | 0, c = cur % size;
    if (r === goal.r && c === goal.c) return true;
    for (const [nr, nc] of neighbors(r, c, size)) {
      if (visited[nr * size + nc]) continue;
      if (edgeBlocked(blocked, r, c, nr, nc)) continue;
      visited[nr * size + nc] = 1;
      queue.push(nr * size + nc);
    }
  }
  return false;
}

function allActivePlayersHavePath(state: GameState): boolean {
  return state.players.every(p =>
    p.ghost || !p.connected || hasPath(p.pos, p.goal, state.walls, state.config.size));
}
```

### 8.2 Reglas clave

- Las fichas (activas o fantasmas) **no** bloquean el pathfinding de validación.
- Los fantasmas y los jugadores con `connected === false` **no** cuentan para el anti-encierro.
- El resultado de `hasPath` es **booleano** (existe camino). La longitud no importa.

### 8.3 Caché opcional

Se permite cachear por hash de paredes (p. ej. clave = lista ordenada de `edges(w)`), con
semántica **idéntica**: un acierto de caché debe devolver el mismo booleano que el BFS directo.
La caché es puramente una optimización y nunca altera la lógica.

---

## 9. Auto-move y timeout

### 9.1 Movimientos legales

```ts
interface LegalMoveOptions { simple?: boolean }
type MoveKind = 'step' | 'straight' | 'chain' | 'L';
interface MoveOption { to: Cell; kind: MoveKind; over: Cell[] }

function getLegalMoves(playerId: string, opts?: LegalMoveOptions): MoveOption[];
function getLegalWallPlacements(playerId: string): Wall[];
```

- `getLegalMoves(id, { simple: true })`: solo **pasos ortogonales simples** (§4), excluyendo
  saltos. Respeta camping: si el jugador está en camping, excluye la meta actual (salvo que no
  haya otra salida).
- `getLegalMoves(id)`: completo, incluye pasos simples y todos los saltos (§5).
- `getLegalWallPlacements(id)`: todas las paredes válidas que el jugador podría colocar ahora
  (respetando inventario, colisiones y anti-encierro). Devuelve `[]` si está en camping.

### 9.2 Auto-move

```ts
function autoMove(state: GameState, playerId: string, rng: Rng): ActionResult;
```

Comportamiento:

1. Si el jugador está en **camping**: elegir entre los movimientos **simples** legales que
   **salgan** de la meta actual. Si no hay salida, "quedarse" (permanecer).
2. Si no está en camping: elegir entre los movimientos **simples** legales (paso ortogonal).
3. **Fallback**: si no hay movimientos simples legales, elegir cualquier movimiento legal
   (incluyendo saltos).
4. Si no hay ningún movimiento legal: **pasar turno** (emite `TURN_CHANGED` al siguiente).
5. La elección aleatoria usa `rng` (inyectable) — único punto de no determinismo del motor.
6. `autoMove` **nunca** coloca paredes (solo mueve o pasa).

### 9.3 Timeout (fuera del motor)

El **servidor** temporiza `config.turnSeconds` (por defecto 30 s). Al expirar, invoca
`autoMove`. El motor **no** cuenta tiempo, **no** conoce relojes y **no** expira nada por sí solo.
Un timeout simulado en pruebas equivale a llamar a `autoMove` con un `rng` fijo.

---

## 10. Fin y rematch

- La partida termina cuando un jugador alcanza su meta propia. Entonces:
  - `status = 'finished'`
  - `winnerId = <id>`
  - evento `PLAYER_WON` (y no `TURN_CHANGED`).
- Tras `finished`, todas las acciones devuelven `GAME_FINISHED`. El estado se **congela**:
  ninguna mutación es válida.
- **Rematch** se resuelve **fuera** del motor: se crea una **nueva instancia** con `createGame`
  y una **nueva semilla**. El motor no reinicia ni recicla estados.

---

## 11. API del motor

### 11.1 Firmas

```ts
interface SpawnResult {
  // Definido en docs/spawns.md; el motor solo consume spawn/goal por jugador.
  players: Array<{ id: string; name: string; colorIndex: number; spawn: Cell; goal: Cell }>;
}

interface Rng {
  next(): number;              // [0, 1)
  int(maxExclusive: number): number;
}

function createGame(config: GameConfig, players: SpawnResult, seed: number): GameEngine;
function getState(): GameState;
function getPublicState(viewerId: string | null): PublicGameState;
function move(playerId: string, to: Cell): ActionResult;
function placeWall(playerId: string, orientation: Orientation, x: number, y: number): ActionResult;
function getLegalMoves(playerId: string, opts?: LegalMoveOptions): MoveOption[];
function getLegalWallPlacements(playerId: string): Wall[];
function autoMove(state: GameState, playerId: string, rng: Rng): ActionResult;
function setGhost(playerId: string, ghost: boolean): ActionResult;
function isFinished(): boolean;
function getWinner(): string | null;
```

`createGame` devuelve una **instancia de `GameEngine`**, no un `GameState` plano. El `GameState`
se obtiene llamando a `getState()` sobre esa instancia.

### 11.2 Formatos exactos

```ts
type ErrorCode =
  | 'NOT_YOUR_TURN' | 'GAME_FINISHED' | 'PLAYER_GHOST' | 'OUT_OF_BOARD'
  | 'NOT_ADJACENT' | 'CELL_OCCUPIED' | 'NO_WALLS_LEFT' | 'WALL_OUT_OF_BOUNDS'
  | 'WALL_OVERLAP' | 'WALL_CROSS' | 'NO_PATH' | 'CAMPING_FORCED_MOVE'
  | 'CAMPING_NO_WALL' | 'INVALID_ACTION' | 'INVALID_ORIENTATION';

type ActionResult =
  | { ok: true; events: GameEvent[] }
  | { ok: false; error: ErrorCode };

interface TurnState {
  turnPlayerId: string;
  turnNumber: number;
  legalMoves: MoveOption[];       // completo (con saltos)
  legalSimpleMoves: MoveOption[]; // solo pasos simples
  legalWalls: Wall[];
}
```

### 11.3 Determinismo

- `createGame` es determinista dada `(config, players, seed)`.
- `move`, `placeWall`, `setGhost`, `getState`, `getPublicState`, `getLegalMoves`,
  `getLegalWallPlacements`, `isFinished`, `getWinner` son **puros y deterministas**.
- **Solo `autoMove`** consume aleatoriedad, a través del `rng` inyectable. Dada la misma
  secuencia de llamadas y el mismo `rng`, la partida es reproducible bit a bit.

### 11.4 `setGhost`

```ts
function setGhost(playerId: string, ghost: boolean): ActionResult;
```

- Marca/desmarca a un jugador como fantasma y emite `GHOST_SET`.
- Al poner fantasma a un jugador cuyo turno está activo, el motor salta al siguiente jugador
  no fantasma (`TURN_CHANGED`).
- Un jugador fantasma no puede recibir `move`/`placeWall` (`PLAYER_GHOST`).
- Al quitar el fantasma, el jugador vuelve a ser considerado activo en el pathfinding/anti-encierro.

---

## 12. Matriz de pruebas

Cada caso: **setup**, **acción**, **resultado esperado**, **error esperado** (si aplica).
`size` por defecto 9, `playerCount` 2, salvo indicación. Los goals se indican explícitamente
cuando el caso los necesita.

| # | Escenario | Setup | Acción | Resultado | Error |
|---|---|---|---|---|---|
| 1 | Movimiento simple | P0 en `(4,4)` | `move(P0,(4,5))` | `MOVE`, turno cambia | — |
| 2 | Movimiento fuera del tablero | P0 en `(0,0)` | `move(P0,(-1,0))` | sin cambio | `OUT_OF_BOARD` |
| 3 | Celda ocupada | P0 `(4,4)`, P1 `(4,5)` | `move(P0,(4,5))` | sin cambio | `CELL_OCCUPIED` |
| 4 | No adyacente | P0 `(4,4)` | `move(P0,(4,6))` | sin cambio | `NOT_ADJACENT` |
| 5 | Turno incorrecto | turno de P0 | `move(P1,(4,5))` | sin cambio | `NOT_YOUR_TURN` |
| 6 | Arista bloqueada por pared | P0 `(4,4)`, `V(5,3)` | `move(P0,(4,5))` | sin cambio | `NOT_ADJACENT` |
| 7 | Salto recto libre | P0 `(1,1)`, P1 `(1,2)` | `move(P0,(1,3))` | `JUMP straight` | — |
| 8 | Salto recto bloqueado por pared -> L | P0 `(1,1)`, P1 `(1,2)`, `V(3,1)` | `move(P0,(0,2))` | `JUMP L` | — |
| 9 | Salto recto bloqueado por borde -> L | P0 `(1,size-2)`, P1 `(1,size-1)` | `move(P0,(0,size-1))` | `JUMP L` | — |
| 10 | L con lateral ocupada | caso 8 + P2 activo en `(0,2)` | `move(P0,(0,2))` | sin cambio | `NOT_ADJACENT` |
| 11 | Cadena de dos fichas | P0 `(1,1)`, P1 `(1,2)`, P2 `(1,3)` | `move(P0,(1,4))` | `JUMP chain over=[(1,2),(1,3)]` | — |
| 12 | Cadena sin aterrizaje (pared tras fichas) | caso 11 + `V(4,1)` | `move(P0,(1,4))` | sin cambio | `NOT_ADJACENT` |
| 13 | Fantasma transitable | P1 ghost en `(1,2)` | `move(P0,(1,2))` | `MOVE` simple | — |
| 14 | Fantasma no se salta | P1 ghost en `(1,2)` | `move(P0,(1,3))` | sin cambio | `NOT_ADJACENT` |
| 15 | Meta propia gana | P0 `(1,1)`, P1 `(1,2)`, goal P0 `(1,3)` | `move(P0,(1,3))` | `JUMP` + `PLAYER_WON`, `finished` | — |
| 16 | Meta ajena -> camping | P0 `(1,1)`, P1 `(1,2)`, goal P1 `(1,3)` | `move(P0,(1,3))` | `JUMP` + `CAMPING_ENTERED` | — |
| 17 | Camping: no puede poner pared | P0 en camping en `E` | `placeWall(P0,'H',0,0)` | sin cambio | `CAMPING_NO_WALL` |
| 18 | Camping: no repetir la meta | P0 en camping en `E` | `move(P0,E)` | sin cambio | `CAMPING_FORCED_MOVE` |
| 19 | Camping 2 turnos: salir | P0 en `E`, con salida libre | `move(P0,(r,c)!=E)` | `CAMPING_FORCED hadLegalExit=true`, `camping=null` | — |
| 20 | Camping sin salida | P0 en `E` sin salida legal | `move(P0,E)` | `CAMPING_FORCED hadLegalExit=false`, `turnsOnGoal++` | — |
| 21 | Anti-encierro rechaza | P0 a un paso de encerrar a P1 | `placeWall(...)` que cierra | sin cambio | `NO_PATH` |
| 22 | Solape exacto | existe `H(0,0)` | `placeWall(P,'H',0,0)` | sin cambio | `WALL_OVERLAP` |
| 23 | Solape parcial | existe `H(0,0)` | `placeWall(P,'H',1,0)` | sin cambio | `WALL_OVERLAP` |
| 24 | Cruce H/V | existe `H(0,0)` | `placeWall(P,'V',0,0)` | sin cambio | `WALL_CROSS` |
| 25 | Pared fuera del tablero | — | `placeWall(P,'H',size-1,0)` | sin cambio | `WALL_OUT_OF_BOUNDS` |
| 26 | Orientación inválida | — | `placeWall(P,'X',0,0)` | sin cambio | `INVALID_ORIENTATION` |
| 27 | Inventario 0 | `wallsPerPlayer=0` | `placeWall(P,'H',0,0)` | sin cambio | `NO_WALLS_LEFT` |
| 28 | Jugar tras terminar | partida `finished` | `move(P0,(4,5))` | sin cambio | `GAME_FINISHED` |
| 29 | Tablero mínimo 8x8 | `size=8` | movimiento y pared válidos | `MOVE`/`WALL_PLACED` | — |
| 30 | Tablero máximo 20x20 | `size=20` | BFS y movimiento válidos | `MOVE`, `hasPath=true` | — |
| 31 | 8 jugadores | `playerCount=8` | recorrido completo de turnos | 8 turnos por ronda, sin saltos | — |
| 32 | Auto-move simple | P0 con varias salidas | `autoMove(P0,rngFijo)` | `MOVE` determinista | — |
| 33 | Timeout simulado | turno de P0, 30 s (fuera) | `autoMove(P0,rngFijo)` | mismo resultado que test 32 | — |
| 34 | Fin y rematch | partida `finished` | `createGame(...)` nueva semilla | nueva instancia, `status='playing'` | — |
| 35 | Fantasma se salta turno | P1 ghost | avanzar turno | `turnPlayerId` nunca es P1 | — |

### 12.1 Invariantes testeables

Se deben verificar tras cada acción en pruebas de propiedades (fuzzing):

1. `walls.length === sum(wallsPerPlayer - p.wallsLeft for p in players)`.
2. Toda pared en `state.walls` es válida (sin solape, sin cruce, no encierra).
3. `allActivePlayersHavePath(state) === true`.
4. Las posiciones de dos fichas **activas** nunca coinciden.
5. `0 <= wallsLeft <= wallsPerPlayer` para todo jugador.
6. `turnPlayerId` es `null` o apunta a un jugador con `ghost === false`.
7. `status === 'finished'` implica `winnerId !== null`.
8. `camping !== null` implica que la celda `pos` es la meta de `camping.goalOwnerId`.
9. En `finished`, ninguna acción muta el estado.
10. Reejecutar la misma secuencia con el mismo `rng` produce estados idénticos.

---

## 13. Glosario y referencias

### 13.1 Glosario

| Término | Significado |
|---|---|
| `GameState` | Estado completo y privado del motor (incluye `seed`). |
| `PublicGameState` | Proyección pública del estado (sin `seed`). |
| `ActionResult` | Resultado discriminado de una acción (`ok` + `events` o `error`). |
| `GameEvent` | Evento emitido por el motor al aplicar una acción. |
| `MoveOption` | Movimiento legal con `to`, `kind` y fichas saltadas (`over`). |
| `TurnState` | Resumen del turno activo (jugador, movimientos y paredes legales). |
| `Rng` | Fuente de aleatoriedad inyectable; solo la usa `autoMove`. |
| `ghost` | Ficha desconectada, transitable y excluida del anti-encierro. |
| `camping` | Estado temporal de un jugador sobre la meta de otro. |
| `anti-encierro` | Regla que impide dejar sin camino a un jugador activo. |

### 13.2 Referencias (sin duplicar contenido)

- [`docs/network.md`](./network.md): transporte, mensajes, reconexión y uso de `setGhost`
  desde la capa de red. El motor solo expone `setGhost`; no conoce sockets.
- [`docs/spawns.md`](./spawns.md): generación de `spawn`/`goal` y el `SpawnResult` que consume
  `createGame` para cada `spawnMode`.
- [`docs/ui.md`](./ui.md): presentación de celdas, paredes, eventos (`MOVE`, `JUMP`,
  `WALL_PLACED`, `CAMPING_*`) y temporizador de 30 s.

> Este documento **no** redefine red, spawns ni UI: solo el contrato lógico del motor puro.
