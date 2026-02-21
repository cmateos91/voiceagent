// chat-route: Implementa el pipeline principal de /api/chat con SSE, intents, ejecución y resumen.
import { AUTO_EXEC_READONLY, AUTO_SUMMARIZE_READS, STRICT_GROUNDED_FS } from './config.js';
import {
  buildVoiceSummary,
  detectCorrectionIntent,
  detectListingIntent,
  detectLongSummaryRequest,
  detectSummaryIntent,
  detectTargetDeclarationIntent,
  isFilesystemIntent,
  wantsHiddenEntries
} from './intent.js';
import {
  extractTargetFromText,
  getOrdinalIndexFromText,
  getSuggestionOrdinalIndex,
  isOrdinalSelectionUtterance,
  referencesPreviousTarget,
  resolveTargetFromContext,
  resolveTargetInWorkdir,
  suggestTargets
} from './resolver.js';
import { compactHistoryForModel, askModel, summarizeExecution } from './model.js';
import { runInternalInspection, runInternalListing } from './filesystem.js';
import { buildGroundingCommand, buildListingSummary } from './grounding.js';
import {
  executeCommand,
  isBlockedCommand,
  isReadOnlyCommand,
  prepareCommandResponse
} from './executor.js';
import {
  getLastUserMessage,
  getSessionState,
  hasRecentExecutionEvidence
} from './session.js';

export function createChatHandler() {
  return async function chatHandler(req, res) {
    try {
      let streamClosed = false;
      const sendSse = (payload) => {
        if (streamClosed || res.writableEnded) return;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const endSse = (payload) => {
        if (!streamClosed) sendSse({ type: 'final', payload });
        if (!res.writableEnded) res.end();
        streamClosed = true;
      };
      const finish = (payload, _branch) => endSse(payload);
      const chunkText = (text, size = 120) => {
        const value = String(text || '');
        const chunks = [];
        for (let i = 0; i < value.length; i += size) chunks.push(value.slice(i, i + size));
        return chunks;
      };

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      res.on('close', () => {
        streamClosed = true;
      });

      const sessionId = String(req.body?.sessionId || 'default');
      const memory = getSessionState(sessionId);
      const history = compactHistoryForModel(req.body?.history);
      const lastUserMessage = getLastUserMessage(history);
      const fsIntent = isFilesystemIntent(lastUserMessage);
      const hasEvidence = hasRecentExecutionEvidence(history);
      const listingIntent = detectListingIntent(lastUserMessage);
      const summaryIntent = detectSummaryIntent(lastUserMessage);
      const longSummaryRequested = detectLongSummaryRequest(lastUserMessage);
      const declarationIntent = detectTargetDeclarationIntent(lastUserMessage);
      const correctionIntent = detectCorrectionIntent(lastUserMessage);
      const FS_INTENTS = new Set(['filesystem', 'summary', 'declaration', 'correction', 'listing:dirs', 'listing:files', 'listing:entries']);
      const detectedIntents = new Set(
        [
          fsIntent ? 'filesystem' : null,
          summaryIntent ? 'summary' : null,
          declarationIntent ? 'declaration' : null,
          correctionIntent ? 'correction' : null,
          listingIntent ? `listing:${listingIntent}` : null
        ].filter(Boolean)
      );
      const extractedTarget = extractTargetFromText(lastUserMessage);
      let resolvedTargetFromContext = null;
      if ([...detectedIntents].some((intent) => FS_INTENTS.has(intent))) {
        resolvedTargetFromContext = await resolveTargetFromContext({ userText: lastUserMessage, extractedTarget, memory });
        if (!resolvedTargetFromContext && referencesPreviousTarget(lastUserMessage) && memory.lastTarget && memory.lastTarget !== '.') {
          resolvedTargetFromContext = memory.lastTarget;
        }
      }
      const ordinalIndex = getOrdinalIndexFromText(lastUserMessage, memory.lastListing.length);
      const ordinalTarget = ordinalIndex !== null && memory.lastListing[ordinalIndex] ? memory.lastListing[ordinalIndex] : null;
      const suggestionOrdinalIndex = getSuggestionOrdinalIndex(lastUserMessage, memory.lastSuggestions.length);
      const suggestionTarget =
        suggestionOrdinalIndex !== null && memory.lastSuggestions[suggestionOrdinalIndex]
          ? memory.lastSuggestions[suggestionOrdinalIndex]
          : null;

      const streamDeferredSummary = async (basePayload, summarizeFn, branch) => {
        const quickMessage =
          basePayload.message ||
          `Comando ${basePayload.ok ? 'ejecutado' : 'con error'}: ${basePayload.command || 'sin comando'}`;
        sendSse({
          type: 'executed',
          payload: {
            type: 'executed',
            message: quickMessage,
            ok: Boolean(basePayload.ok),
            command: basePayload.command || '',
            cwd: basePayload.cwd || '',
            stdout: String(basePayload.stdout || ''),
            stderr: String(basePayload.stderr || '')
          }
        });

        const summary = AUTO_SUMMARIZE_READS ? await summarizeFn() : '';
        if (streamClosed || res.writableEnded) {
          console.log('[summary] skipped, client disconnected');
          return;
        }

        if (summary) {
          for (const piece of chunkText(summary)) sendSse({ type: 'token', delta: piece });
        }
        sendSse({ type: 'summary_complete' });

        return finish(
          {
            ...basePayload,
            summary,
            voiceSummary: buildVoiceSummary(summary, longSummaryRequested)
          },
          branch
        );
      };

      if (suggestionTarget) {
        memory.lastTarget = suggestionTarget;
        memory.lastSuggestions = [];
        memory.notes = [`Ultimo objetivo: ${memory.lastTarget}`];
        if (memory.pendingIntent === 'summary') {
          const execution = await runInternalInspection({ target: memory.lastTarget, includeHidden: true });
          memory.pendingIntent = null;
          return streamDeferredSummary(
            {
              type: 'executed',
              autoApproved: true,
              message: `Seleccioné ${memory.lastTarget} (opcion ${suggestionOrdinalIndex + 1}) y generé el resumen.`,
              ...execution
            },
            () => summarizeExecution(lastUserMessage, execution, { target: memory.lastTarget }),
            'suggestion_target_summary'
          );
        }
        memory.pendingIntent = null;
        return finish(
          {
            type: 'reply',
            message: `Perfecto, elijo ${memory.lastTarget} (opcion ${suggestionOrdinalIndex + 1}).`
          },
          'suggestion_target_reply'
        );
      }

      if (
        ordinalTarget &&
        (summaryIntent || correctionIntent || referencesPreviousTarget(lastUserMessage) || isOrdinalSelectionUtterance(lastUserMessage))
      ) {
        memory.lastTarget = ordinalTarget;
        memory.lastSuggestions = [];
        memory.notes = [`Ultimo objetivo: ${memory.lastTarget}`];
        memory.pendingIntent = null;
        return finish(
          {
            type: 'reply',
            message: `Perfecto, tomo ${memory.lastTarget} como carpeta objetivo. Dime si quieres un resumen o listar su contenido.`
          },
          'ordinal_target_reply'
        );
      }

      if (declarationIntent) {
        if (resolvedTargetFromContext) {
          memory.lastTarget = resolvedTargetFromContext;
          memory.lastSuggestions = [];
          memory.notes = [`Ultimo objetivo: ${memory.lastTarget}`];
          memory.pendingIntent = null;
          return finish(
            {
              type: 'reply',
              message: `Perfecto, tomo ${memory.lastTarget} como carpeta objetivo para los siguientes pasos.`
            },
            'declaration_resolved'
          );
        }
        const suggestions = await suggestTargets(lastUserMessage, memory);
        const hint = suggestions.length
          ? `No identifique ese nombre con certeza. ¿Te refieres a: ${suggestions.join(', ')}?`
          : 'No identifique ese nombre con certeza. Dime el nombre exacto de la carpeta.';
        memory.lastSuggestions = suggestions;
        memory.pendingIntent = 'set_target';
        return finish({ type: 'reply', message: hint }, 'declaration_suggestions');
      }

      if (correctionIntent && resolvedTargetFromContext) {
        memory.lastTarget = resolvedTargetFromContext;
        memory.lastSuggestions = [];
        memory.notes = [`Ultimo objetivo: ${memory.lastTarget}`];
        memory.pendingIntent = null;
        return finish(
          {
            type: 'reply',
            message: `Entendido, te refieres a ${memory.lastTarget}.`
          },
          'correction_resolved'
        );
      }

      if (summaryIntent) {
        if (!resolvedTargetFromContext && memory.lastTarget && memory.lastTarget !== '.') {
          resolvedTargetFromContext = memory.lastTarget;
        }
        if (!resolvedTargetFromContext) {
          const suggestions = await suggestTargets(lastUserMessage, memory);
          const hint = suggestions.length
            ? `No identifique la carpeta exacta. ¿Te refieres a: ${suggestions.join(', ')}?`
            : 'No identifique la carpeta exacta. Dime el nombre exacto o deletrealo.';
          memory.lastSuggestions = suggestions;
          memory.pendingIntent = 'summary';
          return finish({ type: 'reply', message: hint }, 'summary_suggestions');
        }

        const execution = await runInternalInspection({ target: resolvedTargetFromContext, includeHidden: true });
        if (execution.ok) {
          memory.lastTarget = resolvedTargetFromContext;
          memory.notes = [`Ultimo objetivo: ${memory.lastTarget}`];
        }
        memory.pendingIntent = null;
        return streamDeferredSummary(
          {
            type: 'executed',
            autoApproved: true,
            message: 'Inspeccion de carpeta objetivo para resumen.',
            ...execution
          },
          () => summarizeExecution(lastUserMessage, execution, { target: resolvedTargetFromContext }),
          'summary_execution'
        );
      }

      if (listingIntent) {
        const fallbackTarget = referencesPreviousTarget(lastUserMessage) ? memory.lastTarget : '.';
        const resolvedTarget = resolvedTargetFromContext || fallbackTarget;
        const includeHidden = wantsHiddenEntries(lastUserMessage);
        const execution = await runInternalListing({ listingIntent, target: resolvedTarget, includeHidden });
        const summary = buildListingSummary({
          listingIntent,
          includeHidden,
          target: resolvedTarget,
          stdout: execution.stdout,
          stderr: execution.stderr
        });
        if (execution.ok) {
          memory.lastTarget = resolvedTarget;
          memory.lastSuggestions = [];
          memory.lastListing = String(execution.stdout || '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 80);
          memory.notes = [
            `Ultimo objetivo: ${memory.lastTarget}`,
            `Ultimo listado (${memory.lastListing.length} elementos): ${memory.lastListing.slice(0, 12).join(', ')}`
          ];
        }
        memory.pendingIntent = null;

        return finish(
          {
            type: 'executed',
            autoApproved: true,
            message: 'Listado directo del sistema de archivos.',
            summary,
            voiceSummary: buildVoiceSummary(summary, longSummaryRequested),
            ...execution
          },
          'listing_execution'
        );
      }

      const memoryContext = memory.notes.join('\n');
      const result = await askModel(history, lastUserMessage, memoryContext, (delta) => {
        sendSse({ type: 'token', delta });
      });

      if (result.type === 'reply' && (result.message === 'No te entendi bien.' || result.message.includes('No pude interpretar'))) {
        const suggestions = await suggestTargets(lastUserMessage, memory);
        const hint = suggestions.length
          ? `No te entendí bien. ¿Te refieres a: ${suggestions.join(', ')}?`
          : 'No te entendí bien. Repite la frase o dime el nombre exacto de la carpeta.';
        return finish({ type: 'reply', message: hint }, 'model_not_understood');
      }

      if (STRICT_GROUNDED_FS && fsIntent && !hasEvidence && result.type !== 'command') {
        const fallbackTarget = resolvedTargetFromContext || '.';
        if (AUTO_EXEC_READONLY) {
          const execution = await runInternalInspection({ target: fallbackTarget, includeHidden: true });
          return streamDeferredSummary(
            {
              type: 'executed',
              autoApproved: true,
              message: 'Para responder con precisión inspeccioné primero el sistema de archivos y aquí tienes el resultado.',
              ...execution
            },
            () => summarizeExecution(lastUserMessage, execution),
            'grounded_fs_auto_execution'
          );
        }
        const groundingCommand = await buildGroundingCommand(lastUserMessage, resolvedTargetFromContext);
        return finish(
          prepareCommandResponse(
            groundingCommand,
            'Para responder con precisión necesito inspeccionar primero el sistema de archivos. Te propongo este comando de inspección.'
          ),
          'grounded_fs_command'
        );
      }

      if (result.type === 'command' && typeof result.command === 'string') {
        const command = result.command.trim();
        if (!command) {
          return finish({ type: 'reply', message: 'No se recibió comando para ejecutar.' }, 'empty_command');
        }
        if (isBlockedCommand(command)) {
          return finish({ type: 'reply', message: `Bloqueé ese comando por seguridad: ${command}` }, 'blocked_command');
        }

        if (AUTO_EXEC_READONLY && isReadOnlyCommand(command)) {
          const execution = await executeCommand(command);
          if (execution.ok) {
            const extracted = extractTargetFromText(lastUserMessage);
            const resolvedTarget = await resolveTargetInWorkdir(extracted, lastUserMessage);
            if (resolvedTarget) memory.lastTarget = resolvedTarget;
            memory.lastSuggestions = [];
            memory.notes = [`Ultimo objetivo: ${memory.lastTarget}`];
          }
          return streamDeferredSummary(
            {
              type: 'executed',
              autoApproved: true,
              message: result.message,
              ...execution
            },
            () => summarizeExecution(lastUserMessage, execution),
            'readonly_command_execution'
          );
        }

        return finish(prepareCommandResponse(command, result.message), 'command_requires_approval');
      }

      return finish(
        {
          type: 'reply',
          message: String(result.message)
        },
        'model_reply'
      );
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'error', message: error.message || 'Error inesperado en /api/chat' })}\n\n`);
          res.end();
        }
        return;
      }
      return res.status(500).json({ error: error.message || 'Error inesperado en /api/chat' });
    }
  };
}
