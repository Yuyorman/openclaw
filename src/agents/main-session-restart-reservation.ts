/** Durable SQLite reservations for interrupted main-session work. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import {
  type SessionEntry,
  loadSessionStore,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionFilePath,
  resolveSessionTranscriptPathInDir,
} from "../config/sessions.js";
import { resolveCanonicalSessionStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewaySessionStoreTarget } from "../gateway/session-utils.js";
import {
  getAgentEventLifecycleGeneration,
  listAgentRunsForSession,
} from "../infra/agent-events.js";
import { buildMainRunRecoverySessionResumeMessage } from "../infra/main-run-recovery-policy.js";
import { readMainRunRecoveryTranscriptState } from "../infra/main-run-recovery-transcript.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
} from "../routing/session-key.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import {
  reserveMainSessionResumeRecovery,
  reserveMainSessionResumeRecoveryBatch,
  type MainRunRecoveryFence,
  type MainRunRecoverySessionResumeEnvelope,
  type ReserveMainRunRecoveryResult,
  type ReserveMainSessionResumeRecoveryInput,
} from "../state/main-run-recovery-store.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  deliveryContextFromSession,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { upsertMainRunRecoveryBarrier } from "./main-run-recovery-runtime.js";
import { resolveAgentSessionDirs } from "./session-dirs.js";
import type { SessionLockInspection } from "./session-write-lock.js";

const log = createSubsystemLogger("main-session-restart-reservation");

type RecoveryRunEvidence = {
  runId: string;
  lifecycleGeneration: string;
};

type LiveRecoveryRun = RecoveryRunEvidence & {
  sessionKey: string;
  sessionId: string;
  observedAt?: number;
};

type RecoveryStoreTarget = {
  agentId: string;
  storePath: string;
};

type SessionResumeEvidence =
  | { kind: "controlled_restart"; fences: readonly MainRunRecoveryFence[] }
  | {
      kind: "stale_lock";
      lockPath: string;
      pid: number | null;
      createdAt: string | null;
      staleReasons: readonly string[];
    };

function recoveryDatabase(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir ? { path: resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }) } : {};
}

function normalizeStringSet(values?: Iterable<string>): Set<string> {
  return new Set(
    [...(values ?? [])].map((value) => value.trim()).filter((value) => value.length > 0),
  );
}

function shouldSkipMainRecovery(entry: SessionEntry, sessionKey: string): boolean {
  return (
    (typeof entry.spawnDepth === "number" && entry.spawnDepth > 0) ||
    entry.subagentRole != null ||
    isSubagentSessionKey(sessionKey) ||
    isCronSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey)
  );
}

function normalizeTranscriptLockPath(lockPath: string): string | undefined {
  const trimmed = lockPath.trim();
  if (!path.basename(trimmed).endsWith(".jsonl.lock")) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function resolveEntryTranscriptLockPaths(params: {
  entry: SessionEntry;
  sessionsDir: string;
}): string[] {
  const paths = new Set<string>();
  const remember = (resolvePath: () => string) => {
    try {
      const lockPath = normalizeTranscriptLockPath(`${resolvePath()}.lock`);
      if (lockPath) {
        paths.add(lockPath);
      }
    } catch {
      // Invalid retired metadata is not evidence for deleting a stale lock.
    }
  };
  remember(() =>
    resolveSessionFilePath(params.entry.sessionId, params.entry, {
      sessionsDir: params.sessionsDir,
    }),
  );
  remember(() => resolveSessionTranscriptPathInDir(params.entry.sessionId, params.sessionsDir));
  return [...paths];
}

function recoveryDeliveryContext(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  sessionKey: string;
}): DeliveryContext | undefined {
  const context = normalizeDeliveryContext(
    params.entry.pendingFinalDeliveryContext ?? deliveryContextFromSession(params.entry),
  );
  if (!context || !params.cfg) {
    return context;
  }
  return resolveSendPolicy({
    cfg: params.cfg,
    entry: params.entry,
    sessionKey: params.sessionKey,
    channel: context.channel,
    chatType: params.entry.chatType,
  }) === "deny"
    ? undefined
    : context;
}

function stableSourceKey(params: {
  identity: {
    agentId: string;
    sessionKey: string;
    sessionKeyAliases: readonly string[];
    sessionId: string;
    storePath: string;
  };
  envelope: MainRunRecoverySessionResumeEnvelope;
  evidence: SessionResumeEvidence;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        identity: params.identity,
        envelope: params.envelope,
        evidence: params.evidence,
      }),
    )
    .digest("hex");
  return `live-session-resume:${params.evidence.kind}:${digest}`;
}

function normalizeFences(runs: Iterable<RecoveryRunEvidence>) {
  const unique = new Map<string, MainRunRecoveryFence>();
  for (const run of runs) {
    const runId = run.runId.trim();
    const lifecycleGeneration = run.lifecycleGeneration.trim();
    if (!runId || !lifecycleGeneration) {
      continue;
    }
    unique.set(`${runId}\u0000${lifecycleGeneration}`, { runId, lifecycleGeneration });
  }
  return [...unique.values()].toSorted((left, right) =>
    left.runId === right.runId
      ? left.lifecycleGeneration.localeCompare(right.lifecycleGeneration)
      : left.runId.localeCompare(right.runId),
  );
}

async function buildReservationInput(params: {
  agentId: string;
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  evidence: SessionResumeEvidence;
  lifecycleGeneration: string;
  sessionKey: string;
  sessionKeyAliases: readonly string[];
  storePath: string;
}): Promise<ReserveMainSessionResumeRecoveryInput> {
  const transcriptState = await readMainRunRecoveryTranscriptState({
    entry: params.entry,
    storePath: params.storePath,
  });
  const resolution = transcriptState.resumeBlockCode
    ? ({ kind: "fail", code: transcriptState.resumeBlockCode } as const)
    : ({ kind: "resume" } as const);
  const context = recoveryDeliveryContext(params);
  const envelope: MainRunRecoverySessionResumeEnvelope = {
    kind: "session_resume",
    resolution,
    systemMessage: buildMainRunRecoverySessionResumeMessage(),
    transcriptTail: transcriptState.tail ?? null,
    lifecycleRevision: normalizeOptionalString(params.entry.lifecycleRevision) ?? null,
    delivery: {
      context: context ?? null,
      runId: null,
      intentId: normalizeOptionalString(params.entry.pendingFinalDeliveryIntentId) ?? null,
    },
    fences: params.evidence.kind === "controlled_restart" ? params.evidence.fences : [],
  };
  const identity = {
    agentId: normalizeAgentId(params.agentId),
    sessionKey: params.sessionKey,
    sessionKeyAliases: params.sessionKeyAliases,
    sessionId: params.entry.sessionId,
    storePath: resolveCanonicalSessionStorePath(params.storePath),
  };
  return {
    ...identity,
    sourceKey: stableSourceKey({ identity, envelope, evidence: params.evidence }),
    bootId: params.lifecycleGeneration,
    envelope,
    acceptedAtMs: Date.now(),
  };
}

function installRecoveryBarrier(reserved: ReserveMainRunRecoveryResult): void {
  const owner = reserved.recovery;
  if (owner.state !== "terminal") {
    upsertMainRunRecoveryBarrier({
      aliases: [owner.sessionKey, ...owner.sessionKeyAliases],
      ledgerRunId: owner.publicRunId,
      sessionId: owner.sessionId,
      storePath: owner.storePath,
    });
  }
}

async function reserveEntry(params: {
  agentId: string;
  cfg?: OpenClawConfig;
  database: OpenClawStateDatabaseOptions;
  entry: SessionEntry;
  evidence: SessionResumeEvidence;
  lifecycleGeneration: string;
  sessionKey: string;
  sessionKeyAliases: readonly string[];
  storePath: string;
}): Promise<ReserveMainRunRecoveryResult> {
  const reserved = reserveMainSessionResumeRecovery(
    await buildReservationInput(params),
    params.database,
  );
  installRecoveryBarrier(reserved);
  return reserved;
}

async function resolveRecoveryStoreTargets(params: {
  cfg?: OpenClawConfig;
  additionalCfgs?: Iterable<OpenClawConfig | undefined>;
  stateDir?: string;
  sessionKeys?: Iterable<string>;
}): Promise<RecoveryStoreTarget[]> {
  const env = params.stateDir
    ? { ...process.env, OPENCLAW_STATE_DIR: params.stateDir }
    : process.env;
  const targets = new Map<string, RecoveryStoreTarget>();
  const remember = (target: RecoveryStoreTarget) => {
    const storePath = resolveCanonicalSessionStorePath(target.storePath);
    targets.set(storePath, { agentId: normalizeAgentId(target.agentId), storePath });
  };
  for (const cfg of [params.cfg, ...(params.additionalCfgs ?? [])]) {
    if (!cfg) {
      continue;
    }
    for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
      remember(target);
    }
    for (const sessionKey of params.sessionKeys ?? []) {
      try {
        remember(resolveGatewaySessionStoreTarget({ cfg, key: sessionKey }));
      } catch {
        // Configured stores and discovered session directories still cover valid sessions.
      }
    }
  }
  for (const sessionsDir of await resolveAgentSessionDirs(resolveStateDir(env))) {
    remember({
      agentId: path.basename(path.dirname(sessionsDir)),
      storePath: path.join(sessionsDir, "sessions.json"),
    });
  }
  return [...targets.values()].toSorted((left, right) =>
    left.storePath.localeCompare(right.storePath),
  );
}

/** Reserve current-process main runs before a controlled restart aborts them. */
export async function reserveRestartAbortedMainSessions(params: {
  cfg?: OpenClawConfig;
  additionalCfgs?: Iterable<OpenClawConfig | undefined>;
  stateDir?: string;
  sessionKeys?: Iterable<string>;
  sessionIds?: Iterable<string>;
  activeRuns?: Iterable<LiveRecoveryRun>;
  isActiveRun?: (run: LiveRecoveryRun) => boolean;
  reason?: string;
}): Promise<{ reserved: number; skipped: number }> {
  const sessionKeys = normalizeStringSet(params.sessionKeys);
  const sessionIds = normalizeStringSet(params.sessionIds);
  if (sessionKeys.size === 0 && sessionIds.size === 0) {
    return { reserved: 0, skipped: 0 };
  }
  const providedRuns = [...(params.activeRuns ?? [])].filter(
    (run) => params.isActiveRun?.(run) !== false,
  );
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const database = recoveryDatabase(params.stateDir);
  const plans: ReserveMainSessionResumeRecoveryInput[] = [];
  const matchedSessionKeys = new Set<string>();
  const matchedSessionIds = new Set<string>();

  for (const target of await resolveRecoveryStoreTargets({ ...params, sessionKeys })) {
    let store: Record<string, SessionEntry>;
    try {
      store = loadSessionStore(target.storePath, { skipCache: true });
    } catch (err) {
      throw new Error(`failed to read restart recovery store ${target.storePath}`, { cause: err });
    }
    const entriesBySessionId = new Map<string, Array<[string, SessionEntry]>>();
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!entry) {
        continue;
      }
      const entries = entriesBySessionId.get(entry.sessionId) ?? [];
      entries.push([sessionKey, entry]);
      entriesBySessionId.set(entry.sessionId, entries);
    }
    for (const [sessionId, entries] of entriesBySessionId) {
      const aliases = entries.map(([sessionKey]) => sessionKey).toSorted();
      if (
        !sessionIds.has(sessionId) &&
        !aliases.some((sessionKey) => sessionKeys.has(sessionKey))
      ) {
        continue;
      }
      matchedSessionIds.add(sessionId);
      for (const alias of aliases) {
        if (sessionKeys.has(alias)) {
          matchedSessionKeys.add(alias);
        }
      }
      const primary = entries.find(
        ([sessionKey, entry]) => !shouldSkipMainRecovery(entry, sessionKey),
      );
      if (!primary) {
        throw new Error(`restart recovery session ${sessionId} is not a main-session run`);
      }
      const provided = providedRuns.filter(
        (run) => run.sessionId === sessionId || aliases.includes(run.sessionKey),
      );
      const registered = aliases.flatMap((sessionKey) =>
        listAgentRunsForSession({ sessionKey, sessionId }).map((run) => ({
          ...run,
          sessionKey,
          sessionId,
        })),
      );
      const fences = normalizeFences([...provided, ...registered]);
      if (fences.length === 0) {
        // A session projection alone is not authority to synthesize work.
        throw new Error(`restart recovery session ${sessionId} has no exact active-run authority`);
      }
      const preferredKey = provided.find((run) => aliases.includes(run.sessionKey))?.sessionKey;
      const sessionKey = preferredKey ?? primary[0];
      const entry = store[sessionKey] ?? primary[1];
      plans.push(
        await buildReservationInput({
          agentId: target.agentId,
          cfg: params.cfg,
          entry,
          evidence: { kind: "controlled_restart", fences },
          lifecycleGeneration,
          sessionKey,
          sessionKeyAliases: aliases.filter((alias) => alias !== sessionKey),
          storePath: target.storePath,
        }),
      );
    }
  }
  const missingSessionKeys = [...sessionKeys].filter((key) => !matchedSessionKeys.has(key));
  const missingSessionIds = [...sessionIds].filter((id) => !matchedSessionIds.has(id));
  if (missingSessionKeys.length > 0 || missingSessionIds.length > 0) {
    throw new Error(
      `restart recovery identity was not found (${[
        ...missingSessionKeys.map((key) => `key=${key}`),
        ...missingSessionIds.map((id) => `id=${id}`),
      ].join(", ")})`,
    );
  }
  const reservations = reserveMainSessionResumeRecoveryBatch(plans, database);
  for (const reservation of reservations) {
    installRecoveryBarrier(reservation);
  }
  const reserved = reservations.length;
  if (reserved > 0) {
    log.warn(
      `reserved ${reserved} interrupted main session(s) in SQLite${params.reason ? ` (${params.reason})` : ""}`,
    );
  }
  return { reserved, skipped: 0 };
}

export type StaleLockRecoveryReservation =
  | { kind: "cleanup_only" }
  | { kind: "reserved"; publicRunId: string }
  | { kind: "preserve"; reason: string };

/** Reserve exact stale-lock evidence before the caller removes the lock. */
export async function reserveRestartAbortedMainSessionFromLock(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  sessionsDir: string;
  lock: Readonly<SessionLockInspection>;
}): Promise<StaleLockRecoveryReservation> {
  const lockPath = normalizeTranscriptLockPath(params.lock.lockPath);
  if (!lockPath || !params.lock.removable) {
    return { kind: "cleanup_only" };
  }
  const sessionsDir = path.resolve(params.sessionsDir);
  const storePath = resolveCanonicalSessionStorePath(path.join(sessionsDir, "sessions.json"));
  let store: Record<string, SessionEntry>;
  try {
    store = loadSessionStore(storePath, { skipCache: true });
  } catch (err) {
    return { kind: "preserve", reason: `session store unreadable: ${String(err)}` };
  }
  const matching = Object.entries(store).filter(
    ([sessionKey, entry]) =>
      entry?.status === "running" &&
      !shouldSkipMainRecovery(entry, sessionKey) &&
      resolveEntryTranscriptLockPaths({ entry, sessionsDir }).includes(lockPath),
  );
  if (matching.length === 0) {
    return { kind: "cleanup_only" };
  }
  const sessionIds = new Set(matching.map(([, entry]) => entry.sessionId));
  if (sessionIds.size !== 1) {
    return { kind: "preserve", reason: "stale lock maps to conflicting session identities" };
  }
  const [sessionKey, entry] = matching.toSorted(([left], [right]) => left.localeCompare(right))[0]!;
  const aliases = matching.map(([key]) => key).toSorted();
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  try {
    const result = await reserveEntry({
      agentId: path.basename(path.dirname(sessionsDir)),
      cfg: params.cfg,
      database: recoveryDatabase(params.stateDir),
      entry,
      evidence: {
        kind: "stale_lock",
        lockPath,
        pid: params.lock.pid,
        createdAt: params.lock.createdAt,
        staleReasons: [...params.lock.staleReasons].toSorted(),
      },
      lifecycleGeneration,
      sessionKey,
      sessionKeyAliases: aliases.filter((alias) => alias !== sessionKey),
      storePath,
    });
    return { kind: "reserved", publicRunId: result.recovery.publicRunId };
  } catch (err) {
    return { kind: "preserve", reason: String(err) };
  }
}
