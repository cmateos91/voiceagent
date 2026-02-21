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
  const displayTarget = target || '.';
  if (stderr?.trim()) {
    return `No pude listar correctamente ${displayTarget}. Error: ${stderr.trim()}`;
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
    return `${label} en ${displayTarget} (${hiddenLabel}): no se encontraron resultados.`;
  }

  const bulletList = rawLines.map((name) => `- ${name}`).join('\n');
  return `${label} en ${displayTarget} (${hiddenLabel}):\n${bulletList}`;
}

export function buildDeterministicInspectionSummary(target, inspectionOrStdout) {
  const topEntries = Array.isArray(inspectionOrStdout?.topEntries) ? inspectionOrStdout.topEntries : null;
  if (topEntries) {
    const dirCount = topEntries.filter((e) => e?.type === 'dir').length;
    const fileCount = topEntries.filter((e) => e?.type === 'file').length;
    return `La carpeta ${target} contiene ${dirCount} carpetas y ${fileCount} archivos.`;
  }

  const text = String(inspectionOrStdout || '');
  const marker = `INSPECCION: ${target}`;
  if (!text.includes(marker)) return '';

  const lines = text.split('\n').map((s) => s.trim());
  const detailIndex = lines.findIndex((l) => l.startsWith('---DETALLE'));
  const topLines = lines.slice(1, detailIndex >= 0 ? detailIndex : lines.length).filter(Boolean);
  const count = topLines.length;
  return `La carpeta ${target} contiene ${count} elementos de primer nivel.`;
}
