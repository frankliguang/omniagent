/**
 * Orchestration barrel（L3-M5 — M2 iter 1 + iter 2）
 *
 * 多 agent 编排层入口：
 * - TaskManager：双轨管理（WorkItem + RuntimeTask）
 * - Orchestrator：agent_router 主入口，5 路径分发（M2 iter 1: sync/async/fork；iter 2: teammate）
 * - CoordinatorMode：sync/async 路径
 * - ForkAgentSpawner：fork 路径（继承父上下文 + 占位 tool_result）
 * - SubAgentRunner：子 agent 运行器接口（解耦 ReActLoop）
 * - MailboxService（iter 2）：mailbox 高层 API（send/read/markRead）
 */

export {
  TaskManager,
} from './task-manager.js';
export type {
  CreateDualTrackParams,
  DualTrackHandle,
  TaskOutputResult,
} from './task-manager.js';

export {
  Orchestrator,
} from './orchestrator.js';
export type {
  OrchestratorDeps,
  RouteParams,
} from './orchestrator.js';

export {
  CoordinatorMode,
  spawnSync,
  spawnAsync,
} from './coordinator-mode.js';
export type {
  RouteRuntimeParams,
} from './coordinator-mode.js';

export {
  ForkAgentSpawner,
  fillPlaceholderToolResults,
  verifyByteIdenticalPrefix,
} from './fork-agent-spawner.js';
export type {
  ForkSpawnParams,
  ForkAgentSpawnerDeps,
} from './fork-agent-spawner.js';

export {
  subAgentResultToToolResult,
} from './sub-agent-runner.js';
export type {
  SubAgentRunner,
  SubAgentRunnerFactory,
  SubAgentTurnResult,
} from './sub-agent-runner.js';

export {
  ReActLoopSubAgentRunner,
  makeReActLoopRunnerFactory,
} from './react-loop-runner.js';
export type {
  ReActLoopRunnerDeps,
} from './react-loop-runner.js';

export {
  MailboxService,
} from './mailbox-service.js';
export type {
  SendMailboxParams,
  SendMailboxResult,
  MailboxServiceOptions,
} from './mailbox-service.js';

export {
  TeammateRegistry,
} from './teammate-registry.js';
export type {
  TeammateRecord,
  RegisterTeammateParams,
  AssertNameStableParams,
} from './teammate-registry.js';

export {
  WorktreeRoster,
  GitWorktreeOps,
  InMemoryWorktreeOps,
} from './worktree-roster.js';
export type {
  WorktreeEntry,
  AssignWorktreeParams,
  WorktreeOperations,
} from './worktree-roster.js';

export {
  SwarmTeam,
} from './swarm-team.js';
export type {
  JoinTeamParams,
  JoinTeamResult,
  SendMessageParams,
} from './swarm-team.js';

export {
  ShutdownHandshake,
} from './shutdown-handshake.js';
export type {
  HandshakeState,
  ShutdownContext,
  TeammateContext,
  ShutdownResponse,
  ShutdownRequestPayload,
  HandshakeRecord,
  CleanupResources,
  CanShutdownEvaluator,
} from './shutdown-handshake.js';

export {
  ThreeStateRecovery,
  makeRealProcessAliveChecker,
} from './three-state-recovery.js';
export type {
  TeammateStatus,
  RecoveryStrategy,
  ProcessAliveChecker,
  RecoverOptions,
  RecoverResult,
  RestartHandler,
} from './three-state-recovery.js';

export {
  RemoteAgentClient,
  MockSSHClient,
  MockSSHConnection,
  classifyRemoteError,
  backoffDelay,
} from './remote-agent-client.js';
export type {
  SSHClient,
  SSHConnection,
  SSHConnectOptions,
  SSHExecOptions,
  SSHExecResult,
  RemoteAgentClientOptions,
  RemoteDelegateParams,
  RemoteError,
  RemoteErrorKind,
} from './remote-agent-client.js';
