# safe-routing (Phase 1 shadow)

Read-only shadow evaluation of theoretical model routing admission. Reports
what *would* be selected under a task contract, without ever changing which
model a real session actually calls.

## Status

Phase 1. Default off. No `enforce` mode exists yet — this extension can only
observe and report, never block or redirect a real request.

## Enabling

1. Back up `state/openclaw.sqlite` (and its `-wal`/`-shm` files if present)
   before first enabling in any environment that matters.
2. Set config:

   ```json
   {
     "plugins": {
       "safe-routing": {
         "mode": "shadow",
         "allowedTaskKinds": ["safe-routing-readonly-shadow"],
         "approvedProviders": ["anthropic", "openai"]
       }
     }
   }
   ```

   `mode` defaults to `"off"`; installing the extension alone writes nothing.
   `mode: "shadow"` requires a non-empty `approvedProviders` and
   `allowedTaskKinds` containing the fixed `safe-routing-readonly-shadow` —
   any other value is rejected, not silently coerced.

## Running a shadow evaluation

```bash
openclaw safe-routing shadow --contract ./contract.json --session-ref my-session --json
```

- `--contract` is a JSON `PersistedTaskContract` file. It must already declare
  `"deliveryMode": "none"` — the CLI rejects it otherwise before ever talking
  to the gateway.
- `--session-ref` is an opaque reference the CLI passes through; it never
  substitutes for a real session key, and the gateway derives the actual
  caller identity from the connection itself.
- Output includes `taskId`, `routingPolicyVersion`, `digestsConsistent`,
  `theoreticalSelection` (first eligible candidate, if any), and
  `currentSelection` (the candidate a real hook-observed call has actually
  correlated to, if any yet).

## Querying an existing audit

Re-running `safe-routing shadow` against the same contract/session does not
create new database rows beyond a fresh checkpoint — see
`src/tasks/safety/service.ts`'s `getShadowAudit` for the read path; it never
writes.

## Rolling back

Set `mode: "off"` (or remove the extension entirely). This immediately stops
all new lease creation, evaluation, and audit writes. Existing `task_contracts`
/ `task_checkpoints` / `model_capability_snapshots` / `model_route_attempts`
rows are additive-only audit history — nothing needs to be deleted, and older
OpenClaw builds that do not recognize these tables simply ignore them.

## Known Phase 1 limitations

- `runtimeIds` in a contract's required capabilities is never satisfiable —
  Phase 1 never resolves a verified runtime id, so any contract requiring one
  is always rejected.
- `dataPolicy: "local-only"` only recognizes the `ollama` provider API as
  local; every other provider is rejected under that policy.
- Capability snapshots are built from config declarations only — there is no
  runtime probe pipeline yet, so `toolCalling`/`structuredOutput` show
  `unverified` unless explicitly declared in provider/model config.
- `decisionGrade` authorization has no real per-model policy source yet;
  Phase 1 defaults every candidate to `final`-authorized (unrestricted on this
  dimension), since shadow mode never actually executes a call.
- The extension derives caller identity from the gateway connection's session
  key only; it does not yet have a verified way to read `operator.write`/
  `operator.read` scopes off a plugin gateway method's `client` object, so
  only session ownership (not the operator-scope fallback) is enforced today.
- This extension never touches `primary`/`fallbacks` in `openclaw.json` and
  never calls a model, tool, or auth resolver.
