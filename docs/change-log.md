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
