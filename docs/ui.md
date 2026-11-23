# Documento de interfaz de usuario (UI)

**Proyecto:** juego web tipo Quoridor, 2–8 jugadores  
**Ámbito:** capa de presentación, pantallas, componentes, accesibilidad y responsive  
**Stack:** HTML5 + CSS3 + JavaScript ES modules vanilla, sin frameworks  
**Arquitectura:** cliente de un servidor autoritativo Node.js + WebSockets  
**Versión:** 1.0  
**Estado:** contrato implementable

## Contrato con el código (v1)

Resumen normativo para los subagentes de UI y CSS. Si el resto del documento entra en conflicto con esta sección, prevalece el código.

- **Pantallas reales:** `home`, `create`, `join`, `local`, `queue`, `lobby`, `game`, `gameover` (`SCREENS` en `public/js/state.js` y `data-screen` en `public/index.html`).
- **Paleta canónica:** `PLAYER_COLORS` en `state.js` = `#B91C1C`, `#1D4ED8`, `#166534`, `#A16207`, `#6D28D9`, `#C2410C`, `#0F766E`, `#9D174D`; se exponen como `--color-player-0` a `--color-player-7` y se aplican con `colorVar(colorIndex)`.
- **Grid real:** 2n + 1 pistas por eje con canal de pared al inicio y al final; celdas en pistas pares y paredes/anclas en impares (ver §7.4).
- **Alias:** 2–16 code points, solo letras Unicode, números, espacio, `_` y `-`; sin emojis.
- **Capa de presentación:** `public/css/styles.css` y `public/js/main.js` son los dos módulos que la completan y están aún por crear.
- **Ámbito v1:** todo requisito que no exista en `public/index.html` se etiqueta como **Fuera de v1 (opcional)** y no bloquea la implementación; se conserva solo como guía posterior.

Este documento es el contrato de la capa de presentación. No redefine el protocolo ni las reglas:

- Protocolo, mensajes, estados de sala, reconexión y errores: [`docs/network.md`](./network.md).
- Reglas de movimiento, saltos, paredes y camping: [`docs/rules.md`](./rules.md).
- Spawns y metas: [`docs/spawns.md`](./spawns.md).

> **Regla de oro:** la UI no implementa reglas. Renderiza estado, captura intenciones y delega.
> La legalidad de movimientos y paredes se consulta a `src/core` para las ayudas visuales
> (modo local y sugerencias del modo online) y **siempre** la revalida el servidor.

---

## 1. Principios y stack

### 1.1 Stack y límites

- **HTML5 semántico:** `header`, `main`, `aside`, `footer`, `nav`, `section`, `dialog` cuando aplique. Un solo `h1` por pantalla y jerarquía de encabezados sin saltos.
- **CSS3:**
  - Variables CSS para todos los tokens de diseño (§10).
  - CSS Grid para el tablero y para el layout de la partida.
  - Flexbox solo para alineaciones internas simples.
  - Sin preprocesadores ni utilidades externas.
- **JavaScript ES modules vanilla:**
  - Sin React, Vue, Svelte, jQuery ni librerías de UI.
  - Sin paso de build obligatorio.
  - Estado de vista explícito, funciones pequeñas y renderizado incremental.
- **Sin lógica de reglas en la UI:**
  - La UI no calcula adyacencia, saltos, caminos, solapamientos ni `PATH_BLOCKED`.
  - Las ayudas visuales se obtienen llamando a `src/core` con el último snapshot autoritativo.
  - Cualquier acción enviada al servidor es una intención; el servidor decide.
- **Separación estricta de módulos:**

```text
┌──────────────────────────────────────────────────────────────┐
│ UI                                                           │
│  pantallas · componentes · estado de vista · render          │
│  no conoce WebSocket ni reglas                               │
└───────────────┬───────────────────────────┬──────────────────┘
                │ eventos de vista          │ estado/sugerencias
                ▼                           ▼
┌──────────────────────────┐     ┌─────────────────────────────┐
│ net                      │     │ core                        │
│  WebSocket · protocolo   │     │  motor puro de reglas       │
│  hello · reconexión      │     │  local/pass-and-play        │
│  mapea server.* → UI     │     │  hints de legalidad online  │
└───────────────┬──────────┘     └─────────────────────────────┘
                │ JSON
                ▼
        Servidor autoritativo
```

Reglas de dependencia:

- `net` no importa componentes de UI ni manipula el DOM.
- `core` es puro: no usa red, sockets, timers, `localStorage` ni DOM.
- La UI no importa el servidor; solo `net` y `core`.
- El estado autoritativo online es el último `server.gameState` / `server.roomUpdate` recibido.
- El estado local de pass-and-play es el que devuelve `src/core`.
- Los timers y el estado local **nunca** son autoridad.

### 1.2 Estado de vista

Cada pantalla mantiene un estado de vista mínimo y serializable:

| Campo | Valores | Uso |
|---|---|---|
| `screen` | `home`, `create`, `join`, `local`, `queue`, `lobby`, `game`, `gameover` | Pantalla activa. |
| `mode` | `online`, `local` | Origen del estado de partida. |
| `connection` | `online`, `offline`, `reconnecting` | Banner y bloqueo de acciones. |
| `room` | snapshot público o `null` | Lobby/sala. |
| `game` | snapshot público o estado local | Partida. |
| `pending` | `null` o `{ action, requestId, since }` | Evita duplicados. |
| `overlay` | `none`, `handoff`, `reconnecting`, `spectator`, `waiting` | Capa modal/estado. |
| `prefs` | alias, patrones, alto contraste, sonido | Persistencia local segura. |

No se persisten snapshots de partida en `localStorage`. Solo alias, identidad de sesión, preferencias y, como máximo, el código de sala para reconexión.

### 1.3 Accesibilidad

Obligatorio en todas las pantallas:

- **Foco visible:** anillo de 2 px (`--color-focus`) con `outline-offset: 2px`. Nunca `outline: none` sin sustituto.
- **Navegación completa por teclado:**
  - Tab/Shift+Tab entre regiones y controles.
  - Tablero con `tabindex` móvil (roving tabindex): flechas para celdas, `Home`/`End` para extremos de fila, `Enter`/`Espacio` para actuar.
  - Paredes: anclas legales con foco, flechas para desplazarse, `R` para rotar (teclado), `Enter` para colocar, `Escape` para ocultar el preview.
- **Etiquetas ARIA en español** y nombres accesibles que incluyan coordenada, ocupante y estado.
- **Color no es el único indicador:** inicial en la ficha, patrón de fantasma, textos “Tú”, “Host”, “Turno”, “Desconectado”, iconos con texto.
- **Contraste:** texto normal ≥ 4.5:1; texto grande ≥ 3:1; componentes y bordes de foco ≥ 3:1.
- **Movimiento reducido:** respetar `prefers-reduced-motion: reduce`; desactivar pulsos, confeti, desplazamientos y animaciones de pared.
- **Zoom:** soportar zoom de navegador al 200 % sin pérdida de contenido ni scroll horizontal involuntario.
- **Regiones vivas:** `aria-live="polite"` para turno, toasts informativos y timer; `assertive` solo para errores críticos. No anunciar cada segundo.
- **Formularios:** `label` asociado, `aria-invalid`, `aria-describedby` para el error, mensaje inline y foco al primer campo inválido al enviar.
- **Modales:** foco atrapado, `aria-modal="true"`, cierre con `Escape`, clic fuera, retorno de foco al disparador y fondo `inert`.
- **Objetivos táctiles:** mínimo 44 × 44 px en móvil; en escritorio, mínimo 32 × 32 px.
- **Idioma:** `<html lang="es">`; textos de interfaz en español, nombres de usuario sin traducir.

### 1.4 Responsive

- Desktop ancho (≥ 1200 px): tablero centrado + panel lateral fijo.
- Tablet (768–1199 px): panel lateral más estrecho y colapsable.
- Móvil (< 768 px): una columna; panel lateral como cajón; footer compacto; tablero a ancho completo.
- El panel lateral tiene scroll interno propio; el tablero no debe provocar scroll vertical en 1366 × 768.
- Tamaño mínimo de celda: 14 px en desktop/tablet y 12 px en móvil. Si el viewport es menor que el mínimo, permitir scroll del contenedor del tablero, nunca recortarlo.
- No bloquear el zoom: usar `width=device-width, initial-scale=1`, sin `maximum-scale=1` ni `user-scalable=no`.
- Evitar zoom accidental: inputs a 16 px en móvil, `touch-action: manipulation` y objetivos táctiles separados.

---

## 2. Flujo de pantallas y máquina de estados

### 2.1 Pantallas

| Pantalla | Propósito | Entrada principal | Salida principal |
|---|---|---|---|
| `home` | Identidad y elección de modo. | Carga inicial, “Salir al inicio”. | Crear, unirse, casual, local. |
| `create` | Formulario previo de creación de sala. | Botón “Crear partida”. | `lobby` host al recibir `server.roomCreated`; `home` al cancelar. |
| `join` | Introducir código y unirse. | Botón “Unirse a partida”. Deep-link `?room=CODE`: **Fuera de v1**. | `lobby` al recibir `server.roomJoined`; `home`. |
| `local` | Configuración de pass-and-play. | Botón “Jugar en un mismo dispositivo”. | `game` local al empezar; `home`. |
| `queue` | Cola de matchmaking casual. | Botón “Partida casual”. | `game` al recibir `server.matchFound` + `server.gameStarted`; `home` al cancelar. |
| `lobby` | Sala de espera host o invitado. | `roomCreated`, `roomJoined`, `rematchLobby`. | `game` al `server.gameStarted`; `home` al salir. |
| `game` | Partida online o local. | `gameStarted` o inicio local. | `gameover`; reconexión; `lobby` tras revancha. |
| `gameover` | Resultado y revancha. | `server.gameOver` o fin local. | `lobby` al `server.rematchLobby`; `home` al salir. |

`create` es el formulario previo. Al crear la sala se entra en `lobby` con rol de host, que reutiliza los mismos controles de configuración en modo “en vivo”. El código de sala, la lista de jugadores y el botón “Empezar partida” existen solo en `lobby`.

### 2.2 Diagrama ASCII de navegación

```text
                         ┌──────────────────────────────┐
                         │            home              │
                         │ alias + 4 acciones           │
                         └───┬───────┬───────┬───────┬──┘
                    casual   │ crear │ unir  │ local │
                             ▼       ▼       ▼       ▼
                     ┌────────────┐ ┌──────────┐ ┌──────────┐
                     │   queue    │ │  create  │ │   join   │
                     └─────┬──────┘ └────┬─────┘ └────┬─────┘
                          │             │ roomCreated│ roomJoined
                          │             ▼            ▼
                          │        ┌─────────────────────┐
                          │        │        lobby        │
                          │        │ host / invitado     │
                          │        └──────┬──────┬───────┘
                          │               │      │ leaveRoom
                          │               │      └──────────────► home
                          │               │ gameStarted
                          │               ▼
                          │        ┌─────────────────────┐
                          └───────►│        game         │
                     matchFound    │ online / local      │
                                   └──────┬──────────────┘
                                           │ server.gameOver
                                           ▼
                                    ┌─────────────────────┐
                                    │      gameover       │
                                   └──────┬──────┬───────┘
                                          │      │ leaveRoom
                                          │      └──────────────► home
                                          │ rematchLobby
                                          ▼
                                   ┌─────────────────────┐
                                   │        lobby        │
                                   └─────────────────────┘

Reconexión (en cualquier pantalla de sala):
  socket cerrado → overlay reconnecting → client.hello
  → server.welcome(resumed:true) → lobby | game | gameover
  → server.welcome(resumed:false) → home + toast informativo
```

### 2.3 Transiciones permitidas y prohibidas

| Desde | Hacia | Disparador | ¿Permitida? |
|---|---|---|---|
| `home` | `create` | Clic en “Crear partida” con alias válido. | Sí. |
| `home` | `join` | Clic en “Unirse a partida”. `?room=CODE`: **Fuera de v1**. | Sí. |
| `home` | `local` | Clic en “Jugar en un mismo dispositivo”. | Sí. |
| `home` | `queue` | Clic en “Partida casual”. | Sí. |
| `create` | `lobby` | `server.roomCreated`. | Sí. |
| `create` | `home` | Cancelar o error de creación. | Sí. |
| `join` | `lobby` | `server.roomJoined`. | Sí. |
| `join` | `home` | Volver. | Sí. |
| `local` | `game` | Inicio local con `src/core`. | Sí. |
| `local` | `home` | Volver. | Sí. |
| `queue` | `game` | `server.matchFound` + `server.gameStarted`. | Sí. |
| `queue` | `home` | Cancelar cola o error. | Sí. |
| `lobby` | `game` | `server.gameStarted`. | Sí. |
| `lobby` | `home` | `server.leftRoom` o sala vacía/borrada. | Sí. |
| `game` | `gameover` | `server.gameOver` o fin local. | Sí. |
| `game` | `lobby` | `server.rematchLobby` tras `gameover`. | Solo a través de `gameover`. |
| `gameover` | `lobby` | `server.rematchLobby`. | Sí. |
| `gameover` | `home` | `server.leftRoom` o salida local. | Sí. |
| Cualquier pantalla de sala | `home` | `ROOM_EXPIRED`, `SESSION_INVALID` con recuperación segura. | Solo por recuperación. |
| `home` | `lobby` | — | No. |
| `home` | `game` | — | No. |
| `create` | `game` | — | No; falta `roomCreated` y `gameStarted`. |
| `join` | `game` | — | No; falta `roomJoined` y `gameStarted`. |
| `lobby` | `home` | Botón atrás sin `client.leaveRoom`. | No; primero hay que salir. |
| `game` | `home` | Botón atrás o cierre de pestaña. | No; primero confirmar y usar `client.leaveGame`; seguirá como fantasma. |
| `gameover` | `game` | — | No; solo revancha vía `lobby`. |
| `local` | `lobby` | — | No. |
| `queue` | `lobby` | — | No; el matchmaking crea sala y va directo a `game`. |

### 2.4 Historial, botón atrás, recarga, deep-link y reconexión

- **Historial (Fuera de v1):** usar `history.pushState` por pantalla lógica. No guardar snapshots ni `sessionToken` en la URL.
- **Botón atrás:**
  - En `home`, `create`, `join`, `local`, `queue`: comportamiento normal (v1).
  - En `lobby`: **Fuera de v1**; interceptar `popstate`, abrir confirmación “¿Salir de la sala?” y, si se confirma, enviar `client.leaveRoom`.
  - En `game`/`local`-handoff: **Fuera de v1**; interceptar, abrir confirmación “¿Abandonar la partida?”; en online enviar `client.leaveGame` (el jugador pasa a fantasma) y quedarse en modo espectador; en local volver a `local`.
  - En `gameover`: **Fuera de v1**; permitir volver a `lobby` solo con `client.rematch`; “Salir al inicio” usa `client.leaveRoom`.
- **Recarga:**
  1. Leer alias, `playerId`, `sessionToken` y preferencias persistidas.
  2. Si existen identidad y token, abrir WebSocket y enviar `client.hello`.
  3. `server.welcome` con `resumed:true` determina la pantalla: `playing`/`finished` → `game`/`gameover`; `lobby` → `lobby`.
  4. Si `resumed:false`, ir a `home` con toast informativo; no recrear salas automáticamente.
  5. **Fuera de v1:** si la URL contiene `?room=CODE`, precargar `join` solo cuando no haya sesión reanudable.
- **Deep-link `?room=CODE` (Fuera de v1, opcional):** este flujo, incluido el manejo de `popstate`, no forma parte de v1 y no debe bloquear la implementación.
  - Normalizar el código con el mismo algoritmo que el formulario (§5.1).
  - Si el alias ya es válido, precargar el campo y permitir “Unirse”; no enviar `client.joinRoom` automáticamente más de una vez.
  - Si no hay alias válido, mostrar `home` con el código guardado en memoria y un aviso “Introduce tu alias para unirte a la sala CODE”.
  - Un código inválido muestra error inline; no se conserva en la URL.
  - La URL nunca es autoridad: la sala y la partida las decide el servidor.
- **Reconexión:** ver §12.7. El overlay de reconexión no destruye la pantalla; al volver `server.welcome` + snapshot se rehidrata el estado y se restaura el foco donde estaba.
- **Recuperación de join ambiguo:** si un `client.joinRoom` queda sin respuesta por timeout, no reenviarlo a ciegas (podría devolver `ALREADY_IN_ROOM`). Reconectar, enviar `client.hello` y usar el `welcome`/snapshot para saber si ya se entró; si no, ofrecer reintento manual.

---

## 3. Pantalla Home

### 3.1 Layout

Dos columnas en desktop:

- **Izquierda (60–65 %):** logo, título, descripción breve, campo de alias, mensaje de validación y 4 botones de acción.
- **Derecha (35–40 %):** desplegable/modal “Cómo jugar”, con resumen de reglas y estados.
- En tablet y móvil se apila: intro, alias, acciones y “Cómo jugar” debajo.

```html
<main class="home">
  <section class="home__intro" aria-labelledby="home-title">
    <img class="home__logo" src="/assets/logo.svg" alt="" width="48" height="48">
    <h1 id="home-title" class="home__title">Quoridor</h1>
    <p class="home__lead">Bloquea, salta y alcanza tu meta antes que nadie.</p>

    <form class="join-form" novalidate>
      <label class="field__label" for="alias">Tu alias</label>
      <input
        id="alias"
        class="field__input"
        name="alias"
        type="text"
        inputmode="text"
        autocomplete="nickname"
        maxlength="16"
        aria-describedby="alias-help alias-error"
        required>
      <p id="alias-help" class="field__help">2–16 caracteres. Letras, números, espacio, guion y guion bajo.</p>
      <p id="alias-error" class="field__error" role="alert" hidden></p>
    </form>

    <div class="home__actions" aria-label="Acciones principales">
      <button class="button button--primary" data-home-action="casual" disabled>Partida casual</button>
      <button class="button button--secondary" data-home-action="create" disabled>Crear partida</button>
      <button class="button button--secondary" data-home-action="join" disabled>Unirse a partida</button>
      <button class="button button--ghost" data-home-action="local" disabled>Jugar en un mismo dispositivo</button>
    </div>
  </section>

  <aside class="home__howto" aria-labelledby="howto-title">
    <button class="disclosure" aria-expanded="false" aria-controls="howto-panel">
      Cómo jugar
    </button>
    <section id="howto-panel" class="howto" hidden>...</section>
  </aside>
</main>
```

El bloque es ilustrativo: en `public/index.html` los botones llevan `type="button"`, el formulario es `#alias-form` y el panel es un `div#howto-panel`. El logo SVG y los iconos SVG del ejemplo son **Fuera de v1**.

### 3.2 Alias obligatorio

Validación en cliente. Fuente canónica: `LIMITS.alias` y `validateAlias()` en `public/js/state.js`.

1. Normalizar a NFC, colapsar espacios y aplicar `trim()`.
2. Longitud entre **2 y 16 code points** (no unidades UTF-16).
3. Caracteres permitidos:
   - Letras Unicode (`\p{L}`), incluidos acentos y alfabetos no latinos.
   - Números Unicode (`\p{N}`).
   - Espacio simple, `_` y `-`.
   - El primer y el último carácter deben ser letra o número.
   - Prohibidos caracteres de control, tabuladores, saltos de línea, `<`, `>` y secuencias que parezcan HTML.
   - **Sin emojis:** los emojis no son `\p{L}` ni `\p{N}` y la regex con bandera `u` los rechaza.
4. Regex canónica, idéntica a la de `state.js` (validar además longitud por code points):

```text
/^[\p{L}\p{N}](?:[\p{L}\p{N} _-]{0,14}[\p{L}\p{N}])?$/u
```

5. No permitir alias formado solo por espacios ni duplicar espacios internos consecutivos; colapsarlos a uno al normalizar.
6. Comparación de duplicados en sala: el servidor aplica sufijos; la UI muestra el nombre efectivo recibido.

Notas de compatibilidad:

- El límite de la UI es **2–16 code points sin emojis**, el mismo que aplica `state.js`. `docs/network.md` describe límites de servidor más amplios; la UI nunca envía un alias fuera de este rango.
- El alias se envía en `client.hello` o en `client.createRoom` / `client.joinRoom`.
- No se puede cambiar durante la partida; en lobby hay que salir y volver a entrar.
- Persistencia: guardar el alias válido en `localStorage` con clave `quoridor.alias`, con debounce de 250 ms. Si el valor guardado no es válido, eliminarlo.
- Seguridad: renderizar siempre con `textContent`; nunca `innerHTML`.

Comportamiento:

- Validar al salir del campo (`blur`) y, tras el primer error, en cada `input`.
- Mientras el alias sea inválido: los 4 botones permanecen deshabilitados, con el motivo visible en `#alias-error` y en un texto auxiliar.
- Error inline:
  - Vacío: “Escribe un alias para continuar.”
  - Longitud: “El alias debe tener entre 2 y 16 caracteres.”
  - Caracteres: “Usa letras, números, espacios, guion o guion bajo.”
  - Formato: “El alias debe empezar y terminar con letra o número.”
- `aria-invalid="true"` en el input y foco devuelto al campo cuando se intenta enviar con Enter.
- El alias local es también el nombre inicial del jugador 1 en pass-and-play y puede editarse allí.

### 3.3 Cuatro acciones

| Botón | Texto | Jerarquía visual | Icono | Estado |
|---|---|---|---|---|
| Casual | “Partida casual” | Primario relleno (`--color-accent`). | Glifo `⚡` en `.button__icon`; SVG 20 px: **Fuera de v1**. | Habilitado solo con alias válido. |
| Crear | “Crear partida” | Secundario con borde de acento. | Glifo `＋` en `.button__icon`; SVG 20 px: **Fuera de v1**. | Habilitado solo con alias válido. |
| Unirse | “Unirse a partida” | Secundario neutro. | Glifo `→` en `.button__icon`. | Habilitado solo con alias válido. |
| Local | “Jugar en un mismo dispositivo” | Terciario/texto. | Glifo `◍` en `.button__icon`. | Habilitado solo con alias válido. |

- Todos: altura mínima 44 px, ancho completo de la columna, texto alineado a la izquierda con icono a la izquierda, `:hover`, `:focus-visible`, `:active`.
- Deshabilitados: `disabled`, opacidad 0.55, cursor `not-allowed`, sin sombra; el motivo se explica una sola vez bajo el campo.
- Al pulsar Enter en el alias válido, el foco pasa al primer botón habilitado; no se envía ninguna acción automáticamente.
- No usar emojis como iconos funcionales. Los glifos presentes en el HTML se consideran decorativos y `aria-hidden`; sustituirlos por SVG queda **Fuera de v1**.

### 3.4 “Cómo jugar”

El HTML implementa el desplegable accesible con `#howto-toggle` y `#howto-panel`. La variante modal (`<dialog>` o contenedor con `role="dialog"`) y el panel lateral de desktop son **Fuera de v1 (opcional)**.

Contenido mínimo:

| Bloque | Resumen |
|---|---|
| Objetivo | Alcanzar tu celda meta asignada en el lado correspondiente antes que los demás. |
| Turno | En cada turno se elige **una** acción: mover la ficha o colocar una pared. |
| Movimiento | Movimiento ortogonal a una celda adyacente libre. |
| Saltos | Si hay una ficha adyacente, se puede saltar si la celda de detrás está libre; las reglas completas están en `docs/rules.md`. |
| Paredes | Bloquean el paso; no pueden dejar a un jugador activo sin camino a su meta. Se alternan H/V. |
| Camping | No se permite pasar el turno quedándose en la misma celda; el servidor rechaza `CAMPING_MUST_MOVE`. |
| Temporizador | 30 s por turno; al expirar, el servidor mueve automáticamente si es posible. |
| Desconexiones | El jugador pasa a fantasma: su ficha no bloquea, sus paredes permanecen, sus turnos se omiten y puede reconectar. |
| Revancha | Al terminar, la sala puede volver al lobby para una nueva partida. |

Comportamiento del modal:

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` y `aria-describedby`.
- Foco inicial en el título o en el botón de cierre; foco atrapado dentro.
- Cerrar con `Escape`, con clic en el fondo y con el botón “Cerrar”.
- Guardar el elemento que abrió el modal y devolverle el foco.
- Fondo `inert` mientras está abierto; bloquear scroll del `body`.
- En modo desplegable (`aria-expanded`), el contenido no atrapa foco; se cierra con `Escape` y se anuncia el cambio.

---

## 4. Pantalla Crear partida y lobby host

### 4.1 Formulario y valores por defecto

Valores iniciales de la pantalla `create`:

| Campo | Default UI | Rango / valores | Control | Validación |
|---|---:|---|---|---|
| `size` | **9** | 8–20, entero | `<select>` o stepper | Entero, dentro de rango. |
| `maxPlayers` | **2** | 2–8, entero | Stepper `− / +` | No puede ser menor que los jugadores actuales en lobby. |
| `wallsPerPlayer` | **10** | 0–20, entero | `<input type="range">` + número | Entero, dentro de rango. |
| `spawnMode` | **`random`** | `random`, `central`, `perimeter` | `<select>` | Valor exacto. |
| `turnSeconds` | 30 | fijo | Solo lectura | No editable. |
| Nombre de sala | vacío | 0–24 caracteres | `<input type="text">` | **Fuera de v1**: no está en el HTML ni en el protocolo; solo etiqueta local. |

> **Compatibilidad con el servidor:** el default de `client.createRoom` en `docs/network.md` es `size:12`, `maxPlayers:4`, `wallsPerPlayer:10`, `spawnMode:"random"`. Este contrato de UI exige que el formulario inicial muestre 9 / 2 / 10 / random y que el cliente envíe explícitamente esos valores al crear la sala. `client.resetConfig` restablece en el servidor 12 / 4 / 10 / random (o el número actual de jugadores si hay más de 4). La UI debe reflejar el `server.roomUpdate` efectivo, no inventar valores locales.

> **Nombre de sala (Fuera de v1):** el protocolo no transporta un nombre y `public/index.html` no incluye el campo. Se conserva como idea de UX, no se implementa en v1; el identificador es el código de 6 caracteres.

Validación:

- Todos los campos se validan de forma atómica; si uno falla, no se envía configuración parcial.
- Los valores se envían como enteros/strings exactos, nunca como números en texto.
- La configuración de una sala existente solo se puede editar en `lobby` y solo por el host; el formulario previo de `create` es estado local.
- Mientras la sala está `playing`/`finished`, los controles se muestran deshabilitados con el texto “La configuración está bloqueada durante la partida”.
- El resumen visible bajo el formulario se actualiza al cambiar: “Tablero 9 × 9 · 2 jugadores · 10 paredes · Spawn aleatorio”.

Aplicación de cambios:

- `create` (antes de crear): los cambios son estado local; no se envían.
- `lobby` host: selectores y stepper envían `client.updateConfig` inmediatamente; el rango de paredes se envía con debounce de 200 ms al soltar/terminar.
- Mientras hay una actualización pendiente, mostrar “Guardando…” y no enviar otra hasta recibir `server.roomUpdate` o `server.error`.
- Si el servidor rechaza (`INVALID_CONFIG`, `NOT_HOST`, `GAME_STARTED`), revertir al último snapshot y mostrar el error inline.

### 4.2 Restablecer

- Botón “Restablecer” visible solo para el host y solo en `lobby`.
- En `create` (antes de crear), restablece localmente a 9 / 2 / 10 / random.
- En `lobby` host, emite `client.resetConfig`.
- La UI aplica el `server.roomUpdate` resultante. En v1 el servidor fija 12 / 4 / 10 / random (o el número actual de jugadores si hay más de 4).
- Confirmar visualmente con un toast de éxito “Configuración restablecida”.
- No salir de la sala, no perder jugadores, no reiniciar la partida.

### 4.3 Código de sala y copiar

- Código exacto de **6 caracteres** del alfabeto `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (sin `I`, `O`, `0`, `1`, `L`).
- Mostrar en mayúsculas, con espaciado de letras y fuente monoespaciada/tabular.
- `aria-label`: “Código de sala AB12CD”.
- Botón “Copiar código” adyacente:
  - Usar Clipboard API; si falla, seleccionar el texto en un input de solo lectura como fallback.
  - Feedback visible y accesible “Copiado” durante 2 s en una región `aria-live="polite"`.
  - Error: “No se pudo copiar. Selecciona el código y cópialo manualmente.”
  - No copiar nada más que el código.
- Al entrar en `lobby` invitado, el código también es visible y copiable.

### 4.4 Lista de jugadores en tiempo real

```html
<section class="players" aria-labelledby="players-title">
  <h2 id="players-title" class="players__title">Jugadores <span class="badge">3/4</span></h2>
  <ul class="players__list">
    <li class="player-row player-row--host player-row--self" style="--player-color: var(--color-player-0)">
      <span class="avatar" aria-hidden="true">A</span>
      <span class="player-row__name">Ana</span>
      <span class="badge badge--host">Host</span>
      <span class="badge badge--self">Tú</span>
      <span class="player-row__state" aria-label="Conectado">●</span>
    </li>
    <li class="player-row player-row--ghost" style="--player-color: var(--color-player-1)">
      <span class="avatar" aria-hidden="true">L</span>
      <span class="player-row__name">Luis</span>
      <span class="badge badge--ghost">Fantasma</span>
      <span class="player-row__state">Desconectado</span>
    </li>
  </ul>
</section>
```

- Orden fijo: `colorIndex` ascendente (0..7). Los fantasmas permanecen en su posición, atenuados y con patrón.
- Cada fila muestra avatar con inicial, nombre, color de jugador, badges “Host”, “Tú”, “Conectado”/“Fantasma”/“Desconectado”.
- El color se aplica desde un mapa `colorIndex → token`; nunca como cadena libre del servidor.
- `server.roomUpdate` y `server.roomJoined` actualizan la lista completa; no reconstruir filas idénticas.
- Al salir el host, `server.hostChanged` mueve el badge “Host” al nuevo host y `server.roomUpdate` confirma.
- Entrada/salida de jugadores: anuncio `aria-live="polite"` breve, por ejemplo “Luis se ha unido” o “Luis ha salido”.
- Si el jugador local es host, se muestra el panel de configuración editable; si no, solo lectura.

### 4.5 Empezar partida

- Botón “Empezar partida” visible solo para el host.
- **Bloqueado obligatoriamente** si hay menos de 2 jugadores conectados y no fantasmas (`connected && !ghost`).
- Motivo visible junto al botón: “Necesitas al menos 2 jugadores conectados para empezar.”
- También se bloquea si:
  - La configuración está pendiente de guardar.
  - Hay una petición `client.startGame` en curso.
  - La conexión está caída o reconectando.
  - La sala no está en `lobby`.
- Al pulsar: deshabilitar, mostrar spinner y texto “Empezando…”, enviar `client.startGame`.
- Errores visibles:
  - `NOT_ENOUGH_PLAYERS`: “Faltan jugadores conectados.”
  - `INVALID_CONFIG`: “La configuración no es válida; revísala.”
  - `NOT_HOST`: “Solo el host puede empezar la partida.”
  - `WRONG_STATE` / `GAME_STARTED`: “La sala ya no está en lobby.”
- Si llega `server.gameStarted`, navegar a `game` inmediatamente y anunciar “Empieza la partida”.
- Si el host sale en lobby:
  - La UI envía `client.leaveRoom` y espera `server.hostChanged`/`server.roomUpdate`.
  - El nuevo host es el jugador conectado con menor `colorIndex`; recibe los controles.
  - Mostrar toast “Ahora eres el host” al nuevo host y “El host ha salido” al resto.
  - Si no queda nadie, la sala se borra y todos vuelven a `home`.
- El invitado ve la misma lista y configuración en solo lectura, con el estado “Esperando al host…”.

### 4.6 Estados de carga y error

- `create` pendiente: formulario deshabilitado y texto “Creando sala…”; skeleton del código: **Fuera de v1**.
- Error de creación: mensaje inline, botón “Reintentar” y “Volver” a `home`.
- `lobby` pendiente de actualización: controles deshabilitados con “Guardando…”.
- Error de red: banner global (no modal) y reintento; no perder la configuración escrita.
- Nunca mostrar datos de una sala anterior si `server.roomCreated`/`roomJoined` no ha llegado.

---

## 5. Pantalla Unirse a partida

### 5.1 Entrada y normalización del código

```html
<form class="code-form" novalidate>
  <label class="field__label" for="room-code">Código de sala</label>
  <div class="code-form__row">
    <input
      id="room-code"
      class="field__input field__input--code"
      type="text"
      inputmode="text"
      autocomplete="off"
      autocapitalize="characters"
      spellcheck="false"
      maxlength="12"
      aria-describedby="room-code-help room-code-error"
      placeholder="AB12CD">
    <button type="button" class="button button--secondary" data-home-action="paste">Pegar</button>
  </div>
  <p id="room-code-help" class="field__help">6 caracteres. No se usan 0, O, 1, I ni L.</p>
  <p id="room-code-error" class="field__error" role="alert" hidden></p>
  <button type="submit" class="button button--primary">Unirse</button>
</form>
```

Normalización:

1. Convertir a mayúsculas.
2. Eliminar espacios, tabuladores y guiones de separación.
3. Recortar a 6 caracteres visibles; si el resultado no mide 6 o no cumple la regex canónica, mostrar `INVALID_CODE` antes de enviar.
4. Regex canónica: `^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$`.
5. Mostrar el código normalizado en el input mientras se escribe o al pegar.
6. Botón “Pegar”: leer el portapapeles, normalizar y colocar el resultado; si se deniega el permiso, enfocar el input y mostrar “Pega el código manualmente”.

### 5.2 Errores de unión

| Código recibido | Mensaje UI | Acción |
|---|---|---|
| `INVALID_CODE` | “El código debe tener 6 caracteres válidos.” | Quedarse en `join`, foco en el input. |
| `ROOM_NOT_FOUND` | “No existe ninguna sala con ese código.” | Limpiar selección; permitir corregir. |
| `ROOM_FULL` | “La sala está completa.” | Quedarse; ofrecer otro código. |
| `GAME_STARTED` (UI: `GAME_ALREADY_STARTED`) | “La partida ya ha empezado.” | No ofrecer reintento; volver o probar otro código. |
| `ROOM_EXPIRED` | “La sala ha caducado.” | Volver a `home`. |
| `ALREADY_IN_ROOM` | “Ya estás en una sala.” | Reconectar y rehidratar; no reintentar join. |
| `SESSION_INVALID` | “Tu sesión no es válida. Vuelve a empezar.” | Limpiar sesión de sala y volver a `home`. |
| Timeout de red | “No se pudo comprobar la sala. Reintentar.” | Botón manual; no bucle automático. |

> El protocolo usa `GAME_STARTED`; la UI puede mapearlo internamente al estado de error `GAME_ALREADY_STARTED` para el mensaje. No enviar mensajes nuevos al servidor para traducir errores.

### 5.3 Sala de espera (invitado)

- Al recibir `server.roomJoined`, pasar a `lobby` en modo invitado.
- Mostrar:
  - Código de sala copiable.
  - Lista de jugadores en tiempo real.
  - Configuración en solo lectura.
  - Estado “Esperando a que el host empiece la partida…”.
  - Botón “Salir de la sala” (`client.leaveRoom`) con confirmación.
- Si entra un nuevo jugador, actualizar lista y anunciar.
- Si el host cambia, actualizar badge y, si el jugador local pasa a ser host, habilitar controles.
- Si el host empieza, `server.gameStarted` navega a `game`.
- Si el host sale y no queda host, la UI se apoya en `server.roomUpdate`/`hostChanged`; si la sala se borra, volver a `home` con toast.

### 5.4 Reintento y timeout

- Un único `client.joinRoom` en vuelo; botón deshabilitado y texto “Uniéndose…”.
- Timeout de UI: 10 s. Al expirar:
  - No reenviar automáticamente (evita duplicados y `ALREADY_IN_ROOM`).
  - Mostrar “No se pudo comprobar la sala” con botón “Reintentar”.
  - Reintentar solo tras acción explícita; si hay duda, reconectar y usar `client.hello`.
- Backoff de reconexión general en §12.7.
- No mostrar el código ni el alias en logs de consola.

---

## 6. Pantalla Jugar en un mismo dispositivo (local pass-and-play)

### 6.1 Configuración

- Sin red: no se abre WebSocket ni se envían mensajes `client.*`.
- Valores iniciales: tamaño 9, jugadores 2, paredes 10, spawn `random`.
- Botón “Restablecer” vuelve a esos valores en local, sin llamar a `client.resetConfig`.
- Selector **exacto** de número de jugadores locales: 2–8. No es un máximo; se crean exactamente esos jugadores.
- Tamaño 8–20; paredes 0–20; spawn `random` / `central` / `perimeter`.
- Nombres automáticos editables: “Jugador 1”, “Jugador 2”, …; máximo 16 caracteres; sin duplicados normalizados.
- Colores automáticos por `colorIndex` 0..n-1; editables mediante una lista de 8 colores, sin repetir color entre jugadores.
- Avatar con inicial y color. Si se cambia el nombre, actualizar la inicial.
- Resumen “Tablero 9 × 9 · 2 jugadores · 10 paredes · Spawn aleatorio”.
- El botón “Empezar” valida nombres, colores y configuración; luego llama a `src/core` para crear la partida local.

### 6.2 Flujo pass-and-play

Estados internos:

1. `setup`: configuración y jugadores.
2. `handoff`: pantalla de privacidad “Turno de `<nombre>`”.
3. `playing`: tablero visible y acciones del jugador del turno.
4. `gameover`: resultado local.

Reglas de privacidad:

- Al iniciar la partida y **cada vez que cambia el turno**, mostrar una pantalla opaca a pantalla completa:
  - Título “Turno de `<nombre>`”.
  - Color/avatar del jugador.
  - Texto “Pasa el dispositivo a este jugador”.
  - Botón “Continuar” (primario).
  - Botón “Abandonar” (texto/terciario) con confirmación.
- Mientras `handoff` está activo:
  - El tablero queda `inert`, `aria-hidden="true"` y visualmente cubierto; no se puede espiar con scroll ni teclado.
  - No se anuncian movimientos, paredes ni el estado del tablero a lectores de pantalla.
  - El temporizador local, si está activado, se pausa.
- “Continuar”:
  - Oculta la capa, quita `inert`, mueve el foco al tablero y anuncia “Turno de `<nombre>`. Elige movimiento o pared.”
  - No envía ninguna acción; solo revela el estado.
- No mostrar automáticamente el tablero al terminar una acción: primero `handoff` del siguiente jugador.
- Abandonar: confirmación “¿Abandonar la partida local? Se perderá el progreso.”; volver a `setup`.

### 6.3 Uso del motor local y renderizador

- La UI importa `src/core`, crea la partida local y aplica las acciones exclusivamente a través del motor.
- No duplicar reglas en la UI: para movimientos y paredes legales se usan las funciones del core.
- La UI mantiene un snapshot local equivalente al público; el renderizador es el **mismo** componente que en online.
- No hay `server.tick`, `server.gameState` ni reconexión.
- Temporizador local opcional:
  - Desactivado por defecto para evitar penalizar el paso del dispositivo.
  - Si se activa, es informativo y se pausa en `handoff`; no expulsa ni mueve automáticamente.
- Al terminar, `gameover` local con ganador, motivo “meta” y resumen; “Revancha” reinicia la misma configuración y “Salir” vuelve a `setup`.
- Los toasts locales usan el mismo componente, sin `aria-live` agresivo.
- La pantalla debe ser operable solo con teclado y con lector de pantalla.

---

## 7. Pantalla de partida

### 7.1 Layout general

CSS Grid de tres filas y dos columnas:

- `header`: sala, código, estado, conexión.
- `main`: tablero centrado.
- `aside`: panel lateral derecho.
- `footer`: panel propio ampliado.
- `toasts`: capa dentro del grid, superpuesta, sin ocupar una fila real.

```css
.game-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--panel-width);
  grid-template-rows: var(--header-height) minmax(0, 1fr) var(--footer-height);
  grid-template-areas:
    "header header"
    "main   aside"
    "footer footer";
  gap: var(--space-2);
  height: 100dvh;
  padding: var(--space-2);
  overflow: hidden;
  background: var(--color-bg);
}

.game-header { grid-area: header; }
.game-main   { grid-area: main; min-width: 0; min-height: 0; display: grid; place-items: center; overflow: auto; }
.game-aside  { grid-area: aside; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.game-footer { grid-area: footer; }
.game-toasts {
  grid-area: 1 / 1 / -1 / -1;
  align-self: start;
  justify-self: end;
  pointer-events: none;
  z-index: var(--z-toast);
  padding: var(--space-3);
}
```

```html
<div class="game-layout">
  <header class="game-header" aria-label="Información de la partida">
    <div class="game-header__room">
      <span class="game-header__label">Sala</span>
      <strong class="room-code" aria-label="Código de sala AB12CD">AB12CD</strong>
      <button class="icon-button" data-home-action="copy-code" aria-label="Copiar código">...</button>
    </div>
    <div class="game-header__status" aria-live="polite">
      <span class="connection-dot connection-dot--online" aria-hidden="true"></span>
      <span>En curso · Turno 7</span>
    </div>
  </header>

  <main class="game-main" aria-label="Tablero de juego">
    <div class="board-frame">
      <div class="board" role="group" aria-label="Tablero de 9 por 9" data-size="9">...</div>
    </div>
  </main>

  <aside class="game-aside" aria-labelledby="players-panel-title">...</aside>
  <footer class="game-footer" aria-label="Tu jugador">...</footer>
  <div class="game-toasts" aria-live="polite" aria-atomic="false"></div>
</div>
```

- En desktop, el tablero debe caber sin scroll vertical en 1366 × 768; el `aside` puede tener scroll interno.
- El `main` puede tener scroll si el viewport es más pequeño que el mínimo de celda; nunca recortar el tablero.
- El header no debe crecer por nombres largos; truncar con elipsis y `title`/tooltip accesible.
- El estado de conexión se muestra con icono + texto (no solo color): “En línea”, “Reconectando…”, “Sin conexión”.

### 7.2 Panel lateral

Contenido, en orden:

1. Título “Jugadores” con contador `n/max`.
2. Lista de tarjetas de jugador ordenadas por `colorIndex`.
3. Estado del turno y temporizador del jugador activo.
4. Botón “Salir de la partida” al final, separado visualmente.

Cada tarjeta incluye:

- Avatar circular con color del jugador e inicial.
- Nombre (truncado a una línea) y badges “Host”, “Tú”.
- Paredes restantes: icono de pared + número (`wallsLeft`).
- Indicador de turno activo:
  - Barra/borde izquierdo del color del jugador.
  - Texto “Turno” visible, no solo color.
  - Hover/focus muestra tooltip “Es el turno de `<nombre>`”; el tooltip no es la única fuente.
- Temporizador del jugador activo:
  - Aro o barra circular + número de segundos.
  - Solo en la tarjeta activa; el resto muestra “—”.
- Estado fantasma/desconectado:
  - Tarjeta atenuada y con patrón diagonal.
  - Badge “Fantasma” y texto “Desconectado”; tooltip “Puede reconectar”.
- `aria-current="true"` en la tarjeta del jugador activo.
- La tarjeta propia lleva `aria-label` con “Tú, `<nombre>`, `<n>` paredes restantes”.

Interacción:

- Las tarjetas no son botones; si se añade inspección, usar un botón interno con `aria-expanded` y no anidar controles.
- El hover no debe mover el layout: usar `background-color`, `border-color` y `box-shadow`.
- La lista debe ser navegable con Tab solo si contiene acciones; si no, es contenido estático.

Botón “Salir de la partida”:

- Estilo destructivo secundario (borde/rojo), no primario.
- Abre confirmación destructiva: “¿Salir de la partida? Pasarás a fantasma y se omitirán tus turnos.”
- Confirmar envía `client.leaveGame`; cancelar devuelve el foco al botón.
- Tras confirmar, pasar a modo espectador/fantasma; no volver a `home` mientras la partida siga.
- Si el jugador ya es fantasma, el botón se sustituye por el estado “Estás fuera de la partida” y no se ofrece otra acción de salida.

### 7.3 Panel propio ampliado (footer)

Debe mostrar, sin scroll en 1366 × 768:

- Avatar y color del jugador.
- Nombre completo (hasta 2 líneas si cabe; truncar con tooltip).
- Paredes restantes con icono y número grande.
- Tiempo restante con barra + número.
- Meta: icono de dirección (`top`/`bottom`/`left`/`right`) y texto “Meta: lado superior”.
- Indicador “Tu turno” visible cuando `isTurn` y `connected && !ghost`; en caso contrario, “Turno de `<nombre>`” o “Esperando…”.
- Controles de accesibilidad:
  - “Patrones de color” (on/off) para daltonismo.
  - “Alto contraste” (on/off).
  - “Pantalla completa” (si el navegador lo permite).
  - Botón “Cómo jugar” que abre el modal.
- Los controles son botones de 44 px, con `aria-pressed` para toggles y persistencia en `localStorage`.
- El tiempo debe ser legible a distancia: número ≥ 24 px en desktop, ≥ 20 px en móvil.
- En móvil, el footer se compacta: avatar + nombre + paredes + tiempo en una fila; controles en una segunda fila o menú “Accesibilidad”.

### 7.4 Tablero

#### 7.4.1 Pistas y coordenadas

- Tablero cuadrado de `size × size` celdas, `8 ≤ size ≤ 20`.
- CSS Grid de `size * 2 + 1` pistas por eje, con canal de pared al inicio y al final; esta es la estructura real de `board.js`.
  - Pistas pares en base 1 (2, 4, 6, …): celdas. La celda `(x, y)` usa `grid-column: 2x + 2` y `grid-row: 2y + 2`.
  - Pistas impares (1, 3, 5, …): canales de pared. El ancla `(x, y)` usa `grid-column: 2x + 3` y `grid-row: 2y + 3`.
- Origen `(0,0)` arriba a la izquierda; `x` = columna, `y` = fila.
- Celdas cuadradas con `aspect-ratio: 1`, bordes redondeados y separación visual (gap) de `--board-gap`.
- Para no romper el cálculo de pistas, el gap se implementa con `inset` en la cara de la celda, no con la propiedad `gap` del grid. El resultado visual es un gap uniforme.
- El tablero se construye una sola vez por partida/tamaño; ver §13 y la plantilla de §7.4.4.

#### 7.4.2 DOM mínimo de celda

```html
<button
  type="button"
  class="board__cell"
  tabindex="-1"
  style="grid-column: 4; grid-row: 6"
  data-x="1" data-y="2"
  aria-label="B3, libre">
  <span class="board__cell-face" aria-hidden="true"></span>
  <span class="board__spawn" aria-hidden="true"></span>
  <span class="board__goal" aria-hidden="true"></span>
  <span class="board__move-dot" aria-hidden="true"></span>
</button>
```

- La ficha, la meta y el spawn se insertan dentro de la celda como `.board__piece`, `.board__goal-marker` y `.board__spawn-marker`, con `--player-color: var(--color-player-N)`.
- La celda es un botón nativo dentro de un contenedor `role="group"`; mantiene foco y activación por teclado.
- `tabindex="-1"` en todas salvo la celda activa, que usa `tabindex="0"` (roving tabindex).
- No usar `role="grid"` con celdas planas sin `role="row"`: si se desea semántica de grid, envolver cada fila en un `role="row"` y cada celda en `role="gridcell"` sin romper el CSS Grid. La opción recomendada es `role="group"` + botones etiquetados.
- `aria-label` incluye coordenada, ocupante y estado: “C4, ficha de Ana”, “C5, meta de Luis”, “D4, libre”.
- La ficha y la meta son `aria-hidden` porque el nombre accesible de la celda ya lo describe.
- `data-x`/`data-y` son numéricos validados; nunca se interpolan como HTML.

#### 7.4.3 Objetivos, fichas, spawns y fantasmas

- **Objetivo/meta:** banda interior en el lado correspondiente (`top`/`bottom`/`left`/`right`) con el color del jugador, margen interno de 4–6 px. No usar solo un borde exterior.
- **Ficha:** disco del color del jugador, inicial del nombre en blanco, sombra sutil, tamaño ~70 % de la celda.
- **Spawn:** pequeño anillo o marca discreta del color del jugador en la celda de origen; opcional, no debe confundirse con la meta.
- **Fantasma:** opacidad 0.45, patrón diagonal, borde discontinuo, filtro de saturación reducido y badge “Fantasma” en el panel. La celda sigue siendo transitable; el `aria-label` indica “fantasma, celda transitable”.
- **Turno activo:** anillo de foco/estado en la ficha activa; no animar la ficha en cada tick.
- No usar el color como único identificador: inicial + nombre en panel + patrones opcionales.

#### 7.4.4 CSS Grid del tablero

```html
<div
  class="board"
  role="group"
  aria-label="Tablero de 9 por 9"
  data-size="9"
  style="--board-size: 9; --grid-template: var(--wall-thickness) repeat(8, 1fr var(--wall-thickness)) 1fr var(--wall-thickness)">
  ...
</div>
```

```css
.board {
  display: grid;
  grid-template-columns: var(--grid-template);
  grid-template-rows: var(--grid-template);
  inline-size: max-content;
  block-size: max-content;
  background: var(--color-board);
  border-radius: var(--radius-lg);
  padding: 0;
  touch-action: manipulation;
}

.board__cell {
  aspect-ratio: 1;
  min-inline-size: 0;
  min-block-size: 0;
  border: 0;
  padding: 0;
  background: transparent;
  position: relative;
  display: grid;
  place-items: center;
}

.board__cell-face {
  position: absolute;
  inset: calc(var(--board-gap) / 2);
  border-radius: var(--radius-sm);
  background: var(--color-cell);
  box-shadow: inset 0 0 0 1px var(--color-cell-border);
}

.board__piece {
  inline-size: 70%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: var(--player-color, var(--color-accent));
  color: #fff;
  display: grid;
  place-items: center;
  font-weight: 700;
  position: relative;
  z-index: var(--z-piece);
}
```

> `board.js` genera la plantilla en `gridTemplate(size)`: `var(--wall-thickness) repeat(size - 1, 1fr var(--wall-thickness)) 1fr var(--wall-thickness)`. Son `2 * size + 1` pistas: `size + 1` canales de pared y `size` celdas `1fr`. El renderer la asigna directamente a `style.gridTemplateColumns` y `style.gridTemplateRows`; `--grid-template` en el ejemplo es solo notación. No hardcodear 8 salvo en el ejemplo de 9 × 9.

Posicionamiento exacto de paredes (coordenadas 1-based de CSS Grid, según `board.js`):

- Ancla `(x, y)`, con `0 ≤ x,y ≤ size-2`: `grid-row: 2y+3; grid-column: 2x+3;`.
- Pared **H** colocada: `grid-row: 2y+3; grid-column: 2x+2 / span 3;` (canal horizontal entre las filas `y` e `y+1`, a lo largo de las columnas `x` y `x+1`).
- Pared **V** colocada: `grid-column: 2x+3; grid-row: 2y+2 / span 3;` (canal vertical entre las columnas `x` y `x+1`, a lo largo de las filas `y` e `y+1`).
- El botón `.board__anchor`, el preview `.board__wall-preview` y las pistas legales `.board__wall-hint` usan esas mismas coordenadas; el preview se extiende una celda a cada lado según la orientación.
- Una H y una V pueden compartir ancla y cruzarse; solo se consideran solapadas si coinciden orientación y ancla.

### 7.5 Puntos de movimiento legales

- Se muestran **solo** si:
  - La partida está `playing`.
  - El jugador local es el jugador del turno (`turnPlayerId === playerId`).
  - El jugador local está activo (`connected && !ghost`).
  - No hay reconexión, overlay bloqueante ni acción pendiente.
- La lista de destinos se obtiene de `src/core` a partir del último snapshot autoritativo. La UI no calcula adyacencia, saltos ni bloqueos.
- Representación:
  - Punto centrado de 28–32 % del tamaño de la celda, color del jugador.
  - Hover: halo/anillo; foco: anillo de foco visible; click: envía `client.move`.
  - La celda destino recibe `data-legal="true"` y `aria-label` “Movimiento legal a D4”.
  - La ficha actual no muestra punto.
- Teclado:
  - El tablero entra en modo movimiento por defecto al recibir el turno.
  - Flechas mueven el foco entre celdas; `Enter`/`Espacio` envía el movimiento si la celda enfocada es legal.
  - Si la celda no es legal, anunciar “Movimiento no permitido” sin enviar nada.
  - `Escape` cancela la selección de pared y vuelve al modo movimiento.
- Al enviar un movimiento:
  - Deshabilitar nuevas acciones de juego hasta `server.gameState` o error/timeout.
  - Mantener los puntos visibles con opacidad reducida y `aria-busy="true"` hasta recibir el estado.
  - No mover la ficha de forma optimista; el servidor es la autoridad.
- Si no hay movimientos legales, mostrar un texto discreto “Sin movimientos legales” y mantener las paredes disponibles; no inventar un pase.
- Anuncio de turno: “Tu turno. `<n>` movimientos legales.” una vez por turno, no en cada render.

### 7.6 Paredes

#### 7.6.1 Anclas e interacción

- Anclas válidas: `x` e `y` de 0 a `size - 2`.
- Cada ancla es una intersección entre celdas; puede alojar una pared H, V o ambas cruzadas.
- Se renderiza un botón de ancla por intersección para teclado; las anclas legales reciben `data-legal="true"` y un único `tabIndex` móvil (roving).
- El ratón **no necesita modo ni atajo**:
  - Todas las paredes legales (H y V) se muestran como pistas interactivas sobre los canales.
  - Al pasar el cursor por un canal se resalta la pista legal más cercana y se muestra el preview con el color del jugador.
  - Un click sobre esa pista coloca la pared inmediatamente.
  - Si H y V se solapan, gana la pista cuyo centro esté más cerca del cursor.
- Teclado:
  - `H` por defecto; `R` alterna la orientación del ancla enfocada y se anuncia.
  - Flechas navegan entre anclas legales de la orientación actual; `Enter`/`Espacio` coloca; `Escape` oculta el preview.
- No hay botones “Pared” ni “Rotar”.
- No mostrar previews de paredes ilegales, sin paredes restantes, fuera de turno o durante reconexión.
- Contador de paredes restantes visible en el panel y en el footer; no descontar hasta `server.gameState`.
- Al colocar:
  - Enviar `client.placeWall` con `{ orientation, x, y }`.
  - Deshabilitar acciones de juego hasta respuesta.
  - Mostrar animación breve de colocación solo si no hay `prefers-reduced-motion`.
- Si el servidor rechaza (`INVALID_WALL`, `PATH_BLOCKED`, `NO_WALLS_LEFT`, `NOT_YOUR_TURN`, `PLAYER_GHOST`):
  - Quitar el preview/pending.
  - Mantener el estado autoritativo anterior.
  - Mostrar toast de aviso/error y volver a calcular anclas legales con `src/core` sobre el último snapshot.

#### 7.6.2 Representación

- **Preview:** usa `--wall-color` con el color del jugador que va a colocar (fallback `--color-wall-preview`), opacidad 0.85, sin sombra fuerte; H ocupa el canal horizontal y V el vertical. La longitud visual abarca dos celdas.
- **Pared colocada:** usa `--wall-color` derivado de `walls[H|V][].playerId` → `players[].colorIndex` (fallback `--color-wall`), con el mismo relieve, extremos redondeados y `z-index: var(--z-wall)`.
- **Atribución:** el color identifica al autor, pero no es el único indicador: la tarjeta de cada jugador y su ficha usan el mismo color y las paredes conservan su `aria-label`.
- **Animación:** escala/opacidad de 120–160 ms; en `prefers-reduced-motion`, aparición inmediata.
- **Relación con celdas:** las paredes no deben tapar fichas ni puntos de movimiento; las fichas tienen `z-index` superior.
- **Accesibilidad:** `aria-label` “Pared horizontal entre C4 y C5” / “Pared vertical entre D4 y E4”; las paredes colocadas son contenido estático, no botones.
- **Responsive:** en pantallas estrechas se reduce el tamaño máximo de celda, pero el canal de pared se mantiene visible y las pistas siguen siendo alcanzables con el dedo; no se usa selector de confirmación.

### 7.7 Temporizador de 30 s

- El servidor es la autoridad. La UI solo muestra `remainingSeconds` de `server.gameState`/`server.tick`.
- Sincronización:
  - En cada `server.tick`, guardar `remainingSeconds` y el instante local de recepción.
  - Suavizar la cuenta atrás con `requestAnimationFrame` y `performance.now()`; no usar `setInterval` para animar.
  - Si la diferencia entre la estimación local y un tick nuevo supera 1.5 s, hacer snap al valor del servidor.
  - Al volver de una pestaña oculta, descartar la estimación local y esperar el siguiente tick/estado.
- Visual:
  - Aro o barra en la tarjeta activa + número entero de segundos.
  - Barra en el footer propio con `transform: scaleX(remaining / 30)` y `transform-origin: left`.
  - Últimos 5 s: color `--color-danger`, texto “Quedan `<n>` segundos”; sin pulsos si `prefers-reduced-motion`.
- Accesibilidad:
  - Contenedor con `role="timer"` y texto actualizado; o `role="progressbar"` con `aria-valuemin="0"`, `aria-valuemax="30"`, `aria-valuenow` y `aria-valuetext`.
  - Anunciar solo a 10 s, 5 s y 0 s mediante `aria-live="polite"`; no cada segundo.
  - El número no debe depender solo del color.
- Si llega a 0 localmente:
  - No enviar ninguna acción ni declarar timeout.
  - Mostrar “Esperando al servidor…”, deshabilitar acciones y esperar `server.gameState`/`server.tick`.
- El temporizador no se reinicia por acciones locales no confirmadas; solo cambia con el estado del servidor.
- `turnSeconds` es fijo en 30; no mostrar controles para cambiarlo.

### 7.8 Toasts

- Región fija en la esquina superior derecha (desktop) o superior centrada (móvil), con `aria-live`:
  - `polite` para `info` y `success`.
  - `assertive` para `warning` y `error`.
- Cada toast:
  - Icono + color + texto; nunca solo color.
  - Botón “Cerrar” accesible.
  - Pausa del temporizador al hover/focus.
- Cola:
  - Máximo 3 visibles.
  - Los demás esperan en FIFO.
  - Deduplicar el mismo `code`/mensaje dentro de 2 s.
  - No apilar errores idénticos de red.
- Duraciones:
  - `success`: 3 s.
  - `info`: 4 s.
  - `warning`: 6 s.
  - `error`: 8 s o persistente hasta cierre si requiere acción.
- No usar toasts para información crítica que deba permanecer (por ejemplo, “Tu turno”): eso va en el panel/footer.
- Ejemplos:

| Nivel | Ejemplo | Origen |
|---|---|---|
| `info` | “Luis se ha reconectado.” | `server.playerReconnected`. |
| `info` | “Turno omitido por timeout.” | `server.toast` `TURN_TIMEOUT`. |
| `warning` | “Acción inválida. Si vuelve a ocurrir, pasarás a fantasma.” | `server.actionRejected` con `warning:true`. |
| `warning` | “Te has quedado en la misma casilla. Debes moverte.” | `CAMPING_MUST_MOVE`. |
| `warning` | “Luis se ha desconectado; jugará como fantasma.” | `server.playerDisconnected` o `server.toast`. |
| `error` | “No se pudo colocar la pared: dejaría a un jugador sin camino.” | `PATH_BLOCKED`. |
| `error` | “Se ha perdido la conexión. Reintentando…” | Error de WebSocket. |
| `success` | “Código copiado.” | Acción local. |
| `success` | “Te has reconectado.” | `welcome resumed:true` tras reconexión. |

### 7.9 Estados de espera, desconexión, reconexión y fantasmas

| Estado | Señal visual | Comportamiento |
|---|---|---|
| Esperando inicio | Overlay “Preparando la partida…” con spinner. | Bloquear tablero; no enviar acciones. |
| Reconectando | Banner superior persistente “Reconectando…” + overlay semitransparente. | Mantener tablero visible pero `inert`; deshabilitar acciones; backoff §12.7. |
| Sin conexión | Banner “Sin conexión. Reintentando en `<n>` s”. | No acciones; no spamear toasts; reintentar al volver `online`. |
| Otro jugador desconectado | Tarjeta con badge “Fantasma” + toast informativo. | La partida continúa; no bloquear. |
| Yo fantasma por `leaveGame` | Overlay “Estás fuera de la partida” / “Modo espectador”. | Observar; no acciones; esperar fin o reconexión permitida. |
| Yo fantasma por AFK/desconexión | Igual que el anterior + motivo. | Si el socket se cerró, intentar reconectar; si `leaveGame`, no reconectar automáticamente. |
| Turno de otro | Footer “Turno de `<nombre>`”; sin puntos legales. | Deshabilitar movimiento/pared; timer activo en su tarjeta. |
| Fin de partida | Transición a `gameover`. | Cancelar animaciones y timers locales. |

Reconexión:

- Mostrar overlay no destructivo; conservar el tablero y el último estado.
- Al reconectar con `welcome resumed:true`:
  - Reemplazar el snapshot por el completo recibido.
  - Cerrar overlay, mostrar toast “Te has reconectado” y restaurar foco en el tablero o en el último control.
- Si `resumed:false` o la sala ya no existe:
  - Cerrar overlay, limpiar estado de sala y volver a `home` con toast “La partida ya no está disponible”.
- Si el jugador estaba en su turno y el servidor ya lo omitió, aceptar el nuevo turno recibido; no reclamar el anterior.

---

## 8. Pantalla Fin de partida

### 8.1 Contenido

Sustituye a `game` (o se muestra como pantalla completa) al recibir `server.gameOver` o al terminar una partida local.

- **Ganador:**
  - Avatar con color del jugador, inicial y nombre.
  - Corona/insignia “Ganador” con icono + texto.
  - Color del jugador en el fondo del avatar, no en todo el fondo de la pantalla.
- **Motivo:**
  - “Meta alcanzada” si el ganador llegó a su celda meta.
  - “Último jugador activo” si el resto son fantasmas.
  - “Partida abandonada” si el servidor cierra por ausencia total.
  - Mostrar el texto del servidor si no encaja en estos casos, sin interpretar reglas en la UI.
- **Resumen de turnos:**
  - Número total de turnos (`turnNumber`).
  - Tabla de jugadores: avatar, nombre, color, paredes restantes, estado (activo/fantasma), posición de meta.
  - Indicar “Tú” en la fila propia.
- **Acciones:**
  - **Revancha** (primario): envía `client.rematch`; al pulsar, deshabilitar y mostrar “Esperando a que se reinicie la sala…”.
  - **Salir al inicio** (secundario/terciario): confirmación; envía `client.leaveRoom` y navega a `home`.
- **Estado de espera de rematch:**
  - Mostrar spinner/texto “Preparando la revancha…”.
  - No permitir doble envío.
  - Al recibir `server.rematchLobby`, navegar a `lobby` con el nuevo snapshot.
- **Si el host sale:**
  - `server.hostChanged` actualiza el badge “Host”.
  - El nuevo host conserva la posibilidad de iniciar cuando se vuelva al lobby.
  - El botón “Revancha” sigue disponible para cualquier jugador conectado según `docs/network.md`; la UI no exige ser host para enviarlo.
  - Si no quedan jugadores, la sala se borra y la UI vuelve a `home` con toast.
- **Reconexión en `gameover`:**
  - `server.welcome` con `resumed:true` y estado `finished` muestra esta pantalla con el snapshot recibido.
- **Local:**
  - “Revancha” reinicia la misma configuración local.
  - “Salir” vuelve a `local`.
  - No hay `client.rematch` ni sala.

### 8.2 Accesibilidad y foco

- Al entrar, enfocar el `h1` “Fin de la partida” o el nombre del ganador con `tabindex="-1"`.
- Anunciar “Gana `<nombre>` por `<motivo>`” en una región `aria-live="assertive"`.
- La tabla de resumen debe ser una tabla semántica o una lista con encabezados claros; no depender del color.
- La animación de confeti es opcional, decorativa, `aria-hidden` y desactivada con `prefers-reduced-motion`.
- Mantener el foco dentro de la pantalla de resultado; no devolverlo al tablero inexistente.

---

## 9. Modales y componentes reutilizables

### 9.1 Convenciones BEM y ARIA

- Bloques: `modal`, `dialog`, `toast`, `tooltip`, `avatar`, `badge`, `timebar`, `wall-picker`, `player-card`, `board`, `button`, `field`.
- Elementos: `block__element`.
- Modificadores: `block--modifier` o `block__element--modifier`.
- Estados: `is-open`, `is-active`, `is-disabled`, `is-pending`, `is-urgent`, `is-ghost`.
- No usar selectores dependientes de la estructura del servidor; usar `data-*` estables.
- Atributos ARIA mínimos por componente; no añadir roles que dupliquen semántica nativa.

### 9.2 Componentes

Los componentes marcados como **Fuera de v1** no tienen marcado en `public/index.html`; se conservan como guía y no bloquean la implementación. El HTML aporta `#toast-region`, `#modal-root` y `#overlay-root`, además de los controles reales `#wall-toggle` y `#wall-rotate`.

| Componente | DOM mínimo | Clases | ARIA / comportamiento |
|---|---|---|---|
| Modal base (**Fuera de v1**) | backdrop + panel + header + body + actions | `.modal`, `.modal__backdrop`, `.modal__panel`, `.modal__header`, `.modal__body`, `.modal__actions` | `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, `aria-describedby`; foco atrapado; Escape/click fuera; restaurar foco. |
| Confirmación destructiva (**Fuera de v1**) | título, texto, botón cancelar, botón destructivo | `.confirm`, `.confirm__title`, `.confirm__actions` | Foco inicial en “Cancelar”; `aria-describedby`; el botón destructivo no recibe foco inicial; Enter no confirma por accidente. |
| “Cómo jugar” | desplegable con secciones | `.howto`, `.howto__section` | `aria-expanded`/`aria-controls` en el disparador; variante modal con foco atrapado: **Fuera de v1**. |
| Selector de pared (**Fuera de v1**) | segmento H/V, preview, contador, colocar/cancelar | `.wall-picker`, `.wall-picker__orientation`, `.wall-picker__preview` | `role="group"`, `aria-label="Colocar pared"`; botones con `aria-pressed`; `R` rota; móvil en bottom sheet. En v1 se usan `#wall-toggle`, `#wall-rotate` y `.board__anchor`. |
| Toast | icono, mensaje, cierre | `.toast`, `.toast--info`, `.toast--warning`, `.toast--error`, `.toast--success` | `role="status"` (info/success) o `role="alert"` (warning/error); `aria-live` en la región; cierre accesible. |
| Tooltip (**Fuera de v1**) | texto no interactivo | `.tooltip` | `role="tooltip"`, `aria-describedby`; hover/focus; Escape; no es la única fuente de información; en táctil, alternativa visible. |
| Avatar | inicial + color | `.avatar`, `.avatar--ghost` | Texto alternativo si no hay nombre adyacente; `aria-hidden="true"` si el nombre ya está en el mismo contenedor accesible. |
| Badge | texto e icono | `.badge`, `.badge--host`, `.badge--self`, `.badge--ghost` | Texto siempre visible; no solo color; `aria-label` si abrevia. |
| Barra de tiempo | pista + relleno + número | `.timebar`, `.timebar__fill`, `.timebar__value` | `role="progressbar"` o `role="timer"`; `aria-valuemin/max/now/text`; urgente con texto además de color. |
| Tarjeta de jugador | avatar, nombre, badges, paredes, tiempo | `.player-card` | `aria-current="true"` si es el turno; etiqueta completa; no anidar botones. |
| Botón | icono opcional + texto | `.button`, `.button--primary`, `.button--secondary`, `.button--ghost`, `.button--danger` | Altura ≥ 44 px; `aria-pressed` para toggles; `aria-busy` durante pending; `disabled` real. |
| Campo | label + input + help + error | `.field`, `.field__label`, `.field__input`, `.field__help`, `.field__error` | `for`/`id`, `aria-invalid`, `aria-describedby`, error inline. |

### 9.3 Modal base: DOM ilustrativo (Fuera de v1)

```html
<div class="modal is-open" role="dialog" aria-modal="true"
     aria-labelledby="modal-title" aria-describedby="modal-desc">
  <div class="modal__backdrop" data-close="true"></div>
  <div class="modal__panel">
    <header class="modal__header">
      <h2 id="modal-title" class="modal__title">Salir de la partida</h2>
      <button class="icon-button" data-close="true" aria-label="Cerrar">×</button>
    </header>
    <div class="modal__body">
      <p id="modal-desc">Pasarás a fantasma y se omitirán tus turnos.</p>
    </div>
    <footer class="modal__actions">
      <button class="button button--secondary" data-close="true">Cancelar</button>
      <button class="button button--danger">Salir de la partida</button>
    </footer>
  </div>
</div>
```

Reglas:

- El backdrop no debe ser un botón con texto; usar `data-close` y capturar clic.
- No cerrar modales críticos con click fuera si la acción es destructiva; en ese caso, exigir “Cancelar” o Escape.
- Deshabilitar scroll del fondo y aplicar `inert` a la pantalla subyacente.
- Al cerrar, restaurar foco al disparador; si ya no existe, al `main` o al `h1`.
- El modal de “Cómo jugar” puede tener scroll interno; el foco no debe escapar.
- En móvil, el panel ocupa el ancho disponible menos 24 px y puede ocupar el alto completo con `max-block-size: 90dvh`.

---

## 10. Diseño visual y tokens

### 10.1 Paleta de jugadores

Esta es la paleta canónica y única: `PLAYER_COLORS` en `public/js/state.js`, expuesta en CSS como `--color-player-0` a `--color-player-7` y aplicada por `colorVar(colorIndex)`; `colorHex(colorIndex)` devuelve el HEX. No se acepta un color arbitrario del servidor ni HEX alternativos. Todos los colores llevan texto blanco con contraste ≥ 4.5:1.

| Índice | Variable CSS | Nombre | HEX | Texto | Contraste con blanco | Uso |
|---:|---|---|---|---|---:|---|
| 0 | `--color-player-0` | Rojo | `#B91C1C` | `#FFFFFF` | 6.5:1 | Ficha, avatar, meta, borde de turno. |
| 1 | `--color-player-1` | Azul | `#1D4ED8` | `#FFFFFF` | 6.7:1 | Ficha, avatar, meta, borde de turno. |
| 2 | `--color-player-2` | Verde | `#166534` | `#FFFFFF` | 7.1:1 | Ficha, avatar, meta, borde de turno. |
| 3 | `--color-player-3` | Ámbar | `#A16207` | `#FFFFFF` | 4.9:1 | Ficha, avatar, meta, borde de turno. |
| 4 | `--color-player-4` | Violeta | `#6D28D9` | `#FFFFFF` | 7.1:1 | Ficha, avatar, meta, borde de turno. |
| 5 | `--color-player-5` | Naranja | `#C2410C` | `#FFFFFF` | 5.2:1 | Ficha, avatar, meta, borde de turno. |
| 6 | `--color-player-6` | Teal | `#0F766E` | `#FFFFFF` | 5.5:1 | Ficha, avatar, meta, borde de turno. |
| 7 | `--color-player-7` | Rosa | `#9D174D` | `#FFFFFF` | 7.9:1 | Ficha, avatar, meta, borde de turno. |

Notas:

- El contraste indicado es con texto blanco calculado con luminancia relativa WCAG.
- No usar estos colores como fondo de texto largo; son para fichas, avatares, metas, bordes y acentos pequeños.
- Para daltonismo, activar “Patrones de color”: añadir textura/patrón distinto por jugador y mantener siempre la inicial y el nombre.
- El texto sobre el color del jugador usa blanco y peso 700; no usar texto negro sobre estos colores.

### 10.2 Colores de UI

| Token | HEX / valor | Uso | Contraste / nota |
|---|---|---|---|
| `--color-bg` | `#F8FAFC` | Fondo general. | — |
| `--color-surface` | `#FFFFFF` | Tarjetas, paneles, modales. | — |
| `--color-surface-2` | `#F1F5F9` | Filas alternas, fondo de tablero. | — |
| `--color-text` | `#0F172A` | Texto principal. | 17:1 sobre `#F8FAFC`. |
| `--color-text-muted` | `#475569` | Texto secundario. | 7:1 sobre `#F8FAFC`. |
| `--color-border` | `#CBD5E1` | Bordes normales. | 3:1 sobre superficies claras. |
| `--color-cell` | `#FFFFFF` | Cara de celda. | — |
| `--color-cell-border` | `#E2E8F0` | Borde interno de celda. | — |
| `--color-board` | `#E2E8F0` | Fondo del tablero/canales. | — |
| `--color-wall` | `#334155` | Color de fallback de paredes sin `playerId`. | 10:1 sobre blanco. |
| `--color-wall-preview` | `#94A3B8` | Preview de pared. | 3:1 sobre blanco. |
| `--color-accent` | `#0F766E` | Acción primaria. | Blanco 5.5:1. |
| `--color-accent-strong` | `#115E59` | Hover/active primario. | Blanco 6.9:1. |
| `--color-focus` | `#2563EB` | Anillo de foco. | 4.5:1 sobre blanco. |
| `--color-danger` | `#B91C1C` | Error, salir, tiempo crítico. | Blanco 6.5:1. |
| `--color-warning` | `#B45309` | Avisos. | Blanco 4.8:1. |
| `--color-success` | `#15803D` | Éxito. | Blanco 4.8:1. |
| `--color-info` | `#1D4ED8` | Información. | Blanco 6.7:1. |
| `--color-overlay` | `rgba(15, 23, 42, 0.65)` | Fondo de modal/overlay. | Texto blanco encima. |
| `--color-legal` | `var(--player-color, #0F766E)` | Punto de movimiento legal. | Usar color del jugador. |

### 10.3 Tipografía

- Familia: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.
- Números de tiempo/código: `ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace` con `font-variant-numeric: tabular-nums`.

| Token | Tamaño / línea | Peso | Uso |
|---|---|---|---|
| `--font-size-xs` | 12 px / 16 px | 500 | Badges, ayudas. |
| `--font-size-sm` | 14 px / 20 px | 400 | Texto secundario, tablas. |
| `--font-size-md` | 16 px / 24 px | 400 | Texto base, inputs. |
| `--font-size-lg` | 20 px / 28 px | 600 | Títulos de panel. |
| `--font-size-xl` | 28 px / 36 px | 700 | Títulos de pantalla. |
| `--font-size-2xl` | 40 px / 48 px | 700 | Título home/ganador. |
| `--font-weight-regular` | — | 400 | Texto. |
| `--font-weight-medium` | — | 500 | Controles. |
| `--font-weight-bold` | — | 700 | Énfasis, fichas. |

### 10.4 Espaciado, radios, sombras y capas

| Token | Valor | Uso |
|---|---:|---|
| `--space-1` | 4 px | Separaciones mínimas. |
| `--space-2` | 8 px | Gap de layout, padding compacto. |
| `--space-3` | 12 px | Padding de tarjetas. |
| `--space-4` | 16 px | Padding estándar. |
| `--space-5` | 24 px | Separación de secciones. |
| `--space-6` | 32 px | Márgenes de pantalla. |
| `--space-7` | 48 px | Bloques grandes. |
| `--space-8` | 64 px | Home desktop. |
| `--radius-sm` | 6 px | Celdas, badges. |
| `--radius-md` | 10 px | Botones, tarjetas. |
| `--radius-lg` | 16 px | Tablero, modales. |
| `--radius-pill` | 999 px | Avatares, pills. |
| `--shadow-sm` | `0 1px 2px rgba(15,23,42,.08)` | Reposo. |
| `--shadow-md` | `0 4px 12px rgba(15,23,42,.12)` | Tarjetas/modales. |
| `--shadow-lg` | `0 16px 40px rgba(15,23,42,.18)` | Modal. |
| `--z-board` | 1 | Tablero. |
| `--z-piece` | 10 | Fichas. |
| `--z-wall` | 20 | Paredes colocadas. |
| `--z-preview` | 30 | Preview de pared. |
| `--z-header` | 100 | Header. |
| `--z-drawer` | 200 | Cajón lateral móvil. |
| `--z-modal` | 300 | Modales. |
| `--z-toast` | 400 | Toasts. |
| `--z-tooltip` | 500 | Tooltips. |

### 10.5 Movimiento

| Token | Valor | Uso |
|---|---:|---|
| `--transition-fast` | 120 ms ease-out | Hover, foco, colores. |
| `--transition-base` | 180 ms ease-out | Aparición de toasts, paredes. |
| `--transition-slow` | 240 ms ease-in-out | Modales, overlays. |

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

### 10.6 Tamaños de layout

| Token | Valor | Uso |
|---|---:|---|
| `--header-height` | 64 px | Header desktop. |
| `--footer-height` | 112 px | Panel propio desktop. |
| `--panel-width` | 320 px | Aside desktop. |
| `--control-min` | 44 px | Altura mínima de controles. |
| `--touch-min` | 44 px | Objetivo táctil mínimo. |
| `--board-gap` | 2 px | Gap visual entre celdas. |
| `--wall-thickness` | `clamp(6px, 1vmin, 10px)` | Grosor de canales y paredes. |
| `--cell-size` | fórmula §10.7 | Lado de celda. |
| `--board-size` | 8..20 | Número de celdas por lado. |

### 10.7 Fórmula de tamaño del tablero

El tablero debe caber sin scroll en 1366 × 768 con header, footer y panel lateral, y escalar en móvil.

Dimensiones de referencia desktop:

- Ancho disponible: el del área `main` (depende del panel lateral).
- Alto disponible: `100dvh - site-header(64px) - padding(16px) - game-header(56px) - footer(88px) - gaps(32px) = 100dvh - 256px`.
- `--board-available = min(ancho, alto)`.

```css
:root {
  --panel-width: 320px;
  --site-header-height: 64px;
  --header-height: 56px;
  --footer-height: 88px;
  --wall-thickness: clamp(6px, 1vmin, 10px);
  --board-available: min(
    100%,
    calc(100dvh - var(--site-header-height) - 2 * var(--space-2) -
      var(--header-height) - var(--footer-height) - 4 * var(--space-2))
  );
  --cell-size: clamp(
    14px,
    calc((var(--board-available) - (var(--board-size) + 1) * var(--wall-thickness)) / var(--board-size)),
    72px
  );
}

@media (max-width: 767px) {
  :root {
    --wall-thickness: clamp(5px, 1.2vmin, 8px);
  }
  .board {
    --board-available: min(calc(100vw - 2 * var(--space-3)), calc(100dvh - var(--site-header-height) - 200px));
    --cell-size: clamp(
      12px,
      calc((var(--board-available) - (var(--board-size) + 1) * var(--wall-thickness)) / var(--board-size)),
      44px
    );
  }
}
```

Notas de implementación:

- La división por una variable CSS puede no estar soportada en navegadores antiguos. El renderer mide el contenedor con `ResizeObserver` y fija `--cell-size` en píxeles como fallback; la fórmula `clamp()` sigue siendo el valor de referencia.
- El tablero ocupa `size * cell-size + (size + 1) * wall-thickness`: los canales inicial y final ya están incluidos en las `2n + 1` pistas, así que no se añade padding extra.
- En 1366 × 768: `--board-available` = 512 px. Con `--wall-thickness` ≈ 7.7 px:
  - size 8: celda ≈ 56.7 px, tablero ≈ 512 px.
  - size 12: celda ≈ 35.1 px, tablero ≈ 512 px.
  - size 20: celda ≈ 20.2 px, tablero ≈ 512 px.
- En móvil de 390 px: `--board-available` = 366 px. Con pared de 5 px:
  - size 20: celda ≈ 13.1 px, tablero ≈ 366 px.
  - size 8: celda ≈ 40.1 px, tablero ≈ 366 px.
- En 320 px: size 20 con celda mínima de 12 px ocupa ≈ 345 px; si no cabe, el contenedor del tablero permite scroll.
- El `aside` nunca reduce la celda por debajo del mínimo; en ese caso, el panel se colapsa (tablet/móvil) antes que encoger el tablero.

### 10.8 Tabla de tokens CSS

| Token | Valor inicial | Categoría |
|---|---|---|
| `--color-bg` | `#F8FAFC` | Color. |
| `--color-surface` | `#FFFFFF` | Color. |
| `--color-surface-2` | `#F1F5F9` | Color. |
| `--color-text` | `#0F172A` | Color. |
| `--color-text-muted` | `#475569` | Color. |
| `--color-border` | `#CBD5E1` | Color. |
| `--color-accent` | `#0F766E` | Color. |
| `--color-accent-strong` | `#115E59` | Color. |
| `--color-focus` | `#2563EB` | Color. |
| `--color-danger` | `#B91C1C` | Color. |
| `--color-warning` | `#B45309` | Color. |
| `--color-success` | `#15803D` | Color. |
| `--color-info` | `#1D4ED8` | Color. |
| `--color-overlay` | `rgba(15,23,42,.65)` | Color. |
| `--color-board` | `#E2E8F0` | Tablero. |
| `--color-cell` | `#FFFFFF` | Tablero. |
| `--color-cell-border` | `#E2E8F0` | Tablero. |
| `--color-wall` | `#334155` | Tablero. |
| `--color-wall-preview` | `#94A3B8` | Tablero. |
| `--color-player-0` | `#B91C1C` | Jugador. |
| `--color-player-1` | `#1D4ED8` | Jugador. |
| `--color-player-2` | `#166534` | Jugador. |
| `--color-player-3` | `#A16207` | Jugador. |
| `--color-player-4` | `#6D28D9` | Jugador. |
| `--color-player-5` | `#C2410C` | Jugador. |
| `--color-player-6` | `#0F766E` | Jugador. |
| `--color-player-7` | `#9D174D` | Jugador. |
| `--font-sans` | `system-ui, ...` | Tipografía. |
| `--font-mono` | `ui-monospace, ...` | Tipografía. |
| `--font-size-xs` | `12px` | Tipografía. |
| `--font-size-sm` | `14px` | Tipografía. |
| `--font-size-md` | `16px` | Tipografía. |
| `--font-size-lg` | `20px` | Tipografía. |
| `--font-size-xl` | `28px` | Tipografía. |
| `--font-size-2xl` | `40px` | Tipografía. |
| `--space-1` | `4px` | Espaciado. |
| `--space-2` | `8px` | Espaciado. |
| `--space-3` | `12px` | Espaciado. |
| `--space-4` | `16px` | Espaciado. |
| `--space-5` | `24px` | Espaciado. |
| `--space-6` | `32px` | Espaciado. |
| `--space-7` | `48px` | Espaciado. |
| `--space-8` | `64px` | Espaciado. |
| `--radius-sm` | `6px` | Radio. |
| `--radius-md` | `10px` | Radio. |
| `--radius-lg` | `16px` | Radio. |
| `--radius-pill` | `999px` | Radio. |
| `--shadow-sm` | `0 1px 2px rgba(15,23,42,.08)` | Sombra. |
| `--shadow-md` | `0 4px 12px rgba(15,23,42,.12)` | Sombra. |
| `--shadow-lg` | `0 16px 40px rgba(15,23,42,.18)` | Sombra. |
| `--z-board` | `1` | z-index. |
| `--z-piece` | `10` | z-index. |
| `--z-wall` | `20` | z-index. |
| `--z-preview` | `30` | z-index. |
| `--z-header` | `100` | z-index. |
| `--z-drawer` | `200` | z-index. |
| `--z-modal` | `300` | z-index. |
| `--z-toast` | `400` | z-index. |
| `--z-tooltip` | `500` | z-index. |
| `--transition-fast` | `120ms ease-out` | Movimiento. |
| `--transition-base` | `180ms ease-out` | Movimiento. |
| `--transition-slow` | `240ms ease-in-out` | Movimiento. |
| `--header-height` | `64px` | Layout. |
| `--footer-height` | `112px` | Layout. |
| `--panel-width` | `320px` | Layout. |
| `--control-min` | `44px` | Tamaño. |
| `--touch-min` | `44px` | Tamaño. |
| `--board-gap` | `2px` | Tablero. |
| `--wall-thickness` | `clamp(6px, 1vmin, 10px)` | Tablero. |
| `--cell-size` | fórmula §10.7 | Tablero. |
| `--board-size` | `8..20` | Tablero. |
| `--player-color` | `var(--color-player-N)` | Contexto local. |

---

## 11. Responsive y móvil

### 11.1 Breakpoints

| Breakpoint | Rango | Layout |
|---|---|---|
| Desktop | ≥ 1200 px | Grid `main + aside`; aside 320 px; footer 112 px; tablero centrado. |
| Tablet | 768–1199 px | Grid `main + aside`; aside 280 px y colapsable; header 56 px; footer 104 px. |
| Móvil | < 768 px | Una columna; aside como cajón; footer compacto; tablero a ancho completo. |

### 11.2 Reordenación de paneles

- **Desktop:** header, main (izquierda), aside (derecha), footer a todo el ancho.
- **Tablet:** aside visible pero colapsable mediante botón “Jugadores (`n`)” en el header; al colapsar, el tablero ocupa el ancho.
- **Móvil:**
  - Header compacto: código, estado y botón “Jugadores”.
  - Tablero primero, centrado y sin panel lateral permanente.
  - Footer propio debajo del tablero o fijo en la parte inferior, sin tapar el tablero.
  - Toasts en la parte superior, por debajo del header.
- El orden del DOM debe ser lógico: header → main (tablero) → aside → footer. En móvil, el aside se convierte en diálogo/cajón y no debe quedar antes del tablero en el orden de tabulación.

### 11.3 Panel lateral colapsable

- Botón “Jugadores (`n`)” con `aria-expanded` y `aria-controls`.
- En tablet/móvil, abre un cajón (`dialog` no modal o modal con backdrop) desde la derecha.
- Foco:
  - Al abrir, foco al título o al primer control.
  - `Escape` cierra y devuelve el foco al botón.
  - Si es modal, fondo `inert` y foco atrapado; si no, no atrapar.
- Scroll interno del cajón; `overscroll-behavior: contain`.
- No cerrar el cajón al recibir un tick; sí actualizar contadores.
- Persistir el estado abierto/cerrado solo en desktop/tablet; en móvil, cerrar al navegar.

### 11.4 Controles táctiles y móvil

- Objetivos táctiles ≥ 44 × 44 px; separación ≥ 8 px entre acciones destructivas y normales.
- Botones de acción a ancho completo en formularios móviles.
- Inputs con `font-size: 16px` para evitar zoom automático en iOS.
- `touch-action: manipulation` en tablero, botones y anclas; evitar doble tap zoom accidental.
- No usar hover como único mecanismo:
  - Tooltips también por foco o tap.
  - Preview de pared por tap + confirmación.
  - Estados de turno con texto visible.
- Paredes en táctil:
  - Primer tap selecciona ancla/orientación.
   - Segundo tap confirma; botón “Colocar” en el selector: **Fuera de v1**.
  - “Rotar” siempre visible, junto al selector.
- Tablero:
  - Evitar gestos de arrastre que interfieran con scroll.
  - Si el tablero no cabe al tamaño mínimo, contenedor con `overflow: auto` y sombra/fade para indicar scroll.
- Footer móvil:
  - No tapar la última fila del tablero; usar `padding-block-end: env(safe-area-inset-bottom)`.
  - Controles de accesibilidad en un menú desplegable si no caben.
- Orientación:
  - Portrait: tablero centrado, panel como cajón.
  - Landscape: header y footer compactos; tablero al máximo; panel como cajón para no robar ancho.
- No bloquear zoom: no `maximum-scale=1` ni `user-scalable=no`; permitir zoom de texto y pellizco.
- En pantallas muy pequeñas, priorizar legibilidad sobre mostrar todos los paneles; nunca reducir una celda por debajo de 12 px.

---

## 12. Interacción y estados

### 12.1 Eventos UI → mensajes `client.*`

Referencia completa del protocolo: [`docs/network.md`](./network.md) §5.2.

| Evento UI | Condición | Mensaje | Payload | Efecto UI |
|---|---|---|---|---|
| Conectar/recargar | Hay identidad persistida. | `client.hello` | `{ playerId, sessionToken, alias? }` | Esperar `server.welcome`; overlay de conexión. |
| Crear sala | Alias válido, sin sala. | `client.createRoom` | `{ config: { size, maxPlayers, wallsPerPlayer, spawnMode }, alias }` | Pending; pasar a `lobby` solo con `roomCreated`. |
| Unirse | Código válido, alias válido. | `client.joinRoom` | `{ code, alias }` | Pending; pasar a `lobby` solo con `roomJoined`. |
| Editar configuración | Host, lobby. | `client.updateConfig` | `{ config: Partial<Config> }` | Pending “Guardando…”; aplicar `roomUpdate`. |
| Restablecer | Host, lobby. | `client.resetConfig` | `{}` | Pending; aplicar `roomUpdate`. |
| Empezar | Host, lobby, ≥2 activos. | `client.startGame` | `{}` | Pending; navegar con `gameStarted`. |
| Mover | Tu turno, activo, celda legal. | `client.move` | `{ to: { x, y } }` | Pending; no mover optimistamente; esperar `gameState`. |
| Colocar pared | Tu turno, activo, ancla legal. | `client.placeWall` | `{ orientation: "H"\|"V", x, y }` | Pending; preview; esperar `gameState`. |
| Salir de partida | Confirmación. | `client.leaveGame` | `{}` | Modo espectador/fantasma; no volver a `home`. |
| Salir de lobby/finished | Confirmación si procede. | `client.leaveRoom` | `{}` | Navegar a `home` al recibir `leftRoom`. |
| Revancha | `gameover`, conectado. | `client.rematch` | `{}` | Pending “Esperando…”; navegar con `rematchLobby`. |
| Casual | Alias válido, sin sala/cola. | `client.quickPlay` | `{}` | Ir a `queue`; esperar `matchSearching`. |
| Cancelar casual | En cola. | `client.cancelQuickPlay` | `{}` | Volver a `home` con `matchCancelled`. |
| Ping | Conectado. | `client.ping` | `{ t }` | Estimar offset; no bloquear UI. |
| Copiar código | — | Ninguno | — | Feedback local; no mensaje de red. |

Reglas:

- Un solo mensaje de acción de juego en vuelo. No encolar movimientos ni paredes.
- Enviar `requestId` cuando la petición espere respuesta directa; guardar `pending`.
- No enviar `client.updateConfig` en cada píxel del range; debounce 200 ms.
- `client.hello` se envía exactamente una vez por socket, como primer mensaje útil.
- `client.ping` cada 20–25 s y al volver de `visibilitychange`; no sustituye el heartbeat del servidor.

### 12.2 Mensajes `server.*` → cambios de UI

| Mensaje | Cambio de UI |
|---|---|
| `server.welcome` | Si `resumed:true`, rehidratar `lobby`/`game`/`gameover` y cerrar overlay. Si `false`, limpiar sesión de sala y volver a `home` con toast. |
| `server.roomCreated` | Navegar a `lobby` host; renderizar código, config y lista. |
| `server.roomJoined` | Navegar a `lobby` invitado; renderizar snapshot completo. |
| `server.roomUpdate` | Actualizar código, host, config y lista de jugadores sin recrear la pantalla. |
| `server.gameStarted` | Navegar a `game`; construir tablero con `state`; iniciar timer visual. |
| `server.gameState` | Reemplazar snapshot autoritativo; mover fichas, paredes, turno, paredes restantes y timer; recalcular ayudas con core. |
| `server.tick` | Actualizar solo temporizador (texto/barra) y sincronizar reloj; no re-renderizar tablero. |
| `server.gameOver` | Navegar a `gameover`; mostrar ganador, motivo, resumen; detener timers locales. |
| `server.toast` | Encolar toast con el nivel/código; mostrar mensaje seguro. |
| `server.error` | Mostrar error inline o toast según contexto; si es de acción pendiente, limpiar pending y reactivar controles. |
| `server.rematchLobby` | Navegar a `lobby`; actualizar snapshot; quitar estado de espera. |
| `server.actionRejected` | Quitar pending/preview; toast de aviso/error; si `warning:true`, mostrar advertencia AFK; si `ghosted:true`, pasar a estado fantasma. |
| `server.playerDisconnected` | Marcar tarjeta como fantasma/desconectado; toast informativo; no bloquear. |
| `server.playerReconnected` | Marcar conectado; toast “`<nombre>` se ha reconectado”; actualizar host si aplica. |
| `server.hostChanged` | Mover badge “Host”; habilitar/deshabilitar controles; toast. |
| `server.leftRoom` | Limpiar sala y navegar a `home`. |
| `server.matchSearching` | Mostrar posición/cola en `queue`; botón cancelar. |
| `server.matchFound` | Mostrar “Partida encontrada”; esperar `gameStarted`. |
| `server.matchCancelled` | Volver a `home`; toast “Búsqueda cancelada”. |
| `server.pong` | Calcular offset de reloj; no mostrar nada. |
| `server.welcome` con `resumed:false` | No asumir sala; ofrecer home/join. |

### 12.3 Deshabilitar acciones

| Condición | Movimiento | Pared | Empezar | Config | Revancha | Salir |
|---|---|---|---|---|---|---|
| No es tu turno | No | No | — | — | — | Sí (confirmar) |
| Acción pendiente | No | No | No | No | No | No |
| Reconectando/offline | No | No | No | No | No | No |
| Partida `finished` | No | No | — | — | Sí | Sí |
| Jugador fantasma | No | No | — | — | Sí (si conectado) | Modo espectador |
| Sin paredes restantes | — | No | — | — | — | — |
| Config inválida | — | — | No | Corregir | — | — |
| < 2 conectados activos | — | — | No | — | — | — |
| Alias inválido | — | — | — | — | — | — |

- El estado `disabled` debe ser real (`disabled`) y además reflejarse con `aria-disabled` cuando se use un contenedor no nativo.
- Mantener el motivo visible o accesible: no dejar un botón deshabilitado sin explicación.
- Al terminar una acción, reactivar solo tras `gameState`, `roomUpdate`, `error` o timeout controlado.

### 12.4 Idempotencia, doble clic y debounce

- Al hacer clic en una acción de red:
  - Deshabilitar el control inmediatamente.
  - Guardar `pending = { action, requestId, since }`.
  - Ignorar clics adicionales mientras `pending` esté activo.
- Doble clic en una celda legal: un solo `client.move`; el segundo clic se ignora hasta `gameState`.
- Doble clic en “Colocar pared”: un solo `client.placeWall`; no colocar dos paredes.
- Tras `gameState`/`error`, limpiar pending y reactivar.
- Timeout de acción: 10 s. Al expirar, mostrar “La acción no se confirmó” y permitir reintento manual; no reenviar automáticamente acciones de juego.
- Debounce:
  - Configuración tipo range: 200 ms.
  - Alias en `localStorage`: 250 ms.
  - Ping: 20–25 s; no enviar en cada interacción.
- Copiar código: sin red; feedback 2 s; clics repetidos reinician el feedback, no duplican toasts.
- Toasts deduplicados por código/mensaje en 2 s.
- No usar `setInterval` para enviar acciones repetidas.

### 12.5 Errores de red

- Distinguir:
  - `navigator.onLine === false`: banner “Sin conexión”; esperar evento `online`.
  - WebSocket cerrado con red disponible: reconectar con backoff.
  - Error de protocolo/`server.error`: no reconectar; mostrar error de la acción.
- Al cerrar el socket:
  - No borrar el estado de la partida.
  - Mostrar overlay/banner “Reconectando…”.
  - Deshabilitar acciones.
  - Iniciar backoff.
- No mostrar un toast por cada intento fallido; actualizar el banner con la cuenta atrás.
- Si el servidor cierra con `4003` (fantasma por AFK), mostrar el estado de fantasma y no reconectar automáticamente en bucle; ofrecer reconexión manual si el protocolo lo permite.
- Si el servidor cierra con `1008`/`1009`/`4002`, mostrar error y no reintentar en bucle; volver a `home` con explicación.
- Si `server.welcome resumed:false` tras reconectar, limpiar sala y volver a `home`.

### 12.6 Banner y overlay de conexión

- **Banner** (no modal) para estados transitorios:
  - “Sin conexión. Reintentando en 4 s…”
  - “Reconectando…”
  - “Conexión restablecida.”
- **Overlay** para bloqueo real:
  - “Preparando la partida…”
  - “Reconectando… No cierres esta pestaña.”
  - “Estás fuera de la partida (fantasma).”
- El overlay tiene `role="status"` o `role="alert"` según urgencia, `aria-live`, y no roba el foco si solo informa.
- Si bloquea interacción, aplicar `inert` al tablero/paneles y devolver el foco al cerrar.
- No usar el overlay para toasts informativos.

### 12.7 Reconexión con backoff

1. Detectar cierre de WebSocket o error.
2. Pasar `connection = reconnecting`; mostrar banner/overlay; deshabilitar acciones.
3. Reintentar con backoff exponencial + jitter:
   - 1 s, 2 s, 4 s, 8 s, 16 s, 30 s máximo.
   - Jitter de ±20 % para evitar tormentas.
4. Al abrir el socket:
   - Enviar `client.hello` con `playerId` y `sessionToken` persistidos.
   - Esperar `server.welcome`.
5. Si `resumed:true`:
   - Recibir snapshot completo (`gameState`, `roomUpdate`, etc.).
   - Rehidratar la pantalla correspondiente.
   - Cerrar overlay; toast “Te has reconectado”.
6. Si `resumed:false`:
   - Limpiar sala; volver a `home`; toast “La partida ya no está disponible”.
7. Si el navegador está offline, no intentar sockets; esperar `online`.
8. Cancelar timers de backoff al cerrar la pestaña o al salir voluntariamente.
9. No reconectar si el usuario está en `home` sin sesión de sala.

---

## 13. Rendimiento

### 13.1 Presupuesto

- Presupuesto por frame: **16 ms** (60 fps). Cualquier actualización visual debe mantenerse por debajo.
- Las actualizaciones de tablero y timer deben ser independientes:
  - Tick del timer: solo texto/transform.
  - `gameState`: solo cambios de celdas/fichas/paredes.
- Tamaño máximo: 20 × 20 = 400 celdas + 361 anclas; no se necesita virtualización.
- Evitar recrear el tablero completo en cada `server.tick` o `gameState`.

### 13.2 Render incremental

- Construir el tablero una vez por partida y tamaño con `DocumentFragment`.
- Guardar mapas:
  - `cellByKey = Map<"x,y", HTMLElement>`.
  - `wallByKey = Map<"H:x,y" | "V:x,y", HTMLElement>`.
  - `pieceByPlayerId = Map<playerId, HTMLElement>`.
- En `gameState`:
  - Comparar posiciones y mover solo las fichas que cambiaron (actualizar `grid-column`/`grid-row` o `transform`).
  - Añadir/quitar paredes nuevas por clave.
  - Actualizar clases de turno/legal/ghost solo en las celdas afectadas.
  - Actualizar contadores y textos del panel.
- No usar `innerHTML` para reconstruir listas de jugadores; actualizar filas existentes o reemplazar solo las que cambiaron.
- Delegación de eventos en el tablero (`click`, `keydown`, `pointerover`), no un listener por celda.
- Para previews, usar un único elemento de preview reutilizado, no crear/eliminar nodos en cada `mousemove`.
- Limpiar listeners y mapas al destruir la pantalla (`gameover`, salida, cambio de partida).

### 13.3 Timer y animaciones

- Usar `requestAnimationFrame` para la barra/aro del temporizador.
- Guardar `lastTick = { remaining, receivedAt }`; estimar con `performance.now()`.
- No usar `setInterval` para animar; el tick del servidor solo ancla el valor.
- En pestaña oculta, `requestAnimationFrame` se pausa; al volver, sincronizar con el siguiente tick y no acumular deuda.
- Animaciones de pared con `transform`/`opacity`; evitar animar `width`, `height`, `top`, `left` o `box-shadow` en cada frame.
- En `prefers-reduced-motion`, eliminar animaciones no esenciales.

### 13.4 Evitar layout thrashing

- No leer `getBoundingClientRect()`, `offsetWidth` o `scrollTop` dentro de bucles de escritura.
- Medir el contenedor una vez con `ResizeObserver` y escribir `--cell-size`.
- Agrupar lecturas y escrituras; usar `requestAnimationFrame` para el lote de escritura.
- Aplicar `contain: layout paint` al tablero y `contain: content` a tarjetas/toasts.
- Evitar `will-change` permanente; usarlo solo durante una animación concreta.
- No provocar reflow al actualizar cientos de `style` en el mismo frame; usar clases y transformaciones.

### 13.5 Medición

- Instrumentar con Performance API:
  - `performance.mark("gameState:start")` / `performance.measure(...)`.
  - Medir tiempo de render de `gameState`, `tick` y cambio de turno.
- Registrar long tasks con `PerformanceObserver` en desarrollo.
- Presupuesto:
  - Render de `gameState`: < 8 ms.
  - Tick del timer: < 2 ms.
  - Cambio de pantalla: < 50 ms percibido; evitar bloqueo del hilo principal.
- Probar con 8 jugadores, tablero 20 × 20, 30 s de ticks, reconexión y múltiples toasts.
- No incluir logs de depuración en producción.

---

## 14. Seguridad en cliente

### 14.1 Renderizado seguro

- **Nunca** usar `innerHTML` con datos del servidor ni con alias, nombres de sala, códigos, mensajes de error o textos de toast.
- Usar `textContent`, `document.createElement`, `append` y atributos de una lista blanca.
- Los alias y nombres pueden contener Unicode y tildes, pero no emojis en el alias; se muestran tal cual, sin interpretar HTML.
- Truncar visualmente con CSS (`text-overflow: ellipsis`) y mantener el texto completo en un `title`/tooltip accesible, no con HTML.
- Los `aria-label` también se construyen con texto plano, no con `innerHTML`.
- No interpolar datos del servidor en `style`; aplicar color solo desde el mapa `colorIndex → var(--color-player-N)`.
- Validar `colorIndex` como entero 0..7; si es inválido, usar un color neutro y registrar el error de protocolo, sin inyectar el valor.

### 14.2 Validación de entradas y URLs

- Código de sala: normalizar y validar contra `^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$` antes de mostrar, copiar o enviar.
- `x`, `y`, `size`, `maxPlayers`, `wallsPerPlayer`, `remainingSeconds` y `turnNumber`: validar tipo y rango; no usarlos como HTML ni como selectores CSS.
- Deep-link `?room=CODE` (**Fuera de v1**): si se habilita, mostrar solo si cumple la regex; no ejecutar redirecciones ni `location =` con valores no validados.
- No guardar `sessionToken` ni `playerId` en la URL, en logs, en mensajes de error visibles ni en analítica.
- `localStorage`:
  - Guardar alias, `playerId`, `sessionToken` (necesario para reconexión) y preferencias.
  - No guardar historiales de partida ni datos de otros jugadores.
  - Asumir que `localStorage` es legible por XSS; por eso la CSP y el renderizado seguro son obligatorios.
- No usar `eval`, `new Function`, `setTimeout(string)` ni `javascript:`.

### 14.3 CSP

La CSP se sirve como cabecera HTTP `Content-Security-Policy` desde `server/index.js`; no se usa `<meta http-equiv>` porque los navegadores ignoran `frame-ancestors` cuando se entrega en un elemento `<meta>`.

```text
default-src 'self';
connect-src 'self' wss:;
img-src 'self' data:;
style-src 'self' 'unsafe-inline';
script-src 'self';
object-src 'none';
base-uri 'none';
form-action 'self';
frame-ancestors 'none';
```

Notas:

- `style-src 'unsafe-inline'` puede ser necesario para variables de jugador y posiciones generadas; si se puede, usar nonce/hash y evitar estilos inline.
- Servir siempre por HTTPS/WSS en producción; redirigir HTTP a HTTPS.
- No cargar scripts, fuentes ni imágenes de terceros.
- Configurar cabeceras `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` y `Permissions-Policy` restrictiva.
- Evitar `target="_blank"` sin `rel="noopener noreferrer"` si se añaden enlaces externos.

### 14.4 Confianza y autoridad

- No confiar en timers, estado local, movimientos calculados por la UI ni en el `remainingSeconds` estimado.
- Las ayudas de `src/core` son solo para la interfaz; el servidor revalida y puede rechazar.
- No mostrar información de otros jugadores que no venga en el snapshot público.
- No permitir acciones si el estado local no está confirmado; esperar `gameState`/`roomUpdate`.
- No abrir un canal de “debug” que permita inyectar estado o mensajes arbitrarios en producción.
- Limitar la frecuencia de mensajes desde la UI (debounce, un pending) para no provocar `RATE_LIMITED`.

---

## 15. Criterios de aceptación visuales y checklist QA

### 15.1 Criterios visuales

- La pantalla de partida cabe sin scroll vertical en 1366 × 768 con header, footer y aside; el aside tiene scroll propio.
- El tablero mantiene celdas cuadradas, gap uniforme, metas legibles y fichas centradas en 8 × 8, 12 × 12 y 20 × 20.
- Ningún texto o control se solapa; los nombres largos se truncan sin romper filas.
- Los 8 colores de jugador son distinguibles y su texto blanco cumple contraste.
- El estado de turno, fantasma y conexión se entiende sin depender solo del color.
- Los estados hover, focus, active, disabled, pending y error son visualmente distintos.
- En móvil, el tablero, el footer y el cajón de jugadores son usables con una mano y sin zoom accidental.
- Los modales y overlays no dejan el foco atrapado al cerrarse ni permiten interactuar con el fondo.
- Las animaciones son sutiles y desaparecen con `prefers-reduced-motion`.

### 15.2 Checklist QA

- [ ] Home: dos columnas en ≥1200 px y apilado en móvil; sin desbordamientos.
- [ ] Home: alias vacío, de 1 carácter, de 17 caracteres o con caracteres prohibidos deshabilita las 4 acciones y muestra error inline.
- [ ] Home: alias de 2–16 caracteres con acentos se persiste y se muestra con `textContent`; emoji, 1 carácter y 17 caracteres se rechazan.
- [ ] Home: “Cómo jugar” cierra con Escape, clic fuera y botón; el foco se restaura.
- [ ] Crear: defaults 9 / 2 / 10 / random visibles y enviados al crear la sala.
- [ ] Crear: límites 8–20, 2–8, 0–20; no se puede bajar `maxPlayers` por debajo de los jugadores actuales.
- [ ] Lobby host: cambios de configuración se envían con debounce y se reflejan tras `roomUpdate`.
- [ ] Lobby host: “Restablecer” emite `client.resetConfig` y muestra el snapshot efectivo del servidor.
- [ ] Lobby: código de 6 caracteres sin ambiguos; copiar muestra “Copiado” y funciona el fallback.
- [ ] Lobby: lista en tiempo real por `colorIndex`, con Host, Tú, Conectado/Fantasma y orden estable.
- [ ] Lobby: “Empezar” deshabilitado con <2 conectados no fantasmas y motivo visible.
- [ ] Lobby: al salir el host se transfiere el rol y se actualiza la UI sin recargar.
- [ ] Unirse: normalización a mayúsculas y eliminación de espacios/guiones; “Pegar” funciona.
- [ ] Unirse: errores `ROOM_NOT_FOUND`, `ROOM_FULL` y `GAME_ALREADY_STARTED` (mapeado de `GAME_STARTED`) muestran mensajes claros.
- [ ] Unirse: timeout no reenvía a ciegas; el reintento es manual y no duplica la entrada.
- [ ] Local: selector exacto 2–8, nombres/colores editables sin duplicados, reset local.
- [ ] Local: la pantalla “Turno de `<nombre>`” oculta el tablero, bloquea foco y “Continuar” lo revela.
- [ ] Local: abandonar pide confirmación y vuelve a la configuración; revancha funciona.
- [ ] Partida 2 jugadores / tablero 8: layout, turnos, metas y paredes correctos.
- [ ] Partida 8 jugadores / tablero 20: panel con scroll, fichas legibles y sin solapamientos.
- [ ] Tablero: `size * 2 + 1` pistas con canal de pared inicial y final, celdas en pistas pares, anclas en impares, celdas cuadradas, gap, metas con banda de color y fichas con inicial.
- [ ] Movimiento: puntos solo en tu turno, en celdas legales; click y teclado envían una sola intención.
- [ ] Paredes: preview solo en anclas legales, rotación con R/botón, click coloca, contador correcto y sin previews ilegales.
- [ ] Paredes: `PATH_BLOCKED`, `WALL_OVERLAP` y `NO_WALLS_LEFT` muestran toast y no alteran el estado local.
- [ ] Timer: sincronizado con `server.tick`, últimos 5 s en rojo, sin autoridad local; a 0 espera al servidor.
- [ ] Toasts: info/aviso/error/éxito, cola máxima, deduplicación, `aria-live` y pausa al hover/focus.
- [ ] Desconexión propia: banner/overlay, backoff, reconexión con snapshot y restauración de foco.
- [ ] Desconexión ajena: tarjeta fantasma, turnos omitidos, paredes permanentes y sin bloqueo de la partida.
- [ ] AFK: primera acción inválida muestra advertencia; la segunda convierte en fantasma.
- [ ] Camping: intento de quedarse en la misma celda recibe `CAMPING_MUST_MOVE` y toast explicativo.
- [ ] Timeout: el servidor mueve automáticamente; la UI no declara el timeout por su cuenta.
- [ ] Fin de partida: ganador con color/avatar, motivo, resumen de turnos, revancha y salida.
- [ ] Rematch: espera visible, `rematchLobby` vuelve al lobby y el host actualizado se refleja.
- [ ] Host sale en `gameover`: se actualiza el host y no se rompe la pantalla.
- [ ] Modales: foco atrapado, Escape, clic fuera, retorno de foco y fondo `inert`.
- [ ] Accesibilidad: navegación completa por teclado en home, lobby, tablero, paredes y modales.
- [ ] Accesibilidad: contraste ≥4.5:1, foco visible, nombres accesibles y estados no solo por color.
- [ ] Accesibilidad: `prefers-reduced-motion` elimina pulsos/confeti/animaciones de pared.
- [ ] Responsive: 1366 × 768 sin scroll; tablet 1024 × 768; móvil 390 × 844 y 320 × 568; landscape.
- [ ] Móvil: inputs a 16 px, zoom permitido, objetivos táctiles ≥44 px, cajón de jugadores usable.
- [ ] Recarga: reconexión con `hello` y `welcome resumed:true`; no se duplica la sala.
- [ ] **Fuera de v1:** deep-link `?room=CODE`: precarga, valida y no entra dos veces; código inválido no rompe.
- [ ] **Fuera de v1:** botón atrás con `popstate`: confirma salida de lobby/partida; no abandona silenciosamente.
- [ ] Doble clic: no duplica movimientos, paredes, configuración, revancha ni unión.
- [ ] Red: errores y reconexión con backoff; sin bucles infinitos ni toasts duplicados.
- [ ] Seguridad: ningún dato del servidor pasa por `innerHTML`; CSP activa; nombres escapados.
- [ ] Rendimiento: `gameState` no recrea 400 celdas; tick solo actualiza timer; <16 ms por frame.
- [ ] Sin errores en consola; sin recursos 404; sin logs de tokens o datos sensibles.

---

## 16. Referencias cruzadas

- [`docs/network.md`](./network.md): protocolo, estados de conexión y sala, mensajes `client.*`/`server.*`, errores, reconexión, fantasmas, timeout, revancha y forma exacta del estado público.
- [`docs/rules.md`](./rules.md): reglas de movimiento, saltos, paredes, caminos, metas, camping y condiciones de victoria. La UI no las reimplementa.
- [`docs/spawns.md`](./spawns.md): generación de spawns y metas, modos `random`/`central`/`perimeter`, distancias y asignación. La UI solo renderiza `spawn` y `goal`.
- `src/core`: motor puro usado para pass-and-play y para obtener sugerencias de legalidad en online; nunca sustituye la autoridad del servidor.
- `src/net`: transporte WebSocket y mapeo del protocolo; no contiene DOM ni reglas.

Fin del contrato de UI.
