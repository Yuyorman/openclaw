// Gateway event subscription wiring for agent, heartbeat, transcript, and lifecycle broadcasts.
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { isMainRunRecoveryLifecycleFenced } from "../agents/main-run-recovery-runtime.js";
import { isAuditLedgerEnabled, resolveAuditMessageMode } from "../audit/audit-config.js";
import { createAuditEventRecorder } from "../audit/audit-recorder.js";
import { onTrustedMessageAuditEvent } from "../audit/message-audit-events.js";
import { getRuntimeConfig } from "../config/io.js";
import { clearAgentRunContext, onAgentAuditEvent, onAgentEvent } from "../infra/agent-events.js";
import { onTrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import type { TaskRegistryObserverEvent } from "../tasks/task-registry.store.js";
import {
  activeRunIdentityAliases,
  type ActiveRunIdentity,
  resolveActiveRunByIdentity,
  resolveActiveRunIdentity,
} from "./active-run-registry.js";
import {
  type ChatAbortControllerEntry,
  notifyChatAbortControllerSessionTerminalPersistenceFailed,
  notifyChatAbortControllerSessionTerminalPersisted,
  recordChatAbortControllerMainRunRecoveryTerminalEvidence,
  removeChatAbortControllerEntry,
  type RestartRecoveryCandidate,
} from "./chat-abort.js";
import type {
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
  ToolEventRecipientRegistry,
} from "./server-chat-state.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { mapTaskSummary, type TaskEventPayload } from "./server-methods/task-summary.js";
import { resolveGatewaySessionTerminalStatus } from "./session-lifecycle-state.js";

function resolveTrackedRun(
  entries: ReadonlyMap<string, ChatAbortControllerEntry>,
  identity: ActiveRunIdentity,
) {
  return (
    resolveActiveRunByIdentity(entries, identity.executionRunId) ??
    resolveActiveRunByIdentity(entries, identity.publicRunId)
  );
}

function resolveOperatorRunId(params: {
  chatAbortControllers: ReadonlyMap<string, ChatAbortControllerEntry>;
  chatRunState: ChatRunState;
  runId: string;
}): string {
  const chatLink = params.chatRunState.registry.peek(params.runId);
  if (chatLink) {
    return chatLink.runIdentity.publicRunId;
  }
  return (
    resolveActiveRunByIdentity(params.chatAbortControllers, params.runId)?.identity.publicRunId ??
    params.runId
  );
}

function resolveTerminalEventTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= fallback
    ? value
    : fallback;
}

function notifyTrackedRunTerminalPersisted(params: {
  entry: ChatAbortControllerEntry;
  log: SubsystemLogger;
  runId: string;
}): boolean {
  try {
    return notifyChatAbortControllerSessionTerminalPersisted(params.entry);
  } catch (error) {
    // JSON persistence succeeded. Keep the controller as the exact evidence
    // owner; maintenance retries SQLite without reclassifying this as JSON loss.
    params.log.warn("Main-run recovery terminal evidence retry failed", {
      runId: params.runId,
      error,
    });
    return false;
  }
}

function dispatchEventHandler<TEvent>(params: {
  loadHandler: () => Promise<(event: TEvent) => unknown>;
  event: TEvent;
  log: SubsystemLogger;
  failureMessage: string;
  context: Record<string, unknown>;
}) {
  void params
    .loadHandler()
    .then((handler) => handler(params.event))
    .catch((error: unknown) => {
      params.log.warn(params.failureMessage, { ...params.context, error });
    });
}

/** Register gateway runtime event subscriptions and return unsubscribe handles. */
export function startGatewayEventSubscriptions(params: {
  log: SubsystemLogger;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  restartRecoveryCandidates: Map<string, RestartRecoveryCandidate>;
}) {
  // The worker always runs retention maintenance. audit.enabled only controls
  // producer subscriptions, so disabling collection cannot strand expired rows.
  const runtimeConfig = getRuntimeConfig();
  const auditEnabled = isAuditLedgerEnabled(runtimeConfig);
  const auditMessageMode = resolveAuditMessageMode(runtimeConfig);
  const auditRecorder = createAuditEventRecorder({
    messageMode: auditEnabled ? auditMessageMode : "off",
  });
  const unsubscribePrivateAuditEvents = auditEnabled
    ? onAgentAuditEvent((event) =>
        auditRecorder.record(event, {
          runId:
            event.publicRunId ??
            resolveOperatorRunId({
              chatAbortControllers: params.chatAbortControllers,
              chatRunState: params.chatRunState,
              runId: event.runId,
          }),
        }),
      )
    : undefined;
  const unsubscribeToolAuditEvents = auditEnabled
    ? onTrustedToolExecutionEvent((event) => {
        const projection = event.runId
          ? {
              runId:
                event.publicRunId ??
                resolveOperatorRunId({
                  chatAbortControllers: params.chatAbortControllers,
                  chatRunState: params.chatRunState,
                  runId: event.runId,
                }),
            }
          : undefined;
        auditRecorder.recordTool(event, projection);
      })
    : undefined;
  const unsubscribeMessageAuditEvents =
    auditEnabled && auditMessageMode !== "off"
      ? onTrustedMessageAuditEvent(auditRecorder.recordMessage)
      : undefined;
  const getAgentEventHandler = createLazyPromise(
    () => {
      // Lazy-load heavy chat modules only after the first agent event reaches the gateway.
      return Promise.all([import("./server-chat.js"), import("./server-session-key.js")]).then(
        ([{ createAgentEventHandler }, { resolveSessionKeyForRun }]) =>
          createAgentEventHandler({
            broadcast: params.broadcast,
            broadcastToConnIds: params.broadcastToConnIds,
            nodeSendToSession: params.nodeSendToSession,
            agentRunSeq: params.agentRunSeq,
            chatRunState: params.chatRunState,
            resolveSessionKeyForRun,
            clearAgentRunContext,
            toolEventRecipients: params.toolEventRecipients,
            sessionEventSubscribers: params.sessionEventSubscribers,
            sessionMessageSubscribers: params.sessionMessageSubscribers,
            updateRunToolErrorSummary: ({ identity, summary }) => {
              const tracked = resolveTrackedRun(params.chatAbortControllers, identity);
              if (tracked) {
                tracked.entry.toolErrorSummary = summary;
              }
            },
            clearTrackedActiveRun: ({ identity }) => {
              const tracked = resolveTrackedRun(params.chatAbortControllers, identity);
              if (!tracked) {
                return;
              }
              const entry = tracked.entry;
              entry.projectSessionActive = false;
              entry.projectSessionTerminalPending = false;
              entry.projectSessionTerminalPersisted = false;
              queueMicrotask(() => {
                const current = params.chatAbortControllers.get(tracked.identity.executionRunId);
                if (
                  current === entry &&
                  entry.registrationCleanupRequested === true &&
                  !entry.projectSessionTerminalPersistence
                ) {
                  removeChatAbortControllerEntry(
                    params.chatAbortControllers,
                    tracked.identity.executionRunId,
                    entry,
                  );
                }
              });
            },
            markTrackedRunTerminalPersisted: ({ identity }) => {
              for (const candidateRunId of activeRunIdentityAliases(identity)) {
                params.restartRecoveryCandidates.delete(candidateRunId);
              }
              const tracked = resolveTrackedRun(params.chatAbortControllers, identity);
              if (tracked) {
                notifyTrackedRunTerminalPersisted({
                  entry: tracked.entry,
                  log: params.log,
                  runId: tracked.identity.publicRunId,
                });
              }
            },
            trackTrackedRunTerminalPersistence: ({
              identity,
              sessionId: terminalSessionId,
              observedAt,
              persistence,
            }) => {
              const tracked = resolveTrackedRun(params.chatAbortControllers, identity);
              if (!tracked) {
                return;
              }
              const entry = tracked.entry;
              const executionRunId = tracked.identity.executionRunId;
              entry.projectSessionTerminalPending = false;
              entry.projectSessionTerminalPersistence = persistence;
              if (entry.registrationCleanupRequested === true) {
                void persistence.then(
                  () => {
                    if (params.chatAbortControllers.get(executionRunId) !== entry) {
                      return;
                    }
                    if (
                      !notifyTrackedRunTerminalPersisted({
                        entry,
                        log: params.log,
                        runId: tracked.identity.publicRunId,
                      })
                    ) {
                      return;
                    }
                    removeChatAbortControllerEntry(
                      params.chatAbortControllers,
                      executionRunId,
                      entry,
                    );
                  },
                  () => {
                    if (params.chatAbortControllers.get(executionRunId) !== entry) {
                      return;
                    }
                    notifyChatAbortControllerSessionTerminalPersistenceFailed(entry);
                    removeChatAbortControllerEntry(
                      params.chatAbortControllers,
                      executionRunId,
                      entry,
                    );
                  },
                );
              }
              const lifecycleGeneration = entry.lifecycleGeneration?.trim();
              const sessionKey = entry.sessionKey.trim();
              const sessionId = terminalSessionId?.trim() || entry.sessionId.trim();
              void persistence.catch(() => {
                const failureHandled =
                  notifyChatAbortControllerSessionTerminalPersistenceFailed(entry);
                if (
                  !failureHandled &&
                  entry.controlUiVisible !== false &&
                  lifecycleGeneration &&
                  sessionKey &&
                  sessionId
                ) {
                  params.restartRecoveryCandidates.set(executionRunId, {
                    runId: executionRunId,
                    lifecycleGeneration,
                    sessionKey,
                    sessionId,
                    observedAt,
                  });
                }
              });
            },
            isChatSendRunActive: (runId) => {
              const entry = params.chatAbortControllers.get(runId);
              return entry !== undefined && entry.kind !== "agent";
            },
            resolveActiveLifecycleGenerationForRun: (runId) =>
              params.chatAbortControllers.get(runId)?.lifecycleGeneration,
            resolveSessionActiveRunState: (session) =>
              resolveVisibleActiveSessionRunState({
                context: params,
                ...session,
                defaultAgentId: resolveDefaultAgentId(getRuntimeConfig()),
              }),
          }),
      );
    },
    { cacheRejections: true },
  );

  const getSessionEventsModule = createLazyPromise(() => import("./server-session-events.js"), {
    cacheRejections: true,
  });

  let transcriptUpdateHandlerPromise: Promise<
    ReturnType<typeof import("./server-session-events.js").createTranscriptUpdateBroadcastHandler>
  > | null = null;
  const getTranscriptUpdateHandler = () => {
    transcriptUpdateHandlerPromise ??= getSessionEventsModule().then(
      ({ createTranscriptUpdateBroadcastHandler }) =>
        createTranscriptUpdateBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
          sessionMessageSubscribers: params.sessionMessageSubscribers,
          chatAbortControllers: params.chatAbortControllers,
        }),
    );
    return transcriptUpdateHandlerPromise;
  };

  let lifecycleEventHandlerPromise: Promise<
    ReturnType<typeof import("./server-session-events.js").createLifecycleEventBroadcastHandler>
  > | null = null;
  const getLifecycleEventHandler = () => {
    lifecycleEventHandlerPromise ??= getSessionEventsModule().then(
      ({ createLifecycleEventBroadcastHandler }) =>
        createLifecycleEventBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
          chatAbortControllers: params.chatAbortControllers,
        }),
    );
    return lifecycleEventHandlerPromise;
  };

  const unsubscribeAgentEvents = onAgentEvent((evt) => {
    // Capture projection before synchronous abort cleanup removes the run link;
    // lazy handler loading must never turn an internal recovery id into a wire id.
    const chatLink = params.chatRunState.registry.peek(evt.runId);
    const operatorRunId = resolveOperatorRunId({
      chatAbortControllers: params.chatAbortControllers,
      chatRunState: params.chatRunState,
      runId: evt.runId,
    });
    if (auditEnabled) {
      auditRecorder.record(evt, { runId: operatorRunId });
    }
    const eventLifecycleGeneration = evt.lifecycleGeneration?.trim();
    if (
      !chatLink &&
      eventLifecycleGeneration &&
      isMainRunRecoveryLifecycleFenced({
        runId: evt.runId,
        lifecycleGeneration: eventLifecycleGeneration,
      })
    ) {
      return;
    }
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string"
        ? evt.data.phase
        : undefined;
    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      const identity = resolveActiveRunIdentity(evt.runId, chatLink);
      const entry = resolveTrackedRun(params.chatAbortControllers, identity)?.entry;
      if (
        entry &&
        (!eventLifecycleGeneration ||
          !entry.lifecycleGeneration ||
          entry.lifecycleGeneration === eventLifecycleGeneration)
      ) {
        const observedAtMs = evt.ts;
        const terminalStatus = resolveGatewaySessionTerminalStatus(evt);
        try {
          recordChatAbortControllerMainRunRecoveryTerminalEvidence(entry, {
            runId: evt.runId,
            lifecycleGeneration: eventLifecycleGeneration,
            outcome: {
              status: terminalStatus,
              endedAtMs: resolveTerminalEventTimestamp(evt.data.endedAt, observedAtMs),
            },
            // Event-bus delivery is the durable race boundary. JSON session
            // persistence happens asynchronously after this listener returns.
            observedAtMs,
          });
        } catch (error) {
          params.log.warn("Main-run recovery terminal evidence write failed", {
            runId: operatorRunId,
            lifecycleGeneration: eventLifecycleGeneration,
            error,
          });
        }
        entry.projectSessionTerminalPending = true;
        entry.projectSessionTerminalObservedAt =
          typeof evt.data.endedAt === "number" && Number.isFinite(evt.data.endedAt)
            ? evt.data.endedAt
            : evt.ts;
        entry.projectSessionTerminalStatus = terminalStatus;
      }
    } else if (lifecyclePhase === "start") {
      const identity = resolveActiveRunIdentity(evt.runId, chatLink);
      const entry = resolveTrackedRun(params.chatAbortControllers, identity)?.entry;
      if (
        entry &&
        (!eventLifecycleGeneration ||
          !entry.lifecycleGeneration ||
          entry.lifecycleGeneration === eventLifecycleGeneration)
      ) {
        entry.projectSessionTerminalPending = false;
        entry.projectSessionTerminalObservedAt = undefined;
        entry.projectSessionTerminalStatus = undefined;
      }
    }
    dispatchEventHandler({
      loadHandler: () =>
        getAgentEventHandler().then(
          (handler) => (event: typeof evt) => handler(event, { chatLink }),
        ),
      event: evt,
      log: params.log,
      failureMessage: "Agent event dispatch failed",
      context: { runId: operatorRunId, stream: evt.stream },
    });
  });
  const agentUnsub = async () => {
    unsubscribeAgentEvents();
    unsubscribePrivateAuditEvents?.();
    unsubscribeToolAuditEvents?.();
    unsubscribeMessageAuditEvents?.();
    await auditRecorder.stop();
  };

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    params.broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  const transcriptUnsub = onInternalSessionTranscriptUpdate((evt) => {
    dispatchEventHandler({
      loadHandler: getTranscriptUpdateHandler,
      event: evt,
      log: params.log,
      failureMessage: "Transcript update dispatch failed",
      context: { sessionKey: evt.sessionKey },
    });
  });

  const lifecycleUnsub = onSessionLifecycleEvent((evt) => {
    dispatchEventHandler({
      loadHandler: getLifecycleEventHandler,
      event: evt,
      log: params.log,
      failureMessage: "Lifecycle event dispatch failed",
      context: { sessionKey: evt.sessionKey },
    });
  });

  let taskObserverDisposed = false;
  const taskObservers = {
    onEvent: (event: TaskRegistryObserverEvent) => {
      let payload: TaskEventPayload;
      switch (event.kind) {
        case "upserted":
          payload = { action: "upserted", task: mapTaskSummary(event.task) };
          break;
        case "deleted":
          payload = { action: "deleted", taskId: event.taskId };
          break;
        case "restored":
          payload = { action: "restored" };
          break;
      }
      params.broadcast("task", payload, { dropIfSlow: true });
    },
  };
  const taskObserverRuntimePromise = import("../tasks/task-registry.store.js").then((module) => {
    if (!taskObserverDisposed) {
      module.configureTaskRegistryRuntime({ observers: taskObservers });
    }
    return module;
  });
  void taskObserverRuntimePromise.catch((error: unknown) => {
    params.log.warn("Task registry observer registration failed", { error });
  });
  // The observer slot is a process-wide singleton. Cleanup returns its promise
  // so shutdown can await it, and only clears the slot when it still holds
  // this subscription's observer — a replacement gateway may have registered
  // its own observer before a stale deferred dispose runs.
  const taskUnsub = () => {
    taskObserverDisposed = true;
    return taskObserverRuntimePromise
      .then((module) => {
        if (module.getTaskRegistryObservers() === taskObservers) {
          module.configureTaskRegistryRuntime({ observers: null });
        }
      })
      .catch(() => undefined);
  };

  return {
    agentUnsub,
    heartbeatUnsub,
    transcriptUnsub,
    lifecycleUnsub,
    taskUnsub,
  };
}
