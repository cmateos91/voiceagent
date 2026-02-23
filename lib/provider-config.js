// provider-config: Stores and resolves active LLM provider settings persisted on disk.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OLLAMA_MODEL } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', '.provider-config.json');

const DEFAULT_CONFIG = {
  provider: 'ollama',
  ollamaModel: OLLAMA_MODEL,
  openaiModel: 'gpt-4o-mini',
  anthropicModel: 'claude-haiku-4-5-20251001',
  geminiModel: 'gemini-2.5-flash',
  openaiKey: '',
  anthropicKey: '',
  geminiKey: ''
};

export function loadProviderConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveProviderConfig(updates) {
  const current = loadProviderConfig();
  const next = { ...current, ...updates };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

export function getActiveProviderConfig() {
  const cfg = loadProviderConfig();
  return {
    provider: cfg.provider,
    model:
      cfg.provider === 'ollama'
        ? cfg.ollamaModel
        : cfg.provider === 'openai'
          ? cfg.openaiModel
          : cfg.provider === 'anthropic'
            ? cfg.anthropicModel
            : cfg.geminiModel,
    apiKey:
      cfg.provider === 'openai'
        ? cfg.openaiKey
        : cfg.provider === 'anthropic'
          ? cfg.anthropicKey
          : cfg.provider === 'gemini'
            ? cfg.geminiKey
            : null
  };
}
