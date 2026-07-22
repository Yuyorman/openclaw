import { describe, expect, it } from "vitest";
import { validateSafeRoutingConfig } from "./config.js";

describe("validateSafeRoutingConfig", () => {
  it("defaults to mode=off with empty allowlists when given no config at all", () => {
    const result = validateSafeRoutingConfig(undefined);

    expect(result).toEqual({
      ok: true,
      config: { mode: "off", allowedTaskKinds: [], approvedProviders: [] },
    });
  });

  it("accepts mode=off even with no approvedProviders or allowedTaskKinds — installing alone must not take over any task", () => {
    const result = validateSafeRoutingConfig({ mode: "off" });

    expect(result).toEqual({
      ok: true,
      config: { mode: "off", allowedTaskKinds: [], approvedProviders: [] },
    });
  });

  it("rejects any mode other than off or shadow — Phase 1 never exposes enforce", () => {
    const result = validateSafeRoutingConfig({ mode: "enforce" });

    expect(result).toEqual({ ok: false, code: "invalid_mode" });
  });

  it("rejects mode=shadow when approvedProviders is missing", () => {
    const result = validateSafeRoutingConfig({
      mode: "shadow",
      allowedTaskKinds: ["safe-routing-readonly-shadow"],
    });

    expect(result).toEqual({ ok: false, code: "missing_approved_providers" });
  });

  it("rejects mode=shadow when approvedProviders is present but empty", () => {
    const result = validateSafeRoutingConfig({
      mode: "shadow",
      allowedTaskKinds: ["safe-routing-readonly-shadow"],
      approvedProviders: [],
    });

    expect(result).toEqual({ ok: false, code: "missing_approved_providers" });
  });

  it("rejects mode=shadow when allowedTaskKinds does not contain the fixed safe-routing-readonly-shadow kind", () => {
    const result = validateSafeRoutingConfig({
      mode: "shadow",
      allowedTaskKinds: ["some-other-task-kind"],
      approvedProviders: ["anthropic"],
    });

    expect(result).toEqual({ ok: false, code: "missing_allowed_task_kind" });
  });

  it("accepts a fully-configured mode=shadow", () => {
    const result = validateSafeRoutingConfig({
      mode: "shadow",
      allowedTaskKinds: ["safe-routing-readonly-shadow"],
      approvedProviders: ["anthropic", "openai"],
    });

    expect(result).toEqual({
      ok: true,
      config: {
        mode: "shadow",
        allowedTaskKinds: ["safe-routing-readonly-shadow"],
        approvedProviders: ["anthropic", "openai"],
      },
    });
  });
});
