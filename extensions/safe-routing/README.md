# safe-routing (Phase 1 shadow)

Read-only shadow evaluation of theoretical model routing admission. Reports
what _would_ be selected under a task contract, without ever changing which
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
- At most one pending lease is ever live per session: creating a new lease
  immediately supersedes any other still-pending lease for the same session
  (in the same write transaction), so a real hook event can never bind to a
  stale, already-replaced lease. Evaluating a superseded lease's token returns
  `{ ok: false, code: "superseded" }`.
- `safe-routing.evaluate` is rate-limited per caller (10 calls per 60s,
  `src/rate-limit.ts`) — a small extension-local sliding window, not Core's
  `control-plane-rate-limit.ts`, so this stays self-contained instead of
  growing the plugin-sdk export surface. Exceeding it returns
  `{ ok: false, code: "rate_limited" }`.

## Real-call observation

Once a lease has been evaluated, the extension subscribes to the gateway's
`model_call_started`/`model_call_ended` typed hooks (`api.on(...)`, the same
public mechanism `extensions/workboard` uses for a different event — no Core
changes were needed) so that if the real routing loop actually calls one of
the evaluated candidates, the matching route attempt is updated from
`observationCompleteness: "unavailable"` to `"complete"` and
`observationCoverage: "hook-covered"`. `mode: "off"` skips this before
touching anything; a `mode: "shadow"` session with no active lease also
no-ops (see `src/agents/model-routing/observed-attempt.ts`). Verified end to
end in `shadow-evaluator.integration.test.ts`.

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
- The extension has no verified way to read a connection's granted
  `operator.write`/`operator.read` scopes off a plugin gateway method's
  `client` object. It derives caller identity from the connection's
  embedded-agent session key when present; otherwise (the explicit CLI, which
  never carries that identity) it treats the caller as an `operator.admin`
  operator, since all three gateway methods register without a narrower
  `{scope}` and so already require `operator.admin` for Core to dispatch the
  call at all — reaching the handler is itself the proof. A future narrower
  scope reader could downgrade this to the caller's actual granted scope.
- `recordObservedModelAttemptInGateway` (the hook-bridge used for real-call
  observation) has no caller-identity check of its own — it trusts its
  `event`/`ctx` arguments verbatim, because its only intended caller is Core's
  own typed-hook dispatcher. Any other installed plugin that also constructs
  `SafeRoutingServiceDeps` could call it directly with a fabricated
  `ctx.sessionKey`, corrupting the observation trail of a session that
  currently holds an active lease. This cannot corrupt real routing or real
  model calls — Phase 1 never enforces anything — only the shadow audit's own
  report data for a session that voluntarily opted into shadow evaluation.
  Closing it fully needs Core to give hook dispatch tamper-evident
  provenance; out of scope for Phase 1.

## Phase 1 boundaries (by design, not just "not implemented yet")

- Never changes `agents.defaults.model.primary`/`fallbacks` in `openclaw.json`,
  and never mutates the real fallback candidate chain — it only calls the
  unmodified `resolveModelCandidateChain` to _read_ the current chain.
- Never calls a model, a tool, `resolveAuthProfileOrder`, or anything that
  mutates provider cooldown/health state.
- No `enforce` mode, no state-transition API, no way to block or redirect a
  real request — Phase 1 is report-only end to end.
- Does not create the Phase 2 `task_safety_state` table or a `blocked` task
  status; a shadow task with zero eligible candidates still ends via the
  existing `succeeded` lifecycle, only surfacing a derived, non-persisted
  `"CAPABLE_MODEL"` suggestion in the audit response.
- Does not register a model tool and does not listen to ordinary chat traffic
  — only the three gateway methods, the two observation-only typed hook
  subscriptions above, and the explicit CLI exist.
- `mode: "off"` (the default) means the extension's gateway methods refuse to
  run at all — no lease, no checkpoint, no snapshot, no route attempt is ever
  written, verified end to end in
  `extensions/safe-routing/src/cli.integration.test.ts`.
