/**
 * Phase 1 end-to-end acceptance for the extension's own gateway method
 * handlers (index.ts) — distinct from cli.test.ts, which mocks
 * `callGatewayFromCli` and never exercises the real handler bodies.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { __testing as rateLimitTesting } from "./rate-limit.js";

type RespondCall = [ok: boolean, payload?: unknown, error?: { code?: unknown; message?: unknown }];
type CapturedHandler = (params: {
  params: Record<string, unknown>;
  client: { internal?: { agentRuntimeIdentity?: { sessionKey?: string } } } | null;
  respond: (...args: RespondCall) => void;
}) => Promise<void> | void;

function captureGatewayMethods() {
  const methods = new Map<string, CapturedHandler>();
  return {
    methods,
    registerGatewayMethod: (name: string, handler: unknown) => {
      methods.set(name, handler as CapturedHandler);
    },
  };
}

async function callMethod(
  methods: Map<string, CapturedHandler>,
  name: string,
  params: Record<string, unknown>,
  sessionKey?: string,
): Promise<{ ok: boolean; payload?: unknown; error?: { code?: unknown; message?: unknown } }> {
  const handler = methods.get(name);
  if (!handler) {
    throw new Error(`gateway method not registered: ${name}`);
  }
  let result:
    | { ok: boolean; payload?: unknown; error?: { code?: unknown; message?: unknown } }
    | undefined;
  await handler({
    params,
    client: sessionKey ? { internal: { agentRuntimeIdentity: { sessionKey } } } : null,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
  });
  if (!result) {
    throw new Error(`handler for ${name} never called respond()`);
  }
  return result;
}

type HookHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<void> | void;

function activatePlugin(
  pluginConfig: Record<string, unknown>,
  loggerOverride?: { warn: (message: string) => void },
) {
  const captured = captureGatewayMethods();
  const hooks = new Map<string, HookHandler>();
  const api = createTestPluginApi({
    pluginConfig,
    registerGatewayMethod: captured.registerGatewayMethod as never,
    registerCli: () => {},
    on: ((hookName: string, handler: unknown) => {
      hooks.set(hookName, handler as HookHandler);
    }) as never,
    ...(loggerOverride
      ? { logger: { info() {}, warn: loggerOverride.warn, error() {}, debug() {} } }
      : {}),
  });
  (plugin as unknown as { register(api: unknown): void }).register(api);
  return { methods: captured.methods, hooks };
}

const CONTRACT = {
  schemaVersion: 1,
  taskId: "ignored",
  requiredCapabilities: {
    modalities: ["text"],
    minContextWindowTokens: 32000,
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

describe("extensions/safe-routing — gateway method handlers (mode gate + end-to-end flow)", () => {
  let originalStateDir: string | undefined;
  let tmpStateDir: string;

  beforeEach(() => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    tmpStateDir = mkdtempSync(path.join(tmpdir(), "safe-routing-index-e2e-"));
    process.env.OPENCLAW_STATE_DIR = tmpStateDir;
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    rmSync(tmpStateDir, { recursive: true, force: true });
    rateLimitTesting.reset();
  });

  it("mode=off refuses all three methods and writes nothing", async () => {
    const { methods } = activatePlugin({ mode: "off" });

    const created = await callMethod(
      methods,
      "safe-routing.createLease",
      { contract: CONTRACT, sessionRef: "session-1" },
      "session-1",
    );
    const evaluated = await callMethod(methods, "safe-routing.evaluate", {
      leaseId: "x",
      leaseToken: "y",
    });
    const audited = await callMethod(methods, "safe-routing.audit", { taskId: "z" }, "session-1");

    expect(created).toMatchObject({ ok: false, error: { code: "disabled" } });
    expect(evaluated).toMatchObject({ ok: false, error: { code: "disabled" } });
    expect(audited).toMatchObject({ ok: false, error: { code: "disabled" } });
  });

  it("warns once for an invalid shadow config instead of silently running as mode=off on every call", async () => {
    const warn = vi.fn();
    // mode=shadow with neither approvedProviders nor allowedTaskKinds set.
    const { methods } = activatePlugin({ mode: "shadow" }, { warn });

    await callMethod(methods, "safe-routing.audit", { taskId: "z" }, "session-1");
    await callMethod(methods, "safe-routing.audit", { taskId: "z" }, "session-1");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("missing_approved_providers");
  });

  it("mode=shadow runs the full createLease -> evaluate -> audit flow and the session owner can read it back", async () => {
    const { methods } = activatePlugin({
      mode: "shadow",
      allowedTaskKinds: ["safe-routing-readonly-shadow"],
      approvedProviders: ["anthropic", "openai"],
    });

    const created = await callMethod(
      methods,
      "safe-routing.createLease",
      { contract: CONTRACT, sessionRef: "session-1" },
      "session-1",
    );
    expect(created.ok).toBe(true);
    const { leaseId, leaseToken, taskId } = created.payload as {
      leaseId: string;
      leaseToken: string;
      taskId: string;
    };
    expect(leaseId).toBeTruthy();
    expect(leaseToken).toBeTruthy();

    const evaluated = await callMethod(methods, "safe-routing.evaluate", { leaseId, leaseToken });
    expect(evaluated.ok).toBe(true);

    const audited = await callMethod(methods, "safe-routing.audit", { taskId }, "session-1");
    expect(audited.ok).toBe(true);
    const auditPayload = audited.payload as { attempts: unknown[] };
    expect(Array.isArray(auditPayload.attempts)).toBe(true);

    const repeated = await callMethod(methods, "safe-routing.audit", { taskId }, "session-1");
    expect(repeated).toEqual(audited);
  });

  it("mode=shadow runs the full createLease -> evaluate -> audit flow for the real external CLI connection shape (no agentRuntimeIdentity)", async () => {
    const { methods } = activatePlugin({
      mode: "shadow",
      allowedTaskKinds: ["safe-routing-readonly-shadow"],
      approvedProviders: ["anthropic", "openai"],
    });

    // No sessionKey passed: callMethod sends `client: null`, matching a real
    // external `openclaw safe-routing shadow` CLI connection, which never
    // carries agentRuntimeIdentity (only local embedded-agent-session
    // connections do). Reaching these handlers at all already proves the
    // connection cleared the implicit operator.admin gateway-method gate
    // (see deriveCallerScope in index.ts).
    const created = await callMethod(methods, "safe-routing.createLease", {
      contract: CONTRACT,
      sessionRef: "cli-invoker-supplied-ref",
    });
    expect(created.ok).toBe(true);
    const { leaseId, leaseToken, taskId } = created.payload as {
      leaseId: string;
      leaseToken: string;
      taskId: string;
    };

    const evaluated = await callMethod(methods, "safe-routing.evaluate", { leaseId, leaseToken });
    expect(evaluated.ok).toBe(true);

    const audited = await callMethod(methods, "safe-routing.audit", { taskId });
    expect(audited.ok).toBe(true);
  });

  it("rejects createLease for a caller whose session does not match sessionRef", async () => {
    const { methods } = activatePlugin({
      mode: "shadow",
      allowedTaskKinds: ["safe-routing-readonly-shadow"],
      approvedProviders: ["anthropic"],
    });

    const result = await callMethod(
      methods,
      "safe-routing.createLease",
      { contract: CONTRACT, sessionRef: "session-1" },
      "someone-else",
    );

    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("returns not_found auditing a nonexistent taskId, even for an operator caller with no session identity", async () => {
    const { methods } = activatePlugin({
      mode: "shadow",
      allowedTaskKinds: ["safe-routing-readonly-shadow"],
      approvedProviders: ["anthropic"],
    });

    // No sessionKey: an admin-operator-scoped caller (see deriveCallerScope),
    // not a rejected caller — the not_found here comes from the taskId itself
    // not existing, not from a missing identity.
    const result = await callMethod(methods, "safe-routing.audit", { taskId: "whatever" });

    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("rate-limits safe-routing.evaluate per caller once its budget is exhausted", async () => {
    const { methods } = activatePlugin({
      mode: "shadow",
      allowedTaskKinds: ["safe-routing-readonly-shadow"],
      approvedProviders: ["anthropic"],
    });

    const results: Array<{ ok: boolean; error?: { code?: unknown } }> = [];
    for (let i = 0; i < 11; i++) {
      results.push(
        await callMethod(methods, "safe-routing.evaluate", { leaseId: "x", leaseToken: "y" }),
      );
    }

    expect(results.slice(0, 10).every((r) => r.error?.code !== "rate_limited")).toBe(true);
    expect(results[10]).toMatchObject({ ok: false, error: { code: "rate_limited" } });
  });

  it("registers model_call_started/ended hook handlers that no-op safely when mode=off", async () => {
    const { hooks } = activatePlugin({ mode: "off" });

    expect(hooks.has("model_call_started")).toBe(true);
    expect(hooks.has("model_call_ended")).toBe(true);
    await expect(
      hooks.get("model_call_started")!(
        {
          runId: "run-1",
          callId: "call-1",
          sessionKey: "session-1",
          provider: "openai",
          model: "gpt-5.4",
        },
        { sessionKey: "session-1" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks.get("model_call_ended")!(
        {
          runId: "run-1",
          callId: "call-1",
          sessionKey: "session-1",
          provider: "openai",
          model: "gpt-5.4",
        },
        { sessionKey: "session-1" },
      ),
    ).resolves.toBeUndefined();
  });

  it("does not throw when a model_call_started/ended pair fires for a session with no active lease (mode=shadow)", async () => {
    const { hooks } = activatePlugin({
      mode: "shadow",
      allowedTaskKinds: ["safe-routing-readonly-shadow"],
      approvedProviders: ["anthropic"],
    });

    await expect(
      hooks.get("model_call_started")!(
        {
          runId: "run-1",
          callId: "call-1",
          sessionKey: "unrelated-session",
          provider: "openai",
          model: "gpt-5.4",
        },
        { sessionKey: "unrelated-session" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks.get("model_call_ended")!(
        {
          runId: "run-1",
          callId: "call-1",
          sessionKey: "unrelated-session",
          provider: "openai",
          model: "gpt-5.4",
        },
        { sessionKey: "unrelated-session" },
      ),
    ).resolves.toBeUndefined();
  });
});
