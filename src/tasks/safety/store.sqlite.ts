// Single Core store entry point for Phase 1 safe-routing SQLite facts.
// Plugins and CLI code must go through this module; nothing else may open a
// Kysely handle against task_contracts/task_checkpoints/
// model_capability_snapshots/model_route_attempts.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createTaskRecord } from "../runtime-internal.js";
import { upsertTaskRegistryRecordToSqlite } from "../task-registry.store.sqlite.js";
import type { TaskRecord } from "../task-registry.types.js";
import type {
  ObservationLease,
  ObservationLeaseState,
  ObservationLeaseStore,
} from "./observation-lease.js";
import type {
  AppendRouteAttemptInput,
  CapabilitySnapshotRow,
  CreateTaskCheckpointInput,
  CreateTaskContractInput,
  PutCapabilitySnapshotInput,
  RouteAttemptRow,
  TaskCheckpointRow,
  TaskContractRow,
  UpdateRouteAttemptObservationInput,
} from "./store.types.js";

const log = createSubsystemLogger("tasks.safety.store");

type SafetyStoreDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "task_contracts" | "task_checkpoints" | "model_capability_snapshots" | "model_route_attempts"
>;

function getSafetyKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<SafetyStoreDatabase>(db);
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
}

function parseJsonStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function insertTaskContractRow(
  db: DatabaseSync,
  taskId: string,
  input: CreateTaskContractInput,
  now: number,
): void {
  executeSqliteQuerySync(
    db,
    getSafetyKysely(db)
      .insertInto("task_contracts")
      .values({
        task_id: taskId,
        schema_version: input.schemaVersion,
        contract_json: input.contractJson,
        contract_digest: input.contractDigest,
        risk_class: input.riskClass,
        review_required: input.reviewRequired ? 1 : 0,
        delivery_mode: input.deliveryMode,
        routing_policy_version: input.routingPolicyVersion,
        created_at: now,
        updated_at: now,
      }),
  );
}

function insertTaskCheckpointRow(
  db: DatabaseSync,
  taskId: string,
  checkpointId: string,
  input: CreateTaskCheckpointInput,
  now: number,
): void {
  executeSqliteQuerySync(
    db,
    getSafetyKysely(db)
      .insertInto("task_checkpoints")
      .values({
        checkpoint_id: checkpointId,
        task_id: taskId,
        sequence: input.sequence,
        contract_digest: input.contractDigest,
        input_digest: input.inputDigest,
        routing_policy_version: input.routingPolicyVersion,
        config_digest: input.configDigest,
        plugin_registry_digest: input.pluginRegistryDigest,
        candidate_chain_digest: input.candidateChainDigest,
        capability_snapshot_ids_json: serializeJson(input.capabilitySnapshotIds ?? []),
        manifest_json: input.manifest !== undefined ? serializeJson(input.manifest) : null,
        created_at: now,
      }),
  );
}

/**
 * Atomically creates a new managed (safe-routing shadow) task together with
 * its contract and first minimal checkpoint. Reuses task-registry's own
 * record-building/dedup/indices/observer-event pipeline via `persistOverride`
 * so only the persistence step is swapped — old task-creation call sites are
 * completely unaffected since none of them pass this option.
 */
export function createManagedTaskWithCheckpoint(params: {
  // requesterOrigin is excluded: it drives createTaskRecord's deliveryState,
  // but the persistOverride below only persists task/contract/checkpoint rows
  // and has no delivery-state column to put it in, so a caller-supplied
  // requesterOrigin would be silently dropped instead of persisted.
  task: Omit<Parameters<typeof createTaskRecord>[0], "persistOverride" | "requesterOrigin">;
  contract: CreateTaskContractInput;
  checkpoint: CreateTaskCheckpointInput;
  /**
   * Runs inside the same write transaction as the task/contract/checkpoint
   * insert, after the checkpoint row exists but before persistOverride
   * returns. Throwing here rolls the whole insert back and this function
   * returns null, exactly like any other persistence failure — safe because
   * createTaskRecord only updates its in-memory registry after
   * persistOverride returns true, and that never happens if this throws.
   * Do not open a transaction of your own caller-side and call this from
   * inside it: createTaskRecord's in-memory update fires as soon as this
   * function's own transaction reports success, so it must remain the
   * outermost, truly-committing transaction for that update to stay safe.
   */
  afterCheckpoint?: (ids: { taskId: string; checkpointId: string }) => void;
}): { task: TaskRecord; checkpointId: string } | null {
  let persistedCheckpointId: string | undefined;

  const record = createTaskRecord({
    ...params.task,
    persistOverride: (pendingRecord) => {
      try {
        return runOpenClawStateWriteTransaction(() => {
          const { db } = openOpenClawStateDatabase();
          upsertTaskRegistryRecordToSqlite(pendingRecord);
          const now = Date.now();
          insertTaskContractRow(db, pendingRecord.taskId, params.contract, now);
          const checkpointId = randomUUID();
          insertTaskCheckpointRow(db, pendingRecord.taskId, checkpointId, params.checkpoint, now);
          params.afterCheckpoint?.({ taskId: pendingRecord.taskId, checkpointId });
          persistedCheckpointId = checkpointId;
          return true;
        });
      } catch (error) {
        log.warn("Failed to persist managed task with checkpoint", {
          taskId: pendingRecord.taskId,
          error,
        });
        return false;
      }
    },
  });

  if (!record || !persistedCheckpointId) {
    return null;
  }
  return { task: record, checkpointId: persistedCheckpointId };
}

export function getTaskContract(taskId: string): TaskContractRow | undefined {
  const { db } = openOpenClawStateDatabase();
  const row = executeSqliteQuerySync(
    db,
    getSafetyKysely(db).selectFrom("task_contracts").selectAll().where("task_id", "=", taskId),
  ).rows[0];
  if (!row) {
    return undefined;
  }
  return {
    taskId: row.task_id,
    schemaVersion: row.schema_version,
    contractJson: row.contract_json,
    contractDigest: row.contract_digest,
    riskClass: row.risk_class,
    reviewRequired: row.review_required === 1,
    deliveryMode: row.delivery_mode,
    routingPolicyVersion: row.routing_policy_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCapabilitySnapshot(row: {
  snapshot_id: string;
  provider: string;
  model: string;
  runtime_id: string | null;
  verification_status: string;
  capabilities_json: string;
  evidence_json: string;
  snapshot_digest: string;
  created_at: number;
  expires_at: number | null;
}): CapabilitySnapshotRow {
  return {
    snapshotId: row.snapshot_id,
    provider: row.provider,
    model: row.model,
    ...(row.runtime_id !== null ? { runtimeId: row.runtime_id } : {}),
    verificationStatus: row.verification_status,
    capabilities: parseJsonRecord(row.capabilities_json) ?? {},
    evidence: parseJsonRecord(row.evidence_json) ?? {},
    snapshotDigest: row.snapshot_digest,
    createdAt: row.created_at,
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
  };
}

/**
 * Reuses an existing snapshot by digest; never rewrites an already-referenced
 * snapshot in place. Uses INSERT OR IGNORE + re-select so concurrent callers
 * racing the same digest converge on the same winning row.
 */
export function putCapabilitySnapshot(input: PutCapabilitySnapshotInput): CapabilitySnapshotRow {
  return runOpenClawStateWriteTransaction(() => {
    const { db } = openOpenClawStateDatabase();
    const kysely = getSafetyKysely(db);
    const existing = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("model_capability_snapshots")
        .selectAll()
        .where("snapshot_digest", "=", input.snapshotDigest),
    ).rows[0];
    if (existing) {
      return rowToCapabilitySnapshot(existing);
    }
    const snapshotId = randomUUID();
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("model_capability_snapshots")
        .values({
          snapshot_id: snapshotId,
          provider: input.provider,
          model: input.model,
          runtime_id: input.runtimeId ?? null,
          verification_status: input.verificationStatus,
          capabilities_json: serializeJson(input.capabilities),
          evidence_json: serializeJson(input.evidence),
          snapshot_digest: input.snapshotDigest,
          created_at: now,
          expires_at: input.expiresAt ?? null,
        })
        .onConflict((conflict) => conflict.column("snapshot_digest").doNothing()),
    );
    const row = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("model_capability_snapshots")
        .selectAll()
        .where("snapshot_digest", "=", input.snapshotDigest),
    ).rows[0];
    if (!row) {
      throw new Error(
        `Failed to persist or find capability snapshot for digest ${input.snapshotDigest}`,
      );
    }
    return rowToCapabilitySnapshot(row);
  });
}

/** Batch-inserts route attempts atomically: a failure on any one leaves no partial candidate chain. */
export function appendRouteAttempts(
  taskId: string,
  checkpointId: string,
  attempts: readonly AppendRouteAttemptInput[],
): RouteAttemptRow[] {
  if (attempts.length === 0) {
    return [];
  }
  return runOpenClawStateWriteTransaction(() => {
    const { db } = openOpenClawStateDatabase();
    const kysely = getSafetyKysely(db);
    const now = Date.now();
    const rows: RouteAttemptRow[] = attempts.map((attempt) => ({
      ...attempt,
      attemptId: randomUUID(),
      taskId,
      checkpointId,
      createdAt: now,
    }));
    for (const row of rows) {
      executeSqliteQuerySync(
        db,
        kysely.insertInto("model_route_attempts").values({
          attempt_id: row.attemptId,
          task_id: row.taskId,
          checkpoint_id: row.checkpointId,
          ordinal: row.ordinal,
          provider: row.provider,
          model: row.model,
          runtime_id: row.runtimeId ?? null,
          run_id: row.runId ?? null,
          call_id: row.callId ?? null,
          capability_snapshot_id: row.capabilitySnapshotId,
          evaluation_mode: row.evaluationMode,
          eligibility: row.eligibility,
          rejection_code: row.rejectionCode ?? null,
          rejection_reason: row.rejectionReason ?? null,
          would_select: row.wouldSelect ? 1 : 0,
          auth_profile_ref: row.authProfileRef ?? null,
          endpoint_id: row.endpointId ?? null,
          failure_domain_json:
            row.failureDomain !== undefined ? serializeJson(row.failureDomain) : null,
          observation_completeness: row.observationCompleteness,
          observation_coverage: row.observationCoverage,
          observer_error_code: row.observerErrorCode ?? null,
          created_at: row.createdAt,
        }),
      );
    }
    return rows;
  });
}

export function listRouteAttempts(taskId: string, checkpointId: string): RouteAttemptRow[] {
  const { db } = openOpenClawStateDatabase();
  const kysely = getSafetyKysely(db);
  const rows = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("model_route_attempts")
      .selectAll()
      .where("task_id", "=", taskId)
      .where("checkpoint_id", "=", checkpointId)
      .orderBy("ordinal", "asc"),
  ).rows;
  return rows.map((row) => {
    const attempt: RouteAttemptRow = {
      attemptId: row.attempt_id,
      taskId: row.task_id,
      checkpointId: row.checkpoint_id,
      ordinal: row.ordinal,
      provider: row.provider,
      model: row.model,
      capabilitySnapshotId: row.capability_snapshot_id,
      evaluationMode: row.evaluation_mode,
      eligibility: row.eligibility,
      wouldSelect: row.would_select === 1,
      observationCompleteness: row.observation_completeness,
      observationCoverage: row.observation_coverage,
      createdAt: row.created_at,
    };
    if (row.runtime_id !== null) {
      attempt.runtimeId = row.runtime_id;
    }
    if (row.run_id !== null) {
      attempt.runId = row.run_id;
    }
    if (row.call_id !== null) {
      attempt.callId = row.call_id;
    }
    if (row.rejection_code !== null) {
      attempt.rejectionCode = row.rejection_code;
    }
    if (row.rejection_reason !== null) {
      attempt.rejectionReason = row.rejection_reason;
    }
    if (row.auth_profile_ref !== null) {
      attempt.authProfileRef = row.auth_profile_ref;
    }
    if (row.endpoint_id !== null) {
      attempt.endpointId = row.endpoint_id;
    }
    if (row.failure_domain_json !== null) {
      attempt.failureDomain = parseJsonRecord(row.failure_domain_json);
    }
    if (row.observer_error_code !== null) {
      attempt.observerErrorCode = row.observer_error_code;
    }
    return attempt;
  });
}

function rowToTaskCheckpoint(row: {
  checkpoint_id: string;
  task_id: string;
  sequence: number;
  contract_digest: string;
  input_digest: string;
  routing_policy_version: string;
  config_digest: string;
  plugin_registry_digest: string;
  candidate_chain_digest: string;
  capability_snapshot_ids_json: string;
  manifest_json: string | null;
  observation_lease_id: string | null;
  lease_expires_at: number | null;
  lease_state: string | null;
  session_binding_digest: string | null;
  lease_token_digest: string | null;
  token_consumed_at: number | null;
  bound_run_id: string | null;
  bound_call_id: string | null;
  row_version: number;
  created_at: number;
}): TaskCheckpointRow {
  return {
    checkpointId: row.checkpoint_id,
    taskId: row.task_id,
    sequence: row.sequence,
    contractDigest: row.contract_digest,
    inputDigest: row.input_digest,
    routingPolicyVersion: row.routing_policy_version,
    configDigest: row.config_digest,
    pluginRegistryDigest: row.plugin_registry_digest,
    candidateChainDigest: row.candidate_chain_digest,
    capabilitySnapshotIds: parseJsonStringArray(row.capability_snapshot_ids_json),
    ...(row.manifest_json !== null ? { manifest: parseJsonRecord(row.manifest_json) } : {}),
    ...(row.observation_lease_id !== null ? { observationLeaseId: row.observation_lease_id } : {}),
    ...(row.lease_expires_at !== null ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.lease_state !== null ? { leaseState: row.lease_state } : {}),
    ...(row.session_binding_digest !== null
      ? { sessionBindingDigest: row.session_binding_digest }
      : {}),
    ...(row.lease_token_digest !== null ? { leaseTokenDigest: row.lease_token_digest } : {}),
    ...(row.token_consumed_at !== null ? { tokenConsumedAt: row.token_consumed_at } : {}),
    ...(row.bound_run_id !== null ? { boundRunId: row.bound_run_id } : {}),
    ...(row.bound_call_id !== null ? { boundCallId: row.bound_call_id } : {}),
    rowVersion: row.row_version,
    createdAt: row.created_at,
  };
}

export function getTaskCheckpoint(checkpointId: string): TaskCheckpointRow | undefined {
  const { db } = openOpenClawStateDatabase();
  const row = executeSqliteQuerySync(
    db,
    getSafetyKysely(db)
      .selectFrom("task_checkpoints")
      .selectAll()
      .where("checkpoint_id", "=", checkpointId),
  ).rows[0];
  return row ? rowToTaskCheckpoint(row) : undefined;
}

/** Phase 1 creates exactly one checkpoint (sequence 0) per managed task; this returns its most recent one. */
export function getTaskCheckpointByTaskId(taskId: string): TaskCheckpointRow | undefined {
  const { db } = openOpenClawStateDatabase();
  const row = executeSqliteQuerySync(
    db,
    getSafetyKysely(db)
      .selectFrom("task_checkpoints")
      .selectAll()
      .where("task_id", "=", taskId)
      .orderBy("sequence", "desc"),
  ).rows[0];
  return row ? rowToTaskCheckpoint(row) : undefined;
}

/** A checkpoint only doubles as a lease once its lease columns have been populated by `insert`. */
function checkpointToObservationLease(checkpoint: TaskCheckpointRow): ObservationLease | undefined {
  if (
    checkpoint.observationLeaseId === undefined ||
    checkpoint.leaseExpiresAt === undefined ||
    checkpoint.leaseState === undefined ||
    checkpoint.sessionBindingDigest === undefined ||
    checkpoint.leaseTokenDigest === undefined
  ) {
    return undefined;
  }
  return {
    leaseId: checkpoint.observationLeaseId,
    taskId: checkpoint.taskId,
    checkpointId: checkpoint.checkpointId,
    sessionBindingDigest: checkpoint.sessionBindingDigest,
    leaseTokenDigest: checkpoint.leaseTokenDigest,
    contractDigest: checkpoint.contractDigest,
    configDigest: checkpoint.configDigest,
    pluginRegistryDigest: checkpoint.pluginRegistryDigest,
    candidateChainDigest: checkpoint.candidateChainDigest,
    expiresAt: checkpoint.leaseExpiresAt,
    state: checkpoint.leaseState as ObservationLeaseState,
    ...(checkpoint.tokenConsumedAt !== undefined
      ? { tokenConsumedAt: checkpoint.tokenConsumedAt }
      : {}),
    ...(checkpoint.boundRunId !== undefined ? { boundRunId: checkpoint.boundRunId } : {}),
    ...(checkpoint.boundCallId !== undefined ? { boundCallId: checkpoint.boundCallId } : {}),
    rowVersion: checkpoint.rowVersion,
  };
}

/**
 * SQLite-backed `ObservationLeaseStore`: a lease is not a separate row, it is
 * the lease-shaped columns on the checkpoint row it was created against (see
 * Task 3 schema notes). `insert` therefore updates the existing checkpoint
 * rather than creating a new record.
 */
export function createSqliteObservationLeaseStore(): ObservationLeaseStore {
  return {
    insert(lease) {
      runOpenClawStateWriteTransaction(() => {
        const { db } = openOpenClawStateDatabase();
        // At most one live pending lease per session: supersede any other
        // still-pending lease for the same session inside this same
        // transaction, so a real hook event can never bind to a stale,
        // already-replaced lease (the new row's own session_binding_digest is
        // still NULL at this point, so it cannot match and supersede itself).
        // row_version must be bumped here too (matching the in-memory store),
        // otherwise a concurrent CAS still holding the pre-supersede
        // row_version would match this row's unchanged row_version and
        // resurrect the superseded lease back to bound/complete.
        executeSqliteQuerySync(
          db,
          getSafetyKysely(db)
            .updateTable("task_checkpoints")
            .set({
              lease_state: "superseded",
              row_version:
                // kysely-allow-raw: increments in place; the exact prior value
                // is irrelevant, only that any concurrent CAS's expected
                // row_version can no longer match after this commits.
                sql<number>`row_version + 1`,
            })
            .where("session_binding_digest", "=", lease.sessionBindingDigest)
            .where("lease_state", "=", "pending"),
        );
        const result = executeSqliteQuerySync(
          db,
          getSafetyKysely(db)
            .updateTable("task_checkpoints")
            .set({
              observation_lease_id: lease.leaseId,
              lease_expires_at: lease.expiresAt,
              lease_state: lease.state,
              session_binding_digest: lease.sessionBindingDigest,
              lease_token_digest: lease.leaseTokenDigest,
              token_consumed_at: lease.tokenConsumedAt ?? null,
              bound_run_id: lease.boundRunId ?? null,
              bound_call_id: lease.boundCallId ?? null,
              row_version: lease.rowVersion,
            })
            .where("checkpoint_id", "=", lease.checkpointId),
        );
        if ((result.numAffectedRows ?? 0n) !== 1n) {
          throw new Error(
            `observation lease insert affected ${result.numAffectedRows ?? 0n} row(s) for checkpointId=${lease.checkpointId}, expected exactly 1`,
          );
        }
      });
    },
    findById(leaseId) {
      const { db } = openOpenClawStateDatabase();
      const row = executeSqliteQuerySync(
        db,
        getSafetyKysely(db)
          .selectFrom("task_checkpoints")
          .selectAll()
          .where("observation_lease_id", "=", leaseId),
      ).rows[0];
      return row ? checkpointToObservationLease(rowToTaskCheckpoint(row)) : undefined;
    },
    findPendingBySessionBindingDigest(sessionBindingDigest) {
      const { db } = openOpenClawStateDatabase();
      const row = executeSqliteQuerySync(
        db,
        getSafetyKysely(db)
          .selectFrom("task_checkpoints")
          .selectAll()
          .where("session_binding_digest", "=", sessionBindingDigest)
          .where("lease_state", "=", "pending"),
      ).rows[0];
      return row ? checkpointToObservationLease(rowToTaskCheckpoint(row)) : undefined;
    },
    findBoundByRunAndCall(runId, callId) {
      const { db } = openOpenClawStateDatabase();
      const row = executeSqliteQuerySync(
        db,
        getSafetyKysely(db)
          .selectFrom("task_checkpoints")
          .selectAll()
          .where("bound_run_id", "=", runId)
          .where("bound_call_id", "=", callId)
          .where("lease_state", "=", "bound"),
      ).rows[0];
      return row ? checkpointToObservationLease(rowToTaskCheckpoint(row)) : undefined;
    },
    compareAndSwap(leaseId, expectedRowVersion, patch) {
      return runOpenClawStateWriteTransaction(() => {
        const { db } = openOpenClawStateDatabase();
        const result = executeSqliteQuerySync(
          db,
          getSafetyKysely(db)
            .updateTable("task_checkpoints")
            .set({
              ...(patch.state !== undefined ? { lease_state: patch.state } : {}),
              ...(patch.tokenConsumedAt !== undefined
                ? { token_consumed_at: patch.tokenConsumedAt }
                : {}),
              ...(patch.boundRunId !== undefined ? { bound_run_id: patch.boundRunId } : {}),
              ...(patch.boundCallId !== undefined ? { bound_call_id: patch.boundCallId } : {}),
              row_version: expectedRowVersion + 1,
            })
            .where("observation_lease_id", "=", leaseId)
            .where("row_version", "=", expectedRowVersion),
        );
        return (result.numAffectedRows ?? 0n) > 0n;
      });
    },
  };
}

/**
 * Updates a previously-appended route attempt's observed-call fields once a
 * real model_call_started/model_call_ended event correlates to it. Idempotent:
 * a repeat update carrying the same runId/callId onto an already-"complete"
 * attempt is a no-op, so duplicate ended events never double-write. Also a
 * one-way ratchet on "partial": once digest drift has been recorded, a later
 * write cannot launder the row back to "complete" (see call site).
 */
export function updateRouteAttemptObservation(
  attemptId: string,
  patch: UpdateRouteAttemptObservationInput,
): boolean {
  return runOpenClawStateWriteTransaction(() => {
    const { db } = openOpenClawStateDatabase();
    const kysely = getSafetyKysely(db);
    const existing = executeSqliteQuerySync(
      db,
      kysely.selectFrom("model_route_attempts").selectAll().where("attempt_id", "=", attemptId),
    ).rows[0];
    if (!existing) {
      return false;
    }
    if (
      existing.observation_completeness === "complete" &&
      existing.run_id === (patch.runId ?? null) &&
      existing.call_id === (patch.callId ?? null)
    ) {
      return true;
    }
    // "partial" is a terminal, one-way ratchet: once digest drift has been
    // recorded anywhere in this attempt's lifecycle (evaluate-time or
    // hook-observation-time), a later hook event observing only its own
    // point-in-time consistency must not launder the row back to "complete".
    if (
      existing.observation_completeness === "partial" &&
      patch.observationCompleteness === "complete"
    ) {
      return true;
    }
    const result = executeSqliteQuerySync(
      db,
      kysely
        .updateTable("model_route_attempts")
        .set({
          run_id: patch.runId ?? null,
          call_id: patch.callId ?? null,
          observation_completeness: patch.observationCompleteness,
          observation_coverage: patch.observationCoverage,
          observer_error_code: patch.observerErrorCode ?? null,
        })
        .where("attempt_id", "=", attemptId),
    );
    return (result.numAffectedRows ?? 0n) > 0n;
  });
}
