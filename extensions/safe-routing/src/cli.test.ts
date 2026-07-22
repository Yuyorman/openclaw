import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSafeRoutingCli } from "./cli.js";

const gatewayRuntime = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/gateway-runtime")>(
    "openclaw/plugin-sdk/gateway-runtime",
  );
  return { ...actual, callGatewayFromCli: gatewayRuntime.callGatewayFromCli };
});

function createProgram(): Command {
  const program = new Command();
  registerSafeRoutingCli({ program });
  return program;
}

function captureStdout() {
  let output = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return { output: () => output, restore: () => spy.mockRestore() };
}

describe("registerSafeRoutingCli — safe-routing shadow", () => {
  let tmpDir: string;

  beforeEach(() => {
    gatewayRuntime.callGatewayFromCli.mockReset();
    tmpDir = mkdtempSync(path.join(tmpdir(), "safe-routing-cli-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeContract(overrides: Record<string, unknown> = {}): string {
    const contractPath = path.join(tmpDir, "contract.json");
    writeFileSync(
      contractPath,
      JSON.stringify({
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
        ...overrides,
      }),
    );
    return contractPath;
  }

  it("rejects a contract file that does not declare deliveryMode=none before calling the gateway", async () => {
    const contractPath = writeContract({ deliveryMode: "formal" });
    const program = createProgram();

    await expect(
      program.parseAsync(
        ["safe-routing", "shadow", "--contract", contractPath, "--session-ref", "session-1", "--json"],
        { from: "user" },
      ),
    ).rejects.toThrow(/deliveryMode/);
    expect(gatewayRuntime.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("dispatches createLease, evaluate, and audit in order and prints the audit as JSON", async () => {
    const contractPath = writeContract();
    gatewayRuntime.callGatewayFromCli
      .mockResolvedValueOnce({ ok: true, taskId: "task-1", leaseId: "lease-1", leaseToken: "secret-token" })
      .mockResolvedValueOnce({ ok: true, routingPolicyVersion: "v1", digestsConsistent: true })
      .mockResolvedValueOnce({
        ok: true,
        attempts: [
          { provider: "openai", model: "gpt-5.4", wouldSelect: false, eligibility: "rejected" },
          { provider: "anthropic", model: "claude-sonnet-5", wouldSelect: true, eligibility: "eligible", runId: "run-1" },
        ],
      });
    const program = createProgram();
    const stdout = captureStdout();

    await program.parseAsync(
      ["safe-routing", "shadow", "--contract", contractPath, "--session-ref", "session-1", "--json"],
      { from: "user" },
    );
    stdout.restore();

    expect(gatewayRuntime.callGatewayFromCli.mock.calls[0][0]).toBe("safe-routing.createLease");
    expect(gatewayRuntime.callGatewayFromCli.mock.calls[0][2]).toMatchObject({ sessionRef: "session-1" });
    expect(gatewayRuntime.callGatewayFromCli.mock.calls[1][0]).toBe("safe-routing.evaluate");
    expect(gatewayRuntime.callGatewayFromCli.mock.calls[1][2]).toEqual({
      leaseId: "lease-1",
      leaseToken: "secret-token",
    });
    expect(gatewayRuntime.callGatewayFromCli.mock.calls[2][0]).toBe("safe-routing.audit");
    expect(gatewayRuntime.callGatewayFromCli.mock.calls[2][2]).toEqual({ taskId: "task-1" });

    const printed = JSON.parse(stdout.output());
    expect(printed.taskId).toBe("task-1");
    expect(printed.routingPolicyVersion).toBe("v1");
    expect(printed.theoreticalSelection).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(printed.currentSelection).toMatchObject({ provider: "anthropic", runId: "run-1" });
  });

  it("never prints the leaseToken in its output", async () => {
    const contractPath = writeContract();
    gatewayRuntime.callGatewayFromCli
      .mockResolvedValueOnce({ ok: true, taskId: "task-1", leaseId: "lease-1", leaseToken: "super-secret-token" })
      .mockResolvedValueOnce({ ok: true, routingPolicyVersion: "v1", digestsConsistent: true })
      .mockResolvedValueOnce({ ok: true, attempts: [] });
    const program = createProgram();
    const stdout = captureStdout();

    await program.parseAsync(
      ["safe-routing", "shadow", "--contract", contractPath, "--session-ref", "session-1", "--json"],
      { from: "user" },
    );
    stdout.restore();

    expect(stdout.output()).not.toContain("super-secret-token");
  });

  it("stops and prints the error envelope without calling evaluate/audit when createLease is rejected", async () => {
    const contractPath = writeContract();
    gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({ ok: false, code: "forbidden" });
    const program = createProgram();
    const stdout = captureStdout();

    await program.parseAsync(
      ["safe-routing", "shadow", "--contract", contractPath, "--session-ref", "session-1", "--json"],
      { from: "user" },
    );
    stdout.restore();

    expect(gatewayRuntime.callGatewayFromCli).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.output())).toEqual({ ok: false, code: "forbidden" });
  });

  it("prints readable text output when --json is omitted", async () => {
    const contractPath = writeContract();
    gatewayRuntime.callGatewayFromCli
      .mockResolvedValueOnce({ ok: true, taskId: "task-1", leaseId: "lease-1", leaseToken: "secret-token" })
      .mockResolvedValueOnce({ ok: true, routingPolicyVersion: "v1", digestsConsistent: true })
      .mockResolvedValueOnce({ ok: true, attempts: [] });
    const program = createProgram();
    const stdout = captureStdout();

    await program.parseAsync(
      ["safe-routing", "shadow", "--contract", contractPath, "--session-ref", "session-1"],
      { from: "user" },
    );
    stdout.restore();

    expect(stdout.output()).toContain("taskId: task-1");
    expect(stdout.output()).toContain("theoreticalSelection: none eligible");
    expect(stdout.output()).toContain("currentSelection: not yet observed");
  });
});
