import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearCanonicalSessionStorePathCache } from "../config/sessions/paths.js";
import {
  beginSessionWorkAdmission,
  isSessionWorkAdmissionActive,
  SessionWorkAdmissionBlockedError,
} from "../sessions/session-lifecycle-admission.js";
import {
  claimMainRunRecoveryLease,
  getMainRunRecovery,
  MAIN_RUN_RECOVERY_LEASE_MS,
  recordMainRunRecoveryTerminalEvidenceCas,
  requestMainRunRecoveryCancellation,
  reserveMainSessionResumeRecovery,
  terminalizeMainRunRecoveryCancellation,
  type MainRunRecovery,
} from "../state/main-run-recovery-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  clearMainRunRecoveryRuntimeForTest,
  createMainRunRecoveryCancellationSettlementToken,
  createMainRunRecoveryExecutionOwner,
  discardMainRunRecoveryDispatch,
  getMainRunRecoveryBarrier,
  getMainRunRecoveryBarrierByLedgerRunId,
  isMainRunRecoveryLifecycleFenced,
  listMainRunRecoveryBarriers,
  MainRunRecoveryOwnershipLostError,
  markMainRunRecoveryDispatchAdmitted,
  onMainRunRecoveryDispatchStarted,
  prepareMainRunRecoveryDispatch,
  registerMainRunRecoveryTerminalEvidencePending,
  releaseMainRunRecoveryBarrier,
  resolveMainRunRecoveryTerminalEvidencePending,
  settleMainRunRecoveryCancellation,
  takeMainRunRecoveryDispatch,
  upsertMainRunRecoveryBarrier,
  waitForMainRunRecoveryDispatchAdoption,
} from "./main-run-recovery-runtime.js";

const tempDirs: string[] = [];

function durableRecoveryFixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "main-run-recovery-runtime-"));
  tempDirs.push(stateDir);
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  fs.writeFileSync(storePath, "{}");
  const database = { path: path.join(stateDir, "state", "openclaw.sqlite") };
  const nowMs = Date.now();
  const reserved = reserveMainSessionResumeRecovery(
    {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionKeyAliases: ["global"],
      sessionId: "session-1",
      storePath,
      sourceKey: "source-1",
      bootId: "boot-before-recovery",
      envelope: {
        kind: "session_resume",
        resolution: { kind: "resume" },
        systemMessage: "resume this session",
        transcriptTail: null,
        lifecycleRevision: null,
        delivery: { context: null, runId: null, intentId: null },
        fences: [],
      },
      acceptedAtMs: nowMs - 1_000,
    },
    database,
  ).recovery;
  if (reserved.state === "terminal") {
    throw new Error("unexpected terminal recovery fixture");
  }
  const recovery = claimMainRunRecoveryLease(
    {
      agentId: reserved.agentId,
      sessionKey: reserved.sessionKey,
      sessionKeyAliases: reserved.sessionKeyAliases,
      sessionId: reserved.sessionId,
      storePath: reserved.storePath,
      publicRunId: reserved.publicRunId,
      expectedRevision: reserved.revision,
      expectedState: reserved.state,
      leaseOwner: "worker-1",
      currentBootId: "boot-current",
      nowMs,
      leaseDurationMs: MAIN_RUN_RECOVERY_LEASE_MS,
    },
    database,
  );
  if (!recovery) {
    throw new Error("failed to claim recovery fixture");
  }
  const barrier = upsertMainRunRecoveryBarrier({
    aliases: [recovery.sessionKey, ...recovery.sessionKeyAliases],
    ledgerRunId: recovery.publicRunId,
    sessionId: recovery.sessionId,
    storePath: recovery.storePath,
  });
  return { barrier, database, recovery };
}

function prepareFixtureDispatch(
  fixture: ReturnType<typeof durableRecoveryFixture>,
  dispatchRunId = "dispatch-1",
) {
  return prepareMainRunRecoveryDispatch({
    currentBootId: "boot-current",
    database: fixture.database,
    dispatchRunId,
    recovery: fixture.recovery,
  });
}

function takeFixtureDispatch(
  fixture: ReturnType<typeof durableRecoveryFixture>,
  dispatchRunId = "dispatch-1",
) {
  return takeMainRunRecoveryDispatch({
    agentId: fixture.recovery.agentId,
    dispatchRunId,
    message: "resume this session",
    sessionKey: fixture.recovery.sessionKey,
  });
}

function reclaimFixtureRecovery(
  fixture: ReturnType<typeof durableRecoveryFixture>,
  leaseOwner = "worker-2",
): MainRunRecovery {
  const current = getMainRunRecovery(fixture.recovery.publicRunId, fixture.database);
  if (!current || current.state === "terminal") {
    throw new Error("missing recoverable fixture row");
  }
  const nowMs = Date.now();
  const recovery = claimMainRunRecoveryLease(
    {
      agentId: current.agentId,
      sessionKey: current.sessionKey,
      sessionKeyAliases: current.sessionKeyAliases,
      sessionId: current.sessionId,
      storePath: current.storePath,
      publicRunId: current.publicRunId,
      expectedRevision: current.revision,
      expectedState: current.state,
      leaseOwner,
      currentBootId: "boot-current",
      nowMs,
      leaseDurationMs: MAIN_RUN_RECOVERY_LEASE_MS,
    },
    fixture.database,
  );
  if (!recovery) {
    throw new Error("failed to reclaim recovery fixture");
  }
  return recovery;
}

function withRecovery(
  fixture: ReturnType<typeof durableRecoveryFixture>,
  recovery: MainRunRecovery,
): ReturnType<typeof durableRecoveryFixture> {
  return {
    ...fixture,
    recovery,
  };
}

describe("main-run recovery runtime", () => {
  afterEach(() => {
    clearMainRunRecoveryRuntimeForTest();
    closeOpenClawStateDatabaseForTest();
    clearCanonicalSessionStorePathCache();
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps one barrier generation for a physical session", async () => {
    const first = upsertMainRunRecoveryBarrier({
      aliases: ["agent:main:main"],
      ledgerRunId: "ledger-1",
      sessionId: "session-1",
      storePath: "/tmp/main-run-recovery-runtime/sessions.json",
    });
    const second = upsertMainRunRecoveryBarrier({
      aliases: ["agent:main:main"],
      ledgerRunId: "ledger-1",
      sessionId: "session-1",
      storePath: "/tmp/main-run-recovery-runtime/sessions.json",
    });

    expect(second).toEqual(first);
    expect(getMainRunRecoveryBarrierByLedgerRunId("ledger-1")).toEqual(first);
    await expect(
      beginSessionWorkAdmission({
        scope: first.storePath,
        identities: ["agent:main:main", "session-1"],
        assertAllowed: () => {},
      }),
    ).rejects.toBeInstanceOf(SessionWorkAdmissionBlockedError);
    expect(
      releaseMainRunRecoveryBarrier({
        expectedLedgerRunId: "other-ledger",
        sessionId: "session-1",
        storePath: first.storePath,
      }),
    ).toBe(false);
    expect(
      releaseMainRunRecoveryBarrier({
        expectedLedgerRunId: "ledger-1",
        sessionId: "session-1",
        storePath: first.storePath,
      }),
    ).toBe(true);
  });

  it("fails closed when a ledger id is rebound to another physical session", () => {
    const first = upsertMainRunRecoveryBarrier({
      aliases: ["agent:main:main"],
      ledgerRunId: "ledger-1",
      sessionId: "session-1",
      storePath: "/tmp/main-run-recovery-runtime/sessions.json",
    });
    expect(() =>
      upsertMainRunRecoveryBarrier({
        aliases: ["agent:main:main"],
        ledgerRunId: "ledger-1",
        sessionId: "session-2",
        storePath: first.storePath,
      }),
    ).toThrow("main-run recovery ledger already owns another session barrier");

    expect(listMainRunRecoveryBarriers()).toEqual([first]);
    expect(
      getMainRunRecoveryBarrier({ sessionId: first.sessionId, storePath: first.storePath }),
    ).toEqual(first);
    expect(
      getMainRunRecoveryBarrier({ sessionId: "session-2", storePath: first.storePath }),
    ).toBeUndefined();
    expect(getMainRunRecoveryBarrierByLedgerRunId("ledger-1")).toEqual(first);
  });

  it("replaces stale dispatch grants and consumes one exact capability", async () => {
    const fixture = durableRecoveryFixture();
    const { barrier } = fixture;
    const claim = prepareFixtureDispatch(fixture);

    expect(
      takeMainRunRecoveryDispatch({
        agentId: "main",
        dispatchRunId: "dispatch-1",
        message: "different turn",
        sessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
    expect(
      takeMainRunRecoveryDispatch({
        agentId: "other",
        dispatchRunId: "dispatch-1",
        message: "resume this session",
        sessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
    const replacement = prepareMainRunRecoveryDispatch({
      currentBootId: "boot-current",
      database: fixture.database,
      dispatchRunId: "dispatch-2",
      recovery: fixture.recovery,
    });
    await expect(
      beginSessionWorkAdmission({
        scope: barrier.storePath,
        identities: claim.admissionIdentities,
        barrierGrant: claim.admissionGrant,
        assertAllowed: () => {},
      }),
    ).rejects.toMatchObject({ name: "SessionWorkAdmissionBlockedError" });
    expect(
      takeMainRunRecoveryDispatch({
        agentId: "main",
        dispatchRunId: "dispatch-1",
        message: "resume this session",
        sessionKey: "global",
      }),
    ).toBeUndefined();

    expect(
      takeMainRunRecoveryDispatch({
        agentId: "main",
        dispatchRunId: "dispatch-2",
        message: "resume this session",
        sessionKey: "global",
      }),
    ).toBe(replacement);
    expect(replacement.authorization).toEqual({
      senderIsOwner: false,
    });
    expect(listMainRunRecoveryBarriers()).toHaveLength(1);
    expect(discardMainRunRecoveryDispatch("dispatch-2")).toBe(false);
  });

  it("keeps the durable barrier while its one recovery admission runs", async () => {
    const fixture = durableRecoveryFixture();
    const { barrier, recovery } = fixture;
    const claim = prepareFixtureDispatch(fixture);
    const admission = await beginSessionWorkAdmission({
      scope: barrier.storePath,
      identities: claim.admissionIdentities,
      barrierGrant: claim.admissionGrant,
      assertAllowed: () => {},
    });
    try {
      expect(isSessionWorkAdmissionActive(barrier.storePath, [barrier.sessionId])).toBe(true);
      expect(getMainRunRecoveryBarrierByLedgerRunId(recovery.publicRunId)).toEqual(barrier);
    } finally {
      admission.release();
    }
  });

  it("retires owner authority, grant, and indexes after a pre-CAS rejection", async () => {
    const fixture = durableRecoveryFixture();
    const claim = prepareFixtureDispatch(fixture);
    expect(takeFixtureDispatch(fixture)).toBe(claim);
    const owner = createMainRunRecoveryExecutionOwner(claim.dispatchToken);
    expect(owner.publicRunId).toBe(claim.publicRunId);
    let providerContinued = false;

    await expect(
      (async () => {
        await owner.start({ lifecycleGeneration: "generation-rejected" });
        providerContinued = true;
      })(),
    ).rejects.toBeInstanceOf(MainRunRecoveryOwnershipLostError);

    expect(providerContinued).toBe(false);
    expect(getMainRunRecovery(claim.ledgerRunId, fixture.database)).toMatchObject({
      state: "recovery_pending",
      execution: undefined,
    });
    await expect(
      beginSessionWorkAdmission({
        scope: claim.storePath,
        identities: claim.admissionIdentities,
        barrierGrant: claim.admissionGrant,
        assertAllowed: () => {},
      }),
    ).rejects.toBeInstanceOf(SessionWorkAdmissionBlockedError);
    expect(takeFixtureDispatch(fixture)).toBeUndefined();
    await expect(
      owner.start({ lifecycleGeneration: "generation-rejected" }),
    ).rejects.toBeInstanceOf(MainRunRecoveryOwnershipLostError);

    expect(prepareFixtureDispatch(fixture, "dispatch-2")).toMatchObject({
      dispatchRunId: "dispatch-2",
    });
  });

  it("rolls an observer-rejected execution back, fences it, and retires its owner", async () => {
    const fixture = durableRecoveryFixture();
    const claim = prepareFixtureDispatch(fixture);
    expect(takeFixtureDispatch(fixture)).toBe(claim);
    const admission = await beginSessionWorkAdmission({
      scope: claim.storePath,
      identities: claim.admissionIdentities,
      barrierGrant: claim.admissionGrant,
      assertAllowed: () => {},
    });
    markMainRunRecoveryDispatchAdmitted(claim.dispatchToken);
    onMainRunRecoveryDispatchStarted(claim.dispatchToken, () => {
      throw new Error("start observer failed");
    });
    const owner = createMainRunRecoveryExecutionOwner(claim.dispatchToken);

    try {
      await expect(
        owner.start({ lifecycleGeneration: "generation-observer-rejected" }),
      ).rejects.toBeInstanceOf(MainRunRecoveryOwnershipLostError);
    } finally {
      admission.release();
    }

    const execution = {
      runId: claim.dispatchRunId,
      lifecycleGeneration: "generation-observer-rejected",
    };
    expect(getMainRunRecovery(claim.ledgerRunId, fixture.database)).toMatchObject({
      state: "recovery_pending",
      execution: undefined,
      lease: undefined,
      lastError: "start observer failed",
      lifecycleFences: [execution],
    });
    expect(isMainRunRecoveryLifecycleFenced(execution)).toBe(true);
    await expect(
      owner.start({ lifecycleGeneration: execution.lifecycleGeneration }),
    ).rejects.toBeInstanceOf(MainRunRecoveryOwnershipLostError);

    const reclaimed = reclaimFixtureRecovery(fixture);
    expect(prepareFixtureDispatch(withRecovery(fixture, reclaimed), "dispatch-2")).toMatchObject({
      dispatchRunId: "dispatch-2",
    });
  });

  it("finalizes an unadopted token at the bounded handoff timeout", async () => {
    const fixture = durableRecoveryFixture();
    const claim = prepareFixtureDispatch(fixture);
    const owner = createMainRunRecoveryExecutionOwner(claim.dispatchToken);

    await expect(waitForMainRunRecoveryDispatchAdoption(claim.dispatchToken, 1)).resolves.toBe(
      "finalized",
    );

    expect(takeFixtureDispatch(fixture)).toBeUndefined();
    await expect(
      owner.start({ lifecycleGeneration: "generation-after-timeout" }),
    ).rejects.toBeInstanceOf(MainRunRecoveryOwnershipLostError);
    await expect(
      beginSessionWorkAdmission({
        scope: claim.storePath,
        identities: claim.admissionIdentities,
        barrierGrant: claim.admissionGrant,
        assertAllowed: () => {},
      }),
    ).rejects.toBeInstanceOf(SessionWorkAdmissionBlockedError);
    expect(prepareFixtureDispatch(fixture, "dispatch-2")).toMatchObject({
      dispatchRunId: "dispatch-2",
    });
  });

  it("settles only its cancellation epoch and releases the matching barrier", async () => {
    const fixture = durableRecoveryFixture();
    const nowMs = Date.now();
    const cancelling = requestMainRunRecoveryCancellation(
      {
        agentId: fixture.recovery.agentId,
        sessionKey: fixture.recovery.sessionKey,
        sessionKeyAliases: fixture.recovery.sessionKeyAliases,
        sessionId: fixture.recovery.sessionId,
        storePath: fixture.recovery.storePath,
        publicRunId: fixture.recovery.publicRunId,
        expectedRevision: fixture.recovery.revision,
        expectedState: fixture.recovery.state,
        cancellation: {
          kind: "abort",
          epoch: "cancellation-exact-epoch",
          requestedAtMs: nowMs,
        },
        nowMs,
      },
      fixture.database,
    );
    if (!cancelling) {
      throw new Error("failed to request fixture cancellation");
    }
    const token = createMainRunRecoveryCancellationSettlementToken(cancelling, fixture.database);

    expect(
      terminalizeMainRunRecoveryCancellation(
        {
          agentId: cancelling.agentId,
          sessionKey: cancelling.sessionKey,
          sessionKeyAliases: cancelling.sessionKeyAliases,
          sessionId: cancelling.sessionId,
          storePath: cancelling.storePath,
          publicRunId: cancelling.publicRunId,
          cancellation: { kind: "abort", epoch: "another-epoch" },
          endedAtMs: nowMs,
          nowMs,
        },
        fixture.database,
      ),
    ).toBeUndefined();
    expect(getMainRunRecoveryBarrierByLedgerRunId(cancelling.publicRunId)).toEqual(fixture.barrier);
    expect(
      settleMainRunRecoveryCancellation(token, {
        endedAtMs: nowMs,
        nowMs,
      }),
    ).toMatchObject({
      state: "terminal",
      terminalOutcome: { status: "cancelled", endedAtMs: nowMs },
    });
    expect(getMainRunRecoveryBarrierByLedgerRunId(cancelling.publicRunId)).toBeUndefined();
    const admission = await beginSessionWorkAdmission({
      scope: cancelling.storePath,
      identities: [cancelling.sessionId, cancelling.sessionKey],
      assertAllowed: () => {},
    });
    admission.release();
  });

  it("keeps earlier process terminal evidence authoritative over cancellation", async () => {
    const fixture = durableRecoveryFixture();
    const claim = prepareFixtureDispatch(fixture);
    expect(takeFixtureDispatch(fixture)).toBe(claim);
    markMainRunRecoveryDispatchAdmitted(claim.dispatchToken);
    onMainRunRecoveryDispatchStarted(claim.dispatchToken, () => {});
    await createMainRunRecoveryExecutionOwner(claim.dispatchToken).start({
      lifecycleGeneration: "generation-terminal-before-cancel",
    });
    const running = getMainRunRecovery(claim.ledgerRunId, fixture.database);
    if (!running || running.state !== "running" || !running.execution) {
      throw new Error("expected running recovery fixture with execution identity");
    }
    const execution = running.execution;
    const evidenceAtMs = Date.now();
    registerMainRunRecoveryTerminalEvidencePending({
      publicRunId: running.publicRunId,
      execution,
      database: fixture.database,
    });
    const cancellationAtMs = evidenceAtMs + 1;
    const cancelling = requestMainRunRecoveryCancellation(
      {
        agentId: running.agentId,
        sessionKey: running.sessionKey,
        sessionKeyAliases: running.sessionKeyAliases,
        sessionId: running.sessionId,
        storePath: running.storePath,
        publicRunId: running.publicRunId,
        expectedRevision: running.revision,
        expectedState: running.state,
        cancellation: {
          kind: "reset",
          epoch: "reset-after-terminal-event",
          requestedAtMs: cancellationAtMs,
        },
        nowMs: cancellationAtMs,
      },
      fixture.database,
    );
    if (!cancelling) {
      throw new Error("failed to request fixture cancellation");
    }
    const token = createMainRunRecoveryCancellationSettlementToken(cancelling, fixture.database);
    const settlementAtMs = cancellationAtMs + 1;

    expect(
      settleMainRunRecoveryCancellation(token, {
        endedAtMs: settlementAtMs,
        nowMs: settlementAtMs,
      }),
    ).toBeUndefined();
    expect(getMainRunRecovery(cancelling.publicRunId, fixture.database)?.state).toBe("cancelling");

    expect(
      recordMainRunRecoveryTerminalEvidenceCas(
        {
          agentId: cancelling.agentId,
          sessionKey: cancelling.sessionKey,
          sessionKeyAliases: cancelling.sessionKeyAliases,
          sessionId: cancelling.sessionId,
          storePath: cancelling.storePath,
          publicRunId: cancelling.publicRunId,
          expectedRevision: cancelling.revision,
          expectedState: cancelling.state,
          execution,
          outcome: { status: "done", endedAtMs: evidenceAtMs },
          observedAtMs: evidenceAtMs,
          nowMs: settlementAtMs,
        },
        fixture.database,
      ),
    ).toMatchObject({ terminalEvidence: { outcome: { status: "done" } } });
    expect(
      resolveMainRunRecoveryTerminalEvidencePending({
        publicRunId: cancelling.publicRunId,
        execution,
        database: fixture.database,
      }),
    ).toBe(true);
    expect(
      settleMainRunRecoveryCancellation(token, {
        endedAtMs: settlementAtMs,
        nowMs: settlementAtMs,
      }),
    ).toMatchObject({
      state: "terminal",
      terminalOutcome: { status: "done", endedAtMs: evidenceAtMs },
    });
    expect(getMainRunRecoveryBarrierByLedgerRunId(cancelling.publicRunId)).toBeUndefined();
  });
});
