// Session path helper tests pin default store path contracts used by CLI commands.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCanonicalSessionStorePathCache,
  resolveCanonicalSessionStorePath,
  resolveSessionFilePath,
  resolveStorePath,
} from "./paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  clearCanonicalSessionStorePathCache();
  vi.restoreAllMocks();
});

describe("resolveSessionFilePath cross-root reroot", () => {
  it("re-roots foreign-root absolute paths when the file exists in the current sessions dir", () => {
    // Restored backups and moved state dirs persist absolute sessionFile
    // paths from the old root; migration must find the local copy.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reroot-")));
    tempDirs.push(root);
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "sess-1.jsonl"), "{}\n", "utf8");
    const foreign = "/nonexistent-old-root/.openclaw/agents/main/sessions/sess-1.jsonl";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: foreign },
      { sessionsDir, agentId: "main" },
    );

    expect(resolved).toBe(path.join(sessionsDir, "sess-1.jsonl"));
  });

  it("keeps foreign-root absolute paths when no local copy exists", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reroot-keep-")));
    tempDirs.push(root);
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const foreign = "/nonexistent-old-root/.openclaw/agents/main/sessions/sess-2.jsonl";

    const resolved = resolveSessionFilePath(
      "sess-2",
      { sessionFile: foreign },
      { sessionsDir, agentId: "main" },
    );

    expect(resolved).toBe(foreign);
  });
});

describe("resolveStorePath", () => {
  it("uses the default agent store when session.store is absent or blank", () => {
    const stateDir = path.join(path.parse(process.cwd()).root, "openclaw-test-state");
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const expected = path.join(stateDir, "agents", "work", "sessions", "sessions.json");

    expect(resolveStorePath(undefined, { agentId: "work", env })).toBe(expected);
    expect(resolveStorePath("", { agentId: "work", env })).toBe(expected);
  });

  it("uses one physical identity for symlinked stores before the leaf exists", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-store-path-")));
    const physical = path.join(root, "physical");
    const alias = path.join(root, "alias");
    fs.mkdirSync(physical);
    fs.symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");

    expect(resolveCanonicalSessionStorePath(path.join(alias, "future", "sessions.json"))).toBe(
      path.join(physical, "future", "sessions.json"),
    );

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves each configured alias once and reuses its canonical identity", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-store-cache-")));
    const physical = path.join(root, "physical");
    const aliasA = path.join(root, "alias-a");
    const aliasB = path.join(root, "alias-b");
    fs.mkdirSync(physical);
    const physicalStore = path.join(physical, "sessions.json");
    fs.writeFileSync(physicalStore, "{}");
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(physical, aliasA, symlinkType);
    fs.symlinkSync(physical, aliasB, symlinkType);
    const realpath = vi.spyOn(fs.realpathSync, "native");

    expect(resolveCanonicalSessionStorePath(path.join(aliasA, "sessions.json"))).toBe(
      physicalStore,
    );
    expect(resolveCanonicalSessionStorePath(path.join(aliasA, "sessions.json"))).toBe(
      physicalStore,
    );
    expect(resolveCanonicalSessionStorePath(path.join(aliasB, "sessions.json"))).toBe(
      physicalStore,
    );
    expect(resolveCanonicalSessionStorePath(path.join(aliasB, "sessions.json"))).toBe(
      physicalStore,
    );
    expect(realpath).toHaveBeenCalledTimes(2);
    clearCanonicalSessionStorePathCache();
    expect(resolveCanonicalSessionStorePath(path.join(aliasA, "sessions.json"))).toBe(
      physicalStore,
    );
    expect(realpath).toHaveBeenCalledTimes(3);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
