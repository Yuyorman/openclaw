/** Single durable worker for accepted and restart-interrupted main runs. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { resolveStateDir } from "../config/paths.js";
import {
  appendAssistantMessageToSessionTranscript,
  loadSessionStore,
  resolveSessionStoreEntry,
  type SessionEntry,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildMainRunExactTurnFailureNotice,
  buildMainRunRecoveryFailureNotice,
  buildMainRunRecoveryFailureNoticeIdempotencyKey,
} from "../infra/main-run-recovery-policy.js";
import { readMainRunRecoveryApprovedTurn } from "../infra/main-run-recovery-transcript.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { drainPendingDeliveries, type RecoveryLogger } from "../infra/outbound/delivery-queue.js";
import type { QueuedDelivery } from "../infra/outbound/delivery-queue.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CommandLane } from "../process/lanes.js";
import { persistUserTurnTranscript } from "../sessions/user-turn-transcript.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  claimMainRunRecoveryLease,
  deferMainRunRecoveryRetryCas,
  fingerprintMainRunRecoverySource,
  getMainRunRecovery,
  listDueMainRunRecoveries,
  listNonTerminalMainRunRecoveries,
  listPriorBootMainRunRecoveries,
  listRetainedMainRunRecoveryLifecycleFences,
  MAIN_RUN_RECOVERY_LEASE_MS,
  MAIN_RUN_RECOVERY_TERMINAL_RETENTION_MS,
  pruneTerminalMainRunRecoveries,
  releaseMainRunRecoveryLease,
  renewMainRunRecoveryLease,
  requestMainRunRecoveryCancellation,
  transitionMainRunRecoveryStateCas,
  type MainRunRecovery,
  type MainRunRecoveryCas,
  type MainRunRecoveryExecution,
  type MainRunRecoveryTerminalOutcome,
} from "../state/main-run-recovery-store.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import {
  createMainRunRecoveryCancellationSettlementToken,
  createMainRunRecoveryExecutionSettlementToken,
  createMainRunRecoveryPreExecutionSettlementToken,
  finalizeMainRunRecoveryDispatch,
  prepareMainRunRecoveryDispatch,
  pruneMainRunRecoveryLifecycleFences,
  registerMainRunRecoveryLifecycleFence,
  registerMainRunRecoveryLifecycleFences,
  settleMainRunRecoveryCancellation,
  settleMainRunRecoveryExecution,
  settleMainRunRecoveryPreExecutionFailure,
  upsertMainRunRecoveryBarrier,
  verifyMainRunRecoveryTranscriptTail,
  waitForMainRunRecoveryDispatchAdoption,
  type MainRunRecoveryDispatchClaim,
} from "./main-run-recovery-runtime.js";

const log = createSubsystemLogger("main-run-recovery");
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const IDLE_POLL_MS = 5_000;
const LEASE_HEARTBEAT_MS = Math.floor(MAIN_RUN_RECOVERY_LEASE_MS / 3);
export const MAIN_RUN_RECOVERY_MAX_ATTEMPTS = 5;

type PhysicalSessionObservation =
  | {
      kind: "same";
      entry: SessionEntry;
      sessionKey: string;
      store: Record<string, SessionEntry>;
    }
  | {
      kind: "successor";
      entry: SessionEntry;
      sessionKey: string;
      store: Record<string, SessionEntry>;
    }
  | { kind: "absent" }
  | { kind: "unknown" };

export type MainRunRecoveryExecutionAbort = (
  execution: MainRunRecoveryExecution,
) => "aborted" | "inactive" | "unknown" | Promise<"aborted" | "inactive" | "unknown">;

export type MainRunRecoveryWorkerSummary = {
  processed: number;
  dispatched: number;
  terminalized: number;
  retried: number;
  skipped: number;
};

export type MainRunRecoveryStartupSummary = {
  hydrated: number;
  reconciled: number;
  terminalized: number;
};

export type MainRunRecoveryTerminalNotification = {
  publicRunId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  status: MainRunRecoveryTerminalOutcome["status"];
  endedAtMs: number;
  message?: string;
};

export type MainRunRecoveryWorkerOptions = {
  cfg: OpenClawConfig;
  currentBootId: string;
  database?: OpenClawStateDatabaseOptions;
  stateDir?: string;
  now?: () => number;
  createId?: () => string;
  abortExecution: MainRunRecoveryExecutionAbort;
  notifyTerminal?: (notification: MainRunRecoveryTerminalNotification) => void | Promise<void>;
  callAgent: (params: Record<string, unknown>) => Promise<{ status?: string }>;
  drainQueueEntry?: (id: string, database: Readonly<{ path: string }>) => void | Promise<void>;
};

export type MainRunRecoveryWorker = {
  runDue(): Promise<MainRunRecoveryWorkerSummary>;
  stop(): Promise<void>;
  wake(): void;
};

function recoveryCas(recovery: MainRunRecovery): MainRunRecoveryCas {
  if (recovery.state === "terminal") {
    throw new Error(`main-run recovery ${recovery.publicRunId} is already terminal`);
  }
  return {
    publicRunId: recovery.publicRunId,
    expectedRevision: recovery.revision,
    expectedState: recovery.state,
    agentId: recovery.agentId,
    sessionKey: recovery.sessionKey,
    sessionKeyAliases: recovery.sessionKeyAliases,
    sessionId: recovery.sessionId,
    storePath: recovery.storePath,
  };
}

function ensureBarrier(recovery: MainRunRecovery): void {
  upsertMainRunRecoveryBarrier({
    aliases: [recovery.sessionKey, ...recovery.sessionKeyAliases],
    ledgerRunId: recovery.publicRunId,
    sessionId: recovery.sessionId,
    storePath: recovery.storePath,
  });
}

function observePhysicalSession(recovery: MainRunRecovery): PhysicalSessionObservation {
  try {
    const raw = fs.readFileSync(recovery.storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "unknown" };
    }
  } catch {
    return { kind: "unknown" };
  }
  let store: Record<string, SessionEntry>;
  try {
    store = loadSessionStore(recovery.storePath, { skipCache: true });
  } catch {
    return { kind: "unknown" };
  }

  const keys = [...new Set([recovery.sessionKey, ...recovery.sessionKeyAliases])];
  const keyed = keys.flatMap((sessionKey) => {
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    return resolved.existing ? [{ entry: resolved.existing, sessionKey }] : [];
  });
  const same = keyed.find(({ entry }) => entry.sessionId === recovery.sessionId);
  if (same) {
    return { kind: "same", ...same, store };
  }
  const successor = keyed[0];
  return successor ? { kind: "successor", ...successor, store } : { kind: "absent" };
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(6, attemptCount - 1));
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}

function failureTime(recovery: MainRunRecovery, now: number): number {
  return Math.max(now, recovery.acceptedAtMs);
}

function emptySummary(): MainRunRecoveryWorkerSummary {
  return { processed: 0, dispatched: 0, terminalized: 0, retried: 0, skipped: 0 };
}

async function notifyTerminal(
  recovery: MainRunRecovery,
  notify: MainRunRecoveryWorkerOptions["notifyTerminal"],
  message?: string,
): Promise<void> {
  const outcome = recovery.terminalOutcome;
  if (!notify || recovery.state !== "terminal" || !outcome) {
    return;
  }
  const notification: MainRunRecoveryTerminalNotification = {
    publicRunId: recovery.publicRunId,
    agentId: recovery.agentId,
    sessionKey: recovery.sessionKey,
    sessionId: recovery.sessionId,
    status: outcome.status,
    endedAtMs: outcome.endedAtMs,
    ...(message ? { message } : {}),
  };
  try {
    await notify(notification);
  } catch (err) {
    log.warn(
      `main-run recovery ${recovery.publicRunId} terminal projection failed: ${String(err)}`,
    );
  }
}

type MainRunRecoveryWorkerStateLocation = {
  database: Readonly<{ path: string }>;
  queueStateDir?: string;
};

function normalizeWorkerStateLocation(
  params: Pick<MainRunRecoveryWorkerOptions, "database" | "drainQueueEntry" | "stateDir">,
): MainRunRecoveryWorkerStateLocation {
  const baseEnv = params.database?.env ?? process.env;
  const queueStateDir = params.stateDir
    ? resolveStateDir({ ...baseEnv, OPENCLAW_STATE_DIR: params.stateDir })
    : params.database?.path
      ? undefined
      : resolveStateDir(baseEnv);
  const stateDirectoryDatabase = queueStateDir
    ? openOpenClawStateDatabase({
        env: { ...baseEnv, OPENCLAW_STATE_DIR: queueStateDir },
      }).path
    : undefined;
  const configuredDatabase = openOpenClawStateDatabase(
    params.database?.path
      ? { path: params.database.path }
      : params.database?.env
        ? { env: params.database.env }
        : { env: { ...baseEnv, ...(queueStateDir ? { OPENCLAW_STATE_DIR: queueStateDir } : {}) } },
  ).path;
  if (stateDirectoryDatabase && stateDirectoryDatabase !== configuredDatabase) {
    throw new Error("main-run recovery stateDir and database resolve to different SQLite files");
  }
  if (!queueStateDir && !params.drainQueueEntry) {
    throw new Error("custom main-run recovery database requires a path-aware queue drain");
  }
  return {
    database: { path: configuredDatabase },
    ...(queueStateDir ? { queueStateDir } : {}),
  };
}

type MainRunRecoveryLeaseGuard = {
  checkpoint(forceRenewal?: boolean): MainRunRecovery | undefined;
  stop(): void;
};

function createLeaseGuard(params: {
  recovery: MainRunRecovery;
  leaseOwner: string;
  database: OpenClawStateDatabaseOptions;
  now: () => number;
  shouldStop: () => boolean;
}): MainRunRecoveryLeaseGuard {
  let stopped = false;
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const refresh = (forceRenewal: boolean): MainRunRecovery | undefined => {
    if (stopped || lost || params.shouldStop()) {
      lost = true;
      return undefined;
    }
    try {
      const currentTime = params.now();
      const current = getMainRunRecovery(params.recovery.publicRunId, params.database);
      if (
        !current ||
        current.state === "terminal" ||
        current.lease?.owner !== params.leaseOwner ||
        current.lease.expiresAtMs <= currentTime
      ) {
        lost = true;
        return undefined;
      }
      if (!forceRenewal && current.lease.expiresAtMs - currentTime > LEASE_HEARTBEAT_MS) {
        return current;
      }
      const renewed = renewMainRunRecoveryLease(
        {
          ...recoveryCas(current),
          leaseOwner: params.leaseOwner,
          nowMs: currentTime,
          leaseDurationMs: MAIN_RUN_RECOVERY_LEASE_MS,
        },
        params.database,
      );
      if (!renewed) {
        lost = true;
      }
      return renewed;
    } catch (err) {
      lost = true;
      log.warn(`main-run recovery lease heartbeat failed: ${String(err)}`);
      return undefined;
    }
  };

  const schedule = () => {
    timer = setTimeout(() => {
      timer = undefined;
      if (refresh(true)) {
        schedule();
      }
    }, LEASE_HEARTBEAT_MS);
    timer.unref?.();
  };
  schedule();
  return {
    checkpoint: (forceRenewal = false) => refresh(forceRenewal),
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

export function hydrateMainRunRecoveryBarriers(
  params: { database?: OpenClawStateDatabaseOptions; nowMs?: number } = {},
): { hydrated: number } {
  const fenceExpiryMs = (params.nowMs ?? Date.now()) + MAIN_RUN_RECOVERY_TERMINAL_RETENTION_MS;
  registerMainRunRecoveryLifecycleFences(
    listRetainedMainRunRecoveryLifecycleFences(
      { nowMs: params.nowMs ?? Date.now() },
      params.database,
    ),
    fenceExpiryMs,
  );
  let hydrated = 0;
  for (const recovery of listNonTerminalMainRunRecoveries(params.database)) {
    ensureBarrier(recovery);
    hydrated += 1;
  }
  return { hydrated };
}

function settleRecordedEvidence(
  recovery: MainRunRecovery,
  now: number,
  database: OpenClawStateDatabaseOptions | undefined,
): MainRunRecovery | undefined {
  if (!recovery.execution || !recovery.terminalEvidence || recovery.state === "terminal") {
    return undefined;
  }
  const terminalNow = Math.max(
    now,
    recovery.acceptedAtMs,
    recovery.terminalEvidence.outcome.endedAtMs,
    recovery.terminalEvidence.observedAtMs,
  );
  const token = createMainRunRecoveryExecutionSettlementToken(recovery, database);
  return settleMainRunRecoveryExecution(token, {
    nowMs: terminalNow,
  });
}

/** Hydrates admission barriers and reconciles prior-boot execution ownership. */
export async function reconcileMainRunRecoveryStartup(params: {
  currentBootId: string;
  database?: OpenClawStateDatabaseOptions;
  nowMs?: number;
  notifyTerminal?: MainRunRecoveryWorkerOptions["notifyTerminal"];
}): Promise<MainRunRecoveryStartupSummary> {
  const now = params.nowMs ?? Date.now();
  const { hydrated } = hydrateMainRunRecoveryBarriers({
    database: params.database,
    nowMs: now,
  });
  let reconciled = 0;
  let terminalized = 0;
  for (const snapshot of listPriorBootMainRunRecoveries(params.currentBootId, params.database)) {
    let current = getMainRunRecovery(snapshot.publicRunId, params.database);
    if (!current || current.state === "terminal") {
      continue;
    }
    if (current.terminalEvidence) {
      for (let attempt = 0; attempt < 2 && current.terminalEvidence; attempt += 1) {
        const terminal = settleRecordedEvidence(
          current,
          Math.max(now, current.acceptedAtMs),
          params.database,
        );
        if (terminal) {
          await notifyTerminal(terminal, params.notifyTerminal);
          terminalized += 1;
          break;
        }
        current = getMainRunRecovery(current.publicRunId, params.database);
        if (!current || current.state === "terminal") {
          break;
        }
      }
      reconciled += 1;
      continue;
    }
    if (current.state === "running") {
      const transitionAtMs = Math.max(now, current.acceptedAtMs);
      const pending = transitionMainRunRecoveryStateCas(
        {
          ...recoveryCas(current),
          nextState: "recovery_pending",
          currentBootId: params.currentBootId,
          nextAttemptAtMs: transitionAtMs,
          lastError: "gateway restarted before terminal evidence",
          nowMs: transitionAtMs,
        },
        params.database,
      );
      if (pending) {
        if (current.execution) {
          registerMainRunRecoveryLifecycleFence(
            current.execution,
            now + MAIN_RUN_RECOVERY_TERMINAL_RETENTION_MS,
          );
        }
        reconciled += 1;
      }
    }
  }
  pruneTerminalMainRunRecoveries(now, params.database);
  return { hydrated, reconciled, terminalized };
}

async function requestAbortCancellation(params: {
  recovery: MainRunRecovery;
  now: number;
  createId: () => string;
  database?: OpenClawStateDatabaseOptions;
}): Promise<MainRunRecovery | undefined> {
  const current = getMainRunRecovery(params.recovery.publicRunId, params.database);
  if (!current || current.state === "terminal") {
    return current;
  }
  if (current.state === "cancelling") {
    return current.cancellation?.kind === "abort" ? current : undefined;
  }
  const requestedAtMs = failureTime(current, params.now);
  return requestMainRunRecoveryCancellation(
    {
      ...recoveryCas(current),
      cancellation: { kind: "abort", epoch: params.createId(), requestedAtMs },
      nowMs: requestedAtMs,
    },
    params.database,
  );
}

function releaseForRetry(params: {
  recovery: MainRunRecovery;
  leaseOwner: string;
  now: number;
  reason: string;
  database?: OpenClawStateDatabaseOptions;
}): boolean {
  const current = getMainRunRecovery(params.recovery.publicRunId, params.database);
  if (!current || current.state === "terminal" || current.lease?.owner !== params.leaseOwner) {
    return false;
  }
  return Boolean(
    releaseMainRunRecoveryLease(
      {
        ...recoveryCas(current),
        leaseOwner: params.leaseOwner,
        nowMs: params.now,
        nextAttemptAtMs: params.now + retryDelayMs(current.attemptCount),
        lastError: params.reason,
      },
      params.database,
    ),
  );
}

async function settleCancellation(params: {
  recovery: MainRunRecovery;
  now: () => number;
  lease: MainRunRecoveryLeaseGuard;
  currentBootId: string;
  database?: OpenClawStateDatabaseOptions;
  notifyTerminal?: MainRunRecoveryWorkerOptions["notifyTerminal"];
  abortExecution: MainRunRecoveryExecutionAbort;
}): Promise<"terminal" | "retry" | "skip"> {
  let recovery = params.lease.checkpoint();
  if (!recovery) {
    return "retry";
  }
  const cancellation = recovery.cancellation;
  if (recovery.state !== "cancelling" || !cancellation) {
    return "skip";
  }
  if (recovery.terminalEvidence) {
    const terminal = settleRecordedEvidence(recovery, params.now(), params.database);
    if (terminal) {
      await notifyTerminal(terminal, params.notifyTerminal);
      return "terminal";
    }
    return "retry";
  }

  let proven: boolean;
  if (cancellation.kind === "abort") {
    if (!recovery.execution || recovery.bootId !== params.currentBootId) {
      proven = true;
    } else {
      const abortResult = await params.abortExecution(recovery.execution);
      recovery = params.lease.checkpoint();
      if (!recovery || recovery.state !== "cancelling") {
        return "retry";
      }
      if (recovery.terminalEvidence) {
        const terminal = settleRecordedEvidence(recovery, params.now(), params.database);
        if (terminal) {
          await notifyTerminal(terminal, params.notifyTerminal);
          return "terminal";
        }
        return "retry";
      }
      if (abortResult !== "inactive") {
        return "retry";
      }
      proven = true;
    }
  } else {
    if (!params.lease.checkpoint()) {
      return "retry";
    }
    const physical = observePhysicalSession(recovery);
    if (physical.kind === "unknown") {
      return "retry";
    }
    proven =
      cancellation.kind === "reset"
        ? physical.kind === "successor"
        : physical.kind === "absent" || physical.kind === "successor";
  }
  if (!proven) {
    return "retry";
  }
  recovery = params.lease.checkpoint();
  if (!recovery || recovery.state !== "cancelling" || !recovery.cancellation) {
    return "retry";
  }
  const settlementAtMs = params.now();
  const endedAtMs = Math.max(
    settlementAtMs,
    recovery.acceptedAtMs,
    recovery.cancellation.requestedAtMs,
  );
  const token = createMainRunRecoveryCancellationSettlementToken(recovery, params.database);
  const terminal = settleMainRunRecoveryCancellation(token, {
    endedAtMs,
    nowMs: endedAtMs,
  });
  if (!terminal) {
    return "retry";
  }
  await notifyTerminal(terminal, params.notifyTerminal);
  return "terminal";
}

async function persistAcceptedTurn(params: {
  recovery: MainRunRecovery;
  currentBootId: string;
  now: () => number;
  lease: MainRunRecoveryLeaseGuard;
  database?: OpenClawStateDatabaseOptions;
  createId: () => string;
}): Promise<MainRunRecovery | undefined> {
  const recovery = params.lease.checkpoint();
  if (!recovery) {
    return undefined;
  }
  if (recovery.kind !== "exact_turn" || recovery.state !== "accepted" || !recovery.envelope) {
    return undefined;
  }
  const physical = observePhysicalSession(recovery);
  if (physical.kind === "unknown") {
    return undefined;
  }
  if (physical.kind !== "same") {
    await requestAbortCancellation({ ...params, recovery, now: params.now() });
    return undefined;
  }
  const persisted = await persistUserTurnTranscript({
    agentId: recovery.agentId,
    sessionId: recovery.sessionId,
    sessionKey: physical.sessionKey,
    sessionEntry: physical.entry,
    sessionStore: physical.store,
    storePath: recovery.storePath,
    expectedSessionId: recovery.sessionId,
    message: recovery.envelope.approvedTurn,
    updateMode: "inline",
  });
  const current = params.lease.checkpoint();
  if (!current) {
    return undefined;
  }
  if (!persisted) {
    const latestPhysical = observePhysicalSession(current);
    if (latestPhysical.kind !== "same" && latestPhysical.kind !== "unknown") {
      await requestAbortCancellation({ ...params, recovery: current, now: params.now() });
    }
    return undefined;
  }
  const handoffAtMs = Math.max(params.now(), current.acceptedAtMs);
  return transitionMainRunRecoveryStateCas(
    {
      ...recoveryCas(current),
      nextState: "transcript_owned",
      currentBootId: params.currentBootId,
      nextAttemptAtMs: handoffAtMs,
      nowMs: handoffAtMs,
    },
    params.database,
  );
}

function buildQueueEntry(params: {
  recovery: Extract<MainRunRecovery, { kind: "session_resume" }>;
  id: string;
  notice: string;
  now: number;
}): QueuedDelivery | undefined {
  const context = params.recovery.envelope?.delivery.context;
  if (!context || !isDeliverableMessageChannel(context.channel)) {
    return undefined;
  }
  return {
    id: params.id,
    enqueuedAt: params.now,
    retryCount: 0,
    channel: context.channel,
    to: context.to,
    accountId: context.accountId,
    threadId: context.threadId,
    payloads: [{ text: params.notice }],
    queuePolicy: "required",
    bestEffort: false,
  };
}

async function finalizePreExecutionFailure(params: {
  recovery: MainRunRecovery;
  now: () => number;
  lease: MainRunRecoveryLeaseGuard;
  database?: OpenClawStateDatabaseOptions;
  notifyTerminal?: MainRunRecoveryWorkerOptions["notifyTerminal"];
  createId: () => string;
  drainQueueEntry: (id: string, database: Readonly<{ path: string }>) => void | Promise<void>;
}): Promise<"terminal" | "retry" | "cancelled"> {
  let recovery = params.lease.checkpoint();
  if (
    !recovery ||
    (recovery.state !== "transcript_owned" && recovery.state !== "recovery_pending")
  ) {
    return "retry";
  }
  const envelope = recovery.kind === "session_resume" ? recovery.envelope : undefined;
  const notice =
    recovery.kind === "exact_turn"
      ? buildMainRunExactTurnFailureNotice()
      : buildMainRunRecoveryFailureNotice();
  const idempotencyKey = buildMainRunRecoveryFailureNoticeIdempotencyKey(recovery.publicRunId);
  const appended = await appendAssistantMessageToSessionTranscript({
    agentId: recovery.agentId,
    sessionKey: recovery.sessionKey,
    expectedSessionId: recovery.sessionId,
    ...(envelope?.lifecycleRevision
      ? { expectedLifecycleRevision: envelope.lifecycleRevision }
      : {}),
    text: notice,
    idempotencyKey,
    storePath: recovery.storePath,
    updateMode: "inline",
    touchSessionEntry: false,
  });
  const current = params.lease.checkpoint();
  if (!current || current.kind !== recovery.kind) {
    return "retry";
  }
  if (!appended.ok) {
    if (appended.code === "session-rebound") {
      await requestAbortCancellation({ ...params, recovery: current, now: params.now() });
      return "cancelled";
    }
    return "retry";
  }

  recovery = current;
  const endedAtMs = failureTime(recovery, params.now());
  const outcome = { status: "failed" as const, endedAtMs };
  const queueEntry =
    recovery.kind === "session_resume"
      ? buildQueueEntry({ recovery, id: idempotencyKey, notice, now: endedAtMs })
      : undefined;
  const transactionEntry = queueEntry
    ? {
        queueName: "outbound",
        id: queueEntry.id,
        entry: { ...queueEntry } as unknown as Record<string, unknown>,
        entryKind: "outbound",
        sessionKey: recovery.sessionKey,
        channel: queueEntry.channel,
        target: queueEntry.to,
        ...(queueEntry.accountId ? { accountId: queueEntry.accountId } : {}),
        enqueuedAtMs: queueEntry.enqueuedAt,
      }
    : undefined;
  const token = createMainRunRecoveryPreExecutionSettlementToken(recovery, params.database);
  const terminal = settleMainRunRecoveryPreExecutionFailure(token, {
    outcome,
    nowMs: endedAtMs,
    ...(transactionEntry ? { queueEntry: transactionEntry } : {}),
  });
  if (!terminal) {
    return "retry";
  }
  await notifyTerminal(terminal, params.notifyTerminal, notice);
  if (queueEntry) {
    try {
      await params.drainQueueEntry(queueEntry.id, {
        path: openOpenClawStateDatabase(params.database).path,
      });
    } catch (err) {
      log.warn(`failure notice ${queueEntry.id} remains queued: ${String(err)}`);
    }
  }
  return "terminal";
}

function buildAgentRequest(
  recovery: MainRunRecovery,
  claim: MainRunRecoveryDispatchClaim,
  dispatchRunId: string,
): Record<string, unknown> {
  const context = recovery.kind === "session_resume" ? recovery.envelope?.delivery.context : null;
  const deliver = Boolean(context && isDeliverableMessageChannel(context.channel));
  return {
    agentId: recovery.agentId,
    message: claim.message,
    sessionKey: recovery.sessionKey,
    idempotencyKey: dispatchRunId,
    lane: CommandLane.Main,
    deliver,
    ...(deliver && context
      ? {
          channel: context.channel,
          to: context.to,
          bestEffortDeliver: true,
          ...(context.accountId ? { accountId: context.accountId } : {}),
          ...(context.threadId != null ? { threadId: String(context.threadId) } : {}),
        }
      : {}),
  };
}

async function dispatchRecovery(params: {
  recovery: MainRunRecovery;
  lease: MainRunRecoveryLeaseGuard;
  currentBootId: string;
  database?: OpenClawStateDatabaseOptions;
  createId: () => string;
  callAgent: (params: Record<string, unknown>) => Promise<{ status?: string }>;
}): Promise<boolean> {
  const recovery = params.lease.checkpoint(true);
  if (!recovery) {
    throw new Error("main-run recovery lease was lost before dispatch");
  }
  // Ownership stays live until gateway start adopts this exact lease owner.
  // Gateway rereads the current revision; heartbeat revisions are not dispatch identity.
  const dispatchRunId = params.createId();
  const claim = prepareMainRunRecoveryDispatch({
    currentBootId: params.currentBootId,
    dispatchRunId,
    database: params.database,
    recovery,
  });
  // The dispatch token owns heartbeat from here through provider adoption.
  params.lease.stop();
  let response: { status?: string };
  try {
    response = await params.callAgent(buildAgentRequest(recovery, claim, dispatchRunId));
  } catch (err) {
    finalizeMainRunRecoveryDispatch(claim.dispatchToken);
    throw err;
  }
  if (response.status !== "accepted" && response.status !== "in_flight") {
    finalizeMainRunRecoveryDispatch(claim.dispatchToken);
    throw new Error(`recovery dispatch returned ${response.status ?? "no status"}`);
  }
  const adoption = await waitForMainRunRecoveryDispatchAdoption(claim.dispatchToken);
  if (adoption !== "admitted") {
    throw new Error("recovery dispatch was rejected before provider admission");
  }
  return true;
}

function makeDefaultQueueDrain(
  params: MainRunRecoveryWorkerOptions,
  location: MainRunRecoveryWorkerStateLocation,
): (id: string, database: Readonly<{ path: string }>) => Promise<void> {
  if (params.drainQueueEntry) {
    return async (id, database) => await params.drainQueueEntry?.(id, database);
  }
  const stateDir = location.queueStateDir;
  if (!stateDir) {
    throw new Error("main-run recovery queue state directory is unavailable");
  }
  const queueLog: RecoveryLogger = {
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
    error: (message) => log.error(message),
  };
  return async (id, database) => {
    if (database.path !== location.database.path) {
      throw new Error("main-run recovery queue drain database mismatch");
    }
    await drainPendingDeliveries({
      drainKey: `main-run-recovery:${id}`,
      logLabel: "Main-run recovery failure notice",
      cfg: params.cfg,
      log: queueLog,
      stateDir,
      deliver: deliverOutboundPayloads,
      selectEntry: (entry) => ({ match: entry.id === id, bypassBackoff: true }),
    });
  };
}

async function processLeasedRecovery(params: {
  recovery: MainRunRecovery;
  now: () => number;
  lease: MainRunRecoveryLeaseGuard;
  currentBootId: string;
  database?: OpenClawStateDatabaseOptions;
  notifyTerminal?: MainRunRecoveryWorkerOptions["notifyTerminal"];
  createId: () => string;
  callAgent: (params: Record<string, unknown>) => Promise<{ status?: string }>;
  drainQueueEntry: (id: string, database: Readonly<{ path: string }>) => void | Promise<void>;
}): Promise<"dispatched" | "terminal" | "retry" | "cancelled"> {
  let recovery = params.lease.checkpoint();
  if (!recovery) {
    return "retry";
  }
  if (recovery.state === "accepted") {
    const owned = await persistAcceptedTurn({ ...params, recovery });
    if (!owned) {
      return "retry";
    }
    recovery = owned;
  }
  if (recovery.state === "cancelling") {
    return "retry";
  }
  const requiresFailureFinalization =
    recovery.attemptCount > MAIN_RUN_RECOVERY_MAX_ATTEMPTS ||
    (recovery.kind === "session_resume" && recovery.envelope?.resolution.kind === "fail");
  if (requiresFailureFinalization) {
    return await finalizePreExecutionFailure({ ...params, recovery });
  }

  recovery = params.lease.checkpoint();
  if (!recovery) {
    return "retry";
  }
  const physical = observePhysicalSession(recovery);
  if (physical.kind === "unknown") {
    return "retry";
  }
  if (physical.kind !== "same") {
    await requestAbortCancellation({ ...params, recovery, now: params.now() });
    return "cancelled";
  }
  if (
    recovery.kind === "session_resume" &&
    recovery.envelope?.lifecycleRevision &&
    recovery.envelope.lifecycleRevision !== physical.entry.lifecycleRevision
  ) {
    await requestAbortCancellation({ ...params, recovery, now: params.now() });
    return "cancelled";
  }
  if (recovery.kind === "session_resume") {
    const verification = await verifyMainRunRecoveryTranscriptTail({
      recovery,
      entry: physical.entry,
    });
    const current = params.lease.checkpoint();
    if (!current) {
      return "retry";
    }
    recovery = current;
    if (!verification.ok) {
      await requestAbortCancellation({ ...params, recovery, now: params.now() });
      return "cancelled";
    }
  } else {
    const approvedTurn = await readMainRunRecoveryApprovedTurn({
      entry: physical.entry,
      sourceKey: recovery.sourceKey,
      storePath: recovery.storePath,
    });
    const sourceFingerprint = approvedTurn
      ? fingerprintMainRunRecoverySource({
          sourceKey: recovery.sourceKey,
          identity: {
            agentId: recovery.agentId,
            sessionKey: recovery.sessionKey,
            sessionKeyAliases: recovery.sessionKeyAliases,
            sessionId: recovery.sessionId,
            storePath: recovery.storePath,
          },
          envelope: { kind: "exact_turn", approvedTurn },
          ownerPrincipal: recovery.ownerPrincipal,
          authorization: recovery.authorization,
        })
      : undefined;
    if (sourceFingerprint !== recovery.sourceFingerprint) {
      return "retry";
    }
  }
  const current = params.lease.checkpoint();
  if (!current) {
    return "retry";
  }
  await dispatchRecovery({
    recovery: current,
    lease: params.lease,
    currentBootId: params.currentBootId,
    database: params.database,
    createId: params.createId,
    callAgent: params.callAgent,
  });
  return "dispatched";
}

export function createMainRunRecoveryWorker(
  params: MainRunRecoveryWorkerOptions,
): MainRunRecoveryWorker {
  const now = params.now ?? Date.now;
  const createId = params.createId ?? randomUUID;
  const location = normalizeWorkerStateLocation(params);
  const database = location.database;
  const callAgent = params.callAgent;
  const drainQueueEntry = makeDefaultQueueDrain(params, location);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<MainRunRecoveryWorkerSummary> | undefined;

  const schedule = (delayMs: number) => {
    if (stopped) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(
      () => {
        timer = undefined;
        void runDue().catch((err: unknown) => {
          log.warn(`main-run recovery worker failed: ${String(err)}`);
        });
      },
      Math.max(0, delayMs),
    );
    timer.unref?.();
  };

  const scheduleNext = () => {
    const currentTime = now();
    let nextAt = currentTime + IDLE_POLL_MS;
    for (const recovery of listNonTerminalMainRunRecoveries(database)) {
      if (recovery.terminalEvidence) {
        const leaseFloor =
          recovery.bootId === params.currentBootId ? (recovery.lease?.expiresAtMs ?? 0) : 0;
        nextAt = Math.min(nextAt, Math.max(recovery.nextAttemptAtMs ?? currentTime, leaseFloor));
        continue;
      }
      if (recovery.state === "running") {
        continue;
      }
      const dueAt = Math.max(
        recovery.nextAttemptAtMs ?? currentTime,
        recovery.lease?.expiresAtMs ?? 0,
      );
      nextAt = Math.min(nextAt, dueAt);
    }
    schedule(Math.max(0, nextAt - currentTime));
  };

  const executeDue = async (): Promise<MainRunRecoveryWorkerSummary> => {
    const summary = emptySummary();
    if (stopped) {
      return summary;
    }
    const scanAtMs = now();
    for (const snapshot of listDueMainRunRecoveries(
      { nowMs: scanAtMs, currentBootId: params.currentBootId },
      database,
    )) {
      if (stopped) {
        break;
      }
      summary.processed += 1;
      try {
        let current = getMainRunRecovery(snapshot.publicRunId, database);
        if (!current || current.state === "terminal") {
          summary.skipped += 1;
          continue;
        }
        ensureBarrier(current);
        if (current.terminalEvidence) {
          let terminal: MainRunRecovery | undefined;
          for (let attempt = 0; attempt < 2 && current.terminalEvidence; attempt += 1) {
            terminal = settleRecordedEvidence(current, now(), database);
            if (terminal) {
              break;
            }
            const latest = getMainRunRecovery(current.publicRunId, database);
            if (!latest || latest.state === "terminal") {
              current = latest ?? current;
              break;
            }
            current = latest;
          }
          if (terminal) {
            await notifyTerminal(terminal, params.notifyTerminal);
            summary.terminalized += 1;
          } else {
            const retryAtMs = now();
            const deferred =
              current.state === "terminal"
                ? undefined
                : deferMainRunRecoveryRetryCas(
                    {
                      ...recoveryCas(current),
                      nowMs: retryAtMs,
                      nextAttemptAtMs: retryAtMs + retryDelayMs(current.attemptCount + 1),
                      lastError: "terminal evidence settlement pending",
                    },
                    database,
                  );
            if (deferred) {
              summary.retried += 1;
            } else {
              summary.skipped += 1;
            }
          }
          continue;
        }
        if (current.state === "running") {
          summary.skipped += 1;
          continue;
        }
        const leaseOwner = `${params.currentBootId}:${createId()}`;
        if (stopped) {
          break;
        }
        const claimAtMs = now();
        const claimed = claimMainRunRecoveryLease(
          {
            ...recoveryCas(current),
            leaseOwner,
            nowMs: claimAtMs,
            leaseDurationMs: MAIN_RUN_RECOVERY_LEASE_MS,
            currentBootId: params.currentBootId,
          },
          database,
        );
        if (!claimed) {
          summary.skipped += 1;
          continue;
        }
        const lease = createLeaseGuard({
          recovery: claimed,
          leaseOwner,
          database,
          now,
          shouldStop: () => stopped,
        });
        try {
          if (claimed.state === "cancelling") {
            const result = await settleCancellation({
              recovery: claimed,
              now,
              lease,
              currentBootId: params.currentBootId,
              database,
              notifyTerminal: params.notifyTerminal,
              abortExecution: params.abortExecution,
            });
            if (result === "terminal") {
              summary.terminalized += 1;
            } else {
              const releaseAtMs = now();
              releaseForRetry({
                recovery: claimed,
                leaseOwner,
                now: releaseAtMs,
                reason: "cancellation evidence pending",
                database,
              });
              summary.retried += 1;
            }
            continue;
          }
          const result = await processLeasedRecovery({
            recovery: claimed,
            now,
            lease,
            currentBootId: params.currentBootId,
            database,
            notifyTerminal: params.notifyTerminal,
            createId,
            callAgent,
            drainQueueEntry,
          });
          if (result === "dispatched") {
            summary.dispatched += 1;
          } else if (result === "terminal") {
            summary.terminalized += 1;
          } else if (result === "cancelled") {
            const releaseAtMs = now();
            releaseForRetry({
              recovery: claimed,
              leaseOwner,
              now: releaseAtMs,
              reason: "recovery cancellation requested",
              database,
            });
            summary.retried += 1;
          } else {
            const releaseAtMs = now();
            releaseForRetry({
              recovery: claimed,
              leaseOwner,
              now: releaseAtMs,
              reason: "recovery work not committed",
              database,
            });
            summary.retried += 1;
          }
        } catch (err) {
          const releaseAtMs = now();
          releaseForRetry({
            recovery: claimed,
            leaseOwner,
            now: releaseAtMs,
            reason: "recovery dispatch failed",
            database,
          });
          log.warn(`main-run recovery ${claimed.publicRunId} retrying: ${String(err)}`);
          summary.retried += 1;
        } finally {
          lease.stop();
        }
      } catch (err) {
        log.warn(
          `main-run recovery ${snapshot.publicRunId} isolated after row error: ${String(err)}`,
        );
        const retryAtMs = now();
        const deferred = deferMainRunRecoveryRetryCas(
          {
            ...recoveryCas(snapshot),
            nowMs: retryAtMs,
            nextAttemptAtMs: retryAtMs + retryDelayMs(snapshot.attemptCount + 1),
            lastError: "recovery row processing failed",
          },
          database,
        );
        if (deferred) {
          summary.retried += 1;
        } else {
          summary.skipped += 1;
        }
      }
    }
    const pruneAtMs = now();
    pruneTerminalMainRunRecoveries(pruneAtMs, database);
    pruneMainRunRecoveryLifecycleFences(pruneAtMs);
    return summary;
  };

  const runDue = async (): Promise<MainRunRecoveryWorkerSummary> => {
    if (active) {
      return await active;
    }
    active = executeDue();
    try {
      return await active;
    } finally {
      active = undefined;
      if (!stopped) {
        try {
          scheduleNext();
        } catch (err) {
          log.warn(`main-run recovery reschedule failed: ${String(err)}`);
          schedule(IDLE_POLL_MS);
        }
      }
    }
  };

  schedule(0);
  return {
    runDue,
    wake: () => schedule(0),
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      const running = active;
      if (running) {
        await running.catch((err: unknown) => {
          log.warn(`main-run recovery worker stopped after failure: ${String(err)}`);
        });
      }
    },
  };
}

type MainRunRecoveryWorkerLifecycle = {
  worker?: MainRunRecoveryWorker;
  options?: MainRunRecoveryWorkerOptions;
};

const WORKER_LIFECYCLE = resolveGlobalSingleton(
  Symbol.for("openclaw.mainRunRecoveryWorker.lifecycle"),
  (): MainRunRecoveryWorkerLifecycle => ({}),
);

/** Starts the process-wide recovery scheduler after startup reconciliation. */
export function startMainRunRecoveryWorker(
  options: MainRunRecoveryWorkerOptions,
): MainRunRecoveryWorker {
  if (WORKER_LIFECYCLE.worker) {
    throw new Error("main-run recovery worker is already running");
  }
  const worker = createMainRunRecoveryWorker(options);
  const registered: MainRunRecoveryWorker = {
    runDue: worker.runDue,
    wake: worker.wake,
    stop: async () => {
      await worker.stop();
      if (WORKER_LIFECYCLE.worker === registered) {
        WORKER_LIFECYCLE.worker = undefined;
        WORKER_LIFECYCLE.options = undefined;
      }
    },
  };
  WORKER_LIFECYCLE.worker = registered;
  WORKER_LIFECYCLE.options = options;
  return registered;
}

export type MainRunRecoveryWorkerQuiescence = {
  resume(): boolean;
};

/** Quiesces restart dispatch while preserving enough ownership to roll back preparation. */
export async function quiesceMainRunRecoveryWorker(): Promise<MainRunRecoveryWorkerQuiescence> {
  const worker = WORKER_LIFECYCLE.worker;
  if (!worker) {
    return { resume: () => false };
  }
  const options = WORKER_LIFECYCLE.options;
  if (!options) {
    throw new Error("main-run recovery worker restart options are unavailable");
  }
  await worker.stop();
  let resumed = false;
  return {
    resume: () => {
      if (resumed || WORKER_LIFECYCLE.worker) {
        return false;
      }
      startMainRunRecoveryWorker(options);
      resumed = true;
      return true;
    },
  };
}

/** Wakes the active process-wide worker after a durable obligation becomes due. */
export function wakeMainRunRecoveryWorker(): boolean {
  const worker = WORKER_LIFECYCLE.worker;
  if (!worker) {
    return false;
  }
  worker.wake();
  return true;
}

/** Stops and unregisters the process-wide worker during gateway shutdown. */
export async function stopMainRunRecoveryWorker(): Promise<boolean> {
  const worker = WORKER_LIFECYCLE.worker;
  if (!worker) {
    return false;
  }
  await worker.stop();
  return true;
}
