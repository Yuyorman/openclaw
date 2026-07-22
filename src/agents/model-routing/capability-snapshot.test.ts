import { describe, expect, it } from "vitest";
import {
  buildCapabilitySnapshot,
  type BuildCapabilitySnapshotInput,
} from "./capability-snapshot.js";

function baseInput(
  overrides: Partial<BuildCapabilitySnapshotInput> = {},
): BuildCapabilitySnapshotInput {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5",
    decisionGradeAuthorization: {
      maxAuthorizedDecisionGrade: "final",
      reason: "routing policy v1: verified anthropic models are authorized up to final",
    },
    ...overrides,
  };
}

describe("buildCapabilitySnapshot", () => {
  it("aggregates config declaration alone into a configured snapshot", () => {
    const snapshot = buildCapabilitySnapshot(
      baseInput({
        configured: {
          contextWindowTokens: 200000,
          outputTokens: 8192,
          modalities: ["text", "image"],
          toolCalling: true,
          structuredOutput: true,
          api: "anthropic-messages",
        },
      }),
    );

    expect(snapshot.contextWindowTokens).toMatchObject({
      value: 200000,
      verification: "configured",
    });
    expect(snapshot.outputTokens).toMatchObject({ value: 8192, verification: "configured" });
    expect(snapshot.modalities).toMatchObject({
      value: ["image", "text"],
      verification: "configured",
    });
    expect(snapshot.toolCalling).toMatchObject({ value: true, verification: "configured" });
    expect(snapshot.structuredOutput).toMatchObject({ value: true, verification: "configured" });
    expect(snapshot.api).toMatchObject({ value: "anthropic-messages", verification: "configured" });
  });

  it("takes the minimum of config declaration and runtime limit, not the most optimistic", () => {
    const snapshot = buildCapabilitySnapshot(
      baseInput({
        configured: { contextWindowTokens: 200000, outputTokens: 8192 },
        runtimeLimits: { contextWindowTokens: 128000, outputTokens: 4096 },
      }),
    );

    expect(snapshot.contextWindowTokens).toMatchObject({
      value: 128000,
      verification: "configured",
    });
    expect(snapshot.outputTokens).toMatchObject({ value: 4096, verification: "configured" });
  });

  it("adopts observed evidence at or below the static ceiling as the operative value", () => {
    const snapshot = buildCapabilitySnapshot(
      baseInput({
        configured: { contextWindowTokens: 200000 },
        observed: { contextWindowTokens: 190000 },
      }),
    );

    expect(snapshot.contextWindowTokens).toMatchObject({ value: 190000, verification: "observed" });
  });

  it("does not read a dynamic accumulated-usage-shaped observed value as more optimistic than declared", () => {
    const snapshot = buildCapabilitySnapshot(
      baseInput({
        configured: { contextWindowTokens: 128000 },
        observed: { contextWindowTokens: 250000 },
      }),
    );

    expect(snapshot.contextWindowTokens.verification).toBe("contradicted");
    expect(snapshot.contextWindowTokens.value).toBe(128000);
  });

  it("marks a numeric field unverified when neither config, runtime limit, nor observation supply it", () => {
    const snapshot = buildCapabilitySnapshot(baseInput());

    expect(snapshot.contextWindowTokens).toMatchObject({ verification: "unverified" });
    expect(snapshot.contextWindowTokens.value).toBeUndefined();
    expect(snapshot.outputTokens).toMatchObject({ verification: "unverified" });
  });

  it("marks boolean capabilities contradicted and conservative (false) when config and observation disagree", () => {
    const snapshot = buildCapabilitySnapshot(
      baseInput({
        configured: { toolCalling: true, structuredOutput: true },
        observed: { toolCalling: false, structuredOutput: false },
      }),
    );

    expect(snapshot.toolCalling).toMatchObject({ value: false, verification: "contradicted" });
    expect(snapshot.structuredOutput).toMatchObject({ value: false, verification: "contradicted" });
  });

  it("marks boolean capabilities observed when only observation supplies them", () => {
    const snapshot = buildCapabilitySnapshot(baseInput({ observed: { toolCalling: true } }));

    expect(snapshot.toolCalling).toMatchObject({ value: true, verification: "observed" });
  });

  it("marks unproven structured output, tool calling, and modality unverified with no evidence", () => {
    const snapshot = buildCapabilitySnapshot(baseInput());

    expect(snapshot.toolCalling.verification).toBe("unverified");
    expect(snapshot.structuredOutput.verification).toBe("unverified");
    expect(snapshot.modalities.verification).toBe("unverified");
    expect(snapshot.modalities.value).toBeUndefined();
  });

  it("takes the intersection of contradicted modality claims", () => {
    const snapshot = buildCapabilitySnapshot(
      baseInput({
        configured: { modalities: ["text", "image"] },
        observed: { modalities: ["text"] },
      }),
    );

    expect(snapshot.modalities).toMatchObject({ value: ["text"], verification: "contradicted" });
  });

  it("always marks runtimeIds unverified since Phase 1 never resolves a verified runtime id", () => {
    const snapshot = buildCapabilitySnapshot(baseInput());

    expect(snapshot.runtimeIds.verification).toBe("unverified");
    expect(snapshot.runtimeIds.value).toBeUndefined();
  });

  it("writes decisionGrade authorization into snapshot evidence sourced from policy, not model config", () => {
    const snapshot = buildCapabilitySnapshot(
      baseInput({
        decisionGradeAuthorization: {
          maxAuthorizedDecisionGrade: "analysis",
          reason: "routing policy v1: unverified providers capped at analysis",
        },
      }),
    );

    expect(snapshot.authorizedDecisionGrade.value).toBe("analysis");
    expect(snapshot.authorizedDecisionGrade.evidence).toEqual([
      { source: "policy", detail: "routing policy v1: unverified providers capped at analysis" },
    ]);
    expect(
      snapshot.authorizedDecisionGrade.evidence.some((entry) => entry.source === "config"),
    ).toBe(false);
  });

  it("produces a stable digest for identical facts", () => {
    const input = baseInput({
      configured: { contextWindowTokens: 200000, toolCalling: true },
    });

    const first = buildCapabilitySnapshot(input);
    const second = buildCapabilitySnapshot(input);

    expect(first.snapshotDigest).toBe(second.snapshotDigest);
    expect(first.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes the digest when a constraint changes", () => {
    const first = buildCapabilitySnapshot(
      baseInput({ configured: { contextWindowTokens: 200000 } }),
    );
    const second = buildCapabilitySnapshot(
      baseInput({ configured: { contextWindowTokens: 128000 } }),
    );

    expect(first.snapshotDigest).not.toBe(second.snapshotDigest);
  });

  it("changes the digest when only evidence changes and the resolved value stays the same", () => {
    const first = buildCapabilitySnapshot(
      baseInput({
        decisionGradeAuthorization: { maxAuthorizedDecisionGrade: "final", reason: "reason A" },
      }),
    );
    const second = buildCapabilitySnapshot(
      baseInput({
        decisionGradeAuthorization: { maxAuthorizedDecisionGrade: "final", reason: "reason B" },
      }),
    );

    expect(first.authorizedDecisionGrade.value).toBe(second.authorizedDecisionGrade.value);
    expect(first.snapshotDigest).not.toBe(second.snapshotDigest);
  });
});
