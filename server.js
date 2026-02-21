import express from 'express';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  API_TOKEN,
  EXEC_WORKDIR,
  OLLAMA_MODEL,
  PORT,
  STRICT_GROUNDED_FS,
  AUTO_EXEC_READONLY,
  AUTO_SUMMARIZE_READS
} from './lib/config.js';
import { createChatHandler } from './lib/chat-route.js';
import {
  cleanupPendingCommands,
  deletePendingCommand,
  executeCommand,
  getPendingCommand,
  hasPendingCommand,
  runShellCommand
} from './lib/executor.js';
import { isValidModelName, setupStatus } from './lib/setup.js';
import { cleanupSessionMemory } from './lib/session.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.use(express.static(join(__dirname, 'public')));

app.use('/api', (req, res, next) => {
  const headerToken = req.headers['x-api-token'];
  const queryToken = req.query?._token;
  const token =
    (Array.isArray(headerToken) ? headerToken[0] : headerToken) ??
    (Array.isArray(queryToken) ? queryToken[0] : queryToken);

  if (token !== API_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
});

app.get('/api/setup/status', async (_req, res) => {
  try {
    const status = await setupStatus();
    return res.json(status);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'No pude obtener el estado de setup.' });
  }
});

app.post('/api/setup/install-ollama', async (_req, res) => {
  try {
    if (process.platform !== 'win32') {
      return res.status(400).json({
        ok: false,
        message: 'La instalación automática de Ollama se soporta solo en Windows.'
      });
    }
    const cmd =
      'winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements';
    const result = await runShellCommand(cmd, 45 * 60 * 1000);
    const status = await setupStatus();
    return res.json({
      ok: result.ok,
      command: cmd,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
      status
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Error instalando Ollama.' });
  }
});

app.post('/api/setup/start-ollama', async (_req, res) => {
  try {
    let cmd = '';
    if (process.platform === 'win32') {
      cmd = 'ollama app';
      await runShellCommand(cmd, 15000);
    } else {
      cmd = 'ollama serve >/tmp/ollama-serve.log 2>&1 &';
      await runShellCommand(cmd, 15000);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = await setupStatus();
    return res.json({ ok: true, command: cmd, status });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Error iniciando Ollama.' });
  }
});

app.post('/api/setup/pull-model', async (req, res) => {
  try {
    const requested = req.body?.model;
    const model = isValidModelName(requested) ? requested : OLLAMA_MODEL;
    const cmd = `ollama pull ${model}`;
    const result = await new Promise((resolve) => {
      execFile('ollama', ['pull', model], { timeout: 6 * 60 * 60 * 1000 }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: error ? (error.code === 'ENOENT' ? 'Command not found: ollama' : String(error.message || error)) : ''
        });
      });
    });
    const status = await setupStatus();
    return res.json({
      ok: result.ok,
      command: cmd,
      model,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
      status
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Error descargando modelo.' });
  }
});

app.post('/api/chat', createChatHandler());

app.post('/api/execute', async (req, res) => {
  const token = req.body?.token;
  if (!token || !hasPendingCommand(token)) {
    return res.status(400).json({ error: 'Token inválido o expirado.' });
  }

  const pending = getPendingCommand(token);
  deletePendingCommand(token);
  const response = await executeCommand(pending.command);
  return res.status(200).json(response);
});

app.post('/api/reject', (req, res) => {
  const token = req.body?.token;
  if (token) {
    deletePendingCommand(token);
  }
  res.json({ ok: true });
});

setInterval(() => {
  cleanupPendingCommands();
}, 60 * 1000);

setInterval(() => {
  cleanupSessionMemory();
}, 10 * 60 * 1000);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`voice-pc-agent en http://localhost:${PORT}`);
  console.log('[auth] API token:', API_TOKEN);
  console.log(`Modelo: ${OLLAMA_MODEL}`);
  console.log(`Directorio de ejecucion: ${EXEC_WORKDIR}`);
  console.log(`Modo filesystem blindado: ${STRICT_GROUNDED_FS ? 'ON' : 'OFF'}`);
  console.log(`Auto-ejecucion lectura: ${AUTO_EXEC_READONLY ? 'ON' : 'OFF'}`);
  console.log(`Auto-resumen lectura: ${AUTO_SUMMARIZE_READS ? 'ON' : 'OFF'}`);
});
