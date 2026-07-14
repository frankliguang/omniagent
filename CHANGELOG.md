# Changelog

All notable changes to OmniAgent CLI are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — M2 Multi-Agent Orchestration (iter 1-5 complete)

### iter 5 — Live wiring + resource cleanup + cross-process safety

#### Added
- **Live orchestration wiring** (`src/index.ts`): constructs the full dependency graph (TranscriptStore → LocalMemoryEngine → SidechainManager → BoundaryStore → TaskManager → TeammateRegistry → WorktreeRoster → MailboxService → SwarmTeam → ThreeStateRecovery with real restart callback → ShutdownHandshake → makeReActLoopRunnerFactory → Orchestrator) and injects all 5 deps into `createOrchestrationTools`. `allTools = [...BUILTIN_TOOLS, ...orchestrationTools]` flows into the live ReActLoop. `finally` block drains engine + main transcript.
- **ReActLoopSubAgentRunner** (`src/orchestration/react-loop-runner.ts`): adapts `ReActLoop.runTurn(prompt)` to `SubAgentRunner` interface; writes `TurnResult.messages` to sidechain via `sidechain.append`; exports `makeReActLoopRunnerFactory` factory.
- **Graceful shutdown cleanup** (`src/tools/builtin/orchestration/task-stop.ts`): on approve=true path, calls `swarmTeam.leaveTeam(teammateName)` (releases worktree + unregisters teammate) BEFORE `completeTask`; cleanup status surfaced in summary JSON as `"cleanup":{"ok":true|false}`.
- **CompactBoundary recording** (`src/orchestration/task-manager.ts`): `recordBoundary(task)` reads sidechain messages, builds boundary with `triggerLayer='L2_session'`, `compactRange={start:0, end:count-1}`; both `completeTask` and `failTask` invoke it when sidechainId present — enables `/rewind` to failure points.
- **Three-state recovery restart** (`src/orchestration/three-state-recovery.ts`): `RestartHandler` callback type; `restartTeammate` returns `recovered:false` for running state, delegates to injected callback otherwise; `src/index.ts` injects real callback (creates new sidechain + runs `runnerFactory(sidechainId).runTurn` + flushes). Mailbox unread preserved (restart doesn't consume).
- **Cross-process mailbox flock** (`src/memory/mailbox.ts`): `acquireMailboxFileLock` uses `fs.open(lockPath, 'wx', 0o600)` (O_EXCL) + PID file (`{pid}\n{timestamp}\n`) + stale detection (pid dead OR timestamp > 60s). Release only deletes if file's pid matches process.pid (no false-positive deletion of live locks). Double-locked: `withMailboxMutex` (L1 process) wraps `acquireMailboxFileLock` (L2 cross-process), `finally` releases.

#### Tested
- 11 new tests in `tests/orchestration/iter5-live-wiring.test.ts`: 5 tools constructed + no name conflicts + agent_router(sync) end-to-end + task_create(teammate) + send_message + task_output + graceful shutdown approve→release + CompactBoundary on complete + CompactBoundary on failTask + restart stopped → success + restart running → no-op.
- 4 new tests in `tests/memory/mailbox-cross-process-lock.test.ts`: .lock file exists during write + stale lock (pid dead) auto-cleaned + stale lock (timestamp > 60s) auto-cleaned + 2 Node child processes concurrent write 60 messages with zero loss.
- Full suite: 870 tests passing (up from 866 in iter 4; +4 new for iter 5). Typecheck clean.
- Adversarial probe: non-stale lock (alive pid + recent timestamp) correctly blocks write with `file_locked` and preserves lock file (no false-positive deletion).

### iter 4 — Recovery matrix + Docker distribution

#### Added
- **9-scenario recovery matrix** (`src/memory/recovery.ts`): `RecoveryHandler` interface + `RecoveryCoordinator` for 9 scenarios (corrupt_main / corrupt_sidechain / fork_missing / mode_mismatch / not_found / compact_circuit_breaker / mailbox_corruption / sidechain_orphan / boundary_missing).
- **Docker distribution**: `Dockerfile` (multi-stage build, `node:20-alpine` base), `docker-compose.yml` (resource limits: memory 512M / cpus 1.0 / pids 256), `scripts/docker-build.js` (buildx multi-arch: amd64+arm64), `.dockerignore`, `.env.example`.

#### Tested
- 9 new tests in `tests/memory/recovery.test.ts` covering all 9 scenarios.
- 10 new tests in `tests/orchestration/m2-exit-criteria.test.ts` covering all M2 exit criteria (16 concurrent sync/async agents, mailbox 1000 concurrent writes, fork prefix byte-identical, 9-scenario recovery matrix, Shutdown approve/reject).

### iter 3 — Swarm team + mailbox service

#### Added
- **SwarmTeam** (`src/orchestration/swarm-team.ts`): `joinTeam` (register teammate + assign worktree + send hello), `leaveTeam` (release worktree + unregister + send goodbye), `sendMessage` (send + auto-markRead on own mailbox).
- **TeammateRegistry** (`src/orchestration/teammate-registry.ts`): in-memory name→agentId+processId mapping, `assertNameStable` for fork-safety.
- **WorktreeRoster** (`src/orchestration/worktree-roster.ts`): `GitWorktreeOps` interface + `InMemoryWorktreeOps` mock implementation, `assign` / `release` / `get`.
- **MailboxService** (`src/orchestration/mailbox-service.ts`): high-level `send` / `readUnread` / `markRead` over `writeMailboxAtomic` + `readMailboxAll` + `markMailboxRead`.
- **ShutdownHandshake** (`src/orchestration/shutdown-handshake.ts`): 4-step handshake protocol — `sendRequest` (leader→teammate) → teammate `handleRequest` → `waitForResponse` (leader polls) → cleanup callback. Invariant #6: no `SIGKILL` on timeout, only `SIGTERM` + resource release.
- **ThreeStateRecovery** (`src/orchestration/three-state-recovery.ts`): `checkStatus` → 'running'/'stopped'/'evicted' (process alive + mailbox has unread → running; process dead + mailbox has unread → stopped; process dead + mailbox empty → evicted). `recover` strategies: 'restart' / 'requeue' / 'abandon'. `makeRealProcessAliveChecker` for production subprocess pid checking.

### iter 2 — Mailbox atomic write + task_create/task_stop/send_message tools

#### Added
- **Mailbox atomic write** (`src/memory/mailbox.ts`): `writeMailboxAtomic` (temp+rename + per-name Mutex + 10x exponential backoff 1ms-512ms), `readMailboxRaw` / `readMailboxAll` (with archive), `markMailboxRead`, `archiveMessages`. Capacity limits: 64KB single message / 4MB file / 1000 messages; archive triggers at 200.
- **task_create tool** (`src/tools/builtin/orchestration/task-create.ts`): factory `createTaskCreateTool({taskManager, swarmTeam, parentAgentId})`. Routes: sync/async/fork → taskManager; teammate → swarmTeam.joinTeam (register + worktree + hello).
- **task_stop tool** (`src/tools/builtin/orchestration/task-stop.ts`): factory `createTaskStopTool({taskManager, shutdownHandshake, threeStateRecovery, teammateRegistry, swarmTeam, parentAgentId, leaderName})`. Strategies: graceful (4-step handshake → leaveTeam → completeTask) / force (skip handshake, immediate leaveTeam + failTask).
- **send_message tool** (`src/tools/builtin/orchestration/send-message.ts`): factory `createSendMessageTool({mailboxService, parentAgentId})`. Validates `to` is registered teammate (unless leader self-send).

### iter 1 — Sidechain + TaskManager + Orchestrator + agent_router/task_output

#### Added
- **Sidechain transcript persistence** (`src/memory/sidechain.ts`): `MemoryEngine` interface + `LocalMemoryEngine` + `SidechainManager` facade. Sidechain files at `{sessionId}.sidechain-{sidechainId}.jsonl`, independent `DrainWriteQueue`, independent `CompactBoundary` (filtered by `transcriptId`).
- **Sidechain chain validation**: `TranscriptStore.walkChainBeforeParse` detects sidechain transcripts via path pattern and allows first message to have `parentUuid` (fork point back-reference to main transcript).
- **TaskManager** (`src/orchestration/task-manager.ts`): in-memory dual-track (WorkItem + RuntimeTask), `createDualTrack` / `completeTask` / `failTask` / `setSidechain` / `getOutput`.
- **SubAgentRunner interface** (`src/orchestration/sub-agent-runner.ts`): decouples orchestration from concrete ReActLoop, injectable factory for testing.
- **CoordinatorMode** (`src/orchestration/coordinator-mode.ts`): `spawnSync` (blocking) + `spawnAsync` (background spawn, immediate task_id return).
- **ForkAgentSpawner** (`src/orchestration/fork-agent-spawner.ts`): inherits parent context via `MemoryEngine.getCurrentMessages` + `fillPlaceholderToolResults` (injects placeholder tool_result for orphan tool_use, invariant #5 prompt cache prefix byte-identical). `verifyByteIdenticalPrefix` validator for tests.
- **Orchestrator** (`src/orchestration/orchestrator.ts`): `route()` dispatches sync/async/fork/teammate/remote (5 paths, invariant: 5 routes).
- **mergeAndFilterTools** (`src/tools/merge-filter-tools.ts`): dedup by name + coordinator role filter (removes bash/edit_file/write_file for coordinator agents).
- **agent_router tool** (`src/tools/builtin/orchestration/agent-router.ts`): factory `createAgentRouterTool({orchestrator, parentAgentId, traceIdGen})`, validates route ∈ {sync,async,fork,teammate,remote}.
- **task_output tool** (`src/tools/builtin/orchestration/task-output.ts`): factory `createTaskOutputTool({taskManager, sidechainManager?})`. Returns running status / completed with inline result / completed with sidechain fallback (last assistant message) / failed / not found.

### Tested
- 870 tests passing (up from 437 in M1 iter 3; +433 new for M2 iter 1-5).
- Typecheck clean (`tsc --noEmit` strict).
- Brand-neutrality precheck: no vendor-specific dependencies in orchestration layer.

### Known limitations (post-M2 scope)
- ReActLoopSubAgentRunner uses real ReActLoop (no mock in production path).
- TaskManager is in-memory only (no JSONL persistence; planned for M3).
- Remote route returns failed (RemoteAgentClient implemented but production wiring deferred to M3+).

## [0.1.0] — 2026-07-09 — M1 Walking Skeleton (iter 3 complete)

### Added
- **CLI entry** (`src/index.ts`): single-prompt mode (`-p`), `--version`, `--help`. M2 will add interactive REPL.
- **LLM providers**: OpenAI, Anthropic, AWS Bedrock (self-implemented SigV4 + EventStream binary parser, no @aws-sdk dependency), Ollama.
- **Provider capabilities**: streaming, tool calling, prompt caching, multi-modal, risk classification (declared but not enforced in M1).
- **Cost estimator**: BUILTIN_PRICES for OpenAI/Anthropic/Bedrock/Ollama with cache-aware pricing; custom price override via `registerPrice`; alias support via `registerAlias`.
- **ReAct loop** (`src/core/react-loop.ts`): FSM with 11 stop_reason branches, 5-layer degrader (5xx/stall/429), 429 exponential backoff (1s/2s/4s, cap 8s), 5xx degrade to fallbackModel (clear partial, retry once).
- **Termination handler** (`src/core/termination-handler.ts`): pure-function decision for all 11 stop_reason cases, exhaustiveness-checked at compile time.
- **Iteration limiter**: max5xx=1, max429=3, maxStallPassive=2, maxStallActive=1.
- **File tools** (`src/tools/builtin/`): `read_file`, `edit_file`, `write_file`, `glob`, `grep` (with ReDoS protection).
- **Shell tool**: `bash` with 24-item security checklist (mod-04 §4.3).
- **Working memory** (`src/memory/working-memory.ts`): L1 in-memory message list with role/role-validation.
- **Transcript store** (`src/memory/transcript.ts`): JSONL append-only with `walkChainBeforeParse` uuid chain validation, 4 views (raw/ui/activeQuery/apiWire).
- **Session compactor** (`src/memory/session-compact.ts`): L2 compression with tool_use/tool_result pairing repair (Pass 1 + Pass 2), COMPACTABLE_TOOLS whitelist (8 tools).
- **CompactBoundary** (`src/memory/boundary.ts`): compression point metadata for rewind.
- **Resume service** (`src/memory/resume.ts`): 4 scenario recovery (corrupt/fork_missing/mode_mismatch/not_found), atomic metadata persistence (temp+rename).
- **Memory file loader** (`src/memory/memory-loader.ts`): minimal YAML frontmatter parser, no gray-matter dependency, validates 4 memory types (user/feedback/project/reference), dedup by name.
- **MemoryRecaller** (`src/memory/recaller.ts`): findRelevantMemories via lightweight LLM scoring, confidence threshold filtering, LLM failure → skip recall (conversation continues).

### Tested
- 437 tests passing (unit + integration).
- Typecheck clean (`tsc --noEmit` strict).
- Brand-neutrality precheck: grep for vendor-specific terminology in core types/system-prompt.

### Known limitations (M1 scope)
- Interactive REPL not yet (M2).
- Skills (M4), MCP (M4), multi-agent orchestration (M2) not yet.
- Risk classifier (M3), sandbox (M3), hooks (M3) not yet.
- Cross-provider fallback chain (v2.x).

## [0.0.1] — 2026-06-15 — Initial scaffolding

Project bootstrap, L2 design doc draft.
