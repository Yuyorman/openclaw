import { describe, expect, it } from "vitest";
import { digestTaskContract, normalizeTaskContract, type PersistedTaskContract } from "./contracts.js";

function buildContract(overrides: Partial<PersistedTaskContract> = {}): PersistedTaskContract {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    requiredCapabilities: {
      modalities: ["text"],
      minContextWindowTokens: 8000,
      minOutputTokens: 512,
      toolCalling: false,
      structuredOutput: false,
      runtimeIds: [],
      dataPolicy: "local-only",
    },
    minimumDecisionGrade: "draft",
    riskClass: "low",
    reviewRequired: false,
    allowedToolPolicyId: "policy-default",
    deliveryMode: "none",
    routingPolicyVersion: "v1",
    ...overrides,
  };
}

describe("normalizeTaskContract", () => {
  it("produces a stable field order regardless of construction order", () => {
    const normalized = normalizeTaskContract(buildContract());

    expect(Object.keys(normalized)).toEqual([
      "schemaVersion",
      "taskId",
      "requiredCapabilities",
      "minimumDecisionGrade",
      "riskClass",
      "reviewRequired",
      "allowedToolPolicyId",
      "deliveryMode",
      "routingPolicyVersion",
    ]);
    expect(Object.keys(normalized.requiredCapabilities)).toEqual([
      "modalities",
      "minContextWindowTokens",
      "minOutputTokens",
      "toolCalling",
      "structuredOutput",
      "runtimeIds",
      "dataPolicy",
    ]);
  });

  it("dedupes, sorts, and drops empty strings from modalities and runtimeIds", () => {
    const contract = buildContract({
      requiredCapabilities: {
        ...buildContract().requiredCapabilities,
        modalities: ["image", "text", "image", "" as unknown as "text"],
        runtimeIds: ["b", "a", "", "a"],
      },
    });

    const normalized = normalizeTaskContract(contract);

    expect(normalized.requiredCapabilities.modalities).toEqual(["image", "text"]);
    expect(normalized.requiredCapabilities.runtimeIds).toEqual(["a", "b"]);
  });

  it("normalizes an absent runtimeIds to an empty array", () => {
    const contract = buildContract();
    const { runtimeIds: _drop, ...rest } = contract.requiredCapabilities;
    const normalized = normalizeTaskContract({ ...contract, requiredCapabilities: rest as never });

    expect(normalized.requiredCapabilities.runtimeIds).toEqual([]);
  });

  it("rejects an unknown modality", () => {
    const contract = buildContract({
      requiredCapabilities: {
        ...buildContract().requiredCapabilities,
        modalities: ["video"] as unknown as ["text"],
      },
    });

    expect(() => normalizeTaskContract(contract)).toThrow(
      expect.objectContaining({ code: "invalid_modality" }),
    );
  });

  it("rejects an unknown minimumDecisionGrade", () => {
    const contract = buildContract({ minimumDecisionGrade: "urgent" as never });

    expect(() => normalizeTaskContract(contract)).toThrow(
      expect.objectContaining({ code: "invalid_minimum_decision_grade" }),
    );
  });

  it("rejects an unknown riskClass", () => {
    const contract = buildContract({ riskClass: "critical" as never });

    expect(() => normalizeTaskContract(contract)).toThrow(
      expect.objectContaining({ code: "invalid_risk_class" }),
    );
  });

  it("rejects an unknown deliveryMode", () => {
    const contract = buildContract({ deliveryMode: "email" as never });

    expect(() => normalizeTaskContract(contract)).toThrow(
      expect.objectContaining({ code: "invalid_delivery_mode" }),
    );
  });

  it("rejects an unknown dataPolicy", () => {
    const contract = buildContract({
      requiredCapabilities: {
        ...buildContract().requiredCapabilities,
        dataPolicy: "any-provider" as never,
      },
    });

    expect(() => normalizeTaskContract(contract)).toThrow(
      expect.objectContaining({ code: "invalid_data_policy" }),
    );
  });

  it("rejects an unsupported schemaVersion", () => {
    const contract = buildContract({ schemaVersion: 2 as never });

    expect(() => normalizeTaskContract(contract)).toThrow(
      expect.objectContaining({ code: "unsupported_schema_version" }),
    );
  });

  it.each([
    ["minContextWindowTokens", 0],
    ["minContextWindowTokens", -1],
    ["minContextWindowTokens", 1.5],
    ["minOutputTokens", 0],
    ["minOutputTokens", -1],
    ["minOutputTokens", 1.5],
  ] as const)("rejects a non-positive-integer %s of %d", (field, value) => {
    const contract = buildContract({
      requiredCapabilities: {
        ...buildContract().requiredCapabilities,
        [field]: value,
      },
    });

    expect(() => normalizeTaskContract(contract)).toThrow(
      expect.objectContaining({
        code:
          field === "minContextWindowTokens"
            ? "invalid_min_context_window_tokens"
            : "invalid_min_output_tokens",
      }),
    );
  });
});

describe("digestTaskContract", () => {
  it("produces the same digest for synonymous input in a different order", () => {
    const a = normalizeTaskContract(
      buildContract({
        requiredCapabilities: {
          ...buildContract().requiredCapabilities,
          modalities: ["text", "image"],
          runtimeIds: ["b", "a"],
        },
      }),
    );
    const b = normalizeTaskContract(
      buildContract({
        requiredCapabilities: {
          ...buildContract().requiredCapabilities,
          modalities: ["image", "text", "image"],
          runtimeIds: ["a", "b", "a"],
        },
      }),
    );

    expect(digestTaskContract(a)).toBe(digestTaskContract(b));
  });

  it("changes when a meaningful field changes", () => {
    const base = normalizeTaskContract(buildContract());
    const changed = normalizeTaskContract(buildContract({ riskClass: "high" }));

    expect(digestTaskContract(base)).not.toBe(digestTaskContract(changed));
  });

  it("matches the sha256:<64 lowercase hex> format", () => {
    const digest = digestTaskContract(normalizeTaskContract(buildContract()));

    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("does not vary with wall-clock time or process randomness", () => {
    const contract = buildContract();
    const first = digestTaskContract(normalizeTaskContract(contract));
    const second = digestTaskContract(normalizeTaskContract(structuredClone(contract)));

    expect(first).toBe(second);
  });
});
