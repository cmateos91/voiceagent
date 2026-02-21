// providers: Abstracts LLM calls across Ollama, OpenAI, and Anthropic.
import { OLLAMA_HOST, OLLAMA_MODEL } from './config.js';

export async function callProvider(messages, providerConfig, onToken) {
  const { provider, model, apiKey } = providerConfig || {};

  if (provider === 'ollama') {
    return callOllama(messages, model, onToken);
  }
  if (provider === 'openai') {
    return callOpenAI(messages, model, apiKey, onToken);
  }
  if (provider === 'anthropic') {
    return callAnthropic(messages, model, apiKey, onToken);
  }
  throw new Error(`Unknown provider: ${provider}`);
}

async function callOllama(messages, model, onToken) {
  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || OLLAMA_MODEL,
      messages,
      stream: true,
      options: {
        temperature: 0.2
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama error ${response.status}: ${text}`);
  }

  let content = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const item = JSON.parse(line);
          const delta = String(item?.message?.content || '');
          if (delta) {
            content += delta;
            if (typeof onToken === 'function') {
              await onToken(delta);
            }
          }
        } catch {
          // Ignore malformed chunk and keep consuming stream.
        }
      }
    }

    const tail = buffer.trim();
    if (tail) {
      try {
        const item = JSON.parse(tail);
        const delta = String(item?.message?.content || '');
        if (delta) {
          content += delta;
          if (typeof onToken === 'function') {
            await onToken(delta);
          }
        }
      } catch {
        // Ignore trailing malformed chunk.
      }
    }
  } else {
    const data = await response.json();
    content = data?.message?.content?.trim() || '';
  }

  return content.trim();
}

async function callOpenAI(messages, model, apiKey, onToken) {
  if (!apiKey) {
    throw new Error('OpenAI key missing');
  }
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages,
      stream: true,
      temperature: 0.2
    })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI error: ${err}`);
  }
  let content = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') continue;
      try {
        const item = JSON.parse(raw);
        const delta = item?.choices?.[0]?.delta?.content || '';
        if (delta) {
          content += delta;
          if (typeof onToken === 'function') await onToken(delta);
        }
      } catch {
        // Ignore malformed SSE data line.
      }
    }
  }
  return content.trim();
}

async function callAnthropic(messages, model, apiKey, onToken) {
  if (!apiKey) {
    throw new Error('Anthropic key missing');
  }
  const systemMsg = messages.find((m) => m.role === 'system');
  const convoMessages = messages.filter((m) => m.role !== 'system');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'messages-2023-06-16'
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemMsg?.content || '',
      messages: convoMessages,
      stream: true
    })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic error: ${err}`);
  }

  let content = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const item = JSON.parse(line.slice(6));
        const delta = item?.delta?.text || '';
        if (delta) {
          content += delta;
          if (typeof onToken === 'function') await onToken(delta);
        }
      } catch {
        // Ignore malformed SSE data line.
      }
    }
  }
  return content.trim();
}
