// intent: Detecta intención conversacional de archivos/resumen y genera texto de voz resumido.

export function normalizeIntentText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function isFilesystemIntent(text) {
  if (!text) return false;
  const normalized = normalizeIntentText(text);

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

export function wantsHiddenEntries(text) {
  const n = normalizeIntentText(text);
  return n.includes('ocult') || n.includes('hidden') || n.includes('incluyendo ocult') || n.includes('tambien ocult');
}

export function detectListingIntent(text) {
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

export function detectSummaryIntent(text) {
  const n = normalizeIntentText(text);
  return (
    n.includes('resumen') ||
    n.includes('resumeme') ||
    n.includes('resumir') ||
    /\bque es\b/.test(n) ||
    n.includes('de que va') ||
    n.includes('explicame') ||
    n.includes('explica')
  );
}

export function detectLongSummaryRequest(text) {
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

export function detectTargetDeclarationIntent(text) {
  const n = normalizeIntentText(text);
  return (
    (n.includes('se llama') || n.includes('llamada') || n.includes('llamo')) &&
    (n.includes('carpeta') || n.includes('directorio') || n.includes('ruta'))
  );
}

export function detectCorrectionIntent(text) {
  const n = normalizeIntentText(text);
  return (
    n.includes('me refiero') ||
    n.includes('quiero decir') ||
    n.includes('no, es') ||
    /\bno era\b.+\bsino\b/.test(n) ||
    n.includes('me equivoque, es') ||
    n.includes('me equivoque es') ||
    /\bno\b.+\bquiero decir\b/.test(n) ||
    n.includes('corrijo') ||
    n.includes('no esa, la otra') ||
    n.includes('no esa la otra') ||
    n.includes('en realidad es') ||
    n.startsWith('es ') ||
    n.includes('esa es')
  );
}

export function buildVoiceSummary(summary, isLongRequested) {
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
