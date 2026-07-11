/** Shared user-visible policy for main-run restart recovery. */
import { createHash } from "node:crypto";

const MAIN_RUN_RECOVERY_RESUME_MESSAGE =
  "[System] Your previous turn was interrupted by a gateway restart while " +
  "OpenClaw was waiting on tool/model work. Continue from the existing " +
  "transcript and finish the interrupted response.";
const MAIN_RUN_EXACT_TURN_MESSAGE =
  "[System] Respond to the latest persisted user turn. The user turn is already in the transcript; " +
  "do not repeat it or mention this control message.";

const MAIN_RUN_RECOVERY_FAILURE_NOTICE =
  "I was interrupted by a gateway restart and couldn't safely resume the previous turn. " +
  "Please send that last request again and I'll pick it up cleanly.";
const MAIN_RUN_EXACT_TURN_FAILURE_NOTICE =
  "I couldn't complete that request safely. Please send it again and I'll pick it up cleanly.";
const MAIN_RUN_RECOVERY_FAILURE_NOTICE_KEY = /^main-run-recovery:[0-9a-f]{64}:failure-notice$/i;

export function buildMainRunRecoverySessionResumeMessage(): string {
  return MAIN_RUN_RECOVERY_RESUME_MESSAGE;
}

export function buildMainRunExactTurnMessage(): string {
  return MAIN_RUN_EXACT_TURN_MESSAGE;
}

export function buildMainRunRecoveryFailureNotice(): string {
  return MAIN_RUN_RECOVERY_FAILURE_NOTICE;
}

export function buildMainRunExactTurnFailureNotice(): string {
  return MAIN_RUN_EXACT_TURN_FAILURE_NOTICE;
}

export function buildMainRunRecoveryFailureNoticeIdempotencyKey(publicRunId: string): string {
  const normalized = publicRunId.trim();
  if (!normalized) {
    throw new Error("main-run recovery public run id is required");
  }
  const token = createHash("sha256").update(normalized).digest("hex");
  return `main-run-recovery:${token}:failure-notice`;
}

export function isMainRunRecoveryFailureNoticeIdempotencyKey(
  value: unknown,
  legacySessionId?: string,
): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return (
    (legacySessionId !== undefined &&
      value === `main-session-restart-recovery:${legacySessionId}:failed-notice`) ||
    MAIN_RUN_RECOVERY_FAILURE_NOTICE_KEY.test(value)
  );
}

export function formatMainRunRecoveryDoctorHint(params?: {
  storePath?: string;
  sessionKey?: string;
  sessionId?: string;
  reason?: string;
}): string {
  const identity = [
    params?.storePath,
    params?.sessionKey ? `key=${params.sessionKey}` : undefined,
    params?.sessionId ? `sessionId=${params.sessionId}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  const context = [params?.reason, identity].filter(Boolean).join(" at ");
  return `${context ? `${context}; ` : ""}run "openclaw doctor --fix" before sending new work to this session`;
}
