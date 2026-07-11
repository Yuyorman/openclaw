// Covers backup archive creation and verification filtering.
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { backupVerifyCommand } from "../commands/backup-verify.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withRealpathSymlinkRebindRace } from "../test-utils/symlink-rebind-race.js";
import {
  testApi as backupCreateInternals,
  buildExtensionsNodeModulesFilter,
  createBackupArchive,
  formatBackupCreateSummary,
  type BackupCreateResult,
} from "./backup-create.js";
import { isVolatileBackupPath } from "./backup-volatile-filter.js";
import { requireNodeSqlite } from "./node-sqlite.js";

function makeResult(overrides: Partial<BackupCreateResult> = {}): BackupCreateResult {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    archiveRoot: "openclaw-backup-2026-01-01",
    archivePath: "/tmp/openclaw-backup.tar.gz",
    dryRun: false,
    includeWorkspace: true,
    onlyConfig: false,
    verified: false,
    assets: [],
    skipped: [],
    skippedVolatileCount: 0,
    ...overrides,
  };
}

async function listArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push(entry.path);
      entry.resume();
    },
  });
  return entries;
}

async function listArchiveEntryDetails(
  archivePath: string,
): Promise<Array<{ path: string; linkpath?: string; type?: string }>> {
  const entries: Array<{ path: string; linkpath?: string; type?: string }> = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push({
        path: entry.path,
        ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
        ...(entry.type ? { type: entry.type } : {}),
      });
      entry.resume();
    },
  });
  return entries;
}

const BACKUP_MAIN_RUN_RECOVERY_STATES = [
  "accepted",
  "transcript_owned",
  "running",
  "recovery_pending",
  "cancelling",
  "terminal",
] as const;

type BackupMainRunRecoveryState = (typeof BACKUP_MAIN_RUN_RECOVERY_STATES)[number];

function insertMainRunRecoveryFixture(params: {
  db: ReturnType<typeof openOpenClawStateDatabase>["db"];
  runId: string;
  state?: BackupMainRunRecoveryState;
  storePath: string;
}): void {
  const state = params.state ?? "recovery_pending";
  const terminalAtMs = state === "terminal" ? 20 : null;
  const envelope =
    state === "terminal"
      ? null
      : JSON.stringify({
          kind: "session_resume",
          resolution: { kind: "resume" },
          systemMessage: "resume fixture",
          transcriptTail: null,
          lifecycleRevision: null,
          delivery: { context: null, runId: null, intentId: null },
          fences: [],
        });
  params.db
    .prepare(
      `
        INSERT INTO main_run_recoveries (
          public_run_id, source_kind, source_key, source_fingerprint, state,
          boot_id, agent_id, owner_principal_json, sender_is_owner,
          session_key, session_key_aliases_json, session_id, store_path,
          lifecycle_fences_json, envelope_json, next_attempt_at_ms, cancellation_json,
          terminal_outcome_json, accepted_at_ms, updated_at_ms, terminal_at_ms, prune_after_ms
        ) VALUES (
          ?, 'session_resume', ?, ?, ?,
          'boot-1', 'main', NULL, 0,
          ?, '[]', ?, ?,
          '[]', ?, ?, ?,
          ?, 10, ?, ?, ?
        )
      `,
    )
    .run(
      params.runId,
      `source:${params.runId}`,
      "0".repeat(64),
      state,
      `agent:main:dashboard:${params.runId}`,
      `session-${params.runId}`,
      params.storePath,
      envelope,
      state === "accepted" ||
        state === "transcript_owned" ||
        state === "recovery_pending" ||
        state === "cancelling"
        ? 10
        : null,
      state === "cancelling"
        ? JSON.stringify({ kind: "abort", epoch: `cancel:${params.runId}`, requestedAtMs: 10 })
        : null,
      state === "terminal" ? JSON.stringify({ status: "done", endedAtMs: 20 }) : null,
      terminalAtMs ?? 10,
      terminalAtMs,
      terminalAtMs === null ? null : terminalAtMs + 86_400_000,
    );
}

function isFileHandleRead(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "fd" in value &&
    typeof (value as { fd?: unknown }).fd === "number"
  );
}

describe("formatBackupCreateSummary", () => {
  const backupArchiveLine = "Backup archive: /tmp/openclaw-backup.tar.gz";

  it.each([
    {
      name: "formats created archives with included and skipped paths",
      result: makeResult({
        verified: true,
        assets: [
          {
            kind: "state",
            sourcePath: "/state",
            archivePath: "archive/state",
            displayPath: "~/.openclaw",
          },
        ],
        skipped: [
          {
            kind: "workspace",
            sourcePath: "/workspace",
            displayPath: "~/Projects/openclaw",
            reason: "covered",
            coveredBy: "~/.openclaw",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 1 path:",
        "- state: ~/.openclaw",
        "Skipped 1 path:",
        "- workspace: ~/Projects/openclaw (covered by ~/.openclaw)",
        "Created /tmp/openclaw-backup.tar.gz",
        "Archive verification: passed",
      ],
    },
    {
      name: "formats dry runs and pluralized counts",
      result: makeResult({
        dryRun: true,
        assets: [
          {
            kind: "config",
            sourcePath: "/config",
            archivePath: "archive/config",
            displayPath: "~/.openclaw/config.json",
          },
          {
            kind: "credentials",
            sourcePath: "/oauth",
            archivePath: "archive/oauth",
            displayPath: "~/.openclaw/oauth",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 2 paths:",
        "- config: ~/.openclaw/config.json",
        "- credentials: ~/.openclaw/oauth",
        "Dry run only; archive was not written.",
      ],
    },
  ])("$name", ({ result, expected }) => {
    expect(formatBackupCreateSummary(result)).toEqual(expected);
  });

  it("surfaces the volatile skip count in the summary", () => {
    expect(
      formatBackupCreateSummary(
        makeResult({
          assets: [
            {
              kind: "state",
              sourcePath: "/state",
              archivePath: "archive/state",
              displayPath: "~/.openclaw",
            },
          ],
          skippedVolatileCount: 3,
        }),
      ),
    ).toEqual([
      "Backup archive: /tmp/openclaw-backup.tar.gz",
      "Included 1 path:",
      "- state: ~/.openclaw",
      "Created /tmp/openclaw-backup.tar.gz",
      "Skipped 3 volatile files (live sessions, cron logs, queues, sockets, pid/tmp).",
    ]);
  });
});

describe("isTarEofRaceError", () => {
  const { isTarEofRaceError } = backupCreateInternals;

  it.each([
    "did not encounter expected EOF",
    "encountered unexpected EOF",
    "TAR_BAD_ARCHIVE: Unrecognized archive format",
    "Truncated input (needed 512 more bytes, only 0 available) (TAR_BAD_ARCHIVE)",
  ])("matches tar-specific EOF-class error: %s", (message) => {
    expect(isTarEofRaceError(new Error(message))).toBe(true);
  });

  it("matches errors by code even when the message is empty", () => {
    expect(isTarEofRaceError(Object.assign(new Error(""), { code: "EOF" }))).toBe(true);
  });

  it.each([
    "EOF occurred in violation of protocol",
    "unexpected eof while reading",
    "ran out of EOF markers",
    "permission denied",
    "",
  ])("does not match unrelated errors: %s", (message) => {
    expect(isTarEofRaceError(new Error(message))).toBe(false);
  });

  it("rejects non-object inputs", () => {
    expect(isTarEofRaceError(null)).toBe(false);
    expect(isTarEofRaceError(undefined)).toBe(false);
    expect(isTarEofRaceError("did not encounter expected EOF")).toBe(false);
  });
});

describe("writeTarArchiveWithRetry", () => {
  it("retries on EOF-class errors and eventually succeeds", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });
    const runTar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(eofErr)
      .mockRejectedValueOnce(eofErr)
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await backupCreateInternals.writeTarArchiveWithRetry({
      tempArchivePath: "/tmp/backup.tar.gz.tmp",
      runTar,
      log,
      sleepMs: sleep,
    });

    expect(runTar).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 20_000);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("uses a fresh temp archive path when cleanup cannot remove a failed attempt", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });
    const tempArchivePath = "/tmp/backup.tar.gz.tmp";
    const runTar = vi
      .fn<(attemptTempArchivePath: string) => Promise<void>>()
      .mockRejectedValueOnce(eofErr)
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async () => {
      throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
    });

    try {
      const completedTempArchivePath = await backupCreateInternals.writeTarArchiveWithRetry({
        tempArchivePath,
        runTar,
        log,
        sleepMs: sleep,
      });

      expect(runTar).toHaveBeenNthCalledWith(1, tempArchivePath);
      expect(runTar).toHaveBeenNthCalledWith(2, `${tempArchivePath}.retry-2`);
      expect(completedTempArchivePath).toBe(`${tempArchivePath}.retry-2`);
      expect(rmSpy).toHaveBeenCalledWith(tempArchivePath, { force: true });
      expect(log).toHaveBeenCalledWith(
        `Backup archiver could not remove temp archive ${tempArchivePath} between retries: EBUSY. Continuing.`,
      );
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("cleans retry temp archive paths when a later attempt fails", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });
    const tempArchivePath = "/tmp/backup.tar.gz.tmp";
    const runTar = vi
      .fn<(attemptTempArchivePath: string) => Promise<void>>()
      .mockRejectedValueOnce(eofErr)
      .mockRejectedValueOnce(new Error("permission denied"));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);

    try {
      await expect(
        backupCreateInternals.writeTarArchiveWithRetry({
          tempArchivePath,
          runTar,
          sleepMs: sleep,
        }),
      ).rejects.toThrow(/permission denied/);

      expect(runTar).toHaveBeenNthCalledWith(1, tempArchivePath);
      expect(runTar).toHaveBeenNthCalledWith(2, `${tempArchivePath}.retry-2`);
      expect(rmSpy).toHaveBeenCalledWith(`${tempArchivePath}.retry-2`, { force: true });
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("surfaces the offending path and attempt count after exhausting retries", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/logs/gateway.jsonl",
    });
    const runTar = vi.fn<() => Promise<void>>().mockRejectedValue(eofErr);
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      backupCreateInternals.writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar.gz.tmp",
        runTar,
        sleepMs: sleep,
      }),
    ).rejects.toThrow(/last offending path: \/state\/logs\/gateway\.jsonl, after 3 attempts/);
    expect(runTar).toHaveBeenCalledTimes(3);
  });

  it("lets callers reset per-attempt counters so retries report the final attempt's count, not a running sum", async () => {
    // Simulate the caller's pattern: a closure counter populated by a filter
    // that tar.c invokes while walking the tree. Each attempt re-walks the
    // same tree, so the runTar closure must reset the counter before calling
    // tar.c -- otherwise the reported count accumulates across attempts.
    let skippedVolatileCount = 0;
    const volatileFilesSeenPerAttempt = 5;
    let attempt = 0;

    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });

    const runTar = vi.fn<() => Promise<void>>().mockImplementation(async () => {
      attempt += 1;
      skippedVolatileCount = 0;
      for (let i = 0; i < volatileFilesSeenPerAttempt; i += 1) {
        skippedVolatileCount += 1;
      }
      if (attempt < 3) {
        throw eofErr;
      }
    });
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await backupCreateInternals.writeTarArchiveWithRetry({
      tempArchivePath: "/tmp/backup.tar.gz.tmp",
      runTar,
      sleepMs: sleep,
    });

    expect(runTar).toHaveBeenCalledTimes(3);
    // Without the reset, this would be 15 (5 * 3 attempts). With the reset,
    // it equals the count from the final (successful) attempt.
    expect(skippedVolatileCount).toBe(volatileFilesSeenPerAttempt);
  });

  it("does not retry on non-EOF errors", async () => {
    const runTar = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("permission denied"));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      backupCreateInternals.writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar.gz.tmp",
        runTar,
        sleepMs: sleep,
      }),
    ).rejects.toThrow(/permission denied/);
    expect(runTar).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("createBackupVolatileStatCache", () => {
  it("lets tar filter a volatile file that disappears before lstat", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-volatile-stat-cache-",
        scenario: "minimal",
      },
      async (state) => {
        const volatilePath = await state.writeText("logs/gateway.log", "live log\n");
        await state.writeText("settings.json", '{"keep":true}\n');
        const archivePath = state.path("volatile-stat-cache.tar.gz");
        const volatilePlan = { stateDirs: [state.stateDir] };
        const statCache = backupCreateInternals.createBackupVolatileStatCache(volatilePlan);
        const getCachedStat = statCache.get.bind(statCache);
        let removedBeforeStat = false;

        statCache.get = (key: string) => {
          if (path.resolve(key) === path.resolve(volatilePath)) {
            rmSync(volatilePath, { force: true });
            removedBeforeStat = true;
          }
          return getCachedStat(key);
        };

        await tar.c(
          {
            file: archivePath,
            gzip: true,
            portable: true,
            preservePaths: true,
            statCache,
            filter: (entryPath) => !isVolatileBackupPath(entryPath, volatilePlan),
          },
          [state.stateDir],
        );

        const entries = await listArchiveEntries(archivePath);
        expect(removedBeforeStat).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/settings.json"))).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/logs/gateway.log"))).toBe(false);
      },
    );
  });
});

describe("buildExtensionsNodeModulesFilter", () => {
  it("excludes dependency trees only under state extensions", () => {
    const filter = buildExtensionsNodeModulesFilter("/state/");

    expect(filter("/state/extensions/demo/openclaw.plugin.json")).toBe(true);
    expect(filter("/state/extensions/demo/src/index.js")).toBe(true);
    expect(filter("/state/extensions/demo/node_modules/dep/index.js")).toBe(false);
    expect(filter("/state/extensions/demo/vendor/node_modules/dep/index.js")).toBe(false);
    expect(filter("/state/node_modules/dep/index.js")).toBe(true);
    expect(filter("/state/extensions-node_modules/demo/index.js")).toBe(true);
  });

  it("normalizes Windows path separators", () => {
    const filter = buildExtensionsNodeModulesFilter("C:\\Users\\me\\.openclaw\\");

    expect(filter(String.raw`C:\Users\me\.openclaw\extensions\demo\index.js`)).toBe(true);
    expect(
      filter(String.raw`C:\Users\me\.openclaw\extensions\demo\node_modules\dep\index.js`),
    ).toBe(false);
  });
});

describe("createBackupArchive", () => {
  it("falls back when injected nowMs is outside Date range", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-invalid-now-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));

        try {
          const result = await createBackupArchive({
            output: outputDir,
            dryRun: true,
            includeWorkspace: false,
            nowMs: 8_640_000_000_000_001,
          });

          expect(result.createdAt).toBe("2026-05-30T12:00:00.000Z");
          expect(path.basename(result.archivePath)).toContain("openclaw-backup.tar.gz");
          expect(path.basename(result.archivePath)).not.toContain("NaN");
        } finally {
          dateNowSpy.mockRestore();
        }
      },
    );
  });

  it("falls back to epoch when injected nowMs and Date.now are outside Date range", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-invalid-fallback-now-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

        try {
          const result = await createBackupArchive({
            output: outputDir,
            dryRun: true,
            includeWorkspace: false,
            nowMs: 8_640_000_000_000_001,
          });

          expect(result.createdAt).toBe("1970-01-01T00:00:00.000Z");
          expect(path.basename(result.archivePath)).toContain("openclaw-backup.tar.gz");
          expect(path.basename(result.archivePath)).not.toContain("NaN");
        } finally {
          dateNowSpy.mockRestore();
        }
      },
    );
  });

  it("skips current live volatile state files while preserving workspace locks", async () => {
    await withOpenClawTestState(
      {
        layout: "split",
        prefix: "openclaw-backup-volatile-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await state.writeConfig({
          agents: {
            list: [{ id: "main", default: true, workspace: state.workspaceDir }],
          },
        });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(path.join(state.workspaceDir, "Cargo.lock"), "workspace lock\n", "utf8");
        await fs.writeFile(
          path.join(state.workspaceDir, "pending.tmp"),
          "workspace temp fixture\n",
          "utf8",
        );
        await state.writeText("agents/main/sessions/live-session.jsonl", "session\n");
        await state.writeText("sessions/legacy-session.jsonl", "legacy session\n");
        await state.writeText("cron/runs/nightly.jsonl", "cron\n");
        await state.writeText("logs/gateway.log", "log\n");
        await state.writeJson("delivery-queue/message.json", { id: "delivery" });
        await state.writeText("delivery-queue/message.delivered", '{"id":"delivery"}\n');
        await state.writeJson("session-delivery-queue/message.json", { id: "session-delivery" });
        await state.writeText(
          "session-delivery-queue/message.delivered",
          '{"id":"session-delivery"}\n',
        );
        await state.writeText("tmp/staged.tmp", "tmp\n");
        await state.writeText("gateway.pid", "123\n");

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: true,
          nowMs: Date.UTC(2026, 4, 9, 8, 0, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);

        expect(entries.some((entry) => entry.endsWith("/workspace/Cargo.lock"))).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/workspace/pending.tmp"))).toBe(true);
        for (const suffix of [
          "/state/agents/main/sessions/live-session.jsonl",
          "/state/sessions/legacy-session.jsonl",
          "/state/cron/runs/nightly.jsonl",
          "/state/logs/gateway.log",
          "/state/delivery-queue/message.json",
          "/state/delivery-queue/message.delivered",
          "/state/session-delivery-queue/message.json",
          "/state/session-delivery-queue/message.delivered",
          "/state/tmp/staged.tmp",
          "/state/gateway.pid",
        ]) {
          expect(
            entries.some((entry) => entry.endsWith(suffix)),
            suffix,
          ).toBe(false);
        }
        expect(result.skippedVolatileCount).toBe(10);
      },
    );
  });

  it("scrubs transient SQLite runtime rows from archive snapshots", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sqlite-queue-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const sessionStorePath = state.statePath("agents", "main", "sessions", "sessions.json");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        await fs.mkdir(path.dirname(sessionStorePath), { recursive: true });
        await fs.writeFile(sessionStorePath, "{}\n", "utf8");
        const { db } = openOpenClawStateDatabase({ env: state.env });
        db.prepare(
          `
            INSERT INTO delivery_queue_entries (
              queue_name, id, status, retry_count, entry_json, enqueued_at, updated_at
            ) VALUES ('outbound', 'queued-1', 'pending', 0, '{"id":"queued-1"}', 10, 10)
          `,
        ).run();
        for (const recoveryState of BACKUP_MAIN_RUN_RECOVERY_STATES) {
          insertMainRunRecoveryFixture({
            db,
            runId: `run-${recoveryState}`,
            state: recoveryState,
            storePath: sessionStorePath,
          });
        }
        const sourceRecoveryRows = db
          .prepare("SELECT * FROM main_run_recoveries ORDER BY public_run_id")
          .all();
        expect(
          sourceRecoveryRows.map((row) => (row as { state: string }).state).toSorted(),
        ).toEqual([...BACKUP_MAIN_RUN_RECOVERY_STATES].toSorted());

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 30, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const archivedDbEntry = entries.find((entry) =>
            entry.endsWith("/state/state/openclaw.sqlite"),
          );
          expect(archivedDbEntry).toBeDefined();
          expect(entries.some((entry) => entry.endsWith("/state/state/openclaw.sqlite-wal"))).toBe(
            false,
          );

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const sqlite = requireNodeSqlite();
          const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, archivedDbEntry!), {
            readOnly: true,
          });
          try {
            expect(
              archivedDb.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
            ).toEqual({ count: 0 });
            expect(
              archivedDb.prepare("SELECT COUNT(*) AS count FROM main_run_recoveries").get(),
            ).toEqual({ count: 0 });
          } finally {
            archivedDb.close();
          }

          expect(db.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get()).toEqual({
            count: 1,
          });
          expect(
            db.prepare("SELECT * FROM main_run_recoveries ORDER BY public_run_id").all(),
          ).toEqual(sourceRecoveryRows);
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("terminalizes every resumable session in a staged store", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-restart-session-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
        const unreferencedStorePath = state.statePath(
          "agents",
          "new-agent",
          "sessions",
          "sessions.json",
        );
        const nowMs = Date.UTC(2026, 4, 9, 8, 45, 0);
        const sourceStore = {
          "agent:main:dashboard:active": {
            sessionId: "session-active",
            status: "running",
            startedAt: nowMs - 1_000,
            updatedAt: nowMs - 100,
            abortedLastRun: true,
            restartRecoveryRuns: [{ runId: "run-active", lifecycleGeneration: "boot-1" }],
            pendingFinalDelivery: true,
            pendingFinalDeliveryText: "stale reply",
            pendingFinalDeliveryContext: { channel: "webchat", to: "dashboard" },
            pendingFinalDeliveryIntentId: "intent-active",
            keep: "session metadata",
          },
          "agent:main:dashboard:rotated": {
            sessionId: "session-rotated-after-sqlite-snapshot",
            status: "running",
            startedAt: nowMs + 500,
            updatedAt: nowMs + 750,
            abortedLastRun: true,
            restartRecoveryRuns: [{ runId: "run-rotated", lifecycleGeneration: "boot-2" }],
            pendingFinalDelivery: true,
            pendingFinalDeliveryText: "rotated stale reply",
            keep: "rotated session metadata",
          },
          "agent:main:dashboard:recovery-only": {
            sessionId: "session-recovery-only-after-sqlite-snapshot",
            status: "done",
            updatedAt: nowMs - 25,
            abortedLastRun: true,
            restartRecoveryRuns: [{ runId: "run-recovery-only", lifecycleGeneration: "boot-2" }],
            pendingFinalDelivery: true,
            pendingFinalDeliveryText: "recovery-only stale reply",
            keep: "recovery-only session metadata",
          },
          "agent:main:dashboard:completed": {
            sessionId: "session-completed",
            status: "done",
            updatedAt: nowMs - 2_000,
            keep: "unrelated session",
          },
        };
        const unreferencedSourceStore = {
          "agent:new-agent:dashboard:active": {
            sessionId: "session-in-store-absent-from-sqlite-snapshot",
            status: "running",
            startedAt: nowMs - 400,
            updatedAt: nowMs - 40,
            abortedLastRun: true,
            restartRecoveryRuns: [
              { runId: "run-in-store-absent-from-sqlite", lifecycleGeneration: "boot-2" },
            ],
            pendingFinalDelivery: true,
            pendingFinalDeliveryText: "different-store stale reply",
            keep: "different-store session metadata",
          },
        };
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        await state.writeJson("agents/main/sessions/sessions.json", sourceStore);
        await state.writeJson("agents/new-agent/sessions/sessions.json", unreferencedSourceStore);
        const { db } = openOpenClawStateDatabase({ env: state.env });
        insertMainRunRecoveryFixture({ db, runId: "run-active", storePath });

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs,
          });
          const entries = await listArchiveEntries(result.archivePath);
          const archivedStoreEntries = entries.filter((entry) =>
            entry.endsWith("/state/agents/main/sessions/sessions.json"),
          );
          const archivedUnreferencedStoreEntries = entries.filter((entry) =>
            entry.endsWith("/state/agents/new-agent/sessions/sessions.json"),
          );
          expect(archivedStoreEntries).toHaveLength(1);
          expect(archivedUnreferencedStoreEntries).toHaveLength(1);
          const archivedStoreEntry = archivedStoreEntries[0];
          const archivedUnreferencedStoreEntry = archivedUnreferencedStoreEntries[0];
          expect(archivedStoreEntry).toBeDefined();
          expect(archivedUnreferencedStoreEntry).toBeDefined();

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const archivedStore = JSON.parse(
            await fs.readFile(path.join(extractDir, archivedStoreEntry!), "utf8"),
          ) as Record<string, Record<string, unknown>>;
          expect(archivedStore["agent:main:dashboard:active"]).toEqual({
            sessionId: "session-active",
            status: "killed",
            startedAt: nowMs - 1_000,
            endedAt: nowMs,
            updatedAt: nowMs,
            abortedLastRun: false,
            keep: "session metadata",
          });
          expect(archivedStore["agent:main:dashboard:rotated"]).toEqual({
            sessionId: "session-rotated-after-sqlite-snapshot",
            status: "killed",
            startedAt: nowMs + 500,
            endedAt: nowMs + 750,
            updatedAt: nowMs + 750,
            abortedLastRun: false,
            keep: "rotated session metadata",
          });
          expect(archivedStore["agent:main:dashboard:recovery-only"]).toEqual({
            sessionId: "session-recovery-only-after-sqlite-snapshot",
            status: "done",
            updatedAt: nowMs - 25,
            abortedLastRun: false,
            keep: "recovery-only session metadata",
          });
          expect(archivedStore["agent:main:dashboard:completed"]).toEqual(
            sourceStore["agent:main:dashboard:completed"],
          );
          const archivedUnreferencedStore = JSON.parse(
            await fs.readFile(path.join(extractDir, archivedUnreferencedStoreEntry!), "utf8"),
          ) as Record<string, Record<string, unknown>>;
          expect(archivedUnreferencedStore["agent:new-agent:dashboard:active"]).toEqual({
            sessionId: "session-in-store-absent-from-sqlite-snapshot",
            status: "killed",
            startedAt: nowMs - 400,
            endedAt: nowMs,
            updatedAt: nowMs,
            abortedLastRun: false,
            keep: "different-store session metadata",
          });
          expect(JSON.parse(await fs.readFile(storePath, "utf8"))).toEqual(sourceStore);
          expect(JSON.parse(await fs.readFile(unreferencedStorePath, "utf8"))).toEqual(
            unreferencedSourceStore,
          );
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("ignores invalid configured session stores while sanitizing discovered stores", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-invalid-session-store-config-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const nowMs = Date.UTC(2026, 4, 9, 8, 46, 0);
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        await state.writeConfig({ session: { store: 42 } });
        await state.writeJson("agents/main/sessions/sessions.json", {
          "agent:main:dashboard:active": {
            sessionId: "discovered-session",
            status: "running",
            startedAt: nowMs - 100,
            updatedAt: nowMs - 50,
            restartRecoveryRuns: [{ runId: "run-discovered", lifecycleGeneration: "boot-1" }],
          },
        });

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs,
        });
        const entries = await listArchiveEntries(result.archivePath);
        const archivedStoreEntry = entries.find((entry) =>
          entry.endsWith("/state/agents/main/sessions/sessions.json"),
        );
        expect(archivedStoreEntry).toBeDefined();

        await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
        const archivedStore = JSON.parse(
          await fs.readFile(path.join(extractDir, archivedStoreEntry!), "utf8"),
        ) as Record<string, Record<string, unknown>>;
        expect(archivedStore["agent:main:dashboard:active"]).toMatchObject({
          sessionId: "discovered-session",
          status: "killed",
          endedAt: nowMs,
          updatedAt: nowMs,
        });
      },
    );
  });

  it("sanitizes a valid custom session store from otherwise invalid config", async () => {
    const externalRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-backup-invalid-config-custom-store-"),
    );
    try {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-backup-invalid-config-custom-store-state-",
          scenario: "minimal",
          env: { OPENCLAW_OAUTH_DIR: externalRoot },
        },
        async (state) => {
          const outputDir = state.path("backups");
          const extractDir = state.path("extract");
          const storeTemplate = path.join(
            externalRoot,
            "agents",
            "{agentId}",
            "sessions",
            "sessions.json",
          );
          const storePath = path.join(externalRoot, "agents", "ops", "sessions", "sessions.json");
          const nowMs = Date.UTC(2026, 4, 9, 8, 46, 30);
          const sourceStore = {
            "agent:ops:dashboard:active": {
              sessionId: "custom-store-session",
              status: "running",
              startedAt: nowMs - 100,
              updatedAt: nowMs - 50,
              abortedLastRun: true,
              restartRecoveryRuns: [{ runId: "run-custom", lifecycleGeneration: "boot-1" }],
            },
          };
          await fs.mkdir(outputDir, { recursive: true });
          await fs.mkdir(extractDir, { recursive: true });
          await fs.mkdir(path.dirname(storePath), { recursive: true });
          await fs.writeFile(storePath, `${JSON.stringify(sourceStore, null, 2)}\n`, "utf8");
          await state.writeConfig({
            gateway: { port: "invalid" },
            agents: { list: [{ id: "ops", default: true }] },
            session: { store: storeTemplate },
          });

          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs,
          });
          const entries = await listArchiveEntries(result.archivePath);
          const archivedStoreEntries = entries.filter((entry) =>
            entry.endsWith("/agents/ops/sessions/sessions.json"),
          );
          expect(archivedStoreEntries).toHaveLength(1);

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const archivedStore = JSON.parse(
            await fs.readFile(path.join(extractDir, archivedStoreEntries[0]!), "utf8"),
          ) as Record<string, Record<string, unknown>>;
          expect(archivedStore["agent:ops:dashboard:active"]).toEqual({
            sessionId: "custom-store-session",
            status: "killed",
            startedAt: nowMs - 100,
            endedAt: nowMs,
            updatedAt: nowMs,
            abortedLastRun: false,
          });
          expect(JSON.parse(await fs.readFile(storePath, "utf8"))).toEqual(sourceStore);
        },
      );
    } finally {
      await fs.rm(externalRoot, { recursive: true, force: true });
    }
  });

  it("rejects configured session stores that escape through symlinked parents", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-symlinked-session-parent-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const externalDir = state.path("external-session-store");
        const linkedDir = state.statePath("linked-session-store");
        const linkedStorePath = path.join(linkedDir, "sessions.json");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(externalDir, { recursive: true });
        await fs.writeFile(
          path.join(externalDir, "sessions.json"),
          `${JSON.stringify({
            "agent:main:dashboard:active": {
              sessionId: "external-session",
              status: "running",
              marker: "must-not-enter-backup",
            },
          })}\n`,
          "utf8",
        );
        await fs.symlink(externalDir, linkedDir);
        await state.writeConfig({ session: { store: linkedStorePath } });

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 47, 0),
          }),
        ).rejects.toThrow(/Session store is outside the backup assets/);
        expect(await fs.readdir(outputDir)).toEqual([]);
        expect(await fs.readFile(path.join(externalDir, "sessions.json"), "utf8")).toContain(
          "must-not-enter-backup",
        );
      },
    );
  });

  it("rejects a session store parent that escapes after canonicalization", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-session-rebind-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const sessionSlot = state.statePath("session-slot");
        const storePath = path.join(sessionSlot, "sessions.json");
        const externalDir = state.path("external-session-store");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(sessionSlot, { recursive: true });
        await fs.mkdir(externalDir, { recursive: true });
        await fs.writeFile(
          storePath,
          `${JSON.stringify({
            "agent:main:dashboard:completed": {
              sessionId: "safe-session",
              status: "done",
            },
          })}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(externalDir, "sessions.json"),
          `${JSON.stringify({
            "agent:main:dashboard:active": {
              sessionId: "external-session",
              status: "running",
              marker: "must-not-enter-backup",
            },
          })}\n`,
          "utf8",
        );
        await state.writeConfig({ session: { store: storePath } });

        await withRealpathSymlinkRebindRace({
          shouldFlip: (realpathInput) => path.resolve(realpathInput) === storePath,
          symlinkPath: sessionSlot,
          symlinkTarget: externalDir,
          timing: "after-realpath",
          run: async () => {
            await expect(
              createBackupArchive({
                output: outputDir,
                includeWorkspace: false,
                nowMs: Date.UTC(2026, 4, 9, 8, 47, 30),
              }),
            ).rejects.toThrow(/Session store cannot be snapshotted for backup/);
          },
        });
        expect(await fs.readdir(outputDir)).toEqual([]);
        expect(await fs.readFile(path.join(externalDir, "sessions.json"), "utf8")).toContain(
          "must-not-enter-backup",
        );
      },
    );
  });

  it("sanitizes a configured state session store reached through a symlink alias", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-session-store-alias-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const stateAlias = state.path("state-alias");
        const storePath = state.statePath("custom-sessions.json");
        const aliasedStorePath = path.join(stateAlias, "custom-sessions.json");
        const nowMs = Date.UTC(2026, 4, 9, 8, 48, 0);
        const sourceStore = {
          "agent:main:dashboard:active": {
            sessionId: "session-through-state-alias",
            status: "running",
            startedAt: nowMs - 1_000,
            updatedAt: nowMs - 100,
            abortedLastRun: true,
            restartRecoveryRuns: [{ runId: "run-alias", lifecycleGeneration: "boot-1" }],
            pendingFinalDelivery: true,
            pendingFinalDeliveryText: "stale reply",
            keep: "session metadata",
          },
        };
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        await fs.writeFile(storePath, `${JSON.stringify(sourceStore, null, 2)}\n`, "utf8");
        await fs.symlink(state.stateDir, stateAlias);
        await state.writeConfig({ session: { store: aliasedStorePath } });
        const { db } = openOpenClawStateDatabase({ env: state.env });
        insertMainRunRecoveryFixture({ db, runId: "run-alias", storePath: aliasedStorePath });

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs,
          });
          const entries = await listArchiveEntries(result.archivePath);
          const archivedStoreEntries = entries.filter((entry) =>
            entry.endsWith("/state/custom-sessions.json"),
          );
          expect(archivedStoreEntries).toHaveLength(1);

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const archivedStore = JSON.parse(
            await fs.readFile(path.join(extractDir, archivedStoreEntries[0]!), "utf8"),
          ) as Record<string, Record<string, unknown>>;
          expect(archivedStore["agent:main:dashboard:active"]).toEqual({
            sessionId: "session-through-state-alias",
            status: "killed",
            startedAt: nowMs - 1_000,
            endedAt: nowMs,
            updatedAt: nowMs,
            abortedLastRun: false,
            keep: "session metadata",
          });
          expect(JSON.parse(await fs.readFile(storePath, "utf8"))).toEqual(sourceStore);
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("rejects a late agent store under a configured external template root", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-late-template-session-store-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const agentStoresRoot = path.join(state.workspaceDir, "session-roots", "agents");
        const storePath = path.join(agentStoresRoot, "main", "sessions", "sessions.json");
        const lateStorePath = path.join(agentStoresRoot, "late-agent", "sessions", "sessions.json");
        const nowMs = Date.UTC(2026, 4, 9, 8, 49, 0);
        const lateSourceStore = {
          "agent:late-agent:dashboard:active": {
            sessionId: "late-external-template-session",
            status: "running",
            startedAt: nowMs - 100,
            updatedAt: nowMs - 10,
            abortedLastRun: true,
            restartRecoveryRuns: [{ runId: "run-late-template", lifecycleGeneration: "boot-2" }],
          },
        };
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(path.dirname(storePath), { recursive: true });
        await fs.writeFile(
          storePath,
          `${JSON.stringify({
            "agent:main:dashboard:completed": {
              sessionId: "session-main",
              status: "done",
              updatedAt: nowMs - 1_000,
            },
          })}\n`,
          "utf8",
        );
        await state.writeConfig({
          agents: {
            list: [{ id: "main", default: true, workspace: state.workspaceDir }],
          },
          session: {
            store: path.join(
              state.workspaceDir,
              "session-roots",
              "agents",
              "{agentId}",
              "sessions",
              "sessions.json",
            ),
          },
        });
        openOpenClawStateDatabase({ env: state.env });

        const originalReadFile = fs.readFile.bind(fs);
        let injectedLateStore = false;
        const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation((async (...args) => {
          const result = await originalReadFile(...args);
          const filePath = args[0];
          if (
            !injectedLateStore &&
            ((typeof filePath === "string" && path.resolve(filePath) === path.resolve(storePath)) ||
              isFileHandleRead(filePath))
          ) {
            injectedLateStore = true;
            await fs.mkdir(path.dirname(lateStorePath), { recursive: true });
            await fs.writeFile(lateStorePath, `${JSON.stringify(lateSourceStore)}\n`, "utf8");
          }
          return result;
        }) as typeof fs.readFile);

        try {
          await expect(
            createBackupArchive({
              output: outputDir,
              includeWorkspace: true,
              nowMs,
            }),
          ).rejects.toThrow(/Session store appeared after snapshot discovery/);
          expect(injectedLateStore).toBe(true);
          expect(await fs.readdir(outputDir)).toEqual([]);
          expect(JSON.parse(await originalReadFile(lateStorePath, "utf8"))).toEqual(
            lateSourceStore,
          );
        } finally {
          readFileSpy.mockRestore();
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("sanitizes restart state when an ancestor workspace covers the state root", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-covered-state-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-output-"));
        const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-extract-"));
        const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
        const nowMs = Date.UTC(2026, 4, 9, 8, 49, 30);
        const sourceStore = {
          "agent:main:dashboard:active": {
            sessionId: "session-under-covered-state",
            status: "running",
            startedAt: nowMs - 1_000,
            updatedAt: nowMs - 100,
            abortedLastRun: true,
            restartRecoveryRuns: [{ runId: "run-covered-state", lifecycleGeneration: "boot-1" }],
            pendingFinalDelivery: true,
            pendingFinalDeliveryText: "stale reply",
            keep: "session metadata",
          },
        };
        await state.writeConfig({
          agents: {
            list: [{ id: "main", default: true, workspace: state.root }],
          },
        });
        await state.writeJson("agents/main/sessions/sessions.json", sourceStore);
        const { db } = openOpenClawStateDatabase({ env: state.env });
        insertMainRunRecoveryFixture({ db, runId: "run-covered-state", storePath });

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: true,
            nowMs,
          });
          expect(result.assets.some((asset) => asset.kind === "state")).toBe(false);
          expect(
            result.assets.some(
              (asset) =>
                asset.kind === "workspace" && path.resolve(asset.sourcePath) === state.root,
            ),
          ).toBe(true);
          const entries = await listArchiveEntries(result.archivePath);
          const archivedDbEntry = entries.find((entry) =>
            entry.endsWith("/state/state/openclaw.sqlite"),
          );
          const archivedStoreEntry = entries.find((entry) =>
            entry.endsWith("/state/agents/main/sessions/sessions.json"),
          );
          expect(archivedDbEntry).toBeDefined();
          expect(archivedStoreEntry).toBeDefined();

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const sqlite = requireNodeSqlite();
          const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, archivedDbEntry!), {
            readOnly: true,
          });
          try {
            expect(
              archivedDb.prepare("SELECT COUNT(*) AS count FROM main_run_recoveries").get(),
            ).toEqual({ count: 0 });
          } finally {
            archivedDb.close();
          }
          const archivedStore = JSON.parse(
            await fs.readFile(path.join(extractDir, archivedStoreEntry!), "utf8"),
          ) as Record<string, Record<string, unknown>>;
          expect(archivedStore["agent:main:dashboard:active"]).toEqual({
            sessionId: "session-under-covered-state",
            status: "killed",
            startedAt: nowMs - 1_000,
            endedAt: nowMs,
            updatedAt: nowMs,
            abortedLastRun: false,
            keep: "session metadata",
          });
          expect(db.prepare("SELECT COUNT(*) AS count FROM main_run_recoveries").get()).toEqual({
            count: 1,
          });
          expect(JSON.parse(await fs.readFile(storePath, "utf8"))).toEqual(sourceStore);
        } finally {
          closeOpenClawStateDatabase();
          await fs.rm(outputDir, { recursive: true, force: true });
          await fs.rm(extractDir, { recursive: true, force: true });
        }
      },
    );
  });

  it("rejects a new agent session store that appears after store discovery", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-late-session-store-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
        const lateStorePath = state.statePath("agents", "late-agent", "sessions", "sessions.json");
        const nowMs = Date.UTC(2026, 4, 9, 8, 50, 0);
        const lateSourceStore = {
          "agent:late-agent:dashboard:active": {
            sessionId: "session-created-after-store-discovery",
            status: "running",
            startedAt: nowMs - 100,
            updatedAt: nowMs - 10,
            abortedLastRun: true,
            restartRecoveryRuns: [{ runId: "run-late", lifecycleGeneration: "boot-2" }],
          },
        };
        await fs.mkdir(outputDir, { recursive: true });
        await state.writeJson("agents/main/sessions/sessions.json", {
          "agent:main:dashboard:completed": {
            sessionId: "session-main",
            status: "done",
            updatedAt: nowMs - 1_000,
          },
        });
        openOpenClawStateDatabase({ env: state.env });

        const originalReadFile = fs.readFile.bind(fs);
        let injectedLateStore = false;
        const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation((async (...args) => {
          const result = await originalReadFile(...args);
          const filePath = args[0];
          if (
            !injectedLateStore &&
            ((typeof filePath === "string" && path.resolve(filePath) === path.resolve(storePath)) ||
              isFileHandleRead(filePath))
          ) {
            injectedLateStore = true;
            await state.writeJson("agents/late-agent/sessions/sessions.json", lateSourceStore);
          }
          return result;
        }) as typeof fs.readFile);

        try {
          await expect(
            createBackupArchive({
              output: outputDir,
              includeWorkspace: false,
              nowMs,
            }),
          ).rejects.toThrow(/Session store appeared after snapshot discovery/);
          expect(injectedLateStore).toBe(true);
          expect(await fs.readdir(outputDir)).toEqual([]);
          expect(JSON.parse(await originalReadFile(lateStorePath, "utf8"))).toEqual(
            lateSourceStore,
          );
        } finally {
          readFileSpy.mockRestore();
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("snapshots per-agent SQLite auth stores without deleted secret pages", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-agent-sqlite-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                key: "sk-backup",
              },
            },
          },
          state.agentDir(),
          { syncExternalCli: false },
        );
        closeOpenClawAgentDatabasesForTest();
        const sqlite = requireNodeSqlite();
        const liveDbPath = path.join(state.agentDir(), "openclaw-agent.sqlite");
        const deletedSecretMarker = "OPENCLAW_DELETED_SECRET_PAGE_MARKER";
        const deletedSecret = `${deletedSecretMarker}-${"x".repeat(16_384)}`;
        const liveDb = new sqlite.DatabaseSync(liveDbPath);
        try {
          liveDb.exec("PRAGMA secure_delete = OFF; CREATE TABLE deleted_secrets (value TEXT)");
          liveDb.prepare("INSERT INTO deleted_secrets (value) VALUES (?)").run(deletedSecret);
          liveDb
            .prepare("INSERT INTO deleted_secrets (value) VALUES (?)")
            .run(`keeper-${"y".repeat(16_384)}`);
          liveDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          liveDb.prepare("DELETE FROM deleted_secrets WHERE value = ?").run(deletedSecret);
        } finally {
          liveDb.close();
        }
        expect((await fs.readFile(liveDbPath)).includes(Buffer.from(deletedSecretMarker))).toBe(
          true,
        );

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 9, 8, 31, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);
        const archivedDbEntry = entries.find((entry) =>
          entry.endsWith("/state/agents/main/agent/openclaw-agent.sqlite"),
        );
        expect(archivedDbEntry).toBeDefined();
        expect(
          entries.some((entry) =>
            entry.endsWith("/state/agents/main/agent/openclaw-agent.sqlite-wal"),
          ),
        ).toBe(false);

        await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
        const extractedPath = path.join(extractDir, archivedDbEntry!);
        expect((await fs.stat(extractedPath)).mode & 0o777).toBe(0o600);
        expect((await fs.readFile(extractedPath)).includes(Buffer.from(deletedSecretMarker))).toBe(
          false,
        );
        const archivedDb = new sqlite.DatabaseSync(extractedPath, {
          readOnly: true,
        });
        try {
          const row = archivedDb
            .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'")
            .get() as { store_json: string };
          expect(JSON.parse(row.store_json).profiles["openai:default"]).toMatchObject({
            type: "api_key",
            provider: "openai",
            key: "sk-backup",
          });
        } finally {
          archivedDb.close();
        }
      },
    );
  });

  it("snapshots nested live SQLite databases with transaction continuity", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-nested-sqlite-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const dbPath = state.statePath("plugins", "dedicated", "live.sqlite");
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        const sqlite = requireNodeSqlite();
        const db = new sqlite.DatabaseSync(dbPath);
        db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          CREATE TABLE backup_meta (
            id INTEGER PRIMARY KEY,
            last_seq INTEGER NOT NULL
          );
          CREATE TABLE backup_markers (
            seq INTEGER PRIMARY KEY,
            transaction_id INTEGER NOT NULL
          );
          CREATE TABLE delivery_queue_entries (
            id TEXT PRIMARY KEY
          );
          INSERT INTO backup_meta (id, last_seq) VALUES (1, 0);
          INSERT INTO delivery_queue_entries (id) VALUES ('must-stay');
          PRAGMA wal_checkpoint(TRUNCATE);
          BEGIN IMMEDIATE;
          INSERT INTO backup_markers (seq, transaction_id) VALUES (1, 7), (2, 7), (3, 7);
          UPDATE backup_meta SET last_seq = 3 WHERE id = 1;
          COMMIT;
        `);
        await fs.writeFile(`${dbPath}-journal`, "");

        try {
          await expect(fs.access(`${dbPath}-wal`)).resolves.toBeUndefined();
          await expect(fs.access(`${dbPath}-shm`)).resolves.toBeUndefined();
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 32, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const archivedDbEntries = entries.filter((entry) =>
            entry.endsWith("/state/plugins/dedicated/live.sqlite"),
          );
          expect(archivedDbEntries).toHaveLength(1);
          for (const suffix of ["-wal", "-shm", "-journal"]) {
            expect(
              entries.some((entry) =>
                entry.endsWith(`/state/plugins/dedicated/live.sqlite${suffix}`),
              ),
              suffix,
            ).toBe(false);
          }

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, archivedDbEntries[0]), {
            readOnly: true,
          });
          try {
            expect(archivedDb.prepare("PRAGMA integrity_check").get()).toEqual({
              integrity_check: "ok",
            });
            expect(
              archivedDb.prepare("SELECT last_seq FROM backup_meta WHERE id = 1").get(),
            ).toEqual({ last_seq: 3 });
            expect(
              archivedDb
                .prepare(
                  "SELECT COUNT(*) AS count, MIN(seq) AS min_seq, MAX(seq) AS max_seq FROM backup_markers",
                )
                .get(),
            ).toEqual({ count: 3, min_seq: 1, max_seq: 3 });
            expect(
              archivedDb.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
            ).toEqual({ count: 1 });
          } finally {
            archivedDb.close();
          }
        } finally {
          db.close();
        }
      },
    );
  });

  it("fails instead of raw-copying malformed nested SQLite databases", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-malformed-sqlite-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const dbPath = state.statePath("plugins", "dedicated", "malformed.sqlite");
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(dbPath, "not a sqlite database", "utf8");

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 33, 0),
          }),
        ).rejects.toThrow(/file is not a database|malformed/i);
      },
    );
  });

  it.each(["late.sqlite", "late.sqlite-wal"])(
    "fails when SQLite-looking state appears after snapshot discovery: %s",
    async (lateName) => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-backup-late-sqlite-",
          scenario: "minimal",
        },
        async (state) => {
          const outputDir = state.path("backups");
          const latePath = state.statePath(lateName);
          await fs.mkdir(outputDir, { recursive: true });

          const originalReaddir = fs.readdir.bind(fs);
          let createdLatePath = false;
          const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation((async (
            ...args: unknown[]
          ) => {
            const entries = await (
              originalReaddir as (...readdirArgs: unknown[]) => Promise<unknown>
            )(...args);
            if (
              !createdLatePath &&
              path.resolve(String(args[0])) === path.resolve(state.stateDir)
            ) {
              createdLatePath = true;
              await fs.writeFile(latePath, "late SQLite state");
            }
            return entries;
          }) as typeof fs.readdir);

          try {
            await expect(
              createBackupArchive({
                output: outputDir,
                includeWorkspace: false,
                nowMs: Date.UTC(2026, 4, 9, 8, 33, 30),
              }),
            ).rejects.toThrow(/SQLite state appeared after snapshot discovery/);
            expect(createdLatePath).toBe(true);
            expect(await fs.readdir(outputDir)).toEqual([]);
          } finally {
            readdirSpy.mockRestore();
          }
        },
      );
    },
  );

  it("omits pre-existing orphan SQLite sidecars without failing backup", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-orphan-sqlite-sidecars-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const orphanPath = state.statePath("plugins", "dedicated", "orphan.sqlite");
        await fs.mkdir(path.dirname(orphanPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          await fs.writeFile(`${orphanPath}${suffix}`, "orphan SQLite sidecar");
        }

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 9, 8, 33, 45),
        });
        const entries = await listArchiveEntries(result.archivePath);
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          expect(
            entries.some((entry) =>
              entry.endsWith(`/state/plugins/dedicated/orphan.sqlite${suffix}`),
            ),
            suffix,
          ).toBe(false);
        }
      },
    );
  });

  it("omits transient memory reindex databases and sidecars", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-memory-reindex-lock-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const transientPaths = [
          state.statePath("memory", "main.sqlite.reindex-lock.sqlite"),
          state.statePath("memory", "main.sqlite.tmp-11111111-2222-3333-4444-555555555555"),
          state.statePath("memory", "main.sqlite.backup-66666666-7777-8888-9999-aaaaaaaaaaaa"),
          state.statePath(
            "agents",
            "main",
            "agent.sqlite.memory-reindex-bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
          ),
        ];
        await fs.mkdir(outputDir, { recursive: true });
        for (const transientPath of transientPaths) {
          await fs.mkdir(path.dirname(transientPath), { recursive: true });
          for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            await fs.writeFile(`${transientPath}${suffix}`, "transient reindex database");
          }
        }

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 9, 8, 34, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);
        for (const transientPath of transientPaths) {
          const relativeTransientPath = path
            .relative(state.stateDir, transientPath)
            .split(path.sep)
            .join("/");
          for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            expect(
              entries.some((entry) => entry.endsWith(`/state/${relativeTransientPath}${suffix}`)),
              `${relativeTransientPath}${suffix}`,
            ).toBe(false);
          }
        }
      },
    );
  });

  it("preserves noncanonical symlinked SQLite paths without dereferencing them", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-symlinked-sqlite-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const externalDbPath = state.path("external-malformed.sqlite");
        const linkedDbPath = state.statePath("plugins", "dedicated", "linked.sqlite");
        await fs.mkdir(path.dirname(linkedDbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(externalDbPath, "not a sqlite database", "utf8");
        await fs.symlink(externalDbPath, linkedDbPath);

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 9, 8, 34, 0),
        });
        const entries = await listArchiveEntryDetails(result.archivePath);
        expect(
          entries.find((entry) => entry.path.endsWith("/state/plugins/dedicated/linked.sqlite")),
        ).toMatchObject({ type: "SymbolicLink" });
      },
    );
  });

  it("snapshots the canonical global SQLite symlink as a complete regular file", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-global-sqlite-symlink-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const externalDbPath = path.join(state.workspaceDir, "external-global.sqlite");
        const linkedDbPath = state.statePath("state", "openclaw.sqlite");
        await state.writeConfig({
          agents: {
            list: [{ id: "main", default: true, workspace: state.workspaceDir }],
          },
        });
        await fs.mkdir(path.dirname(linkedDbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        const sqlite = requireNodeSqlite();
        const db = new sqlite.DatabaseSync(externalDbPath);
        db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          CREATE TABLE durable_state (
            id INTEGER PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE delivery_queue_entries (
            id TEXT PRIMARY KEY
          );
          PRAGMA wal_checkpoint(TRUNCATE);
          INSERT INTO durable_state (id, value) VALUES (1, 'must-stay');
          INSERT INTO delivery_queue_entries (id) VALUES ('must-drop');
        `);
        await fs.symlink(externalDbPath, linkedDbPath);

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: true,
            nowMs: Date.UTC(2026, 4, 9, 8, 34, 30),
          });
          const entries = await listArchiveEntryDetails(result.archivePath);
          const archivedDbEntries = entries.filter((entry) =>
            entry.path.endsWith("/state/state/openclaw.sqlite"),
          );
          expect(archivedDbEntries).toEqual([
            expect.objectContaining({
              type: "File",
            }),
          ]);
          for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            expect(
              entries.some((entry) =>
                entry.path.endsWith(`/workspace/external-global.sqlite${suffix}`),
              ),
              suffix || "database",
            ).toBe(false);
          }

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const archivedDb = new sqlite.DatabaseSync(
            path.join(extractDir, archivedDbEntries[0].path),
            { readOnly: true },
          );
          try {
            expect(archivedDb.prepare("PRAGMA integrity_check").get()).toEqual({
              integrity_check: "ok",
            });
            expect(
              archivedDb.prepare("SELECT value FROM durable_state WHERE id = 1").get(),
            ).toEqual({ value: "must-stay" });
            expect(
              archivedDb.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
            ).toEqual({ count: 0 });
          } finally {
            archivedDb.close();
          }

          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
          expect(verification.ok).toBe(true);
        } finally {
          db.close();
        }
      },
    );
  });

  it("fails when the canonical global SQLite path is not a file", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-global-sqlite-directory-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const globalDbPath = state.statePath("state", "openclaw.sqlite");
        await fs.mkdir(globalDbPath, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 34, 45),
          }),
        ).rejects.toThrow(/Canonical global SQLite path must be a regular file or symlink/);
        expect(await fs.readdir(outputDir)).toEqual([]);
      },
    );
  });

  it("omits installed plugin node_modules from the real archive while keeping plugin files", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-plugin-deps-",
        scenario: "minimal",
      },
      async (state) => {
        const stateDir = state.stateDir;
        const outputDir = state.path("backups");
        await fs.mkdir(path.join(stateDir, "extensions", "demo", "node_modules", "dep"), {
          recursive: true,
        });
        await fs.mkdir(path.join(stateDir, "extensions", "demo", "src"), { recursive: true });
        await fs.mkdir(path.join(stateDir, "node_modules", "root-dep"), { recursive: true });
        await fs.mkdir(path.join(stateDir, "npm", "projects", "demo", "node_modules", "dep"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "openclaw.plugin.json"),
          '{"id":"demo"}\n',
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "src", "index.js"),
          "export default {}\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "node_modules", "dep", "index.js"),
          "module.exports = {}\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "node_modules", "dep", "cache.sqlite"),
          "not a sqlite database",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "node_modules", "root-dep", "index.js"),
          "module.exports = {}\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "node_modules", "root-dep", "fixture.sqlite"),
          "package-owned sqlite-named asset\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "npm", "projects", "demo", "node_modules", "dep", "fixture.sqlite"),
          "managed-package sqlite-named asset\n",
          "utf8",
        );
        await fs.mkdir(outputDir, { recursive: true });

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 3, 28, 12, 0, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);

        const entrySuffixes = entries.map((entry) => entry.replace(/^.*\/state\//, "/state/"));
        expect(entrySuffixes).toContain("/state/extensions/demo/openclaw.plugin.json");
        expect(entrySuffixes).toContain("/state/extensions/demo/src/index.js");
        expect(entrySuffixes).toContain("/state/node_modules/root-dep/index.js");
        expect(entrySuffixes).toContain("/state/node_modules/root-dep/fixture.sqlite");
        expect(entrySuffixes).toContain("/state/npm/projects/demo/node_modules/dep/fixture.sqlite");
        const pluginNodeModuleEntries = entries.filter((entry) =>
          entry.includes("/state/extensions/demo/node_modules/"),
        );
        expect(pluginNodeModuleEntries).toStrictEqual([]);

        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
        expect(verification.ok).toBe(true);
      },
    );
  });

  it("dereferences hardlinks instead of emitting restore-hostile Link entries", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-hardlink-",
        scenario: "minimal",
      },
      async (state) => {
        const stateDir = state.stateDir;
        const outputDir = state.path("backups");
        const sourcePath = path.join(stateDir, "workspace-adx", "openclaw-src", "node_modules");
        const targetPath = path.join(sourcePath, "esbuild", "bin", "esbuild");
        const hardlinkPath = path.join(sourcePath, "@esbuild", "darwin-arm64", "bin", "esbuild");
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.mkdir(path.dirname(hardlinkPath), { recursive: true });
        await fs.writeFile(targetPath, "binary fixture\n", "utf8");
        await fs.link(targetPath, hardlinkPath);
        await fs.mkdir(outputDir, { recursive: true });

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 3, 29, 12, 0, 0),
        });
        const entries = await listArchiveEntryDetails(result.archivePath);

        expect(entries.filter((entry) => entry.type === "Link")).toStrictEqual([]);
        expect(entries.some((entry) => entry.path.endsWith("/esbuild/bin/esbuild"))).toBe(true);
        expect(
          entries.some((entry) => entry.path.endsWith("/@esbuild/darwin-arm64/bin/esbuild")),
        ).toBe(true);

        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
        expect(verification.ok).toBe(true);
      },
    );
  });

  it("does not duplicate the root manifest when the system tempdir lives inside the state dir", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-tmp-overlap-",
        scenario: "minimal",
      },
      async (state) => {
        const stateDir = state.stateDir;
        const outputDir = state.path("backups");
        const overlappingTmp = path.join(stateDir, "tmp");
        await fs.mkdir(overlappingTmp, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        const tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(overlappingTmp);

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 12, 0, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const rootManifestEntries = entries.filter(
            (entry) => entry.endsWith("/manifest.json") && !entry.includes("/payload/"),
          );
          expect(rootManifestEntries).toHaveLength(1);

          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
          expect(verification.ok).toBe(true);
        } finally {
          tmpdirSpy.mockRestore();
        }
      },
    );
  });

  it("does not duplicate the root manifest when the system tempdir is the state dir itself", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-tmp-equals-state-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const emptyDbPath = state.statePath("plugins", "dedicated", "empty.sqlite");
        const extractDir = state.path("extract");
        await fs.mkdir(path.dirname(emptyDbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        await fs.writeFile(emptyDbPath, "");
        const tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(state.stateDir);

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 12, 0, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const rootManifestEntries = entries.filter(
            (entry) => entry.endsWith("/manifest.json") && !entry.includes("/payload/"),
          );
          expect(rootManifestEntries).toHaveLength(1);
          const emptyDbEntries = entries.filter((entry) =>
            entry.endsWith("/state/plugins/dedicated/empty.sqlite"),
          );
          expect(emptyDbEntries).toHaveLength(1);
          expect(entries.some((entry) => entry.includes("/openclaw-state-db-"))).toBe(false);

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const sqlite = requireNodeSqlite();
          const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, emptyDbEntries[0]), {
            readOnly: true,
          });
          try {
            expect(archivedDb.prepare("PRAGMA integrity_check").get()).toEqual({
              integrity_check: "ok",
            });
          } finally {
            archivedDb.close();
          }

          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
          expect(verification.ok).toBe(true);
        } finally {
          tmpdirSpy.mockRestore();
        }
      },
    );
  });

  describe.runIf(process.platform !== "win32")("archive permissions", () => {
    it.each([
      ["hard link", false],
      ["copy fallback", true],
    ] as const)("publishes via %s with owner-only 0o600 permissions", async (_name, forceCopy) => {
      const linkSpy = forceCopy
        ? vi
            .spyOn(fs, "link")
            .mockRejectedValue(
              Object.assign(new Error("hard links unsupported"), { code: "EPERM" }),
            )
        : undefined;
      try {
        await withOpenClawTestState(
          {
            layout: "state-only",
            prefix: "openclaw-backup-mode-",
            scenario: "minimal",
          },
          async (state) => {
            const outputDir = state.path("backups");
            await fs.mkdir(outputDir, { recursive: true });

            const result = await createBackupArchive({
              output: outputDir,
              includeWorkspace: false,
              nowMs: Date.UTC(2026, 4, 9, 12, 0, 0),
            });

            const stat = await fs.stat(result.archivePath);
            expect(stat.mode & 0o777).toBe(0o600);
          },
        );
      } finally {
        linkSpy?.mockRestore();
      }
    });
  });
});
