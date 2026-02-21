# AGENTS Guide

## Project overview
`voice-pc-agent` is a local-first voice/text assistant for filesystem and shell tasks.
Backend is Node.js + Express (`server.js`) and streams chat responses via SSE.
Primary chat orchestration lives in `lib/chat-route.js`.
Model calls target a local Ollama API (`lib/model.js`, `lib/setup.js`).
Desktop packaging/runtime is Electron (`electron/main.mjs`) with a browser renderer (`public/app.js`).
Renderer sends `_token`/`x-api-token` on all `/api/*` requests.
All runtime configuration constants are centralized in `lib/config.js`.

## Architecture map
`server.js`
→ `lib/chat-route.js`
  → `lib/config.js`
  → `lib/intent.js`
  → `lib/resolver.js` → `lib/config.js`, `lib/intent.js`, `lib/filesystem.js`
  → `lib/model.js` → `lib/config.js`, `lib/grounding.js`
  → `lib/filesystem.js` → `lib/config.js`
  → `lib/grounding.js` → `lib/executor.js`, `lib/resolver.js`
  → `lib/executor.js` → `lib/config.js`
  → `lib/session.js`
→ `lib/executor.js`
→ `lib/setup.js` → `lib/config.js`, `lib/executor.js`
→ `lib/session.js`

`electron/main.mjs` forks `server.js` and loads renderer URL with token.
`public/app.js` calls `/api/chat`, `/api/execute`, `/api/reject`, `/api/setup/*`.

## Module responsibilities
`server.js`: HTTP composition layer (Express setup, auth middleware, routes, intervals, listen), not business rules.
`lib/config.js`: Shared env/runtime constants; not request logic.
`lib/chat-route.js`: Full `/api/chat` pipeline + SSE lifecycle; not setup endpoints.
`lib/intent.js`: Intent/phrase detection and voice summary formatting; not filesystem access.
`lib/session.js`: In-memory session state and history helpers; not network/model calls.
`lib/resolver.js`: Target extraction/fuzzy resolution for folders; not command execution.
`lib/filesystem.js`: Safe path resolution and internal listing/inspection; not intent parsing.
`lib/executor.js`: Command safety checks, parsing, execution, pending-token store; not HTTP routing.
`lib/grounding.js`: Grounding/listing command builders and deterministic inspection summary; not subprocess execution.
`lib/model.js`: Ollama chat/summarization and history compaction; not HTTP/Express concerns.
`lib/setup.js`: Ollama setup checks/status helpers; not chat orchestration.
`electron/main.mjs`: Desktop lifecycle, backend process spawn, updater IPC, navigation hardening; not chat logic.
`public/app.js`: UI state, voice I/O, SSE consumption, API calls, pending confirmation UX; not backend policy.

## Critical paths (latency/correctness)
1. Chat request → first SSE token: `lib/chat-route.js:59` (SSE headers), `lib/chat-route.js:297` (`askModel`), `lib/model.js:63` (`onToken(delta)`), `lib/chat-route.js:298` (`sendSse`).
2. Filesystem intent → listing result: `lib/chat-route.js:73` (`detectListingIntent`), `lib/chat-route.js:260` (`runInternalListing`), `lib/chat-route.js:261` (`buildListingSummary`), `lib/chat-route.js:283` (`finish`).
3. Command execution → confirmation flow: `lib/chat-route.js:364` (`prepareCommandResponse`) → `server.js:131` (`/api/execute`) → `lib/executor.js:89` (`executeCommand`).

## Where to add things
- New intent detector: add in `lib/intent.js`, export it, wire in `lib/chat-route.js`; if filesystem-related, include in `FS_INTENTS` (`lib/chat-route.js:78`).
- New target-resolution heuristic: `lib/resolver.js` only.
- New internal filesystem read/list behavior: `lib/filesystem.js`.
- New shell command policy/type: `lib/executor.js` (and branch in `lib/chat-route.js` if chat-facing).
- New model prompt/LLM call behavior: `lib/model.js`.
- New setup capability/validation: `lib/setup.js` + route in `server.js`.
- New config variable: `lib/config.js` only; import where needed, never inline constants elsewhere.

## What NOT to do (anti-patterns)
- Never import from `server.js` inside `lib/*`.
- Never use `exec()`/shell parsing for user or LLM commands; keep `execFile` path in `lib/executor.js:89`.
- Never add `res.json()` inside `/api/chat`; keep SSE contract (`sendSse`/`finish`) in `lib/chat-route.js`.
- Never add sync FS calls (`readdirSync`, `existsSync`) in request hot paths.
- Never hardcode port, workdir, model, or Ollama host outside `lib/config.js`.

## Running and testing
- Start backend: `npm start`
- Start desktop app: `npm run desktop`
- Syntax check (current lint-equivalent): `npm run check`
- Direct check command: `node --check server.js && node --check lib/*.js`
- No automated test suite is defined yet; if added, document command here.

## Security invariants (must never be broken)
- API auth token is mandatory on every `/api/*` route (`server.js:33`).
- Backend binds to localhost only (`server.js:159` uses `127.0.0.1`).
- User/LLM commands execute via `execFile` tokenization, not shell expansion (`lib/executor.js:56`, `lib/executor.js:117`).
- Blocklist check remains active before command execution (`lib/executor.js:104` and chat-level guard `lib/chat-route.js:339`).
- Electron renderer cannot navigate to external origins (`electron/main.mjs:75`).
