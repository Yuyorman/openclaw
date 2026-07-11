/** Doctor-owned SQLite cutover for shipped JSON main-run restart recovery state. */
import type { SessionEntry } from "../config/sessions.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  fingerprintLegacyMainRunRecoveryEntry,
  fingerprintLegacyMainRunRecoveryTranscriptState,
  matchesImportedLegacyMainRunRecoveryAfterUpdatedAtDrift,
  readLegacyMainRunRecoveryTranscriptState,
  type LegacyMainRunRecoveryEntry,
  type LegacyMainRunRecoveryPlan,
} from "../infra/main-run-recovery-migration.js";
import { formatMainRunRecoveryDoctorHint } from "../infra/main-run-recovery-policy.js";
import type { SessionEntryLike } from "../infra/state-migrations.fs.js";
import {
  detectLegacyMainRunRecoveryMigrations,
  formatLegacyMainRunRecoveryMigrationBlocker,
  normalizeLegacyMainRunRecoveryEntry,
} from "../infra/state-migrations.js";
import {
  findLatestMainRunRecoveryBySession,
  insertOrVerifyImportedMainRunRecovery,
  type MainRunRecovery,
  type MainRunRecoveryTerminalOutcome,
} from "../state/main-run-recovery-store.js";

export type DoctorMainRunRecoveryMigrationResult = {
  changes: string[];
  warnings: string[];
};

type PlanApplicationResult =
  | { status: "migrated"; ledgerTerminal: boolean }
  | { status: "already-migrated" }
  | { status: "cas-mismatch" }
  | { status: "session-blocked"; recovery: MainRunRecovery };

function clearLegacyRecoveryOwnership(entry: SessionEntry): SessionEntry {
  const updated = structuredClone(entry);
  updated.abortedLastRun = false;
  const legacy = updated as LegacyMainRunRecoveryEntry;
  delete legacy.restartRecoveryRuns;
  updated.pendingFinalDelivery = undefined;
  updated.pendingFinalDeliveryCreatedAt = undefined;
  updated.pendingFinalDeliveryLastAttemptAt = undefined;
  updated.pendingFinalDeliveryAttemptCount = undefined;
  updated.pendingFinalDeliveryLastError = undefined;
  updated.pendingFinalDeliveryText = undefined;
  updated.pendingFinalDeliveryContext = undefined;
  updated.pendingFinalDeliveryIntentId = undefined;
  delete legacy.restartRecoveryDeliveryContext;
  delete legacy.restartRecoveryDeliveryRunId;
  return updated;
}

function terminalSessionStatus(
  outcome: MainRunRecoveryTerminalOutcome,
): NonNullable<SessionEntry["status"]> {
  switch (outcome.status) {
    case "done":
      return "done";
    case "timeout":
      return "timeout";
    case "killed":
    case "cancelled":
      return "killed";
    case "failed":
      return "failed";
  }
}

function terminalizeLegacyEntry(
  entry: SessionEntry,
  outcome: MainRunRecoveryTerminalOutcome,
): SessionEntry {
  const updated = clearLegacyRecoveryOwnership(entry);
  updated.status = terminalSessionStatus(outcome);
  updated.endedAt = outcome.endedAtMs;
  updated.updatedAt = Math.max(entry.updatedAt, outcome.endedAtMs);
  return updated;
}

function matchesExpectedEntries(
  plan: LegacyMainRunRecoveryPlan,
  entries: Array<{ sessionKey: string; entry: SessionEntry }>,
): boolean {
  if (entries.length !== plan.expectedEntries.length) {
    return false;
  }
  const expected = new Map(
    plan.expectedEntries.map((entry) => [entry.sessionKey, entry.sourceFingerprint]),
  );
  return entries.every(({ entry, sessionKey }) => {
    const legacyEntry = normalizeLegacyMainRunRecoveryEntry(entry as unknown as SessionEntryLike);
    return (
      legacyEntry?.sessionId === plan.sessionId &&
      expected.get(sessionKey) === fingerprintLegacyMainRunRecoveryEntry(legacyEntry)
    );
  });
}

async function applyPlan(params: {
  database: { env: NodeJS.ProcessEnv };
  now: () => number;
  plan: LegacyMainRunRecoveryPlan;
}): Promise<PlanApplicationResult> {
  return await applySessionEntryReplacements<PlanApplicationResult>({
    storePath: params.plan.storePath,
    sessionKeys: params.plan.expectedEntries.map(({ sessionKey }) => sessionKey),
    requireWriteSuccess: true,
    skipMaintenance: true,
    update: async (entries) => {
      if (!matchesExpectedEntries(params.plan, entries)) {
        return { result: { status: "cas-mismatch" } };
      }
      const transcriptEntry = entries.find(
        ({ sessionKey }) => sessionKey === params.plan.transcriptSessionKey,
      );
      if (!transcriptEntry) {
        return { result: { status: "cas-mismatch" } };
      }
      const transcriptState = await readLegacyMainRunRecoveryTranscriptState({
        entry: transcriptEntry.entry,
        storePath: params.plan.storePath,
      });
      if (
        fingerprintLegacyMainRunRecoveryTranscriptState(transcriptState) !==
        params.plan.transcriptStateFingerprint
      ) {
        return { result: { status: "cas-mismatch" } };
      }
      // SQLite becomes authoritative before JSON ownership is cleared. A file
      // save failure leaves an exact imported row that the next doctor run verifies.
      const latest = findLatestMainRunRecoveryBySession(params.plan.input, params.database);
      const reserved =
        latest && matchesImportedLegacyMainRunRecoveryAfterUpdatedAtDrift(params.plan, latest)
          ? ({ status: "duplicate", recovery: latest } as const)
          : insertOrVerifyImportedMainRunRecovery(params.plan.input, params.database);
      if (
        reserved.status === "session_blocked" &&
        !matchesImportedLegacyMainRunRecoveryAfterUpdatedAtDrift(params.plan, reserved.recovery)
      ) {
        return { result: { status: "session-blocked", recovery: reserved.recovery } };
      }
      const nowMs = Math.max(params.now(), reserved.recovery.acceptedAtMs);
      const terminalOutcome = reserved.recovery.terminalOutcome;
      const failedOutcome: MainRunRecoveryTerminalOutcome = {
        status: "failed",
        endedAtMs: nowMs,
      };
      const replacements = entries.map(({ entry, sessionKey }) => ({
        sessionKey,
        entry: terminalOutcome
          ? terminalizeLegacyEntry(entry, terminalOutcome)
          : params.plan.disposition.kind === "fail"
            ? terminalizeLegacyEntry(entry, failedOutcome)
            : clearLegacyRecoveryOwnership(entry),
      }));
      const sourceChanged = replacements.some(
        (replacement, index) =>
          JSON.stringify(replacement.entry) !== JSON.stringify(entries[index]?.entry),
      );
      if (reserved.status === "duplicate" && !sourceChanged) {
        return { result: { status: "already-migrated" } };
      }
      return {
        result: {
          status: "migrated",
          ledgerTerminal: Boolean(terminalOutcome),
        },
        ...(sourceChanged ? { replacements } : {}),
      };
    },
  });
}

export async function inspectDoctorMainRunRecovery(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<DoctorMainRunRecoveryMigrationResult> {
  const detection = await detectLegacyMainRunRecoveryMigrations(params);
  return {
    changes: [],
    warnings: [
      ...detection.blockers.map(formatLegacyMainRunRecoveryMigrationBlocker),
      ...detection.plans.map((plan) =>
        formatMainRunRecoveryDoctorHint({
          storePath: plan.storePath,
          sessionKey: plan.sessionKey,
          sessionId: plan.sessionId,
          reason: "Legacy main-run restart recovery requires SQLite migration",
        }),
      ),
    ],
  };
}

export async function migrateDoctorMainRunRecovery(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<DoctorMainRunRecoveryMigrationResult> {
  const detection = await detectLegacyMainRunRecoveryMigrations(params);
  const changes: string[] = [];
  const warnings = detection.blockers.map(formatLegacyMainRunRecoveryMigrationBlocker);
  const database = { env: params.env ?? process.env };
  const now = params.now ?? (() => Date.now());

  for (const plan of detection.plans) {
    try {
      const result = await applyPlan({ database, now, plan });
      if (result.status === "cas-mismatch") {
        warnings.push(
          `Legacy main-run restart recovery changed during migration at ${plan.storePath} key=${plan.sessionKey} sessionId=${plan.sessionId}; rerun openclaw doctor --fix`,
        );
        continue;
      }
      if (result.status === "session-blocked") {
        warnings.push(
          `Legacy main-run restart recovery at ${plan.storePath} key=${plan.sessionKey} sessionId=${plan.sessionId} conflicts with SQLite recovery ${result.recovery.publicRunId}; resolve it and rerun openclaw doctor --fix`,
        );
        continue;
      }
      if (result.status === "already-migrated") {
        continue;
      }
      const action = result.ledgerTerminal
        ? "Reconciled terminal"
        : plan.disposition.kind === "fail"
          ? "Migrated unresumable"
          : "Migrated";
      changes.push(
        `${action} legacy main-run restart recovery → SQLite (${plan.storePath} key=${plan.sessionKey} sessionId=${plan.sessionId})`,
      );
    } catch (err) {
      warnings.push(
        `Failed migrating legacy main-run restart recovery at ${plan.storePath} key=${plan.sessionKey} sessionId=${plan.sessionId}: ${String(err)}; rerun openclaw doctor --fix`,
      );
    }
  }
  return { changes, warnings };
}
