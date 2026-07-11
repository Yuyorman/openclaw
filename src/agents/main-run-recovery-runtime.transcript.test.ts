import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashMainRunRecoveryTranscriptTail,
  type MainRunRecovery,
} from "../state/main-run-recovery-store.js";
import { buildMainRunRecoveryFailureNoticeIdempotencyKey } from "../infra/main-run-recovery-policy.js";
import { verifyMainRunRecoveryTranscriptTail } from "./main-run-recovery-runtime.js";

const tempDirs: string[] = [];

function createFixture(publicRunId: string) {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-main-recovery-tail-"));
  tempDirs.push(sessionsDir);
  const sessionId = "session-1";
  const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
  const message = { role: "user", content: "finish this work" };
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ id: "user-1", message })}\n`,
  );
  const recovery = {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionKeyAliases: [],
    sessionId,
    storePath: path.join(sessionsDir, "sessions.json"),
    kind: "session_resume",
    publicRunId,
    sourceKey: "legacy-json:v1:test",
    sourceFingerprint: "a".repeat(64),
    state: "recovery_pending",
    bootId: "boot-1",
    lifecycleGeneration: "generation-1",
    authorization: { senderIsOwner: false },
    revision: 1,
    attemptCount: 0,
    lifecycleFences: [],
    acceptedAtMs: 1,
    updatedAtMs: 1,
    envelope: {
      kind: "session_resume",
      resolution: { kind: "resume" },
      systemMessage: "resume",
      transcriptTail: {
        messageId: "user-1",
        hash: hashMainRunRecoveryTranscriptTail(message),
      },
      lifecycleRevision: null,
      delivery: { context: null, runId: null, intentId: null },
      fences: [],
    },
  } satisfies Extract<MainRunRecovery, { kind: "session_resume" }>;
  return { recovery, transcriptPath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("main-run recovery transcript CAS", () => {
  it.each([
    "00000000-0000-5000-8000-000000000001",
    "non-uuid-public-run-id",
  ])("accepts its %s notice but rejects a newer meaningful tail", async (publicRunId) => {
    const { recovery, transcriptPath } = createFixture(publicRunId);
    const entry = { sessionId: recovery.sessionId, sessionFile: transcriptPath };

    await expect(verifyMainRunRecoveryTranscriptTail({ entry, recovery })).resolves.toEqual({
      ok: true,
    });
    fs.appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        id: "notice-1",
        message: {
          role: "assistant",
          content: "retry",
          idempotencyKey: buildMainRunRecoveryFailureNoticeIdempotencyKey(recovery.publicRunId),
        },
      })}\n`,
    );
    await expect(verifyMainRunRecoveryTranscriptTail({ entry, recovery })).resolves.toEqual({
      ok: true,
    });

    fs.appendFileSync(
      transcriptPath,
      `${JSON.stringify({ id: "user-2", message: { role: "user", content: "new work" } })}\n`,
    );
    await expect(verifyMainRunRecoveryTranscriptTail({ entry, recovery })).resolves.toEqual({
      ok: false,
      reason: "transcript-tail-changed",
    });
  });
});
