// Phase 1 safe-routing extension config: mode off|shadow only, no enforce.
import { SAFE_ROUTING_SHADOW_TASK_KIND } from "openclaw/plugin-sdk/safe-routing";

export type SafeRoutingExtensionMode = "off" | "shadow";

export type SafeRoutingExtensionConfig = {
  mode: SafeRoutingExtensionMode;
  allowedTaskKinds: string[];
  approvedProviders: string[];
};

export type SafeRoutingConfigValidationErrorCode =
  | "invalid_mode"
  | "missing_approved_providers"
  | "missing_allowed_task_kind";

export type ValidateSafeRoutingConfigResult =
  | { ok: true; config: SafeRoutingExtensionConfig }
  | { ok: false; code: SafeRoutingConfigValidationErrorCode };

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Validates the extension's raw config. `mode=off` (the default) never
 * requires `approvedProviders`/`allowedTaskKinds` — installing the extension
 * alone must not take over any task. `mode=shadow` requires an explicit,
 * non-empty `approvedProviders` and `allowedTaskKinds` containing the fixed
 * Phase 1 task kind; anything else is rejected rather than silently coerced.
 */
export function validateSafeRoutingConfig(input: unknown): ValidateSafeRoutingConfigResult {
  const raw = (input ?? {}) as Partial<Record<keyof SafeRoutingExtensionConfig, unknown>>;
  if (raw.mode !== undefined && raw.mode !== "off" && raw.mode !== "shadow") {
    return { ok: false, code: "invalid_mode" };
  }
  const mode: SafeRoutingExtensionMode = raw.mode === "shadow" ? "shadow" : "off";
  const allowedTaskKinds = toStringArray(raw.allowedTaskKinds);
  const approvedProviders = toStringArray(raw.approvedProviders);

  if (mode === "off") {
    return { ok: true, config: { mode, allowedTaskKinds, approvedProviders } };
  }
  if (approvedProviders.length === 0) {
    return { ok: false, code: "missing_approved_providers" };
  }
  if (!allowedTaskKinds.includes(SAFE_ROUTING_SHADOW_TASK_KIND)) {
    return { ok: false, code: "missing_allowed_task_kind" };
  }
  return { ok: true, config: { mode, allowedTaskKinds, approvedProviders } };
}
