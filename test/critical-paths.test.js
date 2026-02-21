import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectCorrectionIntent,
  detectListingIntent,
  detectSummaryIntent
} from '../lib/intent.js';
import {
  isBlockedCommand,
  isReadOnlyCommand,
  parseCommand
} from '../lib/executor.js';
import {
  API_TOKEN,
  AUTO_EXEC_READONLY,
  EXEC_WORKDIR,
  OLLAMA_HOST,
  PORT,
  STRICT_GROUNDED_FS
} from '../lib/config.js';
import {
  getLastUserMessage,
  getSessionState
} from '../lib/session.js';
import { chooseClosestCandidate } from '../lib/resolver.js';

describe('lib/intent.js', () => {
  it("detectSummaryIntent('resúmeme el proyecto') -> true", () => {
    assert.equal(detectSummaryIntent('resúmeme el proyecto'), true);
  });

  it("detectSummaryIntent('hola qué tal') -> false", () => {
    assert.equal(detectSummaryIntent('hola qué tal'), false);
  });

  it("detectListingIntent('lista los archivos') -> truthy", () => {
    assert.notEqual(detectListingIntent('lista los archivos'), null);
  });

  it("detectListingIntent('buenos días') -> null", () => {
    assert.equal(detectListingIntent('buenos días'), null);
  });

  it("detectCorrectionIntent('no era esa carpeta sino Documents') -> true", () => {
    assert.equal(detectCorrectionIntent('no era esa carpeta sino Documents'), true);
  });

  it("detectCorrectionIntent('continúa') -> false", () => {
    assert.equal(detectCorrectionIntent('continúa'), false);
  });
});

describe('lib/executor.js', () => {
  it("isBlockedCommand('rm -rf /') -> true", () => {
    assert.equal(isBlockedCommand('rm -rf /'), true);
  });

  it("isBlockedCommand('ls -la') -> false", () => {
    assert.equal(isBlockedCommand('ls -la'), false);
  });

  it("parseCommand('ls -la \"my folder\"') -> ['ls','-la','my folder']", () => {
    assert.deepEqual(parseCommand('ls -la "my folder"'), ['ls', '-la', 'my folder']);
  });

  it("parseCommand('ls; rm -rf .') keeps semicolon in token", () => {
    assert.deepEqual(parseCommand('ls; rm -rf .'), ['ls;', 'rm', '-rf', '.']);
  });

  it("parseCommand('') -> null", () => {
    assert.equal(parseCommand(''), null);
  });

  it('parseCommand on unterminated quote -> null', () => {
    assert.equal(parseCommand('"unclosed'), null);
  });

  it("isReadOnlyCommand('ls -la') -> true", () => {
    assert.equal(isReadOnlyCommand('ls -la'), true);
  });

  it("isReadOnlyCommand('rm -rf .') -> false", () => {
    assert.equal(isReadOnlyCommand('rm -rf .'), false);
  });
});

describe('lib/config.js', () => {
  it('PORT is a number', () => {
    assert.equal(typeof PORT, 'number');
  });

  it('EXEC_WORKDIR is a non-empty string', () => {
    assert.equal(typeof EXEC_WORKDIR === 'string' && EXEC_WORKDIR.length > 0, true);
  });

  it("OLLAMA_HOST starts with 'http'", () => {
    assert.equal(OLLAMA_HOST.startsWith('http'), true);
  });

  it('API_TOKEN is a non-empty string', () => {
    assert.equal(typeof API_TOKEN === 'string' && API_TOKEN.length > 0, true);
  });

  it('STRICT_GROUNDED_FS is boolean', () => {
    assert.equal(typeof STRICT_GROUNDED_FS, 'boolean');
  });

  it('AUTO_EXEC_READONLY is boolean', () => {
    assert.equal(typeof AUTO_EXEC_READONLY, 'boolean');
  });
});

describe('lib/session.js', () => {
  it('getSessionState returns object with session memory arrays', () => {
    const state = getSessionState('session_test_shape');
    assert.equal(
      typeof state === 'object' && Array.isArray(state.lastListing) && Array.isArray(state.lastSuggestions) && Array.isArray(state.notes),
      true
    );
  });

  it('same sessionId returns same object reference', () => {
    assert.strictEqual(getSessionState('same_ref'), getSessionState('same_ref'));
  });

  it('different sessionIds return different object references', () => {
    assert.notStrictEqual(getSessionState('id_a'), getSessionState('id_b'));
  });

  it('getLastUserMessage returns last user content', () => {
    const history = [
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'último mensaje' }
    ];
    assert.equal(getLastUserMessage(history), 'último mensaje');
  });
});

describe('lib/resolver.js', () => {
  it("chooseClosestCandidate contains-match 'android' -> 'AndroidDevelpment'", () => {
    assert.equal(
      chooseClosestCandidate('android', ['AndroidDevelpment', 'Unity', 'FutbolDB']),
      'AndroidDevelpment'
    );
  });

  it("chooseClosestCandidate contains-match 'recetas' -> 'recetas-mama'", () => {
    assert.equal(
      chooseClosestCandidate('recetas', ['recetas-mama', 'Unity', 'Monad']),
      'recetas-mama'
    );
  });
});
