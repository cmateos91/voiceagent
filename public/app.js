const orb = document.getElementById('orb');
const statusMain = document.getElementById('statusMain');
const statusSub = document.getElementById('statusSub');
const startVoiceBtn = document.getElementById('startVoiceBtn');
const ttsToggle = document.getElementById('ttsToggle');
const autoListenToggle = document.getElementById('autoListenToggle');
const textModeToggle = document.getElementById('textModeToggle');
const settingsBtn = document.getElementById('settingsBtn');
const providerPanel = document.getElementById('providerPanel');
const providerStatusLine = document.getElementById('providerStatusLine');
const providerStatusMsg = document.getElementById('providerStatusMsg');
const providerOllamaBtn = document.getElementById('providerOllamaBtn');
const providerOpenaiBtn = document.getElementById('providerOpenaiBtn');
const providerAnthropicBtn = document.getElementById('providerAnthropicBtn');
const ollamaSettings = document.getElementById('ollamaSettings');
const openaiSettings = document.getElementById('openaiSettings');
const anthropicSettings = document.getElementById('anthropicSettings');
const ollamaModelSelect = document.getElementById('ollamaModelSelect');
const openaiKeyInput = document.getElementById('openaiKeyInput');
const openaiModelSelect = document.getElementById('openaiModelSelect');
const anthropicKeyInput = document.getElementById('anthropicKeyInput');
const anthropicModelSelect = document.getElementById('anthropicModelSelect');
const providerSaveBtn = document.getElementById('providerSaveBtn');
const providerCloseBtn = document.getElementById('providerCloseBtn');
const accessWorkdirBtn = document.getElementById('accessWorkdirBtn');
const accessAllowlistBtn = document.getElementById('accessAllowlistBtn');
const accessFreeBtn = document.getElementById('accessFreeBtn');
const accessStatusLine = document.getElementById('accessStatusLine');
const accessWorkdirPanel = document.getElementById('accessWorkdirPanel');
const accessAllowlistPanel = document.getElementById('accessAllowlistPanel');
const accessFreePanel = document.getElementById('accessFreePanel');
const accessWorkdirText = document.getElementById('accessWorkdirText');
const allowlistItems = document.getElementById('allowlistItems');
const allowlistInput = document.getElementById('allowlistInput');
const allowlistAddBtn = document.getElementById('allowlistAddBtn');
const accessFreeConfirmBtn = document.getElementById('accessFreeConfirmBtn');
const accessStatusMsg = document.getElementById('accessStatusMsg');

const textConsole = document.getElementById('textConsole');
const chat = document.getElementById('chat');
const visualizer = document.getElementById('visualizer');
const pendingBox = document.getElementById('pending');
const form = document.getElementById('chatForm');
const input = document.getElementById('messageInput');
const updateCheckBtn = document.getElementById('updateCheckBtn');
const updateDownloadBtn = document.getElementById('updateDownloadBtn');
const updateInstallBtn = document.getElementById('updateInstallBtn');
const updateStatus = document.getElementById('updateStatus');
const setupPanel = document.getElementById('setupPanel');
const setupSummary = document.getElementById('setupSummary');
const setupChecklist = document.getElementById('setupChecklist');
const setupInstallBtn = document.getElementById('setupInstallBtn');
const setupStartBtn = document.getElementById('setupStartBtn');
const setupPullBtn = document.getElementById('setupPullBtn');
const setupRefreshBtn = document.getElementById('setupRefreshBtn');
const setupLog = document.getElementById('setupLog');
const API_TOKEN = new URLSearchParams(window.location.search).get('_token') || '';

const state = {
  history: [],
  pendingToken: null,
  pendingCommand: null,
  recognition: null,
  listening: false,
  speaking: false,
  thinking: false,
  userPausedListening: true,
  shouldAutoResume: false,
  setupReady: false,
  providerConfig: null,
  providerModels: { ollama: [] },
  selectedProvider: 'ollama',
  accessConfig: null,
  selectedAccessMode: 'workdir'
};
let voiceDebounceTimer = null;
let visualizerBars = [];
let visualizerAudioContext = null;
let visualizerAnalyser = null;
let visualizerSource = null;
let visualizerStream = null;
let visualizerFrame = null;

function ensureVisualizerBars() {
  if (!visualizer) return;
  if (visualizerBars.length) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 24; i += 1) {
    const bar = document.createElement('span');
    bar.className = 'viz-bar';
    frag.appendChild(bar);
    visualizerBars.push(bar);
  }
  visualizer.appendChild(frag);
}

function setVisualizerMode(mode = 'idle') {
  if (!visualizer) return;
  visualizer.classList.remove('listening', 'speaking', 'fallback');
  if (mode === 'listening' || mode === 'speaking' || mode === 'fallback') {
    visualizer.classList.add(mode);
  }
}

async function initAudioVisualizer(stream) {
  ensureVisualizerBars();
  if (!visualizer || !visualizerBars.length) return;
  setVisualizerMode('listening');

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx || !navigator.mediaDevices?.getUserMedia) {
    setVisualizerMode('fallback');
    return;
  }

  try {
    if (visualizerFrame) {
      cancelAnimationFrame(visualizerFrame);
      visualizerFrame = null;
    }

    if (visualizerSource) {
      visualizerSource.disconnect();
      visualizerSource = null;
    }

    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    visualizerStream = stream;

    if (!visualizerAudioContext) {
      visualizerAudioContext = new AudioCtx();
    }
    if (visualizerAudioContext.state === 'suspended') {
      await visualizerAudioContext.resume();
    }

    visualizerAnalyser = visualizerAudioContext.createAnalyser();
    visualizerAnalyser.fftSize = 128;
    visualizerAnalyser.smoothingTimeConstant = 0.75;
    visualizerSource = visualizerAudioContext.createMediaStreamSource(stream);
    visualizerSource.connect(visualizerAnalyser);

    const bins = new Uint8Array(visualizerAnalyser.frequencyBinCount);
    const render = () => {
      if (!visualizerAnalyser) return;
      visualizerAnalyser.getByteFrequencyData(bins);
      const step = Math.max(1, Math.floor(bins.length / visualizerBars.length));
      for (let i = 0; i < visualizerBars.length; i += 1) {
        const value = bins[Math.min(bins.length - 1, i * step)] || 0;
        const height = 4 + Math.round((value / 255) * 52);
        visualizerBars[i].style.height = `${height}px`;
      }
      visualizerFrame = requestAnimationFrame(render);
    };
    render();
  } catch {
    setVisualizerMode('fallback');
  }
}

function stopAudioVisualizer() {
  if (visualizerFrame) {
    cancelAnimationFrame(visualizerFrame);
    visualizerFrame = null;
  }
  if (visualizerSource) {
    visualizerSource.disconnect();
    visualizerSource = null;
  }
  if (visualizerStream) {
    visualizerStream.getTracks().forEach((track) => track.stop());
    visualizerStream = null;
  }
  visualizerBars.forEach((bar) => {
    bar.style.height = '8px';
  });
  setVisualizerMode('idle');
}

const sessionId = (() => {
  const key = 'voice_pc_agent_session_id';
  const current = localStorage.getItem(key);
  if (current) return current;
  const created = `sess_${crypto.randomUUID()}`;
  localStorage.setItem(key, created);
  return created;
})();

function pushHistory(role, content) {
  state.history.push({ role, content: String(content || '') });
  if (state.history.length > 24) {
    state.history = state.history.slice(-24);
  }
}

function setOrb(mode) {
  orb.classList.remove('idle', 'listening', 'thinking', 'speaking', 'pending', 'paused');
  orb.classList.add(mode);
}

function setStatus(main, sub = '') {
  statusMain.textContent = main;
  statusSub.textContent = sub;
}

function setVoiceControlsEnabled(enabled) {
  startVoiceBtn.disabled = !enabled;
  autoListenToggle.disabled = !enabled;
}

function setUpdateUi(status) {
  if (!updateStatus) return;
  const hasDesktopUpdater = Boolean(window.desktopUpdater);
  updateCheckBtn.classList.toggle('hidden', !hasDesktopUpdater);
  updateDownloadBtn.classList.toggle('hidden', true);
  updateInstallBtn.classList.toggle('hidden', true);

  if (!hasDesktopUpdater) {
    updateStatus.classList.add('hidden');
    return;
  }

  updateStatus.classList.remove('hidden');
  updateStatus.textContent = status?.message || '';

  if (status?.status === 'available') {
    updateDownloadBtn.classList.remove('hidden');
  }
  if (status?.status === 'downloaded') {
    updateInstallBtn.classList.remove('hidden');
  }
}

function addMessage(role, text) {
  if (!chat) return;
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function createMessage(role, text = '') {
  if (!chat) return null;
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

async function consumeSseResponse(response, onEvent) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');

      const dataLines = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());

      if (!dataLines.length) continue;
      const raw = dataLines.join('\n');
      try {
        const event = JSON.parse(raw);
        onEvent(event);
        if (event?.type === 'final' && !state.speaking && !state.userPausedListening) {
          maybeResumeListening(600);
        }
      } catch {
        // Ignore malformed event blocks.
      }
    }
  }
}

function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (API_TOKEN) headers.set('x-api-token', API_TOKEN);
  return fetch(url, { ...options, headers });
}

function getProviderButtons() {
  return [
    ['ollama', providerOllamaBtn],
    ['openai', providerOpenaiBtn],
    ['anthropic', providerAnthropicBtn]
  ];
}

function setProviderStatusLine(cfg) {
  if (!providerStatusLine) return;
  if (!cfg) {
    providerStatusLine.textContent = 'PROVEEDOR: OLLAMA';
    return;
  }
  const activeModel =
    cfg.provider === 'ollama' ? cfg.ollamaModel : cfg.provider === 'openai' ? cfg.openaiModel : cfg.anthropicModel;
  providerStatusLine.textContent = `PROVEEDOR: ${String(cfg.provider || 'ollama').toUpperCase()} · ${activeModel || '-'}`;
}

function renderProviderPanel() {
  const cfg = state.providerConfig;
  if (!cfg) return;
  const provider = state.selectedProvider || cfg.provider || 'ollama';

  for (const [name, button] of getProviderButtons()) {
    if (!button) continue;
    button.classList.toggle('active', provider === name);
  }

  if (ollamaSettings) ollamaSettings.classList.toggle('hidden', provider !== 'ollama');
  if (openaiSettings) openaiSettings.classList.toggle('hidden', provider !== 'openai');
  if (anthropicSettings) anthropicSettings.classList.toggle('hidden', provider !== 'anthropic');

  if (ollamaModelSelect) ollamaModelSelect.value = cfg.ollamaModel || '';
  if (openaiModelSelect) openaiModelSelect.value = cfg.openaiModel || 'gpt-4o-mini';
  if (anthropicModelSelect) anthropicModelSelect.value = cfg.anthropicModel || 'claude-haiku-4-5-20251001';
  if (openaiKeyInput && !openaiKeyInput.dataset.dirty) openaiKeyInput.value = cfg.openaiKey || '';
  if (anthropicKeyInput && !anthropicKeyInput.dataset.dirty) anthropicKeyInput.value = cfg.anthropicKey || '';

  setProviderStatusLine(cfg);
}

async function fetchProviderModels(provider) {
  const res = await apiFetch(`/api/provider/models?provider=${encodeURIComponent(provider)}`);
  if (!res.ok) throw new Error(`provider models ${res.status}`);
  return res.json();
}

async function ensureOllamaModelList() {
  if (state.providerModels.ollama?.length) return;
  try {
    const data = await fetchProviderModels('ollama');
    state.providerModels.ollama = Array.isArray(data?.models) ? data.models : [];
  } catch {
    state.providerModels.ollama = [];
  }
  if (!ollamaModelSelect) return;

  const current = state.providerConfig?.ollamaModel || '';
  const models = state.providerModels.ollama;
  const merged = models.includes(current) ? models : [current, ...models].filter(Boolean);
  ollamaModelSelect.innerHTML = merged.map((m) => `<option value="${m}">${m}</option>`).join('');
  if (!merged.length) {
    ollamaModelSelect.innerHTML = '<option value="">(sin modelos detectados)</option>';
  }
}

async function loadProviderConfigUi() {
  const res = await apiFetch('/api/provider/config');
  if (!res.ok) throw new Error(`provider config ${res.status}`);
  const cfg = await res.json();
  state.providerConfig = cfg;
  state.selectedProvider = cfg.provider || 'ollama';
  await ensureOllamaModelList();
  renderProviderPanel();
}

async function saveProviderConfigUi() {
  if (!state.providerConfig) return;
  const provider = state.selectedProvider || 'ollama';
  const payload = {
    provider,
    ollamaModel: ollamaModelSelect?.value || state.providerConfig.ollamaModel,
    openaiModel: openaiModelSelect?.value || state.providerConfig.openaiModel,
    anthropicModel: anthropicModelSelect?.value || state.providerConfig.anthropicModel
  };

  const openaiValue = String(openaiKeyInput?.value || '').trim();
  const anthropicValue = String(anthropicKeyInput?.value || '').trim();
  if (openaiValue && !openaiValue.endsWith('***')) payload.openaiKey = openaiValue;
  if (anthropicValue && !anthropicValue.endsWith('***')) payload.anthropicKey = anthropicValue;

  const res = await apiFetch('/api/provider/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `provider save ${res.status}`);
  }

  const cfg = await res.json();
  state.providerConfig = cfg;
  state.selectedProvider = cfg.provider || 'ollama';
  if (openaiKeyInput) openaiKeyInput.dataset.dirty = '';
  if (anthropicKeyInput) anthropicKeyInput.dataset.dirty = '';
  await ensureOllamaModelList();
  renderProviderPanel();
  providerStatusMsg.textContent = 'Configuración guardada.';
}

function getAccessButtons() {
  return [
    ['workdir', accessWorkdirBtn],
    ['allowlist', accessAllowlistBtn],
    ['free', accessFreeBtn]
  ];
}

function renderAllowlistItems() {
  if (!allowlistItems) return;
  const paths = Array.isArray(state.accessConfig?.allowedPaths) ? state.accessConfig.allowedPaths : [];
  if (!paths.length) {
    allowlistItems.innerHTML = '<p class="provider-status-line">Sin rutas permitidas.</p>';
    return;
  }
  allowlistItems.innerHTML = paths
    .map((p, idx) => `<div class="allowlist-item"><code>${p}</code><button type="button" data-remove-index="${idx}">✕</button></div>`)
    .join('');

  allowlistItems.querySelectorAll('button[data-remove-index]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.getAttribute('data-remove-index'));
      const current = Array.isArray(state.accessConfig?.allowedPaths) ? state.accessConfig.allowedPaths : [];
      const allowedPaths = current.filter((_p, i) => i !== idx);
      await saveAccessConfigUi({ mode: state.selectedAccessMode, allowedPaths });
    });
  });
}

function setAccessStatusLine(cfg) {
  if (!accessStatusLine) return;
  if (!cfg) {
    accessStatusLine.textContent = 'ACCESO: WORKDIR';
    return;
  }
  if (cfg.mode === 'allowlist') {
    accessStatusLine.textContent = `ACCESO: RUTAS PERMITIDAS · ${Array.isArray(cfg.allowedPaths) ? cfg.allowedPaths.length : 0}`;
    return;
  }
  if (cfg.mode === 'free') {
    accessStatusLine.textContent = 'ACCESO: LIBRE';
    return;
  }
  accessStatusLine.textContent = 'ACCESO: WORKDIR';
}

function renderAccessPanel() {
  const cfg = state.accessConfig;
  if (!cfg) return;
  const mode = state.selectedAccessMode || cfg.mode || 'workdir';

  for (const [name, button] of getAccessButtons()) {
    if (!button) continue;
    button.classList.toggle('active', mode === name);
  }

  if (accessWorkdirPanel) accessWorkdirPanel.classList.toggle('hidden', mode !== 'workdir');
  if (accessAllowlistPanel) accessAllowlistPanel.classList.toggle('hidden', mode !== 'allowlist');
  if (accessFreePanel) accessFreePanel.classList.toggle('hidden', mode !== 'free');
  if (accessWorkdirText) {
    const workdir = state.accessConfig?.workdir || '(workdir)';
    accessWorkdirText.textContent = `El agente solo opera en: ${workdir}`;
  }
  setAccessStatusLine(cfg);
  renderAllowlistItems();
}

async function loadAccessConfigUi() {
  const res = await apiFetch('/api/access/config');
  if (!res.ok) throw new Error(`access config ${res.status}`);
  const cfg = await res.json();
  state.accessConfig = cfg;
  state.selectedAccessMode = cfg.mode || 'workdir';
  renderAccessPanel();
}

async function saveAccessConfigUi(payload) {
  const res = await apiFetch('/api/access/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `access save ${res.status}`);
  }
  const cfg = await res.json();
  state.accessConfig = cfg;
  state.selectedAccessMode = cfg.mode || 'workdir';
  renderAccessPanel();
  if (accessStatusMsg) accessStatusMsg.textContent = 'Acceso actualizado.';
}

async function checkPathExists(pathValue) {
  const res = await apiFetch(`/api/access/check-path?path=${encodeURIComponent(pathValue)}`);
  if (!res.ok) return false;
  const data = await res.json();
  return Boolean(data?.exists);
}

function parseAssistantJsonLike(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  if (parsed === null) return null;

  // Some model replies arrive as a JSON string containing JSON text.
  // Unwrap one extra layer when needed.
  if (typeof parsed === 'string') {
    const inner = parsed.trim();
    if (inner) {
      try {
        return JSON.parse(inner);
      } catch {
        return parsed;
      }
    }
  }
  return parsed;
}

function normalizeAssistantPayload(data, streamedText) {
  if (data && typeof data === 'object') {
    if (typeof data.message === 'string') {
      const nested = parseAssistantJsonLike(data.message);
      if (nested?.type && typeof nested?.message === 'string') {
        return nested;
      }
    }
    return data;
  }

  const parsedFromStream = parseAssistantJsonLike(streamedText);
  if (parsedFromStream?.type && typeof parsedFromStream?.message === 'string') {
    return parsedFromStream;
  }
  return { type: 'reply', message: String(streamedText || 'Sin respuesta.') };
}

function normalizeSpeech(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getPendingVoiceIntent(transcript) {
  const normalized = normalizeSpeech(transcript);

  const approvePhrases = [
    'aprobar comando',
    'aprueba comando',
    'confirmar comando',
    'confirma comando',
    'ejecutar comando',
    'ejecuta comando',
    'aprobar',
    'aprueba',
    'confirmar',
    'confirma',
    'ejecutar',
    'ejecuta',
    'sí ejecuta',
    'dale',
    'sí',
    'si',
    'si ejecutar',
    'si confirma'
  ];

  const rejectPhrases = [
    'rechazar comando',
    'rechaza comando',
    'cancelar comando',
    'cancela comando',
    'rechazar',
    'rechaza',
    'cancelar',
    'cancela',
    'no ejecutes',
    'no',
    'para',
    'no ejecutar',
    'no confirmo',
    'descartar comando'
  ];

  if (approvePhrases.some((phrase) => normalized.includes(phrase))) return 'approve';
  if (rejectPhrases.some((phrase) => normalized.includes(phrase))) return 'reject';
  return null;
}

function setTextMode(enabled) {
  if (!textConsole) return;
  textConsole.classList.toggle('hidden', !enabled);
}

function formatExecutionOutput(data) {
  const base = [
    `Comando: ${data.command}`,
    data.cwd ? `CWD: ${data.cwd}` : '',
    `OK: ${Boolean(data.ok)}`,
    data.error ? `Error: ${data.error}` : '',
    data.stdout ? `STDOUT:\n${data.stdout}` : '',
    data.stderr ? `STDERR:\n${data.stderr}` : ''
  ]
    .filter(Boolean)
    .join('\n\n');

  return data.summary ? `Detalles tecnicos (no leidos en voz):\n\n${base}` : base;
}

function renderPendingText(message, command) {
  if (!pendingBox || textConsole.classList.contains('hidden')) return;
  pendingBox.classList.remove('hidden');
  pendingBox.innerHTML = `
    <strong>Comando pendiente</strong>
    <p>${message}</p>
    <code>${command}</code>
    <div class="pending-actions">
      <button id="approveBtn" type="button">Aprobar</button>
      <button id="rejectBtn" type="button">Rechazar</button>
    </div>
  `;

  document.getElementById('approveBtn').onclick = approveCommand;
  document.getElementById('rejectBtn').onclick = rejectCommand;
}

function clearPendingText() {
  if (!pendingBox) return;
  pendingBox.classList.add('hidden');
  pendingBox.innerHTML = '';
}

function startListening() {
  if (!state.recognition || state.listening || state.speaking || state.thinking) return;
  try {
    state.recognition.start();
  } catch {
    // Browser can throw InvalidStateError if previous stop has not fully settled.
  }
}

function maybeResumeListening(delayMs = 180) {
  if (state.userPausedListening || state.thinking || state.speaking) return;
  setTimeout(() => {
    if (!state.listening && !state.userPausedListening && !state.thinking && !state.speaking) {
      startListening();
    }
  }, delayMs);
}

function playTtsOnce(text, lang) {
  return new Promise((resolve) => {
    let started = false;
    let finished = false;

    const utterance = new SpeechSynthesisUtterance(text);
    if (lang) utterance.lang = lang;

    const startTimeout = setTimeout(() => {
      if (!started && !finished) {
        finished = true;
        resolve({ started: false });
      }
    }, 1200);

    utterance.onstart = () => {
      started = true;
    };

    utterance.onend = () => {
      if (finished) return;
      finished = true;
      clearTimeout(startTimeout);
      resolve({ started: true });
    };

    utterance.onerror = () => {
      if (finished) return;
      finished = true;
      clearTimeout(startTimeout);
      resolve({ started });
    };

    window.speechSynthesis.speak(utterance);
  });
}

function toSpeechText(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[>#]/g, ' ')
    .replace(/\s*\/\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function currentIdleState() {
  if (state.pendingToken) return 'pending';
  if (state.userPausedListening) return 'paused';
  return 'idle';
}

function speak(text) {
  if (!ttsToggle.checked || !('speechSynthesis' in window)) {
    maybeResumeListening();
    return;
  }
  const speechText = toSpeechText(text);
  if (!speechText) {
    maybeResumeListening();
    return;
  }

  window.speechSynthesis.cancel();
  state.shouldAutoResume = false;
  state.speaking = true;
  state.thinking = false;

  if (state.listening) {
    state.recognition.stop();
  }

  setVisualizerMode('speaking');
  setOrb(state.pendingToken ? 'pending' : 'speaking');
  setStatus('Hablando', 'Reproduciendo respuesta por voz...');

  (async () => {
    const firstTry = await playTtsOnce(speechText, 'es-ES');
    let ok = firstTry.started;

    if (!ok) {
      window.speechSynthesis.cancel();
      const secondTry = await playTtsOnce(speechText, '');
      ok = secondTry.started;
    }

    state.speaking = false;
    const mode = currentIdleState();
    setOrb(mode);

    if (!ok) {
      setStatus('Error de voz', 'No se pudo reproducir audio.');
      state.shouldAutoResume = false;
      return;
    }

    if (state.pendingToken) {
      setStatus('Confirmacion pendiente', 'Di "aprobar comando" o "rechazar comando".');
    } else if (state.userPausedListening) {
      setStatus('Pausado', 'Pulsa "Activar voz" para continuar.');
    } else {
      setStatus('Listo para escuchar', 'Puedes seguir hablando.');
    }
    if (!state.userPausedListening) {
      state.shouldAutoResume = true;
      maybeResumeListening(400);
    } else {
      setVisualizerMode('idle');
    }
  })();
}

async function sendUserMessage(text, source = 'voice') {
  state.shouldAutoResume = false;
  if (state.listening) state.recognition?.stop();
  if (!text) return;
  if (!state.setupReady) {
    const msg = 'Primero completa el asistente de inicio para instalar o preparar Ollama.';
    addMessage('agent', msg);
    speak(msg);
    return;
  }

  addMessage('user', text);
  pushHistory('user', text);

  state.thinking = true;
  setOrb('thinking');
  setStatus('Pensando', 'Consultando el modelo...');

  const res = await apiFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, history: state.history })
  });

  state.thinking = false;

  if (!res.ok) {
    const err = await res.text();
    const msg = `Error de backend: ${err}`;
    addMessage('agent', msg);
    setOrb('idle');
    speak(msg);
    return;
  }

  const contentType = res.headers.get('content-type') || '';
  let data = null;
  let streamingBubble = null;
  let streamedText = '';

  if (contentType.includes('text/event-stream')) {
    await consumeSseResponse(res, (event) => {
      if (event?.type === 'token') {
        if (!streamingBubble) {
          streamingBubble = createMessage('agent', '');
        }
        streamedText += String(event.delta || '');
        streamingBubble.textContent = streamedText;
        chat.scrollTop = chat.scrollHeight;
        return;
      }
      if (event?.type === 'final') {
        data = event.payload || null;
        if (data?.type === 'command') {
          state.shouldAutoResume = true;
          maybeResumeListening(800);
        }
        return;
      }
      if (event?.type === 'error') {
        data = { type: 'reply', message: `Error de backend: ${event.message || 'desconocido'}` };
      }
    });
  } else {
    data = await res.json();
  }

  data = normalizeAssistantPayload(data, streamedText);

  if (data.type === 'executed') {
    if (streamingBubble) streamingBubble.remove();
    if (data.summary) {
      addMessage('agent', data.summary);
      pushHistory('assistant', data.summary);
    }

    const output = formatExecutionOutput(data);
    addMessage('agent', output);
    pushHistory('assistant', data.summary || `Comando ejecutado: ${data.command}.`);

    if (data.summary) {
      speak(data.voiceSummary || data.summary);
    } else {
      speak(data.ok ? 'Comando de lectura ejecutado.' : 'El comando de lectura fallo.');
    }
    return;
  }

  if (data.type === 'command') {
    if (streamingBubble) streamingBubble.remove();
    state.pendingToken = data.token;
    state.pendingCommand = data.command;

    setOrb('pending');
    setStatus('Comando pendiente', `"${data.command}" — Di "aprobar comando" o "rechazar comando"`);

    const msg = `Necesito confirmacion para ejecutar este comando: ${data.command}`;
    addMessage('agent', msg);
    renderPendingText(data.message, data.command);
    speak('Te propuse un comando. Di aprobar comando o rechazar comando.');
    return;
  }

  const msg = data.message || 'Sin respuesta.';
  if (streamingBubble) {
    streamingBubble.textContent = msg;
  } else {
    addMessage('agent', msg);
  }
  pushHistory('assistant', msg);

  setOrb('idle');
  setStatus('Respuesta lista', source === 'voice' ? 'Te respondo por voz.' : 'Respuesta enviada.');
  speak(msg);
}

function showSetupLog(content) {
  if (!content) return;
  setupLog.classList.remove('hidden');
  setupLog.textContent = content;
}

function renderSetupStatus(status) {
  const ready = status.ollamaInstalled && status.ollamaReachable && status.modelInstalled;
  state.setupReady = ready;
  setVoiceControlsEnabled(ready);

  setupPanel.classList.toggle('hidden', ready);
  if (ready) {
    setupSummary.textContent = 'Entorno listo. Puedes usar modo voz.';
    return;
  }

  const checks = [
    `Ollama instalado: ${status.ollamaInstalled ? 'si' : 'no'}`,
    `Ollama activo: ${status.ollamaReachable ? 'si' : 'no'}`,
    `Modelo (${status.model}) descargado: ${status.modelInstalled ? 'si' : 'no'}`
  ];
  setupChecklist.innerHTML = checks.map((line) => `<li>${line}</li>`).join('');
  setupSummary.textContent = 'Faltan dependencias para que el agente funcione en local.';

  setupInstallBtn.classList.toggle('hidden', !status.suggestedActions.installOllama);
  setupStartBtn.classList.toggle('hidden', !status.suggestedActions.startOllama);
  setupPullBtn.classList.toggle('hidden', !status.suggestedActions.pullModel);
}

async function fetchSetupStatus() {
  const res = await apiFetch('/api/setup/status');
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function runSetupAction(endpoint, payload = null) {
  setupSummary.textContent = 'Ejecutando tarea de setup...';
  setupRefreshBtn.disabled = true;
  setupInstallBtn.disabled = true;
  setupStartBtn.disabled = true;
  setupPullBtn.disabled = true;
  try {
    const res = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : '{}'
    });
    const data = await res.json();
    showSetupLog(
      [
        data.command ? `Comando: ${data.command}` : '',
        data.error ? `Error: ${data.error}` : '',
        data.stderr ? `STDERR:\n${data.stderr}` : '',
        data.stdout ? `STDOUT:\n${data.stdout}` : ''
      ]
        .filter(Boolean)
        .join('\n\n')
    );
  } finally {
    const status = await fetchSetupStatus();
    renderSetupStatus(status);
    setupRefreshBtn.disabled = false;
    setupInstallBtn.disabled = false;
    setupStartBtn.disabled = false;
    setupPullBtn.disabled = false;
  }
}

async function initSetupWizard() {
  try {
    const status = await fetchSetupStatus();
    renderSetupStatus(status);
  } catch (error) {
    state.setupReady = false;
    setVoiceControlsEnabled(false);
    setupPanel.classList.remove('hidden');
    setupSummary.textContent = `No pude comprobar setup: ${error.message}`;
  }
}

async function approveCommand() {
  if (!state.pendingToken) return;

  const token = state.pendingToken;
  const commandLabel = state.pendingCommand;

  state.pendingToken = null;
  state.pendingCommand = null;
  clearPendingText();

  setOrb('thinking');
  setStatus('Ejecutando', 'Procesando comando confirmado...');

  const res = await apiFetch('/api/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });

  const data = await res.json();
  const output = formatExecutionOutput(data);

  addMessage('agent', output);
  pushHistory('assistant', `Comando ejecutado: ${data.command}.`);

  if (data.summary) {
    speak(data.summary);
  } else {
    speak(data.ok ? `Comando ejecutado: ${commandLabel || 'ok'}.` : 'El comando fallo.');
  }
}

async function rejectCommand() {
  if (!state.pendingToken) return;

  const token = state.pendingToken;
  state.pendingToken = null;
  state.pendingCommand = null;
  clearPendingText();

  await apiFetch('/api/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });

  const msg = 'Comando rechazado. No se ejecuto nada.';
  addMessage('agent', msg);
  pushHistory('assistant', msg);

  setOrb('idle');
  setStatus('Comando cancelado', 'No hice cambios.');
  speak(msg);
}

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setOrb('paused');
    setStatus('Voz no disponible', 'Este navegador no soporta reconocimiento de voz.');
    startVoiceBtn.disabled = true;
    autoListenToggle.disabled = true;
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = 'es-ES';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    state.listening = true;
    initAudioVisualizer();
    setOrb(state.pendingToken ? 'pending' : 'listening');
    setStatus('Escuchando', state.pendingToken ? 'Esperando aprobacion o rechazo.' : 'Di tu siguiente instruccion.');
    startVoiceBtn.textContent = 'Pausar voz';
  };

  recognition.onend = () => {
    state.listening = false;
    stopAudioVisualizer();
    startVoiceBtn.textContent = state.userPausedListening ? 'Activar voz' : 'Pausar voz';

    if (state.shouldAutoResume && !state.userPausedListening) {
      maybeResumeListening(250);
      return;
    }

    setOrb(currentIdleState());
    if (state.userPausedListening) {
      setStatus('Pausado', 'Pulsa "Activar voz" para continuar.');
    }
  };

  recognition.onresult = async (event) => {
    const result = event.results?.[event.resultIndex];
    const alt = result?.[0];
    const transcript = alt?.transcript?.trim();
    const confidence = alt?.confidence ?? 1;

    if (!result?.isFinal) {
      maybeResumeListening();
      return;
    }

    if (!transcript || confidence < 0.55) {
      console.log('[voice] filtered: low confidence or empty', { transcript: transcript || '', confidence });
      maybeResumeListening();
      return;
    }

    const normalized = normalizeSpeech(transcript);
    if (normalized.includes('activar modo texto')) {
      textModeToggle.checked = true;
      setTextMode(true);
      speak('Modo texto activado.');
      return;
    }

    if (normalized.includes('desactivar modo texto')) {
      textModeToggle.checked = false;
      setTextMode(false);
      speak('Modo texto desactivado.');
      return;
    }

    if (state.pendingToken) {
      const intent = getPendingVoiceIntent(transcript);
      if (intent === 'approve') {
        await approveCommand();
        return;
      }
      if (intent === 'reject') {
        await rejectCommand();
        return;
      }
      speak('Hay un comando pendiente. Di aprobar comando o rechazar comando.');
      return;
    }

    if (transcript.split(' ').filter(Boolean).length < 2) {
      console.log('[voice] filtered: too short', { transcript, confidence });
      maybeResumeListening();
      return;
    }

    clearTimeout(voiceDebounceTimer);
    voiceDebounceTimer = setTimeout(async () => {
      try {
        await sendUserMessage(transcript, 'voice');
      } catch (error) {
        const msg = `Error: ${error.message}`;
        addMessage('agent', msg);
        speak(msg);
      }
    }, 450);
  };

  recognition.onspeechend = () => {
    setStatus('Procesando', 'Analizando lo que dijiste...');
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed') {
      state.userPausedListening = true;
      state.shouldAutoResume = false;
      setOrb('paused');
      setStatus('Permiso denegado', 'Habilita el microfono del navegador para usar voz.');
      return;
    }

    setStatus('Error de voz', `Reconocimiento: ${event.error}`);
    maybeResumeListening(600);
  };

  state.recognition = recognition;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  state.shouldAutoResume = false;
  if (state.listening) {
    state.recognition.stop();
  }

  try {
    await sendUserMessage(text, 'text');
  } catch (error) {
    const msg = `Error: ${error.message}`;
    addMessage('agent', msg);
    speak(msg);
  }
});

startVoiceBtn.addEventListener('click', () => {
  if (!state.recognition) return;
  if (!state.setupReady) {
    const msg = 'Completa primero el asistente de inicio.';
    setStatus('Setup pendiente', msg);
    speak(msg);
    return;
  }

  if (state.listening || !state.userPausedListening) {
    state.userPausedListening = true;
    state.shouldAutoResume = false;
    if (state.listening) {
      state.recognition.stop();
    }
    setOrb('paused');
    setStatus('Pausado', 'Pulsa "Activar voz" para continuar.');
    startVoiceBtn.textContent = 'Activar voz';
    return;
  }

  state.userPausedListening = false;
  state.shouldAutoResume = true;
  startVoiceBtn.textContent = 'Pausar voz';
  setStatus('Iniciando voz', 'Preparando escucha...');
  startListening();
});

autoListenToggle.addEventListener('change', () => {
  if (autoListenToggle.checked && !state.userPausedListening) {
    maybeResumeListening(180);
  } else if (!autoListenToggle.checked) {
    state.shouldAutoResume = false;
  }
});

textModeToggle.addEventListener('change', () => {
  setTextMode(textModeToggle.checked);
});

for (const [name, button] of getProviderButtons()) {
  if (!button) continue;
  button.addEventListener('click', async () => {
    state.selectedProvider = name;
    if (name === 'ollama') {
      await ensureOllamaModelList();
    }
    renderProviderPanel();
  });
}

if (openaiKeyInput) {
  openaiKeyInput.addEventListener('input', () => {
    openaiKeyInput.dataset.dirty = '1';
  });
}
if (anthropicKeyInput) {
  anthropicKeyInput.addEventListener('input', () => {
    anthropicKeyInput.dataset.dirty = '1';
  });
}

if (settingsBtn) {
  settingsBtn.addEventListener('click', async () => {
    providerStatusMsg.textContent = '';
    if (accessStatusMsg) accessStatusMsg.textContent = '';
    providerPanel.classList.toggle('hidden');
    if (!providerPanel.classList.contains('hidden')) {
      try {
        await loadProviderConfigUi();
        await loadAccessConfigUi();
      } catch (error) {
        providerStatusMsg.textContent = `No se pudo cargar configuración: ${error.message}`;
      }
    }
  });
}

if (providerCloseBtn) {
  providerCloseBtn.addEventListener('click', () => {
    providerPanel.classList.add('hidden');
  });
}

if (providerSaveBtn) {
  providerSaveBtn.addEventListener('click', async () => {
    providerStatusMsg.textContent = 'Guardando...';
    try {
      await saveProviderConfigUi();
    } catch (error) {
      providerStatusMsg.textContent = `Error al guardar: ${error.message}`;
    }
  });
}

for (const [name, button] of getAccessButtons()) {
  if (!button) continue;
  button.addEventListener('click', () => {
    state.selectedAccessMode = name;
    if (accessStatusMsg) accessStatusMsg.textContent = '';
    renderAccessPanel();
    if (name === 'workdir') {
      saveAccessConfigUi({ mode: 'workdir' }).catch((error) => {
        accessStatusMsg.textContent = `Error al guardar acceso: ${error.message}`;
      });
    }
    if (name === 'allowlist') {
      const current = Array.isArray(state.accessConfig?.allowedPaths) ? state.accessConfig.allowedPaths : [];
      saveAccessConfigUi({ mode: 'allowlist', allowedPaths: current }).catch((error) => {
        accessStatusMsg.textContent = `Error al guardar acceso: ${error.message}`;
      });
    }
  });
}

if (allowlistAddBtn) {
  allowlistAddBtn.addEventListener('click', async () => {
    const pathValue = String(allowlistInput?.value || '').trim();
    if (!pathValue) return;
    accessStatusMsg.textContent = 'Validando ruta...';
    try {
      const exists = await checkPathExists(pathValue);
      if (!exists) {
        accessStatusMsg.textContent = 'La ruta no existe.';
        return;
      }
      const current = Array.isArray(state.accessConfig?.allowedPaths) ? state.accessConfig.allowedPaths : [];
      const allowedPaths = current.includes(pathValue) ? current : [...current, pathValue];
      await saveAccessConfigUi({ mode: 'allowlist', allowedPaths });
      allowlistInput.value = '';
    } catch (error) {
      accessStatusMsg.textContent = `Error al añadir ruta: ${error.message}`;
    }
  });
}

if (accessFreeConfirmBtn) {
  accessFreeConfirmBtn.addEventListener('click', async () => {
    accessStatusMsg.textContent = 'Activando modo libre...';
    try {
      const current = Array.isArray(state.accessConfig?.allowedPaths) ? state.accessConfig.allowedPaths : [];
      await saveAccessConfigUi({ mode: 'free', allowedPaths: current });
    } catch (error) {
      accessStatusMsg.textContent = `Error al activar modo libre: ${error.message}`;
    }
  });
}

setupSpeechRecognition();
setTextMode(false);
setOrb('paused');
setStatus('Listo para hablar', 'Pulsa "Activar voz" y empieza a pedir tareas.');
addMessage('agent', 'Modo voz listo. En comandos pendientes: "aprobar comando" o "rechazar comando".');
setVoiceControlsEnabled(false);

setupInstallBtn.addEventListener('click', async () => {
  await runSetupAction('/api/setup/install-ollama');
});
setupStartBtn.addEventListener('click', async () => {
  await runSetupAction('/api/setup/start-ollama');
});
setupPullBtn.addEventListener('click', async () => {
  await runSetupAction('/api/setup/pull-model');
});
setupRefreshBtn.addEventListener('click', async () => {
  const status = await fetchSetupStatus();
  renderSetupStatus(status);
});

initSetupWizard();
loadProviderConfigUi().catch((error) => {
  if (providerStatusMsg) {
    providerStatusMsg.textContent = `No se pudo cargar proveedor: ${error.message}`;
  }
});
loadAccessConfigUi().catch((error) => {
  if (accessStatusMsg) {
    accessStatusMsg.textContent = `No se pudo cargar acceso: ${error.message}`;
  }
});

if (window.desktopUpdater) {
  window.desktopUpdater.onStatus((status) => {
    setUpdateUi(status || {});
  });

  window.desktopUpdater.getState().then((status) => {
    setUpdateUi(status || {});
  });

  updateCheckBtn.addEventListener('click', async () => {
    await window.desktopUpdater.check();
  });
  updateDownloadBtn.addEventListener('click', async () => {
    await window.desktopUpdater.download();
  });
  updateInstallBtn.addEventListener('click', async () => {
    await window.desktopUpdater.install();
  });
}
