# OmniAgent CLI Dockerfile（L2 §11.3 — M2 iter 4）
#
# 多阶段构建：
#   1. builder 阶段：复制源码 + 安装 dev 依赖 + tsc 编译到 dist/
#   2. runtime 阶段：仅复制 dist/ + package.json + production 依赖
#
# buildx 多架构支持（linux/amd64 + linux/arm64）：
#   docker buildx build --platform linux/amd64,linux/arm64 -t omniagent:latest --push .
#
# 基础镜像选 node:20-alpine（小尺寸 + 官方维护 + 多架构支持）。
# Alpine 兼容性：musl libc（与 glibc 差异），第三方库如 sharp/keytar 需额外注意。
# M2 iter 4 范围：omniagent CLI 仅依赖 Node.js 内置 API + 少量纯 JS 第三方库（无原生模块），
# alpine 适配无风险。

# ============================================================
# Stage 1: builder — 编译 TypeScript 到 dist/
# ============================================================
FROM node:20-alpine AS builder

# 安装 tini（alpine 默认无，PID 1 信号转发需要）+ git（worktree 功能需要）
RUN apk add --no-cache tini git

WORKDIR /build

# 先复制 package.json + lockfile，利用 docker layer cache 加速依赖安装
COPY package.json package-lock.json* ./

# 安装全部依赖（含 devDependencies，编译时需要 tsc）
# --ignore-scripts 避免 postinstall 脚本（如 keytar 原生编译）
RUN npm ci --ignore-scripts

# 复制源码 + tsconfig
COPY tsconfig.json ./
COPY src/ ./src/

# 编译 TypeScript
# 输出在 /build/dist/，包含 .js + .d.ts + .map（declaration: true）
RUN npx tsc --noEmit && npx tsc -b

# ============================================================
# Stage 2: runtime — 仅含 production 依赖 + dist/
# ============================================================
FROM node:20-alpine AS runtime

# runtime 依赖：tini（PID 1）+ git（worktree）+ ca-certificates（HTTPS）
RUN apk add --no-cache tini git ca-certificates

# 创建非 root 用户（容器安全最佳实践）
RUN addgroup -S omniagent && adduser -S -G omniagent -h /home/omniagent omniagent

WORKDIR /app

# 复制 package.json + lockfile
COPY package.json package-lock.json* ./

# 安装 production 依赖（仅 dependencies，不含 devDependencies）
# --omit=dev 等价于 --production
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# 复制编译产物
COPY --from=builder /build/dist/ ./dist/

# 创建 .omniagent 数据目录（运行时挂载 volume）
RUN mkdir -p /home/omniagent/.omniagent && \
    chown -R omniagent:omniagent /home/omniagent /app

# 切换到非 root 用户
USER omniagent

# 环境变量（运行时配置）
ENV HOME=/home/omniagent \
    OMNIAGENT_LLM_PROVIDER=openai \
    NODE_ENV=production

# 入口点：tini 转发信号 + node 启动 CLI
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js", "--help"]

# 默认 volume：~/.omniagent（transcripts + memory + mailbox）
VOLUME ["/home/omniagent/.omniagent"]

# 元数据
LABEL org.opencontainers.image.title="OmniAgent CLI" \
      org.opencontainers.image.description="Brand-neutral AI coding assistant CLI" \
      org.opencontainers.image.source="https://github.com/omniagent/omniagent" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.1.0"
