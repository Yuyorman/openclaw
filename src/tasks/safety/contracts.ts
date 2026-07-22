import { stableStringify } from "../../agents/stable-stringify.js";
import { sha256Hex } from "../../infra/crypto-digest.js";

export type TaskContractModality = "text" | "image" | "audio";
export type TaskContractDecisionGrade = "draft" | "analysis" | "decision" | "final";
export type TaskContractRiskClass = "low" | "medium" | "high";
export type TaskContractDeliveryMode = "none" | "internal" | "formal";
export type TaskContractDataPolicy = "local-only" | "approved-providers";

export type TaskCapabilityRequirements = {
  modalities: TaskContractModality[];
  minContextWindowTokens: number;
  minOutputTokens: number;
  toolCalling: boolean;
  structuredOutput: boolean;
  runtimeIds?: string[];
  dataPolicy: TaskContractDataPolicy;
};

export type PersistedTaskContract = {
  schemaVersion: 1;
  taskId: string;
  requiredCapabilities: TaskCapabilityRequirements;
  minimumDecisionGrade: TaskContractDecisionGrade;
  riskClass: TaskContractRiskClass;
  reviewRequired: boolean;
  allowedToolPolicyId: string;
  deliveryMode: TaskContractDeliveryMode;
  routingPolicyVersion: string;
};

export type NormalizedTaskContract = {
  schemaVersion: 1;
  taskId: string;
  requiredCapabilities: {
    modalities: TaskContractModality[];
    minContextWindowTokens: number;
    minOutputTokens: number;
    toolCalling: boolean;
    structuredOutput: boolean;
    runtimeIds: string[];
    dataPolicy: TaskContractDataPolicy;
  };
  minimumDecisionGrade: TaskContractDecisionGrade;
  riskClass: TaskContractRiskClass;
  reviewRequired: boolean;
  allowedToolPolicyId: string;
  deliveryMode: TaskContractDeliveryMode;
  routingPolicyVersion: string;
};

export type TaskContractErrorCode =
  | "unsupported_schema_version"
  | "invalid_shape"
  | "invalid_task_id"
  | "invalid_modality"
  | "invalid_min_context_window_tokens"
  | "invalid_min_output_tokens"
  | "invalid_data_policy"
  | "invalid_minimum_decision_grade"
  | "invalid_risk_class"
  | "invalid_allowed_tool_policy_id"
  | "invalid_delivery_mode"
  | "invalid_routing_policy_version";

export class TaskContractError extends Error {
  constructor(
    public readonly code: TaskContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskContractError";
  }
}

const MODALITIES = new Set<string>(["text", "image", "audio"] satisfies TaskContractModality[]);
const DECISION_GRADES = new Set<string>([
  "draft",
  "analysis",
  "decision",
  "final",
] satisfies TaskContractDecisionGrade[]);
const RISK_CLASSES = new Set<string>(["low", "medium", "high"] satisfies TaskContractRiskClass[]);
const DELIVERY_MODES = new Set<string>([
  "none",
  "internal",
  "formal",
] satisfies TaskContractDeliveryMode[]);
const DATA_POLICIES = new Set<string>([
  "local-only",
  "approved-providers",
] satisfies TaskContractDataPolicy[]);

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Drops empty strings, dedupes, and sorts so equivalent lists normalize identically. */
function normalizeStringList(values: readonly string[] | undefined): string[] {
  const deduped = new Set<string>();
  for (const value of values ?? []) {
    if (value !== "") {
      deduped.add(value);
    }
  }
  return [...deduped].toSorted();
}

/** Validates and canonicalizes a task contract so equivalent inputs digest identically. */
export function normalizeTaskContract(input: PersistedTaskContract): NormalizedTaskContract {
  if (typeof input !== "object" || input === null) {
    throw new TaskContractError("invalid_shape", "Task contract must be a JSON object");
  }
  if ((input.schemaVersion as number) !== 1) {
    throw new TaskContractError(
      "unsupported_schema_version",
      `Unsupported task contract schemaVersion: ${String(input.schemaVersion)}`,
    );
  }
  if (typeof input.taskId !== "string" || input.taskId === "") {
    throw new TaskContractError("invalid_task_id", "taskId must be a non-empty string");
  }
  if (typeof input.requiredCapabilities !== "object" || input.requiredCapabilities === null) {
    throw new TaskContractError("invalid_shape", "requiredCapabilities must be a JSON object");
  }
  if (
    input.requiredCapabilities.modalities !== undefined &&
    !Array.isArray(input.requiredCapabilities.modalities)
  ) {
    throw new TaskContractError(
      "invalid_shape",
      "requiredCapabilities.modalities must be an array",
    );
  }
  if (
    input.requiredCapabilities.runtimeIds !== undefined &&
    !Array.isArray(input.requiredCapabilities.runtimeIds)
  ) {
    throw new TaskContractError(
      "invalid_shape",
      "requiredCapabilities.runtimeIds must be an array",
    );
  }
  if (typeof input.requiredCapabilities.toolCalling !== "boolean") {
    throw new TaskContractError(
      "invalid_shape",
      "requiredCapabilities.toolCalling must be a boolean",
    );
  }
  if (typeof input.requiredCapabilities.structuredOutput !== "boolean") {
    throw new TaskContractError(
      "invalid_shape",
      "requiredCapabilities.structuredOutput must be a boolean",
    );
  }
  if (typeof input.reviewRequired !== "boolean") {
    throw new TaskContractError("invalid_shape", "reviewRequired must be a boolean");
  }

  const modalities = normalizeStringList(
    input.requiredCapabilities.modalities,
  ) as TaskContractModality[];
  for (const modality of modalities) {
    if (!MODALITIES.has(modality)) {
      throw new TaskContractError("invalid_modality", `Unknown modality: ${modality}`);
    }
  }

  if (!isPositiveInteger(input.requiredCapabilities.minContextWindowTokens)) {
    throw new TaskContractError(
      "invalid_min_context_window_tokens",
      "requiredCapabilities.minContextWindowTokens must be a positive integer",
    );
  }
  if (!isPositiveInteger(input.requiredCapabilities.minOutputTokens)) {
    throw new TaskContractError(
      "invalid_min_output_tokens",
      "requiredCapabilities.minOutputTokens must be a positive integer",
    );
  }
  if (!DATA_POLICIES.has(input.requiredCapabilities.dataPolicy)) {
    throw new TaskContractError(
      "invalid_data_policy",
      `Unknown dataPolicy: ${input.requiredCapabilities.dataPolicy}`,
    );
  }
  if (!DECISION_GRADES.has(input.minimumDecisionGrade)) {
    throw new TaskContractError(
      "invalid_minimum_decision_grade",
      `Unknown minimumDecisionGrade: ${input.minimumDecisionGrade}`,
    );
  }
  if (!RISK_CLASSES.has(input.riskClass)) {
    throw new TaskContractError("invalid_risk_class", `Unknown riskClass: ${input.riskClass}`);
  }
  if (typeof input.allowedToolPolicyId !== "string" || input.allowedToolPolicyId === "") {
    throw new TaskContractError(
      "invalid_allowed_tool_policy_id",
      "allowedToolPolicyId must be a non-empty string",
    );
  }
  if (!DELIVERY_MODES.has(input.deliveryMode)) {
    throw new TaskContractError(
      "invalid_delivery_mode",
      `Unknown deliveryMode: ${input.deliveryMode}`,
    );
  }
  if (typeof input.routingPolicyVersion !== "string" || input.routingPolicyVersion === "") {
    throw new TaskContractError(
      "invalid_routing_policy_version",
      "routingPolicyVersion must be a non-empty string",
    );
  }

  return {
    schemaVersion: 1,
    taskId: input.taskId,
    requiredCapabilities: {
      modalities,
      minContextWindowTokens: input.requiredCapabilities.minContextWindowTokens,
      minOutputTokens: input.requiredCapabilities.minOutputTokens,
      toolCalling: input.requiredCapabilities.toolCalling,
      structuredOutput: input.requiredCapabilities.structuredOutput,
      runtimeIds: normalizeStringList(input.requiredCapabilities.runtimeIds),
      dataPolicy: input.requiredCapabilities.dataPolicy,
    },
    minimumDecisionGrade: input.minimumDecisionGrade,
    riskClass: input.riskClass,
    reviewRequired: input.reviewRequired,
    allowedToolPolicyId: input.allowedToolPolicyId,
    deliveryMode: input.deliveryMode,
    routingPolicyVersion: input.routingPolicyVersion,
  };
}

/** Digests a normalized contract; stable across process runs and independent of wall-clock time. */
export function digestTaskContract(contract: NormalizedTaskContract): string {
  return `sha256:${sha256Hex(stableStringify(contract))}`;
}
