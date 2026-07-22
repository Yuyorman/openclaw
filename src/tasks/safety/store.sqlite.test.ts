import { afterEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabase, openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureEnv } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createTaskRecord,
  listTaskRecordsUnsorted,
  resetTaskRegistryForTests,
} from "../task-registry.js";
import type { CreateTaskCheckpointInput, CreateTaskContractInput } from "./store.types.js";
import {
  appendRouteAttempts,
  createManagedTaskWithCheckpoint,
  createSqliteObservationLeaseStore,
  getTaskContract,
  listRouteAttempts,
  putCapabilitySnapshot,
  updateRouteAttemptObservation,
} from "./store.sqlite.js";

const ORIGINAL_ENV = captureEnv(["OPENCLAW_STATE_DIR"]);

type SafetyTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "task_runs" | "task_contracts" | "task_checkpoints" | "model_route_attempts"
>;

function buildContractInput(overrides: Partial<CreateTaskContractInput> = {}): CreateTaskContractInput {
  return {
    schemaVersion: 1,
    contractJson: '{"schemaVersion":1}',
    contractDigest: "sha256:contract-digest",
    riskClass: "low",
    reviewRequired: false,
    deliveryMode: "none",
    routingPolicyVersion: "v1",
    ...overrides,
  };
}

function buildCheckpointInput(overrides: Partial<CreateTaskCheckpointInput> = {}): CreateTaskCheckpointInput {
  return {
    sequence: 0,
    contractDigest: "sha256:contract-digest",
    inputDigest: "sha256:input-digest",
    routingPolicyVersion: "v1",
    configDigest: "sha256:config-digest",
    pluginRegistryDigest: "sha256:registry-digest",
    candidateChainDigest: "sha256:candidate-digest",
    ...overrides,
  };
}

function createManagedTask(overrides: {
  contract?: Partial<CreateTaskContractInput>;
  checkpoint?: Partial<CreateTaskCheckpointInput>;
} = {}) {
  const result = createManagedTaskWithCheckpoint({
    task: {
      runtime: "cli",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "safe-routing-readonly-shadow",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    },
    contract: buildContractInput(overrides.contract),
    checkpoint: buildCheckpointInput(overrides.checkpoint),
  });
  if (!result) {
    throw new Error("expected createManagedTaskWithCheckpoint to succeed");
  }
  return result;
}

describe("safety store sqlite", () => {
  afterEach(() => {
    ORIGINAL_ENV.restore();
    resetTaskRegistryForTests();
    loggingState.rawConsole = null;
    setLoggerOverride(null);
    resetLogger();
  });

  it("atomically persists task_runs, task_contracts, and the first checkpoint together", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-safety-store-create-" },
      async () => {
        resetTaskRegistryForTests();

        const { task, checkpointId } = createManagedTask();

        expect(checkpointId).toBeTruthy();
        const contract = getTaskContract(task.taskId);
        expect(contract).toMatchObject({
          taskId: task.taskId,
          contractDigest: "sha256:contract-digest",
          riskClass: "low",
          reviewRequired: false,
          deliveryMode: "none",
        });

        const { db } = openOpenClawStateDatabase();
        const kysely = getNodeSqliteKysely<SafetyTestDatabase>(db);
        const checkpointRow = executeSqliteQuerySync(
          db,
          kysely.selectFrom("task_checkpoints").selectAll().where("checkpoint_id", "=", checkpointId),
        ).rows[0];
        expect(checkpointRow).toMatchObject({
          task_id: task.taskId,
          sequence: 0,
          contract_digest: "sha256:contract-digest",
        });
        closeOpenClawStateDatabase();
      },
    );
  });

  it("rolls back all three record types when the checkpoint write fails, leaving no ghost task", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-safety-store-rollback-" },
      async () => {
        resetTaskRegistryForTests();

        const beforeCount = listTaskRecordsUnsorted().length;
        const { db } = openOpenClawStateDatabase();
        const kysely = getNodeSqliteKysely<SafetyTestDatabase>(db);
        const countTaskRuns = () =>
          executeSqliteQuerySync(db, kysely.selectFrom("task_runs").select((eb) => eb.fn.countAll().as("n")))
            .rows[0]?.n;
        const beforeTaskRuns = countTaskRuns();

        const circular: Record<string, unknown> = {};
        circular.self = circular;

        const result = createManagedTaskWithCheckpoint({
          task: {
            runtime: "cli",
            ownerKey: "agent:main:main",
            scopeKind: "session",
            task: "safe-routing-readonly-shadow",
            status: "succeeded",
            deliveryStatus: "not_applicable",
            notifyPolicy: "silent",
          },
          contract: buildContractInput(),
          checkpoint: buildCheckpointInput({ manifest: circular }),
        });

        expect(result).toBeNull();
        expect(listTaskRecordsUnsorted().length).toBe(beforeCount);
        expect(countTaskRuns()).toBe(beforeTaskRuns);
        closeOpenClawStateDatabase();
      },
    );
  });

  it("enforces one checkpoint per (task_id, sequence)", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-safety-store-dup-checkpoint-" },
      async () => {
        resetTaskRegistryForTests();
        const { task } = createManagedTask();

        const { db } = openOpenClawStateDatabase();
        const kysely = getNodeSqliteKysely<SafetyTestDatabase>(db);
        expect(() =>
          executeSqliteQuerySync(
            db,
            kysely.insertInto("task_checkpoints").values({
              checkpoint_id: "duplicate-sequence-checkpoint",
              task_id: task.taskId,
              sequence: 0,
              contract_digest: "sha256:contract-digest",
              input_digest: "sha256:input-digest",
              routing_policy_version: "v1",
              config_digest: "sha256:config-digest",
              plugin_registry_digest: "sha256:registry-digest",
              candidate_chain_digest: "sha256:candidate-digest",
              capability_snapshot_ids_json: "[]",
              created_at: Date.now(),
            }),
          ),
        ).toThrow();
        closeOpenClawStateDatabase();
      },
    );
  });

  it("reuses an existing capability snapshot by digest without rewriting it in place", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-safety-store-snapshot-" },
      async () => {
        resetTaskRegistryForTests();

        const first = putCapabilitySnapshot({
          provider: "anthropic",
          model: "claude-sonnet-5",
          verificationStatus: "verified",
          capabilities: { toolCalling: true },
          evidence: { probe: "initial" },
          snapshotDigest: "sha256:snapshot-digest",
        });

        const second = putCapabilitySnapshot({
          provider: "anthropic",
          model: "claude-sonnet-5",
          verificationStatus: "contradicted",
          capabilities: { toolCalling: false },
          evidence: { probe: "later-conflicting-call" },
          snapshotDigest: "sha256:snapshot-digest",
        });

        expect(second).toEqual(first);
        expect(second.verificationStatus).toBe("verified");
        expect(second.capabilities).toEqual({ toolCalling: true });
        closeOpenClawStateDatabase();
      },
    );
  });

  it("rejects a route attempt referencing a nonexistent capability snapshot and leaves no partial chain", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-safety-store-route-fk-" },
      async () => {
        resetTaskRegistryForTests();
        const { task, checkpointId } = createManagedTask();
        const snapshot = putCapabilitySnapshot({
          provider: "anthropic",
          model: "claude-sonnet-5",
          verificationStatus: "verified",
          capabilities: {},
          evidence: {},
          snapshotDigest: "sha256:valid-snapshot",
        });

        expect(() =>
          appendRouteAttempts(task.taskId, checkpointId, [
            {
              ordinal: 0,
              provider: "anthropic",
              model: "claude-sonnet-5",
              capabilitySnapshotId: snapshot.snapshotId,
              evaluationMode: "shadow",
              eligibility: "eligible",
              wouldSelect: true,
              observationCompleteness: "unavailable",
              observationCoverage: "out-of-scope",
            },
            {
              ordinal: 1,
              provider: "openai",
              model: "gpt-5.4",
              capabilitySnapshotId: "nonexistent-snapshot-id",
              evaluationMode: "shadow",
              eligibility: "rejected",
              wouldSelect: false,
              observationCompleteness: "unavailable",
              observationCoverage: "out-of-scope",
            },
          ]),
        ).toThrow();

        expect(listRouteAttempts(task.taskId, checkpointId)).toEqual([]);
        closeOpenClawStateDatabase();
      },
    );
  });

  it("attaches, finds, and CAS-updates a lease on its checkpoint row via the SQLite lease store", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-safety-store-lease-" },
      async () => {
        resetTaskRegistryForTests();
        const { task, checkpointId } = createManagedTask();
        const leaseStore = createSqliteObservationLeaseStore();

        leaseStore.insert({
          leaseId: "lease-1",
          taskId: task.taskId,
          checkpointId,
          sessionBindingDigest: "sha256:session-digest",
          leaseTokenDigest: "sha256:token-digest",
          contractDigest: "sha256:contract-digest",
          configDigest: "sha256:config-digest",
          pluginRegistryDigest: "sha256:registry-digest",
          candidateChainDigest: "sha256:candidate-digest",
          expiresAt: Date.now() + 60_000,
          state: "pending",
          rowVersion: 1,
        });

        const byId = leaseStore.findById("lease-1");
        expect(byId).toMatchObject({ taskId: task.taskId, checkpointId, state: "pending", rowVersion: 1 });

        const byPending = leaseStore.findPendingBySessionBindingDigest("sha256:session-digest");
        expect(byPending?.leaseId).toBe("lease-1");

        const casApplied = leaseStore.compareAndSwap("lease-1", 1, {
          state: "bound",
          boundRunId: "run-1",
          boundCallId: "call-1",
        });
        expect(casApplied).toBe(true);

        expect(leaseStore.findPendingBySessionBindingDigest("sha256:session-digest")).toBeUndefined();
        const byBound = leaseStore.findBoundByRunAndCall("run-1", "call-1");
        expect(byBound).toMatchObject({ leaseId: "lease-1", state: "bound", rowVersion: 2 });

        closeOpenClawStateDatabase();
      },
    );
  });

  it("supersedes an existing pending lease for the same session when a second lease is inserted", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-safety-store-lease-supersede-" },
      async () => {
        resetTaskRegistryForTests();
        const first = createManagedTask();
        const second = createManagedTask();
        const leaseStore = createSqliteObservationLeaseStore();

        leaseStore.insert({
          leaseId: "lease-1",
          taskId: first.task.taskId,
          checkpointId: first.checkpointId,
          sessionBindingDigest: "sha256:session-digest",
          leaseTokenDigest: "sha256:token-digest-1",
          contractDigest: "sha256:contract-digest",
          configDigest: "sha256:config-digest",
          pluginRegistryDigest: "sha256:registry-digest",
          candidateChainDigest: "sha256:candidate-digest",
          expiresAt: Date.now() + 60_000,
          state: "pending",
          rowVersion: 1,
        });

        leaseStore.insert({
          leaseId: "lease-2",
          taskId: second.task.taskId,
          checkpointId: second.checkpointId,
          sessionBindingDigest: "sha256:session-digest",
          leaseTokenDigest: "sha256:token-digest-2",
          contractDigest: "sha256:contract-digest",
          configDigest: "sha256:config-digest",
          pluginRegistryDigest: "sha256:registry-digest",
          candidateChainDigest: "sha256:candidate-digest",
          expiresAt: Date.now() + 60_000,
          state: "pending",
          rowVersion: 1,
        });

        expect(leaseStore.findById("lease-1")).toMatchObject({ state: "superseded" });
        expect(leaseStore.findById("lease-2")).toMatchObject({ state: "pending" });
        expect(leaseStore.findPendingBySessionBindingDigest("sha256:session-digest")?.leaseId).toBe("lease-2");

        closeOpenClawStateDatabase();
      },
    );
  });

  it("throws and leaves no row affected when insert targets a nonexistent checkpoint", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-safety-store-lease-insert-missing-checkpoint-" },
      async () => {
        resetTaskRegistryForTests();
        const leaseStore = createSqliteObservationLeaseStore();

        expect(() =>
          leaseStore.insert({
            leaseId: "lease-1",
            taskId: "no-such-task",
            checkpointId: "no-such-checkpoint",
            sessionBindingDigest: "sha256:session-digest",
            leaseTokenDigest: "sha256:token-digest",
            contractDigest: "sha256:contract-digest",
            configDigest: "sha256:config-digest",
            pluginRegistryDigest: "sha256:registry-digest",
            candidateChainDigest: "sha256:candidate-digest",
            expiresAt: Date.now() + 60_000,
            state: "pending",
            rowVersion: 1,
          }),
        ).toThrow(/expected exactly 1/);

        expect(leaseStore.findById("lease-1")).toBeUndefined();
        closeOpenClawStateDatabase();
      },
    );
  });

  it("rejects a lease CAS whose expected rowVersion is stale, leaving the row untouched", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-safety-store-lease-cas-" },
      async () => {
        resetTaskRegistryForTests();
        const { task, checkpointId } = createManagedTask();
        const leaseStore = createSqliteObservationLeaseStore();
        leaseStore.insert({
          leaseId: "lease-1",
          taskId: task.taskId,
          checkpointId,
          sessionBindingDigest: "sha256:session-digest",
          leaseTokenDigest: "sha256:token-digest",
          contractDigest: "sha256:contract-digest",
          configDigest: "sha256:config-digest",
          pluginRegistryDigest: "sha256:registry-digest",
          candidateChainDigest: "sha256:candidate-digest",
          expiresAt: Date.now() + 60_000,
          state: "pending",
          rowVersion: 1,
        });

        const staleCas = leaseStore.compareAndSwap("lease-1", 99, { state: "partial" });
        expect(staleCas).toBe(false);
        expect(leaseStore.findById("lease-1")).toMatchObject({ state: "pending", rowVersion: 1 });

        closeOpenClawStateDatabase();
      },
    );
  });

  it("updates a route attempt's observed-call fields and is idempotent for a repeat terminal update", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-safety-store-observe-attempt-" },
      async () => {
        resetTaskRegistryForTests();
        const { task, checkpointId } = createManagedTask();
        const snapshot = putCapabilitySnapshot({
          provider: "anthropic",
          model: "claude-sonnet-5",
          verificationStatus: "verified",
          capabilities: {},
          evidence: {},
          snapshotDigest: "sha256:snapshot-digest",
        });
        const [attempt] = appendRouteAttempts(task.taskId, checkpointId, [
          {
            ordinal: 0,
            provider: "anthropic",
            model: "claude-sonnet-5",
            capabilitySnapshotId: snapshot.snapshotId,
            evaluationMode: "shadow",
            eligibility: "eligible",
            wouldSelect: true,
            observationCompleteness: "unavailable",
            observationCoverage: "out-of-scope",
          },
        ]);

        const firstUpdate = updateRouteAttemptObservation(attempt.attemptId, {
          runId: "run-1",
          callId: "call-1",
          observationCompleteness: "complete",
          observationCoverage: "hook-covered",
        });
        expect(firstUpdate).toBe(true);

        const [afterFirst] = listRouteAttempts(task.taskId, checkpointId);
        expect(afterFirst).toMatchObject({
          runId: "run-1",
          callId: "call-1",
          observationCompleteness: "complete",
          observationCoverage: "hook-covered",
        });

        const duplicateEndedUpdate = updateRouteAttemptObservation(attempt.attemptId, {
          runId: "run-1",
          callId: "call-1",
          observationCompleteness: "complete",
          observationCoverage: "hook-covered",
        });
        expect(duplicateEndedUpdate).toBe(true);

        const [afterDuplicate] = listRouteAttempts(task.taskId, checkpointId);
        expect(afterDuplicate).toEqual(afterFirst);

        closeOpenClawStateDatabase();
      },
    );
  });

  it("returns false when updating observation fields for a nonexistent route attempt", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-safety-store-observe-missing-" },
      async () => {
        resetTaskRegistryForTests();
        const updated = updateRouteAttemptObservation("nonexistent-attempt-id", {
          observationCompleteness: "unavailable",
          observationCoverage: "out-of-scope",
        });
        expect(updated).toBe(false);
        closeOpenClawStateDatabase();
      },
    );
  });

  it("does not create a safety row for a task created through the normal, non-managed path", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-safety-store-normal-task-" },
      async () => {
        resetTaskRegistryForTests();

        const task = createTaskRecord({
          runtime: "cli",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          task: "ordinary unrelated task",
          status: "succeeded",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
        });

        expect(task).not.toBeNull();
        expect(getTaskContract(task!.taskId)).toBeUndefined();
        closeOpenClawStateDatabase();
      },
    );
  });
});
