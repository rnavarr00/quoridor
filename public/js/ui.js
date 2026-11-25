import { BoardRenderer } from './board.js';
import {
  app,
  configSummary,
  CREATE_DEFAULT_CONFIG,
  goalSideLabel,
  LOCAL_DEFAULT_CONFIG,
  normalizeRoomCode,
  playerInitial,
  colorVar,
  sanitizeConfig,
  savePrefs,
  SPAWN_MODE_LABELS,
  validateAlias,
  validateRoomCode,
} from './state.js';

const COLOR_NAMES = ['Rojo', 'Azul', 'Verde', 'Ámbar', 'Violeta', 'Naranja', 'Teal', 'Rosa'];
const REASON_LABELS = {
  goal: 'Meta alcanzada',
  last_active: 'Último jugador activo',
  no_active: 'Partida abandonada',
};
const TOAST_DURATION = { success: 3000, info: 4000, warning: 6000, error: 8000 };

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function create(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = String(text);
  return node;
}

function fillRangeSelect(select, min, max) {
  if (!select) return;
  select.replaceChildren();
  for (let value = min; value <= max; value += 1) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = String(value);
    select.appendChild(option);
  }
}

function focusableElements(root) {
  if (!root) return [];
  return [...root.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((node) => node.offsetParent !== null || node === document.activeElement);
}

class UI {
  constructor() {
    this.el = {};
    this.handlers = {};
    this.board = null;
    this.currentScreen = 'home';
    this.connection = 'offline';
    this.aliasValid = false;
    this.aliasSaveTimer = null;
    this.createPending = false;
    this.joinPending = false;
    this.queuePending = false;
    this.lobbyPending = false;
    this.lobbyConfigTimer = null;
    this.lobbyConfigPending = {};
    this.gameRoomCode = '';
    this.localPlayerData = [];
    this.lastGameState = null;
    this.lastMode = null;
    this.playerCards = new Map();
    this.activeCardTimeEl = null;
    this.timer = {
      active: false,
      paused: false,
      remaining: 30,
      duration: 30,
      receivedAt: 0,
      raf: null,
      lastAnnouncedSecond: null,
      zeroReached: false,
    };
    this.toastQueue = [];
    this.visibleToasts = [];
    this.toastDedupe = new Map();
    this.modal = null;
    this.roomSnapshot = null;
  }

  init(handlers = {}) {
    this.handlers = handlers;
    this.cacheElements();
    this.buildAnnouncers();
    this.populateSelects();
    this.board = new BoardRenderer(this.el.boardFrame, {
      onMove: (payload) => this.handlers.onBoardMove?.(payload),
      onWall: (payload) => this.handlers.onBoardWall?.(payload),
      onAnnounce: (message) => this.announce(message),
    });
    this.bindEvents();
    this.applyPrefs();
    this.setCreateDefaults(CREATE_DEFAULT_CONFIG);
    this.setLocalDefaults();
    this.showScreen('home', { focus: false, push: false });
    this.setConnection('offline');
  }

  cacheElements() {
    const ids = [
      'connection-banner', 'connection-banner-text', 'connection-overlay', 'connection-overlay-text',
      'identity-summary', 'alias', 'alias-error', 'alias-form', 'home-connection-hint',
      'howto-toggle', 'howto-panel', 'create-form', 'create-size', 'create-max-players',
      'create-walls', 'create-walls-value', 'create-spawn', 'create-summary', 'create-error',
      'create-submit', 'create-reset', 'join-form', 'room-code', 'room-code-error', 'join-error',
      'join-submit', 'paste-code', 'local-form', 'local-size', 'local-player-count', 'local-walls',
      'local-walls-value', 'local-spawn', 'local-players', 'local-summary', 'local-error',
      'local-submit', 'local-reset', 'queue-status', 'queue-detail', 'queue-error', 'queue-cancel',
      'lobby-title', 'copy-code', 'lobby-status', 'lobby-player-count', 'lobby-players',
      'lobby-error', 'lobby-leave', 'lobby-start', 'lobby-start-hint', 'lobby-config-form',
      'lobby-config-note', 'lobby-size', 'lobby-max-players', 'lobby-walls', 'lobby-walls-value',
      'lobby-spawn', 'lobby-config-summary', 'lobby-reset', 'board-frame', 'game-room-code',
      'game-copy-code', 'game-status', 'game-connection-dot', 'game-status-text',
      'players-drawer-toggle', 'game-main', 'game-message', 'aside-backdrop', 'game-aside',
      'close-aside', 'game-players', 'leave-game', 'self-avatar', 'self-name', 'self-meta',
      'self-walls', 'self-goal',
      'game-leave-inline', 'game-timer', 'timer-value', 'timer-fill', 'patterns-toggle',
      'contrast-toggle', 'fullscreen-toggle', 'game-howto', 'gameover-title',
      'gameover-announcement', 'gameover-avatar', 'gameover-winner-name', 'gameover-reason',
      'gameover-players', 'gameover-error', 'gameover-rematch', 'gameover-leave',
      'toast-region', 'modal-root', 'overlay-root',
    ];
    for (const id of ids) {
      this.el[id.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase())] = document.getElementById(id);
    }
    this.el.screens = [...document.querySelectorAll('section.screen[data-screen]')];
    this.el.homeActions = [...document.querySelectorAll('[data-home-action]')];
    this.el.navButtons = [...document.querySelectorAll('[data-nav]')];
    this.el.timebar = this.el.gameTimer?.querySelector('.timebar') || null;
  }

  buildAnnouncers() {
    this.politeAnnouncer = create('p', 'sr-only');
    this.politeAnnouncer.setAttribute('aria-live', 'polite');
    this.politeAnnouncer.setAttribute('aria-atomic', 'true');
    this.assertiveAnnouncer = create('p', 'sr-only');
    this.assertiveAnnouncer.setAttribute('aria-live', 'assertive');
    this.assertiveAnnouncer.setAttribute('aria-atomic', 'true');
    document.body.append(this.politeAnnouncer, this.assertiveAnnouncer);
  }

  populateSelects() {
    fillRangeSelect(this.el.createSize, 8, 20);
    fillRangeSelect(this.el.localSize, 8, 20);
    fillRangeSelect(this.el.lobbySize, 8, 20);
    fillRangeSelect(this.el.createMaxPlayers, 2, 8);
    fillRangeSelect(this.el.lobbyMaxPlayers, 2, 8);
    fillRangeSelect(this.el.localPlayerCount, 2, 8);
  }

  bindEvents() {
    this.el.alias?.addEventListener('input', () => this.onAliasInput());
    this.el.alias?.addEventListener('blur', () => this.onAliasBlur());
    this.el.alias?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (this.aliasValid) {
          const first = this.el.homeActions.find((button) => !button.disabled);
          first?.focus();
        }
      }
    });

    for (const button of this.el.homeActions) {
      button.addEventListener('click', () => {
        if (!this.aliasValid || button.disabled) return;
        this.handlers.onHomeAction?.(button.dataset.homeAction);
      });
    }

    for (const button of this.el.navButtons) {
      button.addEventListener('click', () => {
        this.handlers.onNavigate?.(button.dataset.nav);
      });
    }

    this.el.howtoToggle?.addEventListener('click', () => {
      const open = this.el.howtoToggle.getAttribute('aria-expanded') !== 'true';
      this.setHowToOpen(open);
    });
    for (const node of [this.el.howtoToggle, this.el.howtoPanel]) {
      node?.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (this.el.howtoToggle.getAttribute('aria-expanded') !== 'true') return;
        event.preventDefault();
        this.setHowToOpen(false, true);
      });
    }

    this.el.createForm?.addEventListener('input', () => this.updateCreateSummary());
    this.el.createForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.createPending) return;
      this.handlers.onCreate?.(this.getCreateConfig());
    });
    this.el.createReset?.addEventListener('click', () => {
      this.setCreateDefaults(CREATE_DEFAULT_CONFIG);
      this.announce('Configuración restablecida.');
    });

    this.el.roomCode?.addEventListener('input', () => {
      const normalized = normalizeRoomCode(this.el.roomCode.value);
      if (this.el.roomCode.value !== normalized) this.el.roomCode.value = normalized;
      this.setJoinError(null);
      this.setCodeFieldError(null);
    });
    this.el.roomCode?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.el.joinForm?.requestSubmit();
      }
    });
    this.el.joinForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.joinPending) return;
      const value = normalizeRoomCode(this.el.roomCode.value);
      const result = validateRoomCode(value);
      if (!result.ok) {
        this.setCodeFieldError(result.error);
        this.el.roomCode?.focus();
        return;
      }
      this.setCodeFieldError(null);
      this.handlers.onJoin?.(result.value);
    });
    this.el.pasteCode?.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        const code = normalizeRoomCode(text);
        this.el.roomCode.value = code;
        this.setCodeFieldError(null);
        this.el.roomCode.focus();
        this.announce('Código pegado.');
      } catch (error) {
        this.el.roomCode.focus();
        this.toast('Pega el código manualmente.', 'warning');
      }
    });

    this.el.localForm?.addEventListener('input', (event) => this.onLocalInput(event));
    this.el.localForm?.addEventListener('change', (event) => this.onLocalChange(event));
    this.el.localForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.handlers.onLocalStart?.(this.getLocalSetup());
    });
    this.el.localReset?.addEventListener('click', () => {
      this.setLocalDefaults();
      this.announce('Configuración local restablecida.');
    });

    this.el.queueCancel?.addEventListener('click', () => {
      if (this.queuePending) return;
      this.handlers.onCancelQueue?.();
    });

    this.el.lobbyConfigForm?.addEventListener('input', (event) => this.onLobbyConfigInput(event));
    this.el.lobbyConfigForm?.addEventListener('change', (event) => this.onLobbyConfigChange(event));
    this.el.lobbyConfigForm?.addEventListener('submit', (event) => event.preventDefault());
    this.el.lobbyReset?.addEventListener('click', () => {
      if (this.lobbyPending) return;
      this.handlers.onLobbyReset?.();
    });
    this.el.lobbyStart?.addEventListener('click', () => {
      if (this.el.lobbyStart.disabled) return;
      this.handlers.onStartGame?.();
    });
    this.el.lobbyLeave?.addEventListener('click', () => this.handlers.onLeaveLobby?.());
    this.el.copyCode?.addEventListener('click', () => this.copyRoomCode());
    this.el.gameCopyCode?.addEventListener('click', () => this.copyRoomCode());

    this.el.playersDrawerToggle?.addEventListener('click', () => this.toggleAside());
    this.el.closeAside?.addEventListener('click', () => this.closeAside(true));
    this.el.asideBackdrop?.addEventListener('click', () => this.closeAside(true));

    this.el.leaveGame?.addEventListener('click', () => this.confirmLeaveGame());
    this.el.gameLeaveInline?.addEventListener('click', () => this.confirmLeaveGame());

    this.el.patternsToggle?.addEventListener('click', () => {
      this.applyPrefs({ ...app.prefs, patterns: !app.prefs.patterns });
    });
    this.el.contrastToggle?.addEventListener('click', () => {
      this.applyPrefs({ ...app.prefs, highContrast: !app.prefs.highContrast });
    });
    this.el.fullscreenToggle?.addEventListener('click', () => this.toggleFullscreen());
    this.el.gameHowto?.addEventListener('click', () => this.openHowTo());

    this.el.gameoverRematch?.addEventListener('click', () => this.handlers.onRematch?.());
    this.el.gameoverLeave?.addEventListener('click', () => this.handlers.onLeaveGameOver?.());
  }

  setHowToOpen(open, restoreFocus = false) {
    this.el.howtoToggle?.setAttribute('aria-expanded', String(Boolean(open)));
    if (this.el.howtoPanel) this.el.howtoPanel.hidden = !open;
    this.announce(open ? 'Cómo jugar abierto.' : 'Cómo jugar cerrado.');
    if (!open && restoreFocus) this.el.howtoToggle?.focus();
  }

  showScreen(name, options = {}) {
    const { focus = true, push = false } = options;
    if (!this.el.screens.some((section) => section.dataset.screen === name)) return;
    const changed = this.currentScreen !== name;
    this.currentScreen = name;
    for (const section of this.el.screens) section.hidden = section.dataset.screen !== name;
    document.body.dataset.screen = name;
    if (name !== 'game') this.stopTimer();
    if (name !== 'game') this.closeAside(false);
    if (changed && push) {
      try {
        history.pushState({ screen: name }, '', location.href);
      } catch (error) {
        // La navegación por historial no está disponible.
      }
    }
    if (focus) {
      const screen = this.el.screens.find((section) => section.dataset.screen === name);
      const heading = screen?.querySelector('h1');
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }
    this.updateConnectionOverlay();
  }

  setScreenTitle(text) {
    document.title = text ? `${text} · Quoridor Arena` : 'Quoridor Arena';
  }

  announce(message, assertive = false) {
    if (!message) return;
    const region = assertive ? this.assertiveAnnouncer : this.politeAnnouncer;
    if (!region) return;
    region.textContent = '';
    setTimeout(() => {
      region.textContent = message;
    }, 30);
  }

  setAlias(value, options = {}) {
    const text = typeof value === 'string' ? value : '';
    if (this.el.alias) this.el.alias.value = text;
    const result = validateAlias(text);
    this.aliasValid = result.ok;
    this.setAliasError(result.ok ? null : result.error);
    this.updateHomeActions();
    this.el.identitySummary.textContent = result.ok ? `Jugando como ${result.value}` : '';
    if (options.updateFirstLocal && result.ok) this.updateFirstLocalName(result.value);
  }

  onAliasInput() {
    const result = validateAlias(this.el.alias.value);
    this.aliasValid = result.ok;
    if (this.el.alias.value && !result.ok && this.el.alias.getAttribute('aria-invalid') === 'true') {
      this.setAliasError(result.error);
    } else if (result.ok) {
      this.setAliasError(null);
    }
    this.updateHomeActions();
    this.el.identitySummary.textContent = result.ok ? `Jugando como ${result.value}` : '';
    if (this.aliasSaveTimer) clearTimeout(this.aliasSaveTimer);
    this.aliasSaveTimer = setTimeout(() => {
      this.aliasSaveTimer = null;
      this.handlers.onAliasChange?.(result.ok ? result.value : '');
    }, 250);
    if (result.ok) this.updateFirstLocalName(result.value);
  }

  onAliasBlur() {
    const result = validateAlias(this.el.alias.value);
    this.aliasValid = result.ok;
    if (result.ok) {
      if (this.el.alias.value !== result.value) this.el.alias.value = result.value;
      this.setAliasError(null);
      this.handlers.onAliasChange?.(result.value);
    } else if (this.el.alias.value.trim()) {
      this.setAliasError(result.error);
    }
    this.updateHomeActions();
  }

  setAliasError(message) {
    if (!this.el.aliasError) return;
    this.el.aliasError.textContent = message || '';
    this.el.aliasError.hidden = !message;
    this.el.alias?.setAttribute('aria-invalid', String(Boolean(message)));
  }

  updateHomeActions() {
    for (const button of this.el.homeActions) {
      const action = button.dataset.homeAction;
      const needsNetwork = action !== 'local';
      button.disabled = !this.aliasValid || (needsNetwork && this.connection !== 'online');
    }
    if (!this.el.homeConnectionHint) return;
    if (!this.aliasValid) {
      this.el.homeConnectionHint.textContent = 'Escribe un alias válido para activar las acciones.';
    } else if (this.connection !== 'online') {
      this.el.homeConnectionHint.textContent = 'Sin conexión: puedes jugar en local, pero las partidas online esperan al servidor.';
    } else {
      this.el.homeConnectionHint.textContent = '';
    }
  }

  setConnection(status, info = {}) {
    const previous = this.connection;
    this.connection = status;
    document.body.classList.remove('is-connection-online', 'is-connection-connecting', 'is-connection-reconnecting', 'is-connection-offline');
    document.body.classList.add(`is-connection-${status}`);
    const messages = {
      connecting: 'Conectando con el servidor…',
      reconnecting: info.retryInMs
        ? `Reconectando… Reintento en ${Math.max(1, Math.ceil(info.retryInMs / 1000))} s.`
        : 'Reconectando…',
      offline: navigator.onLine === false
        ? 'Sin conexión. Se reintentará al recuperar la red.'
        : 'Sin conexión con el servidor.',
      online: 'Conexión restablecida.',
    };
    const message = messages[status] || 'Conectando…';
    if (this.el.connectionBanner) {
      this.el.connectionBanner.hidden = status === 'online';
      this.el.connectionBannerText.textContent = message;
    }
    if (this.el.connectionOverlay) {
      this.el.connectionOverlayText.textContent = status === 'offline'
        ? 'Sin conexión. No se pueden enviar acciones de partida.'
        : 'Reconectando… No cierres esta pestaña.';
      const showOverlay = status !== 'online' && ['game', 'lobby'].includes(this.currentScreen);
      this.el.connectionOverlay.hidden = !showOverlay;
    }
    this.updateGameConnection(status);
    this.updateHomeActions();
    if (status === 'online' && previous !== 'online' && this.timer.active) this.resumeTimer();
    if (status !== 'online' && this.timer.active) this.pauseTimer();
    this.updateConnectionOverlay();
  }

  updateConnectionOverlay() {
    if (!this.el.connectionOverlay) return;
    const show = this.connection !== 'online' && ['game', 'lobby'].includes(this.currentScreen);
    this.el.connectionOverlay.hidden = !show;
  }

  updateGameConnection(status = this.connection) {
    if (!this.el.gameConnectionDot) return;
    const labels = { online: 'En línea', connecting: 'Conectando', reconnecting: 'Reconectando', offline: 'Sin conexión' };
    this.el.gameConnectionDot.className = `connection-dot connection-dot--${status}`;
    this.el.gameConnectionDot.title = labels[status] || '';
    if (status !== 'online') {
      const current = this.el.gameStatusText.textContent;
      if (current && !current.includes('Reconectando') && !current.includes('Sin conexión')) {
        this.el.gameStatusText.dataset.stable = current;
        this.el.gameStatusText.textContent = status === 'offline' ? 'Sin conexión' : 'Reconectando…';
      }
    } else if (this.el.gameStatusText.dataset.stable) {
      this.el.gameStatusText.textContent = this.el.gameStatusText.dataset.stable;
      delete this.el.gameStatusText.dataset.stable;
    }
  }

  updateCreateSummary() {
    const config = this.getCreateConfig();
    if (this.el.createWallsValue) this.el.createWallsValue.textContent = String(config.wallsPerPlayer);
    if (this.el.createSummary) this.el.createSummary.textContent = configSummary(config);
  }

  getCreateConfig() {
    return sanitizeConfig({
      size: Number(this.el.createSize.value),
      maxPlayers: Number(this.el.createMaxPlayers.value),
      wallsPerPlayer: Number(this.el.createWalls.value),
      spawnMode: this.el.createSpawn.value,
      turnSeconds: 30,
    }, CREATE_DEFAULT_CONFIG);
  }

  setCreateDefaults(config = CREATE_DEFAULT_CONFIG) {
    const safe = sanitizeConfig(config, CREATE_DEFAULT_CONFIG);
    this.el.createSize.value = String(safe.size);
    this.el.createMaxPlayers.value = String(safe.maxPlayers);
    this.el.createWalls.value = String(safe.wallsPerPlayer);
    this.el.createSpawn.value = safe.spawnMode;
    this.updateCreateSummary();
  }

  setCreatePending(pending) {
    this.createPending = Boolean(pending);
    this.el.createForm.dataset.pending = pending ? 'true' : 'false';
    this.el.createForm.setAttribute('aria-busy', String(Boolean(pending)));
    const controls = this.el.createForm.querySelectorAll('input, select, #create-reset, #create-submit');
    for (const control of controls) control.disabled = Boolean(pending);
    this.el.createSubmit.textContent = pending ? 'Creando sala…' : 'Crear sala';
  }

  setCreateError(message) {
    if (!this.el.createError) return;
    this.el.createError.textContent = message || '';
    this.el.createError.hidden = !message;
  }

  setJoinCode(code) {
    if (!this.el.roomCode) return;
    this.el.roomCode.value = normalizeRoomCode(code);
    this.setCodeFieldError(null);
    this.setJoinError(null);
  }

  setJoinPending(pending) {
    this.joinPending = Boolean(pending);
    this.el.joinForm.dataset.pending = pending ? 'true' : 'false';
    this.el.joinForm.setAttribute('aria-busy', String(Boolean(pending)));
    const controls = this.el.joinForm.querySelectorAll('input, #paste-code, #join-submit');
    for (const control of controls) control.disabled = Boolean(pending);
    this.el.joinSubmit.textContent = pending ? 'Uniéndose…' : 'Unirse';
  }

  setJoinError(message) {
    if (!this.el.joinError) return;
    this.el.joinError.textContent = message || '';
    this.el.joinError.hidden = !message;
  }

  setCodeFieldError(message) {
    if (!this.el.roomCodeError) return;
    this.el.roomCodeError.textContent = message || '';
    this.el.roomCodeError.hidden = !message;
    this.el.roomCode?.setAttribute('aria-invalid', String(Boolean(message)));
  }

  renderQueue(payload = {}) {
    this.showScreen('queue');
    this.queuePending = false;
    const position = Number.isInteger(payload.position) ? payload.position : null;
    const queueSize = Number.isInteger(payload.queueSize) ? payload.queueSize : null;
    this.el.queueStatus.textContent = 'Buscando jugadores…';
    this.el.queueDetail.textContent = position && queueSize
      ? `Posición ${position} de ${queueSize} en cola.`
      : (queueSize ? `${queueSize} jugador${queueSize === 1 ? '' : 'es'} en cola.` : '');
    this.el.queueError.hidden = true;
    this.el.queueCancel.disabled = false;
    this.el.queueCancel.textContent = 'Cancelar búsqueda';
  }

  setQueuePending(pending) {
    this.queuePending = Boolean(pending);
    this.el.queueCancel.disabled = Boolean(pending);
    this.el.queueCancel.textContent = pending ? 'Cancelando…' : 'Cancelar búsqueda';
  }

  setMatchFound() {
    this.el.queueStatus.textContent = 'Partida encontrada. Preparando el tablero…';
    this.el.queueDetail.textContent = 'Esperando el estado inicial del servidor.';
    this.el.queueCancel.disabled = true;
    this.announce('Partida encontrada. Preparando el tablero.', true);
  }

  renderLobby(room, options = {}) {
    if (!room) return;
    this.roomSnapshot = room;
    const myId = options.myId || null;
    const players = Array.isArray(room.players) ? [...room.players].sort((a, b) => a.colorIndex - b.colorIndex) : [];
    const config = sanitizeConfig(room.config, CREATE_DEFAULT_CONFIG);
    const isHost = room.hostPlayerId === myId;
    const activePlayers = players.filter((player) => player.connected && !player.ghost).length;
    const pending = Boolean(options.pending);
    this.lobbyPending = pending;
    this.showScreen('lobby');

    const code = typeof room.roomCode === 'string' ? room.roomCode : '';
    this.el.lobbyTitle.textContent = code || '------';
    this.el.lobbyTitle.setAttribute('aria-label', `Código de sala ${code || 'no disponible'}`);
    this.el.lobbyPlayerCount.textContent = `${players.length}/${config.maxPlayers}`;
    this.el.lobbyStatus.textContent = pending
      ? 'Guardando cambios…'
      : (isHost
        ? 'Eres el host. Configura la sala y empieza cuando estéis todos.'
        : 'Esperando a que el host empiece la partida…');
    this.el.lobbyPlayers.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const player of players) {
      fragment.appendChild(this.createPlayerRow(player, myId, room.hostPlayerId));
    }
    this.el.lobbyPlayers.appendChild(fragment);
    this.renderLobbyConfig(config, {
      disabled: !isHost || pending || this.connection !== 'online',
      note: isHost ? 'Puedes cambiar la configuración hasta empezar.' : 'Solo el host puede cambiar la configuración.',
      config,
    });

    const blocked = !isHost || pending || this.connection !== 'online' || activePlayers < 2 || room.status !== 'lobby';
    this.el.lobbyStart.hidden = !isHost;
    this.el.lobbyStart.disabled = blocked;
    this.el.lobbyStart.textContent = pending && options.pendingAction === 'startGame' ? 'Empezando…' : 'Empezar partida';
    this.el.lobbyReset.hidden = !isHost;
    this.el.lobbyReset.disabled = !isHost || pending || this.connection !== 'online';
    this.el.lobbyLeave.disabled = pending;
    if (!isHost) {
      this.el.lobbyStartHint.textContent = 'Solo el host puede empezar la partida.';
    } else if (activePlayers < 2) {
      this.el.lobbyStartHint.textContent = 'Necesitas al menos 2 jugadores conectados para empezar.';
    } else if (pending) {
      this.el.lobbyStartHint.textContent = 'Hay una actualización pendiente.';
    } else if (this.connection !== 'online') {
      this.el.lobbyStartHint.textContent = 'Sin conexión: no se puede empezar la partida.';
    } else {
      this.el.lobbyStartHint.textContent = 'Todo listo para empezar.';
    }
    this.setLobbyError(null);
    this.updateConnectionOverlay();
  }

  createPlayerRow(player, myId, hostId) {
    const row = create('li', 'player-row');
    if (player.id === myId) row.classList.add('player-row--self');
    if (player.ghost || !player.connected) row.classList.add('player-row--ghost');
    row.style.setProperty('--player-color', colorVar(player.colorIndex));
    const avatar = create('span', 'avatar', playerInitial(player.name));
    avatar.setAttribute('aria-hidden', 'true');
    const name = create('span', 'player-row__name', player.name);
    name.title = player.name;
    row.append(avatar, name);
    const badges = create('span', 'player-row__badges');
    if (player.isHost || player.id === hostId) badges.appendChild(create('span', 'badge badge--host', 'Host'));
    if (player.id === myId) badges.appendChild(create('span', 'badge badge--self', 'Tú'));
    if (player.ghost) badges.appendChild(create('span', 'badge badge--ghost', 'Fantasma'));
    if (badges.childElementCount) row.appendChild(badges);
    const state = player.ghost || !player.connected
      ? create('span', 'player-row__state', 'Desconectado')
      : create('span', 'player-row__state player-row__state--online', 'Conectado');
    row.appendChild(state);
    return row;
  }

  renderLobbyConfig(config, { disabled, note, config: safeConfig }) {
    this.suppressLobbyEvents = true;
    const safe = safeConfig || sanitizeConfig(config, CREATE_DEFAULT_CONFIG);
    this.el.lobbySize.value = String(safe.size);
    this.el.lobbyMaxPlayers.value = String(safe.maxPlayers);
    this.el.lobbyWalls.value = String(safe.wallsPerPlayer);
    this.el.lobbyWallsValue.textContent = String(safe.wallsPerPlayer);
    this.el.lobbySpawn.value = safe.spawnMode;
    this.el.lobbyConfigSummary.textContent = configSummary(safe, this.roomSnapshot?.players?.length || null);
    this.el.lobbyConfigNote.textContent = note;
    for (const control of this.el.lobbyConfigForm.querySelectorAll('input, select, button')) {
      control.disabled = Boolean(disabled);
    }
    this.suppressLobbyEvents = false;
  }

  onLobbyConfigInput(event) {
    if (this.suppressLobbyEvents) return;
    if (event.target === this.el.lobbyWalls) {
      this.el.lobbyWallsValue.textContent = this.el.lobbyWalls.value;
      this.updateLobbySummary();
    }
  }

  onLobbyConfigChange(event) {
    if (this.suppressLobbyEvents || this.lobbyPending) return;
    const target = event.target;
    if (!['lobby-size', 'lobby-max-players', 'lobby-walls', 'lobby-spawn'].includes(target.id)) return;
    const mapping = {
      'lobby-size': ['size', Number(target.value)],
      'lobby-max-players': ['maxPlayers', Number(target.value)],
      'lobby-walls': ['wallsPerPlayer', Number(target.value)],
      'lobby-spawn': ['spawnMode', target.value],
    };
    const [key, value] = mapping[target.id];
    this.updateLobbySummary();
    Object.assign(this.lobbyConfigPending, { [key]: value });
    if (this.lobbyConfigTimer) clearTimeout(this.lobbyConfigTimer);
    this.lobbyConfigTimer = setTimeout(() => {
      this.lobbyConfigTimer = null;
      const changes = this.lobbyConfigPending;
      this.lobbyConfigPending = {};
      this.handlers.onLobbyConfig?.(changes);
    }, 200);
  }

  updateLobbySummary() {
    const config = sanitizeConfig({
      size: Number(this.el.lobbySize.value),
      maxPlayers: Number(this.el.lobbyMaxPlayers.value),
      wallsPerPlayer: Number(this.el.lobbyWalls.value),
      spawnMode: this.el.lobbySpawn.value,
      turnSeconds: 30,
    }, this.roomSnapshot?.config || CREATE_DEFAULT_CONFIG);
    this.el.lobbyWallsValue.textContent = String(config.wallsPerPlayer);
    this.el.lobbyConfigSummary.textContent = configSummary(config, this.roomSnapshot?.players?.length || null);
  }

  setLobbyError(message) {
    if (!this.el.lobbyError) return;
    this.el.lobbyError.textContent = message || '';
    this.el.lobbyError.hidden = !message;
  }

  renderGame(view, options = {}) {
    if (!view) return;
    this.lastGameState = view;
    this.lastMode = options.mode || this.lastMode || 'online';
    const myId = options.myId || null;
    const players = Array.isArray(view.players) ? view.players : [];
    const myPlayer = players.find((player) => player.id === myId) || null;
    const current = players.find((player) => player.id === view.turnPlayerId) || null;
    this.showScreen('game', { focus: false });
    this.gameRoomCode = options.roomCode || this.gameRoomCode;
    this.el.gameRoomCode.textContent = this.lastMode === 'local' ? 'LOCAL' : (this.gameRoomCode || '------');
    this.el.gameCopyCode.hidden = this.lastMode === 'local';
    this.el.gameRoomCode.setAttribute('aria-label', this.lastMode === 'local' ? 'Partida local' : `Código de sala ${this.gameRoomCode}`);
    this.board.render(view, {
      myId,
      canAct: Boolean(options.canAct),
      pending: Boolean(options.pending),
    });
    this.renderGamePlayers(view, myId);
    this.renderSelf(view, myId, current, options);
    this.updateHeaderStatus(view, current, options);
    this.updateWallControls(view, myId, options);
    this.updateGameMessage(view, myId, current, options);
    if (this.lastMode === 'local') {
      this.setTimerStatic('—');
    } else {
      const remaining = Number.isFinite(view.remainingSeconds) ? view.remainingSeconds : 30;
      this.startTimer(remaining);
      if (this.connection !== 'online') this.pauseTimer();
    }
    this.updateConnectionOverlay();
  }

  renderGamePlayers(view, myId) {
    this.el.gamePlayers.replaceChildren();
    this.playerCards.clear();
    this.activeCardTimeEl = null;
    const players = [...(view.players || [])].sort((a, b) => a.colorIndex - b.colorIndex);
    const hostId = this.roomSnapshot?.hostPlayerId || null;
    const fragment = document.createDocumentFragment();
    for (const player of players) {
      const card = create('article', 'player-card');
      card.dataset.playerId = player.id;
      card.style.setProperty('--player-color', colorVar(player.colorIndex));
      if (player.id === view.turnPlayerId) card.classList.add('is-active');
      if (player.ghost) card.classList.add('is-ghost');
      if (player.id === myId) card.classList.add('is-self');
      if (player.id === view.turnPlayerId) card.setAttribute('aria-current', 'true');

      const avatar = create('span', 'avatar', playerInitial(player.name));
      avatar.setAttribute('aria-hidden', 'true');
      const body = create('div', 'player-card__body');
      const name = create('p', 'player-card__name', player.name);
      name.title = player.name;
      const badges = create('span', 'player-card__badges');
      if (player.id === hostId) badges.appendChild(create('span', 'badge badge--host', 'Host'));
      if (player.id === myId) badges.appendChild(create('span', 'badge badge--self', 'Tú'));
      if (player.ghost) badges.appendChild(create('span', 'badge badge--ghost', 'Fantasma'));
      body.append(name, badges);
      const meta = create('div', 'player-card__meta');
      meta.append(
        create('span', 'player-card__walls', `${Number(player.wallsLeft) || 0} paredes`),
        create('span', 'player-card__time', player.id === view.turnPlayerId ? `${view.remainingSeconds ?? 30}s` : '—'),
      );
      body.appendChild(meta);
      const state = create('span', 'player-card__state', player.ghost ? 'Desconectado' : (player.id === view.turnPlayerId ? 'Turno' : ''));
      if (player.ghost) state.classList.add('is-ghost');
      card.append(avatar, body, state);
      if (player.id === view.turnPlayerId) {
        this.activeCardTimeEl = meta.querySelector('.player-card__time');
      }
      this.playerCards.set(player.id, { card, time: meta.querySelector('.player-card__time') });
      fragment.appendChild(card);
    }
    this.el.gamePlayers.appendChild(fragment);
  }

  renderSelf(view, myId, current, options) {
    const myPlayer = (view.players || []).find((player) => player.id === myId) || null;
    if (!myPlayer) {
      this.el.selfAvatar.textContent = '?';
      this.el.selfAvatar.style.removeProperty('--player-color');
      this.el.selfName.textContent = 'Espectador';
      this.el.selfMeta.textContent = 'Estás observando la partida.';
      this.el.selfWalls.textContent = '— paredes';
      this.el.selfGoal.textContent = 'Meta —';
      return;
    }
    this.el.selfAvatar.textContent = playerInitial(myPlayer.name);
    this.el.selfAvatar.style.setProperty('--player-color', colorVar(myPlayer.colorIndex));
    this.el.selfName.textContent = myPlayer.name;
    this.el.selfName.title = myPlayer.name;
    if (myPlayer.ghost) {
      this.el.selfMeta.textContent = 'Estás fuera de la partida (fantasma).';
    } else if (view.status === 'finished') {
      this.el.selfMeta.textContent = 'Partida finalizada.';
    } else if (view.turnPlayerId === myId) {
      this.el.selfMeta.textContent = 'Tu turno. Elige movimiento o pared.';
    } else if (current) {
      this.el.selfMeta.textContent = `Turno de ${current.name}${this.lastMode === 'local' ? '' : '…'}`;
    } else {
      this.el.selfMeta.textContent = 'Esperando…';
    }
    this.el.selfWalls.textContent = `${Number(myPlayer.wallsLeft) || 0} paredes`;
    const size = view.board?.size || view.config?.size || 9;
    this.el.selfGoal.textContent = goalSideLabel(myPlayer.goal, size);
    this.el.selfAvatar.classList.toggle('avatar--ghost', myPlayer.ghost);
  }

  updateHeaderStatus(view, current, options) {
    const base = view.status === 'finished'
      ? 'Partida finalizada'
      : `En curso · Turno ${view.turnNumber ?? 1}${current ? ` · ${current.name}` : ''}`;
    const connectionPrefix = this.connection === 'online'
      ? ''
      : (this.connection === 'offline' ? 'Sin conexión · ' : 'Reconectando · ');
    this.el.gameStatusText.dataset.stable = `${connectionPrefix}${base}`;
    if (this.connection === 'online' || !this.el.gameStatusText.dataset.locked) {
      this.el.gameStatusText.textContent = `${connectionPrefix}${base}`;
    }
    this.updateGameConnection(this.connection);
    if (this.lastMode === 'local') {
      this.el.gameConnectionDot.className = 'connection-dot connection-dot--local';
      this.el.gameConnectionDot.title = 'Partida local';
    }
    const drawerButton = this.el.playersDrawerToggle;
    drawerButton.textContent = `Jugadores (${(view.players || []).length})`;
    if (!options.myId) drawerButton.disabled = false;
  }

  updateWallControls(view, myId, options = {}) {
    const player = view && myId
      ? (view.players || []).find((entry) => entry.id === myId)
      : null;
    this.el.leaveGame.disabled = Boolean(options.pending);
    this.el.gameLeaveInline.disabled = Boolean(options.pending);
    if (player?.ghost) {
      this.el.leaveGame.textContent = 'Estás fuera de la partida';
      this.el.leaveGame.disabled = true;
      this.el.gameLeaveInline.disabled = true;
    } else {
      this.el.leaveGame.textContent = 'Salir de la partida';
    }
  }

  updateGameMessage(view, myId, current, options) {
    if (!this.el.gameMessage) return;
    if (view.status === 'finished') {
      this.el.gameMessage.hidden = false;
      this.el.gameMessage.textContent = 'Partida finalizada. Consulta el resultado.';
      return;
    }
    if (options.waiting) {
      this.el.gameMessage.hidden = false;
      this.el.gameMessage.textContent = 'Preparando la partida…';
      return;
    }
    if (myId && view.turnPlayerId === myId) {
      this.el.gameMessage.hidden = true;
      return;
    }
    this.el.gameMessage.hidden = true;
  }

  setGameOverPending(pending, mode = this.lastMode) {
    this.el.gameoverRematch.disabled = Boolean(pending);
    this.el.gameoverLeave.disabled = Boolean(pending);
    this.el.gameoverRematch.textContent = pending
      ? (this.lastMode === 'local' ? 'Reiniciando…' : 'Esperando revancha…')
      : 'Revancha';
    this.el.gameoverLeave.textContent = mode === 'local' ? 'Volver a configuración' : 'Salir al inicio';
    if (!pending) this.setGameOverError(null);
  }

  setGameOverError(message) {
    if (!this.el.gameoverError) return;
    this.el.gameoverError.textContent = message || '';
    this.el.gameoverError.hidden = !message;
  }

  renderGameOver(payload, options = {}) {
    const state = payload?.state || this.lastGameState;
    if (!state) return;
    this.lastGameState = state;
    this.lastMode = options.mode || this.lastMode || 'online';
    this.stopTimer();
    this.showScreen('gameover');
    const players = [...(state.players || [])].sort((a, b) => a.colorIndex - b.colorIndex);
    const winnerId = payload?.winnerId || state.winnerId || null;
    const winner = players.find((player) => player.id === winnerId) || null;
    const winnerName = payload?.winnerName || winner?.name || null;
    const reasonCode = payload?.reason || 'goal';
    const reason = REASON_LABELS[reasonCode] || (typeof reasonCode === 'string' ? reasonCode : 'Partida terminada');
    const turnNumber = Number.isInteger(state.turnNumber) ? state.turnNumber : 1;

    this.el.gameoverAvatar.textContent = winner ? playerInitial(winner.name) : '—';
    if (winner) this.el.gameoverAvatar.style.setProperty('--player-color', colorVar(winner.colorIndex));
    else this.el.gameoverAvatar.style.removeProperty('--player-color');
    this.el.gameoverWinnerName.textContent = winnerName || 'Sin ganador';
    this.el.gameoverReason.textContent = `${reason} · Turno ${turnNumber}`;
    this.el.gameoverAnnouncement.textContent = winnerName
      ? `Gana ${winnerName} por ${reason} en el turno ${turnNumber}.`
      : `Fin de la partida en el turno ${turnNumber}: ${reason}.`;
    this.setGameOverError(null);

    this.el.gameoverPlayers.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const player of players) {
      const row = document.createElement('tr');
      if (player.id === winnerId) row.classList.add('is-winner');
      if (player.id === options.myId) row.classList.add('is-self');
      const nameCell = document.createElement('th');
      nameCell.scope = 'row';
      const nameWrap = create('span', 'summary-player');
      const avatar = create('span', 'avatar avatar--sm', playerInitial(player.name));
      avatar.style.setProperty('--player-color', colorVar(player.colorIndex));
      avatar.setAttribute('aria-hidden', 'true');
      nameWrap.append(avatar, create('span', '', player.name));
      if (player.id === options.myId) nameWrap.appendChild(create('span', 'badge badge--self', 'Tú'));
      nameCell.appendChild(nameWrap);
      const wallsCell = create('td', '', String(Number(player.wallsLeft) || 0));
      const statusCell = create('td', '', player.ghost ? 'Fantasma' : 'Activo');
      const size = state.board?.size || state.config?.size || 9;
      const goalCellEl = create('td', '', goalSideLabel(player.goal, size).replace(/^Meta: /, ''));
      row.append(nameCell, wallsCell, statusCell, goalCellEl);
      fragment.appendChild(row);
    }
    this.el.gameoverPlayers.appendChild(fragment);
    this.setGameOverPending(Boolean(options.pending), this.lastMode);
    this.el.gameoverTitle.textContent = 'Fin de la partida';
    if (this.lastMode === 'local') {
      this.el.gameoverLeave.textContent = 'Volver a configuración';
    } else {
      this.el.gameoverLeave.textContent = 'Salir al inicio';
    }
  }

  setGameRoomCode(code) {
    this.gameRoomCode = typeof code === 'string' ? code : '';
    if (this.el.gameRoomCode && this.lastMode !== 'local') {
      this.el.gameRoomCode.textContent = this.gameRoomCode || '------';
      this.el.gameRoomCode.setAttribute('aria-label', `Código de sala ${this.gameRoomCode}`);
    }
  }

  setTimerStatic(text) {
    this.stopTimer();
    this.el.timerValue.textContent = text;
    this.el.timerFill.style.transform = 'scaleX(0)';
    this.el.timebar?.setAttribute('aria-valuenow', '0');
    this.el.timebar?.setAttribute('aria-valuetext', text);
    this.el.gameTimer.classList.remove('is-urgent');
    if (this.activeCardTimeEl) this.activeCardTimeEl.textContent = text;
  }

  startTimer(remaining = 30) {
    const value = clampNumber(remaining, 0, 30, 30);
    this.timer.remaining = value;
    this.timer.duration = 30;
    this.timer.receivedAt = performance.now();
    this.timer.paused = false;
    this.timer.active = true;
    this.timer.lastAnnouncedSecond = null;
    this.timer.zeroReached = false;
    this.renderTimer(value);
    if (!this.timer.raf) {
      this.timer.raf = requestAnimationFrame(() => this.timerLoop());
    }
  }

  updateTimer(remaining) {
    if (!this.timer.active) {
      this.startTimer(remaining);
      return;
    }
    const value = clampNumber(remaining, 0, 30, 0);
    this.timer.remaining = value;
    this.timer.receivedAt = performance.now();
    this.timer.zeroReached = false;
    this.renderTimer(value);
  }

  pauseTimer() {
    if (!this.timer.active || this.timer.paused) return;
    const elapsed = (performance.now() - this.timer.receivedAt) / 1000;
    this.timer.remaining = Math.max(0, this.timer.remaining - elapsed);
    this.timer.paused = true;
    this.renderTimer(this.timer.remaining);
  }

  resumeTimer() {
    if (!this.timer.active || !this.timer.paused) return;
    this.timer.receivedAt = performance.now();
    this.timer.paused = false;
  }

  stopTimer() {
    if (this.timer.raf) cancelAnimationFrame(this.timer.raf);
    this.timer.raf = null;
    this.timer.active = false;
  }

  timerLoop() {
    if (!this.timer.active) {
      this.timer.raf = null;
      return;
    }
    if (!this.timer.paused) {
      const elapsed = (performance.now() - this.timer.receivedAt) / 1000;
      const remaining = Math.max(0, this.timer.remaining - elapsed);
      this.renderTimer(remaining);
      if (remaining <= 0 && !this.timer.zeroReached) {
        this.timer.zeroReached = true;
        if (this.lastMode !== 'local') {
          this.announce('Tiempo agotado. Esperando al servidor.');
          if (this.handlers.onTimerExpired) this.handlers.onTimerExpired();
        }
      }
    }
    this.timer.raf = requestAnimationFrame(() => this.timerLoop());
  }

  renderTimer(remaining) {
    const seconds = clampNumber(Math.ceil(remaining), 0, this.timer.duration, 0);
    this.el.timerValue.textContent = String(seconds);
    const ratio = this.timer.duration > 0 ? Math.max(0, Math.min(1, remaining / this.timer.duration)) : 0;
    this.el.timerFill.style.transform = `scaleX(${ratio})`;
    this.el.timebar?.setAttribute('aria-valuenow', String(seconds));
    this.el.timebar?.setAttribute('aria-valuetext', `${seconds} segundos`);
    this.el.gameTimer.classList.toggle('is-urgent', seconds <= 5);
    if (this.activeCardTimeEl) this.activeCardTimeEl.textContent = `${seconds}s`;
    if (seconds !== this.timer.lastAnnouncedSecond) {
      this.timer.lastAnnouncedSecond = seconds;
      if (seconds === 10 || seconds === 5) {
        this.announce(`Quedan ${seconds} segundos.`);
      }
    }
  }

  toggleAside(force) {
    const open = typeof force === 'boolean' ? force : !this.el.gameAside.classList.contains('is-open');
    this.el.gameAside.classList.toggle('is-open', open);
    this.el.asideBackdrop.hidden = !open;
    this.el.playersDrawerToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      this.el.gameAside.inert = false;
      const first = focusableElements(this.el.gameAside)[0];
      first?.focus();
    }
  }

  closeAside(restoreFocus = false) {
    if (!this.el.gameAside) return;
    this.el.gameAside.classList.remove('is-open');
    this.el.gameAside.inert = true;
    this.el.asideBackdrop.hidden = true;
    this.el.playersDrawerToggle?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.el.playersDrawerToggle?.focus();
  }

  setLocalPlayers(names) {
    this.localPlayerData = names.map((name, index) => ({ name, colorIndex: index }));
  }

  setLocalDefaults() {
    const defaults = LOCAL_DEFAULT_CONFIG;
    this.el.localSize.value = String(defaults.size);
    this.el.localPlayerCount.value = String(defaults.maxPlayers);
    this.el.localWalls.value = String(defaults.wallsPerPlayer);
    this.el.localWallsValue.textContent = String(defaults.wallsPerPlayer);
    this.el.localSpawn.value = defaults.spawnMode;
    this.localPlayerData = [];
    const alias = validateAlias(this.el.alias?.value || '');
    this.renderLocalPlayers(defaults.maxPlayers, { reset: true, firstAlias: alias.ok ? alias.value : '' });
    this.updateLocalSummary();
  }

  renderLocalPlayers(count, options = {}) {
    const { reset = false, firstAlias = '' } = options;
    const previous = reset ? [] : this.localPlayerData;
    const next = [];
    const used = new Set();
    for (let index = 0; index < count; index += 1) {
      const old = previous[index];
      let name = old?.name || (index === 0 && firstAlias ? firstAlias : `Jugador ${index + 1}`);
      let colorIndex = Number.isInteger(old?.colorIndex) ? old.colorIndex : index;
      if (used.has(colorIndex)) {
        colorIndex = Array.from({ length: 8 }, (value, key) => key).find((value) => !used.has(value));
      }
      used.add(colorIndex);
      next.push({ name, colorIndex });
    }
    this.localPlayerData = next;
    this.el.localPlayers.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < next.length; index += 1) {
      fragment.appendChild(this.createLocalPlayerRow(index, next[index]));
    }
    this.el.localPlayers.appendChild(fragment);
    this.updateLocalSummary();
  }

  createLocalPlayerRow(index, player) {
    const row = create('div', 'players-setup__row');
    row.dataset.index = String(index);
    const avatar = create('span', 'avatar', playerInitial(player.name));
    avatar.style.setProperty('--player-color', colorVar(player.colorIndex));
    avatar.setAttribute('aria-hidden', 'true');
    avatar.dataset.localAvatar = 'true';

    const nameField = create('div', 'field');
    const nameLabel = create('label', 'field__label sr-only', `Nombre del jugador ${index + 1}`);
    nameLabel.htmlFor = `local-name-${index}`;
    const nameInput = create('input', 'field__input');
    nameInput.id = `local-name-${index}`;
    nameInput.type = 'text';
    nameInput.maxLength = 16;
    nameInput.autocomplete = 'off';
    nameInput.value = player.name;
    nameInput.dataset.localName = String(index);
    nameInput.setAttribute('aria-label', `Nombre del jugador ${index + 1}`);
    nameField.append(nameLabel, nameInput);

    const colorField = create('div', 'field players-setup__color');
    const colorLabel = create('label', 'field__label sr-only', `Color del jugador ${index + 1}`);
    colorLabel.htmlFor = `local-color-${index}`;
    const colorSelect = create('select', 'field__input');
    colorSelect.id = `local-color-${index}`;
    colorSelect.dataset.localColor = String(index);
    colorSelect.setAttribute('aria-label', `Color del jugador ${index + 1}`);
    for (let colorIndex = 0; colorIndex < 8; colorIndex += 1) {
      const option = document.createElement('option');
      option.value = String(colorIndex);
      option.textContent = COLOR_NAMES[colorIndex];
      colorSelect.appendChild(option);
    }
    colorSelect.value = String(player.colorIndex);
    colorField.append(colorLabel, colorSelect);

    row.append(avatar, nameField, colorField);
    return row;
  }

  onLocalInput(event) {
    const input = event.target.closest('[data-local-name]');
    if (!input) return;
    const index = Number(input.dataset.localName);
    if (!this.localPlayerData[index]) return;
    this.localPlayerData[index].name = input.value;
    const row = input.closest('.players-setup__row');
    const avatar = row?.querySelector('[data-local-avatar]');
    if (avatar) avatar.textContent = playerInitial(input.value);
    this.setLocalError(null);
  }

  onLocalChange(event) {
    const count = event.target.closest('#local-player-count');
    if (count) {
      this.renderLocalPlayers(Number(count.value));
      return;
    }
    const select = event.target.closest('[data-local-color]');
    if (select) {
      const index = Number(select.dataset.localColor);
      const next = Number(select.value);
      const current = this.localPlayerData[index];
      if (!current) return;
      const conflictIndex = this.localPlayerData.findIndex((player, playerIndex) => playerIndex !== index && player.colorIndex === next);
      if (conflictIndex >= 0) {
        const previous = current.colorIndex;
        this.localPlayerData[conflictIndex].colorIndex = previous;
        const otherRow = this.el.localPlayers.querySelector(`[data-index="${conflictIndex}"]`);
        const otherSelect = otherRow?.querySelector('[data-local-color]');
        const otherAvatar = otherRow?.querySelector('[data-local-avatar]');
        if (otherSelect) otherSelect.value = String(previous);
        if (otherAvatar) otherAvatar.style.setProperty('--player-color', colorVar(previous));
      }
      current.colorIndex = next;
      const row = select.closest('.players-setup__row');
      const avatar = row?.querySelector('[data-local-avatar]');
      if (avatar) avatar.style.setProperty('--player-color', colorVar(next));
      return;
    }
    if (event.target === this.el.localWalls) {
      this.el.localWallsValue.textContent = this.el.localWalls.value;
      this.updateLocalSummary();
    }
  }

  updateLocalSummary() {
    const config = sanitizeConfig({
      size: Number(this.el.localSize.value),
      maxPlayers: Number(this.el.localPlayerCount.value),
      wallsPerPlayer: Number(this.el.localWalls.value),
      spawnMode: this.el.localSpawn.value,
      turnSeconds: 30,
    }, LOCAL_DEFAULT_CONFIG);
    this.el.localWallsValue.textContent = String(config.wallsPerPlayer);
    this.el.localSummary.textContent = configSummary(config, config.maxPlayers);
  }

  updateFirstLocalName(alias) {
    if (!this.localPlayerData.length) return;
    const first = this.localPlayerData[0];
    if (/^Jugador 1$/u.test(first.name) || !first.name) {
      first.name = alias;
      const input = this.el.localPlayers.querySelector('[data-local-name="0"]');
      const avatar = this.el.localPlayers.querySelector('[data-index="0"] [data-local-avatar]');
      if (input) input.value = alias;
      if (avatar) avatar.textContent = playerInitial(alias);
    }
  }

  getLocalSetup() {
    const config = sanitizeConfig({
      size: Number(this.el.localSize.value),
      maxPlayers: Number(this.el.localPlayerCount.value),
      wallsPerPlayer: Number(this.el.localWalls.value),
      spawnMode: this.el.localSpawn.value,
      turnSeconds: 30,
    }, LOCAL_DEFAULT_CONFIG);
    const rows = [...this.el.localPlayers.querySelectorAll('.players-setup__row')];
    const players = [];
    const names = new Set();
    const colors = new Set();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const input = row.querySelector('[data-local-name]');
      const select = row.querySelector('[data-local-color]');
      const nameResult = validateAlias(input?.value || '');
      if (!nameResult.ok) {
        return { ok: false, error: `Jugador ${index + 1}: ${nameResult.error}`, config, players: [] };
      }
      const key = nameResult.value.toLocaleLowerCase('es');
      if (names.has(key)) {
        return { ok: false, error: 'Los nombres de los jugadores no pueden repetirse.', config, players: [] };
      }
      const colorIndex = Number(select?.value);
      if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex > 7 || colors.has(colorIndex)) {
        return { ok: false, error: 'Cada jugador debe tener un color distinto.', config, players: [] };
      }
      names.add(key);
      colors.add(colorIndex);
      players.push({
        id: `local-${index + 1}`,
        name: nameResult.value,
        colorIndex,
      });
    }
    if (players.length < 2 || players.length > 8) {
      return { ok: false, error: 'Debe haber entre 2 y 8 jugadores locales.', config, players: [] };
    }
    return { ok: true, error: null, config: { ...config, maxPlayers: players.length }, players };
  }

  setLocalError(message) {
    if (!this.el.localError) return;
    this.el.localError.textContent = message || '';
    this.el.localError.hidden = !message;
  }

  setLocalPending(pending) {
    const controls = this.el.localForm.querySelectorAll('input, select, #local-reset, #local-submit');
    for (const control of controls) control.disabled = Boolean(pending);
    this.el.localSubmit.textContent = pending ? 'Preparando…' : 'Empezar';
  }

  copyRoomCode() {
    const code = typeof this.gameRoomCode === 'string' && this.currentScreen === 'game'
      ? this.gameRoomCode
      : (this.roomSnapshot?.roomCode || this.el.lobbyTitle?.textContent || '');
    const validation = validateRoomCode(code);
    if (!validation.ok) {
      this.toast('No hay un código de sala válido para copiar.', 'warning');
      return;
    }
    const value = validation.value;
    const done = () => this.toast('Código copiado.', 'success');
    const manual = () => this.showCopyFallback(value);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(value).then(done).catch(manual);
    } else {
      manual();
    }
  }

  showCopyFallback(code) {
    const input = create('input', 'field__input');
    input.type = 'text';
    input.readOnly = true;
    input.value = code;
    input.setAttribute('aria-label', 'Código de sala para copiar manualmente');
    const description = create('p', 'field__help', 'No se pudo copiar automáticamente. Selecciona el código y cópialo manualmente.');
    const body = create('div');
    body.append(description, input);
    this.openModal({
      title: 'Copiar código',
      body,
      actions: [{ label: 'Cerrar', variant: 'primary' }],
    });
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  applyPrefs(prefs = app.prefs) {
    app.prefs = {
      patterns: Boolean(prefs.patterns),
      highContrast: Boolean(prefs.highContrast),
    };
    savePrefs(app.prefs);
    document.documentElement.dataset.patterns = app.prefs.patterns ? 'on' : 'off';
    document.documentElement.dataset.contrast = app.prefs.highContrast ? 'on' : 'off';
    this.el.patternsToggle?.setAttribute('aria-pressed', String(app.prefs.patterns));
    this.el.contrastToggle?.setAttribute('aria-pressed', String(app.prefs.highContrast));
    this.el.patternsToggle?.classList.toggle('is-active', app.prefs.patterns);
    this.el.contrastToggle?.classList.toggle('is-active', app.prefs.highContrast);
    this.announce(`Patrones de color ${app.prefs.patterns ? 'activados' : 'desactivados'}. Alto contraste ${app.prefs.highContrast ? 'activado' : 'desactivado'}.`);
  }

  async toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (error) {
      this.toast('El navegador no permite pantalla completa en este momento.', 'warning');
    }
  }

  toast(message, level = 'info', code = '') {
    if (!message) return;
    const safeLevel = ['info', 'success', 'warning', 'error'].includes(level) ? level : 'info';
    const key = `${safeLevel}|${code || message}`;
    const now = Date.now();
    const last = this.toastDedupe.get(key);
    if (last && now - last < 2000) return;
    this.toastDedupe.set(key, now);
    const entry = { message, level: safeLevel, code };
    if (this.visibleToasts.length >= 3) {
      this.toastQueue.push(entry);
      return;
    }
    this.showToast(entry);
  }

  showToast({ message, level }) {
    if (!this.el.toastRegion) return;
    const toastEl = create('div', `toast toast--${level}`);
    toastEl.setAttribute('role', level === 'warning' || level === 'error' ? 'alert' : 'status');
    const iconText = { info: 'i', success: '✓', warning: '!', error: '×' }[level] || 'i';
    const icon = create('span', 'toast__icon', iconText);
    icon.setAttribute('aria-hidden', 'true');
    const text = create('p', 'toast__message', message);
    const close = create('button', 'toast__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Cerrar aviso');
    toastEl.append(icon, text, close);
    this.el.toastRegion.appendChild(toastEl);
    this.visibleToasts.push(toastEl);
    let timer = null;
    let remaining = TOAST_DURATION[level] || 4000;
    let startedAt = Date.now();
    const remove = () => {
      if (timer) clearTimeout(timer);
      toastEl.remove();
      this.visibleToasts = this.visibleToasts.filter((entry) => entry !== toastEl);
      const next = this.toastQueue.shift();
      if (next) this.showToast(next);
    };
    const schedule = () => {
      startedAt = Date.now();
      timer = setTimeout(remove, remaining);
    };
    close.addEventListener('click', remove);
    toastEl.addEventListener('mouseenter', () => {
      if (timer) clearTimeout(timer);
      remaining -= Date.now() - startedAt;
      timer = null;
    });
    toastEl.addEventListener('mouseleave', () => {
      if (!timer) {
        remaining = Math.max(800, remaining);
        schedule();
      }
    });
    toastEl.addEventListener('focusin', () => {
      if (timer) clearTimeout(timer);
      remaining -= Date.now() - startedAt;
      timer = null;
    });
    toastEl.addEventListener('focusout', () => {
      if (!timer) {
        remaining = Math.max(800, remaining);
        schedule();
      }
    });
    schedule();
  }

  openHowTo() {
    const content = this.el.howtoPanel.cloneNode(true);
    content.hidden = false;
    content.removeAttribute('id');
    const body = create('div', 'howto howto--modal');
    body.id = 'howto-modal-description';
    body.append(...content.childNodes);
    this.openModal({
      title: 'Cómo jugar',
      body,
      describedBy: true,
      actions: [{ label: 'Cerrar', variant: 'primary' }],
    });
  }

  openModal({ title, body, actions = [{ label: 'Cerrar', variant: 'primary' }], describedBy = true, onClose = null }) {
    if (this.modal) this.closeModal(false);
    const previousFocus = document.activeElement;
    const modal = create('div', 'modal is-open');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const titleId = `modal-title-${Date.now()}`;
    modal.setAttribute('aria-labelledby', titleId);
    const backdrop = create('div', 'modal__backdrop');
    backdrop.dataset.close = 'true';
    const panel = create('div', 'modal__panel');
    const header = create('header', 'modal__header');
    const heading = create('h2', 'modal__title', title);
    heading.id = titleId;
    const closeButton = create('button', 'icon-button', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Cerrar');
    closeButton.dataset.close = 'true';
    header.append(heading, closeButton);
    const bodyEl = create('div', 'modal__body');
    const bodyNode = body instanceof Node ? body : null;
    if (bodyNode) bodyEl.appendChild(bodyNode);
    else bodyEl.textContent = String(body || '');
    const bodyId = bodyNode?.id || `modal-desc-${Date.now()}`;
    if (bodyNode?.id) bodyNode.removeAttribute('id');
    bodyEl.id = bodyId;
    if (describedBy) modal.setAttribute('aria-describedby', bodyId);
    const footer = create('footer', 'modal__actions');
    const closeModal = (restoreFocus = true) => {
      if (!this.modal) return;
      const current = this.modal;
      this.modal = null;
      current.element.remove();
      this.setBackgroundInert(false);
      document.body.classList.remove('modal-open');
      if (restoreFocus) {
        if (previousFocus && previousFocus.isConnected) previousFocus.focus();
        else document.querySelector('main h1')?.focus();
      }
      onClose?.();
    };
    for (const action of actions) {
      const button = create('button', `button button--${action.variant || 'secondary'}`, action.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        action.onClick?.();
        if (action.close !== false) closeModal();
      });
      footer.appendChild(button);
    }
    panel.append(header, bodyEl, footer);
    modal.append(backdrop, panel);
    this.el.modalRoot.appendChild(modal);
    this.modal = { element: modal, close: closeModal };
    this.setBackgroundInert(true);
    document.body.classList.add('modal-open');
    backdrop.addEventListener('click', () => closeModal());
    closeButton.addEventListener('click', () => closeModal());
    modal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = focusableElements(panel);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    const actionButtons = [...footer.querySelectorAll('button')];
    setTimeout(() => {
      const cancelButton = actionButtons.find((button) => button.textContent.trim().toLocaleLowerCase('es') === 'cancelar');
      const nonDestructive = actionButtons.find((button) => !button.classList.contains('button--danger'));
      const focusTarget = cancelButton
        || nonDestructive
        || focusableElements(panel)[0];
      focusTarget?.focus();
    }, 30);
    return { close: closeModal, element: modal };
  }

  closeModal(restoreFocus = true) {
    this.modal?.close(restoreFocus);
  }

  confirm({ title = 'Confirmar', message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = true }) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const body = create('p', '', message);
      const modal = this.openModal({
        title,
        body,
        onClose: () => finish(false),
        actions: [
          {
            label: cancelLabel,
            variant: 'secondary',
            close: false,
            onClick: () => {
              finish(false);
              modal?.close();
            },
          },
          {
            label: confirmLabel,
            variant: danger ? 'danger' : 'primary',
            close: false,
            onClick: () => {
              finish(true);
              modal?.close();
            },
        },
      ],
      });
    });
  }

  async confirmLeaveGame() {
    const confirmed = await this.confirm({
      title: 'Salir de la partida',
      message: '¿Seguro que quieres salir de la partida? Esta acción no se puede deshacer.',
      confirmLabel: 'Salir de la partida',
      cancelLabel: 'Cancelar',
      danger: true,
    });
    if (confirmed) this.handlers.onLeaveGame?.();
  }

  setBackgroundInert(inert) {
    for (const node of [document.querySelector('.site-header'), document.querySelector('.app-main'), document.querySelector('.site-footer')]) {
      if (node) node.inert = Boolean(inert);
    }
  }

  destroy() {
    this.stopTimer();
    this.closeModal(false);
    this.board?.destroy();
    this.board = null;
  }
}

export const ui = new UI();
