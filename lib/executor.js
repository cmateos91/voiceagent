// executor: Aplica validaciones de seguridad y ejecuta comandos del sistema con manejo de pendientes.
import { exec, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { EXEC_TIMEOUT_MS, EXEC_WORKDIR, SETUP_ALLOWED_CMDS } from './config.js';

const pendingCommands = new Map();

const blockedPatterns = [
  /(^|\s)rm\s+-rf\s+\//i,
  /(^|\s)mkfs(\.|\s)/i,
  /(^|\s)dd\s+if=/i,
  /(^|\s)shutdown(\s|$)/i,
  /(^|\s)reboot(\s|$)/i,
  /(^|\s)init\s+0/i,
  /(^|\s)poweroff(\s|$)/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/
];

export function isBlockedCommand(command) {
  return blockedPatterns.some((pattern) => pattern.test(command));
}

export function isReadOnlyCommand(command) {
  const normalized = command.toLowerCase();

  const mutatingPatterns = [
    /\brm\b/,
    /\bmv\b/,
    /\bcp\b/,
    /\bmkdir\b/,
    /\brmdir\b/,
    /\btouch\b/,
    /\btruncate\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bchgrp\b/,
    /\bln\b/,
    /\bsed\s+-i\b/,
    /\bperl\s+-i\b/,
    /\bgit\s+(add|commit|push|pull|reset|checkout|merge|rebase|clean)\b/,
    /\bnpm\s+(install|uninstall|update)\b/,
    /\bpip\s+install\b/,
    /\bapt\b/,
    /\bdnf\b/,
    /\bpacman\b/,
    /\bbrew\b/,
    /\bsystemctl\b/,
    /\bservice\b/,
    /\bkill\b/
  ];

  return !mutatingPatterns.some((pattern) => pattern.test(normalized));
}

export function parseCommand(commandStr) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (const ch of String(commandStr || '')) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  if (inSingle || inDouble) return null;
  return tokens.length ? tokens : null;
}

export function quoteForShell(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function executeCommand(command) {
  return new Promise((resolve) => {
    const tokens = parseCommand(command);
    if (!tokens) {
      resolve({
        command,
        cwd: EXEC_WORKDIR,
        stdout: '',
        stderr: '',
        ok: false,
        error: 'Empty command'
      });
      return;
    }

    if (
      command.includes('|') ||
      command.includes('>') ||
      command.includes('>>') ||
      command.includes('&&') ||
      command.includes(';')
    ) {
      const suggestion =
        process.platform === 'win32'
          ? 'Usa comandos simples como dir, tasklist, copy.'
          : 'Usa comandos simples como ls, ps, cp.';
      resolve({
        command,
        cwd: EXEC_WORKDIR,
        stdout: '',
        stderr: 'Shell operators not supported. Use simple commands only.',
        ok: false,
        error: `shell_operator_not_supported: ${suggestion}`
      });
      return;
    }

    if (isBlockedCommand(tokens.join(' '))) {
      resolve({
        command,
        cwd: EXEC_WORKDIR,
        stdout: '',
        stderr: '',
        ok: false,
        error: `Bloqueé ese comando por seguridad: ${command}`
      });
      return;
    }

    const [bin, ...args] = tokens;
    execFile(bin, args, { timeout: EXEC_TIMEOUT_MS, cwd: EXEC_WORKDIR }, (error, stdout, stderr) => {
      const response = {
        command,
        cwd: EXEC_WORKDIR,
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || ''
      };

      if (error) {
        resolve({
          ...response,
          ok: false,
          error: error.code === 'ENOENT' ? `Command not found: ${bin}` : error.message
        });
        return;
      }

      resolve({
        ...response,
        ok: true
      });
    });
  });
}

export function runShellCommand(command, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const tokens = parseCommand(command);
    if (!tokens) {
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        error: 'setup command not allowed'
      });
      return;
    }
    if (!SETUP_ALLOWED_CMDS.has(tokens[0])) {
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        error: 'setup command not allowed'
      });
      return;
    }

    exec(command, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? String(error.message || error) : ''
      });
    });
  });
}

export function prepareCommandResponse(command, message) {
  const token = randomUUID();
  pendingCommands.set(token, {
    command,
    createdAt: Date.now()
  });
  return {
    type: 'command',
    message,
    command,
    token
  };
}

export function getPendingCommand(token) {
  return pendingCommands.get(token);
}

export function hasPendingCommand(token) {
  return pendingCommands.has(token);
}

export function deletePendingCommand(token) {
  pendingCommands.delete(token);
}

export function cleanupPendingCommands() {
  const now = Date.now();
  for (const [token, item] of pendingCommands.entries()) {
    if (now - item.createdAt > 5 * 60 * 1000) {
      pendingCommands.delete(token);
    }
  }
}
