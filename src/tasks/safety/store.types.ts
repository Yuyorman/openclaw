// Domain-shaped (camelCase) row and input types for the Phase 1 safe-routing
// SQLite facts: task contracts, checkpoints, capability snapshots, and route
// attempts. See store.sqlite.ts for the single Core store entry point.

export type CreateTaskContractInput = {
  schemaVersion: number;
  contractJson: string;
  contractDigest: string;
  riskClass: string;
  reviewRequired: boolean;
  deliveryMode: string;
  routingPolicyVersion: string;
};

export type TaskContractRow = CreateTaskContractInput & {
  taskId: string;
  createdAt: number;
  updatedAt: number;
};

export type CreateTaskCheckpointInput = {
  sequence: number;
  contractDigest: string;
  inputDigest: string;
  routingPolicyVersion: string;
  configDigest: string;
  pluginRegistryDigest: string;
  candidateChainDigest: string;
  capabilitySnapshotIds?: string[];
  manifest?: Record<string, unknown>;
};

/** First minimal checkpoint written at task creation. Lease/binding fields are
 * populated later (Task 5/6), not by createManagedTaskWithCheckpoint. */
export type TaskCheckpointRow = {
  checkpointId: string;
  taskId: string;
  sequence: number;
  contractDigest: string;
  inputDigest: string;
  routingPolicyVersion: string;
  configDigest: string;
  pluginRegistryDigest: string;
  candidateChainDigest: string;
  capabilitySnapshotIds: string[];
  manifest?: Record<string, unknown>;
  observationLeaseId?: string;
  leaseExpiresAt?: number;
  leaseState?: string;
  sessionBindingDigest?: string;
  leaseTokenDigest?: string;
  tokenConsumedAt?: number;
  boundRunId?: string;
  boundCallId?: string;
  rowVersion: number;
  createdAt: number;
};

export type PutCapabilitySnapshotInput = {
  provider: string;
  model: string;
  runtimeId?: string;
  verificationStatus: string;
  capabilities: Record<string, unknown>;
  evidence: Record<string, unknown>;
  snapshotDigest: string;
  expiresAt?: number;
};

export type CapabilitySnapshotRow = {
  snapshotId: string;
  provider: string;
  model: string;
  runtimeId?: string;
  verificationStatus: string;
  capabilities: Record<string, unknown>;
  evidence: Record<string, unknown>;
  snapshotDigest: string;
  createdAt: number;
  expiresAt?: number;
};

export type AppendRouteAttemptInput = {
  ordinal: number;
  provider: string;
  model: string;
  runtimeId?: string;
  runId?: string;
  callId?: string;
  capabilitySnapshotId: string;
  evaluationMode: string;
  eligibility: string;
  rejectionCode?: string;
  rejectionReason?: string;
  wouldSelect: boolean;
  authProfileRef?: string;
  endpointId?: string;
  failureDomain?: Record<string, unknown>;
  observationCompleteness: string;
  observationCoverage: string;
  observerErrorCode?: string;
};

export type RouteAttemptRow = AppendRouteAttemptInput & {
  attemptId: string;
  taskId: string;
  checkpointId: string;
  createdAt: number;
};

/** Patches a previously-appended route attempt's observed-call fields once a real hook event correlates to it. */
export type UpdateRouteAttemptObservationInput = {
  runId?: string;
  callId?: string;
  observationCompleteness: string;
  observationCoverage: string;
  observerErrorCode?: string;
};
