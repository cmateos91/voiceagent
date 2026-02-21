// session: Gestiona estado por sesión y utilidades para recuperar contexto reciente del chat.

const sessionMemory = new Map();

export function getLastUserMessage(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === 'user' && typeof history[i]?.content === 'string') {
      return history[i].content.trim();
    }
  }
  return '';
}

export function getSessionState(sessionId) {
  if (!sessionId) {
    return {
      lastTarget: null,
      lastAction: null,
      lastCommand: null,
      lastResult: null,
      cachedDirs: [],
      cachedDirsAt: 0,
      lastListing: [],
      lastSuggestions: [],
      pendingIntent: null,
      notes: []
    };
  }
  if (!sessionMemory.has(sessionId)) {
    sessionMemory.set(sessionId, {
      lastTarget: null,
      lastAction: null,
      lastCommand: null,
      lastResult: null,
      cachedDirs: [],
      cachedDirsAt: 0,
      lastListing: [],
      lastSuggestions: [],
      pendingIntent: null,
      notes: []
    });
  }
  return sessionMemory.get(sessionId);
}

export function hasRecentExecutionEvidence(history) {
  const recent = history.slice(-6);
  return recent.some((msg) => {
    if (msg?.role !== 'assistant' || typeof msg?.content !== 'string') return false;
    return msg.content.includes('STDOUT:') || msg.content.includes('Comando:');
  });
}

export function cleanupSessionMemory() {
  if (sessionMemory.size > 200) {
    const keep = Array.from(sessionMemory.entries()).slice(-120);
    sessionMemory.clear();
    for (const [k, v] of keep) {
      sessionMemory.set(k, v);
    }
  }
}
