/** Pure planning for doctor-owned import of shipped JSON main-run recovery state. */
import crypto from "node:crypto";
import type { SessionEntry } from "../config/sessions.js";
import { resolveCanonicalSessionStorePath } from "../config/sessions/paths.js";
import {
  deriveImportedMainRunRecoveryPublicRunId,
  fingerprintMainRunRecoverySource,
  MAIN_RUN_RECOVERY_UNPRIVILEGED_AUTHORIZATION,
  type ImportedMainRunRecoveryInput,
  type MainRunRecovery,
  type MainRunRecoveryFence,
  type MainRunRecoverySessionResumeEnvelope,
} from "../state/main-run-recovery-store.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { buildMainRunRecoverySessionResumeMessage } from "./main-run-recovery-policy.js";
import {
  readMainRunRecoveryTranscriptState,
  type MainRunRecoveryTranscriptState,
} from "./main-run-recovery-transcript.js";

const LEGACY_MAIN_RUN_RECOVERY_SOURCE_VERSION = 1;
const LEGACY_MAIN_RUN_RECOVERY_SOURCE_PREFIX = "legacy-json:v1:";

export type LegacyMainRunRecoveryTranscriptState = MainRunRecoveryTranscriptState;
export const readLegacyMainRunRecoveryTranscriptState = readMainRunRecoveryTranscriptState;

export type LegacyMainRunRecoveryExpectedEntry = {
  sessionKey: string;
  sourceFingerprint: string;
};

export type LegacyMainRunRecoveryPlan = {
  sourceKind: "session_resume";
  sourceKey: string;
  sourceFingerprint: string;
  publicRunId: string;
  stableWorkIdentity: string;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  sessionKeyAliases: readonly string[];
  storePath: string;
  transcriptSessionKey: string;
  transcriptStateFingerprint: string;
  staleTranscriptLockPaths: readonly string[];
  expectedEntries: readonly LegacyMainRunRecoveryExpectedEntry[];
  disposition: { kind: "resume" } | { kind: "fail"; code: "unresumable-tail" | "stale-approval" };
  usesUpdatedAtFallback: boolean;
  input: ImportedMainRunRecoveryInput;
};

export type LegacyMainRunRecoveryPlanResult =
  | { status: "planned"; plan: LegacyMainRunRecoveryPlan }
  | { status: "blocked"; reason: "conflicting-session-identities" };

export type LegacyMainRunRecoveryEntry = Omit<
  SessionEntry,
  "restartRecoveryRuns" | "restartRecoveryDeliveryContext" | "restartRecoveryDeliveryRunId"
> & {
  /** Retired shipped JSON fields read only by Doctor migration. */
  restartRecoveryRuns?: { runId: string; lifecycleGeneration: string }[];
  restartRecoveryDeliveryContext?: DeliveryContext;
  restartRecoveryDeliveryRunId?: string;
};

export type LegacyMainRunRecoveryPlanEntry = {
  entry: LegacyMainRunRecoveryEntry;
  sessionKey: string;
};

type BuildLegacyMainRunRecoveryPlanParams = {
  agentId: string;
  entries: readonly LegacyMainRunRecoveryPlanEntry[];
  storePath: string;
  staleTranscriptLockPaths?: readonly string[];
  transcriptState?: LegacyMainRunRecoveryTranscriptState;
};

function hashString(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  );
}

function hashCanonicalJson(value: unknown): string {
  return hashString(JSON.stringify(canonicalizeJson(value)));
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeLegacyMainRunRecoveryFences(
  entries: Iterable<Pick<LegacyMainRunRecoveryEntry, "restartRecoveryRuns">>,
): MainRunRecoveryFence[] {
  const fences = new Map<string, MainRunRecoveryFence>();
  for (const entry of entries) {
    for (const candidate of entry.restartRecoveryRuns ?? []) {
      const runId = normalizeOptionalString(candidate?.runId);
      const lifecycleGeneration = normalizeOptionalString(candidate?.lifecycleGeneration);
      if (!runId || !lifecycleGeneration) {
        continue;
      }
      fences.set(`${runId}\u0000${lifecycleGeneration}`, { runId, lifecycleGeneration });
    }
  }
  return [...fences.values()].toSorted((left, right) =>
    left.runId === right.runId
      ? left.lifecycleGeneration.localeCompare(right.lifecycleGeneration)
      : left.runId.localeCompare(right.runId),
  );
}

function legacyRecoverySourceSnapshot(entry: LegacyMainRunRecoveryEntry): unknown {
  return {
    sessionId: entry.sessionId,
    sessionStartedAt: entry.sessionStartedAt ?? null,
    lifecycleRevision: entry.lifecycleRevision ?? null,
    status: entry.status ?? null,
    abortedLastRun: entry.abortedLastRun ?? null,
    restartRecoveryRuns: entry.restartRecoveryRuns ?? null,
    pendingFinalDelivery: entry.pendingFinalDelivery ?? null,
    pendingFinalDeliveryCreatedAt: entry.pendingFinalDeliveryCreatedAt ?? null,
    pendingFinalDeliveryLastAttemptAt: entry.pendingFinalDeliveryLastAttemptAt ?? null,
    pendingFinalDeliveryAttemptCount: entry.pendingFinalDeliveryAttemptCount ?? null,
    pendingFinalDeliveryLastError: entry.pendingFinalDeliveryLastError ?? null,
    pendingFinalDeliveryText: entry.pendingFinalDeliveryText ?? null,
    pendingFinalDeliveryContext: entry.pendingFinalDeliveryContext ?? null,
    pendingFinalDeliveryIntentId: entry.pendingFinalDeliveryIntentId ?? null,
    restartRecoveryDeliveryContext: entry.restartRecoveryDeliveryContext ?? null,
    restartRecoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId ?? null,
  };
}

export function fingerprintLegacyMainRunRecoveryEntry(entry: LegacyMainRunRecoveryEntry): string {
  return hashCanonicalJson(legacyRecoverySourceSnapshot(entry));
}

export function fingerprintLegacyMainRunRecoveryTranscriptState(
  state: LegacyMainRunRecoveryTranscriptState | undefined,
): string {
  return hashCanonicalJson(state ?? null);
}

function hashFallbackWorkIdentity(
  disposition: LegacyMainRunRecoveryPlan["disposition"],
  updatedAt: number,
): string {
  // Markerless shipped rows have no stronger incident epoch. SQLite preserves
  // this original timestamp so doctor can recover after DB-first/JSON-second crashes.
  return hashCanonicalJson({
    version: LEGACY_MAIN_RUN_RECOVERY_SOURCE_VERSION,
    disposition,
    deliveryIntentIds: [],
    deliveryRunIds: [],
    lifecycleRevisions: [],
    sessionStartedAts: [],
    fallbackUpdatedAts: [updatedAt],
    transcriptTail: null,
    fences: [],
  });
}

function resolveStableWorkIdentity(params: {
  entries: readonly LegacyMainRunRecoveryPlanEntry[];
  fences: readonly MainRunRecoveryFence[];
  transcriptState?: LegacyMainRunRecoveryTranscriptState;
  disposition: LegacyMainRunRecoveryPlan["disposition"];
  fallbackUpdatedAt: number;
}): { stableWorkIdentity: string; usesUpdatedAtFallback: boolean } {
  const deliveryIntentIds = params.entries
    .map(({ entry }) => normalizeOptionalString(entry.pendingFinalDeliveryIntentId))
    .filter((value): value is string => Boolean(value));
  const deliveryRunIds = params.entries
    .map(({ entry }) => normalizeOptionalString(entry.restartRecoveryDeliveryRunId))
    .filter((value): value is string => Boolean(value));
  const lifecycleRevisions = params.entries
    .map(({ entry }) => normalizeOptionalString(entry.lifecycleRevision))
    .filter((value): value is string => Boolean(value));
  const sessionStartedAts = params.entries
    .map(({ entry }) => entry.sessionStartedAt)
    .filter((value): value is number => Number.isFinite(value))
    .toSorted((a, b) => a - b);
  const hasStrongEpoch =
    deliveryIntentIds.length > 0 ||
    deliveryRunIds.length > 0 ||
    lifecycleRevisions.length > 0 ||
    sessionStartedAts.length > 0 ||
    Boolean(params.transcriptState?.tail) ||
    params.fences.length > 0;
  return {
    stableWorkIdentity: hasStrongEpoch
      ? hashCanonicalJson({
          version: LEGACY_MAIN_RUN_RECOVERY_SOURCE_VERSION,
          disposition: params.disposition,
          deliveryIntentIds: [...new Set(deliveryIntentIds)].toSorted(),
          deliveryRunIds: [...new Set(deliveryRunIds)].toSorted(),
          lifecycleRevisions: [...new Set(lifecycleRevisions)].toSorted(),
          sessionStartedAts,
          fallbackUpdatedAts: [],
          transcriptTail: params.transcriptState?.tail ?? null,
          fences: params.fences,
        })
      : hashFallbackWorkIdentity(params.disposition, params.fallbackUpdatedAt),
    usesUpdatedAtFallback: !hasStrongEpoch,
  };
}

function deriveLegacyMainRunRecoverySourceKey(params: {
  storePath: string;
  sessionId: string;
  stableWorkIdentity: string;
}): string {
  return `${LEGACY_MAIN_RUN_RECOVERY_SOURCE_PREFIX}${hashCanonicalJson(params)}`;
}

export function matchesImportedLegacyMainRunRecoveryAfterUpdatedAtDrift(
  plan: LegacyMainRunRecoveryPlan,
  recovery: MainRunRecovery,
): boolean {
  // Physical-session lookup is only a candidate: cleanup requires the exact
  // original fallback source and full normalized payload fingerprint.
  if (!plan.usesUpdatedAtFallback || recovery.kind !== "session_resume") {
    return false;
  }
  if (
    recovery.state === "terminal" &&
    (recovery.terminalAtMs === undefined || plan.input.acceptedAtMs > recovery.terminalAtMs)
  ) {
    // Work newer than a terminal tombstone is a new markerless incident, not
    // the DB-first import that crashed before clearing its JSON ownership.
    return false;
  }
  const stableWorkIdentity = hashFallbackWorkIdentity(plan.disposition, recovery.acceptedAtMs);
  const sourceKey = deriveLegacyMainRunRecoverySourceKey({
    storePath: plan.storePath,
    sessionId: plan.sessionId,
    stableWorkIdentity,
  });
  if (sourceKey !== recovery.sourceKey) {
    return false;
  }
  return (
    fingerprintMainRunRecoverySource({
      sourceKey,
      identity: plan.input,
      envelope: plan.input.envelope,
      authorization: MAIN_RUN_RECOVERY_UNPRIVILEGED_AUTHORIZATION,
    }) === recovery.sourceFingerprint
  );
}

function resolvePrimaryEntry(
  entries: readonly LegacyMainRunRecoveryPlanEntry[],
): LegacyMainRunRecoveryPlanEntry | undefined {
  return entries.toSorted((left, right) => {
    const updatedOrder = right.entry.updatedAt - left.entry.updatedAt;
    return updatedOrder !== 0 ? updatedOrder : left.sessionKey.localeCompare(right.sessionKey);
  })[0];
}

function resolveDisposition(params: {
  entry: SessionEntry;
  transcriptState?: LegacyMainRunRecoveryTranscriptState;
}): LegacyMainRunRecoveryPlan["disposition"] {
  if (
    params.entry.pendingFinalDelivery === true &&
    normalizeOptionalString(params.entry.pendingFinalDeliveryText)
  ) {
    return { kind: "resume" };
  }
  if (params.transcriptState?.tail && !params.transcriptState.resumeBlockCode) {
    return { kind: "resume" };
  }
  return {
    kind: "fail",
    code: params.transcriptState?.resumeBlockCode ?? "unresumable-tail",
  };
}

export function buildLegacyMainRunRecoveryPlan(
  params: BuildLegacyMainRunRecoveryPlanParams,
): LegacyMainRunRecoveryPlanResult {
  const primary = resolvePrimaryEntry(params.entries);
  if (!primary || params.entries.some(({ entry }) => entry.sessionId !== primary.entry.sessionId)) {
    return { status: "blocked", reason: "conflicting-session-identities" };
  }

  const storePath = resolveCanonicalSessionStorePath(params.storePath);
  const sessionId = primary.entry.sessionId;
  const sessionKeys = [...new Set(params.entries.map(({ sessionKey }) => sessionKey))].toSorted();
  const sessionKey = sessionKeys[0];
  if (!sessionKey) {
    return { status: "blocked", reason: "conflicting-session-identities" };
  }
  const sessionKeyAliases = sessionKeys.filter((candidate) => candidate !== sessionKey);
  const fences = normalizeLegacyMainRunRecoveryFences(params.entries.map(({ entry }) => entry));
  const disposition = resolveDisposition({
    entry: primary.entry,
    transcriptState: params.transcriptState,
  });
  const { stableWorkIdentity, usesUpdatedAtFallback } = resolveStableWorkIdentity({
    entries: params.entries,
    fences,
    transcriptState: params.transcriptState,
    disposition,
    fallbackUpdatedAt: primary.entry.updatedAt,
  });
  const sourceKey = deriveLegacyMainRunRecoverySourceKey({
    storePath,
    sessionId,
    stableWorkIdentity,
  });
  const deliveryContext = normalizeDeliveryContext(
    primary.entry.pendingFinalDeliveryContext ?? primary.entry.restartRecoveryDeliveryContext,
  );
  const envelope: MainRunRecoverySessionResumeEnvelope = {
    kind: "session_resume",
    resolution: disposition,
    systemMessage: buildMainRunRecoverySessionResumeMessage(),
    transcriptTail: params.transcriptState?.tail ?? null,
    lifecycleRevision: normalizeOptionalString(primary.entry.lifecycleRevision) ?? null,
    delivery: {
      context: deliveryContext ?? null,
      runId: normalizeOptionalString(primary.entry.restartRecoveryDeliveryRunId) ?? null,
      intentId: normalizeOptionalString(primary.entry.pendingFinalDeliveryIntentId) ?? null,
    },
    fences,
  };
  const identity = {
    agentId: params.agentId,
    sessionKey,
    sessionKeyAliases,
    sessionId,
    storePath,
  };
  const sourceFingerprint = fingerprintMainRunRecoverySource({
    sourceKey,
    identity,
    envelope,
    authorization: MAIN_RUN_RECOVERY_UNPRIVILEGED_AUTHORIZATION,
  });
  const publicRunId = deriveImportedMainRunRecoveryPublicRunId("session_resume", sourceKey);
  const input: ImportedMainRunRecoveryInput = {
    ...identity,
    publicRunId,
    sourceKey,
    sourceFingerprint,
    envelope,
    acceptedAtMs: primary.entry.updatedAt,
  };
  return {
    status: "planned",
    plan: {
      sourceKind: "session_resume",
      sourceKey,
      sourceFingerprint,
      publicRunId,
      stableWorkIdentity,
      agentId: params.agentId,
      sessionId,
      sessionKey,
      sessionKeyAliases,
      storePath,
      transcriptSessionKey: primary.sessionKey,
      transcriptStateFingerprint: fingerprintLegacyMainRunRecoveryTranscriptState(
        params.transcriptState,
      ),
      staleTranscriptLockPaths: [...new Set(params.staleTranscriptLockPaths ?? [])].toSorted(),
      expectedEntries: params.entries
        .map(({ entry, sessionKey }) => ({
          sessionKey,
          sourceFingerprint: fingerprintLegacyMainRunRecoveryEntry(entry),
        }))
        .toSorted((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
      disposition,
      usesUpdatedAtFallback,
      input,
    },
  };
}
