// Startup WebSocket race tests ensure upgrade handlers are attached before the
// gateway reports its listen step as ready.
import fs from "node:fs/promises";
import { Server as HttpServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { clearMainRunRecoveryRuntimeForTest } from "../agents/main-run-recovery-runtime.js";
import { tryListenOnPort } from "../infra/ports-probe.js";
import { isSessionWorkAdmissionActive } from "../sessions/session-lifecycle-admission.js";
import { reserveMainSessionResumeRecovery } from "../state/main-run-recovery-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { getFreePort, installGatewayTestHooks, startGatewayServer } from "./test-helpers.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";

type StartGatewayServer = typeof import("./test-helpers.js").startGatewayServer;
type GatewayServerForTest = Awaited<ReturnType<StartGatewayServer>>;

installGatewayTestHooks({ scope: "suite" });

async function connectWebSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return await new Promise<WebSocket>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      ws.close();
      reject(new Error("expected websocket connect to succeed immediately after startup"));
    }, 5_000);
    timeout.unref?.();
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", handleOpen);
      ws.off("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve(ws);
    };
    const handleError = (err: Error) => {
      cleanup();
      reject(err);
    };
    ws.once("open", handleOpen);
    ws.once("error", handleError);
  });
}

async function disconnectWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

afterEach(() => {
  clearMainRunRecoveryRuntimeForTest();
  vi.restoreAllMocks();
});

describe("gateway startup websocket readiness", () => {
  it("attaches websocket upgrade handlers before exposing the listen step", async () => {
    const runtimeState = await createGatewayRuntimeStateForTest();
    try {
      expect(runtimeState.httpBindHosts).toEqual([]);
      expect(runtimeState.httpServer.listenerCount("upgrade")).toBeGreaterThan(0);
    } finally {
      runtimeState.releasePluginRouteRegistry();
      runtimeState.wss.close();
    }
  });

  it("accepts an immediate websocket connection once startup resolves", async () => {
    const previousMinimal = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    let server: GatewayServerForTest | undefined;
    let client: WebSocket | undefined;
    try {
      const port = await getFreePort();
      server = await startGatewayServer(port, {
        auth: { mode: "none" },
      });

      client = await connectWebSocket(`ws://127.0.0.1:${port}`);
    } finally {
      if (client) {
        await disconnectWebSocket(client);
      }
      if (server) {
        await server.close();
      }
      if (previousMinimal === undefined) {
        delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
      } else {
        process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimal;
      }
    }
  });

  it("rehydrates restart barriers before exposing the listen step", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway startup tests");
    }
    const previousMinimal = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const sessionId = "startup-restart-session";
    let server: GatewayServerForTest | undefined;
    try {
      reserveMainSessionResumeRecovery({
        agentId: "main",
        sessionKey: "agent:main:dashboard:startup-restart-session",
        sessionKeyAliases: [],
        sessionId,
        storePath,
        sourceKey: "startup-restart-run",
        bootId: "startup-restart-generation",
        envelope: {
          kind: "session_resume",
          resolution: { kind: "resume" },
          systemMessage: "continue after restart",
          transcriptTail: null,
          lifecycleRevision: null,
          delivery: { context: null, runId: null, intentId: null },
          fences: [],
        },
        acceptedAtMs: 1_000,
      });
      clearMainRunRecoveryRuntimeForTest();
      expect(isSessionWorkAdmissionActive(storePath, [sessionId])).toBe(false);

      const originalListen: unknown = Reflect.get(HttpServer.prototype, "listen");
      if (typeof originalListen !== "function") {
        throw new TypeError("HTTP server listen implementation is unavailable");
      }
      const listenSpy = vi.spyOn(HttpServer.prototype, "listen").mockImplementation(function (
        this: HttpServer,
        ...args
      ) {
        expect(isSessionWorkAdmissionActive(storePath, [sessionId])).toBe(true);
        return Reflect.apply(originalListen, this, args);
      });
      server = await startGatewayServer(await getFreePort(), { auth: { mode: "none" } });
      expect(listenSpy).toHaveBeenCalled();
    } finally {
      await server?.close();
      clearMainRunRecoveryRuntimeForTest();
      closeOpenClawStateDatabaseForTest();
      if (previousMinimal === undefined) {
        delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
      } else {
        process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimal;
      }
    }
  });

  it("does not synthesize recovery authority from a JSON-only running row", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway startup tests");
    }
    const previousMinimal = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    const agentDir = path.join(stateDir, "agents", "startup-json-orphan");
    const storePath = path.join(agentDir, "sessions", "sessions.json");
    const sessionKey = "agent:startup-json-orphan:dashboard:restart-proof";
    const sessionId = "startup-json-orphan-session";
    let server: GatewayServerForTest | undefined;
    try {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId,
            updatedAt: Date.now() - 10_000,
            status: "running",
          },
        }),
      );
      expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(false);

      const originalListen: unknown = Reflect.get(HttpServer.prototype, "listen");
      if (typeof originalListen !== "function") {
        throw new TypeError("HTTP server listen implementation is unavailable");
      }
      const listenSpy = vi.spyOn(HttpServer.prototype, "listen").mockImplementation(function (
        this: HttpServer,
        ...args
      ) {
        expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(false);
        return Reflect.apply(originalListen, this, args);
      });
      server = await startGatewayServer(await getFreePort(), { auth: { mode: "none" } });
      expect(listenSpy).toHaveBeenCalled();
      expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(false);
    } finally {
      await server?.close();
      clearMainRunRecoveryRuntimeForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(agentDir, { recursive: true, force: true });
      if (previousMinimal === undefined) {
        delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
      } else {
        process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimal;
      }
    }
  });

  it("serves a specific IPv4 bind and its required loopback alias", async () => {
    const previousMinimal = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    let server: GatewayServerForTest | undefined;
    const clients: WebSocket[] = [];
    try {
      const port = await getFreePort();
      server = await startGatewayServer(port, {
        host: "127.0.0.2",
        auth: { mode: "none" },
      });

      clients.push(
        await connectWebSocket(`ws://127.0.0.1:${port}`),
        await connectWebSocket(`ws://127.0.0.2:${port}`),
      );
    } finally {
      await Promise.all(clients.map(async (client) => await disconnectWebSocket(client)));
      if (server) {
        await server.close();
      }
      if (previousMinimal === undefined) {
        delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
      } else {
        process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimal;
      }
    }
  });

  it("releases the loopback alias when the selected bind fails", async () => {
    const port = await getFreePort();

    await expect(
      startGatewayServer(port, {
        bind: "lan",
        host: "192.0.2.1",
        auth: { mode: "token", token: "test-token" },
      }),
    ).rejects.toThrow("failed to bind gateway socket");

    await expect(
      tryListenOnPort({ host: "127.0.0.1", port, exclusive: true }),
    ).resolves.toBeUndefined();
  });
});
