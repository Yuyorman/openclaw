/** Pure session-scoped admission blockers for legacy JSON recovery ownership. */
import type { SessionEntry } from "../config/sessions.js";
import { resolveCanonicalSessionStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  findActiveMainRunRecoveryBySession,
  getMainRunRecovery,
} from "../state/main-run-recovery-store.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { matchesImportedLegacyMainRunRecoveryAfterUpdatedAtDrift } from "./main-run-recovery-migration.js";
import { formatMainRunRecoveryDoctorHint } from "./main-run-recovery-policy.js";
import {
  detectLegacyMainRunRecoveryMigrations,
  type LegacyMainRunRecoveryMigrationBlocker,
} from "./state-migrations.js";

export type LegacyMainRunRecoverySessionAdmissionBlocker = {
  agentId?: string;
  storePath: string;
  sessionId: string;
  sessionKeys: readonly string[];
  publicRunId?: string;
  sourceFingerprint?: string;
  sourceKey?: string;
  staleTranscriptLockPaths?: readonly string[];
  reason: "legacy-json-recovery-not-converged";
  doctorHint: string;
};

export type LegacyMainRunRecoveryStoreAdmissionBlocker = LegacyMainRunRecoveryMigrationBlocker & {
  doctorHint: string;
};

export type LegacyMainRunRecoveryAdmissionGate = {
  blockedSessions: LegacyMainRunRecoverySessionAdmissionBlocker[];
  storeBlockers: LegacyMainRunRecoveryStoreAdmissionBlocker[];
};

export type LegacyMainRunRecoveryAdmissionBlocker =
  | LegacyMainRunRecoverySessionAdmissionBlocker
  | LegacyMainRunRecoveryStoreAdmissionBlocker;

const gateDatabaseOptions = new WeakMap<
  LegacyMainRunRecoveryAdmissionGate,
  OpenClawStateDatabaseOptions
>();

function canonicalStorePath(storePath: string): string | undefined {
  try {
    return resolveCanonicalSessionStorePath(storePath);
  } catch {
    return undefined;
  }
}

export function findLegacyMainRunRecoveryAdmissionBlocker(
  gate: LegacyMainRunRecoveryAdmissionGate,
  target: {
    storePath: string;
    sessionId?: string;
    sessionKey?: string;
    entry?: Pick<SessionEntry, "abortedLastRun" | "status">;
  },
): LegacyMainRunRecoveryAdmissionBlocker | undefined {
  const targetStorePath = canonicalStorePath(target.storePath);
  if (!targetStorePath) {
    return gate.storeBlockers.find((blocker) => blocker.storePath === target.storePath);
  }
  const sessionBlocker = gate.blockedSessions.find((blocker) => {
    if (canonicalStorePath(blocker.storePath) !== targetStorePath) {
      return false;
    }
    if (target.sessionId) {
      return blocker.sessionId === target.sessionId;
    }
    return Boolean(target.sessionKey && blocker.sessionKeys.includes(target.sessionKey));
  });
  if (sessionBlocker) {
    // Doctor commits SQLite first. Revalidate that exact imported incident so a
    // live repair can release this cached startup gate without losing a stale
    // lock-only crash marker when its lock file is cleaned concurrently.
    if (
      sessionBlocker.agentId &&
      sessionBlocker.publicRunId &&
      sessionBlocker.sourceKey &&
      sessionBlocker.sourceFingerprint
    ) {
      try {
        const recovery = getMainRunRecovery(
          sessionBlocker.publicRunId,
          gateDatabaseOptions.get(gate),
        );
        if (
          recovery &&
          recovery.agentId === sessionBlocker.agentId &&
          canonicalStorePath(recovery.storePath) === targetStorePath &&
          recovery.sessionId === sessionBlocker.sessionId &&
          recovery.sourceKey === sessionBlocker.sourceKey &&
          recovery.sourceFingerprint === sessionBlocker.sourceFingerprint
        ) {
          return undefined;
        }
      } catch {
        return sessionBlocker;
      }
      return sessionBlocker;
    }
    // Marker-only legacy ownership can also be revalidated from the loaded
    // entry. Lock-only evidence has no JSON bit, so it remains blocked until
    // the exact SQLite import above exists.
    if (
      !sessionBlocker.staleTranscriptLockPaths?.length &&
      target.entry &&
      !(target.entry.status === "running" && target.entry.abortedLastRun === true)
    ) {
      return undefined;
    }
    return sessionBlocker;
  }
  return gate.storeBlockers.find((blocker) => {
    const blockerStorePath = canonicalStorePath(blocker.storePath);
    return blockerStorePath
      ? blockerStorePath === targetStorePath
      : blocker.storePath === target.storePath;
  });
}

export async function collectLegacyMainRunRecoveryAdmissionGate(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyMainRunRecoveryAdmissionGate> {
  const detection = await detectLegacyMainRunRecoveryMigrations(params);
  const blockedSessions: LegacyMainRunRecoverySessionAdmissionBlocker[] = [];
  const database = params.env ? { env: params.env } : {};
  for (const plan of detection.plans) {
    let sqliteOwnsPhysicalSession = false;
    try {
      const exact = getMainRunRecovery(plan.publicRunId, database);
      const exactIncidentExists = Boolean(
        exact &&
        exact.agentId === plan.agentId &&
        exact.sessionId === plan.sessionId &&
        canonicalStorePath(exact.storePath) === canonicalStorePath(plan.storePath) &&
        exact.sourceKey === plan.sourceKey &&
        exact.sourceFingerprint === plan.sourceFingerprint,
      );
      const active = findActiveMainRunRecoveryBySession(
        {
          agentId: plan.agentId,
          sessionKey: plan.sessionKey,
          sessionKeyAliases: plan.sessionKeyAliases,
          sessionId: plan.sessionId,
          storePath: plan.storePath,
        },
        database,
      );
      sqliteOwnsPhysicalSession =
        exactIncidentExists ||
        Boolean(active && matchesImportedLegacyMainRunRecoveryAfterUpdatedAtDrift(plan, active));
    } catch {
      // Fail closed. Doctor remains the only writer that can converge an
      // ambiguous or unreadable legacy ownership marker.
    }
    if (sqliteOwnsPhysicalSession) {
      continue;
    }
    blockedSessions.push({
      agentId: plan.agentId,
      storePath: plan.storePath,
      sessionId: plan.sessionId,
      sessionKeys: [plan.sessionKey, ...plan.sessionKeyAliases].toSorted(),
      publicRunId: plan.publicRunId,
      sourceKey: plan.sourceKey,
      sourceFingerprint: plan.sourceFingerprint,
      staleTranscriptLockPaths: plan.staleTranscriptLockPaths,
      reason: "legacy-json-recovery-not-converged",
      doctorHint: formatMainRunRecoveryDoctorHint({
        storePath: plan.storePath,
        sessionKey: plan.sessionKey,
        sessionId: plan.sessionId,
        reason: "Legacy main-run restart recovery is not converged",
      }),
    });
  }
  const gate = {
    blockedSessions,
    storeBlockers: detection.blockers.map((blocker) => ({
      ...blocker,
      doctorHint: formatMainRunRecoveryDoctorHint({
        storePath: blocker.storePath,
        sessionKey: blocker.sessionKey,
        sessionId: blocker.sessionId,
        reason: `Legacy main-run restart recovery is not migrated (${blocker.reason})`,
      }),
    })),
  };
  gateDatabaseOptions.set(gate, database);
  return gate;
}
