# Spawns y objetivos en Quoridor 2–8 jugadores

## Decisiones canónicas (v1)

Resumen para el subagente de código; las secciones siguientes lo desarrollan.

- `n = playerCount` exacto, en `2..8`; nunca se completa hasta 8.
- Modos de spawn: `random`, `central`, `perimeter`.
- `central`: spawns dentro de la zona interior `[lo, hi]^2`.
- `perimeter`: spawns en el borde sin esquinas.
- Distancia común al 60 por ciento: `D = clamp(round(0.6 * size), 2, 2*(size-1))`, medida con Manhattan.
- RNG determinista `mulberry32(seed)` inyectado; sin semilla se usa `Math.random` y `seed: null`.
- Exclusión global: `goals ∩ spawns = ∅` y goals distintos entre sí.
- Backtracking con MRV dinámico por nivel; reproducible para una misma `seed`.

Documento de diseño implementable para la generación de posiciones iniciales (`spawns`) y objetivos (`goals`) de una partida de Quoridor de 2 a 8 jugadores sobre un tablero cuadrado.

El generador es independiente de la interfaz, de los colores, de los asientos y del orden de turno. Su única responsabilidad es devolver `n` spawns y `n` goals que cumplan las invariantes de este documento.

Rango soportado:

- `size` entero, `8 <= size <= 16`.
- `playerCount` entero, `2 <= playerCount <= 8`.
- El número de jugadores es exactamente `n = playerCount`; no se genera siempre una partida de 8.

---

## 1. Objetivos, terminología e invariantes

### 1.1 Terminología

| Término | Definición |
|---|---|
| Tablero | Cuadrado de `size × size` celdas. |
| Celda | Par `(r, c)` con `0 <= r < size`, `0 <= c < size`. |
| Spawn | Celda inicial de un jugador. |
| Goal | Celda objetivo de un jugador. |
| `n` | Número exacto de jugadores, `2..8`. |
| `spawn_i` | Spawn del jugador `i`, con `0 <= i < n`. |
| `goal_i` | Goal del jugador `i`, con `0 <= i < n`. |
| `d1(a,b)` | Distancia Manhattan: `|a.r-b.r| + |a.c-b.c|`. |
| `D` | Distancia Manhattan objetivo común a todos los jugadores. |
| `relaxed` | `true` si fue necesario usar un `D' != D` en el fallback. |
| `mode` | Estrategia de generación de spawns: `random`, `central`, `perimeter`. |
| `seed` | Semilla entera usada para construir el RNG determinista, o `null`. |

### 1.2 Invariantes obligatorias

Toda salida válida del generador cumple:

| ID | Invariante |
|---|---|
| I1 | `n` es exactamente `playerCount` y está en `2..8`. |
| I2 | `spawns.length === n` y `goals.length === n`. |
| I3 | Todos los spawns son celdas válidas del tablero. |
| I4 | Todos los goals son celdas válidas del tablero. |
| I5 | Los `n` spawns son distintos entre sí. |
| I6 | Los `n` goals son distintos entre sí. |
| I7 | Ningún goal coincide con ningún spawn de ningún jugador: `goals ∩ spawns = ∅`. |
| I8 | Existe un entero `D` tal que `d1(spawn_i, goal_i) = D` para todo `i`. |
| I9 | `2 <= D <= 2*(size-1)`. |
| I10 | Si `mode = perimeter`, cada spawn está en el borde y no es una esquina. |
| I11 | Si `mode = central`, cada spawn está dentro de la zona interior definida en la sección 4.3. |
| I12 | Si `mode = random`, los spawns se muestrean uniformemente sin reemplazo de todo el tablero. |
| I13 | `sampleWithoutReplacement` valida `Number.isInteger(count) && count >= 0` antes de cualquier otra comprobación; si falla, lanza `SpawnGenerationError` con código `INSUFFICIENT_CANDIDATES`. |
| I14 | En cada paso del muestreo, `j = i + min(span - 1, floor(rng() * span))` con `span = |pool| - i`, de modo que `i <= j < |pool|` incluso si un RNG a medida devuelve exactamente `1`. |
| I15 | `DEFAULT_MAX_ATTEMPTS = 32` es una constante nombrada y `maxAttempts` toma ese valor por defecto; `nodeBudget` se valida y normaliza a entero `> 0` (por defecto `DEFAULT_NODE_BUDGET = 20000`). La ruta por defecto no lanza `INVALID_ATTEMPTS`. |

Las restricciones de modo se aplican a los **spawns**. Los goals solo están sujetos a I4, I6, I7 e I8. Un goal puede estar fuera de la zona central o no pertenecer al perímetro.

### 1.3 Fuera de alcance

El generador no decide:

- colores;
- asientos;
- orden de turno;
- orientación visual del tablero;
- validación de caminos con muros;
- reglas de colocación de muros.

La sección 8 describe cómo el llamador puede asignar esos elementos de forma determinista a partir del resultado.

### 1.4 Invariantes verificables del muestreo y los presupuestos

I13, I14 e I15 son comprobables directamente sobre el código y constituyen el contrato exacto que la implementación debe cumplir; en el estado actual de `src/core/spawn.js` todavía no se satisfacen y se aplicarán en una corrección posterior:

- Verificación de I13: con `count = -1`, `1.5`, `NaN` o `undefined`, `sampleWithoutReplacement` lanza `INSUFFICIENT_CANDIDATES` sin consumir RNG; con `count = 0` devuelve `[]` sin consumir RNG.
- Verificación de I14: con un RNG que devuelve siempre `1`, el índice calculado es `pool.length - 1` en el primer paso y sigue dentro de `[i, pool.length)` en todos los pasos; no se produce `undefined` ni desbordamiento.
- Verificación de I15: sin `maxAttempts` ni `nodeBudget` en las opciones se usan `32` y `20000`; con valores no enteros o `<= 0` se normaliza a esos mismos valores, sin lanzar `INVALID_ATTEMPTS`.

Estos tres invariantes se comprueban en el helper de muestreo y en la normalización de opciones, no en `validateResult` (sección 6.3).

---

## 2. Distancia objetivo `D`

### 2.1 Fórmula

Para un tablero de lado `size`, la distancia Manhattan objetivo base es:

```text
D = clamp(round(0.6 * size), 2, 2 * (size - 1))
```

donde:

```text
clamp(x, lo, hi) = min(hi, max(lo, x))
round(x)         = Math.round(x)   // redondeo al entero más cercano
```

En el rango `8..16` el clamp inferior nunca actúa, porque `round(0.6*size) >= 5`. El clamp superior tampoco actúa, porque para `size >= 5` se cumple `0.6*size <= 2*size-2`. Aun así se mantiene el clamp para que la fórmula sea segura fuera del rango nominal.

`D` debe ser un entero. En el rango `8..16` no aparecen empates exactos de `.5`, por lo que el redondeo es estable.

### 2.2 Tabla para `size = 8..16`

| `size` | `0.6*size` | `round` | `D` | `2*(size-1)` | Zona central `lo..hi` | Celdas perímetro | Celdas del diamante teórico |
|---:|---:|---:|---:|---:|---|---:|---:|
| 8 | 4.8 | 5 | 5 | 14 | 2..5 | 24 | 61 |
| 9 | 5.4 | 5 | 5 | 16 | 2..6 | 28 | 61 |
| 10 | 6.0 | 6 | 6 | 18 | 2..7 | 32 | 85 |
| 11 | 6.6 | 7 | 7 | 20 | 2..8 | 36 | 113 |
| 12 | 7.2 | 7 | 7 | 22 | 3..8 | 40 | 113 |
| 13 | 7.8 | 8 | 8 | 24 | 3..9 | 44 | 145 |
| 14 | 8.4 | 8 | 8 | 26 | 3..10 | 48 | 145 |
| 15 | 9.0 | 9 | 9 | 28 | 3..11 | 52 | 181 |
| 16 | 9.6 | 10 | 10 | 30 | 4..11 | 56 | 221 |

Ejemplos focales de la fórmula canónica `D = clamp(round(0.6 * size), 2, 2*(size-1))` con `d1` Manhattan:

| `size` | `0.6 * size` | `round` | `D` |
|---:|---:|---:|---:|
| 8 | 4.8 | 5 | 5 |
| 9 | 5.4 | 5 | 5 |
| 12 | 7.2 | 7 | 7 |
| 16 | 9.6 | 10 | 10 |

Notas:

- `lo = floor(size*0.25)`.
- `hi = ceil(size*0.75) - 1`.
- La zona central es inclusiva en ambos extremos: `lo <= r <= hi` y `lo <= c <= hi`.
- "Celdas del diamante teórico" es `1 + 2*D*(D+1)`, el número de celdas a distancia Manhattan exactamente `D` en una cuadrícula infinita. En tableros finitos y cerca de bordes hay menos celdas.
- "Celdas perímetro" es `4*size - 8`: borde completo menos las 4 esquinas.

### 2.3 Propiedades de `D`

- Todos los jugadores comparten el mismo `D` en una generación concreta.
- `D` no depende de `n` ni de `mode`.
- El fallback puede cambiar `D` a `D'`, pero nunca deja de ser común a todos los jugadores.
- `D` se elige antes de asignar goals.

---

## 3. Interfaces, RNG, determinismo y fábrica

### 3.1 Tipos base

```ts
export type Cell = readonly [row: number, col: number];
export type Rng = () => number; // devuelve un número en [0, 1)

export type SpawnMode = 'random' | 'central' | 'perimeter';

export interface SpawnStrategy {
  readonly mode: SpawnMode;
  generateCandidates(size: number, count: number, rng: Rng): Cell[];
}

export interface GoalAssignment {
  status: 'ok' | 'fail' | 'budget';
  goals?: Cell[];
}

export interface GoalAssigner {
  assign(
    spawns: readonly Cell[],
    distance: number,
    size: number,
    rng: Rng
  ): GoalAssignment;
}

export interface SpawnMeta {
  mode: SpawnMode;
  seed: number | null;
  goalDistance: number;
  attempts: number;
  relaxed: boolean;
}

export interface SpawnResult {
  spawns: Cell[];
  goals: Cell[];
  meta: SpawnMeta;
}
```

### 3.2 Contrato de `generateCandidates`

`SpawnStrategy.generateCandidates(size, count, rng)`:

- devuelve exactamente `count` celdas distintas;
- todas las celdas están dentro del tablero;
- el modo decide el universo de candidatos;
- usa exclusivamente `rng` para todas las decisiones aleatorias;
- si el universo tiene menos de `count` celdas, lanza `SpawnGenerationError` con código `INSUFFICIENT_CANDIDATES`;
- no modifica el estado global.

### 3.3 RNG inyectable: `mulberry32`

El RNG por defecto es `Math.random`. Para tests deterministas se inyecta `mulberry32(seed)`.

```ts
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

Propiedades:

- misma semilla y misma secuencia de llamadas producen la misma secuencia de números;
- no usa `Date.now()`, `Math.random()` ni estado externo;
- acepta semillas `0`, negativas y mayores que `2^32` mediante `>>> 0`;
- el generador solo consume números del RNG inyectado.

### 3.4 Determinismo

Una ejecución es determinista si:

1. se fija `size`, `playerCount`, `mode`;
2. se inyecta un RNG determinista, por ejemplo `mulberry32(seed)`;
3. no se introduce ninguna decisión basada en tiempo real;
4. los presupuestos de búsqueda son fijos y no dependen del reloj.

Con esas condiciones, dos llamadas idénticas devuelven exactamente los mismos spawns, goals y meta (`attempts` incluido).

`Math.random` es el RNG por defecto, pero no es determinista entre ejecuciones. En ese caso `meta.seed` debe ser `null`.

### 3.5 Fábrica de estrategias

La fábrica aplica el patrón Estrategia y permite añadir modos futuros sin modificar el generador.

```ts
const STRATEGIES = new Map<SpawnMode, SpawnStrategy>([
  ['random', new RandomSpawnStrategy()],
  ['central', new CentralSpawnStrategy()],
  ['perimeter', new PerimeterSpawnStrategy()],
]);

export function getSpawnStrategy(mode: SpawnMode): SpawnStrategy {
  const strategy = STRATEGIES.get(mode);
  if (!strategy) {
    throw new InvalidConfigError('UNKNOWN_MODE', { mode });
  }
  return strategy;
}

export function registerSpawnStrategy(
  mode: string,
  strategy: SpawnStrategy
): void {
  STRATEGIES.set(mode as SpawnMode, strategy);
}
```

Un modo futuro, por ejemplo `symmetric` o `diagonal`, solo necesita implementar `SpawnStrategy` y registrarse. El asignador de goals, los reintentos, el fallback y la validación se reutilizan.

### 3.6 Meta obligatoria

| Campo | Tipo | Significado |
|---|---|---|
| `mode` | `SpawnMode` | Modo efectivo usado. |
| `seed` | `number \| null` | Semilla registrada, o `null`. |
| `goalDistance` | `number` | `D` efectivo: el base o el del fallback. |
| `attempts` | `number` | Número total de intentos de generación de spawns. |
| `relaxed` | `boolean` | `true` si `goalDistance` proviene del fallback. |

`relaxed === (goalDistance !== D_base)`.

---

## 4. Estrategias de spawn

Las estrategias implementan el patrón Estrategia y solo se responsabilizan de elegir `n` celdas distintas del universo que define su modo. Todas usan el mismo helper de muestreo (`sampleWithoutReplacement`, sección 4.5), de modo que la uniformidad, el consumo de RNG y el tratamiento de errores son comunes.

Convención de orden canónico: las celdas se enumeran inicialmente en orden fila-columna (`r` ascendente y, para cada `r`, `c` ascendente). Es solo el punto de partida: antes de asignar metas, cada lista de candidatos se baraja con el `rng` inyectado (sección 5.2), de modo que el orden fila-columna no sesga las posiciones finales.

### 4.1 `RandomSpawnStrategy`

Universo: todas las celdas del tablero, `size * size`. Muestreo uniforme sin reemplazo.

```ts
export class RandomSpawnStrategy implements SpawnStrategy {
  readonly mode = 'random' as const;

  generateCandidates(size: number, count: number, rng: Rng): Cell[] {
    const universe: Cell[] = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        universe.push([r, c]);
      }
    }
    return sampleWithoutReplacement(universe, count, rng);
  }
}
```

Cumple I12 por construcción: cada subconjunto de `count` celdas tiene la misma probabilidad de ser elegido. El coste es `O(size^2)` en tiempo y espacio, más `O(count)` de muestreo.

### 4.2 `PerimeterSpawnStrategy`

Universo: borde completo menos las cuatro esquinas, `4 * size - 8` celdas. Muestreo uniforme sin reemplazo sobre ese universo.

```ts
export class PerimeterSpawnStrategy implements SpawnStrategy {
  readonly mode = 'perimeter' as const;

  generateCandidates(size: number, count: number, rng: Rng): Cell[] {
    const universe: Cell[] = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const onBorder =
          r === 0 || r === size - 1 || c === 0 || c === size - 1;
        const isCorner =
          (r === 0 || r === size - 1) && (c === 0 || c === size - 1);
        if (onBorder && !isCorner) {
          universe.push([r, c]);
        }
      }
    }
    return sampleWithoutReplacement(universe, count, rng);
  }
}
```

Conteo: `(size - 2)` celdas en la fila superior, `(size - 2)` en la inferior, `(size - 2)` en la columna izquierda y `(size - 2)` en la derecha; total `4 * (size - 2) = 4 * size - 8`. Para `size = 8` son 24 celdas. Cumple I10.

### 4.3 `CentralSpawnStrategy`

Universo: zona central inclusiva definida por:

```text
lo = floor(size * 0.25)
hi = ceil(size * 0.75) - 1
```

```ts
export class CentralSpawnStrategy implements SpawnStrategy {
  readonly mode = 'central' as const;

  generateCandidates(size: number, count: number, rng: Rng): Cell[] {
    const lo = Math.floor(size * 0.25);
    const hi = Math.ceil(size * 0.75) - 1;
    const universe: Cell[] = [];
    for (let r = lo; r <= hi; r++) {
      for (let c = lo; c <= hi; c++) {
        universe.push([r, c]);
      }
    }
    return sampleWithoutReplacement(universe, count, rng);
  }
}
```

La zona es inclusiva en ambos extremos: `lo <= r <= hi` y `lo <= c <= hi`. El número de celdas es `(hi - lo + 1)^2` y coincide con la columna "Zona central" de la tabla 2.2. Para `size = 8`, `lo = 2`, `hi = 5`, es decir, 16 celdas. Cumple I11.

### 4.4 Capacidad mínima de candidatos

La capacidad de cada modo depende solo de `size`, no de `n`. La tabla siguiente compara la capacidad con el máximo `n = 8`.

| `size` | Celdas tablero | `random` | `perimeter` | Lado central | `central` | Mínimo entre modos | ¿Soporta `n <= 8`? |
|---:|---:|---:|---:|---:|---:|---:|:---:|
| 8 | 64 | 64 | 24 | 4 | 16 | 16 | Sí |
| 9 | 81 | 81 | 28 | 5 | 25 | 25 | Sí |
| 10 | 100 | 100 | 32 | 6 | 36 | 32 | Sí |
| 11 | 121 | 121 | 36 | 7 | 49 | 36 | Sí |
| 12 | 144 | 144 | 40 | 6 | 36 | 36 | Sí |
| 13 | 169 | 169 | 44 | 7 | 49 | 44 | Sí |
| 14 | 196 | 196 | 48 | 8 | 64 | 48 | Sí |
| 15 | 225 | 225 | 52 | 9 | 81 | 52 | Sí |
| 16 | 256 | 256 | 56 | 8 | 64 | 56 | Sí |

Demostración de suficiencia para todo el rango nominal:

- `random`: `size^2 >= 8^2 = 64 >= 8`.
- `perimeter`: `4 * size - 8 >= 4 * 8 - 8 = 24 >= 8`.
- `central`: el lado de la zona central es `w = hi - lo + 1`. Para `size >= 8`, `w >= 4` (mínimo en `size = 8`), luego `w^2 >= 16 >= 8`.

Por tanto, para `size >= 8` y `n <= 8` los tres modos siempre tienen candidatos suficientes. En el rango nominal `INSUFFICIENT_CANDIDATES` no puede ocurrir con las estrategias incluidas; el error existe como defensa para estrategias registradas a medida, modos futuros o parámetros fuera de rango que llegasen a saltarse la validación de entrada.

### 4.5 `sampleWithoutReplacement(universe, count, rng)`

Muestreo uniforme sin reemplazo mediante Fisher-Yates parcial sobre una copia del universo. El RNG solo decide el índice `j` de cada paso.

```ts
export function sampleWithoutReplacement(
  universe: readonly Cell[],
  count: number,
  rng: Rng
): Cell[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new SpawnGenerationError('INSUFFICIENT_CANDIDATES', { count });
  }
  if (count > universe.length) {
    throw new SpawnGenerationError('INSUFFICIENT_CANDIDATES', {
      count,
      available: universe.length,
    });
  }

  const pool = universe.slice();
  for (let i = 0; i < count; i++) {
    const span = pool.length - i;
    const j = i + Math.min(span - 1, Math.floor(rng() * span));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, count);
}
```

Pseudocódigo equivalente:

```text
sampleWithoutReplacement(universe, count, rng):
  si count no es entero >= 0: error INSUFFICIENT_CANDIDATES
  si count > |universe|: error INSUFFICIENT_CANDIDATES
  pool = copia(universe)
  para i = 0 .. count-1:
    span = |pool| - i
    j = i + min(span - 1, floor(rng() * span))
    intercambiar(pool[i], pool[j])
  devolver pool[0 .. count-1]
```

Propiedades:

- uniforme: cada subconjunto de tamaño `count` es igualmente probable;
- sin reemplazo: los `count` resultados son distintos;
- consume exactamente `count` números del RNG (si `count = 0`, ninguno);
- no muta `universe`, porque trabaja sobre una copia;
- I13: `Number.isInteger(count) && count >= 0` se comprueba antes que `count > universe.length`, de modo que un `count` negativo o no entero se rechaza con `INSUFFICIENT_CANDIDATES`;
- I14: `Math.min(span - 1, floor(rng() * span))` garantiza `i <= j < |pool|` aunque un RNG a medida devuelva exactamente `1`; sin el `min`, `j` valdría `|pool|` y se introduciría `undefined`;
- coste temporal `O(|universe| + count)`, espacial `O(|universe|)`.

El contrato de I13 e I14 es verificable y se detalla en la sección 1.4; la implementación actual de `src/core/spawn.js` debe ajustarse a él.

---

## 5. Asignación de objetivos equidistantes

### 5.1 Definición

Sea `S = {spawn_0, ..., spawn_{n-1}}` el conjunto de spawns y sea `D_eff` la distancia efectiva común. Para cada jugador `i`, el conjunto de goals candidatos es:

```text
G_i = { g celda válida :
        d1(spawn_i, g) = D_eff
        y g ∉ S
        y g no está asignada a otro jugador }
```

La condición `g ∉ S` implementa I7 y es global: un goal no puede coincidir con el spawn de ningún jugador, ni siquiera con el de otro. La condición "no asignada a otro jugador" implementa I6 y se controla dinámicamente durante la búsqueda.

El objetivo es encontrar una asignación inyectiva `i -> goal_i ∈ G_i` para todos los jugadores, con el mismo `D_eff`.

### 5.2 Algoritmo con backtracking y MRV

El problema es un matching perfecto en un grafo bipartito entre jugadores y celdas. Se resuelve con backtracking y MRV (*minimum remaining values*) **dinámico por nivel**: en cada nodo de la búsqueda se recalcula cuántos candidatos libres tiene cada jugador aún no asignado, y se elige primero quien tiene menos. No existe un orden inicial fijo calculado una sola vez; la selección se repite después de cada asignación porque el conjunto `used` reduce las opciones de los jugadores restantes. Los empates se rompen por índice de jugador más bajo, ya que `remaining` conserva el orden ascendente y la comparación es estrictamente menor. Los candidatos de cada jugador se generan en orden canónico fila-columna, pero se barajan con Fisher-Yates usando el mismo `rng` del generador antes de la búsqueda; el backtracking recorre ese orden aleatorio. Todo ello hace la búsqueda determinista para una misma `seed`.

```ts
function cellKey([r, c]: Cell): string {
  return `${r},${c}`;
}

function cellsAtDistance(from: Cell, distance: number, size: number): Cell[] {
  const out: Cell[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const d = Math.abs(r - from[0]) + Math.abs(c - from[1]);
      if (d === distance) out.push([r, c]);
    }
  }
  return out;
}

function assignGoals(
  spawns: readonly Cell[],
  distance: number,
  size: number,
  nodeBudget: number,
  rng: () => number
): GoalAssignment {
  const n = spawns.length;
  const spawnSet = new Set(spawns.map(cellKey));
  const candidates: Cell[][] = [];

  for (let i = 0; i < n; i++) {
    const cells = cellsAtDistance(spawns[i], distance, size)
      .filter((cell) => !spawnSet.has(cellKey(cell)));
    if (cells.length === 0) return { status: 'fail' };
    candidates.push(sampleWithoutReplacement(cells, cells.length, rng));
  }

  const goals = new Array<Cell | null>(n).fill(null);
  const used = new Set<string>();
  let nodes = 0;
  let exhausted = false;

  const search = (remaining: number[]): boolean => {
    if (remaining.length === 0) return true;
    if (++nodes > nodeBudget) {
      exhausted = true;
      return false;
    }

    let chosenPlayer = -1;
    let chosenOptions: Cell[] = [];
    for (const player of remaining) {
      const options = candidates[player].filter(
        (cell) => !used.has(cellKey(cell))
      );
      if (options.length === 0) return false;
      if (chosenPlayer === -1 || options.length < chosenOptions.length) {
        chosenPlayer = player;
        chosenOptions = options;
      }
    }

    const nextRemaining = remaining.filter((p) => p !== chosenPlayer);
    for (const cell of chosenOptions) {
      const key = cellKey(cell);
      used.add(key);
      goals[chosenPlayer] = cell;

      if (search(nextRemaining)) return true;

      goals[chosenPlayer] = null;
      used.delete(key);
      if (exhausted) return false;
    }
    return false;
  };

  const allPlayers = spawns.map((_, i) => i);
  if (!search(allPlayers)) {
    return { status: exhausted ? 'budget' : 'fail' };
  }
  return { status: 'ok', goals: goals as Cell[] };
}
```

Detalles:

- `spawnSet` excluye todos los spawns antes de empezar; así ningún candidato viola I7.
- `used` garantiza I6 en cada rama y se aplica también al filtrar opciones al recalcular MRV.
- MRV se recalcula en cada llamada a `search` usando `remaining` y `used`; no existe un `order` precalculado. El desempate por índice de `player` más bajo evita ambigüedad.
- Si algún jugador pendiente se queda sin opciones libres, la rama se descarta de inmediato (`return false`).
- El presupuesto `nodeBudget` cuenta llamadas a `search`. Si se agota, se devuelve `status: 'budget'`; el llamador lo trata como intento fallido.
- Consume RNG solo para barajar los candidatos de cada jugador. La búsqueda posterior es determinista para un conjunto de spawns, un `D` y una secuencia de RNG dados.

### 5.3 Fallback de distancia

Si con la `D` base no existe asignación completa (o se agota el presupuesto), se prueban otras distancias comunes manteniendo siempre la misma para todos los jugadores. El orden es determinista: `D`, `D-1`, `D+1`, `D-2`, `D+2`, ... dentro de `[2, 2*(size-1)]`. Las distancias fuera del rango se omiten.

```ts
function* distanceOrder(base: number, size: number): Generator<number> {
  const lo = 2;
  const hi = 2 * (size - 1);
  yield base;
  for (let delta = 1; delta <= hi - lo; delta++) {
    const lower = base - delta;
    if (lower >= lo) yield lower;
    const upper = base + delta;
    if (upper <= hi) yield upper;
  }
}

function assignGoalsWithFallback(
  spawns: readonly Cell[],
  baseDistance: number,
  size: number,
  nodeBudget: number
): { goals: Cell[]; goalDistance: number; relaxed: boolean } {
  for (const distance of distanceOrder(baseDistance, size)) {
    const attempt = assignGoals(spawns, distance, size, nodeBudget);
    if (attempt.status === 'ok') {
      return {
        goals: attempt.goals!,
        goalDistance: distance,
        relaxed: distance !== baseDistance,
      };
    }
  }
  throw new SpawnGenerationError('GOAL_ASSIGNMENT_FAILED', {
    baseDistance,
    size,
    playerCount: spawns.length,
  });
}
```

`goalDistance` del resultado es siempre la distancia efectiva `D_eff`. `relaxed` es `true` exactamente cuando `D_eff !== D_base`. Si se agotan todas las distancias posibles, se lanza `GOAL_ASSIGNMENT_FAILED` y el generador puede reintentar con nuevos spawns.

### 5.4 Reintentos de spawns

La generación completa se intenta hasta `maxAttempts = 32` veces. Cada intento:

1. muestrea `n` spawns nuevos con la misma instancia de `rng` inyectada (no se reinicia);
2. calcula la `D` base;
3. intenta la asignación con fallback de distancia;
4. si tiene éxito, valida invariantes y devuelve el primer resultado válido;
5. si la asignación falla, consume el siguiente estado del RNG y prueba otro conjunto de spawns.

```ts
export function generateSpawnsAndGoals({
  size,
  playerCount,
  mode,
  rng = Math.random,
  seed = null,
  maxAttempts = 32,
  nodeBudget = 20000,
}: GenerateOptions): SpawnResult {
  validateConfig(size, playerCount, mode);
  const strategy = getSpawnStrategy(mode);
  const baseD = baseDistance(size);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const spawns = strategy.generateCandidates(size, playerCount, rng);

    try {
      const assignment = assignGoalsWithFallback(
        spawns,
        baseD,
        size,
        nodeBudget
      );

      const result: SpawnResult = {
        spawns,
        goals: assignment.goals,
        meta: {
          mode,
          seed,
          goalDistance: assignment.goalDistance,
          attempts: attempt,
          relaxed: assignment.relaxed,
        },
      };

      validateResult(result, size, mode);
      return result;
    } catch (error) {
      if (error instanceof SpawnGenerationError) {
        if (error.code === 'INSUFFICIENT_CANDIDATES') throw error;
        if (error.code === 'GOAL_ASSIGNMENT_FAILED') continue;
      }
      throw error;
    }
  }

  throw new SpawnGenerationError('RETRY_EXHAUSTED', {
    attempts: maxAttempts,
    size,
    playerCount,
    mode,
  });
}
```

`attempts` en `meta` es el número de intento que produjo el resultado, empezando en 1. Como el RNG se reutiliza sin reiniciarse, para una misma semilla la secuencia completa de intentos es reproducible: mismos spawns, mismos goals, mismos `attempts` y mismo `relaxed`.

`INSUFFICIENT_CANDIDATES` no se reintenta porque el tamaño del universo no cambia entre intentos; es un error de configuración/estrategia no recuperable. `GOAL_ASSIGNMENT_FAILED` sí se reintenta porque un nuevo muestreo de spawns puede admitir una asignación.

### 5.5 Ejemplo resuelto: `size = 8`, `n = 4`, modo `perimeter`, `D = 5`

Supongamos que el primer intento produce estos spawns (todos en el borde y ninguno en esquina):

```text
Jugador A: spawn (0, 1)
Jugador B: spawn (2, 7)
Jugador C: spawn (7, 6)
Jugador D: spawn (5, 0)
```

`S = {(0,1), (2,7), (7,6), (5,0)}`. Candidatos a distancia Manhattan exactamente 5 que no pertenecen a `S`, enumerados en orden fila-columna antes de barajar:

| Jugador | Spawn | Nº candidatos | Candidatos |
|---|---|---|---:|
| A | `(0,1)` | 7 | `(0,6)`, `(1,5)`, `(2,4)`, `(3,3)`, `(4,0)`, `(4,2)`, `(5,1)` |
| B | `(2,7)` | 8 | `(0,4)`, `(1,3)`, `(2,2)`, `(3,3)`, `(4,4)`, `(5,5)`, `(6,6)`, `(7,7)` |
| C | `(7,6)` | 7 | `(2,6)`, `(3,5)`, `(3,7)`, `(4,4)`, `(5,3)`, `(6,2)`, `(7,1)` |
| D | `(5,0)` | 8 | `(0,0)`, `(1,1)`, `(2,2)`, `(3,3)`, `(4,4)`, `(5,5)`, `(6,4)`, `(7,3)` |

Tras barajar cada lista con el `rng`, MRV recalcula los pendientes en cada nivel y el desempate por índice más bajo resuelve las igualdades. Una posible asignación es:

| Paso | Jugador | Candidato elegido | Estado |
|---:|---|---|---|
| 1 | A | `(5,1)` | primero libre de A tras el barajado |
| 2 | C | `(7,1)` | no usado por A |
| 3 | B | `(5,5)` | no usado por A ni C |
| 4 | D | `(6,4)` | no usado por A, B ni C |

Resultado:

```text
goal_A = (5,1)   d1((0,1),(5,1)) = 5
goal_B = (5,5)   d1((2,7),(5,5)) = 3 + 2 = 5
goal_C = (7,1)   d1((7,6),(7,1)) = 5
goal_D = (6,4)   d1((5,0),(6,4)) = 1 + 4 = 5
```

Los cuatro goals son distintos entre sí, ninguno coincide con un spawn y el barajado evita concentrarlos en la fila 0. Con otra semilla la asignación será distinta pero seguirá cumpliendo las invariantes. La rama elegida tiene éxito sin retroceso. Si una elección temprana bloquease a un jugador posterior, el backtracking probaría el siguiente candidato de la lista barajada, y así sucesivamente hasta agotar el presupuesto o encontrar matching. En este ejemplo `relaxed = false`, `goalDistance = 5` y `attempts = 1`.

---

## 6. Algoritmo completo y pseudocódigo

### 6.1 Firma y validación de entrada

```ts
export interface GenerateOptions {
  size: number;
  playerCount: number;
  mode: SpawnMode;
  rng?: Rng;
  seed?: number | null;
  maxAttempts?: number;
  nodeBudget?: number;
}

export function baseDistance(size: number): number {
  return Math.min(
    2 * (size - 1),
    Math.max(2, Math.round(0.6 * size))
  );
}

function validateConfig(
  size: number,
  playerCount: number,
  mode: SpawnMode
): void {
  if (!Number.isInteger(size) || size < 8 || size > 16) {
    throw new InvalidConfigError('INVALID_SIZE', { size });
  }
  if (
    !Number.isInteger(playerCount) ||
    playerCount < 2 ||
    playerCount > 8
  ) {
    throw new InvalidConfigError('INVALID_PLAYER_COUNT', { playerCount });
  }
  if (mode !== 'random' && mode !== 'central' && mode !== 'perimeter') {
    throw new InvalidConfigError('UNKNOWN_MODE', { mode });
  }
}
```

Reglas de normalización de presupuestos (I15):

- `DEFAULT_MAX_ATTEMPTS = 32` es la constante nombrada; `maxAttempts` vale `32` cuando se omite.
- `maxAttempts` se valida como entero `> 0`; si no lo es, se normaliza a `DEFAULT_MAX_ATTEMPTS` en lugar de lanzar `INVALID_ATTEMPTS`.
- `DEFAULT_NODE_BUDGET = 20000` es la constante nombrada; `nodeBudget` vale `20000` cuando se omite.
- `nodeBudget` se valida como entero `> 0`; si no lo es, se normaliza a `DEFAULT_NODE_BUDGET`. Ambos presupuestos son finitos y no dependen del reloj.
- `seed` es solo metadato: el generador no lo usa para construir el RNG. El llamador construye `mulberry32(seed)` y lo inyecta como `rng`.
- Si no se inyecta `rng`, se usa `Math.random` y `seed` debe quedarse en `null`.

La ruta por defecto no lanza `INVALID_ATTEMPTS`; ese código no forma parte del contrato canónico. La verificación de I15 se recoge en la sección 1.4.

### 6.2 Flujo completo

```text
generateSpawnsAndGoals({size, playerCount, mode, rng, seed, maxAttempts, nodeBudget}):
  validar size, playerCount y mode
  strategy = getSpawnStrategy(mode)
  D_base = clamp(round(0.6 * size), 2, 2*(size-1))

  para attempt = 1 .. maxAttempts:
    spawns = strategy.generateCandidates(size, playerCount, rng)
    comprobar estructura de spawns (longitud, celdas válidas, unicidad, modo)

    intentar:
      asignacion = assignGoalsWithFallback(spawns, D_base, size, nodeBudget)
      resultado = {
        spawns,
        goals: asignacion.goals,
        meta: {
          mode, seed,
          goalDistance: asignacion.goalDistance,
          attempts: attempt,
          relaxed: asignacion.goalDistance != D_base
        }
      }
      validateResult(resultado, size, mode)   // I1-I12; I13-I15 por contrato (ver 1.4)
      devolver resultado
    capturar error:
      si código == INSUFFICIENT_CANDIDATES: propagar
      si código == GOAL_ASSIGNMENT_FAILED: continuar con el siguiente attempt
      en otro caso: propagar

  lanzar RETRY_EXHAUSTED
```

### 6.3 Validación final de invariantes

`validateResult` comprueba la estructura completa antes de devolver nada. Si falla alguna comprobación estructural, lanza `SpawnGenerationError` con código `INVARIANT_VIOLATION` y detalles para diagnóstico.

| ID | Comprobación en `validateResult` |
|---|---|
| I1 | `n === playerCount` y `2 <= n <= 8` (el `playerCount` original se pasa como argumento). |
| I2 | `spawns.length === n` y `goals.length === n`. |
| I3 | Cada spawn es entero y está en `[0, size-1]^2`. |
| I4 | Cada goal es entero y está en `[0, size-1]^2`. |
| I5 | `new Set(spawns).size === n`. |
| I6 | `new Set(goals).size === n`. |
| I7 | `spawnSet` y `goalSet` son disjuntos. |
| I8 | `d1(spawn_i, goal_i) === meta.goalDistance` para todo `i`. |
| I9 | `2 <= meta.goalDistance <= 2*(size-1)`. |
| I10 | Si `mode === 'perimeter'`, cada spawn está en el borde y no es esquina. |
| I11 | Si `mode === 'central'`, cada spawn cumple `lo <= r <= hi` y `lo <= c <= hi`. |
| I12 | Se garantiza por construcción: la estrategia `random` muestrea uniformemente sobre todo el tablero. No es verificable sobre una sola salida; se cubre con tests estadísticos y de propiedades. |

I13, I14 e I15 no se comprueban en `validateResult` porque afectan al helper de muestreo y a la normalización de opciones, que ocurren antes de la validación del resultado; se verifican según la sección 1.4. El conjunto completo de invariantes del generador es por tanto I1..I15.

### 6.4 Complejidad

| Fase | Tiempo | Espacio |
|---|---|---|
| Construir universo `random` | `O(size^2)` | `O(size^2)` |
| Construir universo `perimeter` | `O(size)` | `O(size)` |
| Construir universo `central` | `O(size^2)` | `O(size^2)` |
| Muestreo sin reemplazo | `O(size^2 + n)` en `random`; `O(size + n)` en `perimeter`; `O(size^2 + n)` en `central` | `O(size^2)` por la copia |
| Candidatos de goals | `O(n * size^2)` | `O(n * size^2)` |
| Backtracking | `O(nodeBudget * n)` como cota superior | `O(n)` recursión + `O(n * size^2)` listas |
| Por intento | `O(size^2 + n * size^2 + nodeBudget * n)` | `O(n * size^2)` |
| Total con fallback y reintentos | `O(maxAttempts * (2*(size-1)) * (size^2 + n * size^2 + nodeBudget * n))` como cota superior | `O(n * size^2)` |

Los presupuestos están acotados por constantes fijas (`maxAttempts = 32`, `nodeBudget = 20000`), de modo que el peor caso es finito y no depende del reloj. En la práctica, el fallback rara vez prueba más de dos o tres distancias y el primer intento suele bastar.

---

## 7. Errores y contrato

### 7.1 Tipos de error

```ts
export type SpawnErrorCode =
  | 'INSUFFICIENT_CANDIDATES'
  | 'GOAL_ASSIGNMENT_FAILED'
  | 'RETRY_EXHAUSTED'
  | 'INVARIANT_VIOLATION';

export class SpawnGenerationError extends Error {
  readonly code: SpawnErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: SpawnErrorCode, details?: Record<string, unknown>) {
    super(code);
    this.name = 'SpawnGenerationError';
    this.code = code;
    this.details = details;
  }
}

export type InvalidConfigCode =
  | 'INVALID_SIZE'
  | 'INVALID_PLAYER_COUNT'
  | 'UNKNOWN_MODE';

export class InvalidConfigError extends Error {
  readonly code: InvalidConfigCode;
  readonly details?: Record<string, unknown>;

  constructor(code: InvalidConfigCode, details?: Record<string, unknown>) {
    super(code);
    this.name = 'InvalidConfigError';
    this.code = code;
    this.details = details;
  }
}
```

### 7.2 Tabla de errores

| Error | Código | Cuándo se lanza | Qué debe hacer el servidor |
|---|---|---|---|
| `InvalidConfigError` | `INVALID_SIZE` | `size` no entero o fuera de `8..16`. | Rechazar la creación con `400`, toast de validación, no crear sala. |
| `InvalidConfigError` | `INVALID_PLAYER_COUNT` | `playerCount` no entero o fuera de `2..8`. | Rechazar la creación con `400`, toast de validación, no crear sala. |
| `InvalidConfigError` | `UNKNOWN_MODE` | `mode` no registrado en la fábrica. | Rechazar la creación con `400`, toast "modo no soportado", no crear sala. |
| `SpawnGenerationError` | `INSUFFICIENT_CANDIDATES` | El universo de una estrategia tiene menos de `n` celdas. Defensivo: no ocurre en el rango nominal. | Rechazar con `422`, toast "configuración no soportada", no crear sala ni modificar estado existente. |
| `SpawnGenerationError` | `GOAL_ASSIGNMENT_FAILED` | Ninguna distancia común del fallback produce matching para un conjunto de spawns. Interno de un intento. | Lo captura el generador para reintentar; si se expone, rechazar con `422` y toast. |
| `SpawnGenerationError` | `RETRY_EXHAUSTED` | Se agotaron `maxAttempts` sin un resultado válido. | Rechazar con `422`, toast "no se pudo generar la partida", registrar semilla y modo; permitir reintentar con nueva semilla. |
| `SpawnGenerationError` | `INVARIANT_VIOLATION` | La validación final detecta un fallo interno de I1-I15. | Rechazar con `500`, abortar la creación, alerta de telemetría; nunca publicar estado parcial. |

### 7.3 Contrato de no mutación y RNG

- `generateSpawnsAndGoals` no modifica estado global, ni el registro de estrategias, ni los arrays de entrada.
- Las estrategias crean sus propios universos y `sampleWithoutReplacement` copia antes de mezclar.
- El resultado contiene arrays nuevos; el llamador puede mutarlos sin afectar al generador.
- Si el llamador inyecta `rng`, el generador **no llama** a `Math.random` en ningún punto. `Math.random` es únicamente el valor por defecto cuando no se inyecta RNG.
- El mismo `rng` se usa para muestrear spawns y para barajar los candidatos de metas; no hay otras fuentes de aleatoriedad.
- El generador no llama a `Date.now()`, `performance.now()` ni temporizadores. Los presupuestos son numéricos y fijos.
- `meta.seed` es un eco del valor recibido. El generador no reconstruye el RNG a partir de la semilla; eso lo hace el llamador con `mulberry32(seed)`.

### 7.4 Creación atómica de partida

El servidor debe generar y validar por completo `SpawnResult` **antes** de crear o modificar la sala. Si cualquier error se propaga:

1. no se escribe nada en el almacén de partidas;
2. no se emite estado público a los clientes;
3. se responde al cliente con el código HTTP adecuado y un toast;
4. se registra el fallo con `{ size, playerCount, mode, seed, code, details }`;
5. si procede, se ofrece reintentar con una semilla nueva.

---

## 8. Integración con el motor y el servidor

### 8.1 Asignación determinista de colores y asientos

El generador no decide colores, asientos ni orden de turno. El servidor deriva un rango determinista a partir de los spawns. La opción recomendada es ordenar los índices de jugador por `(spawn.row, spawn.col)` ascendente; como los spawns son distintos (I5), no hay empates.

```ts
function assignColorIndex(spawns: readonly Cell[]): number[] {
  const order = spawns
    .map((spawn, player) => ({ player, spawn }))
    .sort((a, b) =>
      a.spawn[0] - b.spawn[0] || a.spawn[1] - b.spawn[1]
    );

  const colorIndex = new Array<number>(spawns.length);
  order.forEach(({ player }, rank) => {
    colorIndex[player] = rank;
  });
  return colorIndex;
}
```

Alternativas válidas: usar el orden de unión de los jugadores o el orden de llegada, siempre que el servidor lo fije antes de generar y lo documente. En cualquier caso, el generador no depende de ello y el resultado de spawns/goals no cambia.

`colorIndex` es un índice de paleta `0..n-1`, no un color concreto. La paleta y su representación visual pertenecen a la interfaz.

### 8.2 Paso al `GameEngine` y al estado público

```ts
const result = generateSpawnsAndGoals({
  size,
  playerCount,
  mode,
  rng,
  seed,
  maxAttempts: 32,
  nodeBudget: 20000,
});

const colorIndex = assignColorIndex(result.spawns);

const players = result.spawns.map((spawn, i) => ({
  spawn,
  goal: result.goals[i],
  colorIndex: colorIndex[i],
}));

engine.createGame({
  size,
  players,
  meta: {
    gameId,
    seed,
    spawn: result.meta,
  },
});
```

El estado público expone, como mínimo:

| Campo | Tipo | Origen |
|---|---|---|
| `players[i].spawn` | `Cell` | `result.spawns[i]` |
| `players[i].goal` | `Cell` | `result.goals[i]` |
| `players[i].colorIndex` | `number` | `assignColorIndex(result.spawns)[i]` |

No se expone el RNG. La semilla puede exponerse o mantenerse privada; si se expone, conviene hacerlo solo al finalizar la partida o en herramientas de depuración.

### 8.3 Semilla por partida y rematch

El servidor genera una semilla nueva por partida con `crypto.randomInt` y la registra en `gameId`/meta. Un rematch genera una semilla nueva y, por tanto, spawns y goals nuevos.

```ts
import { randomInt } from 'node:crypto';

const seed = randomInt(0, 2 ** 32);
const rng = mulberry32(seed);
const gameId = `game_${seed.toString(16)}_${randomInt(0, 2 ** 32).toString(16)}`;
```

Recomendaciones:

- guardar `{ seed, mode, goalDistance, attempts, relaxed }` junto a la partida;
- no reutilizar la semilla en un rematch;
- si el cliente solicita reproducir una partida, reconstruir con `mulberry32(seed)` y los mismos parámetros;
- si se usa `Math.random` (solo en entornos sin semilla), registrar `seed: null` y no prometer reproducibilidad.

### 8.4 Ejemplo de llamada y JSON de resultado

```ts
const seed = 123456789;
const result = generateSpawnsAndGoals({
  size: 8,
  playerCount: 4,
  mode: 'perimeter',
  rng: mulberry32(seed),
  seed,
  maxAttempts: 32,
  nodeBudget: 20000,
});
```

Resultado ilustrativo (mismo escenario que la sección 5.5):

```json
{
  "spawns": [[0, 1], [2, 7], [7, 6], [5, 0]],
  "goals": [[5, 1], [5, 5], [7, 1], [6, 4]],
  "meta": {
    "mode": "perimeter",
    "seed": 123456789,
    "goalDistance": 5,
    "attempts": 1,
    "relaxed": false
  }
}
```

A partir de ahí, `assignColorIndex` ordena los spawns por fila y columna. El orden de rangos es `(0,1) -> 0`, `(2,7) -> 1`, `(5,0) -> 2`, `(7,6) -> 3`, así que los jugadores A, B, C y D reciben `colorIndex` 0, 1, 3 y 2 respectivamente.

---

## 9. Casos límite

| Caso | Comportamiento esperado |
|---|---|
| `size = 8`, `n = 8`, `random` | Universo de 64 celdas; 8 spawns únicos; `D = 5`. |
| `size = 8`, `n = 8`, `perimeter` | Universo de 24 celdas; 8 spawns únicos del borde sin esquinas; `D = 5`; nunca `INSUFFICIENT_CANDIDATES`. |
| `size = 8`, `n = 8`, `central` | Universo de 16 celdas (`2..5`); 8 spawns únicos; margen suficiente. |
| `size = 16`, `n = 8` | `D = 10`; perímetro 56 y central 64; holgura amplia. |
| Goals en esquinas | Permitido. I7 solo prohíbe que un goal coincida con un spawn. El ejemplo de 5.5 usa `(0,0)` como goal. |
| Spawn en esquina | Permitido en `random`; prohibido en `perimeter` (I10). `central` tampoco incluye esquinas. |
| `D` cerca del máximo | `D_max = 2*(size-1)` solo lo alcanzan pares de esquinas opuestas. Con `n > 2` no hay matching posible; el fallback baja la distancia y marca `relaxed = true`. En `perimeter`, como los spawns no pueden ser esquinas, `D_max` es directamente inalcanzable y también se relaja. |
| `D` fuera de rango en fallback | `distanceOrder` omite valores `< 2` o `> 2*(size-1)`; nunca se genera un `D_eff` inválido (I9). |
| Spawn y goal del mismo jugador | No pueden coincidir porque `D >= 2`; además I7 lo prohíbe explícitamente. |
| Goal igual a otro spawn | Imposible: todos los candidatos se filtran contra `spawnSet` antes de asignar (I7). |
| Simetría | No se garantiza. `random` puede producir configuraciones asimétricas; es válido. Un modo simétrico futuro puede registrarse como estrategia nueva. |
| Tableros impares (`size = 9, 11, ...`) | Las fórmulas `lo = floor(size*0.25)` y `hi = ceil(size*0.75)-1` siguen siendo válidas; la zona central tiene lado impar. |
| Semilla `0` | `mulberry32(0)` es válido y determinista; `seed >>> 0` produce `0`. |
| Semilla negativa | `mulberry32(-1)` normaliza con `>>> 0`; la secuencia es determinista. `meta.seed` conserva el valor recibido. |
| Semilla `null` con `Math.random` | No hay reproducibilidad; `meta.seed` debe ser `null`. El generador no debe fingir una semilla. |
| `maxAttempts = 1` y fallo de asignación | Se lanza `RETRY_EXHAUSTED` con `attempts: 1`; no se devuelve un resultado parcial. |
| `nodeBudget` muy bajo | La asignación devuelve `status: 'budget'`; se trata como intento fallido y puede acabar en `RETRY_EXHAUSTED`. No se relajan invariantes. |
| Estrategia futura con menos candidatos que `n` | Lanza `INSUFFICIENT_CANDIDATES`; el generador no la reintenta. |
| `n` distinto de 8 | El generador usa exactamente `playerCount`; no completa hasta 8. |

---

## 10. Matriz de pruebas (test vectors)

Todas las filas con `seed` numérica son deterministas. Las celdas marcadas **golden** se rellenan con el valor observado en la primera ejecución de referencia y pasan a ser aserciones exactas de `relaxed` y `attempts`.

| # | `size` | `n` | `mode` | `seed` | `D` base | Propiedades esperadas |
|---:|---:|---:|---|---:|---:|---|
| 1 | 8 | 2 | `random` | `0` | 5 | 2 spawns y 2 goals únicos; `d1 = 5`; sin solape; `relaxed` y `attempts` golden. |
| 2 | 8 | 4 | `perimeter` | `123456789` | 5 | 4/4; todos los spawns en borde sin esquinas; `d1 = 5`; sin solape; `relaxed` y `attempts` golden. |
| 3 | 8 | 8 | `perimeter` | `42` | 5 | 8/8 desde 24 candidatos; spawns de borde no esquina; sin solape; `relaxed` y `attempts` golden. |
| 4 | 8 | 8 | `central` | `1` | 5 | 8/8 dentro de `2..5`; sin solape; `relaxed` y `attempts` golden. |
| 5 | 9 | 3 | `central` | `0xFFFFFFFF` | 5 | 3/3 dentro de `2..6`; `d1 = 5`; determinista con semilla máxima de 32 bits. |
| 6 | 10 | 5 | `random` | `-1` | 6 | 5/5; semilla negativa normalizada; `d1 = 6`; sin solape. |
| 7 | 12 | 6 | `perimeter` | `987654321` | 7 | 6/6 desde 40 candidatos de perímetro; `d1 = 7`; sin solape. |
| 8 | 13 | 8 | `central` | `7` | 8 | 8/8 dentro de `3..9`; `d1 = 8`; sin solape. |
| 9 | 15 | 7 | `random` | `555` | 9 | 7/7; `d1 = 9`; sin solape; `relaxed` y `attempts` golden. |
| 10 | 16 | 8 | `random` | `2026` | 10 | 8/8; `d1 = 10`; sin solape; `relaxed` y `attempts` golden. |
| 11 | 16 | 8 | `perimeter` | `9` | 10 | 8/8 desde 56 candidatos; `d1 = 10`; sin solape. |
| 12 | 16 | 8 | `perimeter` | `123` | 10 | 8/8 desde 56 candidatos; `d1 = 10`; sin solape. |
| 13 | 16 | 2 | `central` | `0` | 10 | 2/2 dentro de `4..11`; `d1 = 10`; sin solape. |
| 14 | 8 | 8 | `random` | `1` | 5 | 8/8 desde 64 celdas; `d1 = 5`; uniformidad verificada por propiedades estadísticas, no por una salida única. |
| 15 | 8 | 2 | `central` | `2` | 5 | 2/2 dentro de `2..5`; `d1 = 5`; sin solape; `relaxed` y `attempts` golden. |
| 16 | 12 | 4 | `random` | `1..200` | 7 | 4 goals por semilla con cobertura de filas, columnas, bordes y zona interior; `d1 = 7`; sin solape. |

### 10.1 Propiedades invariantes

Con fast-check o con bucles deterministas sobre semillas fijas, comprobar para toda configuración válida:

```ts
for (const size of range(8, 16)) {
  for (const n of range(2, 8)) {
    for (const mode of ['random', 'central', 'perimeter'] as const) {
      const seed = 1000 + size * 100 + n;
      const r1 = generateSpawnsAndGoals({
        size, playerCount: n, mode,
        rng: mulberry32(seed), seed,
      });
      const r2 = generateSpawnsAndGoals({
        size, playerCount: n, mode,
        rng: mulberry32(seed), seed,
      });

      assert.deepEqual(r1, r2);
      assert.equal(r1.spawns.length, n);
      assert.equal(r1.goals.length, n);
      assert.equal(new Set(r1.spawns.map(String)).size, n);
      assert.equal(new Set(r1.goals.map(String)).size, n);

      const spawnSet = new Set(r1.spawns.map(String));
      for (const goal of r1.goals) {
        assert(!spawnSet.has(String(goal)));
      }

      for (let i = 0; i < n; i++) {
        assert.equal(
          dist(r1.spawns[i], r1.goals[i]),
          r1.meta.goalDistance
        );
      }
      assert(r1.meta.goalDistance >= 2);
      assert(r1.meta.goalDistance <= 2 * (size - 1));
      assert.equal(r1.meta.relaxed, r1.meta.goalDistance !== baseDistance(size));
    }
  }
}
```

Propiedades a cubrir:

1. I1-I15 para todas las combinaciones `size × n × mode` del rango nominal.
2. Misma semilla y mismos parámetros producen resultados profundamente iguales, incluido `meta`.
3. El RNG inyectado es la única fuente de aleatoriedad: sustituir `Math.random` por una función que lance un error y comprobar que la generación con `rng` inyectado sigue funcionando.
4. `seed: null` con `Math.random` simulado produce `meta.seed === null` y resultados reproducibles bajo el mismo mock.
5. No mutación: congelar los arrays de entrada y comprobar que no cambian; comprobar que el resultado no comparte referencias con el universo interno.
6. Modo `perimeter`: todos los spawns en el borde y ninguno en esquina.
7. Modo `central`: todos los spawns dentro de `[lo, hi]^2`.
8. Modo `random`: cobertura estadística aproximada de celdas y comprobación de unicidad.
9. Fallback: con spawns fabricados que fallen en `D` base, verificar que `goalDistance` cambia y `relaxed === true`.
10. Presupuesto: `nodeBudget` bajo produce `status: 'budget'` en el asignador y `RETRY_EXHAUSTED` en el generador con `maxAttempts = 1`.
11. I13: `sampleWithoutReplacement` con `count` negativo, no entero o `NaN` lanza `INSUFFICIENT_CANDIDATES` sin consumir RNG; con `count = 0` devuelve `[]`.
12. I14: un RNG que devuelve siempre `1` mantiene el índice en `[i, |pool|)` y produce `count` celdas válidas y distintas.
13. I15: al omitir presupuestos se usan `32` y `20000`; los valores no enteros o `<= 0` se normalizan sin lanzar `INVALID_ATTEMPTS`.
14. Distribución de metas: con semillas fijas, las goals aparecen en varias filas y columnas (incluidas la fila inferior y la zona interior), sin concentrarse en la fila 0; se comprueban además unicidad, equidistancia y ausencia de solape con spawns.

### 10.2 Pruebas de error

| Entrada | Error esperado |
|---|---|
| `size = 7` | `InvalidConfigError` con `code = 'INVALID_SIZE'`. |
| `size = 17` | `InvalidConfigError` con `code = 'INVALID_SIZE'`. |
| `size = 8.5` | `InvalidConfigError` con `code = 'INVALID_SIZE'`. |
| `n = 1` | `InvalidConfigError` con `code = 'INVALID_PLAYER_COUNT'`. |
| `n = 9` | `InvalidConfigError` con `code = 'INVALID_PLAYER_COUNT'`. |
| `n = 2.5` | `InvalidConfigError` con `code = 'INVALID_PLAYER_COUNT'`. |
| `mode = 'diagonal'` | `InvalidConfigError` con `code = 'UNKNOWN_MODE'`. |
| Estrategia de prueba con universo menor que `n` | `SpawnGenerationError` con `code = 'INSUFFICIENT_CANDIDATES'`. |
| `maxAttempts = 1` con asignación forzada a fallar | `SpawnGenerationError` con `code = 'RETRY_EXHAUSTED'`. |
| Violación inyectada de I7 en un resultado de prueba | `SpawnGenerationError` con `code = 'INVARIANT_VIOLATION'`. |

En todas las pruebas de error se comprueba además que no se ha creado ni modificado ninguna sala, que no se ha emitido estado público y que el error incluye `details` suficiente para diagnosticar la configuración.
