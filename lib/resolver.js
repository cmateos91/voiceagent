// resolver: Extrae y resuelve objetivos de rutas desde lenguaje natural con reglas y fuzzy matching.
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { EXEC_WORKDIR } from './config.js';
import { normalizeIntentText } from './intent.js';
import { listWorkdirDirectories, listWorkdirEntries } from './filesystem.js';

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function normalizeVoiceAlias(value) {
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

export function levenshtein(a, b) {
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

export function phoneticKey(value) {
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

export function extractSpelledCandidate(text) {
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

export async function resolveTargetInWorkdir(rawCandidate, userText) {
  const entries = await listWorkdirEntries();
  if (!entries.length) return rawCandidate || null;

  if (rawCandidate) {
    try {
      await access(join(EXEC_WORKDIR, rawCandidate));
      return rawCandidate;
    } catch {
      // Continue checking normalized candidate.
    }
    const baseCandidate = rawCandidate.replace(/\/+$/, '');
    try {
      await access(join(EXEC_WORKDIR, baseCandidate));
      return baseCandidate;
    } catch {
      // Continue with fuzzy resolution.
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

export function extractTargetFromText(text) {
  if (!text) return null;

  const spelled = extractSpelledCandidate(text);
  if (spelled) return spelled;

  const quoted = text.match(/["'`](.{1,140}?)["'`]/);
  if (quoted?.[1]) return quoted[1].trim();

  const patternMatches = [
    text.match(/se llama\s+([A-Za-z0-9._\-~/ ]{2,80}?)(?:[?.,;]|$)/i),
    text.match(/(?:carpeta|directorio|proyecto)\s+([A-Za-z0-9._\-~/ ]{2,120}?)(?:[?.,;]|$)/i),
    text.match(/(?:resumen de|que hay en|que contiene|contenido de|sobre|carpeta|directorio|proyecto)\s+([A-Za-z0-9._\-~/]+\/?)/i),
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

export function referencesPreviousTarget(text) {
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

export function chooseClosestCandidate(text, candidates) {
  const queryWords = String(text || '')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 3);
  const containsMatch = candidates.find((candidate) =>
    queryWords.some((w) => String(candidate || '').toLowerCase().includes(w))
  );
  if (containsMatch) return containsMatch;

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

export async function resolveTargetFromContext({ userText, extractedTarget, memory }) {
  if (referencesPreviousTarget(userText) && memory?.lastTarget && memory.lastTarget !== '.') {
    return memory.lastTarget;
  }

  const direct = await resolveTargetInWorkdir(extractedTarget, userText);
  if (direct) {
    try {
      await access(join(EXEC_WORKDIR, direct));
      return direct;
    } catch {
      // Keep resolving from candidates.
    }
  }

  const workdirDirs = await listWorkdirDirectories();
  const candidates = [...new Set([...(memory?.lastListing || []), ...workdirDirs])];
  const fromExtracted = extractedTarget ? chooseClosestCandidate(extractedTarget, candidates) : null;
  if (fromExtracted) return fromExtracted;

  const fromFullText = chooseClosestCandidate(userText, candidates);
  if (fromFullText) return fromFullText;

  return direct || null;
}

export async function suggestTargets(userText, memory) {
  const workdirDirs = await listWorkdirDirectories();
  const pool = [...new Set([...(memory?.lastListing || []), ...workdirDirs])];
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

export function extractedTargetFromPrompt(text) {
  return extractTargetFromText(text) || '';
}

export function getOrdinalIndexFromText(text, length) {
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

export function isOrdinalSelectionUtterance(text) {
  const n = normalizeIntentText(text).trim();
  return /^(la|el)?\s*(primera|primero|segunda|segundo|tercera|tercero|ultima|última|\d+)\s*$/.test(n);
}

export function getSuggestionOrdinalIndex(text, length) {
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
