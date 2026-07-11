import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildMainRunRecoveryFailureNoticeIdempotencyKey,
  isMainRunRecoveryFailureNoticeIdempotencyKey,
} from "../infra/main-run-recovery-policy.js";
import { persistUserTurnTranscript } from "../sessions/user-turn-transcript.js";
import { buildPersistedUserTurnMessage } from "../sessions/user-turn-transcript.js";
import {
  MAIN_RUN_RECOVERY_LEASE_MS,
  claimMainRunRecoveryLease,
  fingerprintMainRunRecoverySource,
  getMainRunRecovery,
  recordMainRunRecoveryTerminalEvidenceCas,
  releaseMainRunRecoveryLease,
  requestMainRunRecoveryCancellation,
  reserveMainRunRecovery,
  reserveMainSessionResumeRecovery,
  transitionMainRunRecoveryStateCas,
  type MainRunRecovery,
  type MainRunRecoveryCas,
} from "../state/main-run-recovery-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  clearMainRunRecoveryRuntimeForTest,
  markMainRunRecoveryDispatchAdmitted,
  registerMainRunRecoveryTerminalEvidencePending,
  resolveMainRunRecoveryTerminalEvidencePending,
  takeMainRunRecoveryDispatch,
  upsertMainRunRecoveryBarrier,
} from "./main-run-recovery-runtime.js";
import {
  MAIN_RUN_RECOVERY_MAX_ATTEMPTS,
  createMainRunRecoveryWorker,
  quiesceMainRunRecoveryWorker,
  startMainRunRecoveryWorker,
  stopMainRunRecoveryWorker,
  wakeMainRunRecoveryWorker,
} from "./main-run-recovery-worker.js";

const cfg = {} as OpenClawConfig;
const tempDirs: string[] = [];

function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "main-run-recovery-worker-"));
  tempDirs.push(stateDir);
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = "agent:main:main";
  const sessionId = "session-1";
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      [sessionKey]: {
        sessionId,
        updatedAt: 1_000,
        lifecycleRevision: "revision-1",
        chatType: "direct",
      },
    }),
  );
  return {
    stateDir,
    storePath,
    sessionKey,
    sessionId,
    database: { env: { OPENCLAW_STATE_DIR: stateDir } },
  };
}

function cas(recovery: MainRunRecovery): MainRunRecoveryCas {
  if (recovery.state === "terminal") {
    throw new Error("terminal recovery has no CAS");
  }
  return {
    agentId: recovery.agentId,
    sessionKey: recovery.sessionKey,
    sessionKeyAliases: recovery.sessionKeyAliases,
    sessionId: recovery.sessionId,
    storePath: recovery.storePath,
    publicRunId: recovery.publicRunId,
    expectedRevision: recovery.revision,
    expectedState: recovery.state,
  };
}

async function reserveTranscriptOwnedExact(
  params: ReturnType<typeof fixture> & {
    publicRunId?: string;
    recoverySessionId?: string;
    recoverySessionKey?: string;
  },
) {
  const publicRunId = params.publicRunId ?? "public-exact-1";
  const sessionId = params.recoverySessionId ?? params.sessionId;
  const sessionKey = params.recoverySessionKey ?? params.sessionKey;
  const identity = {
    agentId: "main",
    sessionKey,
    sessionId,
    storePath: params.storePath,
  };
  const approvedTurn = buildPersistedUserTurnMessage({
    text: "write the report",
    timestamp: 1_000,
    idempotencyKey: `${publicRunId}:user`,
    senderIsOwner: true,
  });
  const envelope = { kind: "exact_turn" as const, approvedTurn };
  const ownerPrincipal = { kind: "system" as const };
  const authorization = { senderIsOwner: true };
  const sourceKey = `${publicRunId}:user`;
  const reserved = reserveMainRunRecovery(
    {
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
        owner: "chat-admission",
        expiresAtMs: 1_000 + MAIN_RUN_RECOVERY_LEASE_MS,
      },
      acceptedAtMs: 1_000,
    },
    params.database,
  ).recovery;
  const store = loadSessionStore(params.storePath, { skipCache: true });
  const entry = store[sessionKey];
  await persistUserTurnTranscript({
    agentId: "main",
    sessionId,
    sessionKey,
    sessionEntry: entry,
    sessionStore: store,
    storePath: params.storePath,
    expectedSessionId: sessionId,
    message: approvedTurn,
    updateMode: "inline",
  });
  const transcriptOwned = transitionMainRunRecoveryStateCas(
    {
      ...cas(reserved),
      nextState: "transcript_owned",
      currentBootId: "boot-1",
      nowMs: 1_001,
    },
    params.database,
  );
  if (!transcriptOwned) {
    throw new Error("failed transcript ownership transition");
  }
  const released = releaseMainRunRecoveryLease(
    {
      ...cas(transcriptOwned),
      leaseOwner: "chat-admission",
      nowMs: 1_002,
      nextAttemptAtMs: 1_002,
    },
    params.database,
  );
  if (!released) {
    throw new Error("failed admission release");
  }
  return released;
}

function readTranscriptMessages(
  storePath: string,
  sessionKey: string,
): Array<Record<string, unknown>> {
  const entry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
  if (!entry?.sessionFile) {
    return [];
  }
  return fs
    .readFileSync(entry.sessionFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type?: string; message?: Record<string, unknown> })
    .filter((line) => line.type === "message" && line.message)
    .map((line) => line.message as Record<string, unknown>);
}

afterEach(async () => {
  await stopMainRunRecoveryWorker();
  clearMainRunRecoveryRuntimeForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("main-run recovery worker", () => {
  it("retries a transiently unreadable session store without cancelling the recovery", async () => {
    const state = fixture();
    const recovery = await reserveTranscriptOwnedExact(state);
    fs.renameSync(state.storePath, `${state.storePath}.temporarily-unavailable`);
    const callAgent = vi.fn(async () => ({ status: "accepted" }));
    const worker = createMainRunRecoveryWorker({
      cfg,
      currentBootId: "boot-1",
      database: state.database,
      stateDir: state.stateDir,
      now: () => 5_000,
      abortExecution: async () => "inactive",
      callAgent,
    });

    const result = await worker.runDue();
    await worker.stop();

    expect(result).toMatchObject({ retried: 1, dispatched: 0 });
    expect(callAgent).not.toHaveBeenCalled();
    expect(getMainRunRecovery(recovery.publicRunId, state.database)).toMatchObject({
      state: "recovery_pending",
      cancellation: undefined,
    });
  });

  it.each(["missing", "tampered"] as const)(
    "does not dispatch when the exact persisted user turn is %s",
    async (mode) => {
      const state = fixture();
      const recovery = await reserveTranscriptOwnedExact(state);
      const entry = loadSessionStore(state.storePath, { skipCache: true })[state.sessionKey];
      if (!entry?.sessionFile) {
        throw new Error("expected persisted exact-turn transcript");
      }
      const lines = fs.readFileSync(entry.sessionFile, "utf8").trimEnd().split("\n");
      const rewritten = lines.flatMap((line) => {
        const record = JSON.parse(line) as { message?: Record<string, unknown> };
        if (record.message?.idempotencyKey !== recovery.sourceKey) {
          return [line];
        }
        if (mode === "missing") {
          return [];
        }
        record.message.content = "tampered exact turn";
        return [JSON.stringify(record)];
      });
      fs.writeFileSync(entry.sessionFile, `${rewritten.join("\n")}\n`);
      const callAgent = vi.fn(async () => ({ status: "accepted" }));
      const worker = createMainRunRecoveryWorker({
        cfg,
        currentBootId: "boot-1",
        database: state.database,
        stateDir: state.stateDir,
        now: () => 5_000,
        abortExecution: async () => "inactive",
        callAgent,
      });

      const result = await worker.runDue();
      await worker.stop();

      expect(result).toMatchObject({ retried: 1, dispatched: 0 });
      expect(callAgent).not.toHaveBeenCalled();
      expect(getMainRunRecovery(recovery.publicRunId, state.database)).toMatchObject({
        state: "recovery_pending",
        cancellation: undefined,
      });
    },
  );

  it("treats the canonical keyed successor as authoritative over a stale duplicate session id", async () => {
    const state = fixture();
    const recovery = await reserveTranscriptOwnedExact(state);
    const store = loadSessionStore(state.storePath, { skipCache: true });
    const stale = store[state.sessionKey];
    if (!stale) {
      throw new Error("expected original session entry");
    }
    store["archived:stale-session"] = stale;
    store[state.sessionKey] = {
      sessionId: "session-successor",
      updatedAt: 2_000,
      lifecycleRevision: "revision-2",
      chatType: "direct",
    };
    fs.writeFileSync(state.storePath, JSON.stringify(store));
    const callAgent = vi.fn(async () => ({ status: "accepted" }));
    const worker = createMainRunRecoveryWorker({
      cfg,
      currentBootId: "boot-1",
      database: state.database,
      stateDir: state.stateDir,
      now: () => 5_000,
      createId: () => "canonical-successor-abort",
      abortExecution: async () => "inactive",
      callAgent,
    });

    const result = await worker.runDue();
    await worker.stop();

    expect(result).toMatchObject({ retried: 1, dispatched: 0 });
    expect(callAgent).not.toHaveBeenCalled();
    expect(getMainRunRecovery(recovery.publicRunId, state.database)).toMatchObject({
      state: "cancelling",
      cancellation: { kind: "abort", epoch: "canonical-successor-abort" },
    });
  });

  it("retries cancellation until earlier process terminal evidence is durable", async () => {
    const state = fixture();
    const transcriptOwned = await reserveTranscriptOwnedExact(state);
    const claimed = claimMainRunRecoveryLease(
      {
        ...cas(transcriptOwned),
        leaseOwner: "terminal-race-owner",
        currentBootId: "boot-1",
        nowMs: 2_000,
        leaseDurationMs: MAIN_RUN_RECOVERY_LEASE_MS,
      },
      state.database,
    );
    if (!claimed) {
      throw new Error("failed to claim terminal-race fixture");
    }
    const execution = {
      runId: "private-terminal-race",
      lifecycleGeneration: "generation-terminal-race",
      epoch: "epoch-terminal-race",
    } as const;
    const running = transitionMainRunRecoveryStateCas(
      {
        ...cas(claimed),
        nextState: "running",
        execution,
        currentBootId: "boot-1",
        nowMs: 2_001,
      },
      state.database,
    );
    if (!running) {
      throw new Error("failed to start terminal-race fixture");
    }
    registerMainRunRecoveryTerminalEvidencePending({
      publicRunId: running.publicRunId,
      execution,
      database: state.database,
    });
    const cancelling = requestMainRunRecoveryCancellation(
      {
        ...cas(running),
        cancellation: { kind: "abort", epoch: "abort-terminal-race", requestedAtMs: 2_002 },
        nowMs: 2_002,
      },
      state.database,
    );
    if (!cancelling) {
      throw new Error("failed to cancel terminal-race fixture");
    }
    let currentTime = 3_000;
    const notifyTerminal = vi.fn(async () => {});
    const worker = createMainRunRecoveryWorker({
      cfg,
      currentBootId: "boot-1",
      database: state.database,
      stateDir: state.stateDir,
      now: () => currentTime,
      abortExecution: async () => "inactive",
      callAgent: vi.fn(async () => ({ status: "accepted" })),
      notifyTerminal,
    });

    expect(await worker.runDue()).toMatchObject({ retried: 1, terminalized: 0 });
    const deferred = getMainRunRecovery(cancelling.publicRunId, state.database);
    if (!deferred || deferred.state !== "cancelling") {
      throw new Error("expected deferred cancellation fixture");
    }
    expect(
      recordMainRunRecoveryTerminalEvidenceCas(
        {
          ...cas(deferred),
          execution,
          outcome: { status: "done", endedAtMs: 2_001 },
          observedAtMs: 2_001,
          nowMs: currentTime,
        },
        state.database,
      ),
    ).toMatchObject({ terminalEvidence: { outcome: { status: "done" } } });
    expect(
      resolveMainRunRecoveryTerminalEvidencePending({
        publicRunId: deferred.publicRunId,
        execution,
        database: state.database,
      }),
    ).toBe(true);
    currentTime = 5_000;

    expect(await worker.runDue()).toMatchObject({ retried: 0, terminalized: 1 });
    expect(getMainRunRecovery(deferred.publicRunId, state.database)).toMatchObject({
      state: "terminal",
      terminalOutcome: { status: "done", endedAtMs: 2_001 },
    });
    expect(notifyTerminal).toHaveBeenCalledOnce();
    await worker.stop();
  });

  it("isolates a conflicting first-row barrier, backs it off, and dispatches the next due row", async () => {
    const state = fixture();
    const secondSessionKey = "agent:main:secondary";
    const secondSessionId = "session-2";
    const initialStore = loadSessionStore(state.storePath, { skipCache: true });
    initialStore[secondSessionKey] = {
      sessionId: secondSessionId,
      updatedAt: 1_000,
      lifecycleRevision: "revision-1",
      chatType: "direct",
    };
    fs.writeFileSync(state.storePath, JSON.stringify(initialStore));
    const first = await reserveTranscriptOwnedExact({
      ...state,
      publicRunId: "public-exact-a",
    });
    const second = await reserveTranscriptOwnedExact({
      ...state,
      publicRunId: "public-exact-b",
      recoverySessionKey: secondSessionKey,
      recoverySessionId: secondSessionId,
    });
    upsertMainRunRecoveryBarrier({
      aliases: [state.sessionKey],
      ledgerRunId: "foreign-ledger-owner",
      sessionId: state.sessionId,
      storePath: state.storePath,
    });
    const callAgent = vi.fn(async (request: Record<string, unknown>) => {
      const claim = takeMainRunRecoveryDispatch({
        agentId: String(request.agentId),
        dispatchRunId: String(request.idempotencyKey),
        message: String(request.message),
        sessionKey: String(request.sessionKey),
      });
      if (!claim) {
        throw new Error("expected in-process dispatch claim");
      }
      markMainRunRecoveryDispatchAdmitted(claim.dispatchToken);
      return { status: "accepted" };
    });
    const currentTime = Date.now();
    const worker = createMainRunRecoveryWorker({
      cfg,
      currentBootId: "boot-1",
      database: state.database,
      stateDir: state.stateDir,
      // Dispatch adoption heartbeats compare leases to the process wall clock.
      now: () => currentTime,
      createId: () => "dispatch-secondary",
      abortExecution: async () => "inactive",
      callAgent,
    });

    const result = await worker.runDue();
    await worker.stop();

    expect(result).toMatchObject({ processed: 2, retried: 1, dispatched: 1 });
    expect(callAgent).toHaveBeenCalledTimes(1);
    expect(getMainRunRecovery(first.publicRunId, state.database)).toMatchObject({
      state: "recovery_pending",
      nextAttemptAtMs: currentTime + 1_000,
      lastError: "recovery row processing failed",
    });
    expect(getMainRunRecovery(second.publicRunId, state.database)?.state).toBe("recovery_pending");
  });

  it("exhausts durable exact-turn attempts once, appends one neutral failure, and clears UI state", async () => {
    const state = fixture();
    let recovery = await reserveTranscriptOwnedExact(state);
    for (let attempt = 0; attempt < MAIN_RUN_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
      const claimed = claimMainRunRecoveryLease(
        {
          ...cas(recovery),
          leaseOwner: `failed-worker-${attempt}`,
          currentBootId: "boot-1",
          nowMs: 1_100 + attempt * 2,
          leaseDurationMs: MAIN_RUN_RECOVERY_LEASE_MS,
        },
        state.database,
      );
      if (!claimed) {
        throw new Error("failed synthetic worker claim");
      }
      const released = releaseMainRunRecoveryLease(
        {
          ...cas(claimed),
          leaseOwner: `failed-worker-${attempt}`,
          nowMs: 1_101 + attempt * 2,
          nextAttemptAtMs: 1_101 + attempt * 2,
          lastError: "synthetic dispatch failure",
        },
        state.database,
      );
      if (!released) {
        throw new Error("failed synthetic worker release");
      }
      recovery = released;
    }
    const callAgent = vi.fn(async () => ({ status: "accepted" }));
    const notifyTerminal = vi.fn(async () => {});
    let currentTime = 2_000;
    const worker = createMainRunRecoveryWorker({
      cfg,
      currentBootId: "boot-1",
      database: state.database,
      stateDir: state.stateDir,
      now: () => currentTime++,
      createId: () => "exhaustion-worker",
      abortExecution: async () => "inactive",
      callAgent,
      notifyTerminal,
    });

    const result = await worker.runDue();
    await worker.stop();

    expect(result).toMatchObject({ terminalized: 1, dispatched: 0 });
    expect(callAgent).not.toHaveBeenCalled();
    expect(getMainRunRecovery(recovery.publicRunId, state.database)).toMatchObject({
      state: "terminal",
      terminalOutcome: { status: "failed" },
    });
    const messages = readTranscriptMessages(state.storePath, state.sessionKey);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    const failures = messages.filter((message) =>
      isMainRunRecoveryFailureNoticeIdempotencyKey(message.idempotencyKey),
    );
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures[0])).not.toMatch(/restart|interrupted/i);
    expect(notifyTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        publicRunId: recovery.publicRunId,
        status: "failed",
        message: expect.not.stringMatching(/restart|interrupted/i),
      }),
    );
  });

  it("atomically targets the delivery row in the exact custom SQLite database", async () => {
    const state = fixture();
    const explicitDatabase = openOpenClawStateDatabase(state.database);
    const envelope = {
      kind: "session_resume" as const,
      resolution: { kind: "fail" as const, code: "unresumable-tail" as const },
      systemMessage: "resume after restart",
      transcriptTail: null,
      lifecycleRevision: "revision-1",
      delivery: {
        context: { channel: "telegram", to: "12345" },
        runId: null,
        intentId: null,
      },
      fences: [],
    };
    const recovery = reserveMainSessionResumeRecovery(
      {
        agentId: "main",
        sessionKey: state.sessionKey,
        sessionId: state.sessionId,
        storePath: state.storePath,
        sourceKey: "restart-evidence-1",
        bootId: "boot-1",
        envelope,
        acceptedAtMs: 3_000,
      },
      { path: explicitDatabase.path },
    ).recovery;
    const drained: Array<{ id: string; path: string; entryJson: string }> = [];
    const worker = createMainRunRecoveryWorker({
      cfg,
      currentBootId: "boot-1",
      database: { path: explicitDatabase.path },
      now: () => 3_100,
      createId: () => "failure-worker",
      abortExecution: async () => "inactive",
      callAgent: vi.fn(async () => ({ status: "accepted" })),
      drainQueueEntry: async (id, database) => {
        const row = openOpenClawStateDatabase(database)
          .db.prepare(
            "SELECT entry_json FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = ?",
          )
          .get(id) as { entry_json: string } | undefined;
        if (!row) {
          throw new Error("targeted delivery row missing");
        }
        drained.push({ id, path: database.path, entryJson: row.entry_json });
      },
    });

    const result = await worker.runDue();
    await worker.stop();

    const expectedId = buildMainRunRecoveryFailureNoticeIdempotencyKey(recovery.publicRunId);
    expect(result.terminalized).toBe(1);
    expect(drained).toEqual([
      expect.objectContaining({ id: expectedId, path: explicitDatabase.path }),
    ]);
    expect(JSON.parse(drained[0]?.entryJson ?? "{}")).toMatchObject({ id: expectedId });
    expect(getMainRunRecovery(recovery.publicRunId, { path: explicitDatabase.path })?.state).toBe(
      "terminal",
    );
  });

  it("rejects split state locations and exposes an idempotent singleton wake/stop lifecycle", async () => {
    const first = fixture();
    const second = fixture();
    expect(() =>
      createMainRunRecoveryWorker({
        cfg,
        currentBootId: "boot-1",
        database: first.database,
        stateDir: second.stateDir,
        abortExecution: async () => "inactive",
        callAgent: async () => ({ status: "accepted" }),
      }),
    ).toThrow(/different SQLite files/);

    const worker = startMainRunRecoveryWorker({
      cfg,
      currentBootId: "boot-1",
      database: first.database,
      stateDir: first.stateDir,
      abortExecution: async () => "inactive",
      callAgent: async () => ({ status: "accepted" }),
    });
    expect(wakeMainRunRecoveryWorker()).toBe(true);
    await worker.stop();
    expect(wakeMainRunRecoveryWorker()).toBe(false);
    expect(await stopMainRunRecoveryWorker()).toBe(false);
  });

  it("resumes the singleton worker only when restart preparation rolls back", async () => {
    const state = fixture();
    startMainRunRecoveryWorker({
      cfg,
      currentBootId: "boot-1",
      database: state.database,
      stateDir: state.stateDir,
      abortExecution: async () => "inactive",
      callAgent: async () => ({ status: "accepted" }),
    });

    const quiescence = await quiesceMainRunRecoveryWorker();
    expect(wakeMainRunRecoveryWorker()).toBe(false);
    expect(quiescence.resume()).toBe(true);
    expect(wakeMainRunRecoveryWorker()).toBe(true);
    expect(quiescence.resume()).toBe(false);
  });

  it("waits for an active dispatch before shutdown resolves", async () => {
    const state = fixture();
    const recovery = await reserveTranscriptOwnedExact(state);
    const currentTime = Date.now();
    let releaseDispatch!: () => void;
    const dispatchBlocked = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const worker = startMainRunRecoveryWorker({
      cfg,
      currentBootId: "boot-1",
      database: state.database,
      stateDir: state.stateDir,
      now: () => currentTime,
      createId: () => "blocked-worker",
      abortExecution: async () => "inactive",
      callAgent: async () => {
        await dispatchBlocked;
        return { status: "rejected" };
      },
    });
    const running = worker.runDue();
    await vi.waitFor(() => {
      expect(getMainRunRecovery(recovery.publicRunId, state.database)?.lease).toBeDefined();
    });
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseDispatch();
    await running;
    await stopping;
    expect(stopped).toBe(true);
    expect(getMainRunRecovery(recovery.publicRunId, state.database)).toMatchObject({
      state: "recovery_pending",
      lease: undefined,
    });
  });
});
