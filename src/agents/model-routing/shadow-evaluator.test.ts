import { describe, expect, it } from "vitest";
import { normalizeTaskContract } from "../../tasks/safety/contracts.js";
import { buildCapabilitySnapshot } from "./capability-snapshot.js";
import { evaluateShadowRoute } from "./shadow-evaluator.js";

const CONTRACT = normalizeTaskContract({
  schemaVersion: 1,
  taskId: "task-1",
  requiredCapabilities: {
    modalities: ["text"],
    minContextWindowTokens: 100000,
    minOutputTokens: 4096,
    toolCalling: false,
    structuredOutput: false,
    dataPolicy: "approved-providers",
  },
  minimumDecisionGrade: "analysis",
  riskClass: "low",
  reviewRequired: false,
  allowedToolPolicyId: "policy-1",
  deliveryMode: "none",
  routingPolicyVersion: "v1",
});

const POLICY = { approvedProviders: ["openai", "anthropic"] };

function snapshotFor(provider: string, model: string, contextWindowTokens: number) {
  return buildCapabilitySnapshot({
    provider,
    model,
    configured: { contextWindowTokens, outputTokens: 8192, modalities: ["text"], api: `${provider}-api` },
    decisionGradeAuthorization: { maxAuthorizedDecisionGrade: "final", reason: "test policy" },
  });
}

describe("evaluateShadowRoute", () => {
  it("reports the first eligible candidate as the theoretical choice without reordering or mutating the real chain (A stays real, C is only reported)", () => {
    const candidates = [
      { provider: "openai", model: "gpt-5.4" }, // A: real primary, but shadow-ineligible (context too small)
      { provider: "openai", model: "gpt-5.4-mini" }, // B: also ineligible
      { provider: "anthropic", model: "claude-sonnet-5" }, // C: shadow-eligible
    ];
    const frozenCandidates = structuredClone(candidates);
    const snapshots = [
      snapshotFor("openai", "gpt-5.4", 32000),
      snapshotFor("openai", "gpt-5.4-mini", 16000),
      snapshotFor("anthropic", "claude-sonnet-5", 200000),
    ];

    const result = evaluateShadowRoute({ contract: CONTRACT, candidates, snapshots, policy: POLICY });

    expect(candidates).toEqual(frozenCandidates);
    expect(result.attempts.map((a) => `${a.provider}/${a.model}`)).toEqual([
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "anthropic/claude-sonnet-5",
    ]);
    expect(result.attempts[0].decision.outcome).toBe("ineligible");
    expect(result.attempts[1].decision.outcome).toBe("ineligible");
    expect(result.attempts[2].decision).toEqual({ outcome: "eligible" });
    expect(result.theoreticalChoice).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("echoes the contract's routingPolicyVersion", () => {
    const result = evaluateShadowRoute({ contract: CONTRACT, candidates: [], snapshots: [], policy: POLICY });

    expect(result.routingPolicyVersion).toBe("v1");
  });

  it("records each distinct (provider, model) candidate only once, keeping the first occurrence's ordinal", () => {
    const candidates = [
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "openai", model: "gpt-5.4" },
    ];
    const snapshots = [snapshotFor("anthropic", "claude-sonnet-5", 200000), snapshotFor("openai", "gpt-5.4", 200000)];

    const result = evaluateShadowRoute({ contract: CONTRACT, candidates, snapshots, policy: POLICY });

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ ordinal: 0, provider: "anthropic", model: "claude-sonnet-5" });
    expect(result.attempts[1]).toMatchObject({ ordinal: 1, provider: "openai", model: "gpt-5.4" });
  });

  it("reports CAPABILITY_UNVERIFIED for a candidate with no capability snapshot, rather than skipping or throwing", () => {
    const candidates = [{ provider: "openai", model: "gpt-5.4" }];

    const result = evaluateShadowRoute({ contract: CONTRACT, candidates, snapshots: [], policy: POLICY });

    expect(result.attempts).toEqual([
      {
        ordinal: 0,
        provider: "openai",
        model: "gpt-5.4",
        decision: {
          outcome: "ineligible",
          code: "CAPABILITY_UNVERIFIED",
          reason: "No capability snapshot is available for this candidate",
        },
      },
    ]);
    expect(result.theoreticalChoice).toBeUndefined();
  });

  it("reports no theoretical choice when every candidate is ineligible", () => {
    const candidates = [{ provider: "openai", model: "gpt-5.4" }];
    const snapshots = [snapshotFor("openai", "gpt-5.4", 1000)];

    const result = evaluateShadowRoute({ contract: CONTRACT, candidates, snapshots, policy: POLICY });

    expect(result.theoreticalChoice).toBeUndefined();
    expect(result.attempts[0].decision.outcome).toBe("ineligible");
  });
});
