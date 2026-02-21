// filesystem: Resuelve rutas seguras y realiza listados/inspecciones internas del directorio de trabajo.
import { access, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { EXEC_WORKDIR } from './config.js';

export function isHiddenName(name) {
  return String(name || '').startsWith('.');
}

export function safeResolveTarget(target) {
  const candidate = target && String(target).trim() ? String(target).trim() : '.';
  const abs = resolve(EXEC_WORKDIR, candidate);
  const rel = relative(EXEC_WORKDIR, abs);
  if (rel.startsWith('..')) return null;
  return abs;
}

export async function listWorkdirEntries() {
  try {
    const dirents = await readdir(EXEC_WORKDIR, { withFileTypes: true });
    return dirents
      .filter((d) => d.isDirectory() || d.isFile())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export async function listWorkdirDirectories() {
  try {
    const dirents = await readdir(EXEC_WORKDIR, { withFileTypes: true });
    return dirents
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export async function runInternalListing({ target = '.', listingIntent = 'entries', includeHidden = false }) {
  try {
    const abs = safeResolveTarget(target);
    if (!abs) {
      return {
        ok: true,
        command: `internal:list ${listingIntent} ${target}`,
        cwd: EXEC_WORKDIR,
        stdout: `No existe directorio: ${target}\n`,
        stderr: ''
      };
    }
    try {
      await access(abs);
    } catch {
      return {
        ok: true,
        command: `internal:list ${listingIntent} ${target}`,
        cwd: EXEC_WORKDIR,
        stdout: `No existe directorio: ${target}\n`,
        stderr: ''
      };
    }

    const dirents = await readdir(abs, { withFileTypes: true });
    const filtered = dirents.filter((d) => {
      if (!includeHidden && isHiddenName(d.name)) return false;
      if (listingIntent === 'dirs') return d.isDirectory();
      if (listingIntent === 'files') return d.isFile();
      return true;
    });

    const names = filtered.map((d) => d.name).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    return {
      ok: true,
      command: `internal:list ${listingIntent} ${target}`,
      cwd: EXEC_WORKDIR,
      stdout: names.join('\n') + (names.length ? '\n' : ''),
      stderr: ''
    };
  } catch (error) {
    return {
      ok: false,
      command: `internal:list ${listingIntent} ${target}`,
      cwd: EXEC_WORKDIR,
      stdout: '',
      stderr: String(error.message || error),
      error: String(error.message || error)
    };
  }
}

export async function walkEntries(base, maxDepth, includeHidden) {
  const out = [];
  async function walk(current, depth) {
    if (depth > maxDepth) return;
    let dirents = [];
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (!includeHidden && isHiddenName(d.name)) continue;
      const full = join(current, d.name);
      const rel = relative(EXEC_WORKDIR, full).replace(/\\/g, '/');
      out.push(rel);
      if (d.isDirectory()) await walk(full, depth + 1);
    }
  }
  await walk(base, 2);
  return out;
}

export async function runInternalInspection({ target = '.', includeHidden = true, maxItems = 200 }) {
  try {
    const abs = safeResolveTarget(target);
    if (!abs) {
      return {
        ok: true,
        command: `internal:inspect ${target}`,
        cwd: EXEC_WORKDIR,
        stdout: `No existe: ${target}\n---PWD---\n${EXEC_WORKDIR}\n`,
        stderr: ''
      };
    }
    try {
      await access(abs);
    } catch {
      return {
        ok: true,
        command: `internal:inspect ${target}`,
        cwd: EXEC_WORKDIR,
        stdout: `No existe: ${target}\n---PWD---\n${EXEC_WORKDIR}\n`,
        stderr: ''
      };
    }

    const header = [`INSPECCION: ${target}`];
    const top = (await readdir(abs, { withFileTypes: true }))
      .filter((d) => includeHidden || !isHiddenName(d.name))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    header.push(...top);
    header.push('---DETALLE (max 200)---');

    const details = (await walkEntries(abs, 2, includeHidden)).slice(0, maxItems);
    return {
      ok: true,
      command: `internal:inspect ${target}`,
      cwd: EXEC_WORKDIR,
      stdout: [...header, ...details].join('\n') + '\n',
      stderr: ''
    };
  } catch (error) {
    return {
      ok: false,
      command: `internal:inspect ${target}`,
      cwd: EXEC_WORKDIR,
      stdout: '',
      stderr: String(error.message || error),
      error: String(error.message || error)
    };
  }
}
