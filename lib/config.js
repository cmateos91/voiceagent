// config: Centraliza constantes de entorno y runtime compartidas por el servidor.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export { loadAccessConfig } from './access-config.js';

export const PORT = Number(process.env.PORT || 3187);
export const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gpt-oss:20b';
export const EXEC_TIMEOUT_MS = Number(process.env.EXEC_TIMEOUT_MS || 120000);
export const EXEC_SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
export const API_TOKEN = process.env.API_TOKEN || randomUUID();
export const SETUP_ALLOWED_CMDS = new Set(['ollama', 'winget', 'brew', 'systemctl', 'curl']);

export const DEFAULT_WORKDIR_CANDIDATES =
  process.platform === 'win32'
    ? [join(homedir(), 'Documents'), join(homedir(), 'Documentos')]
    : [join(homedir(), 'Documentos'), join(homedir(), 'Documents')];

export const DEFAULT_WORKDIR = DEFAULT_WORKDIR_CANDIDATES.find((p) => existsSync(p)) || homedir();
export const EXEC_WORKDIR = process.env.AGENT_WORKDIR || DEFAULT_WORKDIR;
export const DESKTOP_DIR =
  process.platform === 'win32'
    ? join(homedir(), 'Desktop')
    : [join(homedir(), 'Escritorio'), join(homedir(), 'Desktop')].find((p) => existsSync(p)) || join(homedir(), 'Desktop');
export const STRICT_GROUNDED_FS = process.env.STRICT_GROUNDED_FS !== 'false';
export const AUTO_EXEC_READONLY = process.env.AUTO_EXEC_READONLY !== 'false';
export const AUTO_SUMMARIZE_READS = process.env.AUTO_SUMMARIZE_READS !== 'false';
