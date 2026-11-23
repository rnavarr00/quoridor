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
