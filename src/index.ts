#!/usr/bin/env node
/**
 * OmniAgent CLI 入口（L2 §11.1 — M1 Walking Skeleton）
 *
 * M1 单 prompt 模式：
 *   omniagent -p "your prompt"
 *   omniagent --prompt "your prompt"
 *   omniagent --version
 *   omniagent --help
 *
 * 交互式 REPL 在 M2 交付（M1 仅 walking skeleton）。
 *
 * 环境变量：
 *   OMNIAGENT_LLM_PROVIDER   — openai / anthropic / bedrock / ollama（默认 openai）
 *   OMNIAGENT_LLM_API_KEY    — provider api key（Bedrock 用 accessKeyId:secretAccessKey）
   OMNIAGENT_LLM_MODEL      — 模型 id（默认按 provider 选）
 *   OMNIAGENT_LLM_FALLBACK   — fallback 模型（可选）
 *   OMNIAGENT_LLM_BASE_URL   — 自定义 endpoint（可选）
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN — Bedrock 备选
 *   HOME                      — 默认 ~/.omniagent/{memory,logs,transcripts}
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { ReActLoop, type StreamRenderer } from './core/react-loop.js';
import { WorkingMemory } from './memory/working-memory.js';
import { TranscriptStore } from './memory/transcript.js';
import { LocalMemoryEngine, SidechainManager } from './memory/sidechain.js';
import { BoundaryStore, defaultBoundaryPath } from './memory/boundary.js';
import { ProviderRegistry } from './providers/registry.js';
import { CredentialsStore } from './providers/credentials.js';
import { MemoryRecaller, setMemoryRecaller } from './memory/recaller.js';
import { BUILTIN_TOOLS } from './tools/builtin/index.js';
import { createOrchestrationTools } from './tools/builtin/orchestration/index.js';
import {
  TaskManager,
  Orchestrator,
  SwarmTeam,
  TeammateRegistry,
  WorktreeRoster,
  InMemoryWorktreeOps,
  MailboxService,
  ShutdownHandshake,
  ThreeStateRecovery,
  makeReActLoopRunnerFactory,
} from './orchestration/index.js';
import type { AgentId, MailboxName, Credentials, LLMProvider, Tool } from './types/index.js';

export const VERSION = '0.1.0';
const DEFAULT_MODEL: Record<string, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-5',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v1:0',
  ollama: 'llama3.1',
};

const HELP_TEXT = `
OmniAgent CLI — 品牌中立的 AI 编程助手（v${VERSION}）

用法:
  omniagent -p <prompt>          单 prompt 模式（M1 walking skeleton）
  omniagent --prompt <prompt>    同上
  omniagent --version            打印版本号
  omniagent --help               打印此帮助

环境变量:
  OMNIAGENT_LLM_PROVIDER    openai / anthropic / bedrock / ollama（默认 openai）
  OMNIAGENT_LLM_API_KEY     provider api key
  OMNIAGENT_LLM_MODEL       模型 id（默认按 provider 选）
  OMNIAGENT_LLM_FALLBACK    fallback 模型（可选）
  OMNIAGENT_LLM_BASE_URL    自定义 endpoint（可选）

示例:
  OMNIAGENT_LLM_PROVIDER=openai \\
  OMNIAGENT_LLM_API_KEY=sk-... \\
  omniagent -p "list files in current directory"

M1 walking skeleton：仅支持单 prompt 模式。交互式 REPL、多轮对话、流式渲染
将在 M2 交付。详细文档见 https://github.com/omniagent/omniagent
`.trim();

interface CliArgs {
  prompt?: string;
  showVersion: boolean;
  showHelp: boolean;
  model?: string;
}

/** 解析命令行参数 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { showVersion: false, showHelp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '-p':
      case '--prompt':
        args.prompt = argv[++i];
        break;
      case '-m':
      case '--model':
        args.model = argv[++i];
        break;
      case '-v':
      case '--version':
        args.showVersion = true;
        break;
      case '-h':
      case '--help':
        args.showHelp = true;
        break;
      default:
        if (a.startsWith('--prompt=')) {
          args.prompt = a.slice('--prompt='.length);
        } else if (a.startsWith('--model=')) {
          args.model = a.slice('--model='.length);
        } else if (!args.prompt && !a.startsWith('-')) {
          args.prompt = a;
        }
        break;
    }
  }
  return args;
}

/** 从环境变量构造凭证 */
function buildCredentials(providerId: string): Credentials | undefined {
  // Bedrock 优先看 AWS_*
  if (providerId === 'bedrock') {
    const akId = process.env.AWS_ACCESS_KEY_ID;
    const sak = process.env.AWS_SECRET_ACCESS_KEY;
    const st = process.env.AWS_SESSION_TOKEN;
    if (akId && sak) {
      const apiKey = st ? `${akId}:${sak}:${st}` : `${akId}:${sak}`;
      return { type: 'api_key', apiKey, providerId };
    }
  }
  const apiKey = process.env.OMNIAGENT_LLM_API_KEY;
  if (!apiKey) return undefined;
  return { type: 'api_key', apiKey, providerId };
}

/** 初始化 provider（含认证） */
async function initProvider(): Promise<{ provider: LLMProvider; model: string; fallbackModel?: string }> {
  const providerId = process.env.OMNIAGENT_LLM_PROVIDER ?? 'openai';
  const registry = ProviderRegistry.create(new CredentialsStore());
  const provider = registry.find(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}. Available: ${registry.list().map(p => p.id).join(', ')}`);
  }

  const creds = buildCredentials(providerId);
  if (!creds) {
    throw new Error(
      `No credentials for provider "${providerId}". ` +
      `Set OMNIAGENT_LLM_API_KEY${providerId === 'bedrock' ? ' or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY' : ''}.`,
    );
  }

  const authResult = await provider.authenticate(creds);
  if (!authResult.success) {
    throw new Error(`Authentication failed for ${providerId}: ${authResult.errorMessage ?? authResult.error}`);
  }

  const model = process.env.OMNIAGENT_LLM_MODEL ?? DEFAULT_MODEL[providerId] ?? 'gpt-4o';
  const fallbackModel = process.env.OMNIAGENT_LLM_FALLBACK;
  return { provider, model, fallbackModel };
}

/** 默认 system prompt（M1 stub，M2 由 L4 system prompt 模块组装） */
const DEFAULT_SYSTEM_PROMPT = `You are OmniAgent, a brand-neutral AI coding assistant.

You can use tools to read/write files, run shell commands, and search codebases.
Always use tools when the user asks for file operations or code search. Prefer
read tools (read_file, glob, grep) before making changes. Confirm with the user
before destructive operations (delete, overwrite, force-push).

Current working directory: ${process.cwd()}`;

/** 流式渲染器：实时打印 LLM 输出到 stdout */
function makeStdoutRenderer(): StreamRenderer {
  return {
    onTextDelta: (text) => process.stdout.write(text),
    onToolUseStart: (_id, name) => process.stdout.write(`\n[tool_use: ${name}]\n`),
    onToolUseDelta: () => {},
    onToolUseEnd: () => {},
    onMessageEnd: (stopReason) => {
      if (stopReason !== 'end_turn') {
        process.stdout.write(`\n[stop: ${stopReason}]\n`);
      }
    },
  };
}

/** 确保 ~/.omniagent 目录存在 */
async function ensureDirs(): Promise<void> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const dirs = [
    path.join(home, '.omniagent'),
    path.join(home, '.omniagent', 'memory'),
    path.join(home, '.omniagent', 'logs'),
    path.join(home, '.omniagent', 'transcripts'),
  ];
  for (const d of dirs) {
    try {
      await fs.mkdir(d, { recursive: true });
    } catch {
      // 忽略创建失败
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.showHelp) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (args.showVersion) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (!args.prompt) {
    process.stdout.write(`${HELP_TEXT}\n`);
    process.exit(1);
  }

  await ensureDirs();

  // 初始化 provider
  let provider: LLMProvider;
  let model: string;
  let fallbackModel: string | undefined;
  try {
    const init = await initProvider();
    provider = init.provider;
    model = init.fallbackModel ? args.model ?? init.model : init.model;
    fallbackModel = init.fallbackModel;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exit(2);
  }

  // 初始化 MemoryRecaller（注入 provider，M1 stub）
  const recaller = new MemoryRecaller(provider);
  setMemoryRecaller(recaller);

  // 召回相关记忆（失败不阻断主流程）
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;
  try {
    const relevant = await recaller.findRelevantMemories(args.prompt);
    if (relevant.length > 0) {
      const memText = relevant
        .map(m => `## ${m.frontmatter.name}\n${m.body}`)
        .join('\n\n');
      systemPrompt = `${systemPrompt}\n\n# Relevant memories\n\n${memText}`;
    }
  } catch {
    // 召回失败不影响主流程
  }

  // 构造编排组件（M2 iter 5）
  // - TaskManager + SidechainManager + Orchestrator: agent_router 5 路径
  // - SwarmTeam + TeammateRegistry + WorktreeRoster + MailboxService: teammate 路径
  // - ShutdownHandshake + ThreeStateRecovery: task_stop graceful/force 路径
  // - makeReActLoopRunnerFactory: 子 agent ReActLoop 适配 SubAgentRunner
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const sessionId = randomUUID();
  const mainTranscriptPath = path.join(home, '.omniagent', 'transcripts', `${sessionId}.jsonl`);
  const mainTranscript = await TranscriptStore.load(mainTranscriptPath);
  const engine = new LocalMemoryEngine(sessionId, mainTranscript);
  const sidechainManager = new SidechainManager(engine);
  const boundaryStore = new BoundaryStore({
    boundaryPath: defaultBoundaryPath(sessionId),
  });
  const taskManager = new TaskManager({ boundaryStore, sidechain: sidechainManager });
  const teammateRegistry = new TeammateRegistry();
  const worktreeBaseDir = path.join(home, '.omniagent', 'worktrees');
  const worktreeRoster = new WorktreeRoster(new InMemoryWorktreeOps(worktreeBaseDir));
  const mailboxService = new MailboxService();
  const swarmTeam = new SwarmTeam(mailboxService, teammateRegistry, worktreeRoster);
  const threeStateRecovery = new ThreeStateRecovery(
    teammateRegistry,
    mailboxService,
    worktreeRoster,
    taskManager,
    {
      // M2 iter 5: 注入 restart 回调
      // 调用 sidechainManager.create + runnerFactory.spawn 重新跑一轮子 agent
      // mailbox 未读消息保留（restart 不消费，由新 teammate 读取）
      restart: async (teammateName) => {
        const teammate = await teammateRegistry.get(teammateName);
        if (!teammate) {
          throw new Error(`cannot restart unregistered teammate "${teammateName}"`);
        }
        // 创建新 sidechain（保留原 sidechain 数据，新建一个用于新 turn）
        const sidechainId = await sidechainManager.create({
          parentTranscriptId: sessionId as never,
          runtimeTaskId: 'restart-' + Date.now() as never,
        });
        const runner = runnerFactory(sidechainId);
        const result = await runner.runTurn({
          prompt: `restart: resume work for ${teammateName}`,
          sidechainId,
          parentAgentId: teammate.agentId,
        });
        await sidechainManager.flush(sidechainId);
        return {
          newAgentId: teammate.agentId,
          detail: `restart turn stopReason=${result.stopReason}, iterations=${result.iterations}`,
        };
      },
    },
  );
  const shutdownHandshake = new ShutdownHandshake(mailboxService);

  // 子 agent runner：每个 sidechain 创建独立 ReActLoop（共享 provider + BUILTIN_TOOLS）
  const runnerFactory = makeReActLoopRunnerFactory({
    sidechain: sidechainManager,
    makeLoop: () =>
      new ReActLoop({
        provider,
        memory: new WorkingMemory(),
        tools: BUILTIN_TOOLS,
        renderer: makeStdoutRenderer(),
        model,
        fallbackModel,
        systemPrompt,
        cwd: process.cwd(),
        maxIterations: 20,
      }),
  });

  const orchestrator = new Orchestrator({
    taskManager,
    sidechain: sidechainManager,
    memoryEngine: engine,
    runnerFactory,
    swarmTeam,
  });

  // 主 agent 标识
  const mainAgentId = 'omniagent-main' as AgentId;
  const mainMailboxName = 'omniagent-main' as MailboxName;

  // 构造编排工具（agent_router / task_create / task_stop / send_message / task_output）
  const orchestrationTools: Tool[] = createOrchestrationTools({
    taskOutput: { taskManager, sidechainManager },
    agentRouter: { orchestrator, parentAgentId: () => mainAgentId },
    sendMessage: { mailboxService, parentAgentId: () => mainMailboxName },
    taskCreate: {
      taskManager,
      swarmTeam,
      parentAgentId: () => mainAgentId,
    },
    taskStop: {
      taskManager,
      shutdownHandshake,
      threeStateRecovery,
      teammateRegistry,
      swarmTeam,
      parentAgentId: () => mainAgentId,
      leaderName: () => mainMailboxName,
    },
  });

  const allTools: Tool[] = [...BUILTIN_TOOLS, ...orchestrationTools];

  // 构造 ReActLoop
  const memory = new WorkingMemory();
  const loop = new ReActLoop({
    provider,
    memory,
    tools: allTools,
    renderer: makeStdoutRenderer(),
    model,
    fallbackModel,
    systemPrompt,
    cwd: process.cwd(),
    maxIterations: 20,
  });

  // 运行单 turn
  try {
    const result = await loop.runTurn(args.prompt);
    process.stdout.write('\n');
    if (result.stopReason !== 'end_turn' && result.stopReason !== 'tool_use') {
      process.stderr.write(`\nTurn ended with: ${result.stopReason}\n`);
      process.exit(3);
    }
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exit(4);
  } finally {
    // 关闭 sidechain + 主 transcript（确保 drainWriteQueue flush）
    await engine.closeAll().catch(() => {});
    await mainTranscript.close().catch(() => {});
  }
}

// 仅在作为主模块运行时启动 CLI（被 import 时不执行 main）
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
