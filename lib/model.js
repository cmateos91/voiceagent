// model: Orquesta llamadas al modelo local para respuesta principal y resumen de ejecución.
import { DESKTOP_DIR, EXEC_WORKDIR, OLLAMA_HOST, OLLAMA_MODEL } from './config.js';
import { buildDeterministicInspectionSummary } from './grounding.js';

const FEW_SHOT_LINUX = `
Ejemplos (sistema: linux):

Usuario: abre la carpeta AndroidDevelpment
{"type":"command","message":"Abriendo AndroidDevelpment.","command":"xdg-open AndroidDevelpment"}

Usuario: cuántas carpetas hay en Roblox
{"type":"command","message":"Contando carpetas en Roblox.","command":"ls -d Roblox/*/"}

Usuario: lista los archivos de FutbolDB
{"type":"command","message":"Listando FutbolDB.","command":"ls -la FutbolDB"}

Usuario: crea una carpeta llamada proyectos
{"type":"command","message":"Creando carpeta proyectos.","command":"mkdir proyectos"}

Usuario: borra el archivo test.txt
{"type":"command","message":"Eliminando test.txt.","command":"rm test.txt"}

Usuario: mueve recetas-mama a la carpeta archivo
{"type":"command","message":"Moviendo recetas-mama.","command":"mv recetas-mama archivo/"}

Usuario: copia config.json a la carpeta backup
{"type":"command","message":"Copiando config.json.","command":"cp config.json backup/"}

Usuario: abre el archivo notas.txt
{"type":"command","message":"Abriendo notas.txt.","command":"xdg-open notas.txt"}

Usuario: cuánto espacio libre hay en el disco
{"type":"command","message":"Consultando espacio en disco.","command":"df -h"}

Usuario: muéstrame los procesos que están corriendo
{"type":"command","message":"Listando procesos.","command":"ps aux"}

Usuario: cierra el proceso firefox
{"type":"command","message":"Cerrando Firefox.","command":"pkill firefox"}

Usuario: qué hora es
{"type":"command","message":"Consultando la hora.","command":"date +%H:%M"}

Usuario: renombra la carpeta Unity a Unity2024
{"type":"command","message":"Renombrando carpeta.","command":"mv Unity Unity2024"}

Usuario: busca archivos llamados config en el directorio actual
{"type":"command","message":"Buscando archivos config.","command":"find . -maxdepth 2 -name 'config*'"}
`;

const FEW_SHOT_WINDOWS = `
Ejemplos (sistema: windows):

Usuario: abre la carpeta AndroidDevelpment
{"type":"command","message":"Abriendo AndroidDevelpment.","command":"explorer AndroidDevelpment"}

Usuario: cuántas carpetas hay en Roblox
{"type":"command","message":"Listando carpetas en Roblox.","command":"dir Roblox /ad /b"}

Usuario: lista los archivos de FutbolDB
{"type":"command","message":"Listando FutbolDB.","command":"dir FutbolDB"}

Usuario: crea una carpeta llamada proyectos
{"type":"command","message":"Creando carpeta proyectos.","command":"mkdir proyectos"}

Usuario: borra el archivo test.txt
{"type":"command","message":"Eliminando test.txt.","command":"del test.txt"}

Usuario: mueve recetas-mama a la carpeta archivo
{"type":"command","message":"Moviendo recetas-mama.","command":"move recetas-mama archivo"}

Usuario: copia config.json a la carpeta backup
{"type":"command","message":"Copiando config.json.","command":"copy config.json backup"}

Usuario: abre el archivo notas.txt
{"type":"command","message":"Abriendo notas.txt.","command":"start notas.txt"}

Usuario: cuánto espacio libre hay en el disco
{"type":"command","message":"Consultando espacio en disco.","command":"wmic logicaldisk get size,freespace,caption"}

Usuario: muéstrame los procesos que están corriendo
{"type":"command","message":"Listando procesos.","command":"tasklist"}

Usuario: cierra el proceso firefox
{"type":"command","message":"Cerrando Firefox.","command":"taskkill /IM firefox.exe /F"}

Usuario: qué hora es
{"type":"command","message":"Consultando la hora.","command":"time /t"}

Usuario: renombra la carpeta Unity a Unity2024
{"type":"command","message":"Renombrando carpeta.","command":"rename Unity Unity2024"}

Usuario: busca archivos llamados config en el directorio actual
{"type":"command","message":"Buscando archivos config.","command":"dir config* /s /b"}
`;

const FEW_SHOT_COMMON = `
Usuario: hola cómo estás
{"type":"reply","message":"¡Hola! ¿En qué puedo ayudarte?"}

Usuario: no era esa carpeta sino FutbolDB
{"type":"reply","message":"Entendido, me refiero a FutbolDB. ¿Qué quieres hacer?"}

Usuario: me equivoqué quiero decir la carpeta de Unity
{"type":"reply","message":"Sin problema, hablamos de Unity. ¿Qué necesitas?"}

Usuario: gracias
{"type":"reply","message":"De nada. ¿Algo más?"}
`;

export async function askModel(history, lastUserMessage, memoryContext = '', onToken, context = {}) {
  const memory = context?.memory || {};
  const resolvedTarget = context?.resolvedTarget || '';
  const availableDirs = Array.isArray(context?.availableDirs) ? context.availableDirs : [];
  const availableDirsText = availableDirs.length ? availableDirs.join(', ') : 'ninguna';
  const platform = process.platform;
  const fewShot = platform === 'win32' ? FEW_SHOT_WINDOWS : FEW_SHOT_LINUX;
  const trimmedMemory = memoryContext ? memoryContext.split('\n').slice(-5).join('\n') : '';
  const system = {
    role: 'system',
    content:
      'Eres un agente local de PC. ' +
      'Responde SIEMPRE en JSON válido: ' +
      '{"type":"reply","message":"..."} o ' +
      '{"type":"command","message":"...","command":"..."}. ' +
      'Reglas de tipo: ' +
      'Usa "reply" para preguntas, confirmaciones o info que ya tienes. ' +
      'Usa "command" solo cuando el usuario pida ejecutar algo. ' +
      'Reglas de mensaje: ' +
      '- Sé breve. Una o dos frases como máximo salvo que pidan detalle. ' +
      '- Nunca listes carpetas/archivos salvo que se pida explícitamente. ' +
      '- Si inspeccionas el filesystem, resume en una frase, no enumeres. ' +
      '- Nunca inventes contenido de archivos o carpetas. ' +
      '- El comando debe ser una sola línea de bash ejecutable. ' +
      '- Nunca uses pipes (|), redirecciones (>, >>) ni operadores (&&, ;) en comandos. Solo comandos simples de una palabra + argumentos. ' +
      '- Para contar carpetas usa: ls -d */ (no find | wc). ' +
      '- No escribas nada fuera del JSON. ' +
      '\nEjemplos de uso:\n' +
      fewShot +
      FEW_SHOT_COMMON +
      `Contexto actual:\n` +
      `- Directorio de trabajo: ${EXEC_WORKDIR}\n` +
      `- Carpetas disponibles: ${availableDirsText}\n` +
      `- Último target usado: ${memory?.lastTarget || 'ninguno'}\n` +
      `- Última acción: ${memory?.lastAction || 'ninguna'}\n` +
      `- Escritorio: ${DESKTOP_DIR}\n` +
      `- Sistema operativo: ${platform}` +
      (trimmedMemory ? `\nMemoria:\n${trimmedMemory}` : '')
  };

  const userMessage =
    `Solicitud: ${lastUserMessage}` +
    (resolvedTarget ? `\nTarget resuelto: ${resolvedTarget}` : '') +
    (memory?.lastTarget ? `\nÚltimo target: ${memory.lastTarget}` : '');

  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [system, ...history, { role: 'user', content: userMessage }],
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

  content = content.trim();

  function parseModelJson(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const slice = cleaned.slice(start, end + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  try {
    let parsed = parseModelJson(content);
    if (typeof parsed === 'string') {
      parsed = parseModelJson(parsed);
    }
    if (parsed?.type && parsed?.message) {
      return { type: String(parsed.type), message: String(parsed.message), command: parsed.command };
    }
    if (parsed?.message && parsed?.command) {
      return { type: 'command', message: String(parsed.message), command: String(parsed.command) };
    }
    if (parsed?.message) {
      return { type: 'reply', message: String(parsed.message) };
    }
    if (parsed?.command) {
      return { type: 'command', message: 'Ejecutar comando propuesto.', command: String(parsed.command) };
    }
    throw new Error('JSON incompleto');
  } catch {
    if (content) {
      const recovered = parseModelJson(content);
      if (typeof recovered === 'string') {
        const inner = parseModelJson(recovered);
        if (inner?.type && inner?.message) {
          return { type: String(inner.type), message: String(inner.message), command: inner.command };
        }
      } else if (recovered?.type && recovered?.message) {
        return { type: String(recovered.type), message: String(recovered.message), command: recovered.command };
      }
      return { type: 'reply', message: String(content) };
    }
    return { type: 'reply', message: 'No te entendi bien.' };
  }
}

export function trimForPrompt(text, maxLen = 12000) {
  const value = String(text || '');
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}\n...[truncado ${value.length - maxLen} caracteres]`;
}

export function compactHistoryForModel(history) {
  const raw = Array.isArray(history) ? history : [];
  const recent = raw.slice(-14);

  return recent
    .map((msg) => {
      const role = msg?.role === 'assistant' || msg?.role === 'user' || msg?.role === 'system' ? msg.role : null;
      if (!role) return null;
      let content = String(msg?.content || '');

      if (role === 'assistant' && (content.includes('STDOUT:') || content.includes('Detalles tecnicos'))) {
        const commandLine = content.split('\n').find((line) => line.startsWith('Comando:')) || 'Comando ejecutado.';
        content = `${commandLine} [salida tecnica omitida para mantener velocidad]`;
      }

      if (content.length > 1400) {
        content = `${content.slice(0, 1400)}\n...[recortado]`;
      }

      return { role, content };
    })
    .filter(Boolean);
}

export async function summarizeExecution(lastUserMessage, execution, options = {}) {
  const target = options?.target || '';
  const system = {
    role: 'system',
    content:
      'Eres un asistente de sistema de archivos. Resume SOLO usando la evidencia dada. ' +
      'No inventes nada. Si no hay evidencia suficiente, dilo claramente. ' +
      'Responde en espanol de forma breve. Prioriza explicar de que trata el proyecto (proposito), ' +
      'y luego menciona 3-6 componentes clave.'
  };

  const user = {
    role: 'user',
    content: [
      `Solicitud original: ${lastUserMessage || '(sin solicitud)'}`,
      target ? `Objetivo confirmado: ${target}` : '',
      `Comando ejecutado: ${execution.command}`,
      `Directorio de ejecucion: ${execution.cwd}`,
      `OK: ${execution.ok}`,
      execution.error ? `Error: ${execution.error}` : '',
      `STDOUT:\n${trimForPrompt(execution.stdout)}`,
      `STDERR:\n${trimForPrompt(execution.stderr)}`
    ]
      .filter(Boolean)
      .join('\n\n')
  };

  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [system, user],
      stream: false,
      options: {
        temperature: 0.1
      }
    })
  });

  if (!response.ok) {
    return '';
  }

  const data = await response.json();
  let summary = String(data?.message?.content || '').trim();

  if (target) {
    const low = summary.toLowerCase();
    const lowTarget = target.toLowerCase();
    const contradicts = (low.includes('no hay evidencia') || low.includes('no existe')) && !low.includes(lowTarget);
    if (contradicts) {
      const deterministic = buildDeterministicInspectionSummary(target, execution);
      if (deterministic) summary = deterministic;
    }
  }

  return summary;
}
