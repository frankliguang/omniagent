#!/usr/bin/env node
/**
 * OmniAgent CLI Docker 多架构构建脚本（L2 §11.3 — M2 iter 4）
 *
 * 用法：
 *   node scripts/docker-build.js                # 本地单架构（amd64）测试
 *   node scripts/docker-build.js --multi       # 多架构（amd64 + arm64）本地
 *   node scripts/docker-build.js --push        # 多架构 + push 到 registry
 *
 * 前置：
 *   - Docker Desktop 或 Docker Engine + buildx
 *   - 多架构支持：docker buildx create --use --name multiarch
 *   - push 需先 docker login <registry>
 *
 * 输出：
 *   - 单架构：本地 image（omniagent:latest + omniagent:<version>）
 *   - 多架构：manifest list push 到 registry（需 --push）
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const version = pkg.version;
const imageName = pkg.name.replace(/^@/, '').replace(/\//, '-'); // omniagent-cli

const args = new Set(process.argv.slice(2));
const multiArch = args.has('--multi') || args.has('--push');
const doPush = args.has('--push');

const platforms = multiArch ? 'linux/amd64,linux/arm64' : 'linux/amd64';
const tagLatest = doPush ? `-t docker.io/omniagent/${imageName}:latest` : `-t ${imageName}:latest`;
const tagVersion = doPush ? `-t docker.io/omniagent/${imageName}:${version}` : `-t ${imageName}:${version}`;
const outputFlag = doPush ? '--push' : '--load';

console.log(`Building omniagent Docker image`);
console.log(`  name:    ${imageName}`);
console.log(`  version: ${version}`);
console.log(`  platforms: ${platforms}`);
console.log(`  push:    ${doPush}`);
console.log('');

// 1. 确认 buildx 可用
try {
  execSync('docker buildx version', { stdio: 'pipe' });
} catch (err) {
  console.error('Error: docker buildx not available. Install Docker Desktop or run: docker buildx install');
  process.exit(1);
}

// 2. 多架构构建需 multi-arch builder
if (multiArch) {
  try {
    execSync('docker buildx inspect multiarch', { stdio: 'pipe' });
  } catch {
    console.log('Creating multiarch buildx builder...');
    execSync('docker buildx create --use --name multiarch', { stdio: 'inherit' });
  }
}

// 3. 执行构建
const cmd = [
  'docker',
  'buildx',
  'build',
  `--platform=${platforms}`,
  tagLatest,
  tagVersion,
  outputFlag,
  '--file', 'Dockerfile',
  '.',
].join(' ');

console.log(`Running: ${cmd}`);
execSync(cmd, { stdio: 'inherit' });

// 4. 单架构本地构建 → 验证可运行
if (!multiArch) {
  console.log('\nVerifying image runs...');
  try {
    execSync(`docker run --rm ${imageName}:latest --version`, { stdio: 'inherit' });
    console.log('✓ Image runs successfully');
  } catch (err) {
    console.error('✗ Image verification failed');
    process.exit(1);
  }
}

console.log(`\n✓ Build complete: ${imageName}:${version}`);
if (doPush) {
  console.log(`  Pushed to: docker.io/omniagent/${imageName}:${version}`);
}
