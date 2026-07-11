---
summary: "What survives a gateway restart or crash, including durable admission and automatic recovery for eligible Control UI turns"
read_when:
  - You want to know whether restarting the gateway loses in-progress agent work
  - An agent run was interrupted by a restart, crash, or config reload
  - You are debugging automatic session recovery after the gateway comes back up
  - A Control UI message was acknowledged just before a crash or forced restart
title: "Restart recovery"
---

Restarting the gateway preserves durable agent state. Conversations,
transcripts, scheduled jobs, background task records, and queued outbound
messages live on disk. Interrupted work that reached a durable recovery
boundary is detected and resumed automatically after the gateway starts again.
Eligible plain-text Control UI turns reach that boundary before the gateway
acknowledges the send. Recovery is always on; no manual intervention or
configuration is required.

This page describes what survives a restart, how interrupted work is detected,
and what the automatic resume looks like.

## What survives a restart

| State                             | Storage                                             | Behavior across restart                                                                                       |
| --------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Conversation history              | JSONL transcripts + per-agent session store on disk | Untouched; sessions continue from the stored transcript                                                       |
| Eligible accepted Control UI turn | SQLite (shared state database)                      | Reserved before the success acknowledgment; unfinished admission becomes a main-session recovery turn on boot |
| Interrupted main-session turn     | SQLite (shared state database)                      | Recovery ownership survives repeated restarts; the turn resumes after startup                                  |
| Subagent runs                     | SQLite (shared state database)                      | Registry restored on boot; interrupted runs resumed                                                           |
| Background tasks                  | SQLite (shared state database)                      | Reconciled on boot; orphaned runs recovered or marked lost                                                    |
| Queued outbound deliveries        | SQLite delivery queue                               | Drained after restart; undelivered replies are retried                                                        |
| Scheduled (cron) jobs             | SQLite cron store                                   | Schedules persist; the scheduler re-arms on boot                                                              |
| Restart continuation              | SQLite restart sentinel                             | One-shot follow-up dispatched to the session that asked for the restart                                       |

## Graceful restarts drain first

A requested restart (`openclaw gateway restart`, a config change that requires
a restart, or a gateway update) does not kill in-flight work immediately. The
gateway stops accepting new work, then waits for active agent turns and
background tasks to finish, up to a drain budget (5 minutes by default). Most
restarts therefore interrupt nothing at all.

Only work that cannot finish inside the drain budget (or any run interrupted
by a forced restart or a crash) is aborted. Before any one-way shutdown step,
the gateway reserves durable recovery ownership for every affected main-session
run. If that preflight cannot complete, the restart is cancelled and the
current gateway stays online.

## How interrupted work is detected

Three complementary mechanisms preserve or mark sessions whose turn did not
finish:

- **Before acknowledgment:** for an eligible plain-text Control UI turn in an
  existing main session, the gateway reserves the public run ID in shared
  SQLite, persists the exact user turn to the transcript, transfers the row to
  transcript ownership, and installs a per-session barrier before returning a
  successful `chat.send` response. If any durable step fails, the send fails
  instead of being acknowledged. Provider and tool execution begins later,
  through the recovery worker.
- **At shutdown:** during the restart drain, the gateway batch-reserves active
  main-session runs in the SQLite recovery ledger before aborting them or
  starting one-way teardown.
- **At startup:** the gateway scans session stores for sessions that still
  claim to be running but have no live owner in the new process, then records
  those obligations in the same SQLite ledger. This catches hard crashes and
  kills where no shutdown code ran. Stale transcript lock files are cleaned up
  at the same time.

On startup, an admission that did not reach durable handoff is appended
idempotently to the same transcript and converted into the normal main-session
recovery path. The admission remains a per-session barrier until the recovery
turn reaches durable terminal state or is explicitly cancelled, so a later
send cannot overtake it. Abort, reset, and delete operations cancel the exact
admission before releasing that barrier. Completed handoffs retain only a
short-lived, content-free terminal tombstone for retry deduplication.

The `runId` returned by the original `chat.send` remains the public identity
through retries and repeated restarts. Recovery dispatch and execution IDs are
private implementation details; they are not substituted into client payloads
or transcript identity.

## Automatic resume

After startup, the recovery worker claims due rows from SQLite. A pre-ack
Control UI admission continues from its one exact persisted user turn; the
worker does not append a duplicate. A previously running session is
re-dispatched with a synthetic system message telling the agent that the turn
was interrupted and to continue from the existing transcript. If a final reply
had already been produced but not delivered, its text is included so the agent
can deliver it instead of redoing the work. Transient failures use bounded
retries with exponential backoff.

Before resuming, the gateway checks that the transcript tail is safe to
continue from. If it is not (for example, the turn ended on a stale pending
approval), the session is not blindly re-run. The session is marked failed,
and OpenClaw attempts to send delivery-capable chats a short notice asking the
user to resend the last request. For Control UI sessions without an outbound
delivery route, OpenClaw appends the same notice once to the session transcript
so it appears after the browser reconnects.

### Subagents

Subagent runs are persisted in the shared SQLite state database, so the
subagent registry survives the process. On boot the registry is restored and
interrupted subagent sessions are resumed with their original task context.
Two safety valves apply:

- Runs interrupted more than 2 hours ago are finalized instead of resumed, so
  a gateway that was down overnight does not resurrect stale work.
- A session that repeatedly fails to recover is tombstoned as wedged so
  recovery cannot loop forever.

### Background tasks

The [background task registry](/automation/tasks) is SQLite-backed and
reconciled on boot and on a periodic interval: durable outcomes recorded by
finished runs are recovered, and runs whose owning process disappeared are
marked lost after a grace period instead of hanging forever.

### Agent-requested restarts

When the agent itself triggers a restart (applying a config change, updating
the gateway, or an explicit restart request), a restart sentinel is written to
SQLite before the process exits. After boot the gateway posts the outcome back
to the originating chat and dispatches a one-shot continuation turn so the
agent picks up exactly where it left off, on the same channel and thread.

### Upgrades from legacy recovery state

Older shipped versions stored main-session recovery ownership in session JSON.
The gateway does not use that JSON as a runtime fallback. `openclaw doctor`
reports affected sessions; `openclaw doctor --fix` writes and verifies the
equivalent SQLite row first, then removes the legacy ownership fields. New work
for an affected session stays blocked until that migration converges.

Backups are restore-safe snapshots, not checkpoints for live work. Backup
creation removes main-run recovery obligations from the staged SQLite snapshot,
so restoring an archive cannot replay a turn owned by the source process. See
[Backup](/cli/backup).

## Safety valves and observability

- **Crash-loop breaker:** 3 unclean boots within 5 minutes trip a breaker that
  suppresses auto-start side services on the next boot, so a crashing gateway
  does not amplify itself. It recovers once the unclean-boot window drains.
- **Metrics:** recovery activity is exported via
  [Prometheus](/gateway/prometheus) as `openclaw_session_recovery_total` and
  `openclaw_session_recovery_age_seconds`.
- **Logs:** recovery decisions are logged under the
  `main-run-recovery` and `subagent-interrupted-resume` subsystems.

## What is not resumed

- Pre-acknowledgment Control UI recovery applies only to an ordinary plain-text
  main turn in an existing session. Attachments, commands and directives,
  per-turn behavior overrides, reconnect or explicitly routed sends,
  secondary or queued work, plugin-owned sessions, and sessions with
  pre-adoption hooks keep their normal post-adoption recovery boundary.
- Sessions excluded from main-session recovery because another owner already
  handles them: subagent sessions (subagent recovery), cron sessions (the
  scheduler re-runs on schedule), and ACP-managed sessions (the connected IDE
  or client owns the resume).
- Sessions whose transcript tail cannot be safely continued; OpenClaw uses the
  channel or Control UI transcript resend-notice paths described above instead
  of a silent re-run.
- Work that was never admitted: messages arriving during the drain window are
  rejected with an explicit restart error rather than silently queued into a
  dying process.
