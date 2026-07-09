# Changelog

All notable changes to OmniAgent CLI are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
