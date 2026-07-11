import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLegacyMainRunRecoveryPlan,
  normalizeLegacyMainRunRecoveryFences,
  readLegacyMainRunRecoveryTranscriptState,
  type LegacyMainRunRecoveryEntry,
} from "./main-run-recovery-migration.js";
import { buildMainRunRecoveryFailureNoticeIdempotencyKey } from "./main-run-recovery-policy.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-main-run-migration-"));
  tempDirs.push(dir);
  return dir;
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("legacy main-run recovery migration planning", () => {
  it("normalizes and deterministically sorts lifecycle fences across aliases", () => {
    expect(
      normalizeLegacyMainRunRecoveryFences([
        recoveryEntry({
          restartRecoveryRuns: [
            { runId: " run-b ", lifecycleGeneration: "generation-2" },
            { runId: "run-a", lifecycleGeneration: "generation-3" },
          ],
        }),
        recoveryEntry({
          restartRecoveryRuns: [
            { runId: "run-a", lifecycleGeneration: "generation-1" },
            { runId: "run-a", lifecycleGeneration: "generation-1" },
          ],
        }),
      ]),
    ).toEqual([
      { runId: "run-a", lifecycleGeneration: "generation-1" },
      { runId: "run-a", lifecycleGeneration: "generation-3" },
      { runId: "run-b", lifecycleGeneration: "generation-2" },
    ]);
  });

  it("reads the last meaningful resumable transcript message through trailing metadata", async () => {
    const sessionsDir = createTempDir();
    const transcriptPath = path.join(sessionsDir, "session-1.jsonl");
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ id: "user-1", message: { role: "user", content: "hello" } }),
        JSON.stringify({ id: "system-1", message: { role: "system", content: "ignored" } }),
        JSON.stringify({ type: "openclaw.cache-ttl", value: 1 }),
      ].join("\n"),
    );

    await expect(
      readLegacyMainRunRecoveryTranscriptState({
        entry: recoveryEntry({ sessionFile: transcriptPath }),
        storePath: path.join(sessionsDir, "sessions.json"),
      }),
    ).resolves.toEqual({
      tail: {
        messageId: "user-1",
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("marks an assistant or approval-pending tail unresumable", async () => {
    const sessionsDir = createTempDir();
    const transcriptPath = path.join(sessionsDir, "session-1.jsonl");
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        id: "tool-1",
        message: { role: "toolResult", details: { status: "approval-pending" } },
      }),
    );

    await expect(
      readLegacyMainRunRecoveryTranscriptState({
        entry: recoveryEntry({ sessionFile: transcriptPath }),
        storePath: path.join(sessionsDir, "sessions.json"),
      }),
    ).resolves.toMatchObject({
      tail: { messageId: "tool-1" },
      resumeBlockCode: "stale-approval",
    });
  });

  it("builds one deterministic least-privilege session-resume operation", () => {
    const entry = recoveryEntry({
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "captured reply",
      pendingFinalDeliveryIntentId: "intent-1",
      restartRecoveryDeliveryRunId: "delivery-run-1",
      restartRecoveryRuns: [
        { runId: "run-2", lifecycleGeneration: "generation-2" },
        { runId: "run-1", lifecycleGeneration: "generation-1" },
      ],
    });
    const params = {
      agentId: "main",
      entries: [{ entry, sessionKey: "agent:main:main" }],
      storePath: "/tmp/openclaw/agents/main/sessions/sessions.json",
      transcriptState: { tail: { messageId: "user-1", hash: "a".repeat(64) } },
    };

    const first = buildLegacyMainRunRecoveryPlan(params);
    expect(buildLegacyMainRunRecoveryPlan(params)).toEqual(first);
    expect(first).toMatchObject({
      status: "planned",
      plan: {
        sourceKind: "session_resume",
        sourceKey: expect.stringMatching(/^legacy-json:v1:[a-f0-9]{64}$/),
        sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        publicRunId: expect.stringMatching(
          /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
        ),
        disposition: { kind: "resume" },
        input: {
          sessionKey: "agent:main:main",
          sessionKeyAliases: [],
          envelope: {
            kind: "session_resume",
            transcriptTail: { messageId: "user-1", hash: "a".repeat(64) },
            lifecycleRevision: "revision-1",
            delivery: { context: null, runId: "delivery-run-1", intentId: "intent-1" },
            fences: [
              { runId: "run-1", lifecycleGeneration: "generation-1" },
              { runId: "run-2", lifecycleGeneration: "generation-2" },
            ],
          },
        },
      },
    });
  });

  it("uses canonical physical store plus session identity, not a JSON alias key", () => {
    const root = createTempDir();
    const realDir = path.join(root, "real");
    const aliasDir = path.join(root, "alias");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, aliasDir);
    const entry = recoveryEntry({ pendingFinalDeliveryIntentId: "intent-1" });
    const left = buildLegacyMainRunRecoveryPlan({
      agentId: "main",
      entries: [{ entry, sessionKey: "agent:main:main" }],
      storePath: path.join(realDir, "sessions.json"),
      transcriptState: { tail: { messageId: "user-1", hash: "a".repeat(64) } },
    });
    const right = buildLegacyMainRunRecoveryPlan({
      agentId: "main",
      entries: [{ entry, sessionKey: "main" }],
      storePath: path.join(aliasDir, "sessions.json"),
      transcriptState: { tail: { messageId: "user-1", hash: "a".repeat(64) } },
    });
    expect(left.status).toBe("planned");
    expect(right.status).toBe("planned");
    if (left.status === "planned" && right.status === "planned") {
      expect(right.plan.sourceKey).toBe(left.plan.sourceKey);
    }
  });

  it("turns markerless and transcriptless legacy state into an actionable failure plan", () => {
    const result = buildLegacyMainRunRecoveryPlan({
      agentId: "main",
      entries: [{ entry: recoveryEntry(), sessionKey: "agent:main:main" }],
      storePath: "/tmp/openclaw/agents/main/sessions/sessions.json",
      transcriptState: { resumeBlockCode: "unresumable-tail" },
    });
    expect(result).toMatchObject({
      status: "planned",
      plan: {
        disposition: { kind: "fail", code: "unresumable-tail" },
        usesUpdatedAtFallback: false,
        input: { envelope: { transcriptTail: null } },
      },
    });
  });

  it("keeps a markerless source stable across legacy and ledger failure notices", async () => {
    const sessionsDir = createTempDir();
    const transcriptPath = path.join(sessionsDir, "session-1.jsonl");
    const entry = recoveryEntry({ lifecycleRevision: undefined, sessionFile: transcriptPath });
    fs.writeFileSync(transcriptPath, "");
    const beforeState = await readLegacyMainRunRecoveryTranscriptState({
      entry,
      storePath: path.join(sessionsDir, "sessions.json"),
    });
    const before = buildLegacyMainRunRecoveryPlan({
      agentId: "main",
      entries: [{ entry, sessionKey: "agent:main:main" }],
      storePath: path.join(sessionsDir, "sessions.json"),
      transcriptState: beforeState,
    });
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          id: "notice-1",
          message: {
            role: "assistant",
            content: "retry",
            idempotencyKey: "main-session-restart-recovery:session-1:failed-notice",
          },
        }),
        JSON.stringify({
          id: "notice-2",
          message: {
            role: "assistant",
            content: "retry",
            idempotencyKey: buildMainRunRecoveryFailureNoticeIdempotencyKey(
              "00000000-0000-5000-8000-000000000000",
            ),
          },
        }),
      ].join("\n"),
    );
    const afterState = await readLegacyMainRunRecoveryTranscriptState({
      entry,
      storePath: path.join(sessionsDir, "sessions.json"),
    });
    const after = buildLegacyMainRunRecoveryPlan({
      agentId: "main",
      entries: [{ entry, sessionKey: "agent:main:main" }],
      storePath: path.join(sessionsDir, "sessions.json"),
      transcriptState: afterState,
    });
    expect(afterState).toEqual(beforeState);
    expect(after).toEqual(before);
  });

  it("plans pending final delivery without requiring a transcript tail", () => {
    const result = buildLegacyMainRunRecoveryPlan({
      agentId: "main",
      entries: [
        {
          entry: recoveryEntry({
            pendingFinalDelivery: true,
            pendingFinalDeliveryText: "reply",
            pendingFinalDeliveryIntentId: "intent-only",
          }),
          sessionKey: "agent:main:main",
        },
      ],
      storePath: "/tmp/openclaw/agents/main/sessions/sessions.json",
    });
    expect(result).toMatchObject({
      status: "planned",
      plan: {
        disposition: { kind: "resume" },
        input: {
          envelope: {
            transcriptTail: null,
            delivery: { intentId: "intent-only" },
          },
        },
      },
    });
  });
});
