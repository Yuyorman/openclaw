/** Durable SQLite owner for restart-safe main-run recovery operations. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable, Updateable } from "kysely";
import { resolveCanonicalSessionStorePath } from "../config/sessions/paths.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.js";
import type { DB as StateDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

export type MainRunRecoveryKind = "exact_turn" | "session_resume";
export type MainRunRecoveryState =
  | "accepted"
  | "transcript_owned"
  | "running"
  | "recovery_pending"
  | "cancelling"
  | "terminal";
export type MainRunRecoveryOwnerPrincipal =
  | { kind: "device"; deviceId: string }
  | { kind: "system" };
export type MainRunRecoveryAuthorization = { senderIsOwner: boolean };
export type MainRunRecoveryUnprivilegedAuthorization = { senderIsOwner: false };
export const MAIN_RUN_RECOVERY_UNPRIVILEGED_AUTHORIZATION = Object.freeze({
  senderIsOwner: false,
}) satisfies MainRunRecoveryUnprivilegedAuthorization;
export const MAIN_RUN_RECOVERY_TERMINAL_RETENTION_MS = 86_400_000;
export const MAIN_RUN_RECOVERY_LEASE_MS = 30_000;

export type MainRunRecoveryFence = Pick<MainRunRecoveryExecution, "runId" | "lifecycleGeneration">;
export type MainRunRecoveryTranscriptTail = { messageId: string; hash: string };
export type MainRunRecoveryDeliveryContext = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};
export type MainRunRecoveryExactTurnEnvelope = {
  kind: "exact_turn";
  approvedTurn: PersistedUserTurnMessage;
};
export type MainRunRecoverySessionResumeEnvelope = {
  kind: "session_resume";
  resolution: { kind: "resume" } | { kind: "fail"; code: "unresumable-tail" | "stale-approval" };
  systemMessage: string;
  transcriptTail: MainRunRecoveryTranscriptTail | null;
  lifecycleRevision: string | null;
  delivery: {
    context: MainRunRecoveryDeliveryContext | null;
    runId: string | null;
    intentId: string | null;
  };
  /** Lifecycle fences for late events, not queued work. */
  fences: readonly MainRunRecoveryFence[];
};
export type MainRunRecoveryEnvelope =
  | MainRunRecoveryExactTurnEnvelope
  | MainRunRecoverySessionResumeEnvelope;
export type MainRunRecoveryTerminalOutcome = {
  status: "done" | "failed" | "timeout" | "killed" | "cancelled";
  endedAtMs: number;
};
export type MainRunRecoveryExecution = {
  runId: string;
  lifecycleGeneration: string;
  epoch: string;
};
export type MainRunRecoveryTerminalEvidence = {
  outcome: MainRunRecoveryTerminalOutcome;
  execution: MainRunRecoveryExecution;
  observedAtMs: number;
};
export type MainRunRecoveryCancellation = {
  kind: "abort" | "reset" | "delete";
  epoch: string;
  requestedAtMs: number;
};
export type MainRunRecoveryInitialLease = {
  owner: string;
  expiresAtMs: number;
};
export type MainRunRecoveryTransactionalQueueEntry = {
  queueName: string;
  id: string;
  entry: Record<string, unknown>;
  entryKind?: string;
  sessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
  enqueuedAtMs: number;
};
export type MainRunRecoveryIdentity = {
  agentId: string;
  sessionKey: string;
  sessionKeyAliases?: readonly string[];
  sessionId: string;
  storePath: string;
};

type RecoveryShared = Omit<MainRunRecoveryIdentity, "sessionKeyAliases"> & {
  sessionKeyAliases: readonly string[];
  publicRunId: string;
  sourceKey: string;
  sourceFingerprint: string;
  state: MainRunRecoveryState;
  bootId: string;
  authorization: MainRunRecoveryAuthorization;
  revision: number;
  attemptCount: number;
  lifecycleFences: readonly MainRunRecoveryFence[];
  nextAttemptAtMs?: number;
  lastError?: string;
  lease?: { owner: string; expiresAtMs: number };
  execution?: MainRunRecoveryExecution;
  terminalEvidence?: MainRunRecoveryTerminalEvidence;
  cancellation?: MainRunRecoveryCancellation;
  terminalOutcome?: MainRunRecoveryTerminalOutcome;
  acceptedAtMs: number;
  updatedAtMs: number;
  terminalAtMs?: number;
  pruneAfterMs?: number;
};
export type MainRunRecovery = RecoveryShared &
  (
    | {
        kind: "exact_turn";
        ownerPrincipal?: MainRunRecoveryOwnerPrincipal;
        envelope?: MainRunRecoveryExactTurnEnvelope;
      }
    | {
        kind: "session_resume";
        ownerPrincipal?: undefined;
        authorization: MainRunRecoveryUnprivilegedAuthorization;
        envelope?: MainRunRecoverySessionResumeEnvelope;
      }
  );
export type ReserveMainRunRecoveryInput = MainRunRecoveryIdentity & {
  publicRunId: string;
  sourceKey: string;
  sourceFingerprint: string;
  bootId: string;
  ownerPrincipal?: MainRunRecoveryOwnerPrincipal;
  authorization: MainRunRecoveryAuthorization;
  envelope: MainRunRecoveryExactTurnEnvelope;
  initialLease: MainRunRecoveryInitialLease;
  acceptedAtMs: number;
};
export type ImportedMainRunRecoveryInput = MainRunRecoveryIdentity & {
  publicRunId?: string;
  sourceKey: string;
  sourceFingerprint: string;
  bootId?: string;
  envelope: MainRunRecoverySessionResumeEnvelope;
  acceptedAtMs: number;
};
export type ReserveMainSessionResumeRecoveryInput = MainRunRecoveryIdentity & {
  sourceKey: string;
  bootId: string;
  envelope: MainRunRecoverySessionResumeEnvelope;
  acceptedAtMs: number;
};
export type ReserveMainRunRecoveryResult =
  | { status: "inserted" | "duplicate"; recovery: MainRunRecovery }
  | { status: "session_blocked"; recovery: MainRunRecovery };
export type MainRunRecoveryCas = MainRunRecoveryIdentity & {
  publicRunId: string;
  expectedRevision: number;
  expectedState: Exclude<MainRunRecoveryState, "terminal">;
};

type RecoveryDatabase = Pick<StateDatabase, "delivery_queue_entries" | "main_run_recoveries">;
type RecoveryRow = Selectable<StateDatabase["main_run_recoveries"]>;
type Patch = Updateable<StateDatabase["main_run_recoveries"]>;
type DbOptions = OpenClawStateDatabaseOptions;

const LEGACY_IMPORT_GENERATION = "legacy-json-import";
const TERMINAL_STATUSES = new Set<MainRunRecoveryTerminalOutcome["status"]>([
  "done",
  "failed",
  "timeout",
  "killed",
  "cancelled",
]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}
function optionalText(value: unknown, label: string): string | undefined {
  return value == null ? undefined : text(value, label);
}
function uint(value: unknown, label: string, positive = false): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < (positive ? 1 : 0)) {
    throw new Error(`${label} must be ${positive ? "positive" : "non-negative"}`);
  }
  return result;
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function fingerprint(value: unknown): string {
  const result = text(value, "source fingerprint");
  if (!/^[a-f0-9]{64}$/.test(result)) {
    throw new Error("source fingerprint must be lowercase SHA-256");
  }
  return result;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  const record = object(value);
  return record
    ? Object.fromEntries(
        Object.entries(record)
          .filter(([, entry]) => entry !== undefined)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonical(entry)]),
      )
    : value;
}
function encode(value: unknown): string {
  const result = JSON.stringify(canonical(value));
  if (result === undefined) {
    throw new Error("recovery value is not JSON-serializable");
  }
  return result;
}
function parse<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
function strings(value: readonly string[] | undefined): string[] {
  return [...new Set((value ?? []).map((entry) => text(entry, "session key alias")))].toSorted();
}
function normalizeIdentity(value: MainRunRecoveryIdentity): Required<MainRunRecoveryIdentity> {
  const sessionKey = text(value.sessionKey, "session key");
  const sessionId = text(value.sessionId, "session id");
  return {
    agentId: text(value.agentId, "agent id"),
    sessionKey,
    sessionKeyAliases: strings(value.sessionKeyAliases).filter(
      (alias) => alias !== sessionKey && alias !== sessionId,
    ),
    sessionId,
    storePath: resolveCanonicalSessionStorePath(text(value.storePath, "session store path")),
  };
}
function normalizePrincipal(
  value: MainRunRecoveryOwnerPrincipal | undefined,
): MainRunRecoveryOwnerPrincipal | undefined {
  if (!value) {
    return undefined;
  }
  return value.kind === "system"
    ? { kind: "system" }
    : { kind: "device", deviceId: text(value.deviceId, "device id") };
}
function assertAuthorization(
  kind: MainRunRecoveryKind,
  principal: MainRunRecoveryOwnerPrincipal | undefined,
  authorization: MainRunRecoveryAuthorization,
): void {
  if (typeof authorization.senderIsOwner !== "boolean") {
    throw new Error("invalid recovery authorization");
  }
  if (kind === "session_resume" && (principal || authorization.senderIsOwner)) {
    throw new Error("session resume recovery must be unowned");
  }
}
function exactTurnMeta(turn: PersistedUserTurnMessage): Record<string, unknown> {
  return object((turn as unknown as Record<string, unknown>).__openclaw) ?? {};
}
function nullableText(value: unknown, label: string): string | null {
  return value == null ? null : text(value, label);
}
function normalizeFences(value: unknown): MainRunRecoveryFence[] {
  if (!Array.isArray(value)) {
    throw new Error("recovery fences must be an array");
  }
  const fences = value.map((candidate) => {
    const fence = object(candidate);
    if (!fence) {
      throw new Error("recovery fence must be an object");
    }
    return {
      runId: text(fence.runId, "recovery fence run id"),
      lifecycleGeneration: text(fence.lifecycleGeneration, "recovery fence generation"),
    };
  });
  return [
    ...new Map(
      fences.map((fence) => [`${fence.runId}\0${fence.lifecycleGeneration}`, fence]),
    ).values(),
  ].toSorted((left, right) =>
    `${left.runId}\0${left.lifecycleGeneration}`.localeCompare(
      `${right.runId}\0${right.lifecycleGeneration}`,
    ),
  );
}
function normalizeResumeEnvelope(value: unknown): MainRunRecoverySessionResumeEnvelope {
  const envelope = object(value);
  const resolution = object(envelope?.resolution);
  const delivery = object(envelope?.delivery);
  if (!envelope || !resolution || !delivery) {
    throw new Error("invalid session resume envelope");
  }
  const kind = resolution.kind;
  const normalizedResolution =
    kind === "resume"
      ? ({ kind } as const)
      : kind === "fail" &&
          (resolution.code === "unresumable-tail" || resolution.code === "stale-approval")
        ? ({ kind, code: resolution.code } as const)
        : undefined;
  if (!normalizedResolution) {
    throw new Error("invalid session resume resolution");
  }
  const tail = envelope.transcriptTail == null ? undefined : object(envelope.transcriptTail);
  if (envelope.transcriptTail != null && !tail) {
    throw new Error("invalid recovery transcript tail");
  }
  const context = delivery.context == null ? undefined : object(delivery.context);
  if (delivery.context != null && !context) {
    throw new Error("invalid recovery delivery context");
  }
  const threadId = context?.threadId;
  if (
    threadId != null &&
    typeof threadId !== "string" &&
    (typeof threadId !== "number" || !Number.isSafeInteger(threadId))
  ) {
    throw new Error("invalid recovery delivery thread");
  }
  const systemMessage = text(envelope.systemMessage, "recovery system message");
  if (systemMessage.length > 16_384) {
    throw new Error("recovery system message is too long");
  }
  return {
    kind: "session_resume",
    resolution: normalizedResolution,
    systemMessage,
    transcriptTail: tail
      ? {
          messageId: text(tail.messageId, "transcript tail id"),
          hash: fingerprint(tail.hash),
        }
      : null,
    lifecycleRevision: nullableText(envelope.lifecycleRevision, "lifecycle revision"),
    delivery: {
      context: context
        ? {
            channel: text(context.channel, "delivery channel"),
            to: text(context.to, "delivery target"),
            ...(context.accountId == null
              ? {}
              : { accountId: text(context.accountId, "delivery account") }),
            ...(threadId == null ? {} : { threadId }),
          }
        : null,
      runId: nullableText(delivery.runId, "delivery run id"),
      intentId: nullableText(delivery.intentId, "delivery intent id"),
    },
    fences: normalizeFences(envelope.fences),
  };
}
function normalizeEnvelope(
  envelope: MainRunRecoveryEnvelope,
  authorization: MainRunRecoveryAuthorization,
): MainRunRecoveryEnvelope {
  if (envelope.kind === "session_resume") {
    assertAuthorization(envelope.kind, undefined, authorization);
    return normalizeResumeEnvelope(envelope);
  }
  const turn = envelope.approvedTurn as unknown as Record<string, unknown>;
  if (
    turn.role !== "user" ||
    typeof turn.content !== "string" ||
    typeof turn.idempotencyKey !== "string" ||
    !turn.idempotencyKey
  ) {
    throw new Error("exact recovery requires an idempotent plain-text user turn");
  }
  return {
    kind: "exact_turn",
    approvedTurn: {
      ...turn,
      __openclaw: { ...exactTurnMeta(envelope.approvedTurn), ...authorization },
    } as unknown as PersistedUserTurnMessage,
  };
}
function parseEnvelope(
  raw: string,
  kind: MainRunRecoveryKind,
  authorization: MainRunRecoveryAuthorization,
): MainRunRecoveryEnvelope {
  const envelope = parse<MainRunRecoveryEnvelope>(raw);
  if (envelope.kind !== kind) {
    throw new Error("recovery envelope kind mismatch");
  }
  if (
    kind === "exact_turn" &&
    exactTurnMeta((envelope as MainRunRecoveryExactTurnEnvelope).approvedTurn).senderIsOwner !==
      authorization.senderIsOwner
  ) {
    throw new Error("recovery envelope authorization mismatch");
  }
  const normalized = normalizeEnvelope(envelope, authorization);
  if (encode(envelope) !== encode(normalized)) {
    throw new Error("recovery envelope is not canonical");
  }
  return normalized;
}
function normalizeOutcome(value: MainRunRecoveryTerminalOutcome): MainRunRecoveryTerminalOutcome {
  if (!TERMINAL_STATUSES.has(value.status)) {
    throw new Error("invalid recovery terminal status");
  }
  return { status: value.status, endedAtMs: uint(value.endedAtMs, "terminal timestamp") };
}
function normalizeExecution(value: MainRunRecoveryExecution): MainRunRecoveryExecution {
  return {
    runId: text(value.runId, "execution run id"),
    lifecycleGeneration: text(value.lifecycleGeneration, "execution lifecycle generation"),
    epoch: text(value.epoch, "execution epoch"),
  };
}
function sameExecution(
  left: MainRunRecoveryExecution | undefined,
  right: MainRunRecoveryExecution,
): boolean {
  return Boolean(
    left &&
    left.runId === right.runId &&
    left.lifecycleGeneration === right.lifecycleGeneration &&
    left.epoch === right.epoch,
  );
}
function normalizeCancellation(value: MainRunRecoveryCancellation): MainRunRecoveryCancellation {
  if (value.kind !== "abort" && value.kind !== "reset" && value.kind !== "delete") {
    throw new Error("invalid recovery cancellation kind");
  }
  return {
    kind: value.kind,
    epoch: text(value.epoch, "cancellation epoch"),
    requestedAtMs: uint(value.requestedAtMs, "cancellation timestamp"),
  };
}

export function hashMainRunRecoveryTranscriptTail(message: unknown): string {
  return sha256(encode(message));
}
export function fingerprintMainRunRecoverySource(params: {
  sourceKey: string;
  identity: MainRunRecoveryIdentity;
  envelope: MainRunRecoveryEnvelope;
  ownerPrincipal?: MainRunRecoveryOwnerPrincipal;
  authorization: MainRunRecoveryAuthorization;
}): string {
  const envelope = normalizeEnvelope(params.envelope, params.authorization);
  const ownerPrincipal = normalizePrincipal(params.ownerPrincipal);
  const identity = normalizeIdentity(params.identity);
  assertAuthorization(envelope.kind, ownerPrincipal, params.authorization);
  const fingerprintEnvelope =
    envelope.kind === "exact_turn"
      ? {
          ...envelope,
          approvedTurn: Object.fromEntries(
            Object.entries(envelope.approvedTurn as unknown as Record<string, unknown>).filter(
              ([key]) => key !== "timestamp",
            ),
          ),
        }
      : envelope;
  return sha256(
    encode({
      sourceKind: envelope.kind,
      sourceKey: text(params.sourceKey, "source key"),
      identity,
      envelope: fingerprintEnvelope,
      ownerPrincipal: ownerPrincipal ?? null,
      authorization: params.authorization,
    }),
  );
}
export function deriveImportedMainRunRecoveryPublicRunId(
  kind: MainRunRecoveryKind,
  sourceKey: string,
): string {
  const bytes = Buffer.from(
    sha256(`openclaw:main-run-recovery:v1\0${kind}\0${text(sourceKey, "source key")}`).slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function facade(db: DatabaseSync) {
  return getNodeSqliteKysely<RecoveryDatabase>(db);
}
function selectPublic(db: DatabaseSync, publicRunId: string): RecoveryRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    facade(db)
      .selectFrom("main_run_recoveries")
      .selectAll()
      .where("public_run_id", "=", publicRunId),
  );
}
function selectSource(
  db: DatabaseSync,
  kind: MainRunRecoveryKind,
  sourceKey: string,
): RecoveryRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    facade(db)
      .selectFrom("main_run_recoveries")
      .selectAll()
      .where("source_kind", "=", kind)
      .where("source_key", "=", sourceKey),
  );
}
function rowToRecovery(row: RecoveryRow): MainRunRecovery {
  const kind = row.source_kind as MainRunRecoveryKind;
  const state = row.state as MainRunRecoveryState;
  const authorization = { senderIsOwner: row.sender_is_owner === 1 };
  const principal = row.owner_principal_json
    ? normalizePrincipal(parse<MainRunRecoveryOwnerPrincipal>(row.owner_principal_json))
    : undefined;
  assertAuthorization(kind, principal, authorization);
  const envelope = row.envelope_json
    ? parseEnvelope(row.envelope_json, kind, authorization)
    : undefined;
  if (
    envelope &&
    fingerprintMainRunRecoverySource({
      sourceKey: row.source_key,
      identity: {
        agentId: row.agent_id,
        sessionKey: row.session_key,
        sessionKeyAliases: parse<string[]>(row.session_key_aliases_json),
        sessionId: row.session_id,
        storePath: row.store_path,
      },
      envelope,
      ownerPrincipal: principal,
      authorization,
    }) !== row.source_fingerprint
  ) {
    throw new Error(`recovery ${row.public_run_id} source fingerprint mismatch`);
  }
  const terminalOutcome = row.terminal_outcome_json
    ? normalizeOutcome(parse<MainRunRecoveryTerminalOutcome>(row.terminal_outcome_json))
    : undefined;
  const lifecycleFences = normalizeFences(parse<unknown>(row.lifecycle_fences_json));
  const execution =
    row.execution_run_id && row.execution_lifecycle_generation && row.execution_epoch
      ? normalizeExecution({
          runId: row.execution_run_id,
          lifecycleGeneration: row.execution_lifecycle_generation,
          epoch: row.execution_epoch,
        })
      : undefined;
  const evidenceValue = row.terminal_evidence_json
    ? parse<{ outcome: MainRunRecoveryTerminalOutcome; execution: MainRunRecoveryExecution }>(
        row.terminal_evidence_json,
      )
    : undefined;
  const terminalEvidence =
    evidenceValue && row.terminal_evidence_at_ms !== null
      ? {
          outcome: normalizeOutcome(evidenceValue.outcome),
          execution: normalizeExecution(evidenceValue.execution),
          observedAtMs: row.terminal_evidence_at_ms,
        }
      : undefined;
  if (terminalEvidence && !sameExecution(execution, terminalEvidence.execution)) {
    throw new Error(`recovery ${row.public_run_id} terminal evidence mismatch`);
  }
  const cancellation = row.cancellation_json
    ? normalizeCancellation(parse<MainRunRecoveryCancellation>(row.cancellation_json))
    : undefined;
  const shared: RecoveryShared = {
    publicRunId: row.public_run_id,
    sourceKey: row.source_key,
    sourceFingerprint: row.source_fingerprint,
    state,
    bootId: row.boot_id,
    agentId: row.agent_id,
    authorization,
    sessionKey: row.session_key,
    sessionKeyAliases: parse<string[]>(row.session_key_aliases_json),
    sessionId: row.session_id,
    storePath: row.store_path,
    envelope: envelope as MainRunRecoveryExactTurnEnvelope & MainRunRecoverySessionResumeEnvelope,
    revision: row.revision,
    attemptCount: row.attempt_count,
    lifecycleFences,
    nextAttemptAtMs: row.next_attempt_at_ms ?? undefined,
    lastError: row.last_error ?? undefined,
    lease:
      row.lease_owner && row.lease_expires_at_ms !== null
        ? { owner: row.lease_owner, expiresAtMs: row.lease_expires_at_ms }
        : undefined,
    execution,
    terminalEvidence,
    cancellation,
    terminalOutcome,
    acceptedAtMs: row.accepted_at_ms,
    updatedAtMs: row.updated_at_ms,
    terminalAtMs: row.terminal_at_ms ?? undefined,
    pruneAfterMs: row.prune_after_ms ?? undefined,
  };
  return kind === "session_resume"
    ? {
        ...shared,
        kind,
        authorization: MAIN_RUN_RECOVERY_UNPRIVILEGED_AUTHORIZATION,
        envelope: envelope as MainRunRecoverySessionResumeEnvelope | undefined,
      }
    : {
        ...shared,
        kind,
        ownerPrincipal: principal,
        envelope: envelope as MainRunRecoveryExactTurnEnvelope | undefined,
      };
}
type NormalizableReserveInput = Omit<ReserveMainRunRecoveryInput, "envelope" | "initialLease"> & {
  envelope: MainRunRecoveryEnvelope;
  initialLease?: MainRunRecoveryInitialLease;
};

function normalizeReserve(input: NormalizableReserveInput, state: "accepted" | "recovery_pending") {
  const envelope = normalizeEnvelope(input.envelope, input.authorization);
  const ownerPrincipal = normalizePrincipal(input.ownerPrincipal);
  const identity = normalizeIdentity(input);
  assertAuthorization(envelope.kind, ownerPrincipal, input.authorization);
  const sourceKey = text(input.sourceKey, "source key");
  if (
    envelope.kind === "exact_turn" &&
    sourceKey !==
      text(
        (envelope.approvedTurn as unknown as { idempotencyKey?: unknown }).idempotencyKey,
        "turn idempotency key",
      )
  ) {
    throw new Error("exact recovery source key must equal the turn idempotency key");
  }
  const sourceFingerprint = fingerprint(input.sourceFingerprint);
  if (
    fingerprintMainRunRecoverySource({
      sourceKey,
      identity,
      envelope,
      ownerPrincipal,
      authorization: input.authorization,
    }) !== sourceFingerprint
  ) {
    throw new Error("recovery source fingerprint does not match its payload");
  }
  const acceptedAtMs = uint(input.acceptedAtMs, "accepted timestamp");
  const initialLease = input.initialLease
    ? {
        owner: text(input.initialLease.owner, "initial lease owner"),
        expiresAtMs: uint(input.initialLease.expiresAtMs, "initial lease expiry"),
      }
    : undefined;
  if (state === "accepted" && envelope.kind === "exact_turn" && !initialLease) {
    throw new Error("exact recovery reservation requires an initial admission lease");
  }
  if (initialLease && (state !== "accepted" || initialLease.expiresAtMs <= acceptedAtMs)) {
    throw new Error("initial recovery lease must expire after acceptance");
  }
  return {
    publicRunId: text(input.publicRunId, "public run id"),
    kind: envelope.kind,
    sourceKey,
    sourceFingerprint,
    state,
    bootId: text(input.bootId, "boot id"),
    ownerJson: ownerPrincipal ? encode(ownerPrincipal) : null,
    senderIsOwner: input.authorization.senderIsOwner ? 1 : 0,
    identity,
    envelopeJson: encode(envelope),
    lifecycleFences:
      envelope.kind === "session_resume" ? normalizeFences(envelope.fences) : ([] as const),
    initialLease,
    acceptedAtMs,
  };
}
type NormalizedReserve = ReturnType<typeof normalizeReserve>;
function verifyDuplicate(row: RecoveryRow, value: NormalizedReserve): MainRunRecovery {
  if (
    row.public_run_id !== value.publicRunId ||
    row.source_kind !== value.kind ||
    row.source_key !== value.sourceKey ||
    row.source_fingerprint !== value.sourceFingerprint ||
    row.agent_id !== value.identity.agentId ||
    row.owner_principal_json !== value.ownerJson ||
    row.sender_is_owner !== value.senderIsOwner ||
    row.session_key !== value.identity.sessionKey ||
    row.session_key_aliases_json !== encode(value.identity.sessionKeyAliases) ||
    row.session_id !== value.identity.sessionId ||
    row.store_path !== value.identity.storePath ||
    (value.kind === "session_resume" &&
      row.envelope_json !== null &&
      row.envelope_json !== value.envelopeJson)
  ) {
    throw new Error(`recovery source collision for ${value.kind}:${value.sourceKey}`);
  }
  return rowToRecovery(row);
}
function insertRecoveryInTransaction(
  value: NormalizedReserve,
  db: DatabaseSync,
): ReserveMainRunRecoveryResult {
  const inserted = executeSqliteQuerySync(
    db,
    facade(db)
      .insertInto("main_run_recoveries")
      .values({
        public_run_id: value.publicRunId,
        source_kind: value.kind,
        source_key: value.sourceKey,
        source_fingerprint: value.sourceFingerprint,
        state: value.state,
        boot_id: value.bootId,
        agent_id: value.identity.agentId,
        owner_principal_json: value.ownerJson,
        sender_is_owner: value.senderIsOwner,
        session_key: value.identity.sessionKey,
        session_key_aliases_json: encode(value.identity.sessionKeyAliases),
        session_id: value.identity.sessionId,
        store_path: value.identity.storePath,
        lifecycle_fences_json: encode(value.lifecycleFences),
        envelope_json: value.envelopeJson,
        revision: 1,
        attempt_count: 0,
        next_attempt_at_ms: value.acceptedAtMs,
        last_error: null,
        lease_owner: value.initialLease?.owner ?? null,
        lease_expires_at_ms: value.initialLease?.expiresAtMs ?? null,
        execution_run_id: null,
        execution_lifecycle_generation: null,
        execution_epoch: null,
        terminal_evidence_json: null,
        terminal_evidence_at_ms: null,
        cancellation_json: null,
        terminal_outcome_json: null,
        accepted_at_ms: value.acceptedAtMs,
        updated_at_ms: value.acceptedAtMs,
        terminal_at_ms: null,
        prune_after_ms: null,
      })
      .onConflict((conflict) => conflict.doNothing()),
  );
  const sameId = selectPublic(db, value.publicRunId);
  if (sameId) {
    return {
      status: Number(inserted.numAffectedRows ?? 0) === 1 ? "inserted" : "duplicate",
      recovery: verifyDuplicate(sameId, value),
    };
  }
  const sameSource = selectSource(db, value.kind, value.sourceKey);
  if (sameSource) {
    return { status: "duplicate", recovery: verifyDuplicate(sameSource, value) };
  }
  const blocker = executeSqliteQueryTakeFirstSync(
    db,
    facade(db)
      .selectFrom("main_run_recoveries")
      .selectAll()
      .where("store_path", "=", value.identity.storePath)
      .where("session_id", "=", value.identity.sessionId)
      .where("state", "!=", "terminal"),
  );
  if (!blocker) {
    throw new Error(`failed to reserve recovery ${value.publicRunId}`);
  }
  return { status: "session_blocked", recovery: rowToRecovery(blocker) };
}

function insertRecovery(
  value: NormalizedReserve,
  database: DbOptions,
): ReserveMainRunRecoveryResult {
  return runOpenClawStateWriteTransaction(
    ({ db }) => insertRecoveryInTransaction(value, db),
    database,
  );
}

export function reserveMainRunRecovery(
  input: ReserveMainRunRecoveryInput,
  database: DbOptions = {},
): ReserveMainRunRecoveryResult {
  return insertRecovery(normalizeReserve(input, "accepted"), database);
}
export function insertOrVerifyImportedMainRunRecovery(
  input: ImportedMainRunRecoveryInput,
  database: DbOptions = {},
): ReserveMainRunRecoveryResult {
  return insertRecovery(normalizeImportedMainRunRecovery(input), database);
}

function normalizeImportedMainRunRecovery(input: ImportedMainRunRecoveryInput): NormalizedReserve {
  const firstFence = input.envelope.fences.toSorted((left, right) =>
    `${left.runId}\0${left.lifecycleGeneration}`.localeCompare(
      `${right.runId}\0${right.lifecycleGeneration}`,
    ),
  )[0];
  return normalizeReserve(
    {
      ...input,
      publicRunId:
        optionalText(input.publicRunId, "public run id") ??
        deriveImportedMainRunRecoveryPublicRunId("session_resume", input.sourceKey),
      bootId:
        optionalText(input.bootId, "boot id") ??
        firstFence?.lifecycleGeneration ??
        LEGACY_IMPORT_GENERATION,
      authorization: MAIN_RUN_RECOVERY_UNPRIVILEGED_AUTHORIZATION,
    },
    "recovery_pending",
  );
}

function importedInputFromSessionResume(
  input: ReserveMainSessionResumeRecoveryInput,
): ImportedMainRunRecoveryInput {
  const identity: MainRunRecoveryIdentity = {
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    sessionKeyAliases: input.sessionKeyAliases,
    sessionId: input.sessionId,
    storePath: input.storePath,
  };
  const sourceKey = text(input.sourceKey, "source key");
  return {
    ...identity,
    publicRunId: deriveImportedMainRunRecoveryPublicRunId("session_resume", sourceKey),
    sourceKey,
    sourceFingerprint: fingerprintMainRunRecoverySource({
      sourceKey,
      identity,
      envelope: input.envelope,
      authorization: MAIN_RUN_RECOVERY_UNPRIVILEGED_AUTHORIZATION,
    }),
    bootId: input.bootId,
    envelope: input.envelope,
    acceptedAtMs: input.acceptedAtMs,
  };
}

/** Reserve live, unprivileged session-resume work under a deterministic SQLite identity. */
export function reserveMainSessionResumeRecovery(
  input: ReserveMainSessionResumeRecoveryInput,
  database: DbOptions = {},
): ReserveMainRunRecoveryResult {
  return insertOrVerifyImportedMainRunRecovery(importedInputFromSessionResume(input), database);
}

/** Atomically reserve a controlled-restart batch; any blocker rolls back every insertion. */
export function reserveMainSessionResumeRecoveryBatch(
  inputs: readonly ReserveMainSessionResumeRecoveryInput[],
  database: DbOptions = {},
): readonly ReserveMainRunRecoveryResult[] {
  const normalized = inputs.map((input) =>
    normalizeImportedMainRunRecovery(importedInputFromSessionResume(input)),
  );
  const physicalOwners = new Set<string>();
  for (const value of normalized) {
    const physicalKey = `${value.identity.storePath}\0${value.identity.sessionId}`;
    if (physicalOwners.has(physicalKey)) {
      throw new Error(`duplicate physical session in recovery batch: ${value.identity.sessionId}`);
    }
    physicalOwners.add(physicalKey);
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    const results: ReserveMainRunRecoveryResult[] = [];
    for (const value of normalized) {
      const result = insertRecoveryInTransaction(value, db);
      if (result.status === "session_blocked") {
        throw new Error(
          `recovery batch blocked by active run ${result.recovery.publicRunId} for session ${result.recovery.sessionId}`,
        );
      }
      results.push(result);
    }
    return results;
  }, database);
}
export function getMainRunRecovery(
  publicRunId: string,
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const row = selectPublic(
    openOpenClawStateDatabase(database).db,
    text(publicRunId, "public run id"),
  );
  return row ? rowToRecovery(row) : undefined;
}
export function getMainRunRecoveryBySource(
  source: { kind: MainRunRecoveryKind; sourceKey: string },
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const row = selectSource(
    openOpenClawStateDatabase(database).db,
    source.kind,
    text(source.sourceKey, "source key"),
  );
  return row ? rowToRecovery(row) : undefined;
}
export function findActiveMainRunRecoveryByExecution(
  execution: MainRunRecoveryExecution &
    Pick<MainRunRecoveryIdentity, "agentId" | "sessionId" | "storePath">,
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const db = openOpenClawStateDatabase(database).db;
  const rows = executeSqliteQuerySync(
    db,
    facade(db)
      .selectFrom("main_run_recoveries")
      .selectAll()
      .where("agent_id", "=", text(execution.agentId, "agent id"))
      .where(
        "store_path",
        "=",
        resolveCanonicalSessionStorePath(text(execution.storePath, "session store path")),
      )
      .where("session_id", "=", text(execution.sessionId, "session id"))
      .where("execution_run_id", "=", text(execution.runId, "execution run id"))
      .where(
        "execution_lifecycle_generation",
        "=",
        text(execution.lifecycleGeneration, "execution lifecycle generation"),
      )
      .where("execution_epoch", "=", text(execution.epoch, "execution epoch"))
      .where("state", "!=", "terminal"),
  ).rows;
  if (rows.length > 1) {
    throw new Error("ambiguous active main-run recovery execution identity");
  }
  return rows[0] ? rowToRecovery(rows[0]) : undefined;
}
export function findActiveMainRunRecoveryBySession(
  identity: MainRunRecoveryIdentity,
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const expected = normalizeIdentity(identity);
  const db = openOpenClawStateDatabase(database).db;
  const rows = executeSqliteQuerySync(
    db,
    facade(db)
      .selectFrom("main_run_recoveries")
      .selectAll()
      .where("store_path", "=", expected.storePath)
      .where("session_id", "=", expected.sessionId)
      .where("state", "!=", "terminal"),
  ).rows;
  if (rows.length > 1) {
    throw new Error("ambiguous active main-run recovery physical session ownership");
  }
  return rows[0] ? rowToRecovery(rows[0]) : undefined;
}
export function findLatestMainRunRecoveryBySession(
  identity: MainRunRecoveryIdentity,
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const expected = normalizeIdentity(identity);
  const db = openOpenClawStateDatabase(database).db;
  const row = executeSqliteQueryTakeFirstSync(
    db,
    facade(db)
      .selectFrom("main_run_recoveries")
      .selectAll()
      .where("agent_id", "=", expected.agentId)
      .where("store_path", "=", expected.storePath)
      .where("session_id", "=", expected.sessionId)
      .orderBy("accepted_at_ms", "desc")
      .orderBy("public_run_id", "desc"),
  );
  return row ? rowToRecovery(row) : undefined;
}
export function listNonTerminalMainRunRecoveries(database: DbOptions = {}): MainRunRecovery[] {
  const db = openOpenClawStateDatabase(database).db;
  return executeSqliteQuerySync(
    db,
    facade(db)
      .selectFrom("main_run_recoveries")
      .selectAll()
      .where("state", "!=", "terminal")
      .orderBy("accepted_at_ms")
      .orderBy("public_run_id"),
  ).rows.map(rowToRecovery);
}

/** Durable late-event fences retained across restarts until terminal pruning. */
export function listRetainedMainRunRecoveryLifecycleFences(
  params: { nowMs: number },
  database: DbOptions = {},
): MainRunRecoveryFence[] {
  const now = uint(params.nowMs, "fence retention timestamp");
  const db = openOpenClawStateDatabase(database).db;
  const recoveries = executeSqliteQuerySync(
    db,
    facade(db)
      .selectFrom("main_run_recoveries")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("state", "!=", "terminal"),
          eb.and([eb("prune_after_ms", "is not", null), eb("prune_after_ms", ">", now)]),
        ]),
      ),
  ).rows.map(rowToRecovery);
  return normalizeFences(
    recoveries.flatMap((recovery) => [
      ...recovery.lifecycleFences,
      ...(recovery.state === "terminal" && recovery.execution ? [recovery.execution] : []),
    ]),
  );
}

export function listPriorBootMainRunRecoveries(
  currentBootId: string,
  database: DbOptions = {},
): MainRunRecovery[] {
  const db = openOpenClawStateDatabase(database).db;
  return executeSqliteQuerySync(
    db,
    facade(db)
      .selectFrom("main_run_recoveries")
      .selectAll()
      .where("state", "!=", "terminal")
      .where("boot_id", "!=", text(currentBootId, "boot id"))
      .orderBy("accepted_at_ms")
      .orderBy("public_run_id"),
  ).rows.map(rowToRecovery);
}
export function listDueMainRunRecoveries(
  params: { nowMs: number; currentBootId: string; limit?: number },
  database: DbOptions = {},
): MainRunRecovery[] {
  const now = uint(params.nowMs, "due timestamp");
  const db = openOpenClawStateDatabase(database).db;
  return executeSqliteQuerySync(
    db,
    facade(db)
      .selectFrom("main_run_recoveries")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb.and([
            eb("terminal_evidence_json", "is not", null),
            eb("next_attempt_at_ms", "<=", now),
            eb.or([
              eb("state", "=", "running"),
              eb("boot_id", "!=", text(params.currentBootId, "current boot id")),
              eb("lease_owner", "is", null),
              eb("lease_expires_at_ms", "<=", now),
            ]),
          ]),
          eb.and([
            eb("state", "in", ["accepted", "transcript_owned", "recovery_pending", "cancelling"]),
            eb("next_attempt_at_ms", "<=", now),
            eb.or([
              eb("boot_id", "!=", text(params.currentBootId, "current boot id")),
              eb("lease_owner", "is", null),
              eb("lease_expires_at_ms", "<=", now),
            ]),
          ]),
        ]),
      )
      .where("state", "!=", "terminal")
      .orderBy("terminal_evidence_at_ms", "desc")
      .orderBy("next_attempt_at_ms")
      .orderBy("public_run_id")
      .limit(uint(params.limit ?? 100, "due limit", true)),
  ).rows.map(rowToRecovery);
}

function mutateCas(
  value: MainRunRecoveryCas,
  nowMs: number,
  database: DbOptions,
  decide: (current: MainRunRecovery) => Patch | undefined,
): MainRunRecovery | undefined {
  const identity = normalizeIdentity(value);
  const publicRunId = text(value.publicRunId, "public run id");
  const revision = uint(value.expectedRevision, "expected revision", true);
  const now = uint(nowMs, "update timestamp");
  return runOpenClawStateWriteTransaction(({ db }) => {
    const row = selectPublic(db, publicRunId);
    if (
      !row ||
      row.revision !== revision ||
      row.state !== value.expectedState ||
      row.agent_id !== identity.agentId ||
      row.session_key !== identity.sessionKey ||
      row.session_key_aliases_json !== encode(identity.sessionKeyAliases) ||
      row.session_id !== identity.sessionId ||
      row.store_path !== identity.storePath
    ) {
      return undefined;
    }
    const current = rowToRecovery(row);
    const patch = decide(current);
    if (!patch) {
      return undefined;
    }
    const updated = executeSqliteQuerySync(
      db,
      facade(db)
        .updateTable("main_run_recoveries")
        .set({ ...patch, revision: revision + 1, updated_at_ms: now })
        .where("public_run_id", "=", publicRunId)
        .where("revision", "=", revision),
    );
    const result =
      Number(updated.numAffectedRows ?? 0) === 1 ? selectPublic(db, publicRunId) : undefined;
    if (!result) {
      return undefined;
    }
    return rowToRecovery(result);
  }, database);
}

function rowMatchesIdentity(
  row: RecoveryRow,
  identity: Required<MainRunRecoveryIdentity>,
): boolean {
  return (
    row.agent_id === identity.agentId &&
    row.session_key === identity.sessionKey &&
    row.session_key_aliases_json === encode(identity.sessionKeyAliases) &&
    row.session_id === identity.sessionId &&
    row.store_path === identity.storePath
  );
}

const TRANSITIONS: Record<Exclude<MainRunRecoveryState, "terminal">, MainRunRecoveryState[]> = {
  accepted: ["transcript_owned"],
  transcript_owned: ["running", "recovery_pending"],
  running: ["recovery_pending"],
  recovery_pending: ["running"],
  cancelling: [],
};
export function transitionMainRunRecoveryStateCas(
  params: MainRunRecoveryCas & {
    nextState: "transcript_owned" | "running" | "recovery_pending";
    nowMs: number;
    nextAttemptAtMs?: number;
    lastError?: string | null;
    currentBootId: string;
    execution?: MainRunRecoveryExecution;
  },
  database: DbOptions = {},
): MainRunRecovery | undefined {
  if (!TRANSITIONS[params.expectedState].includes(params.nextState)) {
    throw new Error(`invalid recovery transition ${params.expectedState} -> ${params.nextState}`);
  }
  const currentBootId = text(params.currentBootId, "current boot id");
  const execution = params.execution ? normalizeExecution(params.execution) : undefined;
  if ((params.nextState === "running") !== Boolean(execution)) {
    throw new Error("running transition requires exactly one execution identity");
  }
  return mutateCas(params, params.nowMs, database, (current) => {
    if (
      current.terminalEvidence ||
      (current.state === "running" && current.bootId === currentBootId)
    ) {
      return undefined;
    }
    const lifecycleFences =
      current.state === "running" && current.execution
        ? normalizeFences([...current.lifecycleFences, current.execution])
        : current.lifecycleFences;
    return {
      state: params.nextState,
      ...(params.nextState === "running" ? { boot_id: currentBootId } : {}),
      next_attempt_at_ms:
        params.nextState === "recovery_pending" || params.nextState === "transcript_owned"
          ? uint(params.nextAttemptAtMs ?? params.nowMs, "next attempt")
          : null,
      last_error:
        params.nextState === "recovery_pending"
          ? (optionalText(params.lastError, "last error") ?? null)
          : null,
      ...(params.nextState === "recovery_pending" || params.nextState === "running"
        ? { lease_owner: null, lease_expires_at_ms: null }
        : {}),
      ...(params.nextState === "running"
        ? {
            execution_run_id: execution?.runId,
            execution_lifecycle_generation: execution?.lifecycleGeneration,
            execution_epoch: execution?.epoch,
          }
        : params.nextState === "recovery_pending"
          ? {
              lifecycle_fences_json: encode(lifecycleFences),
              execution_run_id: null,
              execution_lifecycle_generation: null,
              execution_epoch: null,
            }
          : {}),
      // The accepted prompt is erased exactly when transcript ownership succeeds.
      ...(current.kind === "exact_turn" && params.nextState !== "recovery_pending"
        ? { envelope_json: null }
        : {}),
    };
  });
}

/** Roll back an adopted execution when its start observer rejects the handoff. */
export function returnMainRunRecoveryExecutionToPending(
  params: Omit<MainRunRecoveryCas, "expectedState"> & {
    expectedState: "running";
    execution: MainRunRecoveryExecution;
    currentBootId: string;
    nowMs: number;
    nextAttemptAtMs: number;
    lastError: string;
  },
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const execution = normalizeExecution(params.execution);
  const currentBootId = text(params.currentBootId, "current boot id");
  const nextAttemptAtMs = uint(params.nextAttemptAtMs, "next attempt");
  return mutateCas(params, params.nowMs, database, (current) => {
    if (
      current.state !== "running" ||
      current.bootId !== currentBootId ||
      current.terminalEvidence ||
      !sameExecution(current.execution, execution)
    ) {
      return undefined;
    }
    const lifecycleFences = normalizeFences([...current.lifecycleFences, execution]);
    return {
      state: "recovery_pending",
      lifecycle_fences_json: encode(lifecycleFences),
      next_attempt_at_ms: nextAttemptAtMs,
      last_error: text(params.lastError, "last error"),
      lease_owner: null,
      lease_expires_at_ms: null,
      execution_run_id: null,
      execution_lifecycle_generation: null,
      execution_epoch: null,
    };
  });
}

export function claimMainRunRecoveryLease(
  params: MainRunRecoveryCas & {
    leaseOwner: string;
    nowMs: number;
    leaseDurationMs: number;
    currentBootId: string;
  },
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const owner = text(params.leaseOwner, "lease owner");
  const now = uint(params.nowMs, "lease timestamp");
  const expiresAtMs = now + uint(params.leaseDurationMs, "lease duration", true);
  return mutateCas(params, now, database, (current) =>
    ((current.terminalEvidence && current.state !== "running") ||
      (["accepted", "transcript_owned", "recovery_pending", "cancelling"].includes(current.state) &&
        current.nextAttemptAtMs !== undefined &&
        current.nextAttemptAtMs <= now)) &&
    (current.bootId !== text(params.currentBootId, "current boot id") ||
      !current.lease ||
      current.lease.expiresAtMs <= now)
      ? {
          attempt_count: current.attemptCount + 1,
          boot_id: text(params.currentBootId, "current boot id"),
          last_error: null,
          lease_owner: owner,
          lease_expires_at_ms: uint(expiresAtMs, "lease expiry"),
        }
      : undefined,
  );
}
export function renewMainRunRecoveryLease(
  params: MainRunRecoveryCas & { leaseOwner: string; nowMs: number; leaseDurationMs: number },
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const owner = text(params.leaseOwner, "lease owner");
  const now = uint(params.nowMs, "lease timestamp");
  const expiresAtMs = uint(
    now + uint(params.leaseDurationMs, "lease duration", true),
    "lease expiry",
  );
  return mutateCas(params, now, database, (current) =>
    current.lease?.owner === owner && current.lease.expiresAtMs > now
      ? { lease_expires_at_ms: expiresAtMs }
      : undefined,
  );
}
export function releaseMainRunRecoveryLease(
  params: MainRunRecoveryCas & {
    leaseOwner: string;
    nowMs: number;
    nextAttemptAtMs: number;
    lastError?: string | null;
  },
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const owner = text(params.leaseOwner, "lease owner");
  return mutateCas(params, params.nowMs, database, (current) =>
    current.lease?.owner === owner
      ? {
          state: current.terminalEvidence
            ? current.state
            : current.state === "accepted"
              ? "accepted"
              : current.state === "cancelling"
                ? "cancelling"
                : "recovery_pending",
          next_attempt_at_ms:
            current.terminalEvidence && current.state === "running"
              ? null
              : uint(params.nextAttemptAtMs, "next attempt"),
          last_error: optionalText(params.lastError, "last error") ?? null,
          lease_owner: null,
          lease_expires_at_ms: null,
        }
      : undefined,
  );
}

/**
 * Drop an exact turn that never crossed the public acknowledgement boundary.
 * Every ingress-owned fence is part of the delete so ownership drift preserves
 * the durable row for replay instead of turning cleanup into cancellation.
 */
export function discardUnacknowledgedExactTurn(
  params: Omit<MainRunRecoveryCas, "expectedState"> & {
    expectedState: "accepted";
    leaseOwner: string;
  },
  database: DbOptions = {},
): boolean {
  const identity = normalizeIdentity(params);
  const publicRunId = text(params.publicRunId, "public run id");
  const revision = uint(params.expectedRevision, "expected revision", true);
  const leaseOwner = text(params.leaseOwner, "lease owner");
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      Number(
        executeSqliteQuerySync(
          db,
          facade(db)
            .deleteFrom("main_run_recoveries")
            .where("public_run_id", "=", publicRunId)
            .where("source_kind", "=", "exact_turn")
            .where("state", "=", "accepted")
            .where("revision", "=", revision)
            .where("agent_id", "=", identity.agentId)
            .where("session_key", "=", identity.sessionKey)
            .where("session_key_aliases_json", "=", encode(identity.sessionKeyAliases))
            .where("session_id", "=", identity.sessionId)
            .where("store_path", "=", identity.storePath)
            .where("lease_owner", "=", leaseOwner)
            .where("execution_run_id", "is", null)
            .where("execution_lifecycle_generation", "is", null)
            .where("execution_epoch", "is", null)
            .where("terminal_evidence_json", "is", null)
            .where("cancellation_json", "is", null),
        ).numAffectedRows ?? 0,
      ) === 1,
    database,
  );
}

/** Persist a retry floor when row processing fails before a lease can be established. */
export function deferMainRunRecoveryRetryCas(
  params: MainRunRecoveryCas & {
    nowMs: number;
    nextAttemptAtMs: number;
    lastError: string;
  },
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const now = uint(params.nowMs, "retry update timestamp");
  const nextAttemptAtMs = uint(params.nextAttemptAtMs, "next attempt");
  if (nextAttemptAtMs <= now) {
    throw new Error("deferred recovery retry must be in the future");
  }
  return mutateCas(params, now, database, (current) =>
    (current.state === "running" && Boolean(current.terminalEvidence)) ||
    (current.state !== "running" && (!current.lease || current.lease.expiresAtMs <= now))
      ? {
          attempt_count: current.attemptCount + 1,
          next_attempt_at_ms: nextAttemptAtMs,
          last_error: text(params.lastError, "last error"),
        }
      : undefined,
  );
}

export function requestMainRunRecoveryCancellation(
  params: MainRunRecoveryCas & { cancellation: MainRunRecoveryCancellation; nowMs: number },
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const cancellation = normalizeCancellation(params.cancellation);
  const now = uint(params.nowMs, "cancellation update timestamp");
  if (cancellation.requestedAtMs > now) {
    throw new Error("cancellation request is from the future");
  }
  return mutateCas(params, now, database, (current) =>
    current.state === "cancelling" ||
    current.cancellation ||
    cancellation.requestedAtMs < current.acceptedAtMs ||
    current.terminalEvidence
      ? undefined
      : {
          state: "cancelling",
          cancellation_json: encode(cancellation),
          envelope_json: current.kind === "exact_turn" ? null : undefined,
          next_attempt_at_ms: cancellation.requestedAtMs,
          last_error: null,
        },
  );
}
export function recordMainRunRecoveryTerminalEvidenceCas(
  params: MainRunRecoveryCas & {
    execution: MainRunRecoveryExecution;
    outcome: MainRunRecoveryTerminalOutcome;
    observedAtMs: number;
    nowMs: number;
  },
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const execution = normalizeExecution(params.execution);
  const outcome = normalizeOutcome(params.outcome);
  const observedAtMs = uint(params.observedAtMs, "terminal evidence timestamp");
  const now = uint(params.nowMs, "terminal evidence update timestamp");
  if (outcome.endedAtMs > observedAtMs || observedAtMs > now) {
    throw new Error("invalid terminal evidence ordering");
  }
  return mutateCas(params, now, database, (current) =>
    outcome.endedAtMs >= current.acceptedAtMs &&
    observedAtMs >= current.acceptedAtMs &&
    sameExecution(current.execution, execution) &&
    !current.terminalEvidence &&
    (!current.cancellation || observedAtMs <= current.cancellation.requestedAtMs)
      ? {
          terminal_evidence_json: encode({ outcome, execution }),
          terminal_evidence_at_ms: observedAtMs,
          lifecycle_fences_json: encode(normalizeFences([...current.lifecycleFences, execution])),
          next_attempt_at_ms: observedAtMs,
        }
      : undefined,
  );
}

function terminalPatch(outcome: MainRunRecoveryTerminalOutcome, nowMs: number): Patch {
  return {
    state: "terminal",
    envelope_json: null,
    next_attempt_at_ms: null,
    last_error: null,
    lease_owner: null,
    lease_expires_at_ms: null,
    terminal_evidence_json: null,
    terminal_evidence_at_ms: null,
    cancellation_json: null,
    terminal_outcome_json: encode(outcome),
    terminal_at_ms: nowMs,
    prune_after_ms: uint(nowMs + MAIN_RUN_RECOVERY_TERMINAL_RETENTION_MS, "terminal retention"),
  };
}

function terminalOutcomeFor(
  current: MainRunRecovery,
  requestedOutcome: MainRunRecoveryTerminalOutcome,
  nowMs: number,
): MainRunRecoveryTerminalOutcome | undefined {
  const outcome = current.terminalEvidence?.outcome ?? requestedOutcome;
  const failedImport =
    outcome.status === "failed" &&
    current.kind === "session_resume" &&
    current.state === "recovery_pending" &&
    current.envelope?.resolution.kind === "fail";
  const validPredecessor =
    Boolean(current.terminalEvidence) || current.state === "running" || failedImport;
  if (
    outcome.endedAtMs < current.acceptedAtMs ||
    outcome.endedAtMs > nowMs ||
    (current.terminalEvidence?.observedAtMs ?? 0) > nowMs ||
    !validPredecessor ||
    (!current.terminalEvidence &&
      (outcome.status === "cancelled" ||
        (outcome.status === "done" && current.state !== "running")))
  ) {
    return undefined;
  }
  return outcome;
}

function normalizeTransactionalQueueEntry(
  value: MainRunRecoveryTransactionalQueueEntry,
): MainRunRecoveryTransactionalQueueEntry & { entryJson: string } {
  const queueName = text(value.queueName, "delivery queue name");
  const id = text(value.id, "delivery queue id");
  const enqueuedAtMs = uint(value.enqueuedAtMs, "delivery enqueue timestamp");
  const entry = object(value.entry);
  if (!entry || entry.id !== id || entry.enqueuedAt !== enqueuedAtMs || entry.retryCount !== 0) {
    throw new Error("invalid transactional delivery queue entry");
  }
  return {
    queueName,
    id,
    entry,
    ...(value.entryKind ? { entryKind: text(value.entryKind, "delivery entry kind") } : {}),
    ...(value.sessionKey ? { sessionKey: text(value.sessionKey, "delivery session key") } : {}),
    ...(value.channel ? { channel: text(value.channel, "delivery channel") } : {}),
    ...(value.target ? { target: text(value.target, "delivery target") } : {}),
    ...(value.accountId ? { accountId: text(value.accountId, "delivery account") } : {}),
    enqueuedAtMs,
    entryJson: encode(entry),
  };
}

/** Settles a claimed dispatch that failed before an execution identity existed. */
export function terminalizeMainRunRecoveryPreExecutionFailure(
  params: Omit<MainRunRecoveryCas, "expectedState"> & {
    expectedState: "transcript_owned" | "recovery_pending";
    leaseOwner: string;
    outcome: { status: "failed"; endedAtMs: number };
    nowMs: number;
  },
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const leaseOwner = text(params.leaseOwner, "lease owner");
  const outcome = normalizeOutcome(params.outcome);
  const now = uint(params.nowMs, "terminal update timestamp");
  if (outcome.status !== "failed" || now < outcome.endedAtMs) {
    throw new Error("invalid pre-execution failure outcome");
  }
  return mutateCas(params, now, database, (current) =>
    current.lease?.owner === leaseOwner &&
    outcome.endedAtMs >= current.acceptedAtMs &&
    (current.state === "transcript_owned" || current.state === "recovery_pending")
      ? terminalPatch(outcome, now)
      : undefined,
  );
}

/** Settles only the exact cancellation owner, independent of benign row revisions. */
export function terminalizeMainRunRecoveryCancellation(
  params: MainRunRecoveryIdentity & {
    publicRunId: string;
    cancellation: Pick<MainRunRecoveryCancellation, "kind" | "epoch">;
    endedAtMs: number;
    nowMs: number;
  },
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const identity = normalizeIdentity(params);
  const publicRunId = text(params.publicRunId, "public run id");
  const kind = params.cancellation.kind;
  if (kind !== "abort" && kind !== "reset" && kind !== "delete") {
    throw new Error("invalid recovery cancellation kind");
  }
  const epoch = text(params.cancellation.epoch, "cancellation epoch");
  const endedAtMs = uint(params.endedAtMs, "cancellation outcome timestamp");
  const now = uint(params.nowMs, "terminal update timestamp");
  if (endedAtMs > now) {
    throw new Error("terminal update precedes its outcome");
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    const row = selectPublic(db, publicRunId);
    if (!row || row.state !== "cancelling" || !rowMatchesIdentity(row, identity)) {
      return undefined;
    }
    const current = rowToRecovery(row);
    if (
      current.cancellation?.kind !== kind ||
      current.cancellation.epoch !== epoch ||
      endedAtMs < current.acceptedAtMs ||
      (!current.terminalEvidence && endedAtMs < current.cancellation.requestedAtMs)
    ) {
      return undefined;
    }
    const outcome =
      current.terminalEvidence?.outcome ?? ({ status: "cancelled", endedAtMs } as const);
    if (outcome.endedAtMs > now || (current.terminalEvidence?.observedAtMs ?? 0) > now) {
      return undefined;
    }
    const updated = executeSqliteQuerySync(
      db,
      facade(db)
        .updateTable("main_run_recoveries")
        .set({
          ...terminalPatch(outcome, now),
          revision: row.revision + 1,
          updated_at_ms: now,
        })
        .where("public_run_id", "=", publicRunId)
        .where("revision", "=", row.revision)
        .where("state", "=", "cancelling")
        .where("cancellation_json", "=", row.cancellation_json),
    );
    const result =
      Number(updated.numAffectedRows ?? 0) === 1 ? selectPublic(db, publicRunId) : undefined;
    return result ? rowToRecovery(result) : undefined;
  }, database);
}

/** Atomically queues external delivery and terminalizes the owning recovery row. */
export function terminalizeMainRunRecoveryWithQueueEntry(
  params: MainRunRecoveryCas & {
    outcome: MainRunRecoveryTerminalOutcome;
    nowMs: number;
    queueEntry: MainRunRecoveryTransactionalQueueEntry;
  },
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const identity = normalizeIdentity(params);
  const publicRunId = text(params.publicRunId, "public run id");
  const requestedOutcome = normalizeOutcome(params.outcome);
  const now = uint(params.nowMs, "terminal update timestamp");
  if (requestedOutcome.endedAtMs > now) {
    throw new Error("terminal update precedes its outcome");
  }
  const queue = normalizeTransactionalQueueEntry(params.queueEntry);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const row = selectPublic(db, publicRunId);
    if (
      !row ||
      row.revision !== params.expectedRevision ||
      row.state !== params.expectedState ||
      !rowMatchesIdentity(row, identity)
    ) {
      return undefined;
    }
    const current = rowToRecovery(row);
    const outcome = terminalOutcomeFor(current, requestedOutcome, now);
    if (!outcome) {
      return undefined;
    }
    executeSqliteQuerySync(
      db,
      facade(db)
        .insertInto("delivery_queue_entries")
        .values({
          queue_name: queue.queueName,
          id: queue.id,
          status: "pending",
          entry_kind: queue.entryKind ?? null,
          session_key: queue.sessionKey ?? null,
          channel: queue.channel ?? null,
          target: queue.target ?? null,
          account_id: queue.accountId ?? null,
          retry_count: 0,
          last_attempt_at: null,
          last_error: null,
          recovery_state: null,
          platform_send_started_at: null,
          entry_json: queue.entryJson,
          enqueued_at: queue.enqueuedAtMs,
          updated_at: now,
          failed_at: null,
        })
        .onConflict((conflict) => conflict.columns(["queue_name", "id"]).doNothing()),
    );
    const queued = executeSqliteQueryTakeFirstSync(
      db,
      facade(db)
        .selectFrom("delivery_queue_entries")
        .select([
          "status",
          "entry_kind",
          "session_key",
          "channel",
          "target",
          "account_id",
          "retry_count",
          "entry_json",
          "enqueued_at",
        ])
        .where("queue_name", "=", queue.queueName)
        .where("id", "=", queue.id),
    );
    if (
      !queued ||
      queued.status !== "pending" ||
      queued.entry_kind !== (queue.entryKind ?? null) ||
      queued.session_key !== (queue.sessionKey ?? null) ||
      queued.channel !== (queue.channel ?? null) ||
      queued.target !== (queue.target ?? null) ||
      queued.account_id !== (queue.accountId ?? null) ||
      queued.retry_count !== 0 ||
      queued.entry_json !== queue.entryJson ||
      queued.enqueued_at !== queue.enqueuedAtMs
    ) {
      throw new Error(`delivery queue collision for ${queue.queueName}:${queue.id}`);
    }
    const updated = executeSqliteQuerySync(
      db,
      facade(db)
        .updateTable("main_run_recoveries")
        .set({ ...terminalPatch(outcome, now), revision: row.revision + 1, updated_at_ms: now })
        .where("public_run_id", "=", publicRunId)
        .where("revision", "=", row.revision),
    );
    if (Number(updated.numAffectedRows ?? 0) !== 1) {
      throw new Error(`lost terminal ownership for main-run recovery ${publicRunId}`);
    }
    const result = selectPublic(db, publicRunId);
    if (!result) {
      throw new Error(`missing terminal main-run recovery ${publicRunId}`);
    }
    return rowToRecovery(result);
  }, database);
}

export function terminalizeMainRunRecovery(
  params: MainRunRecoveryCas & { outcome: MainRunRecoveryTerminalOutcome; nowMs: number },
  database: DbOptions = {},
): MainRunRecovery | undefined {
  const requestedOutcome = normalizeOutcome(params.outcome);
  const now = uint(params.nowMs, "terminal update timestamp");
  if (now < requestedOutcome.endedAtMs) {
    throw new Error("terminal update precedes its outcome");
  }
  return mutateCas(params, now, database, (current) => {
    const outcome = terminalOutcomeFor(current, requestedOutcome, now);
    return outcome ? terminalPatch(outcome, now) : undefined;
  });
}
export function pruneTerminalMainRunRecoveries(nowMs: number, database: DbOptions = {}): number {
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      Number(
        executeSqliteQuerySync(
          db,
          facade(db)
            .deleteFrom("main_run_recoveries")
            .where("state", "=", "terminal")
            .where("prune_after_ms", "<=", uint(nowMs, "prune timestamp")),
        ).numAffectedRows ?? 0,
      ),
    database,
  );
}
export function scrubMainRunRecoveriesForBackup(database: DbOptions = {}): number {
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      Number(
        executeSqliteQuerySync(db, facade(db).deleteFrom("main_run_recoveries")).numAffectedRows ??
          0,
      ),
    database,
  );
}
