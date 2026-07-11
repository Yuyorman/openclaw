// Gateway chat/agent abort tracking.
// Registers active run abort controllers and projects in-flight chat state.
import {
  asDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import {
  registerMainRunRecoveryLifecycleFence,
  registerMainRunRecoveryTerminalEvidencePending,
  resolveMainRunRecoveryTerminalEvidencePending,
} from "../agents/main-run-recovery-runtime.js";
import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import { readToolValidationErrorSummary } from "../agents/tool-error-summary.js";
import { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import {
  getMainRunRecovery,
  recordMainRunRecoveryTerminalEvidenceCas,
  type MainRunRecoveryExecution,
  type MainRunRecoveryTerminalOutcome,
} from "../state/main-run-recovery-store.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  activeRunIdentityAliases,
  createActiveRunIdentity,
  type ActiveRunIdentity,
  resolveActiveRunByIdentity,
  resolveActiveRunIdentity,
} from "./active-run-registry.js";
import { projectLiveAssistantBufferedText } from "./live-chat-projector.js";
import {
  createChatAbortMarker,
  type ChatAbortMarker,
  type ChatRunEntry,
} from "./server-chat-state.js";

const DEFAULT_CHAT_RUN_ABORT_GRACE_MS = 60_000;
const TERMINAL_EVIDENCE_RETRY_BASE_MS = 250;
const TERMINAL_EVIDENCE_RETRY_MAX_MS = 30_000;
const terminalPersistenceCallbacksInvoked = new WeakSet<ChatAbortControllerEntry>();
const terminalPersistenceFailureCallbackResults = new WeakMap<ChatAbortControllerEntry, boolean>();

export type ChatAbortMainRunRecoveryExecution = Readonly<{
  publicRunId: string;
  agentId: string;
  sessionKey: string;
  sessionKeyAliases: readonly string[];
  sessionId: string;
  storePath: string;
  execution: Readonly<MainRunRecoveryExecution>;
  database?: Readonly<Pick<OpenClawStateDatabaseOptions, "path">>;
}>;

export type ChatAbortMainRunRecoveryTerminalEvidence = Readonly<{
  runId: string;
  lifecycleGeneration: string;
  outcome: Readonly<MainRunRecoveryTerminalOutcome>;
  observedAtMs: number;
}>;

export type ChatAbortControllerEntry = {
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  /** Canonical execution/public identity. Older manually-built entries fall back to their map key. */
  runIdentity?: ActiveRunIdentity;
  lifecycleGeneration?: string;
  agentId?: string;
  startedAtMs: number;
  expiresAtMs: number;
  ownerConnId?: string;
  ownerDeviceId?: string;
  providerId?: string;
  authProviderId?: string;
  abortStopReason?: string;
  /** Latest argument-free validation diagnostic for operator-initiated aborts. */
  toolErrorSummary?: string;
  /**
   * False for backend/internal agent runs that may share a session key but must
   * not be projected into operator chat surfaces.
   */
  controlUiVisible?: boolean;
  /**
   * Controls only the sessions.list active-run projection. Terminal lifecycle
   * clears this before chat.send settles, while the entry stays as the retry
   * idempotency guard until normal cleanup removes it.
   */
  projectSessionActive?: boolean;
  /** True after the terminal session-store update has completed. */
  projectSessionTerminalPersisted?: boolean;
  /** A terminal lifecycle event was observed and is awaiting persistence. */
  projectSessionTerminalPending?: boolean;
  /** Store timestamp expected from the observed terminal lifecycle event. */
  projectSessionTerminalObservedAt?: number;
  /** Exact terminal status paired with the persisted lifecycle event. */
  projectSessionTerminalStatus?: "done" | "failed" | "timeout" | "killed";
  /** Set-once durable owner for terminal evidence from this exact private execution. */
  readonly mainRunRecoveryExecution?: ChatAbortMainRunRecoveryExecution;
  /** Immutable terminal event retained until its exact SQLite CAS succeeds. */
  readonly mainRunRecoveryTerminalEvidence?: ChatAbortMainRunRecoveryTerminalEvidence;
  /** True after the bound event has a durable evidence or cancellation disposition. */
  mainRunRecoveryTerminalEvidenceResolved?: true;
  /** Bounded retry state for transient SQLite failures. */
  mainRunRecoveryTerminalEvidenceRetryCount?: number;
  mainRunRecoveryTerminalEvidenceRetryAtMs?: number;
  /** In-flight terminal session-store update used by restart shutdown. */
  projectSessionTerminalPersistence?: Promise<void>;
  /** Caller completion requested cleanup before terminal lifecycle persistence settled. */
  registrationCleanupRequested?: boolean;
  /** Runs once after terminal persistence succeeds and caller cleanup is requested. */
  onSessionTerminalPersisted?: () => void;
  /** Returns true when failed terminal persistence is owned and must not become recovery work. */
  onSessionTerminalPersistenceFailed?: () => boolean;
  /** False after the owning reply run commits a terminal outcome. */
  isAbortable?: (entry: ChatAbortControllerEntry) => boolean;
  /** Runs once when this registration is actually removed. */
  onRemoved?: () => void;
  /**
   * Which RPC owns this registration. Absent (undefined) is treated as
   * `"chat-send"` so pre-existing callers that constructed entries without
   * a kind keep their behavior. Consumers that need "chat.send specifically
   * is active" must check `kind !== "agent"`, not just `.has(runId)`.
   */
  kind?: "chat-send" | "agent";
  /** Side questions stay independent from main-turn TUI session stops. */
  turnKind?: "main" | "btw";
};

export type RestartRecoveryCandidate = {
  runId: string;
  lifecycleGeneration: string;
  sessionKey: string;
  sessionId: string;
  observedAt?: number;
};

type RegisteredChatAbortController = {
  controller: AbortController;
  registered: boolean;
  entry?: ChatAbortControllerEntry;
  cleanup: (opts?: { force?: boolean }) => void;
};

export function isChatStopCommandText(text: string): boolean {
  return isAbortRequestText(text);
}

function createChatAbortSignalReason(stopReason: string | undefined): Error | undefined {
  if (stopReason === "restart") {
    return createAgentRunRestartAbortError();
  }
  if (stopReason !== "timeout") {
    return undefined;
  }
  const reason = new Error("chat run timed out");
  reason.name = "TimeoutError";
  return reason;
}

export function resolveChatRunExpiresAtMs(params: {
  now: number;
  timeoutMs: number;
  graceMs?: number;
  minMs?: number;
  maxMs?: number;
}): number {
  const {
    now,
    timeoutMs,
    graceMs = DEFAULT_CHAT_RUN_ABORT_GRACE_MS,
    minMs = 2 * 60_000,
    maxMs = 24 * 60 * 60_000,
  } = params;
  const safeNow = asDateTimestampMs(now);
  if (safeNow === undefined) {
    return 0;
  }
  const boundedTimeoutMs = Math.max(0, timeoutMs);
  const targetDurationMs = boundedTimeoutMs + graceMs;
  const target = resolveExpiresAtMsFromDurationMs(targetDurationMs, { nowMs: safeNow });
  const min = resolveExpiresAtMsFromDurationMs(minMs, { nowMs: safeNow });
  const max = resolveExpiresAtMsFromDurationMs(maxMs, { nowMs: safeNow });
  if (target === undefined || min === undefined || max === undefined) {
    return 0;
  }
  return Math.min(max, Math.max(min, target));
}

export function resolveAgentRunExpiresAtMs(params: {
  now: number;
  timeoutMs: number;
  graceMs?: number;
}): number {
  const graceMs = Math.max(0, params.graceMs ?? DEFAULT_CHAT_RUN_ABORT_GRACE_MS);
  return resolveChatRunExpiresAtMs({
    now: params.now,
    timeoutMs: params.timeoutMs,
    graceMs,
    minMs: graceMs,
    maxMs: Math.max(0, params.timeoutMs) + graceMs,
  });
}

function requiredRecoveryText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function sameRecoveryExecution(
  left: Readonly<MainRunRecoveryExecution> | undefined,
  right: Readonly<MainRunRecoveryExecution>,
): boolean {
  return (
    left?.runId === right.runId &&
    left.lifecycleGeneration === right.lifecycleGeneration &&
    left.epoch === right.epoch
  );
}

function sameRecoveryExecutionMetadata(
  left: ChatAbortMainRunRecoveryExecution,
  right: ChatAbortMainRunRecoveryExecution,
): boolean {
  return (
    left.publicRunId === right.publicRunId &&
    left.agentId === right.agentId &&
    left.sessionKey === right.sessionKey &&
    left.sessionId === right.sessionId &&
    left.storePath === right.storePath &&
    left.sessionKeyAliases.length === right.sessionKeyAliases.length &&
    left.sessionKeyAliases.every((alias, index) => alias === right.sessionKeyAliases[index]) &&
    sameRecoveryExecution(left.execution, right.execution) &&
    left.database?.path === right.database?.path
  );
}

function sameRecoveryTerminalOutcome(
  left: Readonly<MainRunRecoveryTerminalOutcome> | undefined,
  right: Readonly<MainRunRecoveryTerminalOutcome>,
): boolean {
  return left?.status === right.status && left.endedAtMs === right.endedAtMs;
}

function bindChatAbortControllerMainRunRecoveryTerminalEvidence(
  entry: ChatAbortControllerEntry,
  params: ChatAbortMainRunRecoveryTerminalEvidence,
): ChatAbortMainRunRecoveryTerminalEvidence {
  const normalized = Object.freeze({
    runId: requiredRecoveryText(params.runId, "recovery terminal run id"),
    lifecycleGeneration: requiredRecoveryText(
      params.lifecycleGeneration,
      "recovery terminal lifecycle generation",
    ),
    outcome: Object.freeze({ ...params.outcome }),
    observedAtMs: params.observedAtMs,
  }) satisfies ChatAbortMainRunRecoveryTerminalEvidence;
  const current = entry.mainRunRecoveryTerminalEvidence;
  if (current) {
    if (
      current.runId !== normalized.runId ||
      current.lifecycleGeneration !== normalized.lifecycleGeneration ||
      current.observedAtMs !== normalized.observedAtMs ||
      !sameRecoveryTerminalOutcome(current.outcome, normalized.outcome)
    ) {
      throw new Error("main-run recovery terminal evidence is already bound to another event");
    }
    return current;
  }
  Object.defineProperty(entry, "mainRunRecoveryTerminalEvidence", {
    configurable: false,
    enumerable: true,
    value: normalized,
    writable: false,
  });
  return normalized;
}

function resolveChatAbortControllerMainRunRecoveryTerminalEvidence(
  entry: ChatAbortControllerEntry,
): true {
  const metadata = entry.mainRunRecoveryExecution;
  if (metadata) {
    resolveMainRunRecoveryTerminalEvidencePending({
      publicRunId: metadata.publicRunId,
      execution: metadata.execution,
      ...(metadata.database ? { database: metadata.database } : {}),
    });
  }
  entry.mainRunRecoveryTerminalEvidenceResolved = true;
  entry.mainRunRecoveryTerminalEvidenceRetryCount = undefined;
  entry.mainRunRecoveryTerminalEvidenceRetryAtMs = undefined;
  return true;
}

function deferChatAbortControllerMainRunRecoveryTerminalEvidence(
  entry: ChatAbortControllerEntry,
  nowMs: number,
): false {
  const attempt = Math.min(8, (entry.mainRunRecoveryTerminalEvidenceRetryCount ?? 0) + 1);
  const delayMs = Math.min(
    TERMINAL_EVIDENCE_RETRY_MAX_MS,
    TERMINAL_EVIDENCE_RETRY_BASE_MS * 2 ** (attempt - 1),
  );
  entry.mainRunRecoveryTerminalEvidenceRetryCount = attempt;
  entry.mainRunRecoveryTerminalEvidenceRetryAtMs = nowMs + delayMs;
  return false;
}

function persistBoundChatAbortControllerMainRunRecoveryTerminalEvidence(
  entry: ChatAbortControllerEntry,
  options: { force?: boolean; nowMs?: number } = {},
): boolean {
  const metadata = entry.mainRunRecoveryExecution;
  const evidence = entry.mainRunRecoveryTerminalEvidence;
  if (!metadata) {
    return true;
  }
  if (!evidence) {
    return false;
  }
  if (entry.mainRunRecoveryTerminalEvidenceResolved === true) {
    return true;
  }
  const nowMs = options.nowMs ?? Date.now();
  if (options.force !== true && (entry.mainRunRecoveryTerminalEvidenceRetryAtMs ?? 0) > nowMs) {
    return false;
  }
  try {
    const current = getMainRunRecovery(metadata.publicRunId, metadata.database);
    if (
      !current ||
      current.agentId !== metadata.agentId ||
      current.sessionKey !== metadata.sessionKey ||
      current.sessionId !== metadata.sessionId ||
      current.storePath !== metadata.storePath ||
      current.sessionKeyAliases.length !== metadata.sessionKeyAliases.length ||
      !current.sessionKeyAliases.every(
        (alias, index) => alias === metadata.sessionKeyAliases[index],
      ) ||
      !sameRecoveryExecution(current.execution, metadata.execution)
    ) {
      return deferChatAbortControllerMainRunRecoveryTerminalEvidence(entry, nowMs);
    }
    const alreadyDurable =
      (sameRecoveryExecution(current.terminalEvidence?.execution, metadata.execution) &&
        sameRecoveryTerminalOutcome(current.terminalEvidence?.outcome, evidence.outcome)) ||
      (current.state === "terminal" &&
        sameRecoveryTerminalOutcome(current.terminalOutcome, evidence.outcome));
    if (alreadyDurable) {
      return resolveChatAbortControllerMainRunRecoveryTerminalEvidence(entry);
    }
    if (current.cancellation && evidence.observedAtMs > current.cancellation.requestedAtMs) {
      return resolveChatAbortControllerMainRunRecoveryTerminalEvidence(entry);
    }
    if (current.state === "terminal") {
      return deferChatAbortControllerMainRunRecoveryTerminalEvidence(entry, nowMs);
    }
    const recorded = recordMainRunRecoveryTerminalEvidenceCas(
      {
        agentId: metadata.agentId,
        publicRunId: metadata.publicRunId,
        sessionId: metadata.sessionId,
        sessionKey: metadata.sessionKey,
        sessionKeyAliases: metadata.sessionKeyAliases,
        storePath: metadata.storePath,
        expectedRevision: current.revision,
        expectedState: current.state,
        execution: metadata.execution,
        outcome: evidence.outcome,
        observedAtMs: evidence.observedAtMs,
        nowMs: Math.max(nowMs, evidence.observedAtMs),
      },
      metadata.database,
    );
    if (
      sameRecoveryExecution(recorded?.terminalEvidence?.execution, metadata.execution) &&
      sameRecoveryTerminalOutcome(recorded?.terminalEvidence?.outcome, evidence.outcome)
    ) {
      return resolveChatAbortControllerMainRunRecoveryTerminalEvidence(entry);
    }
    return deferChatAbortControllerMainRunRecoveryTerminalEvidence(entry, nowMs);
  } catch (error) {
    deferChatAbortControllerMainRunRecoveryTerminalEvidence(entry, nowMs);
    throw error;
  }
}

/** Retry the immutable terminal event before its active owner can be removed. */
export function retryChatAbortControllerMainRunRecoveryTerminalEvidence(
  entry: ChatAbortControllerEntry,
  options: { force?: boolean; nowMs?: number } = {},
): boolean {
  return persistBoundChatAbortControllerMainRunRecoveryTerminalEvidence(entry, options);
}

/** Attach immutable durable evidence ownership after the recovery row enters `running`. */
export function bindChatAbortControllerMainRunRecoveryExecution(
  entry: ChatAbortControllerEntry,
  metadata: ChatAbortMainRunRecoveryExecution,
): ChatAbortMainRunRecoveryExecution {
  const runIdentity = entry.runIdentity;
  if (!runIdentity) {
    throw new Error("main-run recovery execution requires an active-run identity");
  }
  const publicRunId = requiredRecoveryText(metadata.publicRunId, "recovery public run id");
  const agentId = requiredRecoveryText(metadata.agentId, "recovery agent id");
  const sessionKey = requiredRecoveryText(metadata.sessionKey, "recovery session key");
  const sessionId = requiredRecoveryText(metadata.sessionId, "recovery session id");
  const storePath = requiredRecoveryText(metadata.storePath, "recovery store path");
  const execution = Object.freeze({
    runId: requiredRecoveryText(metadata.execution.runId, "recovery execution run id"),
    lifecycleGeneration: requiredRecoveryText(
      metadata.execution.lifecycleGeneration,
      "recovery execution lifecycle generation",
    ),
    epoch: requiredRecoveryText(metadata.execution.epoch, "recovery execution epoch"),
  });
  const sessionKeyAliases = Object.freeze(
    [
      ...new Set(
        metadata.sessionKeyAliases
          .map((alias) => alias.trim())
          .filter((alias) => alias && alias !== sessionKey && alias !== sessionId),
      ),
    ].toSorted(),
  );
  const databasePath = metadata.database?.path?.trim();
  const database = databasePath ? Object.freeze({ path: databasePath }) : undefined;
  const normalized = Object.freeze({
    publicRunId,
    agentId,
    sessionKey,
    sessionKeyAliases,
    sessionId,
    storePath,
    execution,
    ...(database ? { database } : {}),
  }) satisfies ChatAbortMainRunRecoveryExecution;

  if (
    runIdentity.executionRunId !== execution.runId ||
    runIdentity.publicRunId !== publicRunId ||
    entry.lifecycleGeneration !== execution.lifecycleGeneration ||
    entry.sessionKey !== sessionKey ||
    entry.sessionId !== sessionId ||
    (entry.agentId !== undefined && entry.agentId !== agentId)
  ) {
    throw new Error("main-run recovery execution does not match its active-run registration");
  }

  const current = entry.mainRunRecoveryExecution;
  if (current) {
    if (!sameRecoveryExecutionMetadata(current, normalized)) {
      throw new Error("main-run recovery execution is already bound to another owner");
    }
    return current;
  }
  Object.defineProperty(entry, "mainRunRecoveryExecution", {
    configurable: false,
    enumerable: true,
    value: normalized,
    writable: false,
  });
  return normalized;
}

/** Record evidence only for the exact private execution capability bound above. */
export function recordChatAbortControllerMainRunRecoveryTerminalEvidence(
  entry: ChatAbortControllerEntry,
  params: {
    runId: string;
    lifecycleGeneration?: string;
    outcome: MainRunRecoveryTerminalOutcome;
    observedAtMs: number;
  },
): boolean {
  const metadata = entry.mainRunRecoveryExecution;
  const runIdentity = entry.runIdentity;
  const eventRunId = params.runId.trim();
  const eventLifecycleGeneration = params.lifecycleGeneration?.trim();
  if (
    !metadata ||
    !runIdentity ||
    eventRunId !== metadata.execution.runId ||
    eventLifecycleGeneration !== metadata.execution.lifecycleGeneration ||
    runIdentity.executionRunId !== metadata.execution.runId ||
    runIdentity.publicRunId !== metadata.publicRunId ||
    entry.lifecycleGeneration !== metadata.execution.lifecycleGeneration ||
    !Number.isSafeInteger(params.observedAtMs) ||
    params.observedAtMs < 0
  ) {
    return false;
  }

  // Retire the private execution identity before active-run cleanup can remove
  // its public projection link; duplicate late events must stay invisible.
  registerMainRunRecoveryLifecycleFence(metadata.execution);
  bindChatAbortControllerMainRunRecoveryTerminalEvidence(entry, {
    runId: eventRunId,
    lifecycleGeneration: eventLifecycleGeneration,
    outcome: params.outcome,
    observedAtMs: params.observedAtMs,
  });
  registerMainRunRecoveryTerminalEvidencePending({
    publicRunId: metadata.publicRunId,
    execution: metadata.execution,
    ...(metadata.database ? { database: metadata.database } : {}),
  });
  return persistBoundChatAbortControllerMainRunRecoveryTerminalEvidence(entry);
}

export function registerChatAbortController(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  runId: string;
  runIdentity?: ActiveRunIdentity;
  sessionId: string;
  sessionKey?: string | null;
  agentId?: string;
  timeoutMs: number;
  ownerConnId?: string;
  ownerDeviceId?: string;
  providerId?: string;
  authProviderId?: string;
  controlUiVisible?: boolean;
  isAbortable?: (entry: ChatAbortControllerEntry) => boolean;
  onRemoved?: () => void;
  onSessionTerminalPersisted?: () => void;
  onSessionTerminalPersistenceFailed?: () => boolean;
  kind?: ChatAbortControllerEntry["kind"];
  turnKind?: ChatAbortControllerEntry["turnKind"];
  lifecycleGeneration?: string;
  now?: number;
  expiresAtMs?: number;
}): RegisteredChatAbortController {
  const controller = new AbortController();
  const cleanup = (opts?: { force?: boolean }) => {
    const entry = params.chatAbortControllers.get(params.runId);
    if (entry?.controller === controller) {
      if (opts?.force === true) {
        removeChatAbortControllerEntry(params.chatAbortControllers, params.runId, entry);
        return;
      }
      entry.registrationCleanupRequested = true;
      // Terminal event handling owns final removal once the event has been
      // observed. Runs that never emitted a terminal event still clean up here.
      if (entry.projectSessionTerminalPending === true) {
        return;
      }
      const persistence = entry.projectSessionTerminalPersistence;
      if (persistence) {
        void persistence.then(
          () => {
            if (params.chatAbortControllers.get(params.runId)?.controller === controller) {
              let evidenceResolved: boolean;
              try {
                evidenceResolved = notifyChatAbortControllerSessionTerminalPersisted(entry);
              } catch {
                // JSON persistence succeeded. The evidence retry already deferred
                // itself; maintenance owns the next SQLite attempt.
                return;
              }
              if (evidenceResolved) {
                removeChatAbortControllerEntry(params.chatAbortControllers, params.runId, entry);
              }
            }
          },
          () => {
            if (params.chatAbortControllers.get(params.runId)?.controller === controller) {
              notifyChatAbortControllerSessionTerminalPersistenceFailed(entry);
              removeChatAbortControllerEntry(params.chatAbortControllers, params.runId, entry);
            }
          },
        );
        return;
      }
      if (entry.projectSessionTerminalPersisted === true) {
        if (!notifyChatAbortControllerSessionTerminalPersisted(entry)) {
          return;
        }
      }
      removeChatAbortControllerEntry(params.chatAbortControllers, params.runId, entry);
    }
  };

  const runIdentity = createActiveRunIdentity(params.runId, params.runIdentity?.publicRunId);
  const hasIdentityCollision = activeRunIdentityAliases(runIdentity).some((runId) =>
    Boolean(resolveActiveRunByIdentity(params.chatAbortControllers, runId)),
  );
  if (!params.sessionKey || hasIdentityCollision) {
    // Duplicate run ids keep their fresh controller for caller cancellation, but
    // do not replace the registered entry that owns active-run projection.
    return { controller, registered: false, cleanup };
  }

  const rawNow = params.now ?? Date.now();
  const now = resolveDateTimestampMs(rawNow, 0);
  const explicitExpiresAtMs =
    params.expiresAtMs === undefined ? undefined : (asDateTimestampMs(params.expiresAtMs) ?? 0);
  const entry: ChatAbortControllerEntry = {
    controller,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runIdentity,
    lifecycleGeneration: params.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
    agentId: normalizeActiveAgentId(params.agentId),
    startedAtMs: now,
    expiresAtMs:
      explicitExpiresAtMs ??
      resolveChatRunExpiresAtMs({ now: rawNow, timeoutMs: params.timeoutMs }),
    ownerConnId: params.ownerConnId,
    ownerDeviceId: params.ownerDeviceId,
    providerId: normalizeProviderIdForActiveRun(params.providerId),
    authProviderId: normalizeProviderIdForActiveRun(params.authProviderId),
    controlUiVisible: params.controlUiVisible,
    isAbortable: params.isAbortable,
    onRemoved: params.onRemoved,
    onSessionTerminalPersisted: params.onSessionTerminalPersisted,
    onSessionTerminalPersistenceFailed: params.onSessionTerminalPersistenceFailed,
    projectSessionActive: true,
    kind: params.kind,
    turnKind: params.turnKind,
  };
  params.chatAbortControllers.set(params.runId, entry);
  return { controller, registered: true, entry, cleanup };
}

/** Record terminal persistence success and notify its owner after requested cleanup. */
export function notifyChatAbortControllerSessionTerminalPersisted(
  entry: ChatAbortControllerEntry,
): boolean {
  // This flag describes the JSON session-store write. The exact recovery
  // evidence may still need a bounded SQLite retry before cleanup can proceed.
  entry.projectSessionTerminalPersisted = true;
  entry.projectSessionTerminalPersistence = undefined;
  if (!retryChatAbortControllerMainRunRecoveryTerminalEvidence(entry, { force: true })) {
    return false;
  }
  entry.projectSessionTerminalPending = false;
  if (
    entry.registrationCleanupRequested !== true ||
    !entry.onSessionTerminalPersisted ||
    terminalPersistenceCallbacksInvoked.has(entry)
  ) {
    return true;
  }
  terminalPersistenceCallbacksInvoked.add(entry);
  try {
    entry.onSessionTerminalPersisted();
  } catch {
    // Terminal persistence already succeeded; callback failures cannot retain the run guard.
  }
  return true;
}

/** Notify the owner once; true means it claimed the failure instead of restart recovery. */
export function notifyChatAbortControllerSessionTerminalPersistenceFailed(
  entry: ChatAbortControllerEntry,
): boolean {
  if (terminalPersistenceFailureCallbackResults.has(entry)) {
    return terminalPersistenceFailureCallbackResults.get(entry) === true;
  }
  let handled = false;
  try {
    handled = entry.onSessionTerminalPersistenceFailed?.() === true;
  } catch {
    // A failed owner callback cannot suppress the existing restart-recovery path.
  }
  terminalPersistenceFailureCallbackResults.set(entry, handled);
  return handled;
}

/** True once a real terminal event or its persistence work owns cleanup. */
export function hasObservedChatAbortControllerTerminal(
  entry: ChatAbortControllerEntry | undefined,
): boolean {
  const observedAt = entry?.projectSessionTerminalObservedAt;
  return Boolean(
    entry?.projectSessionTerminalPersistence ||
    entry?.projectSessionTerminalPersisted === true ||
    (entry?.projectSessionTerminalPending === true &&
      typeof observedAt === "number" &&
      Number.isFinite(observedAt)),
  );
}

function normalizeProviderIdForActiveRun(providerId: string | undefined): string | undefined {
  const trimmed = providerId?.trim().toLowerCase();
  return trimmed || undefined;
}

function normalizeActiveAgentId(agentId: string | undefined): string | undefined {
  const trimmed = agentId?.trim().toLowerCase();
  return trimmed || undefined;
}

/**
 * Snapshot the live assistant text of any in-flight run for a session+agent. Used
 * by chat.history so a run that kept streaming while the client was switched away
 * — whose deltas the gateway delivered to a delivery key this client is no longer
 * subscribed to — is restored on switch-back.
 *
 * Matches a run the same way sessions.list's active-run projection does: an abort
 * entry can hold the requested key while chat run state holds the canonical store
 * key, so accept a match on EITHER `requestedSessionKey` or `canonicalSessionKey`,
 * scoping the shared "global" session by agent. Only runs still projected active
 * (`projectSessionActive !== false`, matching sessions.list; the terminal lifecycle
 * flips it to false), not aborted, and visible chat-send runs are returned, so a
 * finalized run — already in persisted history — is not duplicated and hidden
 * agent runs cannot be adopted by chat clients that will not receive their final
 * events.
 */
export function resolveInFlightRunSnapshot(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  requestedSessionKey: string;
  canonicalSessionKey: string;
  agentId?: string;
  defaultAgentId?: string;
}): { runId: string; text: string } | undefined {
  const matchesKey = (entry: ChatAbortControllerEntry, key: string): boolean => {
    if (entry.sessionKey !== key) {
      return false;
    }
    if (key !== "global") {
      return true;
    }
    const requestedAgentId =
      normalizeActiveAgentId(params.agentId) ?? normalizeActiveAgentId(params.defaultAgentId);
    if (!requestedAgentId) {
      return false;
    }
    const runAgentId =
      normalizeActiveAgentId(entry.agentId) ?? normalizeActiveAgentId(params.defaultAgentId);
    return runAgentId === requestedAgentId;
  };
  // Some callers/tests run without populated run state; guard like
  // collectTrackedActiveSessionRuns so a missing map is a no-op, not a throw.
  if (!(params.chatAbortControllers instanceof Map)) {
    return undefined;
  }
  // Pick the newest matching run rather than the first iterated. If a fast
  // restart/retry/stale-controller race leaves two active entries for the same
  // (sessionKey, agentId), Map insertion order is not a meaningful selector;
  // the latest `startedAtMs` is the run a switching-back client wants, and the
  // runId tie-break keeps the choice deterministic when timestamps collide.
  let best: { identity: ActiveRunIdentity; startedAtMs: number } | undefined;
  for (const [runId, entry] of params.chatAbortControllers) {
    const identity = resolveActiveRunIdentity(runId, entry);
    // Active unless explicitly projected inactive — mirrors sessions.list's
    // active-run contract. Ordinary agent runs stay hidden; recovered agent runs
    // carry a public client id and must be adoptable after reconnect.
    if (
      entry.projectSessionActive === false ||
      entry.controlUiVisible === false ||
      entry.controller.signal.aborted ||
      (entry.kind === "agent" && identity.executionRunId === identity.publicRunId)
    ) {
      continue;
    }
    if (
      !matchesKey(entry, params.requestedSessionKey) &&
      !matchesKey(entry, params.canonicalSessionKey)
    ) {
      continue;
    }
    const newer = best === undefined || entry.startedAtMs > best.startedAtMs;
    const tie =
      best !== undefined &&
      entry.startedAtMs === best.startedAtMs &&
      identity.executionRunId > best.identity.executionRunId;
    if (newer || tie) {
      best = { identity, startedAtMs: entry.startedAtMs };
    }
  }
  if (best === undefined) {
    return undefined;
  }
  // Adopt the run even when no assistant text is buffered yet. Some runtimes
  // (e.g. Codex) do not stream incremental assistant text — the result exists
  // only at completion — so there is nothing to show mid-run, but the client
  // should still adopt the run and show a `streaming` status (not idle) and
  // render the result cleanly when it lands.
  const bufferedText = params.chatRunBuffers?.get(best.identity.publicRunId) ?? "";
  const projected = projectLiveAssistantBufferedText(bufferedText, {
    suppressLeadFragments: true,
  });
  return { runId: best.identity.publicRunId, text: projected.suppress ? "" : projected.text };
}

export function boundInFlightRunSnapshotForChatHistory(params: {
  snapshot: { runId: string; text: string } | undefined;
  messages: unknown[];
  maxBytes: number;
}): { runId: string; text: string } | undefined {
  if (!params.snapshot?.text) {
    return params.snapshot;
  }
  const messagesBytes = jsonUtf8Bytes(params.messages);
  const snapshotBytes = jsonUtf8Bytes(params.snapshot);
  if (messagesBytes + snapshotBytes <= params.maxBytes) {
    return params.snapshot;
  }
  // The run id is the recovery contract; buffered partial text is opportunistic.
  // If it would break the history payload budget, keep adoption and wait for the
  // next live delta/final instead of sending an oversized chat.history response.
  return { runId: params.snapshot.runId, text: "" };
}

export type ChatAbortOps = {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  chatAbortedRuns: Map<string, ChatAbortMarker>;
  clearChatRunState: (runId: string) => void;
  removeChatRun: (
    executionRunId: string,
    publicRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  agentRunSeq: Map<string, number>;
  getRuntimeConfig?: () => OpenClawConfig;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
};

type TrackedChatRunAbortOps = {
  chatAbortControllers: ChatAbortOps["chatAbortControllers"];
  chatRunBuffers: ChatAbortOps["chatRunBuffers"];
  chatRunState: {
    abortedRuns: ChatAbortOps["chatAbortedRuns"];
    clearRun: ChatAbortOps["clearChatRunState"];
  };
  removeChatRun: ChatAbortOps["removeChatRun"];
  agentRunSeq: ChatAbortOps["agentRunSeq"];
  broadcast: ChatAbortOps["broadcast"];
  nodeSendToSession: ChatAbortOps["nodeSendToSession"];
};

export function abortTrackedChatRunById(
  ops: TrackedChatRunAbortOps,
  params: Parameters<typeof abortChatRunById>[1],
) {
  return abortChatRunById(
    {
      chatAbortControllers: ops.chatAbortControllers,
      chatRunBuffers: ops.chatRunBuffers,
      chatAbortedRuns: ops.chatRunState.abortedRuns,
      clearChatRunState: ops.chatRunState.clearRun,
      removeChatRun: ops.removeChatRun,
      agentRunSeq: ops.agentRunSeq,
      broadcast: ops.broadcast,
      nodeSendToSession: ops.nodeSendToSession,
    },
    params,
  );
}

function resolveChatAbortDeliverySessionKeys(
  ops: ChatAbortOps,
  sessionKey: string,
  agentId: string | undefined,
): string[] {
  if (sessionKey !== "global") {
    return [sessionKey];
  }
  const scopedAgentId = normalizeActiveAgentId(agentId);
  if (!scopedAgentId) {
    return [sessionKey];
  }
  const keys = [`agent:${scopedAgentId}:global`];
  const cfg = ops.getRuntimeConfig?.();
  const defaultAgentId = cfg ? resolveDefaultAgentId(cfg) : undefined;
  if (defaultAgentId && scopedAgentId === defaultAgentId) {
    keys.push(sessionKey);
  }
  return keys;
}

function broadcastChatAborted(
  ops: ChatAbortOps,
  params: {
    identity: ActiveRunIdentity;
    sessionKey: string;
    agentId?: string;
    stopReason?: string;
    partialText?: string;
    errorMessage?: string;
  },
) {
  const { identity, sessionKey, stopReason, partialText } = params;
  const errorMessage = readToolValidationErrorSummary(params.errorMessage);
  const defaultGlobalAgentId =
    sessionKey === "global" ? normalizeActiveAgentId(resolveDefaultGlobalAgentId(ops)) : undefined;
  const payloadAgentId =
    sessionKey === "global"
      ? (normalizeActiveAgentId(params.agentId) ?? defaultGlobalAgentId)
      : normalizeActiveAgentId(params.agentId);
  const payload = {
    runId: identity.publicRunId,
    sessionKey,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq: (ops.agentRunSeq.get(identity.executionRunId) ?? 0) + 1,
    state: "aborted" as const,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    message: partialText
      ? {
          role: "assistant",
          content: [{ type: "text", text: partialText }],
          timestamp: Date.now(),
        }
      : undefined,
  };
  ops.broadcast("chat", payload);
  for (const deliverySessionKey of resolveChatAbortDeliverySessionKeys(
    ops,
    sessionKey,
    payloadAgentId,
  )) {
    ops.nodeSendToSession(deliverySessionKey, "chat", payload);
  }
}

function resolveDefaultGlobalAgentId(ops: ChatAbortOps): string | undefined {
  const cfg = ops.getRuntimeConfig?.();
  return cfg ? resolveDefaultAgentId(cfg) : undefined;
}

export function isChatAbortControllerEntryAbortable(entry: ChatAbortControllerEntry): boolean {
  if (entry.controller.signal.aborted) {
    return false;
  }
  try {
    return entry.isAbortable?.(entry) !== false;
  } catch {
    return false;
  }
}

export function removeChatAbortControllerEntry(
  entries: Map<string, ChatAbortControllerEntry>,
  runId: string,
  expectedEntry?: ChatAbortControllerEntry,
): boolean {
  const resolved = resolveActiveRunByIdentity(entries, runId);
  if (!resolved || (expectedEntry && resolved.entry !== expectedEntry)) {
    return false;
  }
  const entry = resolved.entry;
  if (
    entry.mainRunRecoveryTerminalEvidence &&
    entry.mainRunRecoveryTerminalEvidenceResolved !== true
  ) {
    return false;
  }
  entries.delete(resolved.identity.executionRunId);
  try {
    entry.onRemoved?.();
  } catch {
    // Removal owns state cleanup even if a caller-provided release hook fails.
  }
  return true;
}

export function abortChatRunById(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
  },
): { aborted: boolean } {
  const { sessionKey, stopReason } = params;
  const resolved = resolveActiveRunByIdentity(ops.chatAbortControllers, params.runId);
  if (!resolved) {
    return { aborted: false };
  }
  const { entry: active, identity } = resolved;
  if (active.sessionKey !== sessionKey) {
    return { aborted: false };
  }
  if (!isChatAbortControllerEntryAbortable(active)) {
    return { aborted: false };
  }

  const bufferedText = ops.chatRunBuffers.get(identity.publicRunId);
  const partialText = bufferedText && bufferedText.trim() ? bufferedText : undefined;
  ops.chatAbortedRuns.set(identity.publicRunId, createChatAbortMarker());
  if (stopReason) {
    active.abortStopReason = stopReason;
  }
  active.projectSessionActive = false;
  // Reserve terminal ownership before abort listeners run; synchronous caller
  // cleanup must not erase the entry before Gateway observes the event below.
  active.projectSessionTerminalPending = true;
  active.projectSessionTerminalObservedAt = undefined;
  active.registrationCleanupRequested = true;
  active.controller.abort(createChatAbortSignalReason(stopReason));
  ops.clearChatRunState(identity.publicRunId);
  if (active.controlUiVisible !== false) {
    broadcastChatAborted(ops, {
      identity,
      sessionKey,
      agentId: active.agentId,
      stopReason,
      partialText,
      errorMessage: active.toolErrorSummary,
    });
  }
  emitAgentEvent({
    runId: identity.executionRunId,
    ...(active.lifecycleGeneration ? { lifecycleGeneration: active.lifecycleGeneration } : {}),
    sessionKey,
    agentId: active.agentId,
    stream: "lifecycle",
    data: {
      phase: "end",
      status: "cancelled",
      aborted: true,
      stopReason,
      ...(active.toolErrorSummary ? { toolErrorSummary: active.toolErrorSummary } : {}),
      startedAt: active.startedAtMs,
      endedAt: Date.now(),
    },
  });
  // Keep source-to-client projection registered through synchronous lifecycle
  // delivery. Removing it earlier can expose an internal recovery dispatch id.
  ops.removeChatRun(identity.executionRunId, identity.publicRunId, sessionKey);
  // Gateway listeners synchronously stamp the terminal observation. Keep the
  // entry as suspension-visible ownership until its persistence write settles.
  if (
    ops.chatAbortControllers.get(identity.executionRunId) === active &&
    active.projectSessionTerminalObservedAt === undefined &&
    !active.projectSessionTerminalPersistence
  ) {
    removeChatAbortControllerEntry(ops.chatAbortControllers, identity.executionRunId, active);
  }
  for (const runId of activeRunIdentityAliases(identity)) {
    ops.agentRunSeq.delete(runId);
  }
  return { aborted: true };
}

export function updateChatRunProvider(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
  params: {
    runId: string;
    providerId?: string;
    authProviderId?: string;
  },
): boolean {
  const resolved = resolveActiveRunByIdentity(chatAbortControllers, params.runId);
  if (!resolved) {
    return false;
  }
  const entry = resolved.entry;
  entry.providerId = normalizeProviderIdForActiveRun(params.providerId);
  entry.authProviderId = normalizeProviderIdForActiveRun(params.authProviderId);
  return true;
}

export function abortChatRunsForProvider(
  ops: ChatAbortOps,
  params: {
    providerId: string;
    stopReason?: string;
  },
): { runIds: string[] } {
  const providerId = normalizeProviderIdForActiveRun(params.providerId);
  if (!providerId) {
    return { runIds: [] };
  }
  const matches = [...ops.chatAbortControllers.entries()].filter(
    ([, entry]) =>
      normalizeProviderIdForActiveRun(entry.authProviderId) === providerId ||
      normalizeProviderIdForActiveRun(entry.providerId) === providerId,
  );
  const runIds: string[] = [];
  for (const [runId, entry] of matches) {
    const result = abortChatRunById(ops, {
      runId,
      sessionKey: entry.sessionKey,
      stopReason: params.stopReason,
    });
    if (result.aborted) {
      runIds.push(resolveActiveRunIdentity(runId, entry).publicRunId);
    }
  }
  return { runIds };
}
