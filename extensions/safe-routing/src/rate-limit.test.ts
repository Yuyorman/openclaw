import { afterEach, describe, expect, it } from "vitest";
import { consumeShadowEvaluateBudget, __testing as testing } from "./rate-limit.js";

describe("consumeShadowEvaluateBudget", () => {
  afterEach(() => {
    testing.reset();
  });

  it("allows up to the per-key limit within a window, then rejects", () => {
    const baseMs = 1_000_000;
    for (let i = 0; i < 10; i++) {
      expect(consumeShadowEvaluateBudget("session-1", baseMs).allowed).toBe(true);
    }

    const eleventh = consumeShadowEvaluateBudget("session-1", baseMs);
    expect(eleventh.allowed).toBe(false);
    expect(eleventh.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks distinct keys independently", () => {
    const baseMs = 1_000_000;
    for (let i = 0; i < 10; i++) {
      expect(consumeShadowEvaluateBudget("session-a", baseMs).allowed).toBe(true);
    }

    expect(consumeShadowEvaluateBudget("session-a", baseMs).allowed).toBe(false);
    expect(consumeShadowEvaluateBudget("session-b", baseMs).allowed).toBe(true);
  });

  it("resets the window once it elapses", () => {
    const baseMs = 1_000_000;
    for (let i = 0; i < 10; i++) {
      consumeShadowEvaluateBudget("session-1", baseMs);
    }
    expect(consumeShadowEvaluateBudget("session-1", baseMs).allowed).toBe(false);

    const nextWindow = consumeShadowEvaluateBudget("session-1", baseMs + 60_000);
    expect(nextWindow.allowed).toBe(true);
  });
});
