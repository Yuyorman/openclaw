// Phase 1 safe-routing extension entrypoint: registers three read-only
// gateway methods and an explicit CLI. No tools, no chat listeners, no global
// fallback changes — mode=off (the default) writes nothing at all.
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createLiveSafeRoutingServiceDeps,
  createShadowObservationLease,
  evaluateShadowRouteInGateway,
  getShadowAudit,
  recordObservedModelAttemptInGateway,
  type SafeRoutingCallerScope,
} from "openclaw/plugin-sdk/safe-routing";
import { asRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import { registerSafeRoutingCli } from "./src/cli.js";
import {
  validateSafeRoutingConfig,
  type SafeRoutingConfigValidationErrorCode,
  type SafeRoutingExtensionConfig,
} from "./src/config.js";

type GatewayMethodHandlerParams = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];

function deriveCallerScope(client: GatewayMethodHandlerParams["client"]): SafeRoutingCallerScope {
  const sessionKey = client?.internal?.agentRuntimeIdentity?.sessionKey?.trim();
  if (sessionKey) {
    return { sessionKey, operatorScopes: [] };
  }
  // No embedded-agent session identity on this connection (e.g. the explicit
  // CLI, which connects as a plain operator, never as an agent runtime). All
  // three gateway methods below register without an explicit `{scope}`
  // option, so Core's own dispatch (src/gateway/methods/registry.ts) defaults
  // their required scope to "operator.admin" — reaching this handler at all
  // already proves the caller cleared that gate. Treat it as a verified admin
  // operator instead of rejecting; this is what makes the CLI's
  // `safe-routing shadow` command work end to end (see README.md).
  return { sessionKey: "", operatorScopes: ["operator.admin"] };
}

// Tracks the last-logged validation failure so a persistently broken config
// (checked on every gateway call and every model_call_started/ended hook)
// warns once per distinct problem instead of spamming on every model call.
let lastLoggedConfigValidationErrorCode: SafeRoutingConfigValidationErrorCode | undefined;

function readExtensionConfig(api: OpenClawPluginApi): SafeRoutingExtensionConfig {
  const result = validateSafeRoutingConfig(api.pluginConfig);
  if (!result.ok) {
    if (result.code !== lastLoggedConfigValidationErrorCode) {
      lastLoggedConfigValidationErrorCode = result.code;
      api.logger.warn(
        `safe-routing: config is invalid (${result.code}); running as mode=off until fixed. ` +
          "See extensions/safe-routing/README.md for the required shape.",
      );
    }
    return { mode: "off", allowedTaskKinds: [], approvedProviders: [] };
  }
  lastLoggedConfigValidationErrorCode = undefined;
  return result.config;
}

export default definePluginEntry({
  id: "safe-routing",
  name: "Safe Routing (Phase 1 shadow)",
  description: "Read-only shadow evaluation of theoretical model routing admission.",
  register(api) {
    const respondDisabled = (respond: GatewayMethodHandlerParams["respond"]) =>
      respond(false, undefined, {
        code: "disabled",
        message: "safe-routing extension is mode=off; no facts are created or read.",
      });

    api.registerGatewayMethod("safe-routing.createLease", async ({ params, client, respond }) => {
      const config = readExtensionConfig(api);
      if (config.mode !== "shadow") {
        respondDisabled(respond);
        return;
      }
      const callerScope = deriveCallerScope(client);
      const record = asRecord(params);
      const deps = createLiveSafeRoutingServiceDeps({
        admissionPolicy: { approvedProviders: config.approvedProviders },
      });
      const result = createShadowObservationLease(deps, {
        contract: record.contract as never,
        sessionRef: readStringField(record, "sessionRef") ?? "",
        callerScope,
      });
      respond(
        result.ok,
        result.ok ? result : undefined,
        result.ok ? undefined : { code: result.code, message: result.code },
      );
    });

    api.registerGatewayMethod("safe-routing.evaluate", async ({ params, respond }) => {
      const config = readExtensionConfig(api);
      if (config.mode !== "shadow") {
        respondDisabled(respond);
        return;
      }
      const record = asRecord(params);
      const deps = createLiveSafeRoutingServiceDeps({
        admissionPolicy: { approvedProviders: config.approvedProviders },
      });
      const result = evaluateShadowRouteInGateway(deps, {
        leaseId: readStringField(record, "leaseId") ?? "",
        leaseToken: readStringField(record, "leaseToken") ?? "",
      });
      respond(
        result.ok,
        result.ok ? result : undefined,
        result.ok ? undefined : { code: result.code, message: result.code },
      );
    });

    api.registerGatewayMethod("safe-routing.audit", async ({ params, client, respond }) => {
      const config = readExtensionConfig(api);
      if (config.mode !== "shadow") {
        respondDisabled(respond);
        return;
      }
      const callerScope = deriveCallerScope(client);
      const record = asRecord(params);
      const result = getShadowAudit({
        taskId: readStringField(record, "taskId") ?? "",
        callerScope,
      });
      respond(
        result.ok,
        result.ok ? result : undefined,
        result.ok ? undefined : { code: result.code, message: result.code },
      );
    });

    // Real-call observation: silently no-ops for any session without an active
    // lease (see observed-attempt.ts), and mode=off skips before touching the
    // store at all. recordObservedModelAttemptInGateway itself does a cheap
    // lease-existence lookup before computing any live config/registry/
    // candidate-chain digest, so ordinary chat sessions only ever pay for that
    // one indexed lookup, never the full digest computation.
    api.on("model_call_started", async (event, ctx) => {
      const config = readExtensionConfig(api);
      if (config.mode !== "shadow") {
        return;
      }
      const deps = createLiveSafeRoutingServiceDeps({
        admissionPolicy: { approvedProviders: config.approvedProviders },
      });
      await recordObservedModelAttemptInGateway(deps, {
        phase: "started",
        event,
        ctx,
        now: Date.now(),
      });
    });

    api.on("model_call_ended", async (event, ctx) => {
      const config = readExtensionConfig(api);
      if (config.mode !== "shadow") {
        return;
      }
      const deps = createLiveSafeRoutingServiceDeps({
        admissionPolicy: { approvedProviders: config.approvedProviders },
      });
      await recordObservedModelAttemptInGateway(deps, {
        phase: "ended",
        event,
        ctx,
        now: Date.now(),
      });
    });

    api.registerCli(
      async ({ program }) => {
        registerSafeRoutingCli({ program });
      },
      {
        descriptors: [
          {
            name: "safe-routing",
            description: "Phase 1 safe-routing shadow evaluation (read-only, default off)",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
