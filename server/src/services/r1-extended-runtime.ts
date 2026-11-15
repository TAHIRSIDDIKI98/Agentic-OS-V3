/**
 * Extended R1 runtime including all new E2-E5 services
 * Composes SDK services with SQL implementations where available
 */
import {
  createSqlR1Repositories,
  R1Service,
  ProjectTransferService,
  SqlCapabilityGovernanceStore,
  InMemoryCapabilityGovernanceStore,
  R1RecallService,
  RecallFeedbackService,
  TaskWorker,
  TaskEventStreamService,
  DurableApprovalService,
  BoundedToolGateway,
  KillSwitchService,
  TelemetryService,
  EvidenceTimelineService,
  ContextPackService,
  TaskConsolidationService,
  SerenaCodeIntelligence,
  SqlCheckpoints,
  SqlLeases,
  SqlCompensations,
  SqlFeedback,
  SqlContradiction,
  SqlKillSwitch,
  SqlDurableApprovals,
  SqlTelemetry,
  SqlEffectClaimStore,
  InMemoryEffectClaimStore,
  MCPAdapter,
  A2AAdapter,
  ProjectSyncService,
  SqlMCPRepo,
  SqlA2ACardRepo,
  SqlA2ATaskRepo,
  SqlSyncStore,
  type SqlExecutor,
  type R1Repositories,
  type ImportApplyResult,
  type EffectClaimStore,
} from '@agentic-os/sdk';
import { CapabilityGovernanceService } from './capability-governance.js';
import { getEnv } from '../lib/env.js';
import { runR1ConstrainedCommand } from './r1-sandbox-runner.js';

export interface ExtendedR1Runtime {
  readonly repositories: R1Repositories;
  readonly service: R1Service;
  readonly governance: CapabilityGovernanceService;
  readonly transfer: ProjectTransferService;
  readonly recall: R1RecallService;
  readonly feedback: RecallFeedbackService;
  readonly worker: TaskWorker;
  readonly eventStream: TaskEventStreamService;
  readonly approvals: DurableApprovalService;
  readonly toolGateway: BoundedToolGateway;
  readonly killSwitch: KillSwitchService;
  readonly telemetry: TelemetryService;
  readonly evidenceTimeline: EvidenceTimelineService;
  readonly contextPack: ContextPackService;
  readonly consolidation: TaskConsolidationService;
  readonly serena: SerenaCodeIntelligence;
  readonly mcp: MCPAdapter;
  readonly a2a: A2AAdapter;
  readonly sync: ProjectSyncService;
  readonly effectClaims: EffectClaimStore;
  readonly applyProjectImport: (candidate: unknown) => Promise<ImportApplyResult>;
}

export function createExtendedSqlR1Runtime(
  executor: SqlExecutor,
  options: { now?: () => string; projectRoots?: Map<string, string> } = {},
  runInTransaction?: <T>(fn: () => Promise<T>) => Promise<T>
): ExtendedR1Runtime {
  const repos = createSqlR1Repositories(executor);
  const governanceStore = new SqlCapabilityGovernanceStore(executor);
  const governance = new CapabilityGovernanceService(governanceStore);
  const transfer = new ProjectTransferService(repos);

  // extended SQL repos
  const checkpoints = new SqlCheckpoints(executor);
  const leases = new SqlLeases(executor);
  const compensations = new SqlCompensations(executor);
  const feedbackRepo = new SqlFeedback(executor);
  const contradictionRepo = new SqlContradiction(executor);
  const killSwitchStore = new SqlKillSwitch(executor);
  const durableApprovalsRepo = new SqlDurableApprovals(executor);
  const telemetrySql = new SqlTelemetry(executor);
  const effectClaims = new SqlEffectClaimStore(executor);

  const recall = new R1RecallService(repos, { embeddingAvailable: false });
  const feedback = new RecallFeedbackService(repos, feedbackRepo, contradictionRepo, {
    now: options.now,
  });
  const consolidation = new TaskConsolidationService(repos, { now: options.now });
  const worker = new TaskWorker(repos, checkpoints, leases, compensations, {
    now: options.now,
    onCompleted: async (projectId, taskId) => {
      await consolidation.consolidateTask(projectId, taskId, { agentId: 'task-worker' });
    },
  });
  const eventStream = new TaskEventStreamService(repos);
  const approvals = new DurableApprovalService(repos, durableApprovalsRepo, {
    now: options.now,
    killSwitchEnabled: async () => (await killSwitchStore.get())?.enabled ?? false,
  });
  const toolGateway = new BoundedToolGateway(repos, {
    now: options.now,
    projectRoots: options.projectRoots,
    projectRootBase: getEnv().NEXUS_PROJECT_ROOT,
    effectClaims,
    isApprovalApproved: async (id: string, projectId: string) => {
      const appr = await durableApprovalsRepo.get(projectId, id);
      return appr?.state === 'approved';
    },
    sandboxExecutor: async (command, args, timeoutMs, workingDirectory) => {
      // `workingDirectory` is derived from trusted runtime configuration plus project ID
      // by the gateway; create only that directory before the runner canonicalizes it.
      const { mkdir } = await import('node:fs/promises');
      await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
      return runR1ConstrainedCommand({ command, args, timeoutMs, workingDirectory });
    },
    fileReader: async (fullPath: string) => {
      // Enforce project root already done in gateway; here we simulate read
      const { readFile } = await import('node:fs/promises');
      return readFile(fullPath, 'utf8');
    },
    fileWriter: async (fullPath: string, content: string) => {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf8');
    },
  });
  const killSwitch = new KillSwitchService(repos, killSwitchStore, { now: options.now });
  const telemetry = new TelemetryService({
    now: options.now,
    spanExporter: {
      export: async (spans) => {
        for (const s of spans) await telemetrySql.saveSpan(s);
      },
    },
  });
  const listDurableApprovals = async (projectId: string) =>
    durableApprovalsRepo.listForProject
      ? await durableApprovalsRepo.listForProject(projectId)
      : await durableApprovalsRepo.listPending(projectId);
  const evidenceTimeline = new EvidenceTimelineService(repos, {
    now: options.now,
    // Durable approvals live outside R1Repositories; include decided ones so the
    // timeline and evidence export retain the full approval history.
    listApprovals: async (projectId, taskId) => {
      const all = await listDurableApprovals(projectId);
      return taskId ? all.filter((approval) => approval.taskId === taskId) : all;
    },
  });
  const contextPack = new ContextPackService(repos, {
    now: options.now,
    listApprovals: listDurableApprovals,
  });
  const serena = new SerenaCodeIntelligence({ now: options.now });
  const mcp = new MCPAdapter(new SqlMCPRepo(executor), { now: options.now });
  // A2A's adapter contract does not yet carry project scope with an approval ID.
  // Fail closed rather than performing an unscoped approval lookup.
  const a2a = new A2AAdapter(new SqlA2ACardRepo(executor), new SqlA2ATaskRepo(executor), {
    now: options.now,
    isApprovalApproved: async () => false,
  });
  const sync = new ProjectSyncService(new SqlSyncStore(executor), { now: options.now });

  const applyProjectImport = async (candidate: unknown) => {
    const svc = new ProjectTransferService(repos);
    if (runInTransaction) return svc.applyImport(candidate, runInTransaction);
    return svc.applyImport(candidate);
  };

  return {
    repositories: repos,
    service: new R1Service(repos, { now: options.now }),
    governance,
    transfer,
    recall,
    feedback,
    worker,
    eventStream,
    approvals,
    toolGateway,
    killSwitch,
    telemetry,
    evidenceTimeline,
    contextPack,
    consolidation,
    serena,
    mcp,
    a2a,
    sync,
    effectClaims,
    applyProjectImport,
  };
}

// In-memory runtime for tests/offline
export function createInMemoryExtendedRuntime(
  repos: R1Repositories,
  options: { now?: () => string; projectRoots?: Map<string, string> } = {}
): ExtendedR1Runtime {
  const governanceStore = new InMemoryCapabilityGovernanceStore();
  const governance = new CapabilityGovernanceService(governanceStore);
  const transfer = new ProjectTransferService(repos);
  const recall = new R1RecallService(repos);
  const feedback = new RecallFeedbackService(repos);
  const consolidation = new TaskConsolidationService(repos, { now: options.now });
  const worker = new TaskWorker(repos, undefined, undefined, undefined, {
    now: options.now,
    onCompleted: async (projectId, taskId) => {
      await consolidation.consolidateTask(projectId, taskId, { agentId: 'task-worker' });
    },
  });
  const eventStream = new TaskEventStreamService(repos);
  const approvals = new DurableApprovalService(repos);
  const toolGateway = new BoundedToolGateway(repos, {
    now: options.now,
    projectRoots: options.projectRoots,
  });
  const killSwitch = new KillSwitchService(repos);
  const telemetry = new TelemetryService({ now: options.now });
  const evidenceTimeline = new EvidenceTimelineService(repos);
  const contextPack = new ContextPackService(repos, { now: options.now });
  const serena = new SerenaCodeIntelligence({ now: options.now });
  const mcp = new MCPAdapter();
  const a2a = new A2AAdapter();
  const sync = new ProjectSyncService();
  const effectClaims = new InMemoryEffectClaimStore();

  return {
    repositories: repos,
    service: new R1Service(repos, { now: options.now }),
    governance,
    transfer,
    recall,
    feedback,
    worker,
    eventStream,
    approvals,
    toolGateway,
    killSwitch,
    telemetry,
    evidenceTimeline,
    contextPack,
    consolidation,
    serena,
    mcp,
    a2a,
    sync,
    effectClaims,
    applyProjectImport: (c) => transfer.applyImport(c),
  };
}
