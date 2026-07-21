import { describe, expect, it } from "vitest";
import { normalizeTaskContract, type PersistedTaskContract } from "../../tasks/safety/contracts.js";
import { buildCapabilitySnapshot, type ModelCapabilitySnapshot } from "./capability-snapshot.js";
import { evaluateCandidateAdmission, type ModelRoutingAdmissionPolicy } from "./candidate-admission.js";

function contract(overrides: Partial<PersistedTaskContract["requiredCapabilities"]> = {}) {
  return normalizeTaskContract({
    schemaVersion: 1,
    taskId: "task-1",
    requiredCapabilities: {
      modalities: ["text"],
      minContextWindowTokens: 32000,
      minOutputTokens: 4096,
      toolCalling: false,
      structuredOutput: false,
      dataPolicy: "approved-providers",
      ...overrides,
    },
    minimumDecisionGrade: "analysis",
    riskClass: "low",
    reviewRequired: false,
    allowedToolPolicyId: "policy-1",
    deliveryMode: "none",
    routingPolicyVersion: "v1",
  });
}

function eligibleSnapshot(overrides: Partial<Parameters<typeof buildCapabilitySnapshot>[0]> = {}): ModelCapabilitySnapshot {
  return buildCapabilitySnapshot({
    provider: "anthropic",
    model: "claude-sonnet-5",
    configured: {
      contextWindowTokens: 200000,
      outputTokens: 8192,
      modalities: ["text", "image"],
      toolCalling: true,
      structuredOutput: true,
      api: "anthropic-messages",
    },
    decisionGradeAuthorization: {
      maxAuthorizedDecisionGrade: "final",
      reason: "routing policy v1: verified anthropic models are authorized up to final",
    },
    ...overrides,
  });
}

const APPROVED_POLICY: ModelRoutingAdmissionPolicy = { approvedProviders: ["anthropic"] };

describe("evaluateCandidateAdmission", () => {
  it("admits a candidate whose snapshot proves every required capability", () => {
    const decision = evaluateCandidateAdmission(contract(), eligibleSnapshot(), APPROVED_POLICY);

    expect(decision).toEqual({ outcome: "eligible" });
  });

  it("rejects MODALITY when a required modality is missing from the verified supported set", () => {
    const decision = evaluateCandidateAdmission(
      contract({ modalities: ["image"] }),
      eligibleSnapshot({ configured: { modalities: ["text"] } }),
      APPROVED_POLICY,
    );

    expect(decision).toMatchObject({ outcome: "ineligible", code: "MODALITY" });
  });

  it("rejects MODALITY when modalities are unverified", () => {
    const decision = evaluateCandidateAdmission(contract(), eligibleSnapshot({ configured: {} }), APPROVED_POLICY);

    expect(decision).toMatchObject({ outcome: "ineligible", code: "MODALITY" });
  });

  it("rejects CAPABILITY_UNVERIFIED when modalities are contradicted", () => {
    const decision = evaluateCandidateAdmission(
      contract(),
      eligibleSnapshot({
        configured: { modalities: ["text", "image"] },
        observed: { modalities: ["image"] },
      }),
      APPROVED_POLICY,
    );

    expect(decision).toMatchObject({ outcome: "ineligible", code: "CAPABILITY_UNVERIFIED" });
  });

  it("rejects CONTEXT when the context window is unverified", () => {
    const decision = evaluateCandidateAdmission(contract(), eligibleSnapshot({ configured: { modalities: ["text"] } }), APPROVED_POLICY);

    expect(decision).toMatchObject({ outcome: "ineligible", code: "CONTEXT" });
  });

  it("rejects CAPABILITY_UNVERIFIED when the context window is contradicted", () => {
    const decision = evaluateCandidateAdmission(
      contract(),
      eligibleSnapshot({
        configured: { modalities: ["text"], contextWindowTokens: 32000 },
        observed: { contextWindowTokens: 64000 },
      }),
      APPROVED_POLICY,
    );

    expect(decision).toMatchObject({ outcome: "ineligible", code: "CAPABILITY_UNVERIFIED" });
  });

  it("rejects CONTEXT when the verified context window is below the required minimum", () => {
    const decision = evaluateCandidateAdmission(
      contract({ minContextWindowTokens: 100000 }),
      eligibleSnapshot({ configured: { modalities: ["text"], contextWindowTokens: 32000 } }),
      APPROVED_POLICY,
    );

    expect(decision).toMatchObject({ outcome: "ineligible", code: "CONTEXT" });
  });

  it("rejects OUTPUT when the verified output limit is below the required minimum", () => {
    const decision = evaluateCandidateAdmission(
      contract({ minOutputTokens: 100000 }),
      eligibleSnapshot({ configured: { modalities: ["text"], contextWindowTokens: 200000, outputTokens: 8192 } }),
      APPROVED_POLICY,
    );

    expect(decision).toMatchObject({ outcome: "ineligible", code: "OUTPUT" });
  });

  it("rejects TOOLS when tool calling is required but not verified true", () => {
    const decision = evaluateCandidateAdmission(
      contract({ toolCalling: true }),
      eligibleSnapshot({
        configured: { modalities: ["text"], contextWindowTokens: 200000, outputTokens: 8192 },
      }),
      APPROVED_POLICY,
    );

    expect(decision).toMatchObject({ outcome: "ineligible", code: "TOOLS" });
  });

  it("rejects CAPABILITY_UNVERIFIED when tool calling is required and contradicted", () => {
    const decision = evaluateCandidateAdmission(
      contract({ toolCalling: true }),
      eligibleSnapshot({
        configured: { modalities: ["text"], contextWindowTokens: 200000, outputTokens: 8192, toolCalling: true },
        observed: { toolCalling: false },
      }),
      APPROVED_POLICY,
    );

    expect(decision).toMatchObject({ outcome: "ineligible", code: "CAPABILITY_UNVERIFIED" });
  });

  it("rejects STRUCTURED_OUTPUT when required but not verified true", () => {
    const decision = evaluateCandidateAdmission(
      contract({ structuredOutput: true }),
      eligibleSnapshot({
        configured: { modalities: ["text"], contextWindowTokens: 200000, outputTokens: 8192 },
      }),
      APPROVED_POLICY,
    );

    expect(decision).toMatchObject({ outcome: "ineligible", code: "STRUCTURED_OUTPUT" });
  });

  it("rejects CAPABILITY_UNVERIFIED when structured output is required and contradicted", () => {
    const decision = evaluateCandidateAdmission(
      contract({ structuredOutput: true }),
      eligibleSnapshot({
        configured: {
          modalities: ["text"],
          contextWindowTokens: 200000,
          outputTokens: 8192,
          structuredOutput: true,
        },
        observed: { structuredOutput: false },
      }),
      APPROVED_POLICY,
    );

    expect(decision).toMatchObject({ outcome: "ineligible", code: "CAPABILITY_UNVERIFIED" });
  });

  it("rejects RUNTIME whenever the contract requires specific runtime ids, since Phase 1 cannot resolve one", () => {
    const decision = evaluateCandidateAdmission(contract({ runtimeIds: ["node-primary"] }), eligibleSnapshot(), APPROVED_POLICY);

    expect(decision).toMatchObject({ outcome: "ineligible", code: "RUNTIME" });
  });

  it("rejects DATA_POLICY when approved-providers is required and the provider is not in the allowlist", () => {
    const decision = evaluateCandidateAdmission(contract({ dataPolicy: "approved-providers" }), eligibleSnapshot(), {
      approvedProviders: ["openai"],
    });

    expect(decision).toMatchObject({ outcome: "ineligible", code: "DATA_POLICY" });
  });

  it("admits a local-only requirement only for a candidate on a recognized local runtime api", () => {
    const decision = evaluateCandidateAdmission(
      contract({ dataPolicy: "local-only" }),
      eligibleSnapshot({ provider: "ollama", configured: { modalities: ["text"], contextWindowTokens: 200000, outputTokens: 8192, api: "ollama" } }),
      APPROVED_POLICY,
    );

    expect(decision).toEqual({ outcome: "eligible" });
  });

  it("rejects DATA_POLICY for a local-only requirement against a cloud api candidate", () => {
    const decision = evaluateCandidateAdmission(contract({ dataPolicy: "local-only" }), eligibleSnapshot(), APPROVED_POLICY);

    expect(decision).toMatchObject({ outcome: "ineligible", code: "DATA_POLICY" });
  });

  it("rejects DECISION_GRADE when the candidate's authorized grade is below the contract's minimum", () => {
    const decision = evaluateCandidateAdmission(
      { ...contract(), minimumDecisionGrade: "final" },
      eligibleSnapshot({
        configured: { modalities: ["text"], contextWindowTokens: 200000, outputTokens: 8192 },
        decisionGradeAuthorization: { maxAuthorizedDecisionGrade: "analysis", reason: "unverified provider capped" },
      }),
      APPROVED_POLICY,
    );

    expect(decision).toMatchObject({ outcome: "ineligible", code: "DECISION_GRADE" });
  });
});
