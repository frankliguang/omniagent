#!/usr/bin/env node
/**
 * OmniAgent CLI precheck — publish 前自检（L2 §10 npm 发布流程）
 *
 * 检查项：
 *  1. typecheck 通过（tsc --noEmit）
 *  2. 全量测试通过（node --test --import tsx/esm）
 *  3. build 成功（tsc → dist/）
 *  4. 品牌中立性：grep 源码无供应商专有名词作为依赖
 *     （openai/anthropic/bedrock/ollama 仅作为 provider id 允许出现，
 *      不应在 core types / system prompt / 错误信息中作为基础术语）
 *  5. bin 入口可执行（dist/index.js 有 shebang + 可运行 --version）
 *  6. package.json 必填字段齐全（name/version/license/bin/files/exports）
 *  7. README/LICENSE/CHANGELOG 存在
 *
 * 退出码：0 = 全部通过，1 = 有失败
 */

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
let failures = 0;

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

console.log('OmniAgent precheck\n');

// 1. typecheck
try {
  execSync('npx tsc --noEmit', { cwd: ROOT, stdio: 'pipe' });
  check('typecheck (tsc --noEmit)', true);
} catch (err) {
  const e = err;
  check('typecheck (tsc --noEmit)', false, (e.stdout && e.stdout.toString('utf8')) ?? '');
}

// 2. tests
try {
  execSync('npx tsx --test tests/**/*.test.ts', { cwd: ROOT, stdio: 'pipe', timeout: 120_000 });
  check('tests (node --test)', true);
} catch (err) {
  const e = err;
  const out = e.stdout && e.stdout.toString ? e.stdout.toString('utf8') : '';
  check('tests (node --test)', false, out.slice(-500));
}

// 3. build
try {
  execSync('npx tsc', { cwd: ROOT, stdio: 'pipe' });
  check('build (tsc → dist/)', true);
} catch {
  check('build (tsc → dist/)', false);
}

// 4. bin shebang + --version
const distEntry = path.join(ROOT, 'dist/index.js');
if (existsSync(distEntry)) {
  const head = readFileSync(distEntry, 'utf8').slice(0, 50);
  check('dist/index.js has shebang', head.startsWith('#!/usr/bin/env node'));

  try {
    const out = execFileSync(process.execPath, [distEntry, '--version'], { encoding: 'utf8' });
    check('dist/index.js --version runs', out.trim().match(/^\d+\.\d+\.\d+/) !== null);
  } catch {
    check('dist/index.js --version runs', false);
  }
} else {
  check('dist/index.js exists', false);
}

// 5. package.json 必填字段
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const requiredPkgFields = ['name', 'version', 'license', 'bin', 'exports', 'files', 'description'];
for (const field of requiredPkgFields) {
  check(`package.json: ${field}`, field in pkg);
}

// 6. LICENSE / README / CHANGELOG
for (const f of ['LICENSE', 'README.md', 'CHANGELOG.md']) {
  check(`file exists: ${f}`, existsSync(path.join(ROOT, f)));
}

// 7. 品牌中立性：grep 源码 core/types 不应将供应商专有名词作为类型/字段名
//    （允许在 provider id 字符串字面量中出现，但不允许作为类型字段名）
const typesPath = path.join(ROOT, 'src/types/index.ts');
if (existsSync(typesPath)) {
  const typesContent = readFileSync(typesPath, 'utf8');
  // 不应出现 vendorBrandPrefixed 字段（如 openaiModel/anthropicApiKey 这种硬编码字段）
  const vendorFieldPattern = /\b(?:openai|anthropic|bedrock|ollama)[A-Z]\w*\s*:/;
  check('types: brand-neutral (no vendor-prefixed fields)', !vendorFieldPattern.test(typesContent));
}

// 8. System prompt 不应硬编码供应商名称
const sysPromptFiles = [
  path.join(ROOT, 'src/index.ts'),
];
for (const f of sysPromptFiles) {
  if (!existsSync(f)) continue;
  const c = readFileSync(f, 'utf8');
  // DEFAULT_SYSTEM_PROMPT 不应硬提及具体供应商名（如"You are powered by GPT-4"）
  const hardcodePattern = /powered by (?:GPT|Claude|Llama|Bedrock)|using (?:OpenAI|Anthropic)/i;
  check(`system prompt: brand-neutral (${path.basename(f)})`, !hardcodePattern.test(c));
}

console.log(`\n${failures === 0 ? '✓ All precheck passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
