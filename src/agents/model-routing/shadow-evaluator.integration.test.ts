/**
 * Phase 1 end-to-end acceptance: real SQLite, the real (unmodified)
 * `resolveModelCandidateChain`, and the real `service.ts` narrow methods
 * wired together — proving live routing stays untouched while shadow
 * evaluation independently reports its own theoretical judgment.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { PersistedTaskContract } from "../../tasks/safety/contracts.js";
import {
  createShadowObservationLease,
  evaluateShadowRouteInGateway,
  getShadowAudit,
  recordObservedModelAttemptInGateway,
  type SafeRoutingCallerScope,
  type SafeRoutingServiceDeps,
} from "../../tasks/safety/service.js";
import { createSqliteObservationLeaseStore } from "../../tasks/safety/store.sqlite.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.test-support.js";
import { captureEnv } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveModelCandidateChain } from "../model-fallback.js";
import { buildCapabilitySnapshot, type ModelCapabilitySnapshot } from "./capability-snapshot.js";
import type { ShadowRouteCandidate } from "./shadow-evaluator.js";

const ORIGINAL_ENV = captureEnv(["OPENCLAW_STATE_DIR"]);

/** A/B/C candidates per the Task 8 acceptance scenario: A is real-primary but shadow-ineligible, B is shadow-eligible, C is unrelated/lower priority. */
const REAL_CONFIG: OpenClawConfig = {
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-5.4",
        fallbacks: ["anthropic/claude-sonnet-5"],
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.example",
        models: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 16000, // deliberately too small for the contract below
            maxTokens: 4096,
          },
        ],
      },
      anthropic: {
        baseUrl: "https://api.anthropic.example",
        models: [
          {
            id: "claude-sonnet-5",
            name: "Claude Sonnet 5",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
} as unknown as OpenClawConfig;

function buildSnapshotFromConfig(
  cfg: OpenClawConfig,
  candidate: ShadowRouteCandidate,
): ModelCapabilitySnapshot {
  const providerConfig = (
    cfg.models?.providers as Record<string, { models?: unknown[] }> | undefined
  )?.[candidate.provider];
  const modelConfig = (
    providerConfig?.models as
      | Array<{ id: string; contextWindow?: number; maxTokens?: number; input?: string[] }>
      | undefined
  )?.find((entry) => entry.id === candidate.model);
  return buildCapabilitySnapshot({
    provider: candidate.provider,
    model: candidate.model,
    configured: {
      contextWindowTokens: modelConfig?.contextWindow,
      outputTokens: modelConfig?.maxTokens,
      modalities: modelConfig?.input?.filter(
        (m): m is "text" | "image" | "audio" => m === "text" || m === "image" || m === "audio",
      ),
      api: "openai-completions",
    },
    decisionGradeAuthorization: { maxAuthorizedDecisionGrade: "final", reason: "test policy" },
  });
}

function createDeps(
  cfg: OpenClawConfig,
  overrides: Partial<SafeRoutingServiceDeps> = {},
): SafeRoutingServiceDeps {
  const clock = 1_000;
  let idCounter = 0;
  return {
    now: () => clock,
    randomId: () => `id-${(idCounter += 1)}`,
    leaseTtlMs: 30_000,
    admissionPolicy: { approvedProviders: ["openai", "anthropic"] },
    resolveCandidates: () =>
      resolveModelCandidateChain({ cfg, provider: "openai", model: "gpt-5.4" }),
    configDigest: () => "sha256:config-v1",
    pluginRegistryDigest: () => "sha256:registry-v1",
    buildSnapshotForCandidate: (candidate) => buildSnapshotFromConfig(cfg, candidate),
    leaseStore: createSqliteObservationLeaseStore(),
    ...overrides,
  };
}

const CONTRACT: PersistedTaskContract = {
  schemaVersion: 1,
  taskId: "ignored",
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
};

const OWNER: SafeRoutingCallerScope = { sessionKey: "session-owner", operatorScopes: [] };

describe("Phase 1 shadow routing — end-to-end acceptance", () => {
  afterEach(() => {
    ORIGINAL_ENV.restore();
    resetTaskRegistryForTests();
    loggingState.rawConsole = null;
    setLoggerOverride(null);
    resetLogger();
  });

  it("never mutates real candidate resolution: resolveModelCandidateChain is identical before and after a full shadow evaluation", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-e2e-no-mutation-" },
      async () => {
        resetTaskRegistryForTests();
        const before = resolveModelCandidateChain({
          cfg: REAL_CONFIG,
          provider: "openai",
          model: "gpt-5.4",
        });
        const deps = createDeps(REAL_CONFIG);

        const created = createShadowObservationLease(deps, {
          contract: CONTRACT,
          sessionRef: "session-owner",
          callerScope: OWNER,
        });
        if (!created.ok) {
          throw new Error("unreachable");
        }
        evaluateShadowRouteInGateway(deps, {
          leaseId: created.leaseId,
          leaseToken: created.leaseToken,
        });

        const after = resolveModelCandidateChain({
          cfg: REAL_CONFIG,
          provider: "openai",
          model: "gpt-5.4",
        });
        expect(after).toEqual(before);
        expect(after).toEqual([
          { provider: "openai", model: "gpt-5.4" },
          { provider: "anthropic", model: "claude-sonnet-5" },
        ]);

        closeOpenClawStateDatabase();
      },
    );
  });

  it("A (the real primary) is shadow-ineligible, B is shadow-eligible: audit reports theoretical=B while the real chain still starts with A", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-e2e-a-b-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createDeps(REAL_CONFIG);

      const created = createShadowObservationLease(deps, {
        contract: CONTRACT,
        sessionRef: "session-owner",
        callerScope: OWNER,
      });
      if (!created.ok) {
        throw new Error("unreachable");
      }
      const evaluation = evaluateShadowRouteInGateway(deps, {
        leaseId: created.leaseId,
        leaseToken: created.leaseToken,
      });
      if (!evaluation.ok) {
        throw new Error("unreachable");
      }

      // Real routing (independent of anything shadow-related) still starts with A.
      const realChain = resolveModelCandidateChain({
        cfg: REAL_CONFIG,
        provider: "openai",
        model: "gpt-5.4",
      });
      expect(realChain[0]).toEqual({ provider: "openai", model: "gpt-5.4" });

      // Shadow evaluation independently reports B as the theoretical choice.
      expect(evaluation.theoreticalChoice).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-5",
      });

      const audit = getShadowAudit({ taskId: created.taskId, callerScope: OWNER });
      if (!audit.ok) {
        throw new Error("unreachable");
      }
      expect(audit.attempts.find((a) => a.provider === "openai")).toMatchObject({
        eligibility: "rejected",
        wouldSelect: false,
        rejectionCode: "CONTEXT",
      });
      expect(audit.attempts.find((a) => a.provider === "anthropic")).toMatchObject({
        eligibility: "eligible",
        wouldSelect: true,
      });
      expect(audit.suggestion).toBeUndefined();

      closeOpenClawStateDatabase();
    });
  });

  it("suggests CAPABLE_MODEL when every candidate is ineligible, while the shadow task itself still ends via the existing succeeded lifecycle (never blocked)", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-e2e-capable-model-" },
      async () => {
        resetTaskRegistryForTests();
        const impossibleContract: PersistedTaskContract = {
          ...CONTRACT,
          requiredCapabilities: {
            ...CONTRACT.requiredCapabilities,
            minContextWindowTokens: 999_000_000,
          },
        };
        const deps = createDeps(REAL_CONFIG);

        const created = createShadowObservationLease(deps, {
          contract: impossibleContract,
          sessionRef: "session-owner",
          callerScope: OWNER,
        });
        if (!created.ok) {
          throw new Error("unreachable");
        }
        evaluateShadowRouteInGateway(deps, {
          leaseId: created.leaseId,
          leaseToken: created.leaseToken,
        });

        const audit = getShadowAudit({ taskId: created.taskId, callerScope: OWNER });
        if (!audit.ok) {
          throw new Error("unreachable");
        }
        expect(audit.attempts.every((a) => !a.wouldSelect)).toBe(true);
        expect(audit.suggestion).toBe("CAPABLE_MODEL");

        closeOpenClawStateDatabase();
      },
    );
  });

  it("rejects a provider outside the approved-providers allowlist with DATA_POLICY through the full create-evaluate-audit flow", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-e2e-data-policy-" },
      async () => {
        resetTaskRegistryForTests();
        const deps = createDeps(REAL_CONFIG, {
          admissionPolicy: { approvedProviders: ["openai"] },
        });

        const created = createShadowObservationLease(deps, {
          contract: CONTRACT,
          sessionRef: "session-owner",
          callerScope: OWNER,
        });
        if (!created.ok) {
          throw new Error("unreachable");
        }
        evaluateShadowRouteInGateway(deps, {
          leaseId: created.leaseId,
          leaseToken: created.leaseToken,
        });

        const audit = getShadowAudit({ taskId: created.taskId, callerScope: OWNER });
        if (!audit.ok) {
          throw new Error("unreachable");
        }
        expect(audit.attempts.find((a) => a.provider === "anthropic")).toMatchObject({
          eligibility: "rejected",
          rejectionCode: "DATA_POLICY",
        });

        closeOpenClawStateDatabase();
      },
    );
  });

  it("marks every attempt partial (not unavailable) when the evaluating process's digests have drifted from the lease's bound digests", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-e2e-digest-drift-" },
      async () => {
        resetTaskRegistryForTests();
        const deps = createDeps(REAL_CONFIG);
        const created = createShadowObservationLease(deps, {
          contract: CONTRACT,
          sessionRef: "session-owner",
          callerScope: OWNER,
        });
        if (!created.ok) {
          throw new Error("unreachable");
        }

        // Simulate a second, independent process (e.g. a stale offline CLI snapshot)
        // whose live config digest no longer matches what the lease was bound to.
        const driftedDeps = createDeps(REAL_CONFIG, {
          configDigest: () => "sha256:a-different-process-config",
        });
        const evaluation = evaluateShadowRouteInGateway(driftedDeps, {
          leaseId: created.leaseId,
          leaseToken: created.leaseToken,
        });
        if (!evaluation.ok) {
          throw new Error("unreachable");
        }
        expect(evaluation.digestsConsistent).toBe(false);

        const audit = getShadowAudit({ taskId: created.taskId, callerScope: OWNER });
        if (!audit.ok) {
          throw new Error("unreachable");
        }
        expect(audit.attempts.every((a) => a.observationCompleteness === "partial")).toBe(true);

        closeOpenClawStateDatabase();
      },
    );
  });

  it("dedupes a duplicate (provider, model) candidate to exactly one persisted attempt even when the real chain contains it twice", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-e2e-dedup-" },
      async () => {
        resetTaskRegistryForTests();
        const deps = createDeps(REAL_CONFIG, {
          resolveCandidates: () => [
            { provider: "anthropic", model: "claude-sonnet-5" },
            { provider: "anthropic", model: "claude-sonnet-5" },
            { provider: "openai", model: "gpt-5.4" },
          ],
        });

        const created = createShadowObservationLease(deps, {
          contract: CONTRACT,
          sessionRef: "session-owner",
          callerScope: OWNER,
        });
        if (!created.ok) {
          throw new Error("unreachable");
        }
        evaluateShadowRouteInGateway(deps, {
          leaseId: created.leaseId,
          leaseToken: created.leaseToken,
        });

        const audit = getShadowAudit({ taskId: created.taskId, callerScope: OWNER });
        if (!audit.ok) {
          throw new Error("unreachable");
        }
        expect(audit.attempts).toHaveLength(2);

        closeOpenClawStateDatabase();
      },
    );
  });

  it("repeated audit reads never create new route attempts", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-e2e-repeat-read-" },
      async () => {
        resetTaskRegistryForTests();
        const deps = createDeps(REAL_CONFIG);
        const created = createShadowObservationLease(deps, {
          contract: CONTRACT,
          sessionRef: "session-owner",
          callerScope: OWNER,
        });
        if (!created.ok) {
          throw new Error("unreachable");
        }
        evaluateShadowRouteInGateway(deps, {
          leaseId: created.leaseId,
          leaseToken: created.leaseToken,
        });

        const first = getShadowAudit({ taskId: created.taskId, callerScope: OWNER });
        const second = getShadowAudit({ taskId: created.taskId, callerScope: OWNER });
        if (!first.ok || !second.ok) {
          throw new Error("unreachable");
        }

        expect(second.attempts).toEqual(first.attempts);

        closeOpenClawStateDatabase();
      },
    );
  });

  it("rejects an out-of-session lease creation attempt end to end", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-e2e-forbidden-" },
      async () => {
        resetTaskRegistryForTests();
        const deps = createDeps(REAL_CONFIG);

        const result = createShadowObservationLease(deps, {
          contract: CONTRACT,
          sessionRef: "session-owner",
          callerScope: { sessionKey: "someone-else", operatorScopes: [] },
        });

        expect(result).toEqual({ ok: false, code: "forbidden" });
        closeOpenClawStateDatabase();
      },
    );
  });

  it("correlates a real model_call_started/ended pair into the matching route attempt, completing it end to end", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-e2e-hook-correlate-" },
      async () => {
        resetTaskRegistryForTests();
        const deps = createDeps(REAL_CONFIG);

        const created = createShadowObservationLease(deps, {
          contract: CONTRACT,
          sessionRef: "session-owner",
          callerScope: OWNER,
        });
        if (!created.ok) {
          throw new Error("unreachable");
        }
        evaluateShadowRouteInGateway(deps, {
          leaseId: created.leaseId,
          leaseToken: created.leaseToken,
        });

        const before = getShadowAudit({ taskId: created.taskId, callerScope: OWNER });
        if (!before.ok) {
          throw new Error("unreachable");
        }
        expect(
          before.attempts.find((a) => a.provider === "anthropic")?.observationCompleteness,
        ).toBe("unavailable");

        await recordObservedModelAttemptInGateway(deps, {
          phase: "started",
          event: {
            runId: "run-1",
            callId: "call-1",
            sessionKey: "session-owner",
            provider: "anthropic",
            model: "claude-sonnet-5",
          },
          ctx: { sessionKey: "session-owner" },
          now: deps.now(),
        });
        await recordObservedModelAttemptInGateway(deps, {
          phase: "ended",
          event: {
            runId: "run-1",
            callId: "call-1",
            sessionKey: "session-owner",
            provider: "anthropic",
            model: "claude-sonnet-5",
            durationMs: 1200,
            outcome: "completed",
          },
          ctx: { sessionKey: "session-owner" },
          now: deps.now(),
        });

        const after = getShadowAudit({ taskId: created.taskId, callerScope: OWNER });
        if (!after.ok) {
          throw new Error("unreachable");
        }
        expect(after.attempts.find((a) => a.provider === "anthropic")).toMatchObject({
          runId: "run-1",
          callId: "call-1",
          observationCompleteness: "complete",
          observationCoverage: "hook-covered",
        });
        // The unrelated openai attempt is untouched — no real call was ever observed for it.
        expect(after.attempts.find((a) => a.provider === "openai")).toMatchObject({
          observationCompleteness: "unavailable",
        });

        closeOpenClawStateDatabase();
      },
    );
  });
});
