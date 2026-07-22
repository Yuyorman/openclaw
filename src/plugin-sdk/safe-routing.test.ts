import { afterEach, describe, expect, it } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { buildCapabilitySnapshot } from "../agents/model-routing/capability-snapshot.js";
import { correlateModelCallEvent } from "../agents/model-routing/observed-attempt.js";
import type { PersistedTaskContract } from "../tasks/safety/contracts.js";
import { createSqliteObservationLeaseStore } from "../tasks/safety/store.sqlite.js";
import { captureEnv } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as safeRoutingSdk from "./safe-routing.js";
import {
  createShadowObservationLease,
  evaluateShadowRouteInGateway,
  getShadowAudit,
  type SafeRoutingCallerScope,
  type SafeRoutingServiceDeps,
} from "./safe-routing.js";

const ORIGINAL_ENV = captureEnv(["OPENCLAW_STATE_DIR"]);

function buildContract(overrides: Partial<PersistedTaskContract> = {}): PersistedTaskContract {
  return {
    schemaVersion: 1,
    taskId: "unused-caller-supplied-id",
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
    deliveryMode: "formal",
    routingPolicyVersion: "v1",
    ...overrides,
  };
}

function createTestDeps(): SafeRoutingServiceDeps {
  let clock = 1_000;
  let idCounter = 0;
  return {
    now: () => clock,
    randomId: () => `id-${(idCounter += 1)}`,
    leaseTtlMs: 30_000,
    admissionPolicy: { approvedProviders: ["openai", "anthropic"] },
    resolveCandidates: () => [{ provider: "anthropic", model: "claude-sonnet-5" }],
    configDigest: () => "sha256:config-v1",
    pluginRegistryDigest: () => "sha256:registry-v1",
    buildSnapshotForCandidate: (candidate) =>
      buildCapabilitySnapshot({
        provider: candidate.provider,
        model: candidate.model,
        configured: { contextWindowTokens: 200000, outputTokens: 8192, modalities: ["text"], api: `${candidate.provider}-api` },
        decisionGradeAuthorization: { maxAuthorizedDecisionGrade: "final", reason: "test policy" },
      }),
    leaseStore: createSqliteObservationLeaseStore(),
  };
}

const OWNER: SafeRoutingCallerScope = { sessionKey: "session-owner", operatorScopes: [] };
const OTHER_SESSION: SafeRoutingCallerScope = { sessionKey: "session-other", operatorScopes: [] };

describe("plugin-sdk safe-routing facade", () => {
  afterEach(() => {
    ORIGINAL_ENV.restore();
    resetTaskRegistryForTests();
    loggingState.rawConsole = null;
    setLoggerOverride(null);
    resetLogger();
  });

  it("exposes exactly the narrow safe-routing surface — no database handle, arbitrary SQL, or enforce API", () => {
    const valueExports = Object.keys(safeRoutingSdk).toSorted();

    expect(valueExports).toEqual([
      "SAFE_ROUTING_SHADOW_TASK_KIND",
      "createLiveSafeRoutingServiceDeps",
      "createShadowObservationLease",
      "evaluateShadowRouteInGateway",
      "getShadowAudit",
    ]);
  });

  it("forces deliveryMode=none through the SDK re-export regardless of the caller's contract", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-sdk-safe-routing-create-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();

      const result = createShadowObservationLease(deps, {
        contract: buildContract({ deliveryMode: "formal" }),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const lease = deps.leaseStore.findById(result.leaseId);
      const audit = getShadowAudit({ taskId: lease!.taskId, callerScope: OWNER });
      if (!audit.ok) throw new Error("unreachable");
      expect(audit.contract.deliveryMode).toBe("none");
      closeOpenClawStateDatabase();
    });
  });

  it("forbids creating a lease for another session without operator.write, through the SDK re-export", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-sdk-safe-routing-forbid-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();

      const result = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OTHER_SESSION,
      });

      expect(result).toEqual({ ok: false, code: "forbidden" });
      closeOpenClawStateDatabase();
    });
  });

  it("rejects evaluation with a wrong leaseToken and does not consume the lease", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-sdk-safe-routing-bad-token-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();
      const created = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });
      if (!created.ok) throw new Error("unreachable");

      const result = evaluateShadowRouteInGateway(deps, { leaseId: created.leaseId, leaseToken: "wrong" });

      expect(result).toEqual({ ok: false, code: "invalid_token" });
      expect(deps.leaseStore.findById(created.leaseId)?.tokenConsumedAt).toBeUndefined();
      closeOpenClawStateDatabase();
    });
  });

  it("rejects a replayed leaseToken with a stable error code, and token consumption never blocks the lease's own CAS bind by a real model call", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-sdk-safe-routing-replay-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();
      const created = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });
      if (!created.ok) throw new Error("unreachable");

      evaluateShadowRouteInGateway(deps, { leaseId: created.leaseId, leaseToken: created.leaseToken });
      const replay = evaluateShadowRouteInGateway(deps, { leaseId: created.leaseId, leaseToken: created.leaseToken });
      expect(replay).toEqual({ ok: false, code: "already_consumed" });

      // The token is spent, but the lease's independent bind lifecycle must still accept a real hook event.
      const lease = deps.leaseStore.findById(created.leaseId)!;
      const bindResult = correlateModelCallEvent(deps.leaseStore, {
        phase: "started",
        event: {
          runId: "run-1",
          callId: "call-1",
          sessionKey: "session-owner",
          provider: "anthropic",
          model: "claude-sonnet-5",
        },
        ctx: { sessionKey: "session-owner" },
        sessionBindingDigest: lease.sessionBindingDigest,
        configDigest: lease.configDigest,
        pluginRegistryDigest: lease.pluginRegistryDigest,
        candidateChainDigest: lease.candidateChainDigest,
        now: deps.now(),
      });
      expect(bindResult).toBeUndefined(); // silent successful bind, not blocked by prior token consumption
      expect(deps.leaseStore.findById(created.leaseId)).toMatchObject({ state: "bound", boundRunId: "run-1" });
      closeOpenClawStateDatabase();
    });
  });

  it("returns the same not_found code for a different session and for a nonexistent task (no enumeration signal)", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-sdk-safe-routing-audit-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();
      const created = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });
      if (!created.ok) throw new Error("unreachable");
      const lease = deps.leaseStore.findById(created.leaseId);

      const forbidden = getShadowAudit({ taskId: lease!.taskId, callerScope: OTHER_SESSION });
      const missing = getShadowAudit({ taskId: "no-such-task", callerScope: OTHER_SESSION });

      expect(forbidden).toEqual({ ok: false, code: "not_found" });
      expect(missing).toEqual({ ok: false, code: "not_found" });
      closeOpenClawStateDatabase();
    });
  });

  it("never returns a leaseToken, session key, or contract free-text in the audit result", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-sdk-safe-routing-no-leak-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();
      const created = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });
      if (!created.ok) throw new Error("unreachable");
      const lease = deps.leaseStore.findById(created.leaseId);

      const audit = getShadowAudit({ taskId: lease!.taskId, callerScope: OWNER });

      expect(audit.ok).toBe(true);
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain(created.leaseToken);
      expect(serialized).not.toContain("session-owner");
      closeOpenClawStateDatabase();
    });
  });
});
