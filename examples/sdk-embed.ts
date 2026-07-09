/**
 * OmniAgent SDK 示例：嵌入到外部 TypeScript 项目
 *
 * 运行：
 *   npx tsx examples/sdk-embed.ts
 *
 * 前置：
 *   export OMNIAGENT_LLM_PROVIDER=openai
 *   export OMNIAGENT_LLM_API_KEY=sk-...
 */

import { ReActLoop } from '../src/core/react-loop.js';
import { WorkingMemory } from '../src/memory/index.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { BUILTIN_TOOLS } from '../src/tools/builtin/index.js';

async function main(): Promise<void> {
  // 1. 初始化 provider registry（已注册 openai/anthropic/bedrock/ollama）
  const registry = ProviderRegistry.create();
  const providerId = process.env.OMNIAGENT_LLM_PROVIDER ?? 'openai';
  const provider = registry.get(providerId);

  // 2. 认证
  const apiKey = process.env.OMNIAGENT_LLM_API_KEY ?? '';
  if (!apiKey) {
    console.error('Set OMNIAGENT_LLM_API_KEY first');
    process.exit(1);
  }
  const auth = await provider.authenticate({ type: 'api_key', apiKey, providerId });
  if (!auth.success) {
    console.error('Auth failed:', auth.errorMessage);
    process.exit(2);
  }

  // 3. 构造 ReActLoop
  const memory = new WorkingMemory();
  const loop = new ReActLoop({
    provider,
    memory,
    tools: BUILTIN_TOOLS,  // read/edit/write/glob/grep/bash
    model: process.env.OMNIAGENT_LLM_MODEL ?? 'gpt-4o',
    fallbackModel: process.env.OMNIAGENT_LLM_FALLBACK,
    systemPrompt: 'You are a helpful coding assistant. Use tools when needed.',
    cwd: process.cwd(),
    maxIterations: 20,
  });

  // 4. 运行单 turn
  const prompt = process.argv[2] ?? 'list files in the current directory';
  console.log(`User: ${prompt}\nAssistant:`);

  const result = await loop.runTurn(prompt);
  console.log(`\n--- turn end: ${result.stopReason} (${result.iterations} iterations) ---`);
  console.log(`Tokens: in=${result.tokenUsage.inputTokens}, out=${result.tokenUsage.outputTokens}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
