/** Canonical transcript-tail reader shared by migration and recovery dispatch. */
import path from "node:path";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSessionFilePath } from "../config/sessions.js";
import { resolveCanonicalSessionStorePath } from "../config/sessions/paths.js";
import { streamSessionTranscriptLinesReverse } from "../config/sessions/transcript-stream.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.js";
import {
  hashMainRunRecoveryTranscriptTail,
  type MainRunRecoveryTranscriptTail,
} from "../state/main-run-recovery-store.js";
import { isMainRunRecoveryFailureNoticeIdempotencyKey } from "./main-run-recovery-policy.js";

export type MainRunRecoveryTranscriptState = {
  tail?: MainRunRecoveryTranscriptTail;
  resumeBlockCode?: "unresumable-tail" | "stale-approval";
};

function resolveRecoveryTranscriptPath(params: {
  entry: Pick<SessionEntry, "sessionFile" | "sessionId">;
  storePath: string;
}): string | undefined {
  try {
    return resolveSessionFilePath(params.entry.sessionId, params.entry, {
      sessionsDir: path.dirname(resolveCanonicalSessionStorePath(params.storePath)),
    });
  } catch {
    return undefined;
  }
}

function messageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function isApprovalPendingToolResult(message: unknown): boolean {
  if (messageRole(message) !== "toolResult") {
    return false;
  }
  const details = (message as { details?: unknown }).details;
  return Boolean(
    details &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    (details as { status?: unknown }).status === "approval-pending",
  );
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseTranscriptState(
  line: string,
  legacySessionId: string,
): MainRunRecoveryTranscriptState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as { id?: unknown; message?: unknown };
  const idempotencyKey =
    record.message && typeof record.message === "object" && !Array.isArray(record.message)
      ? (record.message as { idempotencyKey?: unknown }).idempotencyKey
      : undefined;
  if (isMainRunRecoveryFailureNoticeIdempotencyKey(idempotencyKey, legacySessionId)) {
    return undefined;
  }
  const role = messageRole(record.message);
  if (!role || role === "system") {
    return undefined;
  }
  const hash = hashMainRunRecoveryTranscriptTail(record.message);
  const tail = { messageId: optionalText(record.id) ?? `sha256:${hash}`, hash };
  if (role !== "user" && role !== "tool" && role !== "toolResult") {
    return { tail, resumeBlockCode: "unresumable-tail" };
  }
  return isApprovalPendingToolResult(record.message)
    ? { tail, resumeBlockCode: "stale-approval" }
    : { tail };
}

export async function readMainRunRecoveryTranscriptState(params: {
  entry: Pick<SessionEntry, "sessionFile" | "sessionId">;
  storePath: string;
}): Promise<MainRunRecoveryTranscriptState> {
  const transcriptPath = resolveRecoveryTranscriptPath(params);
  if (!transcriptPath) {
    return { resumeBlockCode: "unresumable-tail" };
  }
  for await (const line of streamSessionTranscriptLinesReverse(transcriptPath)) {
    const state = parseTranscriptState(line, params.entry.sessionId);
    if (state) {
      return state;
    }
  }
  return { resumeBlockCode: "unresumable-tail" };
}

/** Find the exact durable user turn owned by an exact-turn recovery source key. */
export async function readMainRunRecoveryApprovedTurn(params: {
  entry: Pick<SessionEntry, "sessionFile" | "sessionId">;
  sourceKey: string;
  storePath: string;
}): Promise<PersistedUserTurnMessage | undefined> {
  const transcriptPath = resolveRecoveryTranscriptPath(params);
  if (!transcriptPath) {
    return undefined;
  }
  for await (const line of streamSessionTranscriptLinesReverse(transcriptPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const message = (parsed as { message?: unknown }).message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const candidate = message as { role?: unknown; idempotencyKey?: unknown };
    if (candidate.role === "user" && candidate.idempotencyKey === params.sourceKey) {
      return message as PersistedUserTurnMessage;
    }
  }
  return undefined;
}

export function mainRunRecoveryTranscriptTailMatches(
  expected: MainRunRecoveryTranscriptTail | null,
  current: MainRunRecoveryTranscriptState,
): boolean {
  const actual = current.tail ?? null;
  return (
    actual === expected ||
    Boolean(
      actual &&
      expected &&
      actual.messageId === expected.messageId &&
      actual.hash === expected.hash,
    )
  );
}
