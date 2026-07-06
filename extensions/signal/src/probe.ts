// Signal plugin module implements probe behavior.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  detectSignalApiMode,
  type SignalApiMode,
  signalCheck,
  signalRpcRequest,
} from "./client-adapter.js";

export type SignalProbeReadiness =
  | "account_missing"
  | "unreachable"
  | "receive_unavailable"
  | "ready";

export type SignalProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  version?: string | null;
  readiness: SignalProbeReadiness;
};

function parseSignalVersion(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "object" && value !== null) {
    const version = (value as { version?: unknown }).version;
    if (typeof version === "string" && version.trim()) {
      return version.trim();
    }
  }
  return null;
}

function classifyFailedSignalCheck(error: string | null | undefined): SignalProbeReadiness {
  return /\breceive\b/i.test(error ?? "") ? "receive_unavailable" : "unreachable";
}

async function resolveProbeApiMode(params: {
  baseUrl: string;
  timeoutMs: number;
  apiMode: SignalApiMode;
}): Promise<"native" | "container" | null> {
  if (params.apiMode === "native" || params.apiMode === "container") {
    return params.apiMode;
  }
  return await detectSignalApiMode(params.baseUrl, params.timeoutMs).catch(() => null);
}

async function validateContainerProbeAccount(params: {
  baseUrl: string;
  timeoutMs: number;
  apiMode: SignalApiMode;
  account: string;
  receiveAlreadyChecked: boolean;
  mode?: "native" | "container" | null;
}): Promise<{ error: string; readiness: SignalProbeReadiness } | null> {
  const mode = params.mode ?? (await resolveProbeApiMode(params));
  if (mode !== "container") {
    return null;
  }
  if (!params.receiveAlreadyChecked) {
    const receiveCheck = await signalCheck(params.baseUrl, params.timeoutMs, {
      apiMode: "container",
      account: params.account,
      requireReceive: true,
    });
    if (!receiveCheck.ok) {
      return {
        error: receiveCheck.error ?? "Signal container receive endpoint unavailable",
        readiness: "receive_unavailable",
      };
    }
  }
  const { validateSignalContainerLinkedAccount } = await import("./client-container.js");
  const linked = await validateSignalContainerLinkedAccount({
    httpUrl: params.baseUrl,
    account: params.account,
    timeoutMs: params.timeoutMs,
  });
  return linked.ok ? null : { error: linked.error, readiness: "account_missing" };
}

export async function probeSignal(
  baseUrl: string,
  timeoutMs: number,
  options: { apiMode?: SignalApiMode; account?: string } = {},
): Promise<SignalProbe> {
  const started = Date.now();
  const result: SignalProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
    version: null,
    readiness: "unreachable",
  };
  const account = normalizeOptionalString(options.account);
  const apiMode = options.apiMode ?? "native";
  const receiveAlreadyChecked = apiMode === "container" && Boolean(account);
  const check = await signalCheck(baseUrl, timeoutMs, {
    apiMode,
    account,
    // Native signal-cli can keep `/api/v1/events` idle before sending headers;
    // the monitor handles that with an infinite stream deadline. Keep finite
    // receive readiness as a container account contract, not a native setup gate.
    requireReceive: receiveAlreadyChecked,
  });
  if (!check.ok) {
    return {
      ...result,
      status: check.status ?? null,
      error: check.error ?? "unreachable",
      elapsedMs: Date.now() - started,
      readiness: classifyFailedSignalCheck(check.error),
    };
  }
  try {
    const version = await signalRpcRequest("version", undefined, {
      baseUrl,
      timeoutMs,
      apiMode,
    });
    result.version = parseSignalVersion(version);
  } catch (err) {
    result.error = formatErrorMessage(err);
  }
  const mode = await resolveProbeApiMode({
    baseUrl,
    timeoutMs,
    apiMode,
  });
  if (!account) {
    if (mode !== "container") {
      return {
        ...result,
        ok: true,
        status: check.status ?? null,
        elapsedMs: Date.now() - started,
        readiness: "ready",
      };
    }
    return {
      ...result,
      ok: false,
      status: check.status ?? null,
      error: result.error ?? "Signal account is not configured",
      elapsedMs: Date.now() - started,
      readiness: "account_missing",
    };
  }
  const containerAccountFailure = await validateContainerProbeAccount({
    baseUrl,
    timeoutMs,
    apiMode,
    account,
    receiveAlreadyChecked,
    mode,
  });
  if (containerAccountFailure) {
    return {
      ...result,
      status: check.status ?? null,
      error: containerAccountFailure.error,
      elapsedMs: Date.now() - started,
      readiness: containerAccountFailure.readiness,
    };
  }
  return {
    ...result,
    ok: true,
    status: check.status ?? null,
    elapsedMs: Date.now() - started,
    readiness: "ready",
  };
}
