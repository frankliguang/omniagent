# OmniAgent CLI

Brand-neutral AI coding assistant — a TypeScript CLI that wraps LLM providers (OpenAI, Anthropic, AWS Bedrock, Ollama) with a ReAct loop, file/shell tools, and layered memory.

**Status**: M1 Walking Skeleton (v0.1.0). Single-prompt mode only; interactive REPL lands in M2.

## Install

```bash
npm install -g omniagent-cli
```

Or via Homebrew (M1):

```bash
brew install omniagent/tap/omniagent
```

## Quick start

```bash
# Set credentials (any one provider)
export OMNIAGENT_LLM_PROVIDER=openai        # or anthropic / bedrock / ollama
export OMNIAGENT_LLM_API_KEY=sk-...        # provider API key

# Run a single prompt
omniagent -p "list files in current directory"

# Or with explicit model
omniagent -p "explain src/index.ts" --model gpt-4o
```

For AWS Bedrock, you can use either `OMNIAGENT_LLM_API_KEY=accessKeyId:secretAccessKey[:sessionToken]` or the standard `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_SESSION_TOKEN` environment variables.

For Ollama (local), no API key needed — just have `ollama serve` running on `localhost:11434`.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OMNIAGENT_LLM_PROVIDER` | Provider id (`openai` / `anthropic` / `bedrock` / `ollama`) | `openai` |
| `OMNIAGENT_LLM_API_KEY` | API key for the provider | — |
| `OMNIAGENT_LLM_MODEL` | Model id (e.g. `gpt-4o`, `claude-sonnet-4-5`) | provider-specific |
| `OMNIAGENT_LLM_FALLBACK` | Fallback model (same provider, 5xx degrade) | — |
| `OMNIAGENT_LLM_BASE_URL` | Custom endpoint (optional) | — |
| `AWS_ACCESS_KEY_ID` | Bedrock alt credential source | — |
| `AWS_SECRET_ACCESS_KEY` | Bedrock alt credential source | — |
| `AWS_SESSION_TOKEN` | Bedrock alt credential source (optional) | — |

## SDK usage

OmniAgent is also embeddable as a TypeScript SDK:

```typescript
import { ReActLoop } from 'omniagent-cli/core';
import { WorkingMemory } from 'omniagent-cli/memory';
import { ProviderRegistry } from 'omniagent-cli/providers';
import { BUILTIN_TOOLS } from 'omniagent-cli/tools';

const registry = ProviderRegistry.create();
const provider = registry.get('openai');
await provider.authenticate({ type: 'api_key', apiKey: process.env.OPENAI_API_KEY!, providerId: 'openai' });

const loop = new ReActLoop({
  provider,
  memory: new WorkingMemory(),
  tools: BUILTIN_TOOLS,
  model: 'gpt-4o',
  systemPrompt: 'You are a helpful assistant.',
});

const result = await loop.runTurn('read package.json and summarize');
console.log(result);
```

## Architecture

Four-layer architecture (per L2 system design):

- **UI layer**: CLI entry (`src/index.ts`) — argument parsing, stdout streaming
- **Harness layer**: ReAct loop (`src/core/react-loop.ts`), memory (`src/memory/`)
- **LLM layer**: Provider abstraction (`src/providers/`) — OpenAI, Anthropic, Bedrock (SigV4 + EventStream), Ollama
- **Tool layer**: File/Shell tools (`src/tools/builtin/`) — read/edit/write/glob/grep/bash

Key design decisions (frozen at M0):

- **Brand-neutral**: No provider-specific terminology in core types or system prompts
- **Provider abstraction**: `LLMProvider` interface with `chat` / `chatStream` / `countTokens` / `estimateCost` + `capabilities` declaration
- **ReAct loop with 11-way stop_reason handling**: `end_turn` / `tool_use` / `max_output_tokens` / `ptl` / `user_interrupt` / `stall_passive_30s` / `stall_active_90s` / `provider_5xx` / `provider_429` / `tool_execution_error` / `budget_exceeded`
- **Fallback model (same provider)**: 5xx → switch to `fallbackModel`, clear partial output, retry once
- **Layered memory**: L1 working memory / L2 session memory / L3 project memory (`~/.omniagent/memory/*.md`) / L4 system prompt
- **findRelevantMemories**: Lightweight LLM-based recall (recall@5 ≥ 0.8, precision@5 ≥ 0.7)

## Development

```bash
# Install deps
npm install

# Typecheck
npm run typecheck

# Run tests
npm test

# Run a single test file
npx tsx --test tests/core/react-loop.test.ts

# Build
npm run build

# Pre-publish precheck (brand neutrality + types + tests)
npm run precheck
```

## License

MIT — see [LICENSE](./LICENSE).
