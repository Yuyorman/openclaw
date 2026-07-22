// Narrow plugin-facing surface for the Phase 1 safe-routing shadow service.
// Pure forwarding to the Task 5 Core service — no reimplementation, no direct
// database handle, no enforce API. See src/tasks/safety/service.ts.
//
// Deliberately an explicit list, not `export *`: every name below is a
// reviewed, intentional part of the plugin-facing surface (see this file's
// safe-routing.test.ts export-surface assertion). Adding a new export to
// service.ts must not silently widen what every installed plugin can reach —
// it has to be added here on purpose. Type exports are re-exported in full
// (types are erased at runtime and add no capability); only the value
// exports are the actual surface to keep narrow.
export {
  SAFE_ROUTING_SHADOW_TASK_KIND,
  createLiveSafeRoutingServiceDeps,
  createShadowObservationLease,
  evaluateShadowRouteInGateway,
  getShadowAudit,
  recordObservedModelAttemptInGateway,
  type CreateLiveSafeRoutingServiceDepsInput,
  type CreateShadowObservationLeaseInput,
  type CreateShadowObservationLeaseResult,
  type EvaluateShadowRouteInGatewayInput,
  type EvaluateShadowRouteInGatewayResult,
  type GetShadowAuditInput,
  type GetShadowAuditResult,
  type RecordObservedModelAttemptInGatewayInput,
  type SafeRoutingCallerScope,
  type SafeRoutingServiceDeps,
} from "../tasks/safety/service.js";
