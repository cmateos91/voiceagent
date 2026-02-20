# Voice PC Agent (Ollama + Voz + Terminal)

MVP local centrado en voz para hablar con un agente y operar el PC.

## Requisitos

- Node.js 20+
- Ollama corriendo localmente
- Modelo descargado, por ejemplo: `gpt-oss:20b`

## Instalar

```bash
cd /home/mate0s/voice-pc-agent
npm install
```

## Ejecutar

```bash
npm start
```

Abre: `http://localhost:3187`

## App de escritorio (Windows)

Modo escritorio local:

```bash
npm run desktop
```

Generar instalador `.exe`:

```bash
npm run dist:win
```

Desde Linux (Ubuntu) con `wine`:

```bash
npm run dist:win:linux
```

Si faltan dependencias:

```bash
sudo apt update && sudo apt install -y wine64 mono-devel nsis
```

El primer arranque muestra un asistente de setup que comprueba:
- Ollama instalado.
- Ollama en ejecucion.
- Modelo descargado.

Si falta algo, ofrece botones para instalar/iniciar/descargar.

La build ya incluye:
- icono de aplicacion e instalador (`build/icon.ico`).
- sidebar visual del instalador NSIS (`build/installer-sidebar.bmp`).
- splash screen de arranque en la app de escritorio.

## Actualizaciones en clientes Windows

El proyecto queda preparado para update in-app con `electron-updater`:

1. Publica versiones con tag (`v0.1.1`, `v0.1.2`, ...).
2. GitHub Actions (`.github/workflows/release-win.yml`) compila y publica el instalador.
3. En la app de Windows aparece el boton `Buscar actualizacion`:
   - si hay nueva version: `Descargar actualizacion`.
   - luego: `Reiniciar y actualizar`.

Importante:
- Ajusta en `package.json > build.publish` tu `owner/repo` reales.
- Si quieres menos alertas de SmartScreen, añade firma de codigo en CI.

## Flujo

1. Arranca en modo solo voz (orb + estados visuales).
2. Pulsa `Activar voz` y habla.
3. El panel de texto queda oculto por defecto y puedes activarlo con `Modo texto`.
4. Si el comando es de lectura (ej. `ls`, `pwd`, `find`, `cat`), se ejecuta automaticamente.
5. Si el comando modifica el sistema (ej. mover, renombrar, borrar, crear), pide aprobar/rechazar.

Tambien puedes confirmar por voz cuando hay comando pendiente:

- `aprobar comando` / `confirmar comando` / `ejecutar comando`
- `rechazar comando` / `cancelar comando` / `no ejecutar`

## Configuracion opcional

Variables de entorno:

- `OLLAMA_MODEL` (default: `gpt-oss:20b`)
- `PORT` (default: `3187`)
- `EXEC_TIMEOUT_MS` (default: `120000`)
- `AGENT_WORKDIR` (default: `~/Documentos`)
- `STRICT_GROUNDED_FS` (default: `true`)
- `AUTO_EXEC_READONLY` (default: `true`)
- `AUTO_SUMMARIZE_READS` (default: `true`) - tras comandos de lectura, devuelve un resumen automatico basado en la salida real

En modo voz, cuando existe `summary`, el agente lee solo ese resumen. Los detalles tecnicos del comando quedan en pantalla.
Por defecto la locucion es corta. Si pides un resumen `largo`, `detallado`, `completo`, `a fondo`, etc., leera la version larga.

Ejemplo:

```bash
OLLAMA_MODEL=gpt-oss:20b PORT=3187 npm start
```

## Seguridad actual

- Auto-ejecucion para lectura.
- Confirmacion para comandos de cambio.
- Bloqueo basico de comandos destructivos obvios.
- Tokens temporales de confirmacion (expiran).

## Importante

Este MVP no es un sandbox de seguridad fuerte. Para uso serio:

- Ejecutar en contenedor/VM aislada.
- Usar allowlist de comandos en lugar de bloqueo por regex.
- Correr con usuario sin privilegios.
- Auditar logs y agregar autenticacion local.
