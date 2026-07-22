// Narrow plugin-facing surface for the Phase 1 safe-routing shadow service.
// Pure forwarding to the Task 5 Core service — no reimplementation, no direct
// database handle, no enforce API. See src/tasks/safety/service.ts.
export * from "../tasks/safety/service.js";
