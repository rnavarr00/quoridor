import { GameEngine } from '/core/index.js';
import {
  cellKeyXY,
  colorVar,
  coordinateLabel,
  goalSideFromCell,
  normalizeGoalCell,
  playerInitial,
} from './state.js';

function toCell(value) {
  if (!value || typeof value !== 'object') return null;
  if (Number.isInteger(value.r) && Number.isInteger(value.c)) return { r: value.r, c: value.c };
  if (Number.isInteger(value.x) && Number.isInteger(value.y)) return { r: value.y, c: value.x };
  return null;
}

function decorativeSpan(className) {
  const span = document.createElement('span');
  span.className = className;
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function normalizeWalls(walls) {
  if (Array.isArray(walls)) {
    return walls
      .filter((wall) => wall && (wall.orientation === 'H' || wall.orientation === 'V')
        && Number.isInteger(wall.x) && Number.isInteger(wall.y))
      .map((wall) => ({ orientation: wall.orientation, x: wall.x, y: wall.y }));
  }
  const result = [];
  if (walls && typeof walls === 'object') {
    for (const orientation of ['H', 'V']) {
      const list = Array.isArray(walls[orientation]) ? walls[orientation] : [];
      for (const wall of list) {
        if (wall && Number.isInteger(wall.x) && Number.isInteger(wall.y)) {
          result.push({ orientation, x: wall.x, y: wall.y });
        }
      }
    }
  }
  return result;
}

export function normalizeView(view) {
  const size = Number.isInteger(view?.board?.size)
    ? view.board.size
    : Number.isInteger(view?.config?.size)
      ? view.config.size
      : 9;
  const rawPlayers = Array.isArray(view?.players) ? view.players : [];
  const players = rawPlayers.map((player, index) => {
    const pos = toCell(player.pos) || { r: 0, c: 0 };
    const spawn = toCell(player.spawn) || { ...pos };
    const goalCell = normalizeGoalCell(player.goal, size) || { ...pos };
    return {
      id: String(player.id ?? `player-${index}`),
      name: typeof player.name === 'string' ? player.name : `Jugador ${index + 1}`,
      colorIndex: Number.isInteger(player.colorIndex) ? player.colorIndex : index,
      pos,
      spawn,
      goalCell,
      goalRaw: player.goal,
      wallsLeft: Number.isInteger(player.wallsLeft) ? player.wallsLeft : 0,
      ghost: Boolean(player.ghost),
      connected: player.connected !== false && !player.ghost,
      isTurn: Boolean(player.isTurn) || player.id === view?.turnPlayerId,
      camping: player.camping || null,
    };
  });

  return {
    size,
    players,
    walls: normalizeWalls(view?.walls),
    turnPlayerId: typeof view?.turnPlayerId === 'string' ? view.turnPlayerId : null,
    turnNumber: Number.isInteger(view?.turnNumber) ? view.turnNumber : 1,
    status: typeof view?.status === 'string' ? view.status : 'playing',
    winnerId: typeof view?.winnerId === 'string' ? view.winnerId : null,
    config: view?.config || {},
  };
}

export function buildCoreState(view) {
  const normalized = normalizeView(view);
  const config = normalized.config || {};
  return {
    config: {
      size: normalized.size,
      maxPlayers: Number.isInteger(config.maxPlayers) ? config.maxPlayers : normalized.players.length,
      wallsPerPlayer: Number.isInteger(config.wallsPerPlayer) ? config.wallsPerPlayer : 10,
      spawnMode: typeof config.spawnMode === 'string' ? config.spawnMode : 'random',
      turnSeconds: 30,
    },
    players: normalized.players.map((player) => ({
      id: player.id,
      name: player.name,
      colorIndex: player.colorIndex,
      spawn: { ...player.spawn },
      goal: { ...player.goalCell },
      pos: { ...player.pos },
      wallsLeft: player.wallsLeft,
      ghost: player.ghost,
      connected: player.connected,
      camping: player.camping ? { ...player.camping } : null,
    })),
    walls: normalized.walls.map((wall) => ({ ...wall })),
    turnPlayerId: normalized.turnPlayerId,
    turnNumber: normalized.turnNumber,
    status: normalized.status === 'finished' ? 'finished' : 'playing',
    winnerId: normalized.winnerId,
    seed: 0,
  };
}

export class BoardRenderer {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.el = document.createElement('div');
    this.el.className = 'board';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', 'Tablero de juego');
    this.el.addEventListener('click', (event) => this.onClick(event));
    this.el.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.el.addEventListener('pointerover', (event) => this.onPointerOver(event));
    this.el.addEventListener('pointerout', (event) => this.onPointerOut(event));
    this.el.addEventListener('focusin', (event) => this.onFocusIn(event));
    this.el.addEventListener('focusout', (event) => this.onFocusOut(event));
    container.appendChild(this.el);

    this.size = 0;
    this.playerSignature = '';
    this.view = null;
    this.normalized = null;
    this.myId = null;
    this.canAct = false;
    this.pending = false;
    this.wallMode = false;
    this.orientation = 'H';
    this.cells = new Map();
    this.anchors = new Map();
    this.pieces = new Map();
    this.goalMarks = new Map();
    this.spawnMarks = new Map();
    this.wallEls = new Map();
    this.legalMoves = new Map();
    this.legalWalls = new Set();
    this.legalWallsByOrientation = { H: new Set(), V: new Set() };
    this.activeCellKey = '0,0';
    this.activeAnchorKey = null;
    this.hints = null;
    this.preview = null;
    this.hoverAnchor = null;
  }

  setHandlers({ onMove, onWall, onRotate, onAnnounce, onWallModeChange, onCancelWall } = {}) {
    this.options = { ...this.options, onMove, onWall, onRotate, onAnnounce, onWallModeChange, onCancelWall };
  }

  gridTemplate(size) {
    return `var(--wall-thickness) repeat(${size - 1}, 1fr var(--wall-thickness)) 1fr var(--wall-thickness)`;
  }

  cellKey(x, y) {
    return `${x},${y}`;
  }

  wallKey(orientation, x, y) {
    return `${orientation}:${x},${y}`;
  }

  rebuild(size, players) {
    this.el.replaceChildren();
    this.cells.clear();
    this.anchors.clear();
    this.pieces.clear();
    this.goalMarks.clear();
    this.spawnMarks.clear();
    this.wallEls.clear();
    this.size = size;
    this.el.style.setProperty('--board-size', String(size));
    const template = this.gridTemplate(size);
    this.el.style.gridTemplateColumns = template;
    this.el.style.gridTemplateRows = template;
    this.el.setAttribute('aria-label', `Tablero de ${size} por ${size}`);
    this.el.dataset.size = String(size);

    const fragment = document.createDocumentFragment();
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'board__cell';
        cell.dataset.x = String(c);
        cell.dataset.y = String(r);
        cell.style.gridRow = String(2 * r + 2);
        cell.style.gridColumn = String(2 * c + 2);
        cell.tabIndex = r === 0 && c === 0 ? 0 : -1;
        cell.append(
          decorativeSpan('board__cell-face'),
          decorativeSpan('board__spawn'),
          decorativeSpan('board__goal'),
          decorativeSpan('board__move-dot'),
        );
        this.cells.set(this.cellKey(c, r), cell);
        fragment.appendChild(cell);
      }
    }

    const anchorFragment = document.createDocumentFragment();
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const anchor = document.createElement('button');
        anchor.type = 'button';
        anchor.className = 'board__anchor';
        anchor.dataset.x = String(x);
        anchor.dataset.y = String(y);
        anchor.style.gridRow = String(2 * y + 3);
        anchor.style.gridColumn = String(2 * x + 3);
        anchor.tabIndex = -1;
        anchor.setAttribute('aria-label', `Ancla de pared en columna ${x + 1}, fila ${y + 1}`);
        this.anchors.set(this.cellKey(x, y), anchor);
        anchorFragment.appendChild(anchor);
      }
    }
    fragment.appendChild(anchorFragment);

    this.hints = document.createElement('div');
    this.hints.className = 'board__hints';
    this.hints.setAttribute('aria-hidden', 'true');
    fragment.appendChild(this.hints);

    this.preview = document.createElement('div');
    this.preview.className = 'board__wall-preview';
    this.preview.setAttribute('aria-hidden', 'true');
    this.preview.hidden = true;
    fragment.appendChild(this.preview);

    this.el.appendChild(fragment);
    this.goalMarks.clear();
    this.pieces.clear();
    this.spawnMarks.clear();

    for (const player of players) {
      const piece = document.createElement('span');
      piece.className = 'board__piece';
      piece.dataset.playerId = player.id;
      piece.setAttribute('aria-hidden', 'true');
      this.pieces.set(player.id, piece);

      const goal = document.createElement('span');
      goal.className = 'board__goal-marker';
      goal.dataset.playerId = player.id;
      goal.setAttribute('aria-hidden', 'true');
      this.goalMarks.set(player.id, goal);

      const spawn = document.createElement('span');
      spawn.className = 'board__spawn-marker';
      spawn.dataset.playerId = player.id;
      spawn.setAttribute('aria-hidden', 'true');
      this.spawnMarks.set(player.id, spawn);
    }

    this.playerSignature = players.map((player) => `${player.id}:${player.colorIndex}`).sort().join('|');
    this.refreshWallInteractivity();
  }

  render(view, options = {}) {
    const normalized = normalizeView(view);
    const signature = normalized.players.map((player) => `${player.id}:${player.colorIndex}`).sort().join('|');
    if (normalized.size !== this.size || signature !== this.playerSignature) {
      this.rebuild(normalized.size, normalized.players);
    }
    this.view = view;
    this.normalized = normalized;
    this.myId = options.myId || this.myId;
    this.canAct = options.canAct !== false;
    this.pending = Boolean(options.pending);

    this.el.classList.toggle('is-pending', this.pending);
    this.el.classList.toggle('is-wall-mode', this.wallMode);

    const myPlayer = normalized.players.find((player) => player.id === this.myId) || null;
    const isMyTurn = Boolean(myPlayer && !myPlayer.ghost && normalized.turnPlayerId === this.myId && normalized.status === 'playing');
    this.isMyTurn = isMyTurn;

    this.computeLegalHints(isMyTurn);
    this.updateCells();
    this.updatePieces();
    this.updateGoalsAndSpawns();
    this.updateWalls();
    this.refreshWallHints();
    this.refreshWallInteractivity();

    if (myPlayer) {
      this.setActiveCell(myPlayer.pos.c, myPlayer.pos.r, false);
    } else if (!this.cells.has(this.activeCellKey)) {
      this.setActiveCell(0, 0, false);
    }
  }

  computeLegalHints(isMyTurn) {
    this.legalMoves.clear();
    this.legalWalls.clear();
    this.legalWallsByOrientation = { H: new Set(), V: new Set() };
    if (!isMyTurn || this.pending) return;
    let engine;
    try {
      engine = new GameEngine(buildCoreState(this.view));
      const moves = engine.getLegalMoves(this.myId) || [];
      for (const move of moves) {
        const to = toCell(move.to);
        if (to) this.legalMoves.set(this.cellKey(to.c, to.r), { x: to.c, y: to.r });
      }
      const walls = engine.getLegalWallPlacements(this.myId) || [];
      for (const wall of walls) {
        if (!wall || !Number.isInteger(wall.x) || !Number.isInteger(wall.y)) continue;
        const key = this.wallKey(wall.orientation, wall.x, wall.y);
        this.legalWalls.add(key);
        if (this.legalWallsByOrientation[wall.orientation]) {
          this.legalWallsByOrientation[wall.orientation].add(key);
        }
      }
    } catch (error) {
      this.legalMoves.clear();
      this.legalWalls.clear();
      this.legalWallsByOrientation = { H: new Set(), V: new Set() };
    }
  }

  updateCells() {
    const pieceByCell = new Map();
    for (const player of this.normalized.players) {
      const key = this.cellKey(player.pos.c, player.pos.r);
      const list = pieceByCell.get(key) || [];
      list.push(player);
      pieceByCell.set(key, list);
    }
    const goalByCell = new Map();
    for (const player of this.normalized.players) {
      const key = this.cellKey(player.goalCell.c, player.goalCell.r);
      const list = goalByCell.get(key) || [];
      list.push(player);
      goalByCell.set(key, list);
    }

    for (const [key, cell] of this.cells) {
      const [x, y] = key.split(',').map(Number);
      const legal = this.legalMoves.has(key);
      const occupants = pieceByCell.get(key) || [];
      const goals = goalByCell.get(key) || [];
      cell.classList.toggle('has-piece', occupants.length > 0);
      cell.classList.toggle('is-legal-move', legal);
      cell.classList.toggle('is-turn-cell', occupants.some((player) => player.id === this.normalized.turnPlayerId));
      const dot = cell.querySelector('.board__move-dot');
      if (dot) dot.hidden = !(legal && this.isMyTurn);
      const names = occupants.map((player) => {
        if (player.ghost) return `fantasma de ${player.name}, desconectado, celda transitable`;
        return `ficha de ${player.name}`;
      });
      const goalNames = goals.map((player) => `meta de ${player.name}`);
      const parts = [coordinateLabel(y, x)];
      if (names.length) parts.push(...names);
      if (goalNames.length) parts.push(...goalNames);
      if (legal && this.isMyTurn) parts.push('movimiento legal');
      cell.setAttribute('aria-label', parts.join(', '));
      cell.dataset.legal = legal && this.isMyTurn ? 'true' : 'false';
    }
  }

  updatePieces() {
    for (const player of this.normalized.players) {
      const cell = this.cells.get(this.cellKey(player.pos.c, player.pos.r));
      let piece = this.pieces.get(player.id);
      if (!cell) continue;
      if (!piece) {
        piece = document.createElement('span');
        piece.className = 'board__piece';
        piece.dataset.playerId = player.id;
        piece.setAttribute('aria-hidden', 'true');
        this.pieces.set(player.id, piece);
      }
      if (piece.parentElement !== cell) cell.appendChild(piece);
      piece.textContent = playerInitial(player.name);
      piece.style.setProperty('--player-color', colorVar(player.colorIndex));
      piece.classList.toggle('is-ghost', player.ghost);
      piece.classList.toggle('is-turn', player.id === this.normalized.turnPlayerId && !player.ghost);
      piece.classList.toggle('is-self', player.id === this.myId);
      piece.title = `${player.name}${player.id === this.myId ? ' (tú)' : ''}${player.ghost ? ' — desconectado' : ''}`;
      cell.classList.toggle('is-ghost-cell', player.ghost);
    }

    for (const [id, piece] of this.pieces) {
      if (!this.normalized.players.some((player) => player.id === id)) piece.remove();
    }
  }

  updateGoalsAndSpawns() {
    for (const player of this.normalized.players) {
      const goalCell = this.cells.get(this.cellKey(player.goalCell.c, player.goalCell.r));
      let goal = this.goalMarks.get(player.id);
      if (goalCell) {
        if (!goal) {
          goal = document.createElement('span');
          goal.className = 'board__goal-marker';
          goal.dataset.playerId = player.id;
          goal.setAttribute('aria-hidden', 'true');
          this.goalMarks.set(player.id, goal);
        }
        if (goal.parentElement !== goalCell) goalCell.appendChild(goal);
        goal.style.setProperty('--player-color', colorVar(player.colorIndex));
        const side = goalSideFromCell(player.goalCell, this.normalized.size) || 'center';
        goal.className = `board__goal-marker board__goal-marker--${side}`;
        goal.textContent = playerInitial(player.name);
        goal.title = `Meta de ${player.name}`;
      }

      const spawnCell = this.cells.get(this.cellKey(player.spawn.c, player.spawn.r));
      let spawn = this.spawnMarks.get(player.id);
      if (spawnCell) {
        if (!spawn) {
          spawn = document.createElement('span');
          spawn.className = 'board__spawn-marker';
          spawn.dataset.playerId = player.id;
          spawn.setAttribute('aria-hidden', 'true');
          this.spawnMarks.set(player.id, spawn);
        }
        if (spawn.parentElement !== spawnCell) spawnCell.appendChild(spawn);
        spawn.style.setProperty('--player-color', colorVar(player.colorIndex));
      }
    }
  }

  updateWalls() {
    const seen = new Set();
    for (const wall of this.normalized.walls) {
      const key = this.wallKey(wall.orientation, wall.x, wall.y);
      seen.add(key);
      let element = this.wallEls.get(key);
      if (!element) {
        element = document.createElement('span');
        element.className = `board__wall board__wall--${wall.orientation}`;
        element.dataset.key = key;
        element.setAttribute('role', 'img');
        const label = wall.orientation === 'H'
          ? `Pared horizontal entre ${coordinateLabel(wall.y, wall.x)} y ${coordinateLabel(wall.y + 1, wall.x)}`
          : `Pared vertical en columna ${wall.x + 1}, fila ${wall.y + 1}`;
        element.setAttribute('aria-label', label);
        this.wallEls.set(key, element);
        this.el.appendChild(element);
      }
      if (wall.orientation === 'H') {
        element.style.gridRow = String(2 * wall.y + 3);
        element.style.gridColumn = `${2 * wall.x + 2} / span 3`;
      } else {
        element.style.gridColumn = String(2 * wall.x + 3);
        element.style.gridRow = `${2 * wall.y + 2} / span 3`;
      }
    }
    for (const [key, element] of this.wallEls) {
      if (!seen.has(key)) {
        element.remove();
        this.wallEls.delete(key);
      }
    }
  }

  refreshWallHints() {
    if (!this.hints) return;
    this.hints.replaceChildren();
    if (!this.wallMode || !this.pending) {
      if (!this.wallMode) return;
    }
    const legal = this.legalWallsByOrientation[this.orientation] || new Set();
    const fragment = document.createDocumentFragment();
    for (const key of legal) {
      const [orientation, coordinates] = key.split(':');
      const [x, y] = coordinates.split(',').map(Number);
      const hint = document.createElement('span');
      hint.className = `board__wall-hint board__wall-hint--${orientation}`;
      if (orientation === 'H') {
        hint.style.gridRow = String(2 * y + 3);
        hint.style.gridColumn = `${2 * x + 2} / span 3`;
      } else {
        hint.style.gridColumn = String(2 * x + 3);
        hint.style.gridRow = `${2 * y + 2} / span 3`;
      }
      fragment.appendChild(hint);
    }
    this.hints.appendChild(fragment);
  }

  refreshWallInteractivity() {
    const legal = this.legalWallsByOrientation[this.orientation] || new Set();
    const firstLegal = [...legal][0] || null;
    if (this.wallMode && firstLegal && !this.activeAnchorKey) this.activeAnchorKey = firstLegal;
    for (const [key, anchor] of this.anchors) {
      const isLegal = this.wallMode && this.canAct && !this.pending && legal.has(this.wallKey(this.orientation, ...key.split(',').map(Number)));
      anchor.classList.toggle('is-legal', isLegal);
      anchor.dataset.legal = isLegal ? 'true' : 'false';
      anchor.dataset.orientation = this.orientation;
      if (isLegal && this.wallMode) {
        anchor.tabIndex = this.activeAnchorKey === key ? 0 : -1;
      } else {
        anchor.tabIndex = -1;
      }
      anchor.setAttribute('aria-label', `Ancla ${Number(key.split(',')[0]) + 1}, ${Number(key.split(',')[1]) + 1}${isLegal ? `, pared ${this.orientation === 'H' ? 'horizontal' : 'vertical'} legal` : ''}`);
    }

    if (this.wallMode) {
      for (const cell of this.cells.values()) cell.tabIndex = -1;
    } else {
      this.activeAnchorKey = null;
      this.refreshCellTabIndex();
    }
  }

  setWallMode(enabled, orientation = this.orientation) {
    const next = Boolean(enabled);
    const nextOrientation = orientation === 'V' ? 'V' : 'H';
    const changed = next !== this.wallMode || nextOrientation !== this.orientation;
    this.wallMode = next;
    this.orientation = nextOrientation;
    this.el.classList.toggle('is-wall-mode', this.wallMode);
    this.hidePreview();
    if (!this.wallMode) {
      this.activeAnchorKey = null;
      this.refreshCellTabIndex();
    } else {
      const legal = [...(this.legalWallsByOrientation[this.orientation] || new Set())];
      this.activeAnchorKey = legal[0] || null;
    }
    this.refreshWallHints();
    this.refreshWallInteractivity();
    if (changed && this.options.onWallModeChange) {
      this.options.onWallModeChange({ enabled: this.wallMode, orientation: this.orientation });
    }
    return changed;
  }

  rotateWall() {
    const next = this.orientation === 'H' ? 'V' : 'H';
    this.setWallMode(this.wallMode, next);
    if (this.options.onRotate) this.options.onRotate(next);
    if (this.wallMode) {
      const legal = [...(this.legalWallsByOrientation[next] || new Set())];
      this.activeAnchorKey = legal[0] || null;
      this.refreshWallInteractivity();
      if (this.activeAnchorKey) this.focusAnchor(this.activeAnchorKey);
    }
    if (this.options.onAnnounce) {
      this.options.onAnnounce(`Orientación ${next === 'H' ? 'horizontal' : 'vertical'}.`);
    }
  }

  setPending(pending) {
    this.pending = Boolean(pending);
    this.el.classList.toggle('is-pending', this.pending);
    if (this.view) this.render(this.view, { myId: this.myId, canAct: this.canAct, pending: this.pending });
  }

  setInteractive(canAct) {
    this.canAct = Boolean(canAct);
    this.computeLegalHints(Boolean(this.isMyTurn && this.canAct && !this.pending));
    this.updateCells();
    this.refreshWallInteractivity();
  }

  refreshCellTabIndex() {
    for (const [key, cell] of this.cells) {
      cell.tabIndex = key === this.activeCellKey ? 0 : -1;
    }
  }

  setActiveCell(x, y, focus = false) {
    const key = this.cellKey(x, y);
    if (!this.cells.has(key)) return;
    this.activeCellKey = key;
    if (!this.wallMode) this.refreshCellTabIndex();
    if (focus) this.cells.get(key)?.focus();
  }

  focusBoard() {
    if (this.wallMode) {
      if (this.activeAnchorKey) this.focusAnchor(this.activeAnchorKey);
    } else {
      const cell = this.cells.get(this.activeCellKey) || this.cells.values().next().value;
      if (cell) cell.focus();
    }
  }

  focusAnchor(key) {
    const anchor = this.anchors.get(key);
    if (!anchor) return;
    for (const [anchorKey, item] of this.anchors) item.tabIndex = anchorKey === key ? 0 : -1;
    this.activeAnchorKey = key;
    anchor.focus();
    this.showPreview(key, this.orientation);
  }

  showPreview(key, orientation) {
    if (!this.preview || !this.wallMode) return;
    const coords = key.split(',');
    if (coords.length !== 2) return;
    const x = Number(coords[0]);
    const y = Number(coords[1]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    const isLegal = this.legalWallsByOrientation[orientation]?.has(this.wallKey(orientation, x, y));
    if (!isLegal) {
      this.hidePreview();
      return;
    }
    this.preview.hidden = false;
    this.preview.className = `board__wall-preview board__wall-preview--${orientation} is-visible`;
    if (orientation === 'H') {
      this.preview.style.gridRow = String(2 * y + 3);
      this.preview.style.gridColumn = `${2 * x + 2} / span 3`;
    } else {
      this.preview.style.gridColumn = String(2 * x + 3);
      this.preview.style.gridRow = `${2 * y + 2} / span 3`;
    }
  }

  hidePreview() {
    if (!this.preview) return;
    this.preview.hidden = true;
    this.preview.classList.remove('is-visible');
  }

  onClick(event) {
    const anchor = event.target.closest('.board__anchor');
    if (anchor) {
      event.preventDefault();
      const key = this.cellKey(Number(anchor.dataset.x), Number(anchor.dataset.y));
      if (!this.wallMode || !this.legalWallsByOrientation[this.orientation]?.has(this.wallKey(this.orientation, Number(anchor.dataset.x), Number(anchor.dataset.y)))) {
        return;
      }
      this.placeWallAt(anchor.dataset.x, anchor.dataset.y);
      return;
    }
    const cell = event.target.closest('.board__cell');
    if (!cell || this.wallMode) return;
    const key = this.cellKey(Number(cell.dataset.x), Number(cell.dataset.y));
    if (!this.legalMoves.has(key) || !this.isMyTurn || this.pending) return;
    this.setActiveCell(Number(cell.dataset.x), Number(cell.dataset.y));
    if (this.options.onMove) this.options.onMove({ x: Number(cell.dataset.x), y: Number(cell.dataset.y) });
  }

  placeWallAt(x, y) {
    if (!this.isMyTurn || this.pending) return;
    const nx = Number(x);
    const ny = Number(y);
    if (!this.legalWallsByOrientation[this.orientation]?.has(this.wallKey(this.orientation, nx, ny))) return;
    if (this.options.onWall) this.options.onWall({ orientation: this.orientation, x: nx, y: ny });
  }

  onKeyDown(event) {
    const anchor = event.target.closest('.board__anchor');
    if (anchor) {
      const x = Number(anchor.dataset.x);
      const y = Number(anchor.dataset.y);
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        this.rotateWall();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (this.options.onCancelWall) this.options.onCancelWall();
        else this.setWallMode(false);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.placeWallAt(x, y);
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        this.moveAnchorFocus(event.key);
      }
      return;
    }

    const cell = event.target.closest('.board__cell');
    if (!cell) return;
    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      this.rotateWall();
      return;
    }
    if (event.key === 'w' || event.key === 'W') {
      event.preventDefault();
      this.setWallMode(!this.wallMode, this.orientation);
      return;
    }
    if (event.key === 'Escape') {
      if (this.wallMode) {
        event.preventDefault();
        if (this.options.onCancelWall) this.options.onCancelWall();
        else this.setWallMode(false);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const key = this.cellKey(x, y);
      if (this.legalMoves.has(key) && this.isMyTurn && !this.pending) {
        this.setActiveCell(x, y);
        if (this.options.onMove) this.options.onMove({ x, y });
      } else if (this.options.onAnnounce) {
        this.options.onAnnounce('Movimiento no permitido.');
      }
      return;
    }

    let nx = x;
    let ny = y;
    if (event.key === 'ArrowRight') nx = Math.min(this.size - 1, x + 1);
    else if (event.key === 'ArrowLeft') nx = Math.max(0, x - 1);
    else if (event.key === 'ArrowDown') ny = Math.min(this.size - 1, y + 1);
    else if (event.key === 'ArrowUp') ny = Math.max(0, y - 1);
    else if (event.key === 'Home') nx = 0;
    else if (event.key === 'End') nx = this.size - 1;
    else return;
    event.preventDefault();
    this.setActiveCell(nx, ny, true);
  }

  moveAnchorFocus(key) {
    const legal = [...(this.legalWallsByOrientation[this.orientation] || new Set())]
      .map((entry) => {
        const [x, y] = entry.split(':')[1].split(',').map(Number);
        return { x, y, key: this.cellKey(x, y) };
      })
      .sort((a, b) => a.y - b.y || a.x - b.x);
    if (!legal.length) return;
    const currentKey = this.activeAnchorKey || legal[0].key;
    const index = legal.findIndex((entry) => entry.key === currentKey);
    let nextIndex = index < 0 ? 0 : index;
    if (key === 'ArrowRight') nextIndex = Math.min(legal.length - 1, nextIndex + 1);
    else if (key === 'ArrowLeft') nextIndex = Math.max(0, nextIndex - 1);
    else if (key === 'ArrowDown') nextIndex = Math.min(legal.length - 1, nextIndex + 1);
    else if (key === 'ArrowUp') nextIndex = Math.max(0, nextIndex - 1);
    this.focusAnchor(legal[nextIndex].key);
  }

  onPointerOver(event) {
    if (!this.wallMode) return;
    const anchor = event.target.closest('.board__anchor');
    if (!anchor) return;
    const key = this.cellKey(Number(anchor.dataset.x), Number(anchor.dataset.y));
    this.hoverAnchor = key;
    this.showPreview(key, this.orientation);
  }

  onPointerOut(event) {
    if (!this.wallMode) return;
    const anchor = event.target.closest('.board__anchor');
    if (!anchor) return;
    if (event.relatedTarget && anchor.contains(event.relatedTarget)) return;
    this.hoverAnchor = null;
    this.hidePreview();
  }

  onFocusIn(event) {
    if (!this.wallMode) return;
    const anchor = event.target.closest('.board__anchor');
    if (!anchor) return;
    const key = this.cellKey(Number(anchor.dataset.x), Number(anchor.dataset.y));
    this.activeAnchorKey = key;
    this.showPreview(key, this.orientation);
  }

  onFocusOut(event) {
    if (!this.wallMode) return;
    const anchor = event.target.closest('.board__anchor');
    if (!anchor) return;
    if (event.relatedTarget && anchor.parentElement?.contains(event.relatedTarget)) return;
    this.hidePreview();
  }

  destroy() {
    this.el.remove();
    this.cells.clear();
    this.anchors.clear();
    this.pieces.clear();
    this.goalMarks.clear();
    this.spawnMarks.clear();
    this.wallEls.clear();
    this.view = null;
    this.normalized = null;
  }
}
