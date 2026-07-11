// Tests canonical active-run identity normalization, projection, and alias lookup.
import { describe, expect, it } from "vitest";
import {
  ActiveRunRegistry,
  activeRunIdentityAliases,
  createActiveRunIdentity,
  projectActiveRunIdentity,
  resolveActiveRunByIdentity,
  resolveActiveRunIdentity,
} from "./active-run-registry.js";

describe("active run identity", () => {
  it("uses one id for ordinary runs", () => {
    const identity = createActiveRunIdentity("run-1");

    expect(identity).toEqual({ executionRunId: "run-1", publicRunId: "run-1" });
    expect(activeRunIdentityAliases(identity)).toEqual(["run-1"]);
    expect(projectActiveRunIdentity(identity)).toEqual({ runId: "run-1" });
  });

  it("projects recovered runs only under their public id", () => {
    const identity = createActiveRunIdentity("private-dispatch", "public-admission");

    expect(activeRunIdentityAliases(identity)).toEqual(["private-dispatch", "public-admission"]);
    expect(projectActiveRunIdentity(identity)).toEqual({ runId: "public-admission" });
    expect(JSON.stringify(projectActiveRunIdentity(identity))).not.toContain("private-dispatch");
  });

  it("treats the registry key as the execution capability", () => {
    expect(
      resolveActiveRunIdentity("current-dispatch", {
        runIdentity: createActiveRunIdentity("stale-dispatch", "public-admission"),
      }),
    ).toEqual({ executionRunId: "current-dispatch", publicRunId: "public-admission" });
  });

  it("owns stable source and public indexes", () => {
    const entry = {
      runIdentity: createActiveRunIdentity("private-dispatch", "public-admission"),
    };
    const registry = new ActiveRunRegistry<typeof entry>();
    registry.set("private-dispatch", entry);

    expect(registry.get("private-dispatch")).toBe(entry);
    expect(registry.get("public-admission")).toBe(entry);
    expect(registry.resolve("public-admission")?.identity).toEqual(entry.runIdentity);
    expect(registry.delete("public-admission")).toBe(true);
    expect(registry.has("private-dispatch")).toBe(false);
  });

  it("rejects public aliases that collide with another execution id", () => {
    const registry = new ActiveRunRegistry<{
      runIdentity: ReturnType<typeof createActiveRunIdentity>;
    }>();
    registry.set("public-admission", {
      runIdentity: createActiveRunIdentity("public-admission"),
    });

    expect(() =>
      registry.set("private-dispatch", {
        runIdentity: createActiveRunIdentity("private-dispatch", "public-admission"),
      }),
    ).toThrow("active run public id is already registered");
    expect(resolveActiveRunByIdentity(registry, "public-admission")?.identity).toEqual(
      createActiveRunIdentity("public-admission"),
    );
  });
});
