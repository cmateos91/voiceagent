// setup: Verifica e inicializa dependencias de Ollama y estado de modelo instalado.
import { OLLAMA_HOST, OLLAMA_MODEL } from './config.js';
import { runShellCommand } from './executor.js';
import { loadProviderConfig } from './provider-config.js';

export function isValidModelName(model) {
  return typeof model === 'string' && /^[a-zA-Z0-9_.:-]{2,80}$/.test(model);
}

export async function checkOllamaReachable() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getInstalledModelsFromOllama() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { method: 'GET' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.models) ? data.models.map((m) => String(m?.name || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function normalizeModelAliases(model) {
  if (!model) return [];
  const v = String(model).trim();
  if (!v) return [];
  if (v.includes(':')) {
    const [base] = v.split(':');
    return [v, base].filter(Boolean);
  }
  return [v, `${v}:latest`];
}

export async function setupStatus() {
  const providerCfg = loadProviderConfig();
  const targetModel = isValidModelName(providerCfg?.ollamaModel) ? providerCfg.ollamaModel : OLLAMA_MODEL;
  const ollamaVersion = await runShellCommand('ollama --version', 15000);
  const ollamaInstalled = ollamaVersion.ok;
  const ollamaReachable = ollamaInstalled ? await checkOllamaReachable() : false;
  const installedModels = ollamaReachable ? await getInstalledModelsFromOllama() : [];
  const aliases = normalizeModelAliases(targetModel);
  const modelInstalled = aliases.some((alias) => installedModels.includes(alias));

  return {
    platform: process.platform,
    model: targetModel,
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
