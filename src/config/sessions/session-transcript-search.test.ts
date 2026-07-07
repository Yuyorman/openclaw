// Session transcript FTS tests cover append indexing, filtered content, and reconcile cleanup.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  emitInternalSessionTranscriptUpdate,
  emitSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { appendTranscriptMessage } from "./session-accessor.js";
import {
  reconcileSessionTranscriptIndex,
  resetSessionTranscriptSearchForTest,
  searchSessionTranscripts,
  waitForSessionTranscriptIndexForTest,
  waitForSessionTranscriptReconcileForTest,
} from "./session-transcript-search.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";

const config = {};
let previousStateDir: string | undefined;
let tempRoot = "";
let sessionsDir = "";

async function writeStore(
  entries: Record<string, { sessionFile?: string; sessionId: string; updatedAt: number }>,
): Promise<void> {
  await fsp.mkdir(sessionsDir, { recursive: true });
  await fsp.writeFile(path.join(sessionsDir, "sessions.json"), JSON.stringify(entries));
}

describe("session transcript search index", () => {
  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const created = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-session-search-"));
    tempRoot = await fsp.realpath(created);
    sessionsDir = path.join(tempRoot, "agents", "main", "sessions");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempRoot);
    resetSessionTranscriptSearchForTest();
    closeOpenClawAgentDatabasesForTest();
  });

  afterEach(async () => {
    await waitForSessionTranscriptIndexForTest();
    await waitForSessionTranscriptReconcileForTest();
    closeOpenClawAgentDatabasesForTest();
    resetSessionTranscriptSearchForTest();
    if (previousStateDir === undefined) {
      deleteTestEnvValue("OPENCLAW_STATE_DIR");
    } else {
      setTestEnvValue("OPENCLAW_STATE_DIR", previousStateDir);
    }
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it("rejects empty and oversized queries before FTS parsing", () => {
    expect(() => searchSessionTranscripts({ agentId: "main", config, query: "" })).toThrow(
      "query must not be empty",
    );
    expect(() =>
      searchSessionTranscripts({ agentId: "main", config, query: "x".repeat(4097) }),
    ).toThrow("query must not exceed 4096 characters");
  });

  it("indexes appended user and assistant text but skips tools, thinking, and images", async () => {
    const sessionId = "append-session";
    const sessionKey = "agent:main:direct:append";
    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeStore({
      [sessionKey]: { sessionId, sessionFile: transcriptPath, updatedAt: 1 },
    });
    searchSessionTranscripts({ agentId: "main", config, query: "not-indexed-yet" });
    await waitForSessionTranscriptReconcileForTest();

    await appendSessionTranscriptMessage({
      transcriptPath,
      sessionId,
      sessionKey,
      now: 1_000,
      message: { role: "user", content: "alpha needle from user" },
    });
    const immediate = searchSessionTranscripts({ agentId: "main", config, query: "needle" });
    expect(immediate.indexing || immediate.hits.length > 0).toBe(true);
    await appendSessionTranscriptMessage({
      transcriptPath,
      sessionId,
      sessionKey,
      now: 2_000,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "beta needle from assistant" }],
      },
    });
    await appendSessionTranscriptMessage({
      transcriptPath,
      sessionId,
      sessionKey,
      message: { role: "tool", content: [{ type: "text", text: "tool-only-token" }] },
    });
    await appendSessionTranscriptMessage({
      transcriptPath,
      sessionId,
      sessionKey,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thinking-only-token" },
          { type: "image", data: "image-only-token" },
        ],
      },
    });
    await waitForSessionTranscriptIndexForTest();

    const result = searchSessionTranscripts({
      agentId: "main",
      config,
      query: "needle",
    });
    expect(result.hits).toEqual([
      expect.objectContaining({
        sessionKey,
        role: "assistant",
        timestamp: 2_000,
        snippet: expect.stringContaining("beta needle"),
      }),
      expect.objectContaining({
        sessionKey,
        role: "user",
        timestamp: 1_000,
        snippet: expect.stringContaining("alpha needle"),
      }),
    ]);
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "needle", limit: 1 }),
    ).toMatchObject({ hits: [expect.objectContaining({ role: "assistant" })], truncated: true });
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "tool-only-token" }).hits,
    ).toEqual([]);
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "thinking-only-token" }).hits,
    ).toEqual([]);
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "image-only-token" }).hits,
    ).toEqual([]);
  });

  it("filters one FTS query to multiple session keys", async () => {
    searchSessionTranscripts({ agentId: "main", config, query: "warm-index" });
    await waitForSessionTranscriptReconcileForTest();
    const insert = openOpenClawAgentDatabase({ agentId: "main" }).db.prepare(
      "INSERT INTO session_transcript_fts (text, session_key, session_id, message_id, role, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const [index, sessionKey] of [
      "agent:main:one",
      "agent:main:two",
      "agent:main:three",
    ].entries()) {
      insert.run(
        "shared-filter-token",
        sessionKey,
        `session-${index}`,
        `message-${index}`,
        "user",
        index,
      );
    }

    const result = searchSessionTranscripts({
      agentId: "main",
      config,
      query: "shared-filter-token",
      sessionKeys: ["agent:main:one", "agent:main:three"],
    });

    expect(result.hits.map((entry) => entry.sessionKey).toSorted()).toEqual([
      "agent:main:one",
      "agent:main:three",
    ]);
  });

  it("uses the resolved agent for unscoped append indexing", async () => {
    const transcriptPath = path.join(sessionsDir, "work-global.jsonl");

    await appendSessionTranscriptMessage({
      agentId: "work",
      transcriptPath,
      sessionId: "work-global",
      sessionKey: "global",
      message: { role: "user", content: "resolved-work-agent-token" },
    });
    await waitForSessionTranscriptIndexForTest();

    const workRows = openOpenClawAgentDatabase({ agentId: "work" })
      .db.prepare("SELECT text FROM session_transcript_fts")
      .all();
    const mainRows = openOpenClawAgentDatabase({ agentId: "main" })
      .db.prepare("SELECT text FROM session_transcript_fts")
      .all();
    expect(workRows).toEqual([expect.objectContaining({ text: "resolved-work-agent-token" })]);
    expect(mainRows).toEqual([]);
  });

  it("backfills pre-existing transcripts and removes deleted transcript rows", async () => {
    const sessionId = "backfill-session";
    const sessionKey = "agent:main:direct:backfill";
    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeStore({ [sessionKey]: { sessionId, updatedAt: 1 } });
    await fsp.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", id: sessionId }),
        JSON.stringify({
          type: "message",
          id: "backfill-message",
          timestamp: "2026-01-02T03:04:05.000Z",
          message: { role: "user", content: "reconcile-only-token" },
        }),
        "",
      ].join("\n"),
    );

    await reconcileSessionTranscriptIndex({ agentId: "main", config });
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "reconcile-only-token" }).hits,
    ).toEqual([
      expect.objectContaining({
        sessionId,
        messageId: "backfill-message",
        sessionKey,
      }),
    ]);

    await appendSessionTranscriptMessage({
      transcriptPath,
      sessionId,
      sessionKey,
      message: { role: "assistant", content: "post-migration-append-token" },
    });
    await waitForSessionTranscriptIndexForTest();
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "post-migration-append-token" })
        .hits,
    ).toEqual([expect.objectContaining({ sessionId, sessionKey })]);

    await fsp.rm(transcriptPath);
    await reconcileSessionTranscriptIndex({ agentId: "main", config });
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "reconcile-only-token" }).hits,
    ).toEqual([]);
  });

  it("skips sessions owned by another agent in a shared store", async () => {
    const mainPath = path.join(sessionsDir, "shared-main.jsonl");
    const workPath = path.join(sessionsDir, "shared-work.jsonl");
    await writeStore({
      "agent:main:shared": { sessionId: "shared-main", sessionFile: mainPath, updatedAt: 1 },
      "agent:work:shared": { sessionId: "shared-work", sessionFile: workPath, updatedAt: 2 },
    });
    for (const [transcriptPath, sessionId, token] of [
      [mainPath, "shared-main", "shared-main-token"],
      [workPath, "shared-work", "shared-work-token"],
    ] as const) {
      await fsp.writeFile(
        transcriptPath,
        `${JSON.stringify({
          type: "message",
          id: `${sessionId}-message`,
          message: { role: "user", content: token },
        })}\n`,
      );
    }

    await reconcileSessionTranscriptIndex({ agentId: "main", config });

    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "shared-main-token" }).hits,
    ).toEqual([expect.objectContaining({ sessionId: "shared-main" })]);
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "shared-work-token" }).hits,
    ).toEqual([]);
  });

  it("indexes only the freshest row for a canonical key duplicated across stores", async () => {
    const sessionKey = "agent:main:duplicate";
    const stalePath = path.join(sessionsDir, "duplicate-stale.jsonl");
    const customStorePath = path.join(tempRoot, "custom", "main", "sessions.json");
    const freshPath = path.join(path.dirname(customStorePath), "duplicate-fresh.jsonl");
    await writeStore({
      [sessionKey]: { sessionId: "duplicate-stale", sessionFile: stalePath, updatedAt: 1 },
    });
    await fsp.mkdir(path.dirname(customStorePath), { recursive: true });
    await fsp.writeFile(
      customStorePath,
      JSON.stringify({
        [sessionKey]: { sessionId: "duplicate-fresh", sessionFile: freshPath, updatedAt: 2 },
      }),
    );
    await fsp.writeFile(
      stalePath,
      `${JSON.stringify({
        type: "message",
        id: "stale-message",
        message: { role: "user", content: "shadowed-duplicate-token" },
      })}\n`,
    );
    await fsp.writeFile(
      freshPath,
      `${JSON.stringify({
        type: "message",
        id: "fresh-message",
        message: { role: "user", content: "fresh-duplicate-token" },
      })}\n`,
    );
    const duplicateStoreConfig = { session: { store: customStorePath } };

    await reconcileSessionTranscriptIndex({ agentId: "main", config: duplicateStoreConfig });

    expect(
      searchSessionTranscripts({
        agentId: "main",
        config: duplicateStoreConfig,
        query: "fresh-duplicate-token",
      }).hits,
    ).toEqual([expect.objectContaining({ sessionId: "duplicate-fresh", sessionKey })]);
    expect(
      searchSessionTranscripts({
        agentId: "main",
        config: duplicateStoreConfig,
        query: "shadowed-duplicate-token",
      }).hits,
    ).toEqual([]);
  });

  it("does not orphan a session added while reconcile uses an older store snapshot", async () => {
    const existingId = "existing-reconcile-session";
    const existingKey = "agent:main:direct:existing-reconcile";
    const addedId = "added-during-reconcile-session";
    const addedKey = "agent:main:direct:added-during-reconcile";
    const existingPath = path.join(sessionsDir, `${existingId}.jsonl`);
    const addedPath = path.join(sessionsDir, `${addedId}.jsonl`);
    await writeStore({ [existingKey]: { sessionId: existingId, updatedAt: 1 } });
    await fsp.writeFile(
      existingPath,
      `${JSON.stringify({
        type: "message",
        id: "existing-message",
        message: { role: "user", content: "existing-reconcile-token" },
      })}\n`,
    );

    const reconcile = reconcileSessionTranscriptIndex({ agentId: "main", config });
    await writeStore({
      [existingKey]: { sessionId: existingId, updatedAt: 1 },
      [addedKey]: { sessionId: addedId, sessionFile: addedPath, updatedAt: 2 },
    });
    await appendSessionTranscriptMessage({
      transcriptPath: addedPath,
      sessionId: addedId,
      sessionKey: addedKey,
      message: { role: "assistant", content: "added-during-reconcile-token" },
    });
    await waitForSessionTranscriptIndexForTest();
    await reconcile;

    expect(
      searchSessionTranscripts({
        agentId: "main",
        config,
        query: "added-during-reconcile-token",
      }).hits,
    ).toEqual([expect.objectContaining({ sessionId: addedId, sessionKey: addedKey })]);
  });

  it("continues reconciling after one transcript fails", async () => {
    const failedKey = "agent:main:a-failed";
    const healthyKey = "agent:main:z-healthy";
    const failedPath = path.join(sessionsDir, "failed.jsonl");
    const healthyPath = path.join(sessionsDir, "healthy.jsonl");
    await writeStore({
      [failedKey]: { sessionId: "failed", sessionFile: failedPath, updatedAt: 1 },
      [healthyKey]: { sessionId: "healthy", sessionFile: healthyPath, updatedAt: 2 },
    });
    await fsp.writeFile(
      failedPath,
      [
        JSON.stringify({ type: "session", id: "failed" }),
        JSON.stringify({
          type: "message",
          id: "failed-message",
          message: { role: "user", content: "failed-retry-token" },
        }),
        "",
      ].join("\n"),
    );
    await fsp.writeFile(
      healthyPath,
      [
        JSON.stringify({ type: "session", id: "healthy" }),
        JSON.stringify({
          type: "message",
          id: "healthy-message",
          message: { role: "user", content: "healthy-after-failure-token" },
        }),
        "",
      ].join("\n"),
    );
    const open = vi.spyOn(fsp, "open").mockRejectedValueOnce(new Error("simulated read failure"));

    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "failed-retry-token" }).indexing,
    ).toBe(true);
    await waitForSessionTranscriptReconcileForTest();
    open.mockRestore();

    const indexedKeys = openOpenClawAgentDatabase({ agentId: "main" })
      .db.prepare("SELECT session_key FROM session_transcript_fts")
      .all()
      .map((row) => (row as { session_key: string }).session_key);
    expect(indexedKeys).toContain(healthyKey);
    expect(indexedKeys).not.toContain(failedKey);

    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "failed-retry-token" }).indexing,
    ).toBe(true);
    await waitForSessionTranscriptReconcileForTest();
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "failed-retry-token" }),
    ).toMatchObject({
      hits: [expect.objectContaining({ sessionKey: failedKey })],
      indexing: false,
    });
  });

  it("indexes only the active branch and skips oversized non-text records", async () => {
    const sessionId = "branched-session";
    const sessionKey = "agent:main:direct:branched";
    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeStore({ [sessionKey]: { sessionId, updatedAt: 1 } });
    await fsp.writeFile(
      transcriptPath,
      [
        { type: "session", id: sessionId },
        {
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "active-root-token" },
        },
        {
          type: "message",
          id: "abandoned",
          parentId: "root",
          message: { role: "assistant", content: "abandoned-branch-token" },
        },
        {
          type: "message",
          id: "oversized-tool",
          parentId: "root",
          message: { role: "tool", content: "x".repeat(300_000) },
        },
        {
          type: "message",
          id: "active-tail",
          parentId: "oversized-tool",
          message: { role: "assistant", content: "active-tail-token" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    await reconcileSessionTranscriptIndex({ agentId: "main", config });
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "active-tail-token" }).hits,
    ).toEqual([expect.objectContaining({ messageId: "active-tail" })]);
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "abandoned-branch-token" }).hits,
    ).toEqual([]);
  });

  it("does not hang on cyclic leaf-control metadata", async () => {
    const sessionId = "cyclic-session";
    const sessionKey = "agent:main:direct:cyclic";
    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeStore({ [sessionKey]: { sessionId, updatedAt: 1 } });
    await fsp.writeFile(
      transcriptPath,
      [
        { type: "session", id: sessionId },
        { type: "message", id: "a", parentId: null, message: { role: "user", content: "root" } },
        { type: "leaf", id: "b", parentId: "a", targetId: "a" },
        { type: "leaf", id: "a", parentId: "b", targetId: "b" },
        {
          type: "message",
          id: "after-cycle",
          parentId: "a",
          message: { role: "assistant", content: "cyclic-metadata-token" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    await reconcileSessionTranscriptIndex({ agentId: "main", config });

    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "cyclic-metadata-token" }).hits,
    ).toEqual([]);
  });

  it("rebuilds a multi-slice branch without retaining the abandoned path", async () => {
    const sessionId = "large-branched-session";
    const sessionKey = "agent:main:direct:large-branched";
    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeStore({ [sessionKey]: { sessionId, updatedAt: 1 } });
    const entries: Array<Record<string, unknown>> = [
      { type: "session", id: sessionId },
      {
        type: "message",
        id: "large-root",
        parentId: null,
        message: { role: "user", content: "large-active-root-token" },
      },
      {
        type: "message",
        id: "large-abandoned",
        parentId: "large-root",
        message: { role: "assistant", content: "large-abandoned-token" },
      },
      {
        type: "leaf",
        id: "large-leaf",
        parentId: "large-abandoned",
        targetId: "large-root",
      },
    ];
    let parentId = "large-leaf";
    for (let index = 0; index < 20; index += 1) {
      const id = `large-tool-${index}`;
      entries.push({
        type: "message",
        id,
        parentId,
        message: { role: "tool", content: `padding-${index}-${"x".repeat(60_000)}` },
      });
      parentId = id;
    }
    entries.push({
      type: "message",
      id: "large-active-tail",
      parentId,
      message: { role: "assistant", content: "large-active-tail-token" },
    });
    await fsp.writeFile(
      transcriptPath,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );

    await reconcileSessionTranscriptIndex({ agentId: "main", config });

    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "large-active-tail-token" }).hits,
    ).toEqual([expect.objectContaining({ messageId: "large-active-tail" })]);
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "large-abandoned-token" }).hits,
    ).toEqual([]);
  });

  it("indexes appends under the resolved canonical session key", async () => {
    const sessionId = "alias-session";
    const sessionKey = "agent:main:main";
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore({ [sessionKey]: { sessionId, updatedAt: 1 } });

    await appendTranscriptMessage(
      { agentId: "main", sessionId, sessionKey: "Agent:Main:Main", storePath },
      { config, message: { role: "user", content: "canonical-alias-token" } },
    );
    await waitForSessionTranscriptIndexForTest();

    const indexed = openOpenClawAgentDatabase({ agentId: "main" })
      .db.prepare("SELECT session_key, text FROM session_transcript_fts")
      .all();
    expect(indexed).toEqual([
      expect.objectContaining({ session_key: sessionKey, text: "canonical-alias-token" }),
    ]);

    expect(
      searchSessionTranscripts({
        agentId: "main",
        config,
        query: "canonical-alias-token",
        sessionKeys: [sessionKey],
      }).hits,
    ).toEqual([expect.objectContaining({ sessionKey })]);
  });

  it("indexes common SessionManager writes after the transcript is reconciled", async () => {
    const sessionId = "session-manager-session";
    const sessionKey = "agent:main:direct:session-manager";
    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "session-manager-index-token" }),
    ).toMatchObject({ hits: [], indexing: true });
    await waitForSessionTranscriptReconcileForTest();

    await writeStore({ [sessionKey]: { sessionId, sessionFile: transcriptPath, updatedAt: 1 } });
    await fsp.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-01-02T03:04:05.000Z",
          cwd: tempRoot,
        }),
        JSON.stringify({
          type: "message",
          id: "session-manager-user",
          parentId: null,
          timestamp: "2026-01-02T03:04:06.000Z",
          message: { role: "user", content: "question before SessionManager append" },
        }),
        "",
      ].join("\n"),
    );
    const manager = SessionManager.open(transcriptPath, sessionsDir, tempRoot);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "session-manager-index-token" }],
      api: "messages",
      provider: "anthropic",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2_000,
    });
    await waitForSessionTranscriptIndexForTest();

    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "session-manager-index-token" }),
    ).toMatchObject({ hits: [], indexing: true });
    await waitForSessionTranscriptReconcileForTest();
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "session-manager-index-token" })
        .hits,
    ).toEqual([expect.objectContaining({ sessionId, sessionKey, role: "assistant" })]);
  });

  it("rebuilds a larger replacement discovered by restart reconciliation", async () => {
    const sessionId = "growing-rewrite-session";
    const sessionKey = "agent:main:direct:growing-rewrite";
    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeStore({ [sessionKey]: { sessionId, sessionFile: transcriptPath, updatedAt: 1 } });
    await appendSessionTranscriptMessage({
      transcriptPath,
      sessionId,
      sessionKey,
      message: { role: "user", content: "retired-current-token" },
    });
    await waitForSessionTranscriptIndexForTest();
    resetSessionTranscriptSearchForTest();

    await fsp.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        id: "growing-replacement-message",
        timestamp: "2026-01-02T04:00:00.000Z",
        message: {
          role: "assistant",
          content: "replacement-current-token with enough padding to exceed the previous file size",
        },
      })}\n`,
    );
    await reconcileSessionTranscriptIndex({ agentId: "main", config });

    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "retired-current-token" }).hits,
    ).toEqual([]);
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "replacement-current-token" })
        .hits,
    ).toEqual([expect.objectContaining({ messageId: "growing-replacement-message", sessionKey })]);
  });

  it("invalidates archived rows and indexes a replacement transcript", async () => {
    const sessionId = "reset-session";
    const sessionKey = "agent:main:direct:reset";
    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeStore({
      [sessionKey]: { sessionId, sessionFile: transcriptPath, updatedAt: 1 },
    });
    await appendSessionTranscriptMessage({
      transcriptPath,
      sessionId,
      sessionKey,
      message: { role: "user", content: "retired-reset-token" },
    });
    await waitForSessionTranscriptIndexForTest();
    resetSessionTranscriptSearchForTest();

    const archivedPath = `${transcriptPath}.reset.2026-01-02T03-04-05.000Z`;
    await fsp.rename(transcriptPath, archivedPath);
    emitSessionTranscriptUpdate({ sessionFile: archivedPath });
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "retired-reset-token" }).hits,
    ).toEqual([]);
    await waitForSessionTranscriptReconcileForTest();

    await fsp.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        id: "replacement-message",
        timestamp: "2026-01-02T04:00:00.000Z",
        message: { role: "assistant", content: "replacement-reset-token" },
      })}\n`,
    );
    emitSessionTranscriptUpdate({ sessionFile: transcriptPath });
    await waitForSessionTranscriptIndexForTest();
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "replacement-reset-token" }).hits,
    ).toEqual([expect.objectContaining({ messageId: "replacement-message", sessionKey })]);
  });

  it("invalidates replaced transcript rows before rebuilding", async () => {
    const sessionId = "replace-session";
    const sessionKey = "agent:main:direct:replace";
    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeStore({ [sessionKey]: { sessionId, sessionFile: transcriptPath, updatedAt: 1 } });
    await appendSessionTranscriptMessage({
      transcriptPath,
      sessionId,
      sessionKey,
      message: { role: "user", content: "stale-replacement-token" },
    });
    await waitForSessionTranscriptIndexForTest();
    resetSessionTranscriptSearchForTest();
    await fsp.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        id: "current-replacement-message",
        message: { role: "assistant", content: "current-replacement-token" },
      })}\n`,
    );

    emitInternalSessionTranscriptUpdate({
      sessionFile: transcriptPath,
      target: { agentId: "main", sessionId, sessionKey },
      mutation: "replace",
    });

    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "stale-replacement-token" }).hits,
    ).toEqual([]);
    await waitForSessionTranscriptIndexForTest();
    expect(
      searchSessionTranscripts({ agentId: "main", config, query: "current-replacement-token" })
        .hits,
    ).toEqual([expect.objectContaining({ messageId: "current-replacement-message" })]);
  });
});
