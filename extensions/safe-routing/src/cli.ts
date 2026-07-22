// Explicit, default-off CLI for Phase 1 safe-routing shadow evaluation. Only
// dispatches to gateway methods executing in the live gateway process — never
// loads registry/auth/provider state in the CLI process itself.
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { addGatewayClientOptions, callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { SAFE_ROUTING_SHADOW_TASK_KIND } from "openclaw/plugin-sdk/safe-routing";

type JsonOptions = { json?: boolean };

type ShadowCommandOptions = JsonOptions & {
  contract: string;
  sessionRef: string;
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
};

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

async function callSafeRoutingGateway(
  method: string,
  options: JsonOptions & { url?: string; token?: string; timeout?: string; expectFinal?: boolean },
  params?: unknown,
): Promise<unknown> {
  return await callGatewayFromCli(method, options, params, {
    mode: "cli",
    scopes: ["operator.write", "operator.read"],
  });
}

function readContractFile(contractPath: string): Record<string, unknown> {
  const raw = readFileSync(contractPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Contract file ${contractPath} must contain a JSON object.`);
  }
  return parsed;
}

function summarizeAttempts(attempts: unknown): {
  attempts: unknown;
  theoreticalSelection?: unknown;
  currentSelection?: unknown;
} {
  if (!Array.isArray(attempts)) {
    return { attempts };
  }
  const theoreticalSelection = attempts.find(
    (attempt) => isRecord(attempt) && attempt.wouldSelect === true,
  );
  const currentSelection = attempts.find(
    (attempt) => isRecord(attempt) && typeof attempt.runId === "string",
  );
  return {
    attempts,
    ...(theoreticalSelection ? { theoreticalSelection } : {}),
    ...(currentSelection ? { currentSelection } : {}),
  };
}

export function registerSafeRoutingCli(params: { program: Command }): void {
  const safeRouting = params.program
    .command("safe-routing")
    .description("Phase 1 safe-routing shadow evaluation (read-only, default off)");

  addGatewayClientOptions(
    safeRouting
      .command("shadow")
      .description("Create a shadow observation lease, evaluate it, and print the audit")
      .requiredOption("--contract <path>", "Path to a JSON task contract file")
      .requiredOption("--session-ref <ref>", "Opaque session reference (never a raw session key)")
      .option("--json", "Print JSON", false),
  ).action(async (options: ShadowCommandOptions) => {
    const contract = readContractFile(options.contract);
    if (contract.deliveryMode !== "none") {
      throw new Error(
        `Contract file ${options.contract} must declare deliveryMode="none" for Phase 1 shadow evaluation ` +
          `(task kind is always fixed to "${SAFE_ROUTING_SHADOW_TASK_KIND}").`,
      );
    }

    const created = await callSafeRoutingGateway("safe-routing.createLease", options, {
      contract,
      sessionRef: options.sessionRef,
    });
    if (!isRecord(created) || created.ok !== true) {
      writeJson(created);
      return;
    }

    const evaluation = await callSafeRoutingGateway("safe-routing.evaluate", options, {
      leaseId: created.leaseId,
      leaseToken: created.leaseToken,
    });

    const audit = await callSafeRoutingGateway("safe-routing.audit", options, {
      taskId: created.taskId,
    });

    const auditRecord = isRecord(audit) && audit.ok === true ? audit : undefined;
    const result = {
      taskId: created.taskId,
      routingPolicyVersion: isRecord(evaluation) ? evaluation.routingPolicyVersion : undefined,
      digestsConsistent: isRecord(evaluation) ? evaluation.digestsConsistent : undefined,
      // Each attempt's rejectionCode/rejectionReason (e.g. CAPABILITY_UNVERIFIED) carries the
      // per-candidate verification signal; see docs/superpowers/... for the full evidence trail.
      ...summarizeAttempts(auditRecord?.attempts),
    };

    if (options.json) {
      writeJson(result);
      return;
    }
    writeLine(`taskId: ${result.taskId}`);
    writeLine(`routingPolicyVersion: ${String(result.routingPolicyVersion ?? "unknown")}`);
    writeLine(`digestsConsistent: ${String(result.digestsConsistent ?? "unknown")}`);
    writeLine(
      `theoreticalSelection: ${result.theoreticalSelection ? JSON.stringify(result.theoreticalSelection) : "none eligible"}`,
    );
    writeLine(
      `currentSelection: ${result.currentSelection ? JSON.stringify(result.currentSelection) : "not yet observed"}`,
    );
  });
}
