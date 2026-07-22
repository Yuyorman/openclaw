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
import { registerSafeRoutingCli } from "./src/cli.js";
import { validateSafeRoutingConfig, type SafeRoutingExtensionConfig } from "./src/config.js";

type GatewayMethodHandlerParams = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];

function deriveCallerScope(
  client: GatewayMethodHandlerParams["client"],
): SafeRoutingCallerScope | undefined {
  const sessionKey = client?.internal?.agentRuntimeIdentity?.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  // Phase 1 wiring: no verified way to read operator scopes off a bare plugin
  // gateway method `client` was found; this always ships an empty scope list,
  // so only session ownership (never the `operator.write`/`operator.read`
  // fallback) can succeed through this extension today. Strictly more
  // conservative than under-authorizing would be — never over-grants.
  return { sessionKey, operatorScopes: [] };
}

function readExtensionConfig(api: OpenClawPluginApi): SafeRoutingExtensionConfig {
  const result = validateSafeRoutingConfig(api.pluginConfig);
  if (!result.ok) {
    return { mode: "off", allowedTaskKinds: [], approvedProviders: [] };
  }
  return result.config;
}

export default definePluginEntry({
  id: "safe-routing",
  name: "Safe Routing (Phase 1 shadow)",
  description: "Read-only shadow evaluation of theoretical model routing admission.",
  register(api) {
    const respondNotFound = (respond: GatewayMethodHandlerParams["respond"]) =>
      respond(false, undefined, { code: "not_found", message: "Not found." });
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
      if (!callerScope) {
        respondNotFound(respond);
        return;
      }
      const typed = params as { contract?: unknown; sessionRef?: unknown };
      const deps = createLiveSafeRoutingServiceDeps({
        admissionPolicy: { approvedProviders: config.approvedProviders },
      });
      const result = createShadowObservationLease(deps, {
        contract: typed.contract as never,
        sessionRef: String(typed.sessionRef ?? ""),
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
      const typed = params as { leaseId?: unknown; leaseToken?: unknown };
      const deps = createLiveSafeRoutingServiceDeps({
        admissionPolicy: { approvedProviders: config.approvedProviders },
      });
      const result = evaluateShadowRouteInGateway(deps, {
        leaseId: String(typed.leaseId ?? ""),
        leaseToken: String(typed.leaseToken ?? ""),
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
      if (!callerScope) {
        respondNotFound(respond);
        return;
      }
      const typed = params as { taskId?: unknown };
      const result = getShadowAudit({ taskId: String(typed.taskId ?? ""), callerScope });
      respond(
        result.ok,
        result.ok ? result : undefined,
        result.ok ? undefined : { code: result.code, message: result.code },
      );
    });

    // Real-call observation: silently no-ops for any session without an active
    // lease (see observed-attempt.ts), and mode=off skips before touching the
    // store at all — ordinary chat sessions only ever pay for this empty check.
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
