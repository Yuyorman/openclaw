// Session delete lifecycle tests protect transcript deletion, ACP metadata,
// active-run cleanup, hooks, thread bindings, and browser/MCP cleanup.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import {
  readAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import {
  clearMainRunRecoveryRuntimeForTest,
  prepareMainRunRecoveryDispatch,
  upsertMainRunRecoveryBarrier,
} from "../agents/main-run-recovery-runtime.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { buildPersistedUserTurnMessage } from "../sessions/user-turn-transcript.js";
import {
  MAIN_RUN_RECOVERY_LEASE_MS,
  fingerprintMainRunRecoverySource,
  getMainRunRecovery,
  reserveMainRunRecovery,
  transitionMainRunRecoveryStateCas,
  type MainRunRecovery,
  type MainRunRecoveryCas,
} from "../state/main-run-recovery-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { embeddedRunMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionLifecycleHookMocks,
  subagentLifecycleHookMocks,
  subagentLifecycleHookState,
  threadBindingMocks,
  acpManagerMocks,
  browserSessionTabMocks,
  bundleMcpRuntimeMocks,
  writeSingleLineSession,
  sessionStoreEntry,
  expectActiveRunCleanup,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const sessionArchiveFailureState = vi.hoisted(() => ({ error: undefined as Error | undefined }));

vi.mock("./session-archive.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./session-archive.runtime.js")>(
    "./session-archive.runtime.js",
  );
  return {
    ...actual,
    archiveSessionTranscriptsDetailed: (
      ...args: Parameters<typeof actual.archiveSessionTranscriptsDetailed>
    ) => {
      const error = sessionArchiveFailureState.error;
      sessionArchiveFailureState.error = undefined;
      if (error) {
        throw error;
      }
      return actual.archiveSessionTranscriptsDetailed(...args);
    },
  };
});

const {
  createConfiguredGlobalAgentSessionStore,
  createSessionStoreDir,
  openClient,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsTestHarness();
const execFileAsync = promisify(execFile);

async function initializeRemoteBackedGitWorkspace(root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  const remote = path.join(root, "remote.git");
  await fs.mkdir(workspace, { recursive: true });
  await execFileAsync("git", ["-C", workspace, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", workspace, "config", "user.name", "OpenClaw Test"]);
  await execFileAsync("git", [
    "-C",
    workspace,
    "config",
    "user.email",
    "openclaw-test@example.invalid",
  ]);
  await fs.writeFile(path.join(workspace, "README.md"), "base\n");
  await execFileAsync("git", ["-C", workspace, "add", "README.md"]);
  await execFileAsync("git", ["-C", workspace, "commit", "-m", "initial"]);
  await execFileAsync("git", ["clone", "--bare", workspace, remote]);
  await execFileAsync("git", ["-C", workspace, "remote", "add", "origin", remote]);
  await execFileAsync("git", ["-C", workspace, "push", "-u", "origin", "main"]);
  return await fs.realpath(workspace);
}

afterEach(() => {
  sessionArchiveFailureState.error = undefined;
  clearMainRunRecoveryRuntimeForTest();
  closeOpenClawStateDatabaseForTest();
});

function expectObject(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("expected object");
  }
}

type SessionDeleteRequest = {
  key: string;
  agentId?: string;
  archivedOnly?: boolean;
  deleteTranscript?: boolean;
  emitLifecycleHooks?: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  expectedSessionUpdatedAt?: number;
};

async function expectSessionDeleteSucceeds(request: SessionDeleteRequest) {
  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>(
    "sessions.delete",
    request,
  );
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  return deleted;
}

async function seedSubagentWorkerSession() {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-subagent", "hello");
  await writeSessionStore({
    entries: {
      "agent:main:subagent:worker": sessionStoreEntry("sess-subagent"),
    },
  });
}

function reserveSessionRecovery(params: {
  runId: string;
  sessionKey: string;
  sessionId: string;
  storePath: string;
}): void {
  const acceptedAtMs = Date.now();
  const identity = {
    agentId: "main",
    sessionKey: params.sessionKey,
    sessionKeyAliases: [] as string[],
    sessionId: params.sessionId,
    storePath: params.storePath,
  };
  const envelope = {
    kind: "exact_turn" as const,
    approvedTurn: buildPersistedUserTurnMessage({
      text: "continue after restart",
      timestamp: acceptedAtMs,
      idempotencyKey: `${params.runId}:user`,
    }),
  };
  const sourceKey = envelope.approvedTurn.idempotencyKey;
  const ownerPrincipal = { kind: "system" as const };
  const authorization = { senderIsOwner: true };
  reserveMainRunRecovery({
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
    bootId: "test-boot",
    ownerPrincipal,
    authorization,
    envelope,
    initialLease: {
      owner: `test-admission:${params.runId}`,
      expiresAtMs: acceptedAtMs + MAIN_RUN_RECOVERY_LEASE_MS,
    },
    acceptedAtMs,
  });
  upsertMainRunRecoveryBarrier({
    aliases: [params.sessionKey],
    ledgerRunId: params.runId,
    sessionId: params.sessionId,
    storePath: params.storePath,
  });
}

function requireSessionRecovery(runId: string): MainRunRecovery {
  const recovery = getMainRunRecovery(runId);
  if (!recovery) {
    throw new Error(`missing main-run recovery ${runId}`);
  }
  return recovery;
}

function sessionRecoveryCas(recovery: MainRunRecovery): MainRunRecoveryCas {
  if (recovery.state === "terminal") {
    throw new Error(`main-run recovery ${recovery.publicRunId} is terminal`);
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

function prepareSessionRecoveryAdmission(runId: string) {
  const transcriptOwned = transitionMainRunRecoveryStateCas({
    ...sessionRecoveryCas(requireSessionRecovery(runId)),
    nextState: "transcript_owned",
    currentBootId: "test-boot",
    nowMs: Date.now(),
  });
  if (!transcriptOwned) {
    throw new Error(`failed to transfer ${runId} to transcript ownership`);
  }
  return prepareMainRunRecoveryDispatch({
    currentBootId: "test-boot",
    dispatchRunId: runId,
    recovery: transcriptOwned,
  });
}

function expectThreadBindingsUnbound(targetSessionKey: string) {
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey,
    reason: "session-delete",
  });
}

test("sessions.delete removes clean session worktrees and keeps dirty ones", async () => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-delete-worktree-"),
  );
  const workspace = await initializeRemoteBackedGitWorkspace(root);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let dirtyWorktreeId: string | undefined;
  try {
    const adminClient = { connect: { scopes: ["operator.admin"] } } as never;
    const clean = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string };
    }>("sessions.create", { agentId: "main", worktree: true }, { client: adminClient });
    expect(clean.ok).toBe(true);
    const cleanKey = clean.payload?.key;
    const cleanWorktree = clean.payload?.worktree;
    expect(cleanKey).toBeTruthy();
    expect(cleanWorktree).toBeTruthy();

    await expectSessionDeleteSucceeds({ key: cleanKey! });

    await expect(fs.access(cleanWorktree!.path)).rejects.toThrow();
    expect(getRegistryWorktree(process.env, cleanWorktree!.id)).toMatchObject({
      removedAt: expect.any(Number),
      snapshotRef: expect.stringMatching(/^refs\/openclaw\/snapshots\//),
    });

    const dirty = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string };
    }>("sessions.create", { agentId: "main", worktree: true }, { client: adminClient });
    expect(dirty.ok).toBe(true);
    const dirtyKey = dirty.payload?.key;
    const dirtyWorktree = dirty.payload?.worktree;
    dirtyWorktreeId = dirtyWorktree?.id;
    await fs.writeFile(path.join(dirtyWorktree!.path, "dirty.txt"), "keep me\n");

    await expectSessionDeleteSucceeds({ key: dirtyKey! });

    await expect(fs.access(dirtyWorktree!.path)).resolves.toBeUndefined();
    expect(getRegistryWorktree(process.env, dirtyWorktree!.id)?.removedAt).toBeUndefined();
  } finally {
    if (
      dirtyWorktreeId &&
      getRegistryWorktree(process.env, dirtyWorktreeId)?.removedAt === undefined
    ) {
      await managedWorktrees.remove({ id: dirtyWorktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    testState.agentConfig = undefined;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sessions.delete rejects main and aborts active runs", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSingleLineSession(dir, "sess-active", "active");

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:dev": sessionStoreEntry("sess-active"),
    },
  });

  embeddedRunMock.activeIds.add("sess-active");
  embeddedRunMock.waitResults.set("sess-active", true);

  const mainDelete = await directSessionReq("sessions.delete", { key: "main" });
  expect(mainDelete.ok).toBe(false);

  await expectSessionDeleteSucceeds({
    key: "discord:group:dev",
  });
  expectActiveRunCleanup(
    "agent:main:discord:group:dev",
    ["discord:group:dev", "agent:main:discord:group:dev", "sess-active"],
    "sess-active",
  );
  expect(bundleMcpRuntimeMocks.disposeSessionMcpRuntime).toHaveBeenCalledWith("sess-active");
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
  const closeTabsCall = (
    browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mock.calls as unknown as Array<
      [{ sessionKeys?: string[]; onWarn?: unknown }]
    >
  )[0]?.[0];
  expect(closeTabsCall?.sessionKeys).toHaveLength(3);
  expect(closeTabsCall?.sessionKeys).toContain("discord:group:dev");
  expect(closeTabsCall?.sessionKeys).toContain("agent:main:discord:group:dev");
  expect(closeTabsCall?.sessionKeys).toContain("sess-active");
  expect(typeof closeTabsCall?.onWarn).toBe("function");
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledWith(
    {
      targetSessionKey: "agent:main:discord:group:dev",
      targetKind: "acp",
      reason: "session-delete",
      sendFarewell: true,
      outcome: "deleted",
    },
    {
      childSessionKey: "agent:main:discord:group:dev",
    },
  );
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:discord:group:dev",
    reason: "session-delete",
  });
});

test("ordinary sessions.delete emits session_end before an unbind failure", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:ordinary-delete-unbind-failure";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("sess-ordinary-delete-unbind-failure"),
    },
  });
  const findWorktree = vi.spyOn(managedWorktrees, "findLiveByOwner");
  let worktreeLookupCalls: number;
  threadBindingMocks.unbindThreadBindingsBySessionKey.mockRejectedValueOnce(
    new Error("injected ordinary delete unbind failure"),
  );

  try {
    await expect(directSessionReq("sessions.delete", { key: sessionKey })).rejects.toThrow(
      "injected ordinary delete unbind failure",
    );
  } finally {
    worktreeLookupCalls = findWorktree.mock.calls.length;
    findWorktree.mockRestore();
  }

  expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toBeUndefined();
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
  expect(worktreeLookupCalls).toBe(0);
});

test("sessions.delete preserves locked archived sessions and deletes ordinary archived sessions", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const lockedKey = "agent:main:harness:codex:supervision:native-thread";
  const ordinaryKey = "agent:main:ordinary-archived";
  const lockedSessionId = "sess-locked-archived";
  const ordinarySessionId = "sess-ordinary-archived";
  await writeSingleLineSession(dir, lockedSessionId, "locked");
  await writeSingleLineSession(dir, ordinarySessionId, "ordinary");
  await writeSessionStore({
    entries: {
      [lockedKey]: sessionStoreEntry(lockedSessionId, {
        agentHarnessId: "codex",
        archivedAt: Date.now(),
        modelSelectionLocked: true,
      }),
      [ordinaryKey]: sessionStoreEntry(ordinarySessionId, { archivedAt: Date.now() }),
    },
  });
  const lockedEntryBefore = structuredClone(loadSessionEntry({ storePath, sessionKey: lockedKey }));
  const lockedTranscriptPath = path.join(dir, `${lockedSessionId}.jsonl`);
  const lockedTranscriptBefore = await fs.readFile(lockedTranscriptPath, "utf8");

  const rejected = await directSessionReq("sessions.delete", {
    key: lockedKey,
    archivedOnly: true,
  });
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "This session cannot be deleted while model selection is locked.",
  });
  expect(loadSessionEntry({ storePath, sessionKey: lockedKey })).toEqual(lockedEntryBefore);
  expect(await fs.readFile(lockedTranscriptPath, "utf8")).toBe(lockedTranscriptBefore);

  await expectSessionDeleteSucceeds({ key: ordinaryKey, archivedOnly: true });
  expect(loadSessionEntry({ storePath, sessionKey: ordinaryKey })).toBeUndefined();
  expect(loadSessionEntry({ storePath, sessionKey: lockedKey })).toEqual(lockedEntryBefore);
});

test("sessions.delete interrupts work admitted before runtime registration", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:subagent:worker": sessionStoreEntry("sess-subagent"),
    },
  });
  let interrupted = false;
  let releaseAdmission = () => {};
  const admissionLease = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:subagent:worker", "sess-subagent"],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
      releaseAdmission();
    },
  });
  releaseAdmission = admissionLease.release;

  const deleted = await expectSessionDeleteSucceeds({
    key: "agent:main:subagent:worker",
  });

  expect(deleted.payload?.deleted).toBe(true);
  expect(interrupted).toBe(true);
});

test("sessions.delete keeps direct recovery cancelling after cleanup failure, then settles retry", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:durable-delete";
  const sessionId = "sess-durable-delete";
  const runId = "run-delete-accepted";
  await writeSingleLineSession(dir, sessionId, "continue after restart");
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId),
    },
  });
  reserveSessionRecovery({ runId, sessionKey, sessionId, storePath });
  const recoveryClaim = prepareSessionRecoveryAdmission(runId);
  let stateWhenInterrupted: string | undefined;
  let releaseRecovery = () => {};
  const recoveryLease = await beginSessionWorkAdmission({
    scope: storePath,
    identities: recoveryClaim.admissionIdentities,
    barrierGrant: recoveryClaim.admissionGrant,
    assertAllowed: () => {},
    onInterrupt: () => {
      stateWhenInterrupted = getMainRunRecovery(runId)?.state;
      releaseRecovery();
    },
  });
  releaseRecovery = recoveryLease.release;

  embeddedRunMock.activeIds.add(sessionId);
  embeddedRunMock.waitResults.set(sessionId, false);
  const firstDelete = await directSessionReq("sessions.delete", { key: sessionKey }).finally(
    recoveryLease.release,
  );

  expect(firstDelete.ok).toBe(false);
  expect(stateWhenInterrupted).toBe("cancelling");
  expect(getMainRunRecovery(runId)).toMatchObject({
    state: "cancelling",
    cancellation: { kind: "delete", epoch: expect.any(String) },
  });
  expect(getMainRunRecovery(runId)?.envelope).toBeUndefined();

  embeddedRunMock.waitResults.set(sessionId, true);
  const retry = await expectSessionDeleteSucceeds({ key: sessionKey });

  expect(retry.payload?.deleted).toBe(true);
  expect(getMainRunRecovery(runId)).toMatchObject({
    state: "terminal",
    terminalOutcome: { status: "cancelled" },
  });
});

test("sessions.delete retries direct-store settlement after deletion commits", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:delete-settlement-retry";
  const sessionId = "sess-delete-settlement-retry";
  const runId = "run-delete-settlement-retry";
  await writeSingleLineSession(dir, sessionId, "finish deletion");
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId),
    },
  });
  reserveSessionRecovery({ runId, sessionKey, sessionId, storePath });

  const stateDb = openOpenClawStateDatabase().db;
  stateDb.exec(`
    CREATE TRIGGER fail_delete_recovery_settlement
    BEFORE UPDATE OF state ON main_run_recoveries
    WHEN OLD.public_run_id = '${runId}' AND NEW.state = 'terminal'
    BEGIN
      SELECT RAISE(ABORT, 'injected delete settlement failure');
    END;
  `);

  let replacementSessionId: string | undefined;
  let replacementEntry: unknown;
  let mcpCleanupCallsAfterCommit = 0;
  let unbindCallsAfterCommit = 0;
  let sessionEndCallsAfterCommit = 0;
  const broadcastToConnIds = vi.fn();
  const requestOptions = {
    context: {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["delete-settlement-subscriber"]),
    },
  };
  try {
    const firstDelete = await directSessionReq(
      "sessions.delete",
      { key: sessionKey },
      requestOptions,
    );
    expect(firstDelete.ok).toBe(false);
    expect(firstDelete.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toBeUndefined();
    expect(getMainRunRecovery(runId)).toMatchObject({
      state: "cancelling",
      sessionId,
    });

    replacementSessionId = "sess-delete-settlement-replacement";
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(replacementSessionId),
      },
    });
    replacementEntry = structuredClone(
      loadSessionStore(storePath, { skipCache: true })[sessionKey],
    );
    mcpCleanupCallsAfterCommit = bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mock.calls.length;
    unbindCallsAfterCommit = threadBindingMocks.unbindThreadBindingsBySessionKey.mock.calls.length;
    sessionEndCallsAfterCommit = sessionLifecycleHookMocks.runSessionEnd.mock.calls.length;
    expect(unbindCallsAfterCommit).toBe(1);
    expect(sessionEndCallsAfterCommit).toBe(1);
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(broadcastToConnIds.mock.calls[0]?.[0]).toBe("sessions.changed");
    const blockedRetry = await directSessionReq(
      "sessions.delete",
      {
        key: sessionKey,
        expectedSessionId: sessionId,
      },
      requestOptions,
    );
    expect(blockedRetry.ok).toBe(false);
    expect(blockedRetry.error).toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 1_000,
    });
    expect(blockedRetry.error?.message ?? "").toMatch(/still settling/i);
    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toEqual(replacementEntry);
    expect(bundleMcpRuntimeMocks.disposeSessionMcpRuntime).toHaveBeenCalledTimes(
      mcpCleanupCallsAfterCommit,
    );
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(
      unbindCallsAfterCommit,
    );
    expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(
      sessionEndCallsAfterCommit,
    );
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(getMainRunRecovery(runId)?.state).toBe("cancelling");
  } finally {
    stateDb.exec("DROP TRIGGER IF EXISTS fail_delete_recovery_settlement");
  }

  const retry = await directSessionReq<{ ok: true; deleted: boolean }>(
    "sessions.delete",
    {
      key: sessionKey,
      expectedSessionId: sessionId,
    },
    requestOptions,
  );

  expect(retry.ok).toBe(true);
  expect(retry.payload?.deleted).toBe(false);
  expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toEqual(replacementEntry);
  expect(bundleMcpRuntimeMocks.disposeSessionMcpRuntime).toHaveBeenCalledTimes(
    mcpCleanupCallsAfterCommit,
  );
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(
    unbindCallsAfterCommit,
  );
  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(sessionEndCallsAfterCommit);
  expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
  expect(getMainRunRecovery(runId)).toMatchObject({
    state: "terminal",
    sessionId,
    terminalOutcome: { status: "cancelled" },
  });
  if (!replacementSessionId) {
    throw new Error("expected replacement session");
  }
  const replacementAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, replacementSessionId],
    assertAllowed: () => {},
  });
  replacementAdmission.release();
});

test("sessions.delete reconciles a post-store transcript failure on exact retry", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:delete-post-store-failure";
  const sessionId = "sess-delete-post-store-failure";
  const runId = "run-delete-post-store-failure";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId),
    },
  });
  reserveSessionRecovery({ runId, sessionKey, sessionId, storePath });
  const broadcastToConnIds = vi.fn();
  const requestOptions = {
    context: {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["post-store-delete-subscriber"]),
    },
  };
  sessionArchiveFailureState.error = new Error("injected transcript archive failure");

  await expect(
    directSessionReq("sessions.delete", { key: sessionKey }, requestOptions),
  ).rejects.toThrow("injected transcript archive failure");

  expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toBeUndefined();
  expect(getMainRunRecovery(runId)?.state).toBe("cancelling");
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
  expect(broadcastToConnIds).toHaveBeenCalledTimes(1);

  const retry = await directSessionReq<{ ok: true; deleted: boolean }>(
    "sessions.delete",
    { key: sessionKey, expectedSessionId: sessionId },
    requestOptions,
  );

  expect(retry.ok).toBe(true);
  expect(retry.payload?.deleted).toBe(false);
  expect(getMainRunRecovery(runId)).toMatchObject({
    state: "terminal",
    terminalOutcome: { status: "cancelled" },
  });
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
  expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, sessionId],
    assertAllowed: () => {},
  });
  admission.release();
});

test("sessions.delete rejects a stale expected session id without interrupting its replacement", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:worker";
  const replacementSessionId = "sess-replacement";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(replacementSessionId),
    },
  });
  let interrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, replacementSessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  try {
    const deleted = await directSessionReq("sessions.delete", {
      key: sessionKey,
      expectedSessionId: "sess-stale",
    });
    expect(deleted.ok).toBe(false);
    expect(deleted.error?.message).toBe(`Session ${sessionKey} changed before deletion. Retry.`);
    expect((deleted.error as { details?: unknown } | undefined)?.details).toEqual({
      reason: "session-changed",
    });
    expect(interrupted).toBe(false);
  } finally {
    admission.release();
  }
});

test("sessions.delete rechecks its expected id before interrupting replacement work", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:worker";
  const originalSessionId = "sess-original";
  const replacementSessionId = "sess-replacement";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(originalSessionId),
    },
  });
  let replacementInterrupted = false;
  const replacementAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, replacementSessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      replacementInterrupted = true;
    },
  });
  let releaseBlockingMutation = () => {};
  let markBlockingMutationStarted = () => {};
  const blockingMutationStarted = new Promise<void>((resolve) => {
    markBlockingMutationStarted = resolve;
  });
  const blockingMutation = runExclusiveSessionLifecycleMutation({
    scope: storePath,
    identities: [sessionKey],
    run: async () => {
      markBlockingMutationStarted();
      await new Promise<void>((release) => {
        releaseBlockingMutation = release;
      });
    },
  });
  await blockingMutationStarted;

  const deletion = directSessionReq("sessions.delete", {
    key: sessionKey,
    expectedSessionId: originalSessionId,
  });
  await Promise.resolve();
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(replacementSessionId),
    },
  });
  releaseBlockingMutation();

  try {
    const [deleted] = await Promise.all([deletion, blockingMutation]);
    expect(deleted.ok).toBe(false);
    expect(replacementInterrupted).toBe(false);
  } finally {
    replacementAdmission.release();
  }
});

test("sessions.delete rejects a replacement with the same updated-at timestamp", async () => {
  const sessionKey = "agent:main:cron:cleanup";
  const updatedAt = 1_737_600_000_000;
  const { storePath } = await createSessionStoreDir();
  await replaceSessionEntry(
    { sessionKey, storePath },
    {
      ...sessionStoreEntry("replacement-run", {
        lifecycleRevision: "replacement-revision",
        updatedAt,
      }),
    },
  );
  let interrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, "replacement-run"],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  try {
    const deleted = await directSessionReq("sessions.delete", {
      key: sessionKey,
      expectedSessionId: "stale-run",
      expectedLifecycleRevision: "stale-revision",
      expectedSessionUpdatedAt: updatedAt,
    });

    expect(deleted.ok).toBe(false);
    expect(interrupted).toBe(false);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      lifecycleRevision: "replacement-revision",
      sessionId: "replacement-run",
      updatedAt,
    });
  } finally {
    admission.release();
  }
});

test("sessions.delete includes cleanup-owned row changes in its guarded deletion", async () => {
  const sessionKey = "agent:main:cron:cleanup";
  const sessionId = "sess-cleanup";
  const lifecycleRevision = "cleanup-revision";
  const updatedAt = 1_737_600_000_000;
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision, updatedAt }),
    },
  });
  bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockImplementationOnce(async () => {
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, {
          label: "cleanup-owned revision",
          lifecycleRevision,
          updatedAt: updatedAt + 1,
        }),
      },
    });
  });

  const deleted = await expectSessionDeleteSucceeds({
    key: sessionKey,
    expectedSessionId: sessionId,
    expectedLifecycleRevision: lifecycleRevision,
    expectedSessionUpdatedAt: updatedAt,
  });

  expect(deleted.payload?.deleted).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
});

test("sessions.delete serializes a patch behind asynchronous runtime cleanup", async () => {
  const sessionKey = "agent:main:subagent:worker";
  const sessionId = "sess-subagent";
  const updatedAt = 1_737_600_000_000;
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { updatedAt }),
    },
  });
  let releaseRuntimeCleanup = () => {};
  const runtimeCleanupStarted = new Promise<void>((resolve) => {
    bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockImplementationOnce(async () => {
      resolve();
      await new Promise<void>((release) => {
        releaseRuntimeCleanup = release;
      });
    });
  });

  const deletion = directSessionReq("sessions.delete", {
    key: sessionKey,
    expectedSessionId: sessionId,
    expectedSessionUpdatedAt: updatedAt,
  });
  await runtimeCleanupStarted;
  let patchSettled = false;
  const patch = directSessionReq("sessions.patch", {
    key: sessionKey,
    label: "updated during cleanup",
  }).then((result) => {
    patchSettled = true;
    return result;
  });
  await Promise.resolve();
  expect(patchSettled).toBe(false);
  releaseRuntimeCleanup();

  const [deleted, patched] = await Promise.all([deletion, patch]);
  expect(deleted.ok).toBe(true);
  expect(patched.ok).toBe(false);
  expect(patched.error?.message).toBe(`Session ${sessionKey} changed before patch. Retry.`);
  expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
});

test("sessions.patch waits for an in-flight session lifecycle mutation", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:worker";
  const sessionId = "sess-subagent";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId),
    },
  });
  let releaseMutation = () => {};
  let markMutationStarted = () => {};
  const mutationStarted = new Promise<void>((resolve) => {
    markMutationStarted = resolve;
  });
  const mutation = runExclusiveSessionLifecycleMutation({
    scope: storePath,
    identities: [sessionKey, sessionId],
    run: async () => {
      markMutationStarted();
      await new Promise<void>((release) => {
        releaseMutation = release;
      });
    },
  });
  await mutationStarted;
  let patchSettled = false;
  const patch = directSessionReq("sessions.patch", {
    key: sessionKey,
    label: "after lifecycle mutation",
  }).then((result) => {
    patchSettled = true;
    return result;
  });
  await Promise.resolve();
  expect(patchSettled).toBe(false);
  releaseMutation();

  const [patched] = await Promise.all([patch, mutation]);
  expect(patched.ok).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })?.label).toBe("after lifecycle mutation");
});

test("sessions.delete keeps lifecycle admission blocked through session unbinding", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:worker";
  const sessionId = "sess-subagent";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId),
    },
  });
  let releaseUnbind = () => {};
  const unbindStarted = new Promise<void>((resolve) => {
    threadBindingMocks.unbindThreadBindingsBySessionKey.mockImplementationOnce(async () => {
      resolve();
      await new Promise<void>((release) => {
        releaseUnbind = release;
      });
      return [];
    });
  });

  const deletion = directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: sessionKey,
  });
  await unbindStarted;
  let replacementAdmitted = false;
  const replacement = beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, sessionId],
    assertAllowed: () => {},
  }).then((lease) => {
    replacementAdmitted = true;
    return lease;
  });
  await Promise.resolve();
  expect(replacementAdmitted).toBe(false);

  releaseUnbind();
  const [deleted, replacementAdmission] = await Promise.all([deletion, replacement]);
  try {
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(replacementAdmitted).toBe(true);
  } finally {
    replacementAdmission.release();
  }
});

test("sessions.patch rejects archiving active runs", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "discord:group:dev": sessionStoreEntry("sess-active"),
    },
  });
  embeddedRunMock.activeIds.add("sess-active");

  const archived = await directSessionReq("sessions.patch", {
    key: "discord:group:dev",
    archived: true,
  });

  expect(archived.ok).toBe(false);
  expect(archived.error).toMatchObject({
    message: "Cannot archive a session with an active run.",
  });
});

test("sessions.delete limits plugin-runtime cleanup to sessions owned by that plugin", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-owned", "owned");
  await writeSingleLineSession(dir, "sess-foreign", "foreign");

  await writeSessionStore({
    entries: {
      "agent:main:dreaming-narrative-owned": sessionStoreEntry("sess-owned", {
        pluginOwnerId: "memory-core",
      }),
      "agent:main:dreaming-narrative-foreign": sessionStoreEntry("sess-foreign", {
        pluginOwnerId: "other-plugin",
      }),
    },
  });

  const pluginClient = {
    connect: {
      scopes: ["operator.admin"],
    },
    internal: {
      pluginRuntimeOwnerId: "memory-core",
    },
  } as never;
  let foreignWorkInterrupted = false;
  const foreignAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:dreaming-narrative-foreign", "sess-foreign"],
    assertAllowed: () => {},
    onInterrupt: () => {
      foreignWorkInterrupted = true;
    },
  });

  try {
    const denied = await directSessionReq(
      "sessions.delete",
      {
        key: "agent:main:dreaming-narrative-foreign",
      },
      {
        client: pluginClient,
      },
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.message).toContain("did not create it");
    expect(foreignWorkInterrupted).toBe(false);
  } finally {
    foreignAdmission.release();
  }

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>(
    "sessions.delete",
    {
      key: "agent:main:dreaming-narrative-owned",
    },
    {
      client: pluginClient,
    },
  );
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
});

test("sessions.delete scopes selected global deletes to the requested agent", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ writePrimeStore: true });

  await expectSessionDeleteSucceeds({
    key: "global",
    agentId: "work",
    deleteTranscript: false,
  });
  expect(
    loadSessionEntry({
      agentId: "main",
      sessionKey: "global",
      storePath: globalStores.mainStorePath,
    })?.sessionId,
  ).toBe("sess-main-global");
  expect(
    loadSessionEntry({
      agentId: "work",
      sessionKey: "global",
      storePath: globalStores.workStorePath,
    }),
  ).toBeUndefined();
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});

test("sessions.delete closes ACP runtime handles before removing ACP sessions", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSingleLineSession(dir, "sess-acp", "acp");

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:dev": sessionStoreEntry("sess-acp"),
    },
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:discord:group:dev",
    meta: {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime:delete",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    },
  });
  await expectSessionDeleteSucceeds({
    key: "discord:group:dev",
  });
  expect(acpManagerMocks.closeSession).toHaveBeenCalledTimes(1);
  const closeSessionCall = (
    acpManagerMocks.closeSession.mock.calls as unknown as Array<
      [
        {
          allowBackendUnavailable?: boolean;
          cfg?: unknown;
          discardPersistentState?: boolean;
          requireAcpSession?: boolean;
          reason?: string;
          sessionKey?: string;
        },
      ]
    >
  )[0]?.[0];
  expect(closeSessionCall?.allowBackendUnavailable).toBe(true);
  expectObject(closeSessionCall?.cfg);
  expect(closeSessionCall?.discardPersistentState).toBe(true);
  expect(closeSessionCall?.requireAcpSession).toBe(false);
  expect(closeSessionCall?.reason).toBe("session-delete");
  expect(closeSessionCall?.sessionKey).toBe("agent:main:discord:group:dev");

  expect(acpManagerMocks.cancelSession).toHaveBeenCalledTimes(1);
  const cancelSessionCall = (
    acpManagerMocks.cancelSession.mock.calls as unknown as Array<
      [{ cfg?: unknown; reason?: string; sessionKey?: string }]
    >
  )[0]?.[0];
  expectObject(cancelSessionCall?.cfg);
  expect(cancelSessionCall?.reason).toBe("session-delete");
  expect(cancelSessionCall?.sessionKey).toBe("agent:main:discord:group:dev");
  expect(readAcpSessionMeta({ sessionKey: "agent:main:discord:group:dev" })).toBeUndefined();
});

test("sessions.delete closes child ACP runtimes spawned from the deleted parent", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSingleLineSession(dir, "sess-parent", "parent");
  await writeSingleLineSession(dir, "sess-child", "child");

  const acpMeta = (recordId: string) => ({
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: `runtime:${recordId}`,
    mode: "oneshot" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  });

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "acp-parent": sessionStoreEntry("sess-parent"),
      "acp-child": sessionStoreEntry("sess-child", {
        spawnedBy: "agent:main:acp-parent",
      }),
    },
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:acp-parent",
    meta: acpMeta("agent:main:acp-parent"),
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:acp-child",
    meta: acpMeta("agent:main:acp-child"),
  });

  await expectSessionDeleteSucceeds({
    key: "acp-parent",
  });

  // Deleting the parent must also close its spawned ACP child, not just its own
  // runtime, otherwise the child's claude-agent-acp process is orphaned (#68916).
  const closedKeys = (
    acpManagerMocks.closeSession.mock.calls as unknown as Array<[{ sessionKey?: string }]>
  ).map((call) => call[0]?.sessionKey);
  expect(closedKeys).toContain("agent:main:acp-parent");
  expect(closedKeys).toContain("agent:main:acp-child");
  expect(readAcpSessionMeta({ sessionKey: "agent:main:acp-parent" })).toBeUndefined();
  expect(readAcpSessionMeta({ sessionKey: "agent:main:acp-child" })).toBeUndefined();
});

test("sessions.delete emits session_end with deleted reason and no replacement", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:delete": sessionStoreEntry("sess-delete"),
    },
  });

  await expectSessionDeleteSucceeds({
    key: "discord:group:delete",
  });
  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();

  const [event, context] = (
    sessionLifecycleHookMocks.runSessionEnd.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  expect((event as { sessionId?: string } | undefined)?.sessionId).toBe("sess-delete");
  expect((event as { sessionKey?: string } | undefined)?.sessionKey).toBe(
    "agent:main:discord:group:delete",
  );
  expect((event as { reason?: string } | undefined)?.reason).toBe("deleted");
  expect(
    (event as { transcriptArchived?: boolean } | undefined)?.transcriptArchived,
  ).toBeUndefined();
  expect((event as { sessionFile?: string } | undefined)?.sessionFile).toBeUndefined();
  expect((event as { nextSessionId?: string } | undefined)?.nextSessionId).toBeUndefined();
  expect((context as { sessionId?: string } | undefined)?.sessionId).toBe("sess-delete");
  expect((context as { sessionKey?: string } | undefined)?.sessionKey).toBe(
    "agent:main:discord:group:delete",
  );
  expect((context as { agentId?: string } | undefined)?.agentId).toBe("main");
});

test("sessions.delete does not emit lifecycle events when nothing was deleted", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "agent:main:subagent:missing",
  });

  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(false);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();
});

test("sessions.delete emits subagent targetKind for subagent sessions", async () => {
  await seedSubagentWorkerSession();

  await expectSessionDeleteSucceeds({
    key: "agent:main:subagent:worker",
  });
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  const event = (subagentLifecycleHookMocks.runSubagentEnded.mock.calls as unknown[][])[0]?.[0] as
    | { targetKind?: string; targetSessionKey?: string; reason?: string; outcome?: string }
    | undefined;
  expect(event?.targetSessionKey).toBe("agent:main:subagent:worker");
  expect(event?.targetKind).toBe("subagent");
  expect(event?.reason).toBe("session-delete");
  expect(event?.outcome).toBe("deleted");
  expectThreadBindingsUnbound("agent:main:subagent:worker");
});

test("sessions.delete can skip lifecycle hooks while still unbinding thread bindings", async () => {
  await seedSubagentWorkerSession();

  await expectSessionDeleteSucceeds({
    key: "agent:main:subagent:worker",
    emitLifecycleHooks: false,
  });
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expectThreadBindingsUnbound("agent:main:subagent:worker");
});

test("sessions.delete directly unbinds thread bindings when hooks are unavailable", async () => {
  await seedSubagentWorkerSession();
  subagentLifecycleHookState.hasSubagentEndedHook = false;

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "agent:main:subagent:worker",
  });
  expect(deleted.ok).toBe(true);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expectThreadBindingsUnbound("agent:main:subagent:worker");
});

test("sessions.delete returns unavailable when active run does not stop", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-active", "active");

  await writeSessionStore({
    entries: {
      "discord:group:dev": sessionStoreEntry("sess-active"),
    },
  });

  embeddedRunMock.activeIds.add("sess-active");
  embeddedRunMock.waitResults.set("sess-active", false);

  const { ws } = await openClient();

  const deleted = await rpcReq(ws, "sessions.delete", {
    key: "discord:group:dev",
  });
  expect(deleted.ok).toBe(false);
  expect(deleted.error).toMatchObject({
    code: "UNAVAILABLE",
    retryable: true,
    retryAfterMs: 1_000,
  });
  expect(deleted.error?.message ?? "").toMatch(/still active/i);
  expectActiveRunCleanup(
    "agent:main:discord:group:dev",
    ["discord:group:dev", "agent:main:discord:group:dev", "sess-active"],
    "sess-active",
  );
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

  const storedEntry = loadSessionEntry({
    sessionKey: "agent:main:discord:group:dev",
    storePath,
  });
  expect(storedEntry?.sessionId).toBe("sess-active");
  const filesAfterDeleteAttempt = await fs.readdir(dir);
  expect(
    filesAfterDeleteAttempt.filter((fileName) => fileName.startsWith("sess-active.jsonl.deleted.")),
  ).toEqual([]);

  ws.close();
});
