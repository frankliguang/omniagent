/**
 * Memory 模块 barrel（SDK 子路径 ./memory 的入口）
 *
 * 导出 SDK 用户需要的：
 *  - WorkingMemory（L1 工作记忆）
 *  - MemoryRecaller（L3 findRelevantMemories）
 *  - TranscriptStore / ResumeService（持久化与恢复）
 *  - SessionCompactor / CompactBoundary（L2 压缩）
 */

export { WorkingMemory } from './working-memory.js';
export { MemoryRecaller, setMemoryRecaller, getMemoryRecaller } from './recaller.js';
export type { MemoryRecallerOptions } from './recaller.js';
export { TranscriptStore } from './transcript.js';
export { ResumeService, resumeService } from './resume.js';
export { SessionCompactor } from './session-compact.js';
export { BoundaryStore, generateBoundaryId } from './boundary.js';
