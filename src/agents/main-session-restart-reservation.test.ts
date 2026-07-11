import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  rotateAgentEventLifecycleGeneration,
  resetAgentRunContextForTest,
} from "../infra/agent-events.js";
import {
  getMainRunRecovery,
  listNonTerminalMainRunRecoveries,
  reserveMainSessionResumeRecovery,
  terminalizeMainRunRecovery,
  transitionMainRunRecoveryStateCas,
  type MainRunRecovery,
  type MainRunRecoveryCas,
} from "../state/main-run-recovery-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  clearMainRunRecoveryRuntimeForTest,
  getMainRunRecoveryBarrierByLedgerRunId,
  listMainRunRecoveryBarriers,
} from "./main-run-recovery-runtime.js";
import {
  reserveRestartAbortedMainSessionFromLock,
  reserveRestartAbortedMainSessions,
} from "./main-session-restart-reservation.js";
import { cleanStaleLockFiles } from "./session-write-lock.js";

const DEAD_PID = 2_147_483_647;

let stateDir: string;

function database() {
  return { env: { OPENCLAW_STATE_DIR: stateDir } };
}

function cas(recovery: MainRunRecovery): MainRunRecoveryCas {
  if (recovery.state === "terminal") {
    throw new Error("terminal recovery has no CAS identity");
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

async function makeSessionsDir(agentId = "main"): Promise<string> {
  const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

async function writeStore(
  sessionsDir: string,
  store: Record<string, SessionEntry>,
): Promise<string> {
  const storePath = path.join(sessionsDir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
  return storePath;
}

async function writeTranscript(
  transcriptPath: string,
  messages: Array<{ id: string; message: unknown }>,
): Promise<void> {
  await fs.writeFile(
    transcriptPath,
    `${messages.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

async function writeStaleLock(transcriptPath: string): Promise<{
  lockPath: string;
  nowMs: number;
}> {
  const nowMs = Date.now();
  const lockPath = `${transcriptPath}.lock`;
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      pid: DEAD_PID,
      createdAt: new Date(nowMs - 60_000).toISOString(),
    }),
  );
  return { lockPath, nowMs };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  resetAgentRunContextForTest();
  clearMainRunRecoveryRuntimeForTest();
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-restart-reservation-"));
});

afterEach(async () => {
  resetAgentRunContextForTest();
  clearMainRunRecoveryRuntimeForTest();
  closeOpenClawStateDatabaseForTest();
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("main-session restart reservation", () => {
  it("refuses to synthesize controlled-restart work without exact active-run authority", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:main";
    const sessionId = "session-no-authority";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        status: "running",
      },
    });
    await writeTranscript(path.join(sessionsDir, `${sessionId}.jsonl`), [
      { id: "user-1", message: { role: "user", content: "finish this work" } },
    ]);

    await expect(
      reserveRestartAbortedMainSessions({
        stateDir,
        sessionKeys: [sessionKey],
        sessionIds: [sessionId],
      }),
    ).rejects.toThrow("has no exact active-run authority");
    await expect(
      reserveRestartAbortedMainSessions({
        stateDir,
        sessionKeys: [sessionKey],
        sessionIds: [sessionId],
        activeRuns: [
          {
            runId: "run-rejected",
            lifecycleGeneration: "generation-rejected",
            sessionKey,
            sessionId,
          },
        ],
        isActiveRun: () => false,
      }),
    ).rejects.toThrow("has no exact active-run authority");

    expect(listNonTerminalMainRunRecoveries(database())).toEqual([]);
  });

  it("persists only exact lifecycle fences and makes controlled replay idempotent", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:main";
    const alias = "agent:main:dm:owner";
    const sessionId = "session-controlled";
    const entry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      status: "running",
    };
    await writeStore(sessionsDir, { [sessionKey]: entry, [alias]: entry });
    await writeTranscript(path.join(sessionsDir, `${sessionId}.jsonl`), [
      { id: "user-1", message: { role: "user", content: "continue after restart" } },
      { id: "tool-1", message: { role: "toolResult", content: "partial result" } },
    ]);
    const activeRuns = [
      {
        runId: "run-b",
        lifecycleGeneration: "generation-b",
        sessionKey,
        sessionId,
      },
      {
        runId: "run-a",
        lifecycleGeneration: "generation-a",
        sessionKey,
        sessionId,
      },
      {
        runId: "run-filtered",
        lifecycleGeneration: "generation-filtered",
        sessionKey,
        sessionId,
      },
      {
        runId: "run-other",
        lifecycleGeneration: "generation-other",
        sessionKey: "agent:main:other",
        sessionId: "other-session",
      },
    ];
    const reserve = () =>
      reserveRestartAbortedMainSessions({
        stateDir,
        sessionKeys: [sessionKey],
        sessionIds: [sessionId],
        activeRuns,
        isActiveRun: (run) => run.runId !== "run-filtered",
      });

    await expect(reserve()).resolves.toEqual({ reserved: 1, skipped: 0 });
    await expect(reserve()).resolves.toEqual({ reserved: 1, skipped: 0 });

    const recoveries = listNonTerminalMainRunRecoveries(database());
    expect(recoveries).toHaveLength(1);
    const [recovery] = recoveries;
    expect(recovery).toMatchObject({
      kind: "session_resume",
      sessionKey,
      sessionKeyAliases: [alias],
      sessionId,
      authorization: { senderIsOwner: false },
    });
    expect(recovery?.envelope?.kind).toBe("session_resume");
    if (recovery?.envelope?.kind !== "session_resume") {
      throw new Error("expected session-resume recovery envelope");
    }
    expect(recovery.envelope.fences).toEqual([
      { runId: "run-a", lifecycleGeneration: "generation-a" },
      { runId: "run-b", lifecycleGeneration: "generation-b" },
    ]);
    expect(getMainRunRecoveryBarrierByLedgerRunId(recovery.publicRunId)).toMatchObject({
      aliases: [alias, sessionKey],
      ledgerRunId: recovery.publicRunId,
      sessionId,
    });
  });

  it("rolls back the full controlled batch when a later session is blocked", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = await writeStore(sessionsDir, {
      "agent:main:first": {
        sessionId: "session-first",
        updatedAt: Date.now(),
        status: "running",
      },
      "agent:main:second": {
        sessionId: "session-second",
        updatedAt: Date.now(),
        status: "running",
      },
    });
    for (const sessionId of ["session-first", "session-second"]) {
      await writeTranscript(path.join(sessionsDir, `${sessionId}.jsonl`), [
        { id: `${sessionId}-user`, message: { role: "user", content: "continue" } },
      ]);
    }
    reserveMainSessionResumeRecovery(
      {
        agentId: "main",
        sessionKey: "agent:main:second",
        sessionKeyAliases: [],
        sessionId: "session-second",
        storePath,
        sourceKey: "existing-second-session-owner",
        bootId: "existing-boot",
        envelope: {
          kind: "session_resume",
          resolution: { kind: "resume" },
          systemMessage: "existing recovery",
          transcriptTail: null,
          lifecycleRevision: null,
          delivery: { context: null, runId: null, intentId: null },
          fences: [],
        },
        acceptedAtMs: 1,
      },
      database(),
    );

    await expect(
      reserveRestartAbortedMainSessions({
        stateDir,
        sessionKeys: ["agent:main:first", "agent:main:second"],
        sessionIds: ["session-first", "session-second"],
        activeRuns: [
          {
            runId: "run-first",
            lifecycleGeneration: "generation-first",
            sessionKey: "agent:main:first",
            sessionId: "session-first",
          },
          {
            runId: "run-second",
            lifecycleGeneration: "generation-second",
            sessionKey: "agent:main:second",
            sessionId: "session-second",
          },
        ],
      }),
    ).rejects.toThrow("recovery batch blocked");

    expect(listNonTerminalMainRunRecoveries(database())).toMatchObject([
      { sessionId: "session-second", sourceKey: "existing-second-session-owner" },
    ]);
    expect(listMainRunRecoveryBarriers()).toEqual([]);
  });

  it("reserves stale-lock evidence before removing the lock", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:main";
    const sessionId = "session-stale-lock";
    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeStore(sessionsDir, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        status: "running",
      },
    });
    await writeTranscript(transcriptPath, [
      { id: "user-1", message: { role: "user", content: "resume from stale lock" } },
    ]);
    const { lockPath, nowMs } = await writeStaleLock(transcriptPath);
    const order: string[] = [];

    const cleanup = await cleanStaleLockFiles({
      sessionsDir,
      staleMs: 1_000,
      nowMs,
      removeStale: true,
      beforeRemoveStale: async (lock) => {
        order.push("inspected");
        expect(lock).toMatchObject({ lockPath, removable: true, removed: false });
        expect(await pathExists(lockPath)).toBe(true);
        const reservation = await reserveRestartAbortedMainSessionFromLock({
          stateDir,
          sessionsDir,
          lock,
        });
        order.push("reserved");
        expect(reservation.kind).toBe("reserved");
        expect(listNonTerminalMainRunRecoveries(database())).toHaveLength(1);
        expect(await pathExists(lockPath)).toBe(true);
        return reservation.kind === "reserved";
      },
    });
    order.push((await pathExists(lockPath)) ? "preserved" : "removed");

    expect(order).toEqual(["inspected", "reserved", "removed"]);
    expect(cleanup.cleaned).toHaveLength(1);
    expect(cleanup.cleaned[0]).toMatchObject({ lockPath, removed: true });
    const [recovery] = listNonTerminalMainRunRecoveries(database());
    expect(recovery?.envelope).toMatchObject({ kind: "session_resume", fences: [] });
  });

  it("preserves an ambiguous stale lock instead of choosing a session identity", async () => {
    const sessionsDir = await makeSessionsDir();
    const transcriptPath = path.join(sessionsDir, "shared.jsonl");
    await writeStore(sessionsDir, {
      "agent:main:first": {
        sessionId: "session-first",
        sessionFile: "shared.jsonl",
        updatedAt: Date.now(),
        status: "running",
      },
      "agent:main:second": {
        sessionId: "session-second",
        sessionFile: "shared.jsonl",
        updatedAt: Date.now(),
        status: "running",
      },
    });
    await writeTranscript(transcriptPath, [
      { id: "user-1", message: { role: "user", content: "ambiguous transcript" } },
    ]);
    const { lockPath, nowMs } = await writeStaleLock(transcriptPath);
    let reservationKind: string | undefined;

    const cleanup = await cleanStaleLockFiles({
      sessionsDir,
      staleMs: 1_000,
      nowMs,
      removeStale: true,
      beforeRemoveStale: async (lock) => {
        const reservation = await reserveRestartAbortedMainSessionFromLock({
          stateDir,
          sessionsDir,
          lock,
        });
        reservationKind = reservation.kind;
        return reservation.kind !== "preserve";
      },
    });

    expect(reservationKind).toBe("preserve");
    expect(cleanup.cleaned).toEqual([]);
    expect(cleanup.locks[0]).toMatchObject({ lockPath, removable: true, removed: false });
    expect(await pathExists(lockPath)).toBe(true);
    expect(listNonTerminalMainRunRecoveries(database())).toEqual([]);
  });

  it("keeps a terminal controlled reservation terminal across repeated restart boots", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:main";
    const sessionId = "session-terminal";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        status: "running",
      },
    });
    await writeTranscript(path.join(sessionsDir, `${sessionId}.jsonl`), [
      { id: "user-1", message: { role: "user", content: "one recoverable turn" } },
    ]);
    const activeRuns = [
      {
        runId: "run-before-restart",
        lifecycleGeneration: "generation-before-restart",
        sessionKey,
        sessionId,
      },
    ];
    const reserve = () =>
      reserveRestartAbortedMainSessions({
        stateDir,
        sessionKeys: [sessionKey],
        sessionIds: [sessionId],
        activeRuns,
      });

    await expect(reserve()).resolves.toEqual({ reserved: 1, skipped: 0 });
    const [reserved] = listNonTerminalMainRunRecoveries(database());
    if (!reserved) {
      throw new Error("expected controlled-restart reservation");
    }
    const execution = {
      runId: "run-after-restart",
      lifecycleGeneration: "generation-after-restart",
      epoch: "execution-epoch",
    };
    const running = transitionMainRunRecoveryStateCas(
      {
        ...cas(reserved),
        nextState: "running",
        currentBootId: "boot-after-restart",
        execution,
        nowMs: reserved.acceptedAtMs + 1,
      },
      database(),
    );
    if (!running) {
      throw new Error("expected running recovery transition");
    }
    const terminal = terminalizeMainRunRecovery(
      {
        ...cas(running),
        outcome: { status: "done", endedAtMs: running.acceptedAtMs + 2 },
        nowMs: running.acceptedAtMs + 2,
      },
      database(),
    );
    expect(terminal?.state).toBe("terminal");

    for (let boot = 0; boot < 3; boot += 1) {
      clearMainRunRecoveryRuntimeForTest();
      rotateAgentEventLifecycleGeneration();
      await expect(reserve()).resolves.toEqual({ reserved: 1, skipped: 0 });
      expect(listNonTerminalMainRunRecoveries(database())).toEqual([]);
      expect(getMainRunRecoveryBarrierByLedgerRunId(reserved.publicRunId)).toBeUndefined();
      expect(getMainRunRecovery(reserved.publicRunId, database())).toMatchObject({
        publicRunId: reserved.publicRunId,
        state: "terminal",
        terminalOutcome: { status: "done" },
      });
    }
  });
});
