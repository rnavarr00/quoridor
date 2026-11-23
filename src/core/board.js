import { DIRECTIONS } from './constants.js';

export function cell(r, c) {
  return { r, c };
}

export function cellKey(value) {
  return `${value.r},${value.c}`;
}

export function sameCell(a, b) {
  return Boolean(a && b && a.r === b.r && a.c === b.c);
}

export function isCell(value) {
  return Boolean(value && Number.isInteger(value.r) && Number.isInteger(value.c));
}

export function inBounds(value, size) {
  return Boolean(value && value.r >= 0 && value.r < size && value.c >= 0 && value.c < size);
}

export function manhattan(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
}

export function neighbors(value, size) {
  return DIRECTIONS
    .map((dir) => ({ r: value.r + dir.dr, c: value.c + dir.dc }))
    .filter((next) => inBounds(next, size));
}

export function isEdgeBlocked(walls, a, b) {
  if (!a || !b) return true;
  if (a.r === b.r && Math.abs(a.c - b.c) === 1) {
    const row = a.r;
    const col = Math.min(a.c, b.c);
    return walls.some((wall) => wall.orientation === 'V'
      && wall.x === col
      && (wall.y === row || wall.y === row - 1));
  }
  if (a.c === b.c && Math.abs(a.r - b.r) === 1) {
    const row = Math.min(a.r, b.r);
    const col = a.c;
    return walls.some((wall) => wall.orientation === 'H'
      && wall.y === row
      && (wall.x === col || wall.x === col - 1));
  }
  return true;
}

export function wallEdgeKeys(wall) {
  if (wall.orientation === 'H') {
    return [`NS:${wall.y}:${wall.x}`, `NS:${wall.y}:${wall.x + 1}`];
  }
  return [`EW:${wall.y}:${wall.x}`, `EW:${wall.y + 1}:${wall.x}`];
}

export function isWallInBounds(wall, size) {
  return Boolean(
    wall
    && (wall.orientation === 'H' || wall.orientation === 'V')
    && Number.isInteger(wall.x)
    && Number.isInteger(wall.y)
    && wall.x >= 0
    && wall.x <= size - 2
    && wall.y >= 0
    && wall.y <= size - 2
  );
}

export function wallsOverlap(a, b) {
  if (a.orientation !== b.orientation) return false;
  const edges = new Set(wallEdgeKeys(a));
  return wallEdgeKeys(b).some((edge) => edges.has(edge));
}

export function wallsCross(a, b) {
  if (a.orientation === b.orientation) return false;
  const horizontal = a.orientation === 'H' ? a : b;
  const vertical = a.orientation === 'V' ? a : b;
  return horizontal.x === vertical.x && horizontal.y === vertical.y;
}

export function hasWallConflict(walls, wall) {
  for (const existing of walls) {
    if (wallsOverlap(existing, wall)) return 'WALL_OVERLAP';
    if (wallsCross(existing, wall)) return 'WALL_CROSS';
  }
  return null;
}

export function hasPath(start, goal, walls, size) {
  if (!inBounds(start, size) || !inBounds(goal, size)) return false;
  if (sameCell(start, goal)) return true;
  const target = cellKey(goal);
  const seen = new Set([cellKey(start)]);
  const queue = [start];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    for (const dir of DIRECTIONS) {
      const next = { r: current.r + dir.dr, c: current.c + dir.dc };
      if (!inBounds(next, size)) continue;
      if (isEdgeBlocked(walls, current, next)) continue;
      const key = cellKey(next);
      if (seen.has(key)) continue;
      if (key === target) return true;
      seen.add(key);
      queue.push(next);
    }
  }
  return false;
}

export function shortestPathDistance(start, goal, walls, size) {
  if (!inBounds(start, size) || !inBounds(goal, size)) return null;
  if (sameCell(start, goal)) return 0;
  const seen = new Set([cellKey(start)]);
  const queue = [{ cell: start, distance: 0 }];
  let head = 0;
  while (head < queue.length) {
    const { cell: current, distance } = queue[head++];
    for (const dir of DIRECTIONS) {
      const next = { r: current.r + dir.dr, c: current.c + dir.dc };
      if (!inBounds(next, size)) continue;
      if (isEdgeBlocked(walls, current, next)) continue;
      const key = cellKey(next);
      if (seen.has(key)) continue;
      if (sameCell(next, goal)) return distance + 1;
      seen.add(key);
      queue.push({ cell: next, distance: distance + 1 });
    }
  }
  return null;
}

export function allActivePlayersHavePath(players, walls, size) {
  for (const player of players) {
    if (player.ghost || player.connected === false) continue;
    if (!hasPath(player.pos, player.goal, walls, size)) return false;
  }
  return true;
}

export function nearestFreeCell(from, walls, size, occupied, goal = null) {
  const occupiedKeys = new Set(occupied.map(cellKey));
  if (!occupiedKeys.has(cellKey(from))) return { ...from };
  const seen = new Set([cellKey(from)]);
  const queue = [{ r: from.r, c: from.c }];
  let head = 0;
  let best = null;
  let bestDistance = Infinity;
  while (head < queue.length) {
    const current = queue[head++];
    if (!occupiedKeys.has(cellKey(current))) {
      const distance = goal ? manhattan(current, goal) : 0;
      if (distance < bestDistance) {
        best = current;
        bestDistance = distance;
      }
      if (!goal) return current;
    }
    for (const dir of DIRECTIONS) {
      const next = { r: current.r + dir.dr, c: current.c + dir.dc };
      if (!inBounds(next, size)) continue;
      if (isEdgeBlocked(walls, current, next)) continue;
      const key = cellKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return best;
}

export function activePlayerAt(players, position, excludeId = null) {
  return players.find((player) => !player.ghost && player.id !== excludeId && sameCell(player.pos, position)) || null;
}

export function goalOwner(players, position) {
  return players.find((player) => sameCell(player.goal, position)) || null;
}
