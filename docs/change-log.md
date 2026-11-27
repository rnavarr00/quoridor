# Registro de peticiones

Convención: una entrada por petición, añadida al final del archivo en orden cronológico.
Cada entrada lleva fecha ISO, título corto y tres campos: resumen de la petición,
resumen de la solución/respuesta y tareas derivadas (checklist; `Ninguna` si no hay).
Los archivos de texto usan finales de línea LF.

## 2026-11-23 — Pantalla en blanco y aviso de CSP en partidas casuales

- **Petición:** al abrir el localhost desde dos navegadores, la partida casual se quedaba en blanco hasta que un jugador abandonaba o agotaba el tiempo; la consola mostraba avisos de `frame-ancestors` ignorado en un `<meta>`.
- **Solución/respuesta:** `ui.js` excluyó el `<body>` del selector de pantallas (era marcado como `hidden` al cambiar de vista); la CSP completa y `X-Frame-Options: DENY` pasaron a cabeceras HTTP en `server/index.js` y se eliminó el `<meta>` de `index.html`. Se actualizó `docs/ui.md` y se añadió un test de regresión. `npm test` (38/38) y `npm run check` pasan.
- **Tareas derivadas:**
  - [ ] Probar el emparejamiento real desde dos navegadores y confirmar que el tablero aparece de inmediato y que no quedan avisos de CSP.

## 2026-11-23 — Configuración de finales de línea LF

- **Petición:** añadir `.gitattributes` con `* text=auto eol=lf` y respetar LF en todos los archivos de texto a partir de entonces, sin conversiones masivas.
- **Solución/respuesta:** se confirmó que los archivos modificados hasta ese momento ya usaban LF; se registró la regla para futuras ediciones. No se modificó ningún archivo solo por sus finales de línea.
- **Tareas derivadas:**
  - [ ] Normalizar `.gitattributes` a LF solo si se solicita explícitamente (actualmente tiene CRLF).

## 2026-11-23 — Registro de peticiones y cambios

- **Petición:** crear un documento que registre, tras cada petición, un resumen breve de la petición, de la solución/respuesta y de las tareas derivadas.
- **Solución/respuesta:** se creó `docs/change-log.md` con esa plantilla y las dos entradas anteriores, y `AGENTS.md` con la regla para mantenerlo actualizado en futuras peticiones, usando LF y sin commits.
- **Tareas derivadas:** Ninguna.

## 2026-11-23 — Colocación de paredes con ratón, tablero mayor y color por jugador

- **Petición:** hacer que las paredes se puedan colocar pasando el cursor entre casillas y haciendo click, sin activar modes ni rotar con teclas; ampliar el tablero y los canales; colorear cada pared con el color de quien la puso.
- **Solución/respuesta:** `board.js` muestra todas las paredes legales H/V como pistas interactivas, elige la más cercana al cursor, previsualiza y coloca con un click; se eliminaron los botones «Pared» y «Rotar» y su estado en `ui.js`/`index.html`. `GameEngine` guarda `playerId` en cada pared, `Room` lo expone en `walls.H/V`, y `board.js` lo mapea al color del jugador para paredes y preview. CSS aumenta `--wall-thickness`, reduce márgenes verticales y ajusta `--board-available`. Se actualizaron `docs/rules.md`, `docs/network.md`, `docs/ui.md` y se añadió un test de regresión. `npm test` (39/39), `npm run check` y `node --check` de los JS modificados pasan.
- **Tareas derivadas:**
  - [ ] Probar en el navegador que el hover resalta la pista correcta y que un click coloca la pared sin teclas.
  - [ ] Verificar en partida de dos navegadores que cada pared conserva el color de su autor tras varios turnos y reconnects.

## 2026-11-24 — Turnos locales sin confirmación

- **Petición:** quitar la confirmación entre turnos de las partidas jugadas en un único dispositivo, incluida la inicial, para dar más ritmo a la partida.
- **Solución/respuesta:** `main.js` sustituye `showLocalTurn()` por `beginLocalTurn()`, que muestra el tablero del jugador activo, mueve el foco, anuncia el turno y reinicia el temporizador sin capas modales. `ui.js` elimina `showHandoff()`/`hideHandoff()` y su estado; se retiran los estilos `.handoff*` y se actualizan `index.html` y `docs/ui.md`. La confirmación al salir de la partida se mantiene y el modo online queda intacto. `npm test` (39/39), `npm run check` y `node --check` de los JS modificados pasan.
- **Tareas derivadas:**
  - [ ] Probar en el navegador que el tablero aparece al empezar y tras cada movimiento o pared, sin overlay ni foco bloqueado.
  - [ ] Comprobar que el temporizador se reinicia por turno, que el auto-move continúa sin confirmación y que game over y revancha siguen funcionando.

## 2026-11-24 — Metas repartidas por el tablero

- **Petición:** eliminar el sesgo que hacía aparecer siempre las casillas objetivo en la parte superior del tablero, manteniendo que todos los jugadores tengan su meta a la misma distancia de su spawn y que ninguna meta se repita.
- **Solución/respuesta:** `assignGoals()` en `spawn.js` recibe el mismo `rng` del generador y baraja con Fisher-Yates los candidatos a distancia Manhattan antes del backtracking; se conservan unicidad, equidistancia, exclusión de spawns, modos de spawn y determinismo por semilla. `ui.js` usa `goalSideLabel()` para etiquetar metas interiores y `styles.css` añade `.board__goal-marker--center`. Se actualizaron `spawns.md`, `network.md`, `ui.md` y `rules.md`, y se añadió un test de distribución con 200 semillas. `npm test` (40/40), `npm run check` y `node --check` de los JS modificados pasan.
- **Tareas derivadas:**
  - [ ] Probar en el navegador que las metas aparecen repartidas entre bordes e interior y que una meta interior muestra sus coordenadas y marcador discontinuo.
  - [ ] Verificar en online con la misma semilla que dos jugadores reciben exactamente los mismos spawns y goals.

## 2026-11-25 — Ajustes visuales en celdas y fichas

- **Petición:** quitar la marca visible de spawn durante la partida, teñir las celdas objetivo con el color del jugador con transparencia y borde del mismo color, y dar a las fichas una sombra que sugiera relieve 3D sobre la celda.
- **Solución/respuesta:** `board.js` eliminó `spawnMarks`, el span de spawn y su actualización; `updateGoalsAndSpawns()` pasó a `updateGoals()`, que ahora marca la celda objetivo con `.is-goal` y `--player-color`. `styles.css` elimina `.board__spawn-marker`, añade el fondo al 22 % y el borde interior del color del jugador en `.board__cell.is-goal .board__cell-face`, y aplica el nuevo token `--shadow-piece-3d` a `.board__piece` y `.board__piece.is-turn`. Se actualizó `docs/ui.md`. `npm test` (40/40), `npm run check`, `node --check public/js/board.js` y `git diff --check` pasan.
- **Tareas derivadas:**
  - [ ] Probar en el navegador que no aparece ninguna marca de spawn, que las metas muestran el fondo y borde del color correcto y que las fichas se ven ligeramente elevadas, también en el turno activo.
  - [ ] Verificar con dos navegadores que cada meta conserva el color de su jugador y que el hover de movimientos legales sigue siendo claro.

## 2026-11-25 — Fichas y metas sin inicial ni marcador interior

- **Petición:** eliminar la letra «J» que aparece en la ficha y en la casilla objetivo, y quitar también el círculo a rayas dibujado dentro de la casilla objetivo.
- **Solución/respuesta:** `board.js` dejó de asignar `textContent` a `.board__piece` y eliminó `.board__goal-marker`, su mapa `goalMarks`, el span decorativo y `updateGoals()`; el teñido de la celda sigue funcionando desde `updateCells()` con `.is-goal` y `--player-color`. `styles.css` eliminó todas las reglas `.board__goal-marker*`, incluido el borde discontinuo de las metas interiores. Se actualizó `docs/ui.md`. `npm test` (40/40), `npm run check`, `node --check public/js/board.js` y `git diff --check` pasan.
- **Tareas derivadas:**
  - [ ] Comprobar en el navegador que las fichas son discos de color sin texto, que las metas solo muestran fondo y borde del color del jugador y que no queda ningún anillo a rayas.
  - [ ] Verificar que el tooltip de la ficha y el `aria-label` de la celda siguen identificando a cada jugador y su meta.

## 2026-11-25 — Fichas planas sin punto blanco

- **Petición:** eliminar el sombreado de las fichas y el pequeño círculo blanco que aparece en la parte inferior de la ficha propia, manteniendo el anillo azul del jugador activo.
- **Solución/respuesta:** `styles.css` quitó `--shadow-piece-3d`, el `box-shadow` base de `.board__piece` y la regla `.board__piece.is-self::after`; `.board__piece.is-turn` conserva únicamente los dos anillos de foco blanco y azul. Se actualizó `docs/ui.md`. `npm test` (40/40), `npm run check`, `node --check public/js/board.js` y `git diff --check` pasan.
- **Tareas derivadas:**
  - [ ] Comprobar en el navegador que las fichas no proyectan sombra ni muestran el punto blanco inferior, y que el anillo azul del turno sigue visible.

## 2026-11-25 — Paleta ampliada a 20 colores

- **Petición:** añadir 12 colores más para elegir, hasta 20 en total, sin ampliar el número máximo de jugadores.
- **Solución/respuesta:** `state.js` incorporó `PLAYER_COLOR_NAMES` y amplió `PLAYER_COLORS`, `colorVar()` y `colorHex()` a los índices 0..19; `ui.js` usa esas listas en el selector local y en su validación. `styles.css` añadió `--color-player-8` a `--color-player-19`, y `src/core/constants.js` sincronizó nombres, HEX, variantes y el tamaño de la paleta. Se actualizaron `docs/ui.md` y `docs/network.md`, y se añadió un test de longitud, coherencia y contraste ≥ 4.5:1 con blanco. `npm test` (41/41), `npm run check`, `node --check` de los JS modificados y `git diff --check` pasan.
- **Tareas derivadas:**
  - [ ] Probar en el navegador que el selector local muestra las 20 opciones con sus nombres y que ficha, avatar y metas usan el color elegido.
  - [ ] Revisar visualmente que los colores nuevos se distinguen suficientemente en partidas de hasta 8 jugadores.

## 2026-11-25 — Meta propia resaltada

- **Petición:** destacar la casilla objetivo del usuario frente al resto cuando hay muchos jugadores y colores parecidos, con el mismo tipo de resaltado que la ficha en turno.
- **Solución/respuesta:** `board.js` añadió `.is-my-goal` a la meta de `myId` en `updateCells()`; `styles.css` sube su tinte al 34 % y aplica el anillo blanco y azul de foco, con `z-index` para que no quede tapada por celdas vecinas. Se actualizó `docs/ui.md`. `npm test` (41/41), `npm run check`, `node --check public/js/board.js` y `git diff --check` pasan.
- **Tareas derivadas:**
  - [ ] Comprobar en el navegador que solo la meta propia lleva el anillo azul y que sigue siendo visible al pasar el cursor sobre un movimiento legal.
  - [ ] Verificar en local y online que el resaltado sigue al jugador correcto al cambiar de turno.

## 2026-11-25 — Tablero máximo 16 y radio de pared reducido

- **Petición:** reducir el máximo de casillas del tablero a 16 y disminuir el radio en que el cursor detecta colocación de pared sin reducir el grosor visual de la pared, para poder mover fichas en tableros grandes.
- **Solución/respuesta:** `state.js`, `ui.js`, `index.html`, `constants.js`, `GameEngine.js`, `spawn.js` y `protocol.js` limitan `size` a 8..16; se actualizaron tests y documentación, incluidos los vectores de `spawns.md`. `styles.css` añadió `--wall-hit-radius` (3 px / 4 px en móvil), reduce el `::after` de anclas a ese radio y pone las pistas en `pointer-events: none`; `board.js` cachea el radio desde CSS y lo usa en `findHintNearPointer()`. `--wall-thickness` y los `span 3` no cambian. `npm test` (41/41), `npm run check`, los `node --check` de los JS modificados, `git diff --check` y la comprobación LF pasan.
- **Tareas derivadas:**
  - [ ] Probar en navegador 8 × 8 y 16 × 16 que el centro de las celdas mueve la ficha y que las paredes se colocan con el canal resaltado.
  - [ ] Verificar en móvil el radio de 4 px, el teclado y que no se pierde precisión al colocar paredes.
   - [ ] Reiniciar o drenar salas creadas antes del cambio con tamaño 17-20.

## 2026-11-27 — Hover exclusivo entre casilla y pared

- **Petición:** evitar que al pasar el cursor se resalten a la vez la casilla de movimiento y la pared, dejando dudoso qué hará un click; en la franja solapada debe ganar la casilla y no mostrarse la pared.
- **Solución/respuesta:** `board.js` decide el hover en `onPointerMove`: si el objetivo es `.board__cell`, marca solo esa celda con `.is-hovered` y oculta pista, preview y ancla; el click trata primero la celda y solo consulta paredes fuera de ella. `findHintNearPointer` aplica el radio solo a lo largo del canal; `hidePreview`, `clearHover`, `render` y `setInteractive` limpian el estado obsoleto, y el foco de ancla comparte el mismo resaltado. `styles.css` sustituye los `:hover` de celda y ancla por `.is-hovered` controlado por JS, hace que el `::after` del ancla no capture eventos y elimina la regla muerta de `:hover` de pista. Se actualizó `docs/ui.md`. `npm test` (41/41), `npm run check`, `node --check public/js/board.js`, `git diff --check` y la comprobación LF pasan.
- **Tareas derivadas:**
  - [ ] Probar en el navegador 8 × 8 y 16 × 16 que al pasar por el borde de una casilla legal solo se resalta la casilla y el click mueve la ficha.
  - [ ] Verificar que el canal sigue colocando paredes con un solo click, también en móvil con radio de 4 px, y que H/V en un cruce siguen resolviéndose por centro más cercano.
