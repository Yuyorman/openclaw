// Tests for gateway runtime subscription wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMainRunRecoveryRuntimeForTest,
  registerMainRunRecoveryLifecycleFence,
} from "../agents/main-run-recovery-runtime.js";
import {
  emitAgentAuditEvent,
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  emitInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { createTaskRecord, resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { getTaskRegistryObservers } from "../tasks/task-registry.store.js";
import { installInMemoryTaskRegistryRuntime } from "../test-utils/task-registry-runtime.js";
import { createActiveRunIdentity } from "./active-run-registry.js";
import {
  bindChatAbortControllerMainRunRecoveryExecution,
  registerChatAbortController,
} from "./chat-abort.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
  createToolEventRecipientRegistry,
} from "./server-chat-state.js";
import type { AgentEventHandlerOptions } from "./server-chat.js";
import type { TaskEventPayload } from "./server-methods/task-summary.js";

const warn = vi.fn();
const mockLog: SubsystemLogger = {
  subsystem: "gateway-test",
  isEnabled: () => true,
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn,
  error: vi.fn(),
  fatal: vi.fn(),
  raw: vi.fn(),
  child: () => mockLog,
};

const auditTestState = vi.hoisted(() => ({
  enabled: true,
  messageMode: "off" as "off" | "direct" | "all",
  created: 0,
  recorded: 0,
  stopped: 0,
  record: vi.fn(),
  recordTool: vi.fn(),
}));

const serverChatTestState = vi.hoisted(() => ({
  failLoad: true,
  handler: undefined as ((event: unknown) => unknown) | undefined,
  options: undefined as AgentEventHandlerOptions | undefined,
}));

const mainRunRecoveryStoreTestState = vi.hoisted(() => ({
  get: vi.fn(),
  recordTerminalEvidence: vi.fn(),
}));

vi.mock("../audit/audit-config.js", () => ({
  isAuditLedgerEnabled: () => auditTestState.enabled,
  resolveAuditMessageMode: () => auditTestState.messageMode,
}));

vi.mock("../audit/audit-recorder.js", () => ({
  createAuditEventRecorder: () => {
    auditTestState.created += 1;
    return {
      record: auditTestState.record,
      recordTool: auditTestState.recordTool,
      recordMessage: vi.fn(),
      stop: vi.fn(async () => {
        auditTestState.stopped += 1;
      }),
    };
  },
}));

vi.mock("../state/main-run-recovery-store.js", () => ({
  MAIN_RUN_RECOVERY_TERMINAL_RETENTION_MS: 86_400_000,
  getMainRunRecovery: mainRunRecoveryStoreTestState.get,
  recordMainRunRecoveryTerminalEvidenceCas: mainRunRecoveryStoreTestState.recordTerminalEvidence,
}));

vi.mock("./server-chat.js", () => ({
  createAgentEventHandler: (options: AgentEventHandlerOptions) => {
    if (serverChatTestState.failLoad) {
      throw new Error("server-chat lazy load failure");
    }
    serverChatTestState.options = options;
    return (event: unknown) => serverChatTestState.handler?.(event);
  },
}));

vi.mock("./server-session-key.js", () => ({
  resolveSessionKeyForRun: () => "agent:main:main",
}));

vi.mock("./server-session-events.js", () => ({
  createTranscriptUpdateBroadcastHandler: () => () => {
    throw new Error("transcript handler failure");
  },
  createLifecycleEventBroadcastHandler: () => () => {
    throw new Error("lifecycle handler failure");
  },
}));

const { startGatewayEventSubscriptions } = await import("./server-runtime-subscriptions.js");
type SubscriptionParams = Parameters<typeof startGatewayEventSubscriptions>[0];

function createParams(): SubscriptionParams {
  return {
    log: mockLog,
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map(),
    chatRunState: createChatRunState(),
    toolEventRecipients: createToolEventRecipientRegistry(),
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    chatAbortControllers: new Map(),
    restartRecoveryCandidates: new Map(),
  };
}

function registerRecoveryExecution(params: SubscriptionParams, options?: { generation?: string }) {
  const generation = options?.generation ?? getAgentEventLifecycleGeneration();
  const execution = {
    runId: "private-recovery-run",
    lifecycleGeneration: generation,
    epoch: "stored-execution-epoch",
  } as const;
  const recovery = {
    agentId: "main",
    publicRunId: "public-recovery-run",
    sessionId: "session-recovery",
    sessionKey: "agent:main:main",
    sessionKeyAliases: ["global"],
    storePath: "/tmp/main-run-recovery-sessions.json",
    state: "running",
    revision: 7,
    execution,
  };
  const registration = registerChatAbortController({
    chatAbortControllers: params.chatAbortControllers,
    runId: execution.runId,
    runIdentity: createActiveRunIdentity(execution.runId, recovery.publicRunId),
    sessionId: recovery.sessionId,
    sessionKey: recovery.sessionKey,
    agentId: recovery.agentId,
    lifecycleGeneration: generation,
    timeoutMs: 60_000,
  });
  if (!registration.entry) {
    throw new Error("expected recovery abort registration");
  }
  bindChatAbortControllerMainRunRecoveryExecution(registration.entry, {
    publicRunId: recovery.publicRunId,
    agentId: recovery.agentId,
    sessionId: recovery.sessionId,
    sessionKey: recovery.sessionKey,
    sessionKeyAliases: recovery.sessionKeyAliases,
    storePath: recovery.storePath,
    execution,
    database: { path: "/tmp/main-run-recovery.sqlite" },
  });
  mainRunRecoveryStoreTestState.get.mockReturnValue(recovery);
  mainRunRecoveryStoreTestState.recordTerminalEvidence.mockImplementation(
    (input: { outcome: unknown; observedAtMs: number }) => ({
      ...recovery,
      terminalEvidence: {
        execution,
        outcome: input.outcome,
        observedAtMs: input.observedAtMs,
      },
    }),
  );
  return { execution, recovery, registration };
}

describe("startGatewayEventSubscriptions", () => {
  let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    auditTestState.enabled = true;
    auditTestState.messageMode = "off";
    auditTestState.created = 0;
    auditTestState.recorded = 0;
    auditTestState.stopped = 0;
    auditTestState.record.mockReset();
    auditTestState.record.mockImplementation(() => {
      auditTestState.recorded += 1;
    });
    auditTestState.recordTool.mockReset();
    serverChatTestState.failLoad = true;
    serverChatTestState.handler = undefined;
    serverChatTestState.options = undefined;
    mainRunRecoveryStoreTestState.get.mockReset();
    mainRunRecoveryStoreTestState.recordTerminalEvidence.mockReset();
    installInMemoryTaskRegistryRuntime();
  });

  afterEach(async () => {
    await unsubs?.agentUnsub();
    unsubs?.heartbeatUnsub();
    unsubs?.transcriptUnsub();
    unsubs?.lifecycleUnsub();
    void unsubs?.taskUnsub();
    resetAgentEventsForTest();
    clearMainRunRecoveryRuntimeForTest();
    resetTaskRegistryForTests({ persist: false });
  });

  it("records audit events by default and stops the recorder on unsubscribe", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    expect(auditTestState.created).toBe(1);
    emitAgentAuditEvent({ runId: "enabled-audit", stream: "lifecycle", data: { phase: "start" } });
    expect(auditTestState.recorded).toBe(1);
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(1);
  });

  it("keeps retention maintenance but creates no producers when audit.enabled is false", async () => {
    auditTestState.enabled = false;
    unsubs = startGatewayEventSubscriptions(createParams());

    expect(auditTestState.created).toBe(1);
    emitAgentAuditEvent({
      runId: "disabled-private",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emitAgentEvent({ runId: "disabled-public", stream: "lifecycle", data: { phase: "start" } });
    expect(auditTestState.recorded).toBe(0);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    warn.mockClear();
    // Disabled wiring must still unsubscribe cleanly.
    await unsubs.agentUnsub();
    expect(auditTestState.stopped).toBe(1);
  });

  it("projects recovery execution ids before operator audit and log boundaries", async () => {
    serverChatTestState.failLoad = false;
    const params = createParams();
    const { execution, recovery } = registerRecoveryExecution(params);
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentAuditEvent({
      runId: execution.runId,
      stream: "lifecycle",
      data: { phase: "start" },
    });
    expect(auditTestState.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ runId: execution.runId }),
      { runId: recovery.publicRunId },
    );

    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: execution.runId,
      toolName: "read",
    });
    expect(auditTestState.recordTool).toHaveBeenLastCalledWith(
      expect.objectContaining({ runId: execution.runId }),
      { runId: recovery.publicRunId },
    );

    mainRunRecoveryStoreTestState.recordTerminalEvidence.mockImplementation(() => {
      throw new Error("terminal evidence failure");
    });
    emitAgentEvent({
      runId: execution.runId,
      lifecycleGeneration: execution.lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 123 },
    });
    expect(auditTestState.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ runId: execution.runId }),
      { runId: recovery.publicRunId },
    );
    expect(warn).toHaveBeenCalledWith(
      "Main-run recovery terminal evidence write failed",
      expect.objectContaining({ runId: recovery.publicRunId }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(execution.runId);
  });

  it("logs lazy agent event module failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: { phase: "start" } });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Agent event dispatch failed",
      expect.objectContaining({ runId: "run-1", stream: "lifecycle" }),
    );
  });

  it("captures the exact terminal status paired with lifecycle persistence", () => {
    serverChatTestState.failLoad = false;
    const params = createParams();
    const registration = registerChatAbortController({
      chatAbortControllers: params.chatAbortControllers,
      runId: "run-terminal",
      sessionId: "session-terminal",
      sessionKey: "agent:main:main",
      timeoutMs: 60_000,
    });
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentEvent({
      runId: "run-terminal",
      stream: "lifecycle",
      data: { phase: "end", aborted: true, stopReason: "rpc", endedAt: 123 },
    });

    expect(registration.entry).toMatchObject({
      projectSessionTerminalPending: true,
      projectSessionTerminalObservedAt: 123,
      projectSessionTerminalStatus: "killed",
    });
  });

  it("records exact recovery terminal evidence before blocked session persistence", async () => {
    serverChatTestState.failLoad = false;
    let releasePersistence!: () => void;
    const blockedPersistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const handler = vi.fn(() => blockedPersistence);
    serverChatTestState.handler = handler;
    const params = createParams();
    const { execution } = registerRecoveryExecution(params);
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentEvent({
      runId: execution.runId,
      lifecycleGeneration: execution.lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 123 },
    });

    // The SQLite observation is synchronous; the lazy JSON session handler has
    // not even entered yet and may remain blocked indefinitely.
    expect(mainRunRecoveryStoreTestState.recordTerminalEvidence).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const observedEvent = handler.mock.calls[0]?.[0] as { ts: number };
    const evidenceInput = mainRunRecoveryStoreTestState.recordTerminalEvidence.mock.calls[0]?.[0];
    expect(evidenceInput).toMatchObject({
      publicRunId: "public-recovery-run",
      expectedRevision: 7,
      expectedState: "running",
      execution,
      outcome: { status: "done", endedAtMs: 123 },
      observedAtMs: observedEvent.ts,
    });
    expect(
      mainRunRecoveryStoreTestState.recordTerminalEvidence.mock.invocationCallOrder[0],
    ).toBeLessThan(handler.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);

    releasePersistence();
  });

  it("does not escape or misclassify a detached evidence retry failure", async () => {
    serverChatTestState.failLoad = false;
    const params = createParams();
    const terminalPersistenceFailed = vi.fn(() => true);
    const { execution, registration } = registerRecoveryExecution(params);
    const entry = registration.entry;
    if (!entry) {
      throw new Error("expected recovery abort registration");
    }
    entry.onSessionTerminalPersistenceFailed = terminalPersistenceFailed;
    mainRunRecoveryStoreTestState.recordTerminalEvidence.mockImplementation(() => {
      throw new Error("transient evidence write failure");
    });
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentEvent({
      runId: execution.runId,
      lifecycleGeneration: execution.lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 123 },
    });
    registration.cleanup();
    await vi.waitFor(() => expect(serverChatTestState.options).toBeDefined());
    warn.mockClear();
    const persistence = Promise.resolve();
    serverChatTestState.options?.trackTrackedRunTerminalPersistence?.({
      identity: createActiveRunIdentity(execution.runId, "public-recovery-run"),
      sessionKey: "agent:main:main",
      sessionId: "session-recovery",
      observedAt: 123,
      persistence,
    });

    await persistence;
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        "Main-run recovery terminal evidence retry failed",
        expect.objectContaining({ runId: "public-recovery-run" }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(execution.runId);
    });
    expect(terminalPersistenceFailed).not.toHaveBeenCalled();
    expect(entry.projectSessionTerminalPersisted).toBe(true);
    expect(entry.mainRunRecoveryTerminalEvidenceResolved).not.toBe(true);
    expect(params.chatAbortControllers.get(execution.runId)).toBe(entry);
  });

  it("does not treat cleanup-time evidence retry failure as JSON persistence failure", async () => {
    serverChatTestState.failLoad = false;
    const params = createParams();
    const terminalPersistenceFailed = vi.fn(() => true);
    const { execution, registration } = registerRecoveryExecution(params);
    const entry = registration.entry;
    if (!entry) {
      throw new Error("expected recovery abort registration");
    }
    entry.onSessionTerminalPersistenceFailed = terminalPersistenceFailed;
    mainRunRecoveryStoreTestState.recordTerminalEvidence.mockImplementation(() => {
      throw new Error("transient evidence write failure");
    });
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentEvent({
      runId: execution.runId,
      lifecycleGeneration: execution.lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 123 },
    });
    const persistence = Promise.resolve();
    entry.projectSessionTerminalPending = false;
    entry.projectSessionTerminalPersistence = persistence;
    registration.cleanup();

    await persistence;
    await vi.waitFor(() => expect(entry.projectSessionTerminalPersisted).toBe(true));
    expect(terminalPersistenceFailed).not.toHaveBeenCalled();
    expect(entry.mainRunRecoveryTerminalEvidenceResolved).not.toBe(true);
    expect(params.chatAbortControllers.get(execution.runId)).toBe(entry);
  });

  it("leaves an earlier recovery cancellation authoritative", () => {
    serverChatTestState.failLoad = false;
    const params = createParams();
    const { execution, recovery } = registerRecoveryExecution(params);
    const cancelling = {
      ...recovery,
      state: "cancelling",
      revision: 8,
      cancellation: { kind: "reset", epoch: "reset-epoch", requestedAtMs: 1 },
    };
    mainRunRecoveryStoreTestState.get.mockReturnValue(cancelling);
    mainRunRecoveryStoreTestState.recordTerminalEvidence.mockImplementation(
      (input: { observedAtMs: number }) =>
        input.observedAtMs <= cancelling.cancellation.requestedAtMs ? cancelling : undefined,
    );
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentEvent({
      runId: execution.runId,
      lifecycleGeneration: execution.lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "error", endedAt: 1, error: "late terminal" },
    });

    expect(mainRunRecoveryStoreTestState.recordTerminalEvidence).not.toHaveBeenCalled();
    expect(
      params.chatAbortControllers.get(execution.runId)?.mainRunRecoveryTerminalEvidenceResolved,
    ).toBe(true);
  });

  it("does not mutate recovery state for a fenced lifecycle generation", () => {
    serverChatTestState.failLoad = false;
    const params = createParams();
    const { execution, registration } = registerRecoveryExecution(params, {
      generation: "stale-lifecycle-generation",
    });
    registerMainRunRecoveryLifecycleFence(execution);
    unsubs = startGatewayEventSubscriptions(params);

    emitAgentEvent({
      runId: execution.runId,
      lifecycleGeneration: execution.lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 123 },
    });

    expect(mainRunRecoveryStoreTestState.get).not.toHaveBeenCalled();
    expect(mainRunRecoveryStoreTestState.recordTerminalEvidence).not.toHaveBeenCalled();
    expect(registration.entry?.projectSessionTerminalPending).toBeUndefined();
  });

  it("routes rejected terminal persistence to its owner or restart recovery", async () => {
    serverChatTestState.failLoad = false;
    const params = createParams();
    unsubs = startGatewayEventSubscriptions(params);
    emitAgentEvent({ runId: "load-handler", stream: "lifecycle", data: { phase: "start" } });
    await vi.waitFor(() => expect(serverChatTestState.options).toBeDefined());

    const handledFailure = vi.fn(() => true);
    const handled = registerChatAbortController({
      chatAbortControllers: params.chatAbortControllers,
      runId: "run-cancelled",
      sessionId: "session-cancelled",
      sessionKey: "agent:main:main",
      lifecycleGeneration: "generation-cancelled",
      timeoutMs: 60_000,
      onSessionTerminalPersistenceFailed: handledFailure,
    });
    const handledPersistence = Promise.reject(new Error("cancelled write failed"));
    serverChatTestState.options?.trackTrackedRunTerminalPersistence?.({
      identity: createActiveRunIdentity("run-cancelled"),
      sessionKey: "agent:main:main",
      observedAt: 1,
      persistence: handledPersistence,
    });
    await expect(handledPersistence).rejects.toThrow("cancelled write failed");
    await vi.waitFor(() => expect(handledFailure).toHaveBeenCalledTimes(1));
    expect(params.restartRecoveryCandidates.has("run-cancelled")).toBe(false);
    handled.cleanup();
    await Promise.resolve();
    expect(handledFailure).toHaveBeenCalledTimes(1);

    const recoverFailure = vi.fn(() => false);
    registerChatAbortController({
      chatAbortControllers: params.chatAbortControllers,
      runId: "run-recoverable",
      sessionId: "session-recoverable",
      sessionKey: "agent:main:main",
      lifecycleGeneration: "generation-recoverable",
      timeoutMs: 60_000,
      onSessionTerminalPersistenceFailed: recoverFailure,
    });
    const recoverablePersistence = Promise.reject(new Error("recoverable write failed"));
    serverChatTestState.options?.trackTrackedRunTerminalPersistence?.({
      identity: createActiveRunIdentity("run-recoverable"),
      sessionKey: "agent:main:main",
      sessionId: "session-recoverable",
      observedAt: 2,
      persistence: recoverablePersistence,
    });
    await expect(recoverablePersistence).rejects.toThrow("recoverable write failed");
    await vi.waitFor(() => {
      expect(params.restartRecoveryCandidates.get("run-recoverable")).toEqual({
        runId: "run-recoverable",
        lifecycleGeneration: "generation-recoverable",
        sessionKey: "agent:main:main",
        sessionId: "session-recoverable",
        observedAt: 2,
      });
    });
    expect(recoverFailure).toHaveBeenCalledTimes(1);
  });

  it("logs transcript handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitInternalSessionTranscriptUpdate({
      sessionFile: "/tmp/sess.jsonl",
      sessionKey: "agent:main:main",
    } as InternalSessionTranscriptUpdate);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Transcript update dispatch failed",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  it("logs lifecycle handler failures", async () => {
    unsubs = startGatewayEventSubscriptions(createParams());

    emitSessionLifecycleEvent({ sessionKey: "agent:main:main", reason: "created" });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      "Lifecycle event dispatch failed",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  it("broadcasts bounded public task summaries with ledger statuses", async () => {
    const broadcast = vi.fn<SubscriptionParams["broadcast"]>();
    unsubs = startGatewayEventSubscriptions({ ...createParams(), broadcast });
    await vi.waitFor(() => expect(getTaskRegistryObservers()).not.toBeNull());

    const completed = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Completed task",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      terminalSummary: "x".repeat(10_000),
    });
    const lost = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Lost task",
      status: "lost",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });

    if (!completed || !lost) {
      throw new Error("expected task records to be created");
    }
    const taskUpsertsById = new Map(
      broadcast.mock.calls
        .filter(([event]) => event === "task")
        .map(([, payload]) => payload as TaskEventPayload)
        .filter(
          (payload): payload is Extract<TaskEventPayload, { action: "upserted" }> =>
            payload.action === "upserted",
        )
        .map((payload) => [payload.task.id, payload.task]),
    );
    expect(broadcast).toHaveBeenCalledWith("task", expect.anything(), { dropIfSlow: true });
    // Runtime registry statuses translate to the public ledger vocabulary.
    expect(taskUpsertsById.get(completed.taskId)?.status).toBe("completed");
    expect(taskUpsertsById.get(lost.taskId)?.status).toBe("failed");
    // Unbounded status text from providers/shells must be truncated on the wire.
    const wireTerminalSummary = taskUpsertsById.get(completed.taskId)?.terminalSummary;
    expect(wireTerminalSummary).toBeTruthy();
    expect(wireTerminalSummary?.length ?? 0).toBeLessThan(10_000);

    void unsubs?.taskUnsub();
    await vi.waitFor(() => expect(getTaskRegistryObservers()).toBeNull());
    broadcast.mockClear();
    createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "After dispose",
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("keeps a replacement gateway's task observer when a stale unsub runs late", async () => {
    const staleBroadcast = vi.fn<SubscriptionParams["broadcast"]>();
    const staleSubs = startGatewayEventSubscriptions({
      ...createParams(),
      broadcast: staleBroadcast,
    });
    await vi.waitFor(() => expect(getTaskRegistryObservers()).not.toBeNull());
    const staleObservers = getTaskRegistryObservers();

    const replacementBroadcast = vi.fn<SubscriptionParams["broadcast"]>();
    unsubs = startGatewayEventSubscriptions({
      ...createParams(),
      broadcast: replacementBroadcast,
    });
    await vi.waitFor(() => {
      const current = getTaskRegistryObservers();
      expect(current).not.toBeNull();
      expect(current).not.toBe(staleObservers);
    });

    // The stale dispose must not clear the replacement's observer slot.
    await staleSubs.taskUnsub();
    await staleSubs.agentUnsub();
    staleSubs.heartbeatUnsub();
    staleSubs.transcriptUnsub();
    staleSubs.lifecycleUnsub();
    expect(getTaskRegistryObservers()).not.toBeNull();

    createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "After stale dispose",
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    expect(replacementBroadcast).toHaveBeenCalledWith("task", expect.anything(), {
      dropIfSlow: true,
    });
    expect(staleBroadcast).not.toHaveBeenCalledWith("task", expect.anything(), {
      dropIfSlow: true,
    });
  });
});
