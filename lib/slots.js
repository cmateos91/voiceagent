// slots: Resolves anaphoric references in user messages using session memory.

import { normalizeIntentText } from './intent.js';

/**
 * Replaces vague references in userText with concrete values from memory.
 * Returns the rewritten text and a log of substitutions made.
 *
 * @param {string} userText
 * @param {object} memory - session memory object
 * @returns {{ text: string, subs: string[] }}
 */
export function fillSlots(userText, memory) {
  let text = userText;
  const subs = [];
  const n = normalizeIntentText(userText);

  // Patterns that reference the last known target
  const targetRefs = [
    'abrir', 'abrela', 'abre esa', 'abre la carpeta',
    'esa carpeta', 'esa misma', 'la misma', 'la anterior',
    'el mismo', 'el anterior', 'esa', 'ese',
    'listala', 'listame esa', 'lista esa',
    'resumela', 'resumeme esa', 'inspecciona esa',
    'borrala', 'eliminala', 'copiala', 'muevela'
  ];

  const hasTargetRef = targetRefs.some(ref => n.includes(ref));

  if (hasTargetRef && memory.lastTarget && memory.lastTarget !== '.') {
    // Only substitute if no explicit target already in text
    const hasExplicitTarget = memory.cachedDirs?.some(
      dir => normalizeIntentText(dir) !== '.' &&
             n.includes(normalizeIntentText(dir))
    );
    if (!hasExplicitTarget) {
      text = text + ` (target: ${memory.lastTarget})`;
      subs.push(`target -> ${memory.lastTarget}`);
    }
  }

  // Patterns that reference the last command result
  const resultRefs = [
    'repite', 'hazlo de nuevo', 'otra vez',
    'vuelve a ejecutar', 'ejecutalo de nuevo'
  ];
  const hasResultRef = resultRefs.some(ref => n.includes(ref));

  if (hasResultRef && memory.lastCommand) {
    text = text + ` (repetir comando: ${memory.lastCommand})`;
    subs.push(`comando -> ${memory.lastCommand}`);
  }

  return { text, subs };
}
