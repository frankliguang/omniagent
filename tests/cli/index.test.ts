import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CLI_PATH = path.resolve(process.cwd(), 'src/index.ts');

/** 运行 CLI 并返回 stdout + exit code */
function runCli(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx/esm', CLI_PATH, ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: 30_000,
      },
    );
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: e.status ?? 1,
    };
  }
}

// ============================================================
// CLI 入口测试
// ============================================================

test('CLI: --version 打印版本号', () => {
  const { stdout, code } = runCli(['--version']);
  assert.equal(code, 0);
  assert.ok(stdout.trim().match(/^\d+\.\d+\.\d+/), '应输出 semver 版本号');
});

test('CLI: -v 短选项同 --version', () => {
  const { stdout, code } = runCli(['-v']);
  assert.equal(code, 0);
  assert.ok(stdout.trim().match(/^\d+\.\d+\.\d+/));
});

test('CLI: --help 打印帮助', () => {
  const { stdout, code } = runCli(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage:|用法:/);
  assert.match(stdout, /OMNIAGENT_LLM_PROVIDER/);
  assert.match(stdout, /--prompt/);
});

test('CLI: -h 短选项同 --help', () => {
  const { stdout, code } = runCli(['-h']);
  assert.equal(code, 0);
  assert.match(stdout, /用法/);
});

test('CLI: 无参数 → 帮助 + exit 1', () => {
  const { code } = runCli([]);
  assert.equal(code, 1);
});

test('CLI: 无凭证 → 友好错误 + exit 2', () => {
  const { stderr, code } = runCli(['-p', 'hello'], {
    OMNIAGENT_LLM_PROVIDER: 'openai',
    OMNIAGENT_LLM_API_KEY: '',
  });
  assert.equal(code, 2);
  assert.match(stderr, /No credentials/);
});

test('CLI: 未知 provider → 友好错误', () => {
  const { stderr, code } = runCli(['-p', 'hi'], {
    OMNIAGENT_LLM_PROVIDER: 'unknown_provider',
    OMNIAGENT_LLM_API_KEY: 'foo',
  });
  assert.equal(code, 2);
  assert.match(stderr, /Unknown provider/);
});

test('CLI: --prompt=value 形式', () => {
  const { stderr, code } = runCli(['--prompt=hi'], {
    OMNIAGENT_LLM_API_KEY: '',
  });
  assert.equal(code, 2);  // 缺凭证
  assert.match(stderr, /No credentials/);
});

test('CLI: -p 单 prompt 形式', () => {
  const { stderr, code } = runCli(['-p', 'hi'], {
    OMNIAGENT_LLM_API_KEY: '',
  });
  assert.equal(code, 2);
  assert.match(stderr, /No credentials/);
});

test('CLI: Bedrock 缺 AWS 凭证 → 友好错误', () => {
  const { stderr, code } = runCli(['-p', 'hi'], {
    OMNIAGENT_LLM_PROVIDER: 'bedrock',
    OMNIAGENT_LLM_API_KEY: '',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
  });
  assert.equal(code, 2);
  assert.match(stderr, /No credentials.*bedrock|AWS_ACCESS_KEY_ID/);
});
