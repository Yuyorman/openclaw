// Tests lifecycle/work admission ordering across canonical keys and backing ids.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { clearCanonicalSessionStorePathCache } from "../config/sessions/paths.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  beginSessionWorkAdmission,
  collectActiveSessionWorkAdmissionIdentities,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
  hasOnlySessionLifecycleMutationKindActive,
  interruptSessionWorkAdmissions,
  isSessionWorkAdmissionActive,
  registerSessionWorkAdmissionBarrier,
  runExclusiveSessionLifecycleMutation,
  SessionWorkAdmissionBlockedError,
} from "./session-lifecycle-admission.js";

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

it("counts one multi-identity admission once", async () => {
  const admission = await beginSessionWorkAdmission({
    scope: "store-count",
    identities: ["agent:main:child", "session-count"],
    assertAllowed: () => {},
  });
  try {
    expect(getActiveSessionWorkAdmissionCount()).toBe(1);
  } finally {
    admission.release();
  }
  expect(getActiveSessionWorkAdmissionCount()).toBe(0);
});

it("counts one multi-identity lifecycle mutation once across module instances", async () => {
  const first = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=session-mutation-count-a",
  );
  const second = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=session-mutation-count-b",
  );
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = first.runExclusiveSessionLifecycleMutation({
    scope: "store-mutation-count",
    identities: ["agent:main:child", "session-mutation-count"],
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;

  try {
    expect(first.getActiveSessionLifecycleMutationCount()).toBe(1);
    expect(second.getActiveSessionLifecycleMutationCount()).toBe(1);
  } finally {
    releaseMutation.resolve();
    await mutation;
  }
  expect(second.getActiveSessionLifecycleMutationCount()).toBe(0);
});

it("rejects an admission that resumes after suspension closes the async gap", async () => {
  resetGatewayWorkAdmission();
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation({
    scope: "store-suspend-race",
    identities: ["session-suspend-race", "backing-suspend-race"],
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;
  expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0);

  const admission = beginSessionWorkAdmission({
    scope: "store-suspend-race",
    identities: ["session-suspend-race", "backing-suspend-race"],
    assertAllowed: () => {},
  });
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  releaseMutation.resolve();
  await mutation;
  expect(getActiveSessionLifecycleMutationCount()).toBe(0);

  await expect(admission).rejects.toMatchObject({ name: "GatewayDrainingError" });
  expect(getActiveSessionWorkAdmissionCount()).toBe(0);
  suspension?.release();
  resetGatewayWorkAdmission();
});

it("lets an admitted root enter session work while suspension preparation refuses new roots", async () => {
  resetGatewayWorkAdmission();
  const continueRoot = createDeferred();
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  const active = root?.run(async () => {
    await continueRoot.promise;
    const admission = await beginSessionWorkAdmission({
      scope: "store-admitted-root",
      identities: ["session-admitted-root"],
      assertAllowed: () => {},
    });
    admission.release();
  });
  const suspension = tryBeginGatewaySuspendAdmission(() => {});

  try {
    continueRoot.resolve();
    await expect(active).resolves.toBeUndefined();
    await expect(
      beginSessionWorkAdmission({
        scope: "store-new-root",
        identities: ["session-new-root"],
        assertAllowed: () => {},
      }),
    ).rejects.toMatchObject({ name: "GatewayDrainingError" });
  } finally {
    suspension?.rollback();
    root?.release();
    resetGatewayWorkAdmission();
  }
});

it("registers active work before waiting for the store writer barrier", async () => {
  const storePath = "store-writer-barrier";
  const writerStarted = createDeferred();
  const releaseWriter = createDeferred();
  const firstValidation = createDeferred();
  let validationCount = 0;
  const writer = runExclusiveSessionStoreWrite(storePath, async () => {
    writerStarted.resolve();
    await releaseWriter.promise;
  });
  await writerStarted.promise;

  const admissionPromise = beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:child", "session-writer-barrier"],
    assertAllowed: () => {
      validationCount += 1;
      if (validationCount === 1) {
        firstValidation.resolve();
      }
    },
  });
  await firstValidation.promise;
  await Promise.resolve();

  expect(isSessionWorkAdmissionActive(storePath, ["session-writer-barrier"])).toBe(true);

  releaseWriter.resolve();
  const admission = await admissionPromise;
  try {
    expect(validationCount).toBe(2);
  } finally {
    admission.release();
    await writer;
  }
});

it("serializes writer revalidation across physical store aliases", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-writer-alias-")));
  const physical = path.join(root, "physical");
  const aliasA = path.join(root, "alias-a");
  const aliasB = path.join(root, "alias-b");
  fs.mkdirSync(physical);
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(physical, aliasA, symlinkType);
  fs.symlinkSync(physical, aliasB, symlinkType);
  fs.writeFileSync(path.join(physical, "sessions.json"), "{}");
  const storeA = path.join(aliasA, "sessions.json");
  const storeB = path.join(aliasB, "sessions.json");
  const writerStarted = createDeferred();
  const releaseWriter = createDeferred();
  const initialValidated = createDeferred();
  const revalidationStarted = createDeferred();
  const releaseRevalidation = createDeferred();
  const order: string[] = [];
  const writer = runExclusiveSessionStoreWrite(storeA, async () => {
    order.push("writer:start");
    writerStarted.resolve();
    await releaseWriter.promise;
    order.push("writer:end");
  });
  await writerStarted.promise;

  const admissionPromise = beginSessionWorkAdmission({
    scope: storeB,
    identities: ["session-writer-physical-alias"],
    assertAllowed: () => {
      order.push("initial");
      initialValidated.resolve();
    },
    revalidateAllowed: async () => {
      order.push("revalidate");
      revalidationStarted.resolve();
      await releaseRevalidation.promise;
    },
  });
  let admission: Awaited<typeof admissionPromise> | undefined;

  try {
    await initialValidated.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["writer:start", "initial"]);

    releaseWriter.resolve();
    await writer;
    await revalidationStarted.promise;
    releaseRevalidation.resolve();
    admission = await admissionPromise;
    expect(order).toEqual(["writer:start", "initial", "writer:end", "revalidate"]);
  } finally {
    releaseWriter.resolve();
    releaseRevalidation.resolve();
    const [, admissionResult] = await Promise.allSettled([writer, admissionPromise]);
    const settledAdmission =
      admissionResult.status === "fulfilled" ? admissionResult.value : undefined;
    (admission ?? settledAdmission)?.release();
    clearCanonicalSessionStorePathCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("revalidates inline when admission begins inside the active store writer", async () => {
  const storePath = "store-writer-reentrant-admission";
  const order: string[] = [];
  const admission = await runExclusiveSessionStoreWrite(storePath, async () => {
    order.push("writer:start");
    const lease = await beginSessionWorkAdmission({
      scope: storePath,
      identities: ["session-writer-reentrant-admission"],
      assertAllowed: () => {
        order.push("validate");
      },
    });
    order.push("writer:end");
    return lease;
  });

  try {
    expect(order).toEqual(["writer:start", "validate", "validate", "writer:end"]);
    expect(isSessionWorkAdmissionActive(storePath, ["session-writer-reentrant-admission"])).toBe(
      true,
    );
  } finally {
    admission.release();
  }
});

it("runs one-time admission work only during writer-barrier revalidation", async () => {
  let initialChecks = 0;
  let finalChecks = 0;
  const admission = await beginSessionWorkAdmission({
    scope: "store-dedicated-revalidation",
    identities: ["session-dedicated-revalidation"],
    assertAllowed: () => {
      initialChecks += 1;
    },
    revalidateAllowed: () => {
      finalChecks += 1;
    },
  });

  try {
    expect(initialChecks).toBe(1);
    expect(finalChecks).toBe(1);
  } finally {
    admission.release();
  }
});

it("reports an admission that passed the writer before its caller registers work", async () => {
  const scope = "store-concurrent-admission";
  const sessionId = "session-concurrent-admission";
  const writerStarted = createDeferred();
  const releaseWriter = createDeferred();
  const firstValidated = createDeferred();
  const allowFirstCaller = createDeferred();
  const writer = runExclusiveSessionStoreWrite(scope, async () => {
    writerStarted.resolve();
    await releaseWriter.promise;
  });
  await writerStarted.promise;

  const firstAdmission = beginSessionWorkAdmission({
    scope,
    identities: ["agent:main:concurrent-admission", sessionId],
    assertAllowed: () => {
      firstValidated.resolve();
    },
  });
  let firstCallerRegisteredWork = false;
  const firstCaller = firstAdmission.then(async () => {
    await allowFirstCaller.promise;
    firstCallerRegisteredWork = true;
  });
  await firstValidated.promise;

  let hasConcurrentAdmissions: boolean | undefined;
  const secondAdmission = beginSessionWorkAdmission({
    scope,
    identities: [sessionId],
    assertAllowed: () => {},
    revalidateAllowed: (facts) => {
      hasConcurrentAdmissions = facts.hasConcurrentAdmissions;
    },
  });
  releaseWriter.resolve();

  let first: Awaited<typeof firstAdmission> | undefined;
  let second: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
  try {
    first = await firstAdmission;
    second = await secondAdmission;
    expect(hasConcurrentAdmissions).toBe(true);
    expect(firstCallerRegisteredWork).toBe(false);
    expect(getActiveSessionWorkAdmissionCount()).toBe(2);
  } finally {
    second?.release();
    first?.release();
    allowFirstCaller.resolve();
    await Promise.allSettled([firstCaller, writer, firstAdmission, secondAdmission]);
  }

  expect(getActiveSessionWorkAdmissionCount()).toBe(0);
});

it("blocks work that matches any durable session identity", async () => {
  const barrier = registerSessionWorkAdmissionBarrier({
    scope: "store-durable-identity",
    identities: ["agent:main:alias", "session-durable-identity"],
  });

  try {
    await expect(
      beginSessionWorkAdmission({
        scope: "store-durable-identity",
        identities: ["agent:main:alias"],
        assertAllowed: () => {},
      }),
    ).rejects.toMatchObject({ name: "SessionWorkAdmissionBlockedError" });
    await expect(
      beginSessionWorkAdmission({
        scope: "store-durable-identity",
        identities: ["session-durable-identity"],
        assertAllowed: () => {},
      }),
    ).rejects.toMatchObject({ name: "SessionWorkAdmissionBlockedError" });
  } finally {
    barrier.release();
  }
});

it("shares durable barriers across physical store aliases", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lifecycle-alias-")));
  const physical = path.join(root, "physical");
  const aliasA = path.join(root, "alias-a");
  const aliasB = path.join(root, "alias-b");
  fs.mkdirSync(physical);
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(physical, aliasA, symlinkType);
  fs.symlinkSync(physical, aliasB, symlinkType);
  const storeA = path.join(aliasA, "sessions.json");
  const storeB = path.join(aliasB, "sessions.json");
  fs.writeFileSync(path.join(physical, "sessions.json"), "{}");
  const identity = "session-durable-physical-identity";
  const barrier = registerSessionWorkAdmissionBarrier({ scope: storeA, identities: [identity] });

  try {
    expect(isSessionWorkAdmissionActive(storeB, [identity])).toBe(true);
    expect(collectActiveSessionWorkAdmissionIdentities(storeB)).toEqual(new Set([identity]));
    await expect(
      beginSessionWorkAdmission({
        scope: storeB,
        identities: [identity],
        assertAllowed: () => {},
      }),
    ).rejects.toMatchObject({ name: "SessionWorkAdmissionBlockedError" });
    await expect(
      runExclusiveSessionLifecycleMutation({
        scope: storeB,
        identities: [identity],
        run: async () => {},
      }),
    ).rejects.toMatchObject({ name: "SessionWorkAdmissionBlockedError" });
  } finally {
    barrier.release();
    clearCanonicalSessionStorePathCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("reports durable barriers as active session work identities", () => {
  const scope = "store-durable-observability";
  const alias = "agent:main:durable-observability";
  const sessionId = "session-durable-observability";
  const barrier = registerSessionWorkAdmissionBarrier({
    scope,
    identities: [alias, sessionId],
  });

  try {
    expect(isSessionWorkAdmissionActive(scope, [alias])).toBe(true);
    expect(isSessionWorkAdmissionActive(scope, [sessionId])).toBe(true);
    expect(collectActiveSessionWorkAdmissionIdentities(scope)).toEqual(new Set([alias, sessionId]));
  } finally {
    barrier.release();
  }

  expect(isSessionWorkAdmissionActive(scope, [alias, sessionId])).toBe(false);
  expect(collectActiveSessionWorkAdmissionIdentities(scope)).toEqual(new Set());
});

it("blocks lifecycle mutation before preparation while durable work remains", async () => {
  const scope = "store-durable-mutation-block";
  const identity = "session-durable-mutation-block";
  const barrier = registerSessionWorkAdmissionBarrier({ scope, identities: [identity] });
  let prepared = false;
  let ran = false;

  try {
    await expect(
      runExclusiveSessionLifecycleMutation({
        scope,
        identities: [identity],
        prepare: async () => {
          prepared = true;
        },
        run: async () => {
          ran = true;
        },
      }),
    ).rejects.toMatchObject({ name: "SessionWorkAdmissionBlockedError" });
    expect(prepared).toBe(false);
    expect(ran).toBe(false);
  } finally {
    barrier.release();
  }
});

it("allows an exact cancellation mutation to bypass and release durable work", async () => {
  const scope = "store-durable-mutation-cancel";
  const identity = "session-durable-mutation-cancel";
  const barrier = registerSessionWorkAdmissionBarrier({ scope, identities: [identity] });
  const order: string[] = [];

  try {
    await runExclusiveSessionLifecycleMutation({
      scope,
      identities: [identity],
      bypassDurableBarrier: true,
      prepare: async () => {
        order.push("prepare");
        expect(isSessionWorkAdmissionActive(scope, [identity])).toBe(true);
        barrier.release();
      },
      run: async () => {
        order.push("run");
        expect(isSessionWorkAdmissionActive(scope, [identity])).toBe(false);
      },
    });
    expect(order).toEqual(["prepare", "run"]);
  } finally {
    barrier.release();
  }
});

it("allows unrelated sessions through a durable session barrier", async () => {
  const barrier = registerSessionWorkAdmissionBarrier({
    scope: "store-durable-unrelated",
    identities: ["session-durable-blocked"],
  });

  try {
    const admission = await beginSessionWorkAdmission({
      scope: "store-durable-unrelated",
      identities: ["session-durable-allowed"],
      assertAllowed: () => {},
    });
    admission.release();
  } finally {
    barrier.release();
  }
});

it("allows the durable barrier owner to resume matching session work", async () => {
  const barrier = registerSessionWorkAdmissionBarrier({
    scope: "store-durable-owner",
    identities: ["agent:main:owner-alias", "session-durable-owner"],
  });

  try {
    const admission = await beginSessionWorkAdmission({
      scope: "store-durable-owner",
      identities: ["agent:main:owner-alias", "session-durable-owner"],
      barrierGrant: barrier.issueGrant({
        identities: ["agent:main:owner-alias", "session-durable-owner"],
      }).grant,
      assertAllowed: () => {},
    });
    admission.release();
  } finally {
    barrier.release();
  }
});

it("consumes a durable barrier grant only once", async () => {
  const scope = "store-durable-one-shot";
  const identity = "session-durable-one-shot";
  const barrier = registerSessionWorkAdmissionBarrier({ scope, identities: [identity] });
  const grant = barrier.issueGrant({ identities: [identity] }).grant;

  try {
    const admission = await beginSessionWorkAdmission({
      scope,
      identities: [identity],
      barrierGrant: grant,
      assertAllowed: () => {},
    });
    admission.release();
    await expect(
      beginSessionWorkAdmission({
        scope,
        identities: [identity],
        barrierGrant: grant,
        assertAllowed: () => {},
      }),
    ).rejects.toMatchObject({ name: "SessionWorkAdmissionBlockedError" });
  } finally {
    barrier.release();
  }
});

it("binds durable barrier grants to their exact scope and identities", async () => {
  const scope = "store-durable-bound-grant";
  const identity = "session-durable-bound-grant";
  const barrier = registerSessionWorkAdmissionBarrier({ scope, identities: [identity] });

  try {
    expect(() => barrier.issueGrant({ identities: ["other-session"] })).toThrow(
      SessionWorkAdmissionBlockedError,
    );
    const wrongScopeGrant = barrier.issueGrant({ identities: [identity] }).grant;
    await expect(
      beginSessionWorkAdmission({
        scope: `${scope}-other`,
        identities: [identity],
        barrierGrant: wrongScopeGrant,
        assertAllowed: () => {},
      }),
    ).rejects.toMatchObject({ name: "SessionWorkAdmissionBlockedError" });
  } finally {
    barrier.release();
  }
});

it("inherits the durable barrier owner through nested admission runs", async () => {
  const scope = "store-durable-owner-inherited";
  const identity = "session-durable-owner-inherited";
  const barrier = registerSessionWorkAdmissionBarrier({ scope, identities: [identity] });
  const outer = await beginSessionWorkAdmission({
    scope,
    identities: [identity],
    barrierGrant: barrier.issueGrant({ identities: [identity] }).grant,
    assertAllowed: () => {},
  });

  try {
    await outer.run(async () => {
      const nested = await beginSessionWorkAdmission({
        scope,
        identities: [identity],
        assertAllowed: () => {},
      });
      try {
        await nested.run(async () => {
          const deepest = await beginSessionWorkAdmission({
            scope,
            identities: [identity],
            assertAllowed: () => {},
          });
          deepest.release();
        });
      } finally {
        nested.release();
      }
    });
  } finally {
    outer.release();
    barrier.release();
  }
});

it("does not promote an inherited owner beyond its parent admission run", async () => {
  const scope = "store-durable-owner-child-stashed";
  const identity = "session-durable-owner-child-stashed";
  const barrier = registerSessionWorkAdmissionBarrier({ scope, identities: [identity] });
  const outer = await beginSessionWorkAdmission({
    scope,
    identities: [identity],
    barrierGrant: barrier.issueGrant({ identities: [identity] }).grant,
    assertAllowed: () => {},
  });
  let nested: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;

  try {
    await outer.run(async () => {
      nested = await beginSessionWorkAdmission({
        scope,
        identities: [identity],
        assertAllowed: () => {},
      });
    });
    if (!nested) {
      throw new Error("nested admission was not created");
    }
    await expect(
      nested.run(async () => {
        const deepest = await beginSessionWorkAdmission({
          scope,
          identities: [identity],
          assertAllowed: () => {},
        });
        deepest.release();
      }),
    ).rejects.toMatchObject({ name: "SessionWorkAdmissionBlockedError" });
  } finally {
    nested?.release();
    outer.release();
    barrier.release();
  }
});

it("uses the explicit nested barrier owner only for that admission run", async () => {
  const scope = "store-durable-owner-explicit-nested";
  const outerIdentity = "session-durable-owner-outer";
  const nestedIdentity = "session-durable-owner-nested";
  const outerBarrier = registerSessionWorkAdmissionBarrier({
    scope,
    identities: [outerIdentity],
  });
  const nestedBarrier = registerSessionWorkAdmissionBarrier({
    scope,
    identities: [nestedIdentity],
  });
  const outer = await beginSessionWorkAdmission({
    scope,
    identities: [outerIdentity],
    barrierGrant: outerBarrier.issueGrant({ identities: [outerIdentity] }).grant,
    assertAllowed: () => {},
  });

  try {
    await outer.run(async () => {
      await expect(
        beginSessionWorkAdmission({
          scope,
          identities: [nestedIdentity],
          assertAllowed: () => {},
        }),
      ).rejects.toMatchObject({ name: "SessionWorkAdmissionBlockedError" });

      const nested = await beginSessionWorkAdmission({
        scope,
        identities: [nestedIdentity],
        barrierGrant: nestedBarrier.issueGrant({ identities: [nestedIdentity] }).grant,
        assertAllowed: () => {},
      });
      try {
        await nested.run(async () => {
          const deepest = await beginSessionWorkAdmission({
            scope,
            identities: [nestedIdentity],
            assertAllowed: () => {},
          });
          deepest.release();
        });
      } finally {
        nested.release();
      }

      await expect(
        beginSessionWorkAdmission({
          scope,
          identities: [nestedIdentity],
          assertAllowed: () => {},
        }),
      ).rejects.toMatchObject({ name: "SessionWorkAdmissionBlockedError" });
    });
  } finally {
    outer.release();
    nestedBarrier.release();
    outerBarrier.release();
  }
});

it("revokes an inherited barrier owner when its admission releases", async () => {
  const scope = "store-durable-owner-released";
  const identity = "session-durable-owner-released";
  const barrier = registerSessionWorkAdmissionBarrier({ scope, identities: [identity] });
  const outer = await beginSessionWorkAdmission({
    scope,
    identities: [identity],
    barrierGrant: barrier.issueGrant({ identities: [identity] }).grant,
    assertAllowed: () => {},
  });

  try {
    await outer.run(async () => {
      const childValidated = createDeferred();
      const continueChild = createDeferred();
      const child = beginSessionWorkAdmission({
        scope,
        identities: [identity],
        assertAllowed: async () => {
          childValidated.resolve();
          await continueChild.promise;
        },
      });
      await childValidated.promise;
      const blockedChild = expect(child).rejects.toMatchObject({
        name: "SessionWorkAdmissionBlockedError",
      });
      outer.release();
      continueChild.resolve();
      await blockedChild;
    });
  } finally {
    outer.release();
    barrier.release();
  }
});

it("does not retain an inherited barrier owner after its admission run", async () => {
  const scope = "store-durable-owner-run-ended";
  const identity = "session-durable-owner-run-ended";
  const barrier = registerSessionWorkAdmissionBarrier({ scope, identities: [identity] });
  const outer = await beginSessionWorkAdmission({
    scope,
    identities: [identity],
    barrierGrant: barrier.issueGrant({ identities: [identity] }).grant,
    assertAllowed: () => {},
  });
  const continueChild = createDeferred();
  let child: Promise<void> | undefined;

  try {
    await outer.run(async () => {
      child = (async () => {
        await continueChild.promise;
        const nested = await beginSessionWorkAdmission({
          scope,
          identities: [identity],
          assertAllowed: () => {},
        });
        nested.release();
      })();
    });
    if (!child) {
      throw new Error("detached child was not created");
    }
    const blockedChild = expect(child).rejects.toMatchObject({
      name: "SessionWorkAdmissionBlockedError",
    });
    continueChild.resolve();
    await blockedChild;
  } finally {
    continueChild.resolve();
    await child?.catch(() => {});
    outer.release();
    barrier.release();
  }
});

it("rechecks durable session barriers behind the store writer", async () => {
  const scope = "store-durable-writer-race";
  const identity = "session-durable-writer-race";
  const writerStarted = createDeferred();
  const releaseWriter = createDeferred();
  const firstValidation = createDeferred();
  const writer = runExclusiveSessionStoreWrite(scope, async () => {
    writerStarted.resolve();
    await releaseWriter.promise;
  });
  await writerStarted.promise;

  const admission = beginSessionWorkAdmission({
    scope,
    identities: [identity],
    assertAllowed: () => {
      firstValidation.resolve();
    },
  });
  await firstValidation.promise;
  const barrier = registerSessionWorkAdmissionBarrier({ scope, identities: [identity] });
  const blockedAdmission = expect(admission).rejects.toMatchObject({
    name: "SessionWorkAdmissionBlockedError",
  });

  try {
    releaseWriter.resolve();
    await writer;
    await blockedAdmission;
    expect(isSessionWorkAdmissionActive(scope, [identity])).toBe(true);
    barrier.release();
    expect(isSessionWorkAdmissionActive(scope, [identity])).toBe(false);
  } finally {
    releaseWriter.resolve();
    barrier.release();
    await Promise.allSettled([writer, admission]);
  }
});

it("unblocks matching work after the durable barrier releases", async () => {
  const scope = "store-durable-release";
  const identity = "session-durable-release";
  const barrier = registerSessionWorkAdmissionBarrier({ scope, identities: [identity] });

  try {
    await expect(
      beginSessionWorkAdmission({
        scope,
        identities: [identity],
        assertAllowed: () => {},
      }),
    ).rejects.toMatchObject({ name: "SessionWorkAdmissionBlockedError" });
  } finally {
    barrier.release();
  }

  const admission = await beginSessionWorkAdmission({
    scope,
    identities: [identity],
    assertAllowed: () => {},
  });
  admission.release();
});

it("rejects and releases an admission invalidated by an earlier store writer", async () => {
  const storePath = "store-writer-revalidation";
  const writerStarted = createDeferred();
  const releaseWriter = createDeferred();
  const firstValidation = createDeferred();
  let allowed = true;
  let validationCount = 0;
  const writer = runExclusiveSessionStoreWrite(storePath, async () => {
    writerStarted.resolve();
    await releaseWriter.promise;
    allowed = false;
  });
  await writerStarted.promise;

  const admission = beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:child", "session-writer-revalidation"],
    assertAllowed: () => {
      validationCount += 1;
      if (validationCount === 1) {
        firstValidation.resolve();
      }
      if (!allowed) {
        throw new Error("session changed");
      }
    },
  });
  await firstValidation.promise;
  await Promise.resolve();
  expect(isSessionWorkAdmissionActive(storePath, ["session-writer-revalidation"])).toBe(true);

  releaseWriter.resolve();
  await writer;
  await expect(admission).rejects.toThrow("session changed");
  expect(validationCount).toBe(2);
  expect(isSessionWorkAdmissionActive(storePath, ["session-writer-revalidation"])).toBe(false);
});

it("releases an admission aborted while waiting for the store writer barrier", async () => {
  const storePath = "store-writer-abort";
  const writerStarted = createDeferred();
  const releaseWriter = createDeferred();
  const firstValidation = createDeferred();
  const controller = new AbortController();
  const abortError = new Error("admission aborted behind writer");
  const writer = runExclusiveSessionStoreWrite(storePath, async () => {
    writerStarted.resolve();
    await releaseWriter.promise;
  });
  await writerStarted.promise;

  const admission = beginSessionWorkAdmission({
    scope: storePath,
    identities: ["session-writer-abort"],
    signal: controller.signal,
    assertAllowed: () => {
      firstValidation.resolve();
    },
  });
  await firstValidation.promise;
  controller.abort(abortError);

  await expect(admission).rejects.toBe(abortError);
  expect(isSessionWorkAdmissionActive(storePath, ["session-writer-abort"])).toBe(false);

  releaseWriter.resolve();
  await writer;
});

it("revalidates without inheriting a released gateway root from the writer queue", async () => {
  resetGatewayWorkAdmission();
  const storePath = "store-released-gateway-root";
  const writerStarted = createDeferred();
  const releaseWriter = createDeferred();
  const firstValidation = createDeferred();
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  if (!root) {
    throw new Error("gateway root admission unavailable");
  }
  const writer = root.run(
    async () =>
      await runExclusiveSessionStoreWrite(storePath, async () => {
        writerStarted.resolve();
        await releaseWriter.promise;
      }),
  );
  await writerStarted.promise;

  let validationCount = 0;
  const admissionPromise = beginSessionWorkAdmission({
    scope: storePath,
    identities: ["session-released-gateway-root"],
    assertAllowed: () => {
      validationCount += 1;
      if (validationCount === 1) {
        firstValidation.resolve();
      }
    },
  });
  await firstValidation.promise;

  root.release();
  releaseWriter.resolve();
  const admission = await admissionPromise;
  try {
    expect(validationCount).toBe(2);
  } finally {
    admission.release();
    await writer;
    resetGatewayWorkAdmission();
  }
});

it("serializes lifecycle mutation and work admission across identity aliases", async () => {
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;

  let admitted = false;
  const admission = beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["session-1"],
    assertAllowed: () => {
      admitted = true;
    },
  });
  await Promise.resolve();
  expect(admitted).toBe(false);

  releaseMutation.resolve();
  await mutation;
  const admissionLease = await admission;
  expect(admitted).toBe(true);
  expect(isSessionWorkAdmissionActive("store-a", ["agent:main:child", "session-1"])).toBe(true);

  admissionLease.release();
  expect(isSessionWorkAdmissionActive("store-a", ["session-1"])).toBe(false);
});

it("tracks the active lifecycle mutation kind across identity aliases", async () => {
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation({
    scope: "store-kind",
    identities: ["agent:main:child", "session-kind"],
    kind: "compaction",
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;

  expect(
    hasOnlySessionLifecycleMutationKindActive("store-kind", ["session-kind"], "compaction"),
  ).toBe(true);
  expect(
    hasOnlySessionLifecycleMutationKindActive("store-other", ["session-kind"], "compaction"),
  ).toBe(false);

  releaseMutation.resolve();
  await mutation;
  expect(
    hasOnlySessionLifecycleMutationKindActive("store-kind", ["session-kind"], "compaction"),
  ).toBe(false);
});

it("keeps identical session keys isolated by store", async () => {
  const admissionLease = await beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["global", "session-a"],
    assertAllowed: () => {},
  });

  try {
    expect(isSessionWorkAdmissionActive("store-a", ["global"])).toBe(true);
    expect(isSessionWorkAdmissionActive("store-b", ["global"])).toBe(false);
    let storeBMutationRan = false;
    await runExclusiveSessionLifecycleMutation({
      scope: "store-b",
      identities: ["global"],
      run: async () => {
        storeBMutationRan = true;
      },
    });
    expect(storeBMutationRan).toBe(true);
  } finally {
    admissionLease.release();
  }
});

it("cancels work admission waiting behind a lifecycle mutation", async () => {
  const mutationPrepared = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    prepare: async () => {
      mutationPrepared.resolve();
      await releaseMutation.promise;
    },
    run: async () => {},
  });
  await mutationPrepared.promise;

  const controller = new AbortController();
  const abortError = new Error("reset interrupted admission");
  const admission = beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["session-1"],
    signal: controller.signal,
    assertAllowed: () => {},
  });
  controller.abort(abortError);

  await expect(admission).rejects.toBe(abortError);
  releaseMutation.resolve();
  await mutation;
});

it("cancels work admission while a lifecycle mutation holds the identity lock", async () => {
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;

  const controller = new AbortController();
  const abortError = new Error("cancel during lifecycle mutation");
  const admission = beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["session-1"],
    signal: controller.signal,
    assertAllowed: () => {},
  });
  controller.abort(abortError);

  await expect(admission).rejects.toBe(abortError);
  releaseMutation.resolve();
  await mutation;
});

it("cancels a queued lifecycle mutation before it becomes active", async () => {
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const first = runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    run: async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    },
  });
  await firstStarted.promise;

  const controller = new AbortController();
  const abortError = new Error("cancel queued lifecycle mutation");
  let cancelledMutationRan = false;
  const cancelled = runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    signal: controller.signal,
    run: async () => {
      cancelledMutationRan = true;
    },
  });
  controller.abort(abortError);

  await expect(cancelled).rejects.toBe(abortError);
  releaseFirst.resolve();
  await first;
  await runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    run: async () => {},
  });
  expect(cancelledMutationRan).toBe(false);
});

it("preserves the initiating admission across a queued lifecycle mutation", async () => {
  let selfInterrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    assertAllowed: () => {},
    onInterrupt: () => {
      selfInterrupted = true;
    },
  });
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const first = runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    run: async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    },
  });
  await firstStarted.promise;

  let initiatingAdmissionExcluded = false;
  const queued = admission.run(
    async () =>
      await runExclusiveSessionLifecycleMutation({
        scope: "store-a",
        identities: ["agent:main:child", "session-1"],
        prepare: async () => {
          initiatingAdmissionExcluded = await interruptSessionWorkAdmissions({
            scope: "store-a",
            identities: ["agent:main:child", "session-1"],
            timeoutMs: 1,
          });
        },
        run: async () => {},
      }),
  );

  try {
    releaseFirst.resolve();
    await first;
    await queued;
    expect(initiatingAdmissionExcluded).toBe(true);
    expect(selfInterrupted).toBe(false);
  } finally {
    releaseFirst.resolve();
    admission.release();
    await Promise.allSettled([first, queued]);
  }
});

it("bounds interruption waits for non-cooperative work", async () => {
  const admissionLease = await beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    assertAllowed: () => {},
    onInterrupt: () => {},
  });

  try {
    await expect(
      interruptSessionWorkAdmissions({
        scope: "store-a",
        identities: ["session-1"],
        timeoutMs: 1,
      }),
    ).resolves.toBe(false);
  } finally {
    admissionLease.release();
  }
});

it("excludes the initiating admission from an in-band interruption", async () => {
  let interrupted = false;
  const admissionLease = await beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  try {
    await expect(
      admissionLease.run(
        async () =>
          await interruptSessionWorkAdmissions({
            scope: "store-a",
            identities: ["session-1"],
            timeoutMs: 1,
          }),
      ),
    ).resolves.toBe(true);
    expect(interrupted).toBe(false);
  } finally {
    admissionLease.release();
  }
});

it("shares lifecycle coordination across duplicate module instances", async () => {
  const first = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=session-lifecycle-a",
  );
  const second = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=session-lifecycle-b",
  );
  let releaseLease = () => {};
  let interrupted = false;
  const lease = await first.beginSessionWorkAdmission({
    scope: "store-duplicate",
    identities: ["agent:main:child", "session-duplicate"],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
      releaseLease();
    },
  });
  releaseLease = lease.release;

  try {
    expect(second.isSessionWorkAdmissionActive("store-duplicate", ["session-duplicate"])).toBe(
      true,
    );
    await expect(
      second.interruptSessionWorkAdmissions({
        scope: "store-duplicate",
        identities: ["agent:main:child"],
        timeoutMs: 50,
      }),
    ).resolves.toBe(true);
    expect(interrupted).toBe(true);
    expect(first.isSessionWorkAdmissionActive("store-duplicate", ["session-duplicate"])).toBe(
      false,
    );
  } finally {
    lease.release();
  }
});
