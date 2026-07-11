/** Process-local barriers and one-shot dispatch capabilities for main-run recovery. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SessionEntry } from "../config/sessions.js";
import { resolveCanonicalSessionStorePath } from "../config/sessions/paths.js";
import { buildMainRunExactTurnMessage } from "../infra/main-run-recovery-policy.js";
import {
  mainRunRecoveryTranscriptTailMatches,
  readMainRunRecoveryTranscriptState,
} from "../infra/main-run-recovery-transcript.js";
import {
  registerSessionWorkAdmissionBarrier,
  type SessionWorkAdmissionBarrierGrant,
  type SessionWorkAdmissionBarrier,
} from "../sessions/session-lifecycle-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  getMainRunRecovery,
  MAIN_RUN_RECOVERY_LEASE_MS,
  MAIN_RUN_RECOVERY_TERMINAL_RETENTION_MS,
  releaseMainRunRecoveryLease,
  renewMainRunRecoveryLease,
  returnMainRunRecoveryExecutionToPending,
  terminalizeMainRunRecovery,
  terminalizeMainRunRecoveryCancellation,
  terminalizeMainRunRecoveryPreExecutionFailure,
  terminalizeMainRunRecoveryWithQueueEntry,
  type MainRunRecovery,
  type MainRunRecoveryAuthorization,
  type MainRunRecoveryExecution,
  type MainRunRecoveryIdentity,
  type MainRunRecoveryKind,
  type MainRunRecoveryOwnerPrincipal,
  type MainRunRecoveryTransactionalQueueEntry,
  transitionMainRunRecoveryStateCas,
} from "../state/main-run-recovery-store.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { MainRunRecoveryOwnershipLostError } from "./main-run-recovery-errors.js";
import type { MainRunRecoveryExecutionOwner } from "./main-run-recovery-execution-owner.js";

export {
  isMainRunRecoveryOwnershipLostError,
  MainRunRecoveryOwnershipLostError,
} from "./main-run-recovery-errors.js";

export type { MainRunRecoveryAuthorization, MainRunRecoveryKind };

declare const MAIN_RUN_RECOVERY_EXECUTION_SETTLEMENT_TOKEN: unique symbol;
declare const MAIN_RUN_RECOVERY_CANCELLATION_SETTLEMENT_TOKEN: unique symbol;
declare const MAIN_RUN_RECOVERY_PRE_EXECUTION_SETTLEMENT_TOKEN: unique symbol;
declare const MAIN_RUN_RECOVERY_DISPATCH_TOKEN: unique symbol;

export type MainRunRecoveryExecutionSettlementToken = {
  readonly [MAIN_RUN_RECOVERY_EXECUTION_SETTLEMENT_TOKEN]: true;
};
export type MainRunRecoveryCancellationSettlementToken = {
  readonly [MAIN_RUN_RECOVERY_CANCELLATION_SETTLEMENT_TOKEN]: true;
};
export type MainRunRecoveryPreExecutionSettlementToken = {
  readonly [MAIN_RUN_RECOVERY_PRE_EXECUTION_SETTLEMENT_TOKEN]: true;
};
/** Opaque ownership for one prepared worker dispatch. Never crosses ingress options. */
export type MainRunRecoveryDispatchToken = {
  readonly [MAIN_RUN_RECOVERY_DISPATCH_TOKEN]: true;
};

type MainRunRecoverySettlementIdentity = MainRunRecoveryIdentity & {
  database: OpenClawStateDatabaseOptions;
  publicRunId: string;
};

type MainRunRecoverySettlement =
  | (MainRunRecoverySettlementIdentity & {
      kind: "execution";
      execution: { runId: string; lifecycleGeneration: string; epoch: string };
    })
  | (MainRunRecoverySettlementIdentity & {
      kind: "cancellation";
      cancellation: { kind: "abort" | "reset" | "delete"; epoch: string };
    })
  | (MainRunRecoverySettlementIdentity & {
      kind: "pre_execution";
      expectedRevision: number;
      expectedState: "transcript_owned" | "recovery_pending";
      leaseOwner: string;
    });

const MAIN_RUN_RECOVERY_SETTLEMENTS = resolveGlobalSingleton<
  WeakMap<object, MainRunRecoverySettlement>
>(Symbol.for("openclaw.mainRunRecoveryRuntime.settlements"), () => new WeakMap());

type MainRunRecoveryDispatchTokenState = {
  adoption: Promise<"admitted" | "finalized">;
  adoptionSettled: boolean;
  claim: MainRunRecoveryDispatchClaim;
  claimKey: string;
  phase: "prepared" | "taken" | "admitted" | "started" | "finalized";
  revokeGrant: () => void;
  startPromise?: Promise<MainRunRecoveryExecution>;
  startedExecution?: MainRunRecoveryExecution;
  onStarted?: (execution: MainRunRecoveryExecution) => void;
  heartbeat?: ReturnType<typeof setInterval>;
  ownershipLost?: boolean;
  resolveAdoption: (result: "admitted" | "finalized") => void;
};

const MAIN_RUN_RECOVERY_DISPATCH_TOKENS = resolveGlobalSingleton<
  WeakMap<object, MainRunRecoveryDispatchTokenState>
>(Symbol.for("openclaw.mainRunRecoveryRuntime.dispatchTokens"), () => new WeakMap());

export type MainRunRecoveryTranscriptVerification =
  | { ok: true }
  | {
      ok: false;
      reason: "identity-changed" | "missing-envelope" | "not-resumable" | "transcript-tail-changed";
    };

export async function verifyMainRunRecoveryTranscriptTail(params: {
  entry: Pick<SessionEntry, "sessionFile" | "sessionId">;
  recovery: Extract<MainRunRecovery, { kind: "session_resume" }>;
}): Promise<MainRunRecoveryTranscriptVerification> {
  if (params.entry.sessionId !== params.recovery.sessionId) {
    return { ok: false, reason: "identity-changed" };
  }
  const envelope = params.recovery.envelope;
  if (!envelope || envelope.kind !== "session_resume") {
    return { ok: false, reason: "missing-envelope" };
  }
  if (envelope.resolution.kind !== "resume") {
    return { ok: false, reason: "not-resumable" };
  }
  const current = await readMainRunRecoveryTranscriptState({
    entry: params.entry,
    storePath: params.recovery.storePath,
  });
  return mainRunRecoveryTranscriptTailMatches(envelope.transcriptTail, current)
    ? { ok: true }
    : { ok: false, reason: "transcript-tail-changed" };
}

export type MainRunRecoveryBarrier = {
  aliases: readonly string[];
  ledgerRunId?: string;
  sessionId: string;
  storePath: string;
};

type MainRunRecoveryBarrierEntry = MainRunRecoveryBarrier & {
  aliasSignature: string;
  handle: SessionWorkAdmissionBarrier;
};

export type MainRunRecoveryDispatchClaim = {
  admissionGrant: SessionWorkAdmissionBarrierGrant;
  admissionIdentities: readonly string[];
  agentId: string;
  authorization: MainRunRecoveryAuthorization;
  currentBootId: string;
  database: OpenClawStateDatabaseOptions;
  dispatchRunId: string;
  dispatchToken: MainRunRecoveryDispatchToken;
  executionEpoch: string;
  kind: MainRunRecoveryKind;
  ledgerRunId: string;
  message: string;
  owner?: MainRunRecoveryOwnerPrincipal;
  publicRunId: string;
  recoveryState: "transcript_owned" | "recovery_pending";
  leaseOwner: string;
  sessionId: string;
  sessionKey: string;
  sessionKeyAliases: readonly string[];
  storePath: string;
};

type MainRunRecoveryRuntimeState = {
  barriers: Map<string, MainRunRecoveryBarrierEntry>;
  barrierKeyByLedgerRunId: Map<string, string>;
  dispatchClaims: Map<
    string,
    {
      claim: MainRunRecoveryDispatchClaim;
      claimKey: string;
    }
  >;
  dispatchRunIdByClaimKey: Map<string, string>;
  dispatchRunIdByLedgerRunId: Map<string, string>;
  dispatchTokenByLedgerRunId: Map<string, MainRunRecoveryDispatchToken>;
  lifecycleFences: Map<string, number>;
  pendingTerminalEvidence: Map<string, MainRunRecoveryExecution>;
};

const RUNTIME_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.mainRunRecoveryRuntime"),
  (): MainRunRecoveryRuntimeState => ({
    barriers: new Map(),
    barrierKeyByLedgerRunId: new Map(),
    dispatchClaims: new Map(),
    dispatchRunIdByClaimKey: new Map(),
    dispatchRunIdByLedgerRunId: new Map(),
    dispatchTokenByLedgerRunId: new Map(),
    lifecycleFences: new Map(),
    pendingTerminalEvidence: new Map(),
  }),
);

function normalizeText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function normalizeStorePath(storePath: string): string {
  return resolveCanonicalSessionStorePath(normalizeText(storePath, "recovery store path"));
}

function normalizeDatabase(
  database: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabaseOptions {
  return {
    path: path.resolve(
      database.path ?? resolveOpenClawStateSqlitePath(database.env ?? process.env),
    ),
  };
}

function recoverySessionKey(storePath: string, sessionId: string): string {
  return `${normalizeStorePath(storePath)}\u0000${normalizeText(sessionId, "recovery session id")}`;
}

function recoveryLifecycleFenceKey(execution: {
  runId: string;
  lifecycleGeneration: string;
}): string {
  return `${normalizeText(execution.runId, "recovery execution run id")}\u0000${normalizeText(
    execution.lifecycleGeneration,
    "recovery lifecycle generation",
  )}`;
}

function recoveryLedgerKey(params: {
  publicRunId: string;
  database?: OpenClawStateDatabaseOptions;
}): string {
  return `${normalizeDatabase(params.database).path}\u0000${normalizeText(
    params.publicRunId,
    "recovery ledger run id",
  )}`;
}

/** Blocks later cancellation settlement while an earlier process event awaits SQLite. */
export function registerMainRunRecoveryTerminalEvidencePending(params: {
  publicRunId: string;
  execution: MainRunRecoveryExecution;
  database?: OpenClawStateDatabaseOptions;
}): void {
  const key = recoveryLedgerKey(params);
  const execution = {
    runId: normalizeText(params.execution.runId, "recovery execution run id"),
    lifecycleGeneration: normalizeText(
      params.execution.lifecycleGeneration,
      "recovery lifecycle generation",
    ),
    epoch: normalizeText(params.execution.epoch, "recovery execution epoch"),
  };
  const current = RUNTIME_STATE.pendingTerminalEvidence.get(key);
  if (current && !sameExecution(current, execution)) {
    throw new Error("main-run recovery terminal evidence already has another process owner");
  }
  RUNTIME_STATE.pendingTerminalEvidence.set(key, execution);
}

/** Releases only the exact process event after its durable disposition is known. */
export function resolveMainRunRecoveryTerminalEvidencePending(params: {
  publicRunId: string;
  execution: MainRunRecoveryExecution;
  database?: OpenClawStateDatabaseOptions;
}): boolean {
  const key = recoveryLedgerKey(params);
  const current = RUNTIME_STATE.pendingTerminalEvidence.get(key);
  if (!current) {
    return false;
  }
  if (!sameExecution(current, params.execution)) {
    throw new Error("main-run recovery terminal evidence process owner changed");
  }
  RUNTIME_STATE.pendingTerminalEvidence.delete(key);
  return true;
}

function hasMainRunRecoveryTerminalEvidencePending(
  settlement: MainRunRecoverySettlementIdentity,
): boolean {
  return RUNTIME_STATE.pendingTerminalEvidence.has(recoveryLedgerKey(settlement));
}

export function registerMainRunRecoveryLifecycleFence(
  execution: {
    runId: string;
    lifecycleGeneration: string;
  },
  expiresAtMs = Date.now() + MAIN_RUN_RECOVERY_TERMINAL_RETENTION_MS,
): void {
  const nowMs = Date.now();
  pruneMainRunRecoveryLifecycleFences(nowMs);
  RUNTIME_STATE.lifecycleFences.set(
    recoveryLifecycleFenceKey(execution),
    Math.max(nowMs, expiresAtMs),
  );
}

export function registerMainRunRecoveryLifecycleFences(
  executions: Iterable<{ runId: string; lifecycleGeneration: string }>,
  expiresAtMs?: number,
): void {
  for (const execution of executions) {
    registerMainRunRecoveryLifecycleFence(execution, expiresAtMs);
  }
}

export function isMainRunRecoveryLifecycleFenced(execution: {
  runId: string;
  lifecycleGeneration: string;
}): boolean {
  const nowMs = Date.now();
  const key = recoveryLifecycleFenceKey(execution);
  const expiresAtMs = RUNTIME_STATE.lifecycleFences.get(key);
  if (expiresAtMs === undefined) {
    return false;
  }
  if (expiresAtMs <= nowMs) {
    RUNTIME_STATE.lifecycleFences.delete(key);
    return false;
  }
  return true;
}

export function pruneMainRunRecoveryLifecycleFences(nowMs = Date.now()): void {
  for (const [key, expiresAtMs] of RUNTIME_STATE.lifecycleFences) {
    if (expiresAtMs <= nowMs) {
      RUNTIME_STATE.lifecycleFences.delete(key);
    }
  }
}

function normalizeAliases(sessionId: string, aliases: Iterable<string | undefined>): string[] {
  const normalizedSessionId = normalizeText(sessionId, "recovery session id");
  return [
    ...new Set(
      [...aliases]
        .map((alias) => alias?.trim())
        .filter((alias): alias is string => Boolean(alias) && alias !== normalizedSessionId),
    ),
  ].toSorted();
}

function toPublicBarrier(entry: MainRunRecoveryBarrierEntry): MainRunRecoveryBarrier {
  return {
    aliases: entry.aliases,
    ...(entry.ledgerRunId ? { ledgerRunId: entry.ledgerRunId } : {}),
    sessionId: entry.sessionId,
    storePath: entry.storePath,
  };
}

export function upsertMainRunRecoveryBarrier(params: {
  aliases: Iterable<string | undefined>;
  ledgerRunId?: string;
  sessionId: string;
  storePath: string;
}): MainRunRecoveryBarrier {
  const storePath = normalizeStorePath(params.storePath);
  const sessionId = normalizeText(params.sessionId, "recovery session id");
  const aliases = normalizeAliases(sessionId, params.aliases);
  const aliasSignature = aliases.join("\u0000");
  const ledgerRunId = params.ledgerRunId?.trim() || undefined;
  const key = recoverySessionKey(storePath, sessionId);
  const current = RUNTIME_STATE.barriers.get(key);
  if (current && current.aliasSignature === aliasSignature && current.ledgerRunId === ledgerRunId) {
    return toPublicBarrier(current);
  }
  if (current) {
    throw new Error("main-run recovery barrier identity changed before settlement");
  }
  if (ledgerRunId) {
    const otherKey = RUNTIME_STATE.barrierKeyByLedgerRunId.get(ledgerRunId);
    if (otherKey && otherKey !== key) {
      throw new Error("main-run recovery ledger already owns another session barrier");
    }
  }
  const handle = registerSessionWorkAdmissionBarrier({
    scope: storePath,
    identities: [...aliases, sessionId],
  });
  const entry: MainRunRecoveryBarrierEntry = {
    aliases,
    aliasSignature,
    handle,
    ...(ledgerRunId ? { ledgerRunId } : {}),
    sessionId,
    storePath,
  };
  RUNTIME_STATE.barriers.set(key, entry);
  if (ledgerRunId) {
    RUNTIME_STATE.barrierKeyByLedgerRunId.set(ledgerRunId, key);
  }
  return toPublicBarrier(entry);
}

export function getMainRunRecoveryBarrier(params: {
  sessionId: string;
  storePath: string;
}): MainRunRecoveryBarrier | undefined {
  const entry = RUNTIME_STATE.barriers.get(recoverySessionKey(params.storePath, params.sessionId));
  return entry ? toPublicBarrier(entry) : undefined;
}

export function listMainRunRecoveryBarriers(): MainRunRecoveryBarrier[] {
  return [...RUNTIME_STATE.barriers.values()].map(toPublicBarrier);
}

export function getMainRunRecoveryBarrierByLedgerRunId(
  ledgerRunId: string,
): MainRunRecoveryBarrier | undefined {
  const normalizedRunId = normalizeText(ledgerRunId, "recovery ledger run id");
  const key = RUNTIME_STATE.barrierKeyByLedgerRunId.get(normalizedRunId);
  const entry = key ? RUNTIME_STATE.barriers.get(key) : undefined;
  return entry?.ledgerRunId === normalizedRunId ? toPublicBarrier(entry) : undefined;
}

export function releaseMainRunRecoveryBarrier(params: {
  expectedLedgerRunId: string;
  sessionId: string;
  storePath: string;
}): boolean {
  const key = recoverySessionKey(params.storePath, params.sessionId);
  const entry = RUNTIME_STATE.barriers.get(key);
  if (!entry || entry.ledgerRunId !== params.expectedLedgerRunId) {
    return false;
  }
  entry.handle.release();
  RUNTIME_STATE.barriers.delete(key);
  if (entry.ledgerRunId && RUNTIME_STATE.barrierKeyByLedgerRunId.get(entry.ledgerRunId) === key) {
    RUNTIME_STATE.barrierKeyByLedgerRunId.delete(entry.ledgerRunId);
  }
  return true;
}

export function releaseMainRunRecoveryBarrierByLedgerRunId(ledgerRunId: string): boolean {
  const barrier = getMainRunRecoveryBarrierByLedgerRunId(ledgerRunId);
  if (!barrier) {
    return false;
  }
  return releaseMainRunRecoveryBarrier({
    expectedLedgerRunId: ledgerRunId,
    sessionId: barrier.sessionId,
    storePath: barrier.storePath,
  });
}

function settlementIdentity(
  recovery: MainRunRecovery,
  database: OpenClawStateDatabaseOptions = {},
): MainRunRecoverySettlementIdentity {
  return {
    agentId: recovery.agentId,
    publicRunId: recovery.publicRunId,
    sessionId: recovery.sessionId,
    sessionKey: recovery.sessionKey,
    sessionKeyAliases: [...recovery.sessionKeyAliases],
    storePath: recovery.storePath,
    database: normalizeDatabase(database),
  };
}

function matchesSettlement(recovery: MainRunRecovery, settlement: MainRunRecoverySettlement) {
  return (
    recovery.publicRunId === settlement.publicRunId &&
    recovery.agentId === settlement.agentId &&
    recovery.sessionId === settlement.sessionId &&
    recovery.sessionKey === settlement.sessionKey &&
    recovery.storePath === settlement.storePath &&
    recovery.sessionKeyAliases.length === (settlement.sessionKeyAliases?.length ?? 0) &&
    recovery.sessionKeyAliases.every(
      (alias, index) => alias === settlement.sessionKeyAliases?.[index],
    )
  );
}

function releaseSettledMainRunRecoveryBarrier(
  settlement: MainRunRecoverySettlement,
  recovery: MainRunRecovery,
): void {
  if (recovery.state !== "terminal" || !matchesSettlement(recovery, settlement)) {
    return;
  }
  releaseMainRunRecoveryBarrier({
    expectedLedgerRunId: recovery.publicRunId,
    sessionId: recovery.sessionId,
    storePath: recovery.storePath,
  });
}

export function createMainRunRecoveryExecutionSettlementToken(
  recovery: MainRunRecovery,
  database: OpenClawStateDatabaseOptions = {},
): MainRunRecoveryExecutionSettlementToken {
  if (!recovery.execution) {
    throw new Error("main-run recovery has no execution settlement authority");
  }
  const token = {} as MainRunRecoveryExecutionSettlementToken;
  MAIN_RUN_RECOVERY_SETTLEMENTS.set(token, {
    ...settlementIdentity(recovery, database),
    kind: "execution",
    execution: { ...recovery.execution },
  });
  return token;
}

export function createMainRunRecoveryCancellationSettlementToken(
  recovery: MainRunRecovery,
  database: OpenClawStateDatabaseOptions = {},
): MainRunRecoveryCancellationSettlementToken {
  if (recovery.state !== "cancelling" || !recovery.cancellation) {
    throw new Error("main-run recovery has no cancellation settlement authority");
  }
  const token = {} as MainRunRecoveryCancellationSettlementToken;
  MAIN_RUN_RECOVERY_SETTLEMENTS.set(token, {
    ...settlementIdentity(recovery, database),
    kind: "cancellation",
    cancellation: {
      kind: recovery.cancellation.kind,
      epoch: recovery.cancellation.epoch,
    },
  });
  return token;
}

export function createMainRunRecoveryPreExecutionSettlementToken(
  recovery: MainRunRecovery,
  database: OpenClawStateDatabaseOptions = {},
): MainRunRecoveryPreExecutionSettlementToken {
  if (
    (recovery.state !== "transcript_owned" && recovery.state !== "recovery_pending") ||
    !recovery.lease?.owner
  ) {
    throw new Error("main-run recovery has no pre-execution settlement authority");
  }
  const token = {} as MainRunRecoveryPreExecutionSettlementToken;
  MAIN_RUN_RECOVERY_SETTLEMENTS.set(token, {
    ...settlementIdentity(recovery, database),
    kind: "pre_execution",
    expectedRevision: recovery.revision,
    expectedState: recovery.state,
    leaseOwner: recovery.lease.owner,
  });
  return token;
}

function readMainRunRecoverySettlement<T extends MainRunRecoverySettlement["kind"]>(
  token:
    | MainRunRecoveryExecutionSettlementToken
    | MainRunRecoveryCancellationSettlementToken
    | MainRunRecoveryPreExecutionSettlementToken,
  kind: T,
): Extract<MainRunRecoverySettlement, { kind: T }> {
  const settlement = MAIN_RUN_RECOVERY_SETTLEMENTS.get(token);
  if (!settlement || settlement.kind !== kind) {
    throw new Error("invalid main-run recovery settlement token");
  }
  return settlement as Extract<MainRunRecoverySettlement, { kind: T }>;
}

function sameExecution(
  left: { runId: string; lifecycleGeneration: string; epoch: string } | undefined,
  right: { runId: string; lifecycleGeneration: string; epoch: string },
): boolean {
  return (
    left?.runId === right.runId &&
    left.lifecycleGeneration === right.lifecycleGeneration &&
    left.epoch === right.epoch
  );
}

/** Settles only terminal evidence bound to this exact execution capability. */
export function settleMainRunRecoveryExecution(
  token: MainRunRecoveryExecutionSettlementToken,
  params: {
    nowMs: number;
  },
): MainRunRecovery | undefined {
  const settlement = readMainRunRecoverySettlement(token, "execution");
  const database = settlement.database;
  let current = getMainRunRecovery(settlement.publicRunId, database);
  if (
    !current ||
    !matchesSettlement(current, settlement) ||
    !sameExecution(current.execution, settlement.execution)
  ) {
    return undefined;
  }
  const outcome = current.terminalEvidence?.outcome ?? current.terminalOutcome;
  if (!outcome) {
    return undefined;
  }
  if (current.state !== "terminal") {
    if (!sameExecution(current.terminalEvidence?.execution, settlement.execution)) {
      return undefined;
    }
    current = terminalizeMainRunRecovery(
      {
        ...settlement,
        expectedRevision: current.revision,
        expectedState: current.state,
        outcome,
        nowMs: params.nowMs,
      },
      database,
    );
    current ??= getMainRunRecovery(settlement.publicRunId, database);
  }
  if (
    !current ||
    !matchesSettlement(current, settlement) ||
    current.state !== "terminal" ||
    !sameExecution(current.execution, settlement.execution)
  ) {
    return undefined;
  }
  releaseSettledMainRunRecoveryBarrier(settlement, current);
  return current;
}

/** Settles only the exact cancellation epoch, then releases the matching barrier. */
export function settleMainRunRecoveryCancellation(
  token: MainRunRecoveryCancellationSettlementToken,
  params: {
    endedAtMs: number;
    nowMs: number;
  },
): MainRunRecovery | undefined {
  const settlement = readMainRunRecoverySettlement(token, "cancellation");
  if (hasMainRunRecoveryTerminalEvidencePending(settlement)) {
    return undefined;
  }
  const database = settlement.database;
  const current = terminalizeMainRunRecoveryCancellation(
    {
      ...settlement,
      cancellation: settlement.cancellation,
      endedAtMs: params.endedAtMs,
      nowMs: params.nowMs,
    },
    database,
  );
  if (!current || !matchesSettlement(current, settlement) || current.state !== "terminal") {
    return undefined;
  }
  releaseSettledMainRunRecoveryBarrier(settlement, current);
  return current;
}

/** Settles one exact leased failure before an execution identity exists. */
export function settleMainRunRecoveryPreExecutionFailure(
  token: MainRunRecoveryPreExecutionSettlementToken,
  params: {
    outcome: { status: "failed"; endedAtMs: number };
    nowMs: number;
    queueEntry?: MainRunRecoveryTransactionalQueueEntry;
  },
): MainRunRecovery | undefined {
  const settlement = readMainRunRecoverySettlement(token, "pre_execution");
  const database = settlement.database;
  const current = getMainRunRecovery(settlement.publicRunId, database);
  if (
    !current ||
    !matchesSettlement(current, settlement) ||
    current.revision !== settlement.expectedRevision ||
    current.state !== settlement.expectedState ||
    current.lease?.owner !== settlement.leaseOwner
  ) {
    const terminal = current?.state === "terminal" ? current : undefined;
    if (
      !terminal ||
      !matchesSettlement(terminal, settlement) ||
      terminal.execution !== undefined ||
      terminal.terminalOutcome?.status !== "failed"
    ) {
      return undefined;
    }
    releaseSettledMainRunRecoveryBarrier(settlement, terminal);
    return terminal;
  }
  const cas = {
    ...settlement,
    expectedRevision: settlement.expectedRevision,
    expectedState: settlement.expectedState,
    leaseOwner: settlement.leaseOwner,
    outcome: params.outcome,
    nowMs: params.nowMs,
  };
  const terminalized = params.queueEntry
    ? terminalizeMainRunRecoveryWithQueueEntry({ ...cas, queueEntry: params.queueEntry }, database)
    : terminalizeMainRunRecoveryPreExecutionFailure(cas, database);
  const terminal = terminalized ?? getMainRunRecovery(settlement.publicRunId, database);
  if (
    !terminal ||
    !matchesSettlement(terminal, settlement) ||
    terminal.state !== "terminal" ||
    terminal.execution !== undefined ||
    terminal.terminalOutcome?.status !== "failed"
  ) {
    return undefined;
  }
  releaseSettledMainRunRecoveryBarrier(settlement, terminal);
  return terminal;
}

function dispatchClaimKey(dispatchRunId: string): string {
  return normalizeText(dispatchRunId, "recovery dispatch run id");
}

function readDispatchTokenState(
  token: MainRunRecoveryDispatchToken,
): MainRunRecoveryDispatchTokenState {
  const state = MAIN_RUN_RECOVERY_DISPATCH_TOKENS.get(token);
  if (!state || state.phase === "finalized") {
    throw new Error("invalid main-run recovery dispatch token");
  }
  return state;
}

function mainRunRecoveryMatchesDispatchClaim(
  recovery: MainRunRecovery,
  claim: MainRunRecoveryDispatchClaim,
): boolean {
  return (
    recovery.publicRunId === claim.publicRunId &&
    recovery.agentId === claim.agentId &&
    recovery.kind === claim.kind &&
    recovery.sessionId === claim.sessionId &&
    recovery.sessionKey === claim.sessionKey &&
    recovery.storePath === claim.storePath &&
    recovery.sessionKeyAliases.length === claim.sessionKeyAliases.length &&
    recovery.sessionKeyAliases.every((alias, index) => alias === claim.sessionKeyAliases[index])
  );
}

function stopDispatchHeartbeat(state: MainRunRecoveryDispatchTokenState): void {
  if (state.heartbeat) {
    clearInterval(state.heartbeat);
    state.heartbeat = undefined;
  }
}

function renewDispatchLease(state: MainRunRecoveryDispatchTokenState): MainRunRecovery {
  const { claim } = state;
  const nowMs = Date.now();
  const current = getMainRunRecovery(claim.ledgerRunId, claim.database);
  if (
    !current ||
    !mainRunRecoveryMatchesDispatchClaim(current, claim) ||
    current.state !== claim.recoveryState ||
    current.execution !== undefined ||
    current.lease?.owner !== claim.leaseOwner ||
    current.lease.expiresAtMs <= nowMs
  ) {
    throw new MainRunRecoveryOwnershipLostError();
  }
  const renewed = renewMainRunRecoveryLease(
    {
      ...settlementIdentity(current),
      expectedRevision: current.revision,
      expectedState: current.state,
      leaseOwner: claim.leaseOwner,
      nowMs,
      leaseDurationMs: MAIN_RUN_RECOVERY_LEASE_MS,
    },
    claim.database,
  );
  if (!renewed?.lease || renewed.lease.owner !== claim.leaseOwner) {
    throw new MainRunRecoveryOwnershipLostError();
  }
  return renewed;
}

function startDispatchHeartbeat(state: MainRunRecoveryDispatchTokenState): void {
  renewDispatchLease(state);
  state.heartbeat = setInterval(
    () => {
      try {
        renewDispatchLease(state);
      } catch {
        state.ownershipLost = true;
        finalizeDispatchTokenState(state);
      }
    },
    Math.floor(MAIN_RUN_RECOVERY_LEASE_MS / 2),
  );
  state.heartbeat.unref?.();
}

function unlinkDispatchIndexes(state: MainRunRecoveryDispatchTokenState): void {
  const { claim } = state;
  if (
    RUNTIME_STATE.dispatchClaims.get(claim.dispatchRunId)?.claim.dispatchToken ===
    claim.dispatchToken
  ) {
    RUNTIME_STATE.dispatchClaims.delete(claim.dispatchRunId);
  }
  if (RUNTIME_STATE.dispatchRunIdByClaimKey.get(state.claimKey) === claim.dispatchRunId) {
    RUNTIME_STATE.dispatchRunIdByClaimKey.delete(state.claimKey);
  }
  if (RUNTIME_STATE.dispatchRunIdByLedgerRunId.get(claim.ledgerRunId) === claim.dispatchRunId) {
    RUNTIME_STATE.dispatchRunIdByLedgerRunId.delete(claim.ledgerRunId);
  }
  if (RUNTIME_STATE.dispatchTokenByLedgerRunId.get(claim.ledgerRunId) === claim.dispatchToken) {
    RUNTIME_STATE.dispatchTokenByLedgerRunId.delete(claim.ledgerRunId);
  }
}

function finalizeDispatchTokenState(state: MainRunRecoveryDispatchTokenState): void {
  if (state.phase === "finalized") {
    return;
  }
  stopDispatchHeartbeat(state);
  state.revokeGrant();
  state.phase = "finalized";
  if (!state.adoptionSettled) {
    state.adoptionSettled = true;
    state.resolveAdoption("finalized");
  }
  unlinkDispatchIndexes(state);
}

/** Revokes any unconsumed admission capability and retires this dispatch generation. */
export function finalizeMainRunRecoveryDispatch(token: MainRunRecoveryDispatchToken): void {
  const state = MAIN_RUN_RECOVERY_DISPATCH_TOKENS.get(token);
  if (state) {
    finalizeDispatchTokenState(state);
  }
}

/** Marks the one-shot barrier grant as consumed by a successfully returned admission lease. */
export function markMainRunRecoveryDispatchAdmitted(token: MainRunRecoveryDispatchToken): void {
  const state = readDispatchTokenState(token);
  if (state.phase !== "taken") {
    throw new Error("main-run recovery dispatch was not taken for admission");
  }
  state.phase = "admitted";
  if (!state.adoptionSettled) {
    state.adoptionSettled = true;
    state.resolveAdoption("admitted");
  }
}

/** Worker handoff result; only admitted means the gateway consumed ownership. */
export async function waitForMainRunRecoveryDispatchAdoption(
  token: MainRunRecoveryDispatchToken,
  timeoutMs = 5_000,
): Promise<"admitted" | "finalized"> {
  const state = MAIN_RUN_RECOVERY_DISPATCH_TOKENS.get(token);
  if (!state) {
    throw new Error("invalid main-run recovery dispatch token");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("main-run recovery adoption timeout must be positive");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      state.adoption,
      new Promise<"finalized">((resolve) => {
        timer = setTimeout(() => {
          finalizeDispatchTokenState(state);
          resolve("finalized");
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Registers process-local cleanup after the exact running CAS succeeds. */
export function onMainRunRecoveryDispatchStarted(
  token: MainRunRecoveryDispatchToken,
  callback: (execution: MainRunRecoveryExecution) => void,
): void {
  const state = readDispatchTokenState(token);
  if (state.startedExecution) {
    callback(state.startedExecution);
    return;
  }
  state.onStarted = callback;
}

/** Returns an unstarted dispatch to the durable worker after an in-process rejection. */
export function releaseMainRunRecoveryDispatchForRetry(
  token: MainRunRecoveryDispatchToken,
  params: {
    error?: string;
    nextAttemptAtMs: number;
    nowMs: number;
  },
): MainRunRecovery | undefined {
  const state = readDispatchTokenState(token);
  if (state.phase !== "taken" && state.phase !== "admitted") {
    return undefined;
  }
  const { claim } = state;
  const current = getMainRunRecovery(claim.ledgerRunId, claim.database);
  if (
    !current ||
    !mainRunRecoveryMatchesDispatchClaim(current, claim) ||
    current.state !== claim.recoveryState ||
    current.execution !== undefined ||
    current.lease?.owner !== claim.leaseOwner ||
    current.lease.expiresAtMs <= params.nowMs
  ) {
    finalizeDispatchTokenState(state);
    return undefined;
  }
  const released = releaseMainRunRecoveryLease(
    {
      ...settlementIdentity(current),
      expectedRevision: current.revision,
      expectedState: current.state,
      leaseOwner: claim.leaseOwner,
      nowMs: params.nowMs,
      nextAttemptAtMs: params.nextAttemptAtMs,
      lastError: params.error,
    },
    claim.database,
  );
  finalizeDispatchTokenState(state);
  return released;
}

/** Creates the only provider-start authority for one opaque dispatch token. */
export function createMainRunRecoveryExecutionOwner(
  token: MainRunRecoveryDispatchToken,
): MainRunRecoveryExecutionOwner {
  const state = readDispatchTokenState(token);
  return Object.freeze({
    publicRunId: state.claim.publicRunId,
    start: async (params: { lifecycleGeneration: string }): Promise<void> =>
      await notifyMainRunRecoveryExecutionStartedForToken(token, params),
  }) as MainRunRecoveryExecutionOwner;
}

function sameDispatchExecution(
  left: MainRunRecoveryExecution | undefined,
  right: MainRunRecoveryExecution,
): boolean {
  return (
    left?.runId === right.runId &&
    left.lifecycleGeneration === right.lifecycleGeneration &&
    left.epoch === right.epoch
  );
}

async function startMainRunRecoveryDispatch(
  state: MainRunRecoveryDispatchTokenState,
  lifecycleGeneration: string,
): Promise<MainRunRecoveryExecution> {
  let adopted = false;
  try {
    const { claim } = state;
    if (state.phase !== "admitted" || state.ownershipLost || !state.onStarted) {
      throw new MainRunRecoveryOwnershipLostError("main-run recovery dispatch is not admitted");
    }
    const execution: MainRunRecoveryExecution = {
      runId: claim.dispatchRunId,
      lifecycleGeneration: normalizeText(lifecycleGeneration, "recovery lifecycle generation"),
      epoch: claim.executionEpoch,
    };
    const current = renewDispatchLease(state);
    const nowMs = Date.now();
    if (
      current.state !== claim.recoveryState ||
      current.execution !== undefined ||
      current.lease?.owner !== claim.leaseOwner
    ) {
      throw new MainRunRecoveryOwnershipLostError(
        "main-run recovery dispatch lost ownership before execution",
      );
    }
    const running = transitionMainRunRecoveryStateCas(
      {
        ...settlementIdentity(current),
        expectedRevision: current.revision,
        expectedState: current.state,
        nextState: "running",
        currentBootId: claim.currentBootId,
        execution,
        nowMs,
      },
      claim.database,
    );
    if (!running || !sameDispatchExecution(running.execution, execution)) {
      throw new MainRunRecoveryOwnershipLostError(
        "main-run recovery dispatch could not start execution",
      );
    }
    stopDispatchHeartbeat(state);
    try {
      state.onStarted(execution);
    } catch (error) {
      const rollbackAtMs = Date.now();
      const pending = returnMainRunRecoveryExecutionToPending(
        {
          ...settlementIdentity(running),
          expectedRevision: running.revision,
          expectedState: "running",
          execution,
          currentBootId: claim.currentBootId,
          nowMs: rollbackAtMs,
          nextAttemptAtMs: rollbackAtMs,
          lastError: error instanceof Error ? error.message : String(error),
        },
        claim.database,
      );
      if (!pending) {
        throw new MainRunRecoveryOwnershipLostError(
          "main-run recovery observer failed after execution adoption",
        );
      }
      registerMainRunRecoveryLifecycleFence(execution);
      throw new MainRunRecoveryOwnershipLostError(
        "main-run recovery observer rejected execution adoption",
      );
    }
    state.startedExecution = execution;
    state.phase = "started";
    unlinkDispatchIndexes(state);
    adopted = true;
    return execution;
  } finally {
    if (!adopted) {
      finalizeDispatchTokenState(state);
    }
  }
}

/**
 * Awaited at the provider/model boundary. Repeated fallback attempts are
 * idempotent only for the same execution triple; unrelated ingress is a no-op.
 */
async function notifyMainRunRecoveryExecutionStartedForToken(
  token: MainRunRecoveryDispatchToken,
  params: { lifecycleGeneration: string },
): Promise<void> {
  const state = MAIN_RUN_RECOVERY_DISPATCH_TOKENS.get(token);
  if (!state) {
    throw new Error("invalid main-run recovery dispatch token");
  }
  if (state.phase === "finalized") {
    throw new MainRunRecoveryOwnershipLostError(
      "main-run recovery dispatch was retired before execution",
    );
  }
  const requested: MainRunRecoveryExecution = {
    runId: state.claim.dispatchRunId,
    lifecycleGeneration: normalizeText(params.lifecycleGeneration, "recovery lifecycle generation"),
    epoch: state.claim.executionEpoch,
  };
  if (state.startedExecution) {
    if (!sameDispatchExecution(state.startedExecution, requested)) {
      throw new MainRunRecoveryOwnershipLostError(
        "main-run recovery execution identity changed during fallback",
      );
    }
    const current = getMainRunRecovery(state.claim.ledgerRunId, state.claim.database);
    if (
      !current ||
      !mainRunRecoveryMatchesDispatchClaim(current, state.claim) ||
      !sameDispatchExecution(current.execution, requested)
    ) {
      throw new MainRunRecoveryOwnershipLostError(
        "main-run recovery execution ownership changed during fallback",
      );
    }
    return;
  }
  if (!state.startPromise) {
    state.startPromise = startMainRunRecoveryDispatch(state, requested.lifecycleGeneration).catch(
      (error) => {
        finalizeDispatchTokenState(state);
        throw error;
      },
    );
  }
  const started = await state.startPromise;
  if (!sameDispatchExecution(started, requested)) {
    throw new MainRunRecoveryOwnershipLostError(
      "main-run recovery execution identity changed during startup",
    );
  }
}

function recoveryDispatchClaimKey(recovery: MainRunRecovery): string {
  if (!recovery.lease) {
    throw new Error(`main-run recovery ${recovery.publicRunId} has no worker lease`);
  }
  return `${recovery.publicRunId}\u0000${recovery.revision}\u0000${recovery.lease.owner}`;
}

function discardPreparedDispatch(dispatchRunId: string): boolean {
  const prepared = RUNTIME_STATE.dispatchClaims.get(dispatchRunId);
  if (!prepared) {
    return false;
  }
  finalizeMainRunRecoveryDispatch(prepared.claim.dispatchToken);
  return true;
}

export function prepareMainRunRecoveryDispatch(params: {
  currentBootId: string;
  dispatchRunId: string;
  database?: OpenClawStateDatabaseOptions;
  recovery: MainRunRecovery;
}): MainRunRecoveryDispatchClaim {
  const dispatchRunId = dispatchClaimKey(params.dispatchRunId);
  const { recovery } = params;
  if (recovery.state !== "transcript_owned" && recovery.state !== "recovery_pending") {
    throw new Error(`main-run recovery ${recovery.publicRunId} is not ready for dispatch`);
  }
  if (!recovery.lease?.owner) {
    throw new Error(`main-run recovery ${recovery.publicRunId} has no worker lease`);
  }
  const storePath = normalizeStorePath(recovery.storePath);
  const sessionId = normalizeText(recovery.sessionId, "recovery session id");
  const sessionKey = normalizeText(recovery.sessionKey, "recovery session key");
  const barrier = RUNTIME_STATE.barriers.get(recoverySessionKey(storePath, sessionId));
  const ledgerRunId = normalizeText(recovery.publicRunId, "recovery ledger run id");
  if (!barrier || barrier.ledgerRunId !== ledgerRunId) {
    throw new Error(`main-run recovery ${ledgerRunId} has no matching barrier`);
  }
  const aliases = normalizeAliases(sessionId, [
    ...recovery.sessionKeyAliases,
    ...barrier.aliases,
  ]).filter((alias) => alias !== sessionKey);
  const message =
    recovery.kind === "session_resume"
      ? recovery.envelope?.kind === "session_resume"
        ? recovery.envelope.systemMessage
        : undefined
      : buildMainRunExactTurnMessage();
  if (!message) {
    throw new Error(`main-run recovery ${ledgerRunId} has no dispatch message`);
  }
  const claimKey = recoveryDispatchClaimKey(recovery);
  const outstandingToken = RUNTIME_STATE.dispatchTokenByLedgerRunId.get(ledgerRunId);
  if (outstandingToken) {
    const outstanding = MAIN_RUN_RECOVERY_DISPATCH_TOKENS.get(outstandingToken);
    if (outstanding && outstanding.phase !== "prepared" && outstanding.phase !== "finalized") {
      throw new Error(`main-run recovery ${ledgerRunId} already has an active dispatch`);
    }
    if (outstanding) {
      finalizeDispatchTokenState(outstanding);
    }
  }
  const previousLedgerDispatchRunId = RUNTIME_STATE.dispatchRunIdByLedgerRunId.get(ledgerRunId);
  if (previousLedgerDispatchRunId) {
    discardPreparedDispatch(previousLedgerDispatchRunId);
  }
  const previousDispatchRunId = RUNTIME_STATE.dispatchRunIdByClaimKey.get(claimKey);
  if (previousDispatchRunId) {
    discardPreparedDispatch(previousDispatchRunId);
  }
  discardPreparedDispatch(dispatchRunId);
  const admissionIdentities = normalizeAliases(sessionId, [
    dispatchRunId,
    sessionKey,
    ...aliases,
  ]).concat(sessionId);
  const admissionGrant = barrier.handle.issueGrant({ identities: admissionIdentities });
  const dispatchToken = {} as MainRunRecoveryDispatchToken;
  const claim: MainRunRecoveryDispatchClaim = {
    admissionGrant: admissionGrant.grant,
    admissionIdentities,
    agentId: normalizeText(recovery.agentId, "recovery agent id"),
    authorization: {
      senderIsOwner: recovery.authorization.senderIsOwner,
    },
    currentBootId: normalizeText(params.currentBootId, "recovery current boot id"),
    database: params.database?.path ? { path: params.database.path } : {},
    dispatchRunId,
    dispatchToken,
    executionEpoch: randomUUID(),
    kind: recovery.kind,
    ledgerRunId,
    message,
    ...(recovery.ownerPrincipal ? { owner: recovery.ownerPrincipal } : {}),
    publicRunId: recovery.publicRunId,
    recoveryState: recovery.state,
    leaseOwner: recovery.lease.owner,
    sessionId,
    sessionKey,
    sessionKeyAliases: aliases,
    storePath,
  };
  let resolveAdoption!: (result: "admitted" | "finalized") => void;
  const adoption = new Promise<"admitted" | "finalized">((resolve) => {
    resolveAdoption = resolve;
  });
  const tokenState: MainRunRecoveryDispatchTokenState = {
    adoption,
    adoptionSettled: false,
    claim,
    claimKey,
    phase: "prepared",
    revokeGrant: admissionGrant.revoke,
    resolveAdoption,
  };
  MAIN_RUN_RECOVERY_DISPATCH_TOKENS.set(dispatchToken, tokenState);
  RUNTIME_STATE.dispatchTokenByLedgerRunId.set(ledgerRunId, dispatchToken);
  RUNTIME_STATE.dispatchClaims.set(dispatchRunId, {
    claim,
    claimKey,
  });
  RUNTIME_STATE.dispatchRunIdByClaimKey.set(claimKey, dispatchRunId);
  RUNTIME_STATE.dispatchRunIdByLedgerRunId.set(ledgerRunId, dispatchRunId);
  try {
    startDispatchHeartbeat(tokenState);
  } catch (error) {
    discardPreparedDispatch(dispatchRunId);
    throw error;
  }
  return claim;
}

export function takeMainRunRecoveryDispatch(params: {
  agentId: string;
  dispatchRunId: string;
  message: string;
  sessionKey: string;
}): MainRunRecoveryDispatchClaim | undefined {
  const dispatchRunId = dispatchClaimKey(params.dispatchRunId);
  const prepared = RUNTIME_STATE.dispatchClaims.get(dispatchRunId);
  const claim = prepared?.claim;
  const sessionKey = params.sessionKey.trim();
  const agentId = params.agentId.trim();
  const sessionMatches =
    claim?.sessionKey === sessionKey || claim?.sessionKeyAliases.includes(sessionKey);
  if (!claim || claim.agentId !== agentId || !sessionMatches || claim.message !== params.message) {
    return undefined;
  }
  RUNTIME_STATE.dispatchClaims.delete(dispatchRunId);
  if (prepared && RUNTIME_STATE.dispatchRunIdByClaimKey.get(prepared.claimKey) === dispatchRunId) {
    RUNTIME_STATE.dispatchRunIdByClaimKey.delete(prepared.claimKey);
  }
  if (
    prepared &&
    RUNTIME_STATE.dispatchRunIdByLedgerRunId.get(prepared.claim.ledgerRunId) === dispatchRunId
  ) {
    RUNTIME_STATE.dispatchRunIdByLedgerRunId.delete(prepared.claim.ledgerRunId);
  }
  const tokenState = MAIN_RUN_RECOVERY_DISPATCH_TOKENS.get(claim.dispatchToken);
  if (!tokenState || tokenState.phase !== "prepared") {
    return undefined;
  }
  tokenState.phase = "taken";
  return claim;
}

export function discardMainRunRecoveryDispatch(dispatchRunId: string): boolean {
  return discardPreparedDispatch(dispatchClaimKey(dispatchRunId));
}

export function clearMainRunRecoveryBarriersForTest(): void {
  for (const barrier of RUNTIME_STATE.barriers.values()) {
    barrier.handle.release();
  }
  RUNTIME_STATE.barriers.clear();
  RUNTIME_STATE.barrierKeyByLedgerRunId.clear();
}

export function clearMainRunRecoveryRuntimeForTest(): void {
  clearMainRunRecoveryBarriersForTest();
  for (const dispatch of RUNTIME_STATE.dispatchClaims.values()) {
    finalizeMainRunRecoveryDispatch(dispatch.claim.dispatchToken);
  }
  RUNTIME_STATE.dispatchClaims.clear();
  RUNTIME_STATE.dispatchRunIdByClaimKey.clear();
  RUNTIME_STATE.dispatchRunIdByLedgerRunId.clear();
  for (const token of RUNTIME_STATE.dispatchTokenByLedgerRunId.values()) {
    finalizeMainRunRecoveryDispatch(token);
  }
  RUNTIME_STATE.dispatchTokenByLedgerRunId.clear();
  RUNTIME_STATE.lifecycleFences.clear();
  RUNTIME_STATE.pendingTerminalEvidence.clear();
}
