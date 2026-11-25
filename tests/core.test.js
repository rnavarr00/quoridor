import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GameEngine,
  computeLegalMoves,
  hasPath,
  wallsCross,
  mulberry32,
  generateSpawnsAndGoals,
  sampleWithoutReplacement,
  goalDistance,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_NODE_BUDGET,
  SPAWN_MODES,
  manhattan,
  cellKey,
  PLAYER_COLORS as CORE_PLAYER_COLORS,
} from '../src/core/index.js';
import { colorHex, colorVar, PLAYER_COLORS, PLAYER_COLOR_NAMES } from '../public/js/state.js';

const CONFIG = {
  size: 8,
  maxPlayers: 2,
  wallsPerPlayer: 10,
  spawnMode: 'random',
  turnSeconds: 30,
};

function engineWith(players, config = CONFIG) {
  return GameEngine.create(
    config,
    players.map((player, index) => ({ id: player.id, name: player.id.toUpperCase(), colorIndex: index })),
    {
      spawns: players.map((player) => player.spawn),
      goals: players.map((player) => player.goal),
    },
    123,
  );
}

function twoPlayers(overrides = {}) {
  return [
    { id: 'a', spawn: { r: 3, c: 3 }, goal: { r: 0, c: 0 }, ...overrides.a },
    { id: 'b', spawn: { r: 6, c: 6 }, goal: { r: 7, c: 7 }, ...overrides.b },
  ];
}

test('movimiento simple y cambio de turno', () => {
  const engine = engineWith(twoPlayers());
  const result = engine.move('a', { r: 2, c: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.events[0].type, 'MOVE');
  assert.equal(result.events.at(-1).type, 'TURN_CHANGED');
  assert.deepEqual(engine.getPlayer('a').pos, { r: 2, c: 3 });
  assert.equal(engine.getState().turnPlayerId, 'b');
});

test('no se puede mover fuera de turno ni a casilla ocupada', () => {
  const engine = engineWith(twoPlayers({ a: { spawn: { r: 3, c: 3 } }, b: { spawn: { r: 3, c: 4 } } }));
  assert.equal(engine.move('b', { r: 2, c: 4 }).error, 'NOT_YOUR_TURN');
  assert.equal(engine.move('a', { r: 3, c: 4 }).error, 'CELL_OCCUPIED');
  assert.equal(engine.move('a', { r: 9, c: 9 }).error, 'OUT_OF_BOARD');
  assert.deepEqual(engine.getPlayer('a').pos, { r: 3, c: 3 });
});

test('salto recto sobre ficha adyacente', () => {
  const engine = engineWith(twoPlayers({ a: { pos: { r: 3, c: 3 } }, b: { spawn: { r: 3, c: 4 } } }));
  const moves = computeLegalMoves(engine.getState(), 'a');
  const jump = moves.find((move) => move.kind === 'straight' && move.to.r === 3 && move.to.c === 5);
  assert.ok(jump);
  const result = engine.move('a', { r: 3, c: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.events[0].type, 'JUMP');
  assert.deepEqual(result.events[0].over, [{ r: 3, c: 4 }]);
});

test('salto en L cuando el salto recto está bloqueado por pared', () => {
  const engine = engineWith(twoPlayers({ b: { spawn: { r: 3, c: 4 } } }));
  engine.state.walls.push({ orientation: 'V', x: 4, y: 3 });
  const moves = computeLegalMoves(engine.getState(), 'a');
  const targets = moves.filter((move) => move.kind === 'L').map((move) => `${move.to.r},${move.to.c}`);
  assert.deepEqual(targets.sort(), ['2,4', '4,4']);
});

test('cadena de saltos rectos sobre dos fichas', () => {
  const engine = engineWith([
    { id: 'a', spawn: { r: 3, c: 3 }, goal: { r: 0, c: 0 } },
    { id: 'b', spawn: { r: 3, c: 4 }, goal: { r: 7, c: 7 } },
    { id: 'c', spawn: { r: 3, c: 5 }, goal: { r: 0, c: 7 } },
  ]);
  const result = engine.move('a', { r: 3, c: 6 });
  assert.equal(result.ok, true);
  assert.equal(result.events[0].type, 'JUMP');
  assert.equal(result.events[0].kind, 'chain');
  assert.equal(result.events[0].over.length, 2);
});

test('los fantasmas son transitables y no se saltan', () => {
  const engine = engineWith(twoPlayers({ b: { spawn: { r: 3, c: 4 } } }));
  const b = engine.getPlayer('b');
  b.ghost = true;
  b.connected = false;
  const moves = computeLegalMoves(engine.getState(), 'a');
  assert.ok(moves.some((move) => move.kind === 'step' && move.to.r === 3 && move.to.c === 4));
  assert.ok(!moves.some((move) => move.kind !== 'step' && move.to.r === 3 && move.to.c === 4));
});

test('meta propia termina la partida', () => {
  const engine = engineWith([
    { id: 'a', spawn: { r: 0, c: 1 }, goal: { r: 0, c: 0 } },
    { id: 'b', spawn: { r: 7, c: 7 }, goal: { r: 7, c: 6 } },
  ]);
  const result = engine.move('a', { r: 0, c: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.events.at(-1).type, 'PLAYER_WON');
  assert.equal(engine.isFinished(), true);
  assert.equal(engine.getWinner(), 'a');
});

test('camping en meta ajena obliga a salir y prohíbe pared', () => {
  const engine = engineWith([
    { id: 'a', spawn: { r: 3, c: 5 }, goal: { r: 0, c: 0 } },
    { id: 'b', spawn: { r: 6, c: 6 }, goal: { r: 3, c: 6 } },
  ]);
  const enter = engine.move('a', { r: 3, c: 6 });
  assert.equal(enter.ok, true);
  assert.equal(enter.events.some((event) => event.type === 'CAMPING_ENTERED'), true);
  assert.deepEqual(engine.getPlayer('a').camping, { goalOwnerId: 'b', turnsOnGoal: 1 });

  engine.autoMove('b', () => 0);
  assert.equal(engine.getState().turnPlayerId, 'a');
  assert.equal(engine.placeWall('a', 'H', 0, 0).error, 'CAMPING_NO_WALL');
  assert.equal(engine.move('a', { r: 3, c: 6 }).error, 'CAMPING_FORCED_MOVE');
  const exit = engine.move('a', { r: 2, c: 6 });
  assert.equal(exit.ok, true);
  assert.equal(engine.getPlayer('a').camping, null);
});

test('anti-encierro rechaza la pared que deja sin camino', () => {
  const engine = engineWith([
    { id: 'a', spawn: { r: 0, c: 0 }, goal: { r: 7, c: 7 } },
    { id: 'b', spawn: { r: 7, c: 0 }, goal: { r: 0, c: 7 } },
  ]);
  assert.equal(engine.placeWall('a', 'H', 0, 0).ok, true);
  engine.state.turnPlayerId = 'a';
  assert.equal(engine.wallError({ orientation: 'V', x: 1, y: 0 }), 'NO_PATH');
  assert.equal(hasPath({ r: 0, c: 0 }, { r: 7, c: 7 }, [{ orientation: 'H', x: 0, y: 0 }, { orientation: 'V', x: 1, y: 0 }], 8), false);
});

test('la pared conserva el jugador que la colocó', () => {
  const engine = engineWith(twoPlayers());
  const result = engine.placeWall('a', 'H', 0, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(engine.getState().walls[0], { orientation: 'H', x: 0, y: 0, playerId: 'a' });
  assert.deepEqual(result.events[0].wall, { orientation: 'H', x: 0, y: 0, playerId: 'a' });
});

test('colisiones de paredes: solape, L permitida y cruce', () => {
  const engine = engineWith(twoPlayers());
  engine.state.walls.push({ orientation: 'H', x: 2, y: 2 });
  assert.equal(engine.wallError({ orientation: 'H', x: 3, y: 2 }), 'WALL_OVERLAP');
  assert.equal(engine.wallError({ orientation: 'V', x: 2, y: 2 }), 'WALL_CROSS');
  assert.equal(engine.wallError({ orientation: 'V', x: 3, y: 2 }), null);
  assert.equal(engine.wallError({ orientation: 'H', x: 1, y: 3 }), null);
  engine.state.walls.push({ orientation: 'V', x: 2, y: 1 });
  assert.equal(engine.wallError({ orientation: 'V', x: 2, y: 1 }), 'WALL_OVERLAP');
  engine.state.walls.length = 0;
  engine.state.walls.push({ orientation: 'H', x: 1, y: 1 });
  assert.equal(engine.wallError({ orientation: 'V', x: 2, y: 0 }), null);
  assert.equal(engine.wallError({ orientation: 'V', x: 1, y: 1 }), 'WALL_CROSS');
});

test('autopase por timeout mueve y avanza turno', () => {
  const engine = engineWith(twoPlayers());
  const result = engine.autoMove('a', () => 0);
  assert.equal(result.ok, true);
  assert.ok(result.events.some((event) => event.type === 'MOVE' || event.type === 'TURN_CHANGED'));
  assert.equal(engine.getState().turnPlayerId, 'b');
});

test('desconexión convierte en fantasma y declara ganador al último activo', () => {
  const engine = engineWith(twoPlayers());
  const result = engine.setGhost('b', true);
  assert.equal(result.ok, true);
  assert.equal(engine.isFinished(), true);
  assert.equal(engine.getWinner(), 'a');
  assert.equal(engine.getPlayer('b').ghost, true);
});

test('reconexión reubica si la celda está ocupada', () => {
  const engine = engineWith(twoPlayers({ b: { spawn: { r: 3, c: 4 } } }));
  const bPlayer = engine.getPlayer('b');
  bPlayer.ghost = true;
  bPlayer.connected = false;
  assert.equal(engine.move('a', { r: 3, c: 4 }).ok, true);
  engine.setGhost('b', false);
  const b = engine.getPlayer('b');
  assert.equal(b.ghost, false);
  assert.ok(b.pos.r !== 3 || b.pos.c !== 4);
  assert.ok(!engine.getState().players.some((player) => player.id !== 'b' && !player.ghost && player.pos.r === b.pos.r && player.pos.c === b.pos.c));
});

test('generación de spawns invariantes en todos los tamaños y modos', () => {
  for (const size of [8, 9, 12, 16]) {
    for (const mode of SPAWN_MODES) {
      for (const playerCount of [2, 4, 8]) {
        const rng = mulberry32(size * 1000 + playerCount * 10 + mode.length);
        const result = generateSpawnsAndGoals({ size, playerCount, mode, rng, seed: 7 });
        assert.equal(result.spawns.length, playerCount);
        assert.equal(result.goals.length, playerCount);
        assert.equal(new Set(result.spawns.map(cellKey)).size, playerCount);
        assert.equal(new Set(result.goals.map(cellKey)).size, playerCount);
        const spawnKeys = new Set(result.spawns.map(cellKey));
        assert.ok(result.goals.every((goal) => !spawnKeys.has(cellKey(goal))));
        assert.ok(result.meta.goalDistance >= 2 && result.meta.goalDistance <= 2 * (size - 1));
        assert.equal(result.meta.relaxed, result.meta.goalDistance !== goalDistance(size));
        for (let i = 0; i < playerCount; i += 1) {
          assert.equal(manhattan(result.spawns[i], result.goals[i]), result.meta.goalDistance);
          if (mode === 'perimeter') {
            const cell = result.spawns[i];
            const border = cell.r === 0 || cell.c === 0 || cell.r === size - 1 || cell.c === size - 1;
            const corner = (cell.r === 0 || cell.r === size - 1) && (cell.c === 0 || cell.c === size - 1);
            assert.ok(border && !corner);
          }
          if (mode === 'central') {
            const lo = Math.floor(size * 0.25);
            const hi = Math.ceil(size * 0.75) - 1;
            assert.ok(result.spawns[i].r >= lo && result.spawns[i].r <= hi);
            assert.ok(result.spawns[i].c >= lo && result.spawns[i].c <= hi);
          }
        }
      }
    }
  }
});

test('spawns deterministas con la misma semilla', () => {
  const options = { size: 12, playerCount: 5, mode: 'random', seed: 99 };
  const first = generateSpawnsAndGoals({ ...options, rng: mulberry32(99) });
  const second = generateSpawnsAndGoals({ ...options, rng: mulberry32(99) });
  assert.deepEqual(first, second);
});

test('metas repartidas por el tablero en generaciones con semillas distintas', () => {
  const size = 12;
  const playerCount = 4;
  const rows = new Array(size).fill(0);
  const cols = new Array(size).fill(0);
  const sides = { top: 0, bottom: 0, left: 0, right: 0, interior: 0 };
  let total = 0;

  for (let seed = 1; seed <= 200; seed += 1) {
    const result = generateSpawnsAndGoals({ size, playerCount, mode: 'random', rng: mulberry32(seed), seed });
    const spawnKeys = new Set(result.spawns.map(cellKey));
    assert.equal(new Set(result.goals.map(cellKey)).size, playerCount);
    for (let i = 0; i < playerCount; i += 1) {
      const goal = result.goals[i];
      assert.ok(!spawnKeys.has(cellKey(goal)));
      assert.equal(manhattan(result.spawns[i], goal), result.meta.goalDistance);
      rows[goal.r] += 1;
      cols[goal.c] += 1;
      if (goal.r === 0) sides.top += 1;
      else if (goal.r === size - 1) sides.bottom += 1;
      else if (goal.c === 0) sides.left += 1;
      else if (goal.c === size - 1) sides.right += 1;
      else sides.interior += 1;
      total += 1;
    }
  }

  assert.ok(rows.every((count) => count > 0), `filas sin metas: ${rows}`);
  assert.ok(cols.every((count) => count > 0), `columnas sin metas: ${cols}`);
  assert.ok(Math.max(...rows) < total * 0.4, `sesgo vertical: ${rows}`);
  assert.ok(Object.values(sides).every((count) => count > 0), JSON.stringify(sides));
  assert.ok(sides.interior > total * 0.25, JSON.stringify(sides));
});

test('errores de configuración del generador', () => {
  assert.throws(() => generateSpawnsAndGoals({ size: 7, playerCount: 2 }), /INVALID_SIZE/);
  assert.throws(() => generateSpawnsAndGoals({ size: 17, playerCount: 2 }), /INVALID_SIZE/);
  assert.throws(() => generateSpawnsAndGoals({ size: 9, playerCount: 1 }), /INVALID_PLAYER_COUNT/);
  assert.throws(() => generateSpawnsAndGoals({ size: 9, playerCount: 2, mode: 'diagonal' }), /UNKNOWN_MODE/);
});

test('cruce de paredes solo con el mismo ancla', () => {
  const diagonal = { orientation: 'V', x: 2, y: 0 };
  const anchor = { orientation: 'H', x: 1, y: 1 };
  assert.equal(wallsCross(anchor, diagonal), false);
  assert.equal(wallsCross(anchor, { orientation: 'V', x: 1, y: 1 }), true);

  const engine = engineWith(twoPlayers());
  engine.state.walls.push({ orientation: 'H', x: 0, y: 0 });
  assert.equal(engine.wallError({ orientation: 'V', x: 0, y: 0 }), 'WALL_CROSS');
  assert.equal(engine.wallError({ orientation: 'V', x: 2, y: 0 }), null);
});

test('no se ofrece salto en L cuando falla una cadena de dos fichas', () => {
  const engine = engineWith([
    { id: 'a', spawn: { r: 3, c: 3 }, goal: { r: 0, c: 0 } },
    { id: 'b', spawn: { r: 3, c: 4 }, goal: { r: 7, c: 7 } },
    { id: 'c', spawn: { r: 3, c: 5 }, goal: { r: 0, c: 7 } },
  ]);
  engine.state.walls.push({ orientation: 'V', x: 5, y: 3 });
  const moves = computeLegalMoves(engine.getState(), 'a');
  assert.ok(!moves.some((move) => move.kind === 'L'));
  assert.ok(!moves.some((move) => move.to.r === 3 && move.to.c === 6));
});

test('setGhost no muta una partida terminada', () => {
  const engine = engineWith([
    { id: 'a', spawn: { r: 0, c: 1 }, goal: { r: 0, c: 0 } },
    { id: 'b', spawn: { r: 7, c: 7 }, goal: { r: 7, c: 6 } },
  ]);
  assert.equal(engine.move('a', { r: 0, c: 0 }).ok, true);
  const before = engine.getState();
  assert.equal(engine.setGhost('b', true).error, 'GAME_FINISHED');
  assert.equal(engine.setGhost('a', false).error, 'GAME_FINISHED');
  assert.deepEqual(engine.getState(), before);
});

test('getDistances calcula la distancia BFS con paredes', () => {
  const engine = engineWith([
    { id: 'a', spawn: { r: 0, c: 0 }, goal: { r: 0, c: 1 } },
    { id: 'b', spawn: { r: 7, c: 7 }, goal: { r: 7, c: 6 } },
  ]);
  assert.deepEqual(engine.getDistances(), [
    { id: 'a', distance: 1 },
    { id: 'b', distance: 1 },
  ]);
  engine.state.walls.push({ orientation: 'V', x: 0, y: 0 });
  assert.deepEqual(engine.getDistances(), [
    { id: 'a', distance: 5 },
    { id: 'b', distance: 1 },
  ]);
  engine.state.walls.push({ orientation: 'H', x: 0, y: 0 });
  assert.deepEqual(engine.getDistances(), [
    { id: 'a', distance: null },
    { id: 'b', distance: 1 },
  ]);
});

test('ocho jugadores completan un ciclo de turnos', () => {
  const players = Array.from({ length: 8 }, (_, index) => ({
    id: `p${index}`,
    spawn: { r: 0, c: index },
    goal: { r: 7, c: index },
  }));
  const engine = engineWith(players, { ...CONFIG, maxPlayers: 8 });
  const seen = [];
  for (let i = 0; i < 8; i += 1) {
    const id = engine.getState().turnPlayerId;
    seen.push(id);
    const result = engine.autoMove(id, () => 0);
    assert.equal(result.ok, true);
    assert.equal(result.events.at(-1).type, 'TURN_CHANGED');
  }
  assert.deepEqual(seen, players.map((player) => player.id));
  assert.equal(engine.getState().turnNumber, 9);
  assert.equal(engine.getState().turnPlayerId, 'p0');
});

test('partidas con la misma semilla y secuencia son idénticas', () => {
  const build = () => {
    const spawn = generateSpawnsAndGoals({
      size: 8,
      playerCount: 4,
      mode: 'perimeter',
      rng: mulberry32(2026),
      seed: 2026,
    });
    const players = spawn.spawns.map((cell, index) => ({
      id: `p${index}`,
      spawn: { r: cell.r, c: cell.c },
      goal: { r: spawn.goals[index].r, c: spawn.goals[index].c },
    }));
    return engineWith(players, { ...CONFIG, maxPlayers: 4 });
  };
  const first = build();
  const second = build();
  for (let i = 0; i < 3; i += 1) {
    const id = first.getState().turnPlayerId;
    assert.equal(id, second.getState().turnPlayerId);
    assert.equal(first.autoMove(id, mulberry32(500 + i)).ok, true);
    assert.equal(second.autoMove(id, mulberry32(500 + i)).ok, true);
  }
  assert.deepEqual(first.getState(), second.getState());
});

test('sampleWithoutReplacement valida count y acota el índice del RNG', () => {
  const universe = [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }];
  let calls = 0;
  const counting = () => {
    calls += 1;
    return 1;
  };
  for (const count of [-1, 1.5, NaN, undefined]) {
    assert.throws(
      () => sampleWithoutReplacement(universe, count, counting),
      (error) => error.code === 'INSUFFICIENT_CANDIDATES',
    );
  }
  assert.equal(calls, 0);
  assert.deepEqual(sampleWithoutReplacement(universe, 0, counting), []);
  assert.equal(calls, 0);
  const sampled = sampleWithoutReplacement(universe, 3, counting);
  assert.equal(sampled.length, 3);
  assert.equal(new Set(sampled.map(cellKey)).size, 3);
  assert.equal(calls, 3);
});

test('presupuestos por defecto y normalización sin INVALID_ATTEMPTS', () => {
  assert.equal(DEFAULT_MAX_ATTEMPTS, 32);
  assert.equal(DEFAULT_NODE_BUDGET, 20000);
  const options = { size: 8, playerCount: 2, mode: 'random' };
  const base = generateSpawnsAndGoals({ ...options, rng: mulberry32(1) });
  const normalized = generateSpawnsAndGoals({
    ...options,
    rng: mulberry32(1),
    maxAttempts: -3,
    nodeBudget: 1.5,
  });
  assert.deepEqual(base, normalized);
});

test('paleta de jugadores ofrece 20 colores coherentes y accesibles', () => {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((start) => {
      const value = parseInt(hex.slice(start, start + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };

  assert.equal(PLAYER_COLORS.length, 20);
  assert.equal(PLAYER_COLOR_NAMES.length, PLAYER_COLORS.length);
  assert.equal(CORE_PLAYER_COLORS.length, PLAYER_COLORS.length);
  for (const [index, hex] of PLAYER_COLORS.entries()) {
    assert.match(hex, /^#[0-9A-F]{6}$/);
    assert.equal(CORE_PLAYER_COLORS[index].hex, hex);
    assert.ok(1.05 / (luminance(hex) + 0.05) >= 4.5, `${hex} no alcanza contraste 4.5:1`);
  }
  assert.equal(colorVar(0), 'var(--color-player-0)');
  assert.equal(colorVar(19), 'var(--color-player-19)');
  assert.equal(colorHex(19), PLAYER_COLORS[19]);
  assert.equal(colorVar(20), 'var(--color-player-0)');
  assert.equal(colorHex(-1), PLAYER_COLORS[0]);
});
