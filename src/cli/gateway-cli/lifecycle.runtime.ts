// Lazy lifecycle runtime export hub used by gateway run-loop restart paths.
export {
  abortEmbeddedAgentRun,
  getActiveEmbeddedRunCount,
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
  waitForActiveEmbeddedRuns,
} from "../../agents/embedded-agent-runner/runs.js";
export { reserveRestartAbortedMainSessions } from "../../agents/main-session-restart-reservation.js";
export { getRuntimeConfig } from "../../config/config.js";
export {
  respawnGatewayProcessForUpdate,
  restartGatewayProcessWithFreshPid,
} from "../../infra/process-respawn.js";
export {
  resolveGatewayRestartDeferralTimeoutMs,
  consumeGatewayRestartIntentPayloadSync,
  consumeGatewaySigusr1RestartIntent,
  consumeGatewayRestartIntentSync,
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  isGatewayRestartPreparationError,
  markGatewaySigusr1RestartHandled,
  peekGatewaySigusr1RestartReason,
  resetGatewayRestartStateForInProcessRestart,
  rollbackGatewayRestartSignalAdmission,
  scheduleGatewaySigusr1Restart,
} from "../../infra/restart.js";
export { writeGatewayRestartHandoffSync } from "../../infra/restart-handoff.js";
export { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
export { markUpdateRestartSentinelFailure } from "../../infra/restart-sentinel.js";
export { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
export { beginGatewayRestartSignalAdmission } from "../../process/gateway-work-admission.js";
export { writeDiagnosticStabilityBundleForFailureSync } from "../../logging/diagnostic-stability-bundle.js";
export {
  advanceCronActiveJobGeneration,
  resetCronActiveJobs,
  waitForActiveCronJobs,
} from "../../cron/active-jobs.js";
export {
  abortActiveCronTaskRuns,
  retireActiveCronTaskRunTracking,
  waitForActiveCronTaskRuns,
} from "../../tasks/cron-task-cancel.js";
export {
  getActiveTaskCount,
  resetAllLanes,
  waitForActiveTasks,
} from "../../process/command-queue.js";
export { getInspectableActiveTaskRestartBlockers } from "../../tasks/task-registry.maintenance.js";
export { reloadTaskRegistryFromStore } from "../../tasks/runtime-internal.js";
export { abortPendingChannelReloads } from "../../gateway/server-reload-handlers.js";
