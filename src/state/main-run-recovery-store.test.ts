import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
} from "../infra/delivery-queue-sqlite.js";
import { buildPersistedUserTurnMessage } from "../sessions/user-turn-transcript.js";
import {
  MAIN_RUN_RECOVERY_LEASE_MS,
  MAIN_RUN_RECOVERY_TERMINAL_RETENTION_MS,
  claimMainRunRecoveryLease,
  deferMainRunRecoveryRetryCas,
  discardUnacknowledgedExactTurn,
  findActiveMainRunRecoveryBySession,
  fingerprintMainRunRecoverySource,
  getMainRunRecovery,
  listDueMainRunRecoveries,
  pruneTerminalMainRunRecoveries,
  recordMainRunRecoveryTerminalEvidenceCas,
  releaseMainRunRecoveryLease,
  returnMainRunRecoveryExecutionToPending,
  requestMainRunRecoveryCancellation,
  reserveMainRunRecovery,
  reserveMainSessionResumeRecovery,
  terminalizeMainRunRecovery,
  terminalizeMainRunRecoveryCancellation,
  terminalizeMainRunRecoveryWithQueueEntry,
  transitionMainRunRecoveryStateCas,
  type MainRunRecovery,
  type MainRunRecoveryCas,
  type MainRunRecoveryExecution,
  type ReserveMainRunRecoveryInput,
} from "./main-run-recovery-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs: string[] = [];

function stateLocation() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "main-run-recovery-store-"));
  tempDirs.push(stateDir);
  return {
    stateDir,
    database: { env: { OPENCLAW_STATE_DIR: stateDir } },
    storePath: path.join(stateDir, "sessions.json"),
  };
}

function exactInput(params: {
  storePath: string;
  publicRunId?: string;
  agentId?: string;
  sessionId?: string;
  timestamp?: number;
  acceptedAtMs?: number;
}): ReserveMainRunRecoveryInput {
  const publicRunId = params.publicRunId ?? "public-run-1";
  const agentId = params.agentId ?? "main";
  const acceptedAtMs = params.acceptedAtMs ?? 1_000;
  const identity = {
    agentId,
    sessionKey: `agent:${agentId}:main`,
    sessionKeyAliases: [agentId],
    sessionId: params.sessionId ?? "session-1",
    storePath: params.storePath,
  };
  const envelope = {
    kind: "exact_turn" as const,
    approvedTurn: buildPersistedUserTurnMessage({
      text: "finish this request",
      timestamp: params.timestamp ?? acceptedAtMs,
      idempotencyKey: `${publicRunId}:user`,
      senderIsOwner: true,
    }),
  };
  const ownerPrincipal = { kind: "system" as const };
  const authorization = { senderIsOwner: true };
  const sourceKey = `${publicRunId}:user`;
  return {
    ...identity,
    publicRunId,
    sourceKey,
    sourceFingerprint: fingerprintMainRunRecoverySource({
      sourceKey,
      identity,
      envelope,
      ownerPrincipal,
      authorization,
    }),
    bootId: "boot-1",
    ownerPrincipal,
    authorization,
    envelope,
    initialLease: {
      owner: `admission:${publicRunId}`,
      expiresAtMs: acceptedAtMs + MAIN_RUN_RECOVERY_LEASE_MS,
    },
    acceptedAtMs,
  };
}

function cas(recovery: MainRunRecovery): MainRunRecoveryCas {
  if (recovery.state === "terminal") {
    throw new Error("terminal recovery has no CAS");
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

function runningRecovery(storePath: string, database: { env: NodeJS.ProcessEnv }) {
  const reserved = reserveMainRunRecovery(exactInput({ storePath }), database).recovery;
  const transcriptOwned = transitionMainRunRecoveryStateCas(
    {
      ...cas(reserved),
      nextState: "transcript_owned",
      currentBootId: "boot-1",
      nowMs: 1_001,
    },
    database,
  );
  if (!transcriptOwned) {
    throw new Error("failed transcript transition");
  }
  const execution: MainRunRecoveryExecution = {
    runId: "execution-1",
    lifecycleGeneration: "generation-1",
    epoch: "epoch-1",
  };
  const running = transitionMainRunRecoveryStateCas(
    {
      ...cas(transcriptOwned),
      nextState: "running",
      currentBootId: "boot-1",
      execution,
      nowMs: 1_002,
    },
    database,
  );
  if (!running) {
    throw new Error("failed running transition");
  }
  return { running, execution };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("main-run recovery store", () => {
  it("fails closed when an accepted exact-turn envelope is removed", () => {
    const { database, storePath } = stateLocation();
    const recovery = reserveMainRunRecovery(exactInput({ storePath }), database).recovery;
    const db = openOpenClawStateDatabase(database).db;

    expect(() =>
      db
        .prepare("UPDATE main_run_recoveries SET envelope_json = NULL WHERE public_run_id = ?")
        .run(recovery.publicRunId),
    ).toThrow();
    expect(getMainRunRecovery(recovery.publicRunId, database)?.envelope?.kind).toBe("exact_turn");
  });

  it("atomically reserves the admission lease and treats timestamp-only replay as duplicate", () => {
    const { database, storePath } = stateLocation();
    const first = exactInput({ storePath, timestamp: 1_000 });
    const replay = exactInput({ storePath, timestamp: 9_000 });

    expect(first.sourceFingerprint).toBe(replay.sourceFingerprint);
    expect(reserveMainRunRecovery(first, database)).toMatchObject({
      status: "inserted",
      recovery: { lease: { owner: "admission:public-run-1" } },
    });
    const duplicate = reserveMainRunRecovery(replay, database);
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.recovery.envelope?.kind).toBe("exact_turn");
    if (duplicate.recovery.envelope?.kind === "exact_turn") {
      expect(duplicate.recovery.envelope.approvedTurn.timestamp).toBe(1_000);
    }
  });

  it("uses physical store and session identity across agent routing changes", () => {
    const { database, storePath } = stateLocation();
    reserveMainRunRecovery(exactInput({ storePath, agentId: "alpha" }), database);

    const blocked = reserveMainRunRecovery(
      exactInput({
        storePath,
        publicRunId: "public-run-2",
        agentId: "beta",
      }),
      database,
    );
    expect(blocked).toMatchObject({
      status: "session_blocked",
      recovery: { agentId: "alpha", sessionId: "session-1" },
    });
    expect(
      findActiveMainRunRecoveryBySession(
        {
          agentId: "beta",
          sessionKey: "agent:beta:main",
          sessionId: "session-1",
          storePath,
        },
        database,
      ),
    ).toMatchObject({ agentId: "alpha" });
  });

  it("persists lifecycle fences when an interrupted execution returns to recovery", () => {
    const { database, storePath } = stateLocation();
    const { running, execution } = runningRecovery(storePath, database);

    const pending = transitionMainRunRecoveryStateCas(
      {
        ...cas(running),
        nextState: "recovery_pending",
        currentBootId: "boot-2",
        nextAttemptAtMs: 1_003,
        nowMs: 1_003,
      },
      database,
    );
    expect(pending?.lifecycleFences).toContainEqual({
      runId: execution.runId,
      lifecycleGeneration: execution.lifecycleGeneration,
    });
  });

  it("rolls back only the exact same-boot execution after start observation fails", () => {
    const { database, storePath } = stateLocation();
    const { running, execution } = runningRecovery(storePath, database);

    expect(
      returnMainRunRecoveryExecutionToPending(
        {
          ...cas(running),
          execution: { ...execution, epoch: "wrong-epoch" },
          currentBootId: "boot-1",
          nextAttemptAtMs: 1_004,
          lastError: "start observer failed",
          nowMs: 1_004,
        },
        database,
      ),
    ).toBeUndefined();

    expect(
      returnMainRunRecoveryExecutionToPending(
        {
          ...cas(running),
          execution,
          currentBootId: "boot-1",
          nextAttemptAtMs: 1_004,
          lastError: "start observer failed",
          nowMs: 1_004,
        },
        database,
      ),
    ).toMatchObject({
      state: "recovery_pending",
      execution: undefined,
      lease: undefined,
      lastError: "start observer failed",
      lifecycleFences: [
        { runId: execution.runId, lifecycleGeneration: execution.lifecycleGeneration },
      ],
    });
  });

  it("keeps the first cancellation token and lets earlier terminal evidence win", () => {
    const { database, storePath } = stateLocation();
    const { running, execution } = runningRecovery(storePath, database);
    const cancelling = requestMainRunRecoveryCancellation(
      {
        ...cas(running),
        cancellation: { kind: "abort", epoch: "cancel-1", requestedAtMs: 1_006 },
        nowMs: 1_006,
      },
      database,
    );
    if (!cancelling) {
      throw new Error("failed cancellation transition");
    }
    expect(
      requestMainRunRecoveryCancellation(
        {
          ...cas(cancelling),
          cancellation: { kind: "reset", epoch: "cancel-2", requestedAtMs: 1_007 },
          nowMs: 1_007,
        },
        database,
      ),
    ).toBeUndefined();
    const evidenced = recordMainRunRecoveryTerminalEvidenceCas(
      {
        ...cas(cancelling),
        execution,
        outcome: { status: "done", endedAtMs: 1_004 },
        observedAtMs: 1_005,
        nowMs: 1_007,
      },
      database,
    );
    if (!evidenced) {
      throw new Error("failed evidence write");
    }
    const leased = claimMainRunRecoveryLease(
      {
        ...cas(evidenced),
        leaseOwner: "worker-2",
        currentBootId: "boot-2",
        nowMs: 1_008,
        leaseDurationMs: MAIN_RUN_RECOVERY_LEASE_MS,
      },
      database,
    );
    expect(leased).toBeDefined();
    expect(
      terminalizeMainRunRecoveryCancellation(
        {
          agentId: evidenced.agentId,
          sessionKey: evidenced.sessionKey,
          sessionKeyAliases: evidenced.sessionKeyAliases,
          sessionId: evidenced.sessionId,
          storePath: evidenced.storePath,
          publicRunId: evidenced.publicRunId,
          cancellation: { kind: "reset", epoch: "cancel-1" },
          endedAtMs: 1_008,
          nowMs: 1_008,
        },
        database,
      ),
    ).toBeUndefined();
    const terminal = terminalizeMainRunRecoveryCancellation(
      {
        agentId: evidenced.agentId,
        sessionKey: evidenced.sessionKey,
        sessionKeyAliases: evidenced.sessionKeyAliases,
        sessionId: evidenced.sessionId,
        storePath: evidenced.storePath,
        publicRunId: evidenced.publicRunId,
        cancellation: { kind: "abort", epoch: "cancel-1" },
        endedAtMs: 1_008,
        nowMs: 1_008,
      },
      database,
    );
    expect(terminal).toMatchObject({
      state: "terminal",
      terminalOutcome: { status: "done", endedAtMs: 1_004 },
      cancellation: undefined,
    });
    expect(getMainRunRecovery(evidenced.publicRunId, database)).toMatchObject({
      state: "terminal",
      cancellation: undefined,
    });
    expect(
      terminalizeMainRunRecoveryCancellation(
        {
          agentId: terminal?.agentId ?? evidenced.agentId,
          sessionKey: terminal?.sessionKey ?? evidenced.sessionKey,
          sessionKeyAliases: terminal?.sessionKeyAliases ?? evidenced.sessionKeyAliases,
          sessionId: terminal?.sessionId ?? evidenced.sessionId,
          storePath: terminal?.storePath ?? evidenced.storePath,
          publicRunId: terminal?.publicRunId ?? evidenced.publicRunId,
          cancellation: { kind: "abort", epoch: "cancel-1" },
          endedAtMs: 1_008,
          nowMs: 1_008,
        },
        database,
      ),
    ).toBeUndefined();
  });

  it("rolls back queue insertion when terminal ownership or queue identity collides", () => {
    const { database, stateDir, storePath } = stateLocation();
    const envelope = {
      kind: "session_resume" as const,
      resolution: { kind: "fail" as const, code: "unresumable-tail" as const },
      systemMessage: "resume",
      transcriptTail: null,
      lifecycleRevision: "revision-1",
      delivery: {
        context: { channel: "telegram", to: "123" },
        runId: null,
        intentId: null,
      },
      fences: [],
    };
    const reserved = reserveMainSessionResumeRecovery(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-1",
        storePath,
        sourceKey: "resume-source-1",
        bootId: "boot-1",
        envelope,
        acceptedAtMs: 2_000,
      },
      database,
    ).recovery;
    const leased = claimMainRunRecoveryLease(
      {
        ...cas(reserved),
        leaseOwner: "failure-worker",
        currentBootId: "boot-1",
        nowMs: 2_001,
        leaseDurationMs: MAIN_RUN_RECOVERY_LEASE_MS,
      },
      database,
    );
    if (!leased) {
      throw new Error("failed recovery lease");
    }
    upsertDeliveryQueueEntry({
      queueName: "outbound",
      stateDir,
      entry: { id: "failure-key", enqueuedAt: 2_002, retryCount: 0, lastError: "foreign" },
      metadata: { entryKind: "outbound", sessionKey: leased.sessionKey },
    });
    const queueEntry = {
      queueName: "outbound",
      id: "failure-key",
      entry: { id: "failure-key", enqueuedAt: 2_002, retryCount: 0, lastError: "expected" },
      entryKind: "outbound",
      sessionKey: leased.sessionKey,
      enqueuedAtMs: 2_002,
    };
    expect(() =>
      terminalizeMainRunRecoveryWithQueueEntry(
        {
          ...cas(leased),
          outcome: { status: "failed", endedAtMs: 2_002 },
          nowMs: 2_002,
          queueEntry,
        },
        database,
      ),
    ).toThrow(/delivery queue collision/);
    expect(getMainRunRecovery(leased.publicRunId, database)?.state).toBe("recovery_pending");
    expect(loadDeliveryQueueEntry("outbound", "failure-key", stateDir)).toMatchObject({
      lastError: "foreign",
    });
  });

  it("does not claim a live admission lease and honors explicit same-boot release time", () => {
    const { database, storePath } = stateLocation();
    const reserved = reserveMainRunRecovery(exactInput({ storePath }), database).recovery;
    expect(listDueMainRunRecoveries({ nowMs: 1_001, currentBootId: "boot-1" }, database)).toEqual(
      [],
    );
    const released = releaseMainRunRecoveryLease(
      {
        ...cas(reserved),
        leaseOwner: "admission:public-run-1",
        nowMs: 1_002,
        nextAttemptAtMs: 1_100,
      },
      database,
    );
    expect(released).toBeDefined();
    expect(listDueMainRunRecoveries({ nowMs: 1_099, currentBootId: "boot-1" }, database)).toEqual(
      [],
    );
    expect(
      listDueMainRunRecoveries({ nowMs: 1_100, currentBootId: "boot-1" }, database),
    ).toHaveLength(1);
  });

  it("discards only the exact accepted ingress lease and permits same-key retry", () => {
    const { database, storePath } = stateLocation();
    const input = exactInput({ storePath });
    const reserved = reserveMainRunRecovery(input, database).recovery;

    expect(
      discardUnacknowledgedExactTurn(
        { ...cas(reserved), expectedState: "accepted", leaseOwner: "another-ingress" },
        database,
      ),
    ).toBe(false);
    expect(
      discardUnacknowledgedExactTurn(
        {
          ...cas(reserved),
          expectedState: "accepted",
          expectedRevision: reserved.revision + 1,
          leaseOwner: "admission:public-run-1",
        },
        database,
      ),
    ).toBe(false);
    expect(getMainRunRecovery(reserved.publicRunId, database)).toBeDefined();

    expect(
      discardUnacknowledgedExactTurn(
        {
          ...cas(reserved),
          expectedState: "accepted",
          leaseOwner: "admission:public-run-1",
        },
        database,
      ),
    ).toBe(true);
    expect(getMainRunRecovery(reserved.publicRunId, database)).toBeUndefined();
    expect(reserveMainRunRecovery(input, database).status).toBe("inserted");
  });

  it("adopts the current boot on a prior-boot claim so another worker cannot steal its live lease", () => {
    const { database, storePath } = stateLocation();
    const reserved = reserveMainRunRecovery(exactInput({ storePath }), database).recovery;
    const claimed = claimMainRunRecoveryLease(
      {
        ...cas(reserved),
        leaseOwner: "boot-2-worker",
        currentBootId: "boot-2",
        nowMs: 1_001,
        leaseDurationMs: MAIN_RUN_RECOVERY_LEASE_MS,
      },
      database,
    );
    expect(claimed).toMatchObject({
      bootId: "boot-2",
      lease: { owner: "boot-2-worker" },
    });
    expect(listDueMainRunRecoveries({ nowMs: 1_002, currentBootId: "boot-2" }, database)).toEqual(
      [],
    );
  });

  it("orders terminal evidence before ordinary due work at the scan limit", () => {
    const { database, stateDir, storePath } = stateLocation();
    const { running, execution } = runningRecovery(storePath, database);
    const evidenced = recordMainRunRecoveryTerminalEvidenceCas(
      {
        ...cas(running),
        execution,
        outcome: { status: "done", endedAtMs: 1_003 },
        observedAtMs: 1_004,
        nowMs: 1_004,
      },
      database,
    );
    if (!evidenced) {
      throw new Error("failed evidence write");
    }
    reserveMainRunRecovery(
      exactInput({
        storePath: path.join(stateDir, "other-sessions.json"),
        publicRunId: "public-run-ordinary",
        sessionId: "session-ordinary",
      }),
      database,
    );

    expect(
      listDueMainRunRecoveries({ nowMs: 1_005, currentBootId: "boot-1", limit: 1 }, database),
    ).toMatchObject([{ publicRunId: running.publicRunId, terminalEvidence: { execution } }]);
  });

  it("does not terminalize recorded evidence before its observation timestamp", () => {
    const { database, storePath } = stateLocation();
    const { running, execution } = runningRecovery(storePath, database);
    const evidenced = recordMainRunRecoveryTerminalEvidenceCas(
      {
        ...cas(running),
        execution,
        outcome: { status: "done", endedAtMs: 1_003 },
        observedAtMs: 2_000,
        nowMs: 2_000,
      },
      database,
    );
    if (!evidenced) {
      throw new Error("failed evidence write");
    }
    expect(
      terminalizeMainRunRecovery(
        {
          ...cas(evidenced),
          outcome: { status: "done", endedAtMs: 1_003 },
          nowMs: 1_500,
        },
        database,
      ),
    ).toBeUndefined();
    expect(
      terminalizeMainRunRecovery(
        {
          ...cas(evidenced),
          outcome: { status: "done", endedAtMs: 1_003 },
          nowMs: 2_000,
        },
        database,
      ),
    ).toMatchObject({ state: "terminal", terminalAtMs: 2_000 });
  });

  it("backs off a failed running-evidence settlement without clearing execution ownership", () => {
    const { database, storePath } = stateLocation();
    const { running, execution } = runningRecovery(storePath, database);
    const evidenced = recordMainRunRecoveryTerminalEvidenceCas(
      {
        ...cas(running),
        execution,
        outcome: { status: "done", endedAtMs: 1_003 },
        observedAtMs: 2_000,
        nowMs: 2_000,
      },
      database,
    );
    if (!evidenced) {
      throw new Error("failed evidence write");
    }
    const deferred = deferMainRunRecoveryRetryCas(
      {
        ...cas(evidenced),
        nowMs: 2_000,
        nextAttemptAtMs: 3_000,
        lastError: "synthetic settlement failure",
      },
      database,
    );
    expect(deferred).toMatchObject({
      state: "running",
      execution,
      terminalEvidence: { execution },
      nextAttemptAtMs: 3_000,
      lastError: "synthetic settlement failure",
    });
    expect(listDueMainRunRecoveries({ nowMs: 2_999, currentBootId: "boot-1" }, database)).toEqual(
      [],
    );
    expect(
      listDueMainRunRecoveries({ nowMs: 3_000, currentBootId: "boot-1" }, database),
    ).toMatchObject([{ publicRunId: running.publicRunId, execution }]);
  });

  it("prunes terminal rows only at the retention boundary", () => {
    const { database, storePath } = stateLocation();
    const { running } = runningRecovery(storePath, database);
    const terminalAtMs = 2_000;
    expect(
      terminalizeMainRunRecovery(
        {
          ...cas(running),
          outcome: { status: "done", endedAtMs: 1_500 },
          nowMs: terminalAtMs,
        },
        database,
      ),
    ).toMatchObject({ state: "terminal" });
    expect(
      pruneTerminalMainRunRecoveries(
        terminalAtMs + MAIN_RUN_RECOVERY_TERMINAL_RETENTION_MS - 1,
        database,
      ),
    ).toBe(0);
    expect(
      pruneTerminalMainRunRecoveries(
        terminalAtMs + MAIN_RUN_RECOVERY_TERMINAL_RETENTION_MS,
        database,
      ),
    ).toBe(1);
  });
});
