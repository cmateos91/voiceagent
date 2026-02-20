import express from 'express';
import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = express();
app.use(express.json({ limit: '1mb' }));
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.use(express.static(join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3187);
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gpt-oss:20b';
const EXEC_TIMEOUT_MS = Number(process.env.EXEC_TIMEOUT_MS || 120000);
const EXEC_SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
const DEFAULT_WORKDIR_CANDIDATES =
  process.platform === 'win32'
    ? [join(homedir(), 'Documents'), join(homedir(), 'Documentos')]
    : [join(homedir(), 'Documentos'), join(homedir(), 'Documents')];
const DEFAULT_WORKDIR = DEFAULT_WORKDIR_CANDIDATES.find((p) => existsSync(p)) || homedir();
const EXEC_WORKDIR = process.env.AGENT_WORKDIR || DEFAULT_WORKDIR;
const STRICT_GROUNDED_FS = process.env.STRICT_GROUNDED_FS !== 'false';
const AUTO_EXEC_READONLY = process.env.AUTO_EXEC_READONLY !== 'false';
const AUTO_SUMMARIZE_READS = process.env.AUTO_SUMMARIZE_READS !== 'false';

const pendingCommands = new Map();
const sessionMemory = new Map();

const blockedPatterns = [
  /(^|\s)rm\s+-rf\s+\//i,
  /(^|\s)mkfs(\.|\s)/i,
  /(^|\s)dd\s+if=/i,
  /(^|\s)shutdown(\s|$)/i,
  /(^|\s)reboot(\s|$)/i,
  /(^|\s)init\s+0/i,
  /(^|\s)poweroff(\s|$)/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/ // fork bomb
];

function isBlockedCommand(command) {
  return blockedPatterns.some((pattern) => pattern.test(command));
}

function isReadOnlyCommand(command) {
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

function getLastUserMessage(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === 'user' && typeof history[i]?.content === 'string') {
      return history[i].content.trim();
    }
  }
  return '';
}

function getSessionState(sessionId) {
  if (!sessionId) {
    return { lastTarget: '.', lastListing: [], lastSuggestions: [], pendingIntent: null, notes: [] };
  }
  if (!sessionMemory.has(sessionId)) {
    sessionMemory.set(sessionId, {
      lastTarget: '.',
      lastListing: [],
      lastSuggestions: [],
      pendingIntent: null,
      notes: []
    });
  }
  return sessionMemory.get(sessionId);
}

function isFilesystemIntent(text) {
  if (!text) return false;
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const keywords = [
    'archivo',
    'archivos',
    'carpeta',
    'directorio',
    'ruta',
    'mover',
    'renombrar',
    'organizar',
    'listar',
    'contenido',
    'que hay en',
    'que contiene',
    'resumen de',
    'borra',
    'elimina',
    'copia',
    'crear',
    'proyecto'
  ];

  if (keywords.some((key) => normalized.includes(key))) return true;
  if (/[./~][A-Za-z0-9._\-\/]+/.test(text)) return true;
  if (/\b[a-zA-Z0-9._-]+\/\b/.test(text)) return true;
  return false;
}

function normalizeIntentText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function wantsHiddenEntries(text) {
  const n = normalizeIntentText(text);
  return (
    n.includes('ocult') ||
    n.includes('hidden') ||
    n.includes('incluyendo ocult') ||
    n.includes('tambien ocult')
  );
}

function detectListingIntent(text) {
  const n = normalizeIntentText(text);
  if (detectSummaryIntent(text)) return null;
  const asksFolders = n.includes('carpeta') || n.includes('directorios') || n.includes('directorio');
  const asksFiles = n.includes('archivo') || n.includes('fichero');

  if (asksFolders && !asksFiles) return 'dirs';
  if (asksFiles && !asksFolders) return 'files';
  if (asksFiles && asksFolders) return 'entries';
  if (n.includes('que hay') || n.includes('que contiene') || n.includes('listar')) return 'entries';
  return null;
}

function detectSummaryIntent(text) {
  const n = normalizeIntentText(text);
  return (
    n.includes('resumen') ||
    /\bque es\b/.test(n) ||
    n.includes('de que va') ||
    n.includes('explicame') ||
    n.includes('explica')
  );
}

function detectLongSummaryRequest(text) {
  const n = normalizeIntentText(text);
  return (
    n.includes('resumen largo') ||
    n.includes('muy detallado') ||
    n.includes('detallado') ||
    n.includes('completo') ||
    n.includes('en detalle') ||
    n.includes('a fondo') ||
    n.includes('profundo')
  );
}

function buildVoiceSummary(summary, isLongRequested) {
  const raw = String(summary || '').trim();
  if (!raw) return '';
  if (isLongRequested) return raw;

  const listingMatch = raw.match(/^(Carpetas|Archivos|Elementos)\s+en\s+(.+):\n([\s\S]+)$/i);
  if (listingMatch) {
    const kind = listingMatch[1];
    const target = listingMatch[2];
    const items = listingMatch[3]
      .split('\n')
      .map((l) => l.replace(/^-+\s*/, '').trim())
      .filter(Boolean);
    const preview = items.slice(0, 5).join(', ');
    return `${kind} en ${target}: ${items.length} elementos. ${preview}${items.length > 5 ? ', y más.' : '.'}`;
  }

  const clean = raw.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= 260) return clean;
  return `${clean.slice(0, 250).replace(/[,:;.\s]+$/, '')}.`;
}

function detectTargetDeclarationIntent(text) {
  const n = normalizeIntentText(text);
  return (
    (n.includes('se llama') || n.includes('llamada') || n.includes('llamo')) &&
    (n.includes('carpeta') || n.includes('directorio') || n.includes('ruta'))
  );
}

function detectCorrectionIntent(text) {
  const n = normalizeIntentText(text);
  return (
    n.includes('me refiero') ||
    n.includes('quiero decir') ||
    n.includes('no, es') ||
    n.startsWith('es ') ||
    n.includes('esa es')
  );
}

function getOrdinalIndexFromText(text, length) {
  if (!length) return null;
  const n = normalizeIntentText(text);
  const mentionsList =
    n.includes('lista') ||
    n.includes('las que dijiste') ||
    n.includes('las que has dicho') ||
    n.includes('las carpetas que dijiste') ||
    /^(la|el)?\s*(primera|primero|segunda|segundo|tercera|tercero|ultima|última|\d+)\s*$/.test(n.trim());
  if (!mentionsList) return null;
  if (n.includes('ultima') || n.includes('ultimo')) return length - 1;
  if (n.includes('primera') || n.includes('primero')) return 0;
  if (n.includes('segunda') || n.includes('segundo')) return Math.min(1, length - 1);
  if (n.includes('tercera') || n.includes('tercero')) return Math.min(2, length - 1);

  const numberMatch = n.match(/\b(\d{1,2})\b/);
  if (numberMatch) {
    const pos = Number(numberMatch[1]) - 1;
    if (Number.isFinite(pos) && pos >= 0 && pos < length) return pos;
  }
  return null;
}

function isOrdinalSelectionUtterance(text) {
  const n = normalizeIntentText(text).trim();
  return /^(la|el)?\s*(primera|primero|segunda|segundo|tercera|tercero|ultima|última|\d+)\s*$/.test(n);
}

function getSuggestionOrdinalIndex(text, length) {
  if (!length) return null;
  const n = normalizeIntentText(text);
  const wantsSuggestedOption =
    n.includes('opcion') ||
    n.includes('de las opciones') ||
    n.includes('de esas') ||
    n.includes('de esas opciones') ||
    n.includes('la primera') ||
    n.includes('la segunda') ||
    n.includes('la tercera') ||
    n.includes('la ultima') ||
    n.includes('la última');
  if (!wantsSuggestedOption) return null;

  if (n.includes('ultima') || n.includes('última')) return length - 1;
  if (n.includes('primera')) return 0;
  if (n.includes('segunda')) return Math.min(1, length - 1);
  if (n.includes('tercera')) return Math.min(2, length - 1);

  const numberMatch = n.match(/\b([1-9])\b/);
  if (numberMatch) {
    const pos = Number(numberMatch[1]) - 1;
    if (pos >= 0 && pos < length) return pos;
  }
  return null;
}

function hasRecentExecutionEvidence(history) {
  const recent = history.slice(-6);
  return recent.some((msg) => {
    if (msg?.role !== 'assistant' || typeof msg?.content !== 'string') return false;
    return msg.content.includes('STDOUT:') || msg.content.includes('Comando:');
  });
}

function quoteForShell(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function normalizeVoiceAlias(value) {
  let v = normalizeText(value);
  v = v
    .replace(/guion/g, '')
    .replace(/espacio/g, '')
    .replace(/deletrear/g, '')
    .replace(/vocapp/g, 'vocapp')
    .replace(/vokapp/g, 'vocapp')
    .replace(/bocapp/g, 'vocapp')
    .replace(/bocap/g, 'vocapp')
    .replace(/bocaapp/g, 'vocapp')
    .replace(/bobapp/g, 'vocapp')
    .replace(/boapp/g, 'vocapp');
  return v;
}

function levenshtein(a, b) {
  if (!a) return b.length;
  if (!b) return a.length;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function listWorkdirEntries() {
  try {
    return readdirSync(EXEC_WORKDIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isFile())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function listWorkdirDirectories() {
  try {
    return readdirSync(EXEC_WORKDIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function phoneticKey(value) {
  let v = normalizeVoiceAlias(value);
  v = v
    .replace(/guion/g, '')
    .replace(/espacio/g, '')
    .replace(/gu/g, 'g')
    .replace(/v/g, 'b')
    .replace(/q/g, 'k')
    .replace(/c/g, 'k')
    .replace(/z/g, 's')
    .replace(/h/g, '')
    .replace(/pp/g, 'p')
    .replace(/ll/g, 'y')
    .replace(/[^a-z0-9]/g, '');
  return v;
}

function extractSpelledCandidate(text) {
  const n = normalizeIntentText(text);
  const directVoc = n.match(/\b(?:v|uve)\s+(?:o)\s+(?:c|ce)\s+app\b/i);
  if (directVoc) return 'vocapp';

  const spacedLetters = n.match(/\b([a-z])\s+([a-z])\s+([a-z])(?:\s+([a-z]))?\s+app\b/i);
  if (spacedLetters) {
    const letters = [spacedLetters[1], spacedLetters[2], spacedLetters[3], spacedLetters[4]]
      .filter(Boolean)
      .join('');
    return `${letters}app`;
  }

  const rough = n.match(/\b([a-z]{2,8}\s*app)\b/i);
  if (rough) return rough[1].replace(/\s+/g, '');
  return null;
}

function resolveTargetInWorkdir(rawCandidate, userText) {
  const entries = listWorkdirEntries();
  if (!entries.length) return rawCandidate || null;

  if (rawCandidate) {
    if (existsSync(join(EXEC_WORKDIR, rawCandidate))) {
      return rawCandidate;
    }
    const baseCandidate = rawCandidate.replace(/\/+$/, '');
    if (existsSync(join(EXEC_WORKDIR, baseCandidate))) {
      return baseCandidate;
    }
  }

  const probes = [rawCandidate, userText]
    .map((v) => normalizeText(v))
    .filter((v) => v.length >= 4);
  if (!probes.length) return rawCandidate || null;

  let best = null;
  for (const entry of entries) {
    const nEntry = normalizeText(entry);
    if (!nEntry) continue;

    for (const probe of probes) {
      let score;
      if (probe.includes(nEntry) || nEntry.includes(probe)) {
        score = Math.abs(probe.length - nEntry.length) / Math.max(probe.length, nEntry.length);
      } else {
        score = levenshtein(probe, nEntry) / Math.max(probe.length, nEntry.length);
      }

      if (!best || score < best.score) {
        best = { entry, score };
      }
    }
  }

  if (best && best.score <= 0.42) {
    return best.entry;
  }
  return null;
}

function extractTargetFromText(text) {
  if (!text) return null;

  const spelled = extractSpelledCandidate(text);
  if (spelled) return spelled;

  const quoted = text.match(/["'`](.{1,140}?)["'`]/);
  if (quoted?.[1]) return quoted[1].trim();

  const patternMatches = [
    text.match(/se llama\s+([A-Za-z0-9._\-~/ ]{2,80}?)(?:[?.,;]|$)/i),
    text.match(
      /(?:carpeta|directorio|proyecto)\s+([A-Za-z0-9._\-~/ ]{2,120}?)(?:[?.,;]|$)/i
    ),
    text.match(
      /(?:resumen de|que hay en|que contiene|contenido de|sobre|carpeta|directorio|proyecto)\s+([A-Za-z0-9._\-~/]+\/?)/i
    ),
    text.match(/\b([A-Za-z0-9._\-~]+\/[A-Za-z0-9._\-~/]*)\b/)
  ];

  for (const match of patternMatches) {
    if (match?.[1]) {
      const candidate = match[1].trim().replace(/\s+/g, ' ').replace(/\/+$/, '');
      const lowered = candidate.toLowerCase();
      const wordCount = candidate.split(' ').filter(Boolean).length;
      if (
        candidate.length >= 3 &&
        wordCount <= 5 &&
        ![
          'archivo',
          'carpeta',
          'directorio',
          'proyecto',
          'esta',
          'estas',
          'est',
          'es',
          'que',
          'de',
          'la',
          'el'
        ].includes(lowered)
      ) {
        return candidate;
      }
    }
  }

  return null;
}

function referencesPreviousTarget(text) {
  const n = normalizeIntentText(text);
  return (
    n.includes('esa carpeta') ||
    n.includes('ese directorio') ||
    n.includes('ese proyecto') ||
    n.includes('este proyecto') ||
    n.includes('esta carpeta') ||
    n.includes('este directorio') ||
    n.includes('esa ruta') ||
    n.includes('esta ruta') ||
    n.includes('ahi') ||
    n.includes('alli') ||
    n.includes('anterior')
  );
}

function chooseClosestCandidate(text, candidates) {
  const raw = normalizeIntentText(text);
  const stopwords = new Set([
    'la',
    'el',
    'de',
    'del',
    'que',
    'quiero',
    'resumen',
    'carpeta',
    'directorio',
    'ruta',
    'me',
    'refiero',
    'es',
    'una',
    'un',
    'por',
    'favor',
    'app'
  ]);
  const tokenProbes = raw
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stopwords.has(t));
  const probes = [...new Set([normalizeVoiceAlias(text), ...tokenProbes.map((t) => normalizeVoiceAlias(t))])].filter(
    (p) => p.length >= 3
  );
  if (!probes.length) return null;

  let best = null;
  for (const candidate of candidates) {
    const n = normalizeVoiceAlias(candidate);
    const nPh = phoneticKey(candidate);
    if (!n) continue;
    for (const probe of probes) {
      const probePh = phoneticKey(probe);
      let score;
      if (probe.includes(n) || n.includes(probe)) {
        score = Math.abs(probe.length - n.length) / Math.max(probe.length, n.length);
      } else if (probePh && nPh && (probePh.includes(nPh) || nPh.includes(probePh))) {
        score = Math.abs(probePh.length - nPh.length) / Math.max(probePh.length, nPh.length);
      } else if (probePh && nPh) {
        score = Math.min(
          levenshtein(probe, n) / Math.max(probe.length, n.length),
          levenshtein(probePh, nPh) / Math.max(probePh.length, nPh.length)
        );
      } else {
        score = levenshtein(probe, n) / Math.max(probe.length, n.length);
      }
      if (!best || score < best.score) {
        best = { candidate, score };
      }
    }
  }
  return best && best.score <= 0.36 ? best.candidate : null;
}

function resolveTargetFromContext({ userText, extractedTarget, memory }) {
  if (referencesPreviousTarget(userText) && memory?.lastTarget && memory.lastTarget !== '.') {
    return memory.lastTarget;
  }

  const direct = resolveTargetInWorkdir(extractedTarget, userText);
  if (direct && existsSync(join(EXEC_WORKDIR, direct))) {
    return direct;
  }

  const candidates = [...new Set([...(memory?.lastListing || []), ...listWorkdirDirectories()])];
  const fromExtracted = extractedTarget ? chooseClosestCandidate(extractedTarget, candidates) : null;
  if (fromExtracted) return fromExtracted;

  const fromFullText = chooseClosestCandidate(userText, candidates);
  if (fromFullText) return fromFullText;

  return direct || null;
}

function suggestTargets(userText, memory) {
  const pool = [...new Set([...(memory?.lastListing || []), ...listWorkdirDirectories()])];
  const probe = normalizeVoiceAlias(extractedTargetFromPrompt(userText) || userText);
  if (!probe) return [];

  const scored = pool
    .map((name) => {
      const n = normalizeText(name);
      if (!n) return null;
      const score = Math.min(
        levenshtein(probe, normalizeVoiceAlias(n)) / Math.max(probe.length, normalizeVoiceAlias(n).length || 1),
        levenshtein(phoneticKey(probe), phoneticKey(n)) /
          Math.max(phoneticKey(probe).length || 1, phoneticKey(n).length || 1)
      );
      return { name, score };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);

  return scored.map((s) => s.name);
}

function extractedTargetFromPrompt(text) {
  return extractTargetFromText(text) || '';
}

function buildGroundingCommand(userText, preferredTarget = null) {
  const extractedTarget = extractTargetFromText(userText);
  const target = preferredTarget || resolveTargetInWorkdir(extractedTarget, userText);
  if (target) {
    const safeTarget = quoteForShell(target);
    return (
      `if [ -e ${safeTarget} ]; then ` +
      `echo "INSPECCION: ${target}"; ls -la ${safeTarget}; ` +
      `echo "---DETALLE (max 200)---"; find ${safeTarget} -maxdepth 2 -mindepth 1 -print | head -n 200; ` +
      `else echo "No existe: ${target}"; echo "---PWD---"; pwd; echo "---LS---"; ls -la; fi`
    );
  }
  return 'pwd && ls -la && echo "---DETALLE (max 200)---" && find . -maxdepth 2 -mindepth 1 -print | head -n 200';
}

function buildListingCommand({ listingIntent, target, includeHidden }) {
  const safeTarget = quoteForShell(target || '.');
  const typePart = listingIntent === 'dirs' ? ' -type d' : listingIntent === 'files' ? ' -type f' : '';
  const hiddenPart = includeHidden ? '' : " ! -name '.*'";
  return (
    `if [ -d ${safeTarget} ]; then ` +
    `find ${safeTarget} -maxdepth 1 -mindepth 1${typePart}${hiddenPart} -printf '%f\\n' | sort -f; ` +
    `else echo "No existe directorio: ${target || '.'}"; fi`
  );
}

function buildListingSummary({ listingIntent, includeHidden, target, stdout, stderr }) {
  if (stderr?.trim()) {
    return `No pude listar correctamente ${target}. Error: ${stderr.trim()}`;
  }

  const rawLines = String(stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (rawLines[0]?.startsWith('No existe directorio:')) {
    return rawLines[0];
  }

  const label =
    listingIntent === 'dirs'
      ? 'Carpetas'
      : listingIntent === 'files'
        ? 'Archivos'
        : 'Elementos';
  const hiddenLabel = includeHidden ? 'incluyendo ocultos' : 'sin ocultos';

  if (!rawLines.length) {
    return `${label} en ${target} (${hiddenLabel}): no se encontraron resultados.`;
  }

  const bulletList = rawLines.map((name) => `- ${name}`).join('\n');
  return `${label} en ${target} (${hiddenLabel}):\n${bulletList}`;
}

function prepareCommandResponse(command, message) {
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

function executeCommand(command) {
  return new Promise((resolve) => {
    exec(command, { timeout: EXEC_TIMEOUT_MS, shell: EXEC_SHELL, cwd: EXEC_WORKDIR }, (error, stdout, stderr) => {
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
          error: error.message
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

function isHiddenName(name) {
  return String(name || '').startsWith('.');
}

function safeResolveTarget(target) {
  const candidate = target && String(target).trim() ? String(target).trim() : '.';
  const abs = resolve(EXEC_WORKDIR, candidate);
  const rel = relative(EXEC_WORKDIR, abs);
  if (rel.startsWith('..')) return null;
  return abs;
}

function runInternalListing({ target = '.', listingIntent = 'entries', includeHidden = false }) {
  try {
    const abs = safeResolveTarget(target);
    if (!abs || !existsSync(abs)) {
      return {
        ok: true,
        command: `internal:list ${listingIntent} ${target}`,
        cwd: EXEC_WORKDIR,
        stdout: `No existe directorio: ${target}\n`,
        stderr: ''
      };
    }

    const dirents = readdirSync(abs, { withFileTypes: true });
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

function walkEntries(base, maxDepth, includeHidden) {
  const out = [];
  function walk(current, depth) {
    if (depth > maxDepth) return;
    let dirents = [];
    try {
      dirents = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (!includeHidden && isHiddenName(d.name)) continue;
      const full = join(current, d.name);
      const rel = relative(EXEC_WORKDIR, full).replace(/\\/g, '/');
      out.push(rel);
      if (d.isDirectory()) walk(full, depth + 1);
    }
  }
  walk(base, 2);
  return out;
}

function runInternalInspection({ target = '.', includeHidden = true, maxItems = 200 }) {
  try {
    const abs = safeResolveTarget(target);
    if (!abs || !existsSync(abs)) {
      return {
        ok: true,
        command: `internal:inspect ${target}`,
        cwd: EXEC_WORKDIR,
        stdout: `No existe: ${target}\n---PWD---\n${EXEC_WORKDIR}\n`,
        stderr: ''
      };
    }

    const header = [`INSPECCION: ${target}`];
    const top = readdirSync(abs, { withFileTypes: true })
      .filter((d) => includeHidden || !isHiddenName(d.name))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    header.push(...top);
    header.push('---DETALLE (max 200)---');

    const details = walkEntries(abs, 2, includeHidden).slice(0, maxItems);
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

function runShellCommand(command, timeoutMs = 120000) {
  return new Promise((resolve) => {
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

function isValidModelName(model) {
  return typeof model === 'string' && /^[a-zA-Z0-9_.:-]{2,80}$/.test(model);
}

async function checkOllamaReachable() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

async function getInstalledModelsFromOllama() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { method: 'GET' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.models) ? data.models.map((m) => String(m?.name || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizeModelAliases(model) {
  if (!model) return [];
  const v = String(model).trim();
  if (!v) return [];
  if (v.includes(':')) {
    const [base] = v.split(':');
    return [v, base].filter(Boolean);
  }
  return [v, `${v}:latest`];
}

async function setupStatus() {
  const ollamaVersion = await runShellCommand('ollama --version', 15000);
  const ollamaInstalled = ollamaVersion.ok;
  const ollamaReachable = ollamaInstalled ? await checkOllamaReachable() : false;
  const installedModels = ollamaReachable ? await getInstalledModelsFromOllama() : [];
  const aliases = normalizeModelAliases(OLLAMA_MODEL);
  const modelInstalled = aliases.some((alias) => installedModels.includes(alias));

  return {
    platform: process.platform,
    model: OLLAMA_MODEL,
    ollamaInstalled,
    ollamaReachable,
    modelInstalled,
    installedModels,
    canAutoInstallOllama: process.platform === 'win32',
    suggestedActions: {
      installOllama: !ollamaInstalled,
      startOllama: ollamaInstalled && !ollamaReachable,
      pullModel: ollamaInstalled && ollamaReachable && !modelInstalled
    }
  };
}

async function askModel(history, lastUserMessage, memoryContext = '') {
  const system = {
    role: 'system',
    content:
      'Eres un agente local de PC. Responde SIEMPRE en JSON válido con esta forma exacta: ' +
      '{"type":"reply","message":"..."} o {"type":"command","message":"...","command":"..."}. ' +
      'Usa "reply" cuando no haga falta terminal. Usa "command" cuando deba ejecutarse algo en shell. ' +
      'El comando debe ser una sola línea de bash. No expliques fuera del JSON. ' +
      `Tu directorio de trabajo actual es: ${EXEC_WORKDIR}. ` +
      'Regla crítica: Nunca inventes contenido de archivos/carpetas. Si te piden datos del sistema de archivos, primero inspecciona con comando. ' +
      (memoryContext ? `Memoria de sesion:\n${memoryContext}` : '')
  };

  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [system, ...history, { role: 'user', content: `Ultima solicitud: ${lastUserMessage}` }],
      stream: false,
      options: {
        temperature: 0.2
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const content = data?.message?.content?.trim() || '';

  function parseModelJson(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      // Try to recover the largest JSON-like object from noisy text.
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const slice = cleaned.slice(start, end + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  try {
    const parsed = parseModelJson(content);
    if (parsed?.type && parsed?.message) {
      return parsed;
    }
    if (parsed?.message && parsed?.command) {
      return { type: 'command', message: String(parsed.message), command: String(parsed.command) };
    }
    if (parsed?.message) {
      return { type: 'reply', message: String(parsed.message) };
    }
    if (parsed?.command) {
      return { type: 'command', message: 'Ejecutar comando propuesto.', command: String(parsed.command) };
    }
    throw new Error('JSON incompleto');
  } catch {
    if (content) {
      // If it came as plain text, still return text instead of hard-failing parse.
      return { type: 'reply', message: content };
    }
    return { type: 'reply', message: 'No te entendi bien.' };
  }
}

function trimForPrompt(text, maxLen = 12000) {
  const value = String(text || '');
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}\n...[truncado ${value.length - maxLen} caracteres]`;
}

function compactHistoryForModel(history) {
  const raw = Array.isArray(history) ? history : [];
  const recent = raw.slice(-14);

  return recent
    .map((msg) => {
      const role = msg?.role === 'assistant' || msg?.role === 'user' || msg?.role === 'system' ? msg.role : null;
      if (!role) return null;
      let content = String(msg?.content || '');

      if (role === 'assistant' && (content.includes('STDOUT:') || content.includes('Detalles tecnicos'))) {
        const commandLine = content.split('\n').find((line) => line.startsWith('Comando:')) || 'Comando ejecutado.';
        content = `${commandLine} [salida tecnica omitida para mantener velocidad]`;
      }

      if (content.length > 1400) {
        content = `${content.slice(0, 1400)}\n...[recortado]`;
      }

      return { role, content };
    })
    .filter(Boolean);
}

function buildDeterministicInspectionSummary(target, stdout) {
  const text = String(stdout || '');
  const marker = `INSPECCION: ${target}`;
  if (!text.includes(marker)) return '';

  const detailSplit = text.split('---DETALLE');
  const detailSection = detailSplit.length > 1 ? detailSplit[1] : '';
  const detailLines = detailSection
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && s.startsWith(`${target}/`));

  const topLevel = new Set();
  for (const line of detailLines) {
    const rest = line.slice(`${target}/`.length);
    const first = rest.split('/')[0];
    if (first) topLevel.add(first);
  }

  const sample = Array.from(topLevel).slice(0, 8);
  const sampleText = sample.length ? ` Ejemplos: ${sample.join(', ')}.` : '';
  return `La carpeta ${target} existe y se inspecciono correctamente. Se detectaron ${topLevel.size} elementos de primer nivel.${sampleText}`;
}

async function summarizeExecution(lastUserMessage, execution, options = {}) {
  const target = options?.target || '';
  const system = {
    role: 'system',
    content:
      'Eres un asistente de sistema de archivos. Resume SOLO usando la evidencia dada. ' +
      'No inventes nada. Si no hay evidencia suficiente, dilo claramente. ' +
      'Responde en espanol de forma breve. Prioriza explicar de que trata el proyecto (proposito), ' +
      'y luego menciona 3-6 componentes clave.'
  };

  const user = {
    role: 'user',
    content: [
      `Solicitud original: ${lastUserMessage || '(sin solicitud)'}`,
      target ? `Objetivo confirmado: ${target}` : '',
      `Comando ejecutado: ${execution.command}`,
      `Directorio de ejecucion: ${execution.cwd}`,
      `OK: ${execution.ok}`,
      execution.error ? `Error: ${execution.error}` : '',
      `STDOUT:\n${trimForPrompt(execution.stdout)}`,
      `STDERR:\n${trimForPrompt(execution.stderr)}`
    ]
      .filter(Boolean)
      .join('\n\n')
  };

  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [system, user],
      stream: false,
      options: {
        temperature: 0.1
      }
    })
  });

  if (!response.ok) {
    return '';
  }

  const data = await response.json();
  let summary = String(data?.message?.content || '').trim();

  if (target) {
    const low = summary.toLowerCase();
    const lowTarget = target.toLowerCase();
    const contradicts =
      (low.includes('no hay evidencia') || low.includes('no existe')) && !low.includes(lowTarget);
    if (contradicts) {
      const deterministic = buildDeterministicInspectionSummary(target, execution.stdout);
      if (deterministic) summary = deterministic;
    }
  }

  return summary;
}

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
      cmd = 'start "" ollama app';
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
    const result = await runShellCommand(cmd, 6 * 60 * 60 * 1000);
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

app.post('/api/chat', async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || 'default');
    const memory = getSessionState(sessionId);
    const history = compactHistoryForModel(req.body?.history);
    const lastUserMessage = getLastUserMessage(history);
    const fsIntent = isFilesystemIntent(lastUserMessage);
    const hasEvidence = hasRecentExecutionEvidence(history);
    const listingIntent = detectListingIntent(lastUserMessage);
    const summaryIntent = detectSummaryIntent(lastUserMessage);
    const longSummaryRequested = detectLongSummaryRequest(lastUserMessage);
    const declarationIntent = detectTargetDeclarationIntent(lastUserMessage);
    const correctionIntent = detectCorrectionIntent(lastUserMessage);
    const extractedTarget = extractTargetFromText(lastUserMessage);
    let resolvedTargetFromContext = resolveTargetFromContext({
      userText: lastUserMessage,
      extractedTarget,
      memory
    });
    if (!resolvedTargetFromContext && referencesPreviousTarget(lastUserMessage) && memory.lastTarget && memory.lastTarget !== '.') {
      resolvedTargetFromContext = memory.lastTarget;
    }
    const ordinalIndex = getOrdinalIndexFromText(lastUserMessage, memory.lastListing.length);
    const ordinalTarget =
      ordinalIndex !== null && memory.lastListing[ordinalIndex] ? memory.lastListing[ordinalIndex] : null;
    const suggestionOrdinalIndex = getSuggestionOrdinalIndex(lastUserMessage, memory.lastSuggestions.length);
    const suggestionTarget =
      suggestionOrdinalIndex !== null && memory.lastSuggestions[suggestionOrdinalIndex]
        ? memory.lastSuggestions[suggestionOrdinalIndex]
        : null;

    if (suggestionTarget) {
      memory.lastTarget = suggestionTarget;
      memory.lastSuggestions = [];
      memory.notes = [`Ultimo objetivo: ${memory.lastTarget}`];
      if (memory.pendingIntent === 'summary') {
        const execution = runInternalInspection({ target: memory.lastTarget, includeHidden: true });
        const summary = AUTO_SUMMARIZE_READS
          ? await summarizeExecution(lastUserMessage, execution, { target: memory.lastTarget })
          : '';
        memory.pendingIntent = null;
      return res.json({
        type: 'executed',
        autoApproved: true,
        message: `Seleccioné ${memory.lastTarget} (opcion ${suggestionOrdinalIndex + 1}) y generé el resumen.`,
        summary,
        voiceSummary: buildVoiceSummary(summary, longSummaryRequested),
        ...execution
      });
      }
      memory.pendingIntent = null;
      return res.json({
        type: 'reply',
        message: `Perfecto, elijo ${memory.lastTarget} (opcion ${suggestionOrdinalIndex + 1}).`
      });
    }

    if (
      ordinalTarget &&
      (summaryIntent ||
        correctionIntent ||
        referencesPreviousTarget(lastUserMessage) ||
        isOrdinalSelectionUtterance(lastUserMessage))
    ) {
      memory.lastTarget = ordinalTarget;
      memory.lastSuggestions = [];
      memory.notes = [`Ultimo objetivo: ${memory.lastTarget}`];
      memory.pendingIntent = null;
      return res.json({
        type: 'reply',
        message: `Perfecto, tomo ${memory.lastTarget} como carpeta objetivo. Dime si quieres un resumen o listar su contenido.`
      });
    }

    if (declarationIntent) {
      if (resolvedTargetFromContext) {
        memory.lastTarget = resolvedTargetFromContext;
        memory.lastSuggestions = [];
        memory.notes = [`Ultimo objetivo: ${memory.lastTarget}`];
        memory.pendingIntent = null;
        return res.json({
          type: 'reply',
          message: `Perfecto, tomo ${memory.lastTarget} como carpeta objetivo para los siguientes pasos.`
        });
      }
      const suggestions = suggestTargets(lastUserMessage, memory);
      const hint = suggestions.length
        ? `No identifique ese nombre con certeza. ¿Te refieres a: ${suggestions.join(', ')}?`
        : 'No identifique ese nombre con certeza. Dime el nombre exacto de la carpeta.';
      memory.lastSuggestions = suggestions;
      memory.pendingIntent = 'set_target';
      return res.json({ type: 'reply', message: hint });
    }

    if (correctionIntent && resolvedTargetFromContext) {
      memory.lastTarget = resolvedTargetFromContext;
      memory.lastSuggestions = [];
      memory.notes = [`Ultimo objetivo: ${memory.lastTarget}`];
      memory.pendingIntent = null;
      return res.json({
        type: 'reply',
        message: `Entendido, te refieres a ${memory.lastTarget}.`
      });
    }

    if (summaryIntent) {
      if (!resolvedTargetFromContext && memory.lastTarget && memory.lastTarget !== '.') {
        resolvedTargetFromContext = memory.lastTarget;
      }
      if (!resolvedTargetFromContext) {
        const suggestions = suggestTargets(lastUserMessage, memory);
        const hint = suggestions.length
          ? `No identifique la carpeta exacta. ¿Te refieres a: ${suggestions.join(', ')}?`
          : 'No identifique la carpeta exacta. Dime el nombre exacto o deletrealo.';
        memory.lastSuggestions = suggestions;
        memory.pendingIntent = 'summary';
        return res.json({ type: 'reply', message: hint });
      }

      const execution = runInternalInspection({ target: resolvedTargetFromContext, includeHidden: true });
      const summary = AUTO_SUMMARIZE_READS
        ? await summarizeExecution(lastUserMessage, execution, { target: resolvedTargetFromContext })
        : '';
      if (execution.ok) {
        memory.lastTarget = resolvedTargetFromContext;
        memory.notes = [`Ultimo objetivo: ${memory.lastTarget}`];
      }
      memory.pendingIntent = null;
      return res.json({
        type: 'executed',
        autoApproved: true,
        message: 'Inspeccion de carpeta objetivo para resumen.',
        summary,
        voiceSummary: buildVoiceSummary(summary, longSummaryRequested),
        ...execution
      });
    }

    if (listingIntent) {
      const fallbackTarget = referencesPreviousTarget(lastUserMessage) ? memory.lastTarget : '.';
      const resolvedTarget = resolvedTargetFromContext || fallbackTarget;
      const includeHidden = wantsHiddenEntries(lastUserMessage);
      const execution = runInternalListing({
        listingIntent,
        target: resolvedTarget,
        includeHidden
      });
      const summary = buildListingSummary({
        listingIntent,
        includeHidden,
        target: resolvedTarget,
        stdout: execution.stdout,
        stderr: execution.stderr
      });
      if (execution.ok) {
        memory.lastTarget = resolvedTarget;
        memory.lastSuggestions = [];
        memory.lastListing = String(execution.stdout || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 80);
        memory.notes = [
          `Ultimo objetivo: ${memory.lastTarget}`,
          `Ultimo listado (${memory.lastListing.length} elementos): ${memory.lastListing.slice(0, 12).join(', ')}`
        ];
      }
      memory.pendingIntent = null;

      return res.json({
        type: 'executed',
        autoApproved: true,
        message: 'Listado directo del sistema de archivos.',
        summary,
        voiceSummary: buildVoiceSummary(summary, longSummaryRequested),
        ...execution
      });
    }

    const memoryContext = memory.notes.join('\n');
    const result = await askModel(history, lastUserMessage, memoryContext);

    if (result.type === 'reply' && (result.message === 'No te entendi bien.' || result.message.includes('No pude interpretar'))) {
      const suggestions = suggestTargets(lastUserMessage, memory);
      const hint = suggestions.length
        ? `No te entendí bien. ¿Te refieres a: ${suggestions.join(', ')}?`
        : 'No te entendí bien. Repite la frase o dime el nombre exacto de la carpeta.';
      return res.json({ type: 'reply', message: hint });
    }

    if (STRICT_GROUNDED_FS && fsIntent && !hasEvidence && result.type !== 'command') {
      const fallbackTarget = resolvedTargetFromContext || '.';
      if (AUTO_EXEC_READONLY) {
        const execution = runInternalInspection({ target: fallbackTarget, includeHidden: true });
        const summary = AUTO_SUMMARIZE_READS ? await summarizeExecution(lastUserMessage, execution) : '';
        return res.json({
          type: 'executed',
          autoApproved: true,
          message:
            'Para responder con precisión inspeccioné primero el sistema de archivos y aquí tienes el resultado.',
          summary,
          voiceSummary: buildVoiceSummary(summary, longSummaryRequested),
          ...execution
        });
      }
      const groundingCommand = buildGroundingCommand(lastUserMessage, resolvedTargetFromContext);
      return res.json(
        prepareCommandResponse(
          groundingCommand,
          'Para responder con precisión necesito inspeccionar primero el sistema de archivos. Te propongo este comando de inspección.'
        )
      );
    }

    if (result.type === 'command' && typeof result.command === 'string') {
      const command = result.command.trim();
      if (!command) {
        return res.json({ type: 'reply', message: 'No se recibió comando para ejecutar.' });
      }
      if (isBlockedCommand(command)) {
        return res.json({
          type: 'reply',
          message: `Bloqueé ese comando por seguridad: ${command}`
        });
      }

      if (AUTO_EXEC_READONLY && isReadOnlyCommand(command)) {
        const execution = await executeCommand(command);
        const summary = AUTO_SUMMARIZE_READS ? await summarizeExecution(lastUserMessage, execution) : '';
        if (execution.ok) {
          const extractedTarget = extractTargetFromText(lastUserMessage);
          const resolvedTarget = resolveTargetInWorkdir(extractedTarget, lastUserMessage);
          if (resolvedTarget) {
            memory.lastTarget = resolvedTarget;
          }
          memory.lastSuggestions = [];
          memory.notes = [`Ultimo objetivo: ${memory.lastTarget}`];
        }
        return res.json({
          type: 'executed',
          autoApproved: true,
          message: result.message,
          summary,
          voiceSummary: buildVoiceSummary(summary, longSummaryRequested),
          ...execution
        });
      }

      return res.json(prepareCommandResponse(command, result.message));
    }

    return res.json({
      type: 'reply',
      message: String(result.message)
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || 'Error inesperado en /api/chat'
    });
  }
});

app.post('/api/execute', async (req, res) => {
  const token = req.body?.token;
  if (!token || !pendingCommands.has(token)) {
    return res.status(400).json({ error: 'Token inválido o expirado.' });
  }

  const pending = pendingCommands.get(token);
  pendingCommands.delete(token);
  const response = await executeCommand(pending.command);
  return res.status(200).json(response);
});

app.post('/api/reject', (req, res) => {
  const token = req.body?.token;
  if (token) {
    pendingCommands.delete(token);
  }
  res.json({ ok: true });
});

setInterval(() => {
  const now = Date.now();
  for (const [token, item] of pendingCommands.entries()) {
    if (now - item.createdAt > 5 * 60 * 1000) {
      pendingCommands.delete(token);
    }
  }
}, 60 * 1000);

app.listen(PORT, () => {
  console.log(`voice-pc-agent en http://localhost:${PORT}`);
  console.log(`Modelo: ${OLLAMA_MODEL}`);
  console.log(`Directorio de ejecucion: ${EXEC_WORKDIR}`);
  console.log(`Modo filesystem blindado: ${STRICT_GROUNDED_FS ? 'ON' : 'OFF'}`);
  console.log(`Auto-ejecucion lectura: ${AUTO_EXEC_READONLY ? 'ON' : 'OFF'}`);
  console.log(`Auto-resumen lectura: ${AUTO_SUMMARIZE_READS ? 'ON' : 'OFF'}`);
});

setInterval(() => {
  // Lightweight cleanup to avoid unbounded memory growth.
  if (sessionMemory.size > 200) {
    const keep = Array.from(sessionMemory.entries()).slice(-120);
    sessionMemory.clear();
    for (const [k, v] of keep) {
      sessionMemory.set(k, v);
    }
  }
}, 10 * 60 * 1000);
