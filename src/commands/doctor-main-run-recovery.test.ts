import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  collectLegacyMainRunRecoveryAdmissionGate,
  findLegacyMainRunRecoveryAdmissionBlocker,
} from "../infra/main-run-recovery-admission-gate.js";
import type { LegacyMainRunRecoveryEntry } from "../infra/main-run-recovery-migration.js";
import { detectLegacyMainRunRecoveryMigrations } from "../infra/state-migrations.js";
import { buildPersistedUserTurnMessage } from "../sessions/user-turn-transcript.js";
import {
  fingerprintMainRunRecoverySource,
  getMainRunRecoveryBySource,
  insertOrVerifyImportedMainRunRecovery,
  reserveMainRunRecovery,
  terminalizeMainRunRecovery,
} from "../state/main-run-recovery-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

const { migrateDoctorMainRunRecovery } = await import("./doctor-main-run-recovery.js");

const tempDirs: string[] = [];

function createFixture(entry: SessionEntry, aliases: string[] = ["agent:main:main"]) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-main-recovery-"));
  tempDirs.push(stateDir);
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const storePath = path.join(sessionsDir, "sessions.json");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    storePath,
    `${JSON.stringify(Object.fromEntries(aliases.map((key) => [key, entry])), null, 2)}\n`,
  );
  const env = { OPENCLAW_STATE_DIR: stateDir };
  return { cfg: {}, env, stateDir, storePath };
}

function readEntry(storePath: string, sessionKey = "agent:main:main"): SessionEntry {
  return JSON.parse(fs.readFileSync(storePath, "utf8"))[sessionKey] as SessionEntry;
}

function writeStaleTranscriptLock(params: { stateDir: string; sessionId: string }): string {
  const sessionsDir = path.join(params.stateDir, "agents", "main", "sessions");
  const transcriptPath = path.join(sessionsDir, `${params.sessionId}.jsonl`);
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      id: "user-before-crash",
      message: { role: "user", content: "finish the interrupted work" },
    })}\n`,
  );
  const lockPath = `${transcriptPath}.lock`;
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 2_147_483_647,
      createdAt: "2020-01-01T00:00:00.000Z",
      starttime: 1,
    }),
  );
  return lockPath;
}

function recoveryEntry(
  overrides: Partial<LegacyMainRunRecoveryEntry> = {},
): LegacyMainRunRecoveryEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1234,
    status: "running",
    abortedLastRun: true,
    lifecycleRevision: "revision-1",
    ...overrides,
  };
}

function reserveExactRecovery(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  storePath: string;
  runId: string;
}) {
  const identity = {
    agentId: params.agentId,
    sessionKey: `agent:${params.agentId}:main`,
    sessionKeyAliases: params.agentId === "main" ? ["main"] : [],
    sessionId: params.sessionId,
    storePath: params.storePath,
  };
  const approvedTurn = buildPersistedUserTurnMessage({
    text: "continue after restart",
    timestamp: 1200,
    idempotencyKey: `${params.runId}:user`,
  });
  const envelope = { kind: "exact_turn" as const, approvedTurn };
  const ownerPrincipal = { kind: "system" as const };
  const authorization = { senderIsOwner: true };
  const sourceKey = approvedTurn.idempotencyKey;
  return reserveMainRunRecovery(
    {
      ...identity,
      publicRunId: params.runId,
      sourceKey,
      sourceFingerprint: fingerprintMainRunRecoverySource({
        sourceKey,
        identity,
        envelope,
        ownerPrincipal,
        authorization,
      }),
      bootId: "boot-before-restart",
      ownerPrincipal,
      authorization,
      envelope,
      initialLease: { owner: "doctor-test-admission", expiresAtMs: 1300 },
      acceptedAtMs: 1200,
    },
    { env: params.env },
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("doctor main-run recovery migration", () => {
  it("normalizes retired recovery fields only at the Doctor boundary", async () => {
    const entry = recoveryEntry() as unknown as Record<string, unknown>;
    entry.restartRecoveryRuns = [
      { runId: " run-1 ", lifecycleGeneration: " generation-1 " },
      { runId: "", lifecycleGeneration: "generation-empty" },
    ];
    entry.restartRecoveryDeliveryRunId = 42;
    entry.restartRecoveryDeliveryContext = ["invalid"];
    const fixture = createFixture(entry as SessionEntry);

    const detected = await detectLegacyMainRunRecoveryMigrations(fixture);

    expect(detected.blockers).toEqual([]);
    expect(detected.plans).toHaveLength(1);
    expect(detected.plans[0]?.input.envelope).toMatchObject({
      kind: "session_resume",
      delivery: { context: null, runId: null },
      fences: [{ runId: "run-1", lifecycleGeneration: "generation-1" }],
    });
    await expect(migrateDoctorMainRunRecovery(fixture)).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated")],
      warnings: [],
    });
  });

  it("uses a deterministic epoch when legacy updatedAt is missing", async () => {
    const entry = recoveryEntry() as unknown as Record<string, unknown>;
    delete entry.updatedAt;
    const fixture = createFixture(entry as SessionEntry);

    const first = await detectLegacyMainRunRecoveryMigrations(fixture);
    const second = await detectLegacyMainRunRecoveryMigrations(fixture);

    expect(first.plans[0]?.input.acceptedAtMs).toBe(0);
    expect(second.plans[0]?.sourceKey).toBe(first.plans[0]?.sourceKey);
  });

  it("imports a stale-lock hard crash without requiring abortedLastRun", async () => {
    const fixture = createFixture(recoveryEntry({ abortedLastRun: false }));
    const lockPath = writeStaleTranscriptLock({
      stateDir: fixture.stateDir,
      sessionId: "session-1",
    });

    const detected = await detectLegacyMainRunRecoveryMigrations(fixture);
    expect(detected.blockers).toEqual([]);
    expect(detected.plans).toHaveLength(1);
    expect(detected.plans[0]).toMatchObject({
      disposition: { kind: "resume" },
      staleTranscriptLockPaths: [lockPath],
    });
    const startupGate = await collectLegacyMainRunRecoveryAdmissionGate(fixture);
    expect(
      findLegacyMainRunRecoveryAdmissionBlocker(startupGate, {
        storePath: fixture.storePath,
        sessionId: "session-1",
        entry: readEntry(fixture.storePath),
      }),
    ).toMatchObject({
      reason: "legacy-json-recovery-not-converged",
      staleTranscriptLockPaths: [lockPath],
    });

    await expect(
      migrateDoctorMainRunRecovery({ ...fixture, now: () => 2000 }),
    ).resolves.toMatchObject({ changes: [expect.stringContaining("Migrated")], warnings: [] });
    expect(readEntry(fixture.storePath)).toMatchObject({
      status: "running",
      abortedLastRun: false,
    });
    expect(fs.existsSync(lockPath)).toBe(true);
    // The cached startup gate observes Doctor's exact DB-first import without
    // waiting for the generic stale-lock cleanup or a gateway restart.
    expect(
      findLegacyMainRunRecoveryAdmissionBlocker(startupGate, {
        storePath: fixture.storePath,
        sessionId: "session-1",
        entry: readEntry(fixture.storePath),
      }),
    ).toBeUndefined();
    await expect(collectLegacyMainRunRecoveryAdmissionGate(fixture)).resolves.toEqual({
      blockedSessions: [],
      storeBlockers: [],
    });
  });

  it("keeps legacy migration blocked behind an unrelated active exact turn", async () => {
    const fixture = createFixture(recoveryEntry());
    reserveExactRecovery({
      agentId: "main",
      env: fixture.env,
      sessionId: "session-1",
      storePath: fixture.storePath,
      runId: "00000000-0000-4000-8000-000000000101",
    });

    for (let restart = 0; restart < 3; restart += 1) {
      await expect(collectLegacyMainRunRecoveryAdmissionGate(fixture)).resolves.toMatchObject({
        blockedSessions: [
          {
            storePath: fixture.storePath,
            sessionId: "session-1",
            reason: "legacy-json-recovery-not-converged",
          },
        ],
        storeBlockers: [],
      });
      expect(readEntry(fixture.storePath)).toMatchObject({
        sessionId: "session-1",
        status: "running",
        abortedLastRun: true,
      });
    }
  });

  it("does not release a cached startup gate from JSON cleanup without the exact SQLite row", async () => {
    const fixture = createFixture(recoveryEntry());
    const startupGate = await collectLegacyMainRunRecoveryAdmissionGate(fixture);
    const store = JSON.parse(fs.readFileSync(fixture.storePath, "utf8")) as Record<
      string,
      SessionEntry
    >;
    const entry = store["agent:main:main"];
    if (!entry) {
      throw new Error("expected legacy session entry");
    }
    entry.abortedLastRun = false;
    fs.writeFileSync(fixture.storePath, `${JSON.stringify(store, null, 2)}\n`);

    expect(
      findLegacyMainRunRecoveryAdmissionBlocker(startupGate, {
        storePath: fixture.storePath,
        sessionId: entry.sessionId,
        entry,
      }),
    ).toMatchObject({ reason: "legacy-json-recovery-not-converged" });
  });

  it("keeps stale JSON blocked when SQLite ownership has a different agent", async () => {
    const fixture = createFixture(recoveryEntry());
    reserveExactRecovery({
      agentId: "other",
      env: fixture.env,
      sessionId: "session-1",
      storePath: fixture.storePath,
      runId: "00000000-0000-4000-8000-000000000102",
    });

    await expect(collectLegacyMainRunRecoveryAdmissionGate(fixture)).resolves.toMatchObject({
      blockedSessions: [
        {
          storePath: fixture.storePath,
          sessionId: "session-1",
          reason: "legacy-json-recovery-not-converged",
        },
      ],
      storeBlockers: [],
    });
  });

  it("does not partially import a session with an ambiguously owned alias", async () => {
    const fixture = createFixture(recoveryEntry(), ["agent:main:main", "main"]);
    const detection = await detectLegacyMainRunRecoveryMigrations({
      ...fixture,
      cfg: {
        agents: { list: [{ id: "main" }, { id: "other" }] },
        session: { store: fixture.storePath },
      },
    });

    expect(detection.plans).toEqual([]);
    expect(detection.blockers).toContainEqual(
      expect.objectContaining({
        reason: "ambiguous-session-owner",
        sessionKey: "main",
        sessionId: "session-1",
      }),
    );
  });

  it("commits one unprivileged SQLite owner before clearing every JSON ownership signal", async () => {
    const fixture = createFixture(
      recoveryEntry({
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "captured reply",
        pendingFinalDeliveryIntentId: "intent-1",
        restartRecoveryDeliveryRunId: "delivery-run-1",
        restartRecoveryRuns: [{ runId: "run-1", lifecycleGeneration: "generation-1" }],
      }),
      ["agent:main:main", "main"],
    );
    const detected = await detectLegacyMainRunRecoveryMigrations(fixture);
    expect(detected.plans).toHaveLength(1);
    const gate = await collectLegacyMainRunRecoveryAdmissionGate(fixture);
    expect(gate).toMatchObject({
      blockedSessions: [
        {
          storePath: fixture.storePath,
          sessionId: "session-1",
          sessionKeys: ["agent:main:main", "main"],
          reason: "legacy-json-recovery-not-converged",
          doctorHint: expect.stringContaining("openclaw doctor --fix"),
        },
      ],
      storeBlockers: [],
    });
    expect(
      findLegacyMainRunRecoveryAdmissionBlocker(gate, {
        storePath: fixture.storePath,
        sessionId: "session-1",
      }),
    ).toMatchObject({
      reason: "legacy-json-recovery-not-converged",
      sessionId: "session-1",
    });
    expect(
      findLegacyMainRunRecoveryAdmissionBlocker(gate, {
        storePath: fixture.storePath,
        sessionId: "unrelated-session",
      }),
    ).toBeUndefined();

    const result = await migrateDoctorMainRunRecovery({ ...fixture, now: () => 2000 });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    for (const sessionKey of ["agent:main:main", "main"]) {
      expect(readEntry(fixture.storePath, sessionKey)).toMatchObject({
        status: "running",
        abortedLastRun: false,
      });
      expect(readEntry(fixture.storePath, sessionKey)).not.toHaveProperty("restartRecoveryRuns");
      expect(readEntry(fixture.storePath, sessionKey)).not.toHaveProperty("pendingFinalDelivery");
      expect(readEntry(fixture.storePath, sessionKey)).not.toHaveProperty(
        "pendingFinalDeliveryText",
      );
      expect(readEntry(fixture.storePath, sessionKey)).not.toHaveProperty(
        "restartRecoveryDeliveryRunId",
      );
    }
    const plan = detected.plans[0];
    if (!plan) {
      throw new Error("expected migration plan");
    }
    expect(
      getMainRunRecoveryBySource(
        { kind: "session_resume", sourceKey: plan.sourceKey },
        { env: fixture.env },
      ),
    ).toMatchObject({
      kind: "session_resume",
      state: "recovery_pending",
      authorization: { senderIsOwner: false },
      sessionId: "session-1",
      sessionKeyAliases: ["main"],
    });
    await expect(collectLegacyMainRunRecoveryAdmissionGate(fixture)).resolves.toEqual({
      blockedSessions: [],
      storeBlockers: [],
    });
    await expect(migrateDoctorMainRunRecovery(fixture)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("imports an unresumable failure as due work and clears JSON ownership", async () => {
    const fixture = createFixture(recoveryEntry());
    const detected = await detectLegacyMainRunRecoveryMigrations(fixture);
    const plan = detected.plans[0];
    if (!plan) {
      throw new Error("expected migration plan");
    }
    const result = await migrateDoctorMainRunRecovery({ ...fixture, now: () => 2000 });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(readEntry(fixture.storePath)).toMatchObject({
      status: "failed",
      abortedLastRun: false,
      endedAt: 2000,
      updatedAt: 2000,
    });
    await expect(collectLegacyMainRunRecoveryAdmissionGate(fixture)).resolves.toEqual({
      blockedSessions: [],
      storeBlockers: [],
    });
    expect(
      getMainRunRecoveryBySource(
        { kind: "session_resume", sourceKey: plan.sourceKey },
        { env: fixture.env },
      ),
    ).toMatchObject({
      kind: "session_resume",
      state: "recovery_pending",
      envelope: { resolution: { kind: "fail", code: "unresumable-tail" } },
      authorization: { senderIsOwner: false },
    });
    await expect(migrateDoctorMainRunRecovery(fixture)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("reconciles an imported markerless row after updatedAt-only drift", async () => {
    const fixture = createFixture(recoveryEntry({ lifecycleRevision: undefined }));
    const firstDetection = await detectLegacyMainRunRecoveryMigrations(fixture);
    const firstPlan = firstDetection.plans[0];
    if (!firstPlan) {
      throw new Error("expected initial migration plan");
    }
    expect(firstPlan.usesUpdatedAtFallback).toBe(true);
    expect(
      insertOrVerifyImportedMainRunRecovery(firstPlan.input, { env: fixture.env }).status,
    ).toBe("inserted");

    const store = JSON.parse(fs.readFileSync(fixture.storePath, "utf8")) as Record<
      string,
      SessionEntry
    >;
    const entry = store["agent:main:main"];
    if (!entry) {
      throw new Error("expected legacy session entry");
    }
    entry.updatedAt = 2500;
    fs.writeFileSync(fixture.storePath, `${JSON.stringify(store, null, 2)}\n`);

    const driftedDetection = await detectLegacyMainRunRecoveryMigrations(fixture);
    const driftedPlan = driftedDetection.plans[0];
    if (!driftedPlan) {
      throw new Error("expected drifted migration plan");
    }
    expect(driftedPlan.sourceKey).not.toBe(firstPlan.sourceKey);

    await expect(
      migrateDoctorMainRunRecovery({ ...fixture, now: () => 2000 }),
    ).resolves.toMatchObject({ changes: [expect.stringContaining("Migrated")], warnings: [] });
    expect(readEntry(fixture.storePath)).toMatchObject({
      status: "failed",
      abortedLastRun: false,
      updatedAt: 2500,
    });
    expect(
      getMainRunRecoveryBySource(
        { kind: "session_resume", sourceKey: firstPlan.sourceKey },
        { env: fixture.env },
      ),
    ).toMatchObject({ state: "recovery_pending", acceptedAtMs: 1234 });
    expect(
      getMainRunRecoveryBySource(
        { kind: "session_resume", sourceKey: driftedPlan.sourceKey },
        { env: fixture.env },
      ),
    ).toBeUndefined();
  });

  it("reconciles JSON drift before a delayed ledger terminal commit", async () => {
    const fixture = createFixture(recoveryEntry({ lifecycleRevision: undefined }));
    const firstDetection = await detectLegacyMainRunRecoveryMigrations(fixture);
    const firstPlan = firstDetection.plans[0];
    if (!firstPlan) {
      throw new Error("expected initial migration plan");
    }
    const imported = insertOrVerifyImportedMainRunRecovery(firstPlan.input, {
      env: fixture.env,
    });
    if (imported.status === "session_blocked") {
      throw new Error("expected imported recovery owner");
    }
    const store = JSON.parse(fs.readFileSync(fixture.storePath, "utf8")) as Record<
      string,
      SessionEntry
    >;
    const entry = store["agent:main:main"];
    if (!entry) {
      throw new Error("expected legacy session entry");
    }
    entry.updatedAt = 1500;
    fs.writeFileSync(fixture.storePath, `${JSON.stringify(store, null, 2)}\n`);

    expect(
      terminalizeMainRunRecovery(
        {
          agentId: imported.recovery.agentId,
          sessionKey: imported.recovery.sessionKey,
          sessionKeyAliases: imported.recovery.sessionKeyAliases,
          sessionId: imported.recovery.sessionId,
          storePath: imported.recovery.storePath,
          publicRunId: imported.recovery.publicRunId,
          expectedRevision: imported.recovery.revision,
          expectedState: "recovery_pending",
          outcome: { status: "failed", endedAtMs: 1400 },
          nowMs: 1800,
        },
        { env: fixture.env },
      ),
    ).toMatchObject({ state: "terminal" });

    await expect(
      migrateDoctorMainRunRecovery({ ...fixture, now: () => 2000 }),
    ).resolves.toMatchObject({
      changes: [expect.stringContaining("Reconciled terminal")],
      warnings: [],
    });
    expect(readEntry(fixture.storePath)).toMatchObject({
      status: "failed",
      abortedLastRun: false,
      endedAt: 1400,
      updatedAt: 1500,
    });
  });

  it("imports markerless work newer than the previous terminal incident", async () => {
    const fixture = createFixture(recoveryEntry({ lifecycleRevision: undefined }));
    const firstDetection = await detectLegacyMainRunRecoveryMigrations(fixture);
    const firstPlan = firstDetection.plans[0];
    if (!firstPlan) {
      throw new Error("expected initial migration plan");
    }
    const imported = insertOrVerifyImportedMainRunRecovery(firstPlan.input, {
      env: fixture.env,
    });
    if (imported.status === "session_blocked") {
      throw new Error("expected imported recovery owner");
    }
    expect(
      terminalizeMainRunRecovery(
        {
          agentId: imported.recovery.agentId,
          sessionKey: imported.recovery.sessionKey,
          sessionKeyAliases: imported.recovery.sessionKeyAliases,
          sessionId: imported.recovery.sessionId,
          storePath: imported.recovery.storePath,
          publicRunId: imported.recovery.publicRunId,
          expectedRevision: imported.recovery.revision,
          expectedState: "recovery_pending",
          outcome: { status: "failed", endedAtMs: 1400 },
          nowMs: 1800,
        },
        { env: fixture.env },
      ),
    ).toMatchObject({ state: "terminal" });

    const store = JSON.parse(fs.readFileSync(fixture.storePath, "utf8")) as Record<
      string,
      SessionEntry
    >;
    const entry = store["agent:main:main"];
    if (!entry) {
      throw new Error("expected legacy session entry");
    }
    entry.updatedAt = 2500;
    fs.writeFileSync(fixture.storePath, `${JSON.stringify(store, null, 2)}\n`);
    const nextDetection = await detectLegacyMainRunRecoveryMigrations(fixture);
    const nextPlan = nextDetection.plans[0];
    if (!nextPlan) {
      throw new Error("expected next incident migration plan");
    }

    await expect(
      migrateDoctorMainRunRecovery({ ...fixture, now: () => 3000 }),
    ).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated unresumable")],
      warnings: [],
    });
    expect(
      getMainRunRecoveryBySource(
        { kind: "session_resume", sourceKey: firstPlan.sourceKey },
        { env: fixture.env },
      ),
    ).toMatchObject({ state: "terminal" });
    expect(
      getMainRunRecoveryBySource(
        { kind: "session_resume", sourceKey: nextPlan.sourceKey },
        { env: fixture.env },
      ),
    ).toMatchObject({ state: "recovery_pending", acceptedAtMs: 2500 });
  });
});
