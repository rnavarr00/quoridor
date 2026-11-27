import { GameEngine } from '/core/index.js';
import {
  cellKeyXY,
  colorVar,
  coordinateLabel,
  normalizeGoalCell,
} from './state.js';

const DEFAULT_WALL_HIT_RADIUS = 3;

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
  const normalized = (orientation, wall) => ({
    orientation,
    x: wall.x,
    y: wall.y,
    playerId: typeof wall.playerId === 'string' ? wall.playerId : null,
  });
  if (Array.isArray(walls)) {
    return walls
      .filter((wall) => wall && (wall.orientation === 'H' || wall.orientation === 'V')
        && Number.isInteger(wall.x) && Number.isInteger(wall.y))
      .map((wall) => normalized(wall.orientation, wall));
  }
  const result = [];
  if (walls && typeof walls === 'object') {
    for (const orientation of ['H', 'V']) {
      const list = Array.isArray(walls[orientation]) ? walls[orientation] : [];
      for (const wall of list) {
        if (wall && Number.isInteger(wall.x) && Number.isInteger(wall.y)) {
          result.push(normalized(orientation, wall));
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
    this.el.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.el.addEventListener('pointerleave', () => this.onPointerLeave());
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
    this.isMyTurn = false;
    this.orientation = 'H';
    this.cells = new Map();
    this.anchors = new Map();
    this.pieces = new Map();
    this.wallEls = new Map();
    this.hintEls = new Map();
    this.legalMoves = new Map();
    this.legalWalls = new Set();
    this.legalWallsByOrientation = { H: new Set(), V: new Set() };
    this.activeCellKey = '0,0';
    this.activeAnchorKey = null;
    this.hints = null;
    this.preview = null;
    this.hoverAnchor = null;
    this.hoverTarget = null;
    this.wallHitRadius = DEFAULT_WALL_HIT_RADIUS;
    this.refreshWallHitRadius();
    if (typeof window.matchMedia === 'function') {
      const query = window.matchMedia('(max-width: 767px)');
      query.addEventListener?.('change', () => this.refreshWallHitRadius());
    }
  }

  refreshWallHitRadius() {
    const raw = getComputedStyle(this.el).getPropertyValue('--wall-hit-radius');
    const parsed = Number.parseFloat(raw);
    this.wallHitRadius = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WALL_HIT_RADIUS;
  }

  setHandlers({ onMove, onWall, onRotate, onAnnounce } = {}) {
    this.options = { ...this.options, onMove, onWall, onRotate, onAnnounce };
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
    this.pieces.clear();
    this.hintEls.clear();

    for (const player of players) {
      const piece = document.createElement('span');
      piece.className = 'board__piece';
      piece.dataset.playerId = player.id;
      piece.setAttribute('aria-hidden', 'true');
      this.pieces.set(player.id, piece);
    }

    this.playerSignature = players.map((player) => `${player.id}:${player.colorIndex}`).sort().join('|');
    this.refreshWallInteractivity();
  }

  render(view, options = {}) {
    this.clearHover();
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

    const myPlayer = normalized.players.find((player) => player.id === this.myId) || null;
    const isMyTurn = Boolean(myPlayer && !myPlayer.ghost && normalized.turnPlayerId === this.myId && normalized.status === 'playing');
    this.isMyTurn = isMyTurn;

    this.computeLegalHints(isMyTurn && this.canAct && !this.pending);
    this.updateCells();
    this.updatePieces();
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
      cell.classList.toggle('is-goal', goals.length > 0);
      cell.classList.toggle('is-my-goal', goals.some((player) => player.id === this.myId));
      if (goals.length > 0) {
        cell.style.setProperty('--player-color', colorVar(goals[0].colorIndex));
      } else {
        cell.style.removeProperty('--player-color');
      }
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

  colorForPlayer(playerId) {
    const player = this.normalized?.players?.find((entry) => entry.id === playerId);
    return colorVar(player?.colorIndex ?? 0);
  }

  get currentColor() {
    return this.colorForPlayer(this.myId);
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
        this.wallEls.set(key, element);
        this.el.appendChild(element);
      }
      const label = wall.orientation === 'H'
        ? `Pared horizontal entre ${coordinateLabel(wall.y, wall.x)} y ${coordinateLabel(wall.y + 1, wall.x)}`
        : `Pared vertical en columna ${wall.x + 1}, fila ${wall.y + 1}`;
      element.setAttribute('aria-label', label);
      if (wall.playerId) element.style.setProperty('--wall-color', this.colorForPlayer(wall.playerId));
      else element.style.removeProperty('--wall-color');
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
    this.hintEls.clear();
    if (!this.isMyTurn || !this.canAct || this.pending) return;
    const fragment = document.createDocumentFragment();
    for (const [orientation, keys] of Object.entries(this.legalWallsByOrientation)) {
      for (const key of keys) {
        const [coordinates] = key.split(':').slice(1);
        const [x, y] = coordinates.split(',').map(Number);
        const hint = document.createElement('span');
        hint.className = `board__wall-hint board__wall-hint--${orientation}`;
        hint.dataset.orientation = orientation;
        hint.dataset.x = String(x);
        hint.dataset.y = String(y);
        hint.dataset.key = key;
        if (orientation === 'H') {
          hint.style.gridRow = String(2 * y + 3);
          hint.style.gridColumn = `${2 * x + 2} / span 3`;
        } else {
          hint.style.gridColumn = String(2 * x + 3);
          hint.style.gridRow = `${2 * y + 2} / span 3`;
        }
        this.hintEls.set(key, hint);
        fragment.appendChild(hint);
      }
    }
    this.hints.appendChild(fragment);
  }

  anchorKeyFromWallKey(key) {
    const parts = String(key).split(':');
    return parts.length === 2 ? parts[1] : null;
  }

  refreshWallInteractivity() {
    const legal = this.legalWallsByOrientation[this.orientation] || new Set();
    const firstAnchor = this.anchorKeyFromWallKey([...legal][0] || '');
    const activeWallKey = this.activeAnchorKey
      ? this.wallKey(this.orientation, ...this.activeAnchorKey.split(',').map(Number))
      : null;
    if (!activeWallKey || !legal.has(activeWallKey)) this.activeAnchorKey = firstAnchor;
    for (const [key, anchor] of this.anchors) {
      const [x, y] = key.split(',').map(Number);
      const isLegal = this.isMyTurn && this.canAct && !this.pending && legal.has(this.wallKey(this.orientation, x, y));
      anchor.classList.toggle('is-legal', isLegal);
      anchor.dataset.legal = isLegal ? 'true' : 'false';
      anchor.dataset.orientation = this.orientation;
      anchor.tabIndex = isLegal && this.activeAnchorKey === key ? 0 : -1;
      anchor.setAttribute('aria-label', `Ancla ${x + 1}, ${y + 1}${isLegal ? `, pared ${this.orientation === 'H' ? 'horizontal' : 'vertical'} legal` : ''}`);
    }
    this.refreshCellTabIndex();
  }

  rotateWall() {
    const previousAnchor = this.activeAnchorKey;
    const next = this.orientation === 'H' ? 'V' : 'H';
    this.orientation = next;
    this.hidePreview();
    const nextWallKey = previousAnchor
      ? this.wallKey(next, ...previousAnchor.split(',').map(Number))
      : null;
    this.activeAnchorKey = nextWallKey && this.legalWallsByOrientation[next]?.has(nextWallKey)
      ? previousAnchor
      : null;
    this.refreshWallInteractivity();
    if (this.options.onRotate) this.options.onRotate(next);
    if (this.activeAnchorKey) this.focusAnchor(this.activeAnchorKey);
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
    this.clearHover();
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
    this.refreshCellTabIndex();
    if (focus) this.cells.get(key)?.focus();
  }

  focusBoard() {
    const cell = this.cells.get(this.activeCellKey) || this.cells.values().next().value;
    if (cell) cell.focus();
  }

  focusAnchor(key) {
    const anchor = this.anchors.get(key);
    if (!anchor) return;
    const [x, y] = key.split(',').map(Number);
    for (const [anchorKey, item] of this.anchors) item.tabIndex = anchorKey === key ? 0 : -1;
    this.activeAnchorKey = key;
    anchor.focus();
    const hint = this.hintEls.get(this.wallKey(this.orientation, x, y));
    if (hint) this.setHoveredWall(hint, anchor);
    else this.showPreview(x, y, this.orientation);
  }

  showPreview(x, y, orientation = this.orientation) {
    if (!this.preview) return;
    const nx = Number(x);
    const ny = Number(y);
    const nextOrientation = orientation === 'V' ? 'V' : 'H';
    if (!Number.isInteger(nx) || !Number.isInteger(ny)) return;
    const isLegal = this.legalWallsByOrientation[nextOrientation]?.has(this.wallKey(nextOrientation, nx, ny));
    if (!isLegal) {
      this.hidePreview();
      return;
    }
    this.preview.hidden = false;
    this.preview.className = `board__wall-preview board__wall-preview--${nextOrientation} is-visible`;
    this.preview.style.setProperty('--wall-color', this.currentColor);
    if (nextOrientation === 'H') {
      this.preview.style.gridRow = String(2 * ny + 3);
      this.preview.style.gridColumn = `${2 * nx + 2} / span 3`;
    } else {
      this.preview.style.gridColumn = String(2 * nx + 3);
      this.preview.style.gridRow = `${2 * ny + 2} / span 3`;
    }
  }

  clearHoveredCell() {
    if (this.hoverTarget?.type === 'cell') {
      this.hoverTarget.element.classList.remove('is-hovered');
      this.hoverTarget = null;
    }
  }

  setHoveredCell(cell) {
    this.clearHoveredCell();
    if (this.hoverTarget?.type === 'wall' || (this.preview && !this.preview.hidden)) this.hidePreview();
    if (!cell) return;
    cell.classList.add('is-hovered');
    this.hoverTarget = {
      type: 'cell',
      element: cell,
      key: this.cellKey(Number(cell.dataset.x), Number(cell.dataset.y)),
    };
  }

  setHoveredWall(hint, anchor = null) {
    this.clearHoveredCell();
    this.hoverAnchor = hint.dataset.key;
    for (const [key, other] of this.hintEls) other.classList.toggle('is-hovered', key === hint.dataset.key);
    for (const other of this.anchors.values()) other.classList.remove('is-hovered');
    if (anchor) anchor.classList.add('is-hovered');
    this.hoverTarget = { type: 'wall', element: hint, key: hint.dataset.key };
    this.showPreview(hint.dataset.x, hint.dataset.y, hint.dataset.orientation);
  }

  hidePreview() {
    if (!this.preview) return;
    this.preview.hidden = true;
    this.preview.classList.remove('is-visible');
    for (const hint of this.hintEls.values()) hint.classList.remove('is-hovered');
    for (const anchor of this.anchors.values()) anchor.classList.remove('is-hovered');
    this.hoverAnchor = null;
    if (this.hoverTarget?.type === 'wall') this.hoverTarget = null;
  }

  clearHover() {
    this.clearHoveredCell();
    this.hidePreview();
  }

  onClick(event) {
    const cell = event.target.closest('.board__cell');
    if (cell) {
      if (!this.isMyTurn || !this.canAct || this.pending) return;
      const key = this.cellKey(Number(cell.dataset.x), Number(cell.dataset.y));
      if (!this.legalMoves.has(key)) return;
      this.setActiveCell(Number(cell.dataset.x), Number(cell.dataset.y));
      if (this.options.onMove) this.options.onMove({ x: Number(cell.dataset.x), y: Number(cell.dataset.y) });
      return;
    }
    const hint = (event.detail > 0 ? this.findHintNearPointer(event) : null)
      || event.target.closest('.board__wall-hint');
    if (hint) {
      event.preventDefault();
      this.placeWallAt(hint.dataset.x, hint.dataset.y, hint.dataset.orientation);
      return;
    }
    const anchor = event.target.closest('.board__anchor');
    if (anchor) {
      event.preventDefault();
      this.placeWallAt(anchor.dataset.x, anchor.dataset.y, this.orientation);
    }
  }

  placeWallAt(x, y, orientation = this.orientation) {
    if (!this.isMyTurn || !this.canAct || this.pending) return;
    const nx = Number(x);
    const ny = Number(y);
    const nextOrientation = orientation === 'V' ? 'V' : 'H';
    if (!this.legalWallsByOrientation[nextOrientation]?.has(this.wallKey(nextOrientation, nx, ny))) return;
    if (this.options.onWall) this.options.onWall({ orientation: nextOrientation, x: nx, y: ny });
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
        this.hidePreview();
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
    if (event.key === 'Escape') {
      this.hidePreview();
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

  findHintNearPointer(event) {
    if (!this.hintEls.size) return null;
    const px = event.clientX;
    const py = event.clientY;
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const hint of this.hintEls.values()) {
      const rect = hint.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const dx = Math.max(rect.left - px, 0, px - rect.right);
      const dy = Math.max(rect.top - py, 0, py - rect.bottom);
      if (hint.dataset.orientation === 'H') {
        if (dy > 0 || dx > this.wallHitRadius) continue;
      } else if (dx > 0 || dy > this.wallHitRadius) continue;
      const centerDistance = Math.hypot(
        px - (rect.left + rect.right) / 2,
        py - (rect.top + rect.bottom) / 2,
      );
      if (centerDistance < bestDistance) {
        bestDistance = centerDistance;
        best = hint;
      }
    }
    return best;
  }

  onPointerMove(event) {
    if (!this.isMyTurn || !this.canAct || this.pending) return;
    const cell = event.target.closest('.board__cell');
    if (cell) {
      this.setHoveredCell(cell);
      return;
    }
    const hint = this.findHintNearPointer(event) || event.target.closest('.board__wall-hint');
    if (!hint) {
      this.clearHoveredCell();
      if (!event.target.closest('.board__anchor')) this.hidePreview();
      return;
    }
    this.setHoveredWall(hint, event.target.closest('.board__anchor'));
  }

  onPointerLeave() {
    if (document.activeElement?.closest?.('.board__anchor')) return;
    this.clearHover();
  }

  onFocusIn(event) {
    const anchor = event.target.closest('.board__anchor');
    if (!anchor) return;
    const x = Number(anchor.dataset.x);
    const y = Number(anchor.dataset.y);
    this.activeAnchorKey = this.cellKey(x, y);
    const hint = this.hintEls.get(this.wallKey(this.orientation, x, y));
    if (hint) this.setHoveredWall(hint, anchor);
    else this.showPreview(x, y, this.orientation);
  }

  onFocusOut(event) {
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
    this.wallEls.clear();
    this.hintEls.clear();
    this.view = null;
    this.normalized = null;
  }
}
