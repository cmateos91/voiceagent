import express from 'express';
import { execFile } from 'node:child_process';
import { access as fsAccess } from 'node:fs/promises';
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
import { loadAccessConfig, saveAccessConfig } from './lib/access-config.js';
import { getActiveProviderConfig, loadProviderConfig, saveProviderConfig } from './lib/provider-config.js';
import {
  cleanupPendingCommands,
  deletePendingCommand,
  executeCommand,
  getPendingCommand,
  hasPendingCommand,
  runShellCommand
} from './lib/executor.js';
import { getInstalledModelsFromOllama, isValidModelName, setupStatus } from './lib/setup.js';
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

function maskKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  return `${key.slice(0, 4)}***`;
}

function toPublicProviderConfig(config) {
  return {
    provider: config.provider,
    ollamaModel: config.ollamaModel,
    openaiModel: config.openaiModel,
    anthropicModel: config.anthropicModel,
    openaiKey: maskKey(config.openaiKey),
    anthropicKey: maskKey(config.anthropicKey)
  };
}

app.get('/api/provider/config', (_req, res) => {
  const config = loadProviderConfig();
  return res.json(toPublicProviderConfig(config));
});

app.post('/api/provider/config', (req, res) => {
  const body = req.body || {};
  const current = loadProviderConfig();
  const provider = String(body.provider || current.provider || 'ollama');

  if (!['ollama', 'openai', 'anthropic'].includes(provider)) {
    return res.status(400).json({ error: 'provider invalido' });
  }

  const updates = {};
  if (typeof body.ollamaModel === 'string' && body.ollamaModel.trim()) updates.ollamaModel = body.ollamaModel.trim();
  if (typeof body.openaiModel === 'string' && body.openaiModel.trim()) updates.openaiModel = body.openaiModel.trim();
  if (typeof body.anthropicModel === 'string' && body.anthropicModel.trim()) updates.anthropicModel = body.anthropicModel.trim();
  if (typeof body.openaiKey === 'string') updates.openaiKey = body.openaiKey.trim();
  if (typeof body.anthropicKey === 'string') updates.anthropicKey = body.anthropicKey.trim();
  updates.provider = provider;

  const next = { ...current, ...updates };
  if (provider === 'openai' && !String(next.openaiKey || '').trim()) {
    return res.status(400).json({ error: 'openai key requerida' });
  }
  if (provider === 'anthropic' && !String(next.anthropicKey || '').trim()) {
    return res.status(400).json({ error: 'anthropic key requerida' });
  }

  const saved = saveProviderConfig(updates);
  return res.json(toPublicProviderConfig(saved));
});

app.get('/api/provider/models', async (req, res) => {
  const requested = String(req.query?.provider || getActiveProviderConfig().provider || 'ollama');
  if (requested === 'ollama') {
    const models = await getInstalledModelsFromOllama();
    return res.json({ provider: 'ollama', models });
  }
  if (requested === 'openai') {
    return res.json({ provider: 'openai', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'] });
  }
  if (requested === 'anthropic') {
    return res.json({
      provider: 'anthropic',
      models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6']
    });
  }
  return res.status(400).json({ error: 'provider invalido' });
});

app.get('/api/access/config', (_req, res) => {
  return res.json({ ...loadAccessConfig(), workdir: EXEC_WORKDIR });
});

app.post('/api/access/config', (req, res) => {
  const body = req.body || {};
  const mode = String(body.mode || '').trim();
  if (!['workdir', 'allowlist', 'free'].includes(mode)) {
    return res.status(400).json({ error: 'modo invalido' });
  }

  const updates = { mode };
  if (Array.isArray(body.allowedPaths)) {
    updates.allowedPaths = body.allowedPaths.map((p) => String(p || '').trim()).filter(Boolean);
  }

  if (mode === 'free') {
    console.warn('[security] Free mode enabled — full system access');
  }

  return res.json({ ...saveAccessConfig(updates), workdir: EXEC_WORKDIR });
});

app.get('/api/access/check-path', async (req, res) => {
  const input = String(req.query?.path || '').trim();
  if (!input) return res.json({ exists: false });
  try {
    await fsAccess(input);
    return res.json({ exists: true });
  } catch {
    return res.json({ exists: false });
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
