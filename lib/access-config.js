// access-config: Manages agent filesystem access scope.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', '.access-config.json');

const DEFAULT_CONFIG = {
  mode: 'workdir',
  allowedPaths: [homedir(), join(homedir(), 'Desktop'), join(homedir(), 'Escritorio'), join(homedir(), 'Documents'), join(homedir(), 'Documentos')].filter((p) => existsSync(p))
};

export function loadAccessConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveAccessConfig(updates) {
  const current = loadAccessConfig();
  const next = { ...current, ...updates };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}
