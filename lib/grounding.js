// grounding: Construye comandos de inspección/listado y resúmenes deterministas de salida.
import { quoteForShell } from './executor.js';
import { extractTargetFromText, resolveTargetInWorkdir } from './resolver.js';

export async function buildGroundingCommand(userText, preferredTarget = null) {
  const extractedTarget = extractTargetFromText(userText);
  const target = preferredTarget || (await resolveTargetInWorkdir(extractedTarget, userText));
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

export function buildListingCommand({ listingIntent, target, includeHidden }) {
  const safeTarget = quoteForShell(target || '.');
  const typePart = listingIntent === 'dirs' ? ' -type d' : listingIntent === 'files' ? ' -type f' : '';
  const hiddenPart = includeHidden ? '' : " ! -name '.*'";
  return (
    `if [ -d ${safeTarget} ]; then ` +
    `find ${safeTarget} -maxdepth 1 -mindepth 1${typePart}${hiddenPart} -printf '%f\\n' | sort -f; ` +
    `else echo "No existe directorio: ${target || '.'}"; fi`
  );
}

export function buildListingSummary({ listingIntent, includeHidden, target, stdout, stderr }) {
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

export function buildDeterministicInspectionSummary(target, stdout) {
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
