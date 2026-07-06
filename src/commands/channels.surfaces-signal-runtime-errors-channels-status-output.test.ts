// Channels status error-surface tests cover Signal runtime errors in channel status output.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectStatusIssuesFromLastError } from "../plugin-sdk/status-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { formatGatewayChannelsStatusLines } from "./channels/status.js";

const now = 1_700_000_000_000;

const signalPlugin = {
  ...createChannelTestPluginBase({ id: "signal" }),
  status: {
    collectStatusIssues: (accounts: Parameters<typeof collectStatusIssuesFromLastError>[1]) =>
      collectStatusIssuesFromLastError("signal", accounts),
  },
};

const imessagePlugin = {
  ...createChannelTestPluginBase({ id: "imessage" }),
  status: {
    collectStatusIssues: (accounts: Parameters<typeof collectStatusIssuesFromLastError>[1]) =>
      collectStatusIssuesFromLastError("imessage", accounts),
  },
};

describe("channels command", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "signal", source: "test", plugin: signalPlugin }]),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("surfaces Signal runtime errors in channels status output", () => {
    const lines = formatGatewayChannelsStatusLines({
      channelLabels: {
        signal: "Signal",
      },
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "signal-cli unreachable",
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/signal/i);
    expect(lines.join("\n")).toMatch(/Channel error/i);
  });

  it("surfaces iMessage runtime errors in channels status output", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: imessagePlugin,
        },
      ]),
    );
    const lines = formatGatewayChannelsStatusLines({
      channelLabels: {
        imessage: "iMessage",
      },
      channelAccounts: {
        imessage: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "imsg permission denied",
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/imessage/i);
    expect(lines.join("\n")).toMatch(/Channel error/i);
  });

  it("surfaces degraded gateway event-loop health in channels status output", () => {
    const lines = formatGatewayChannelsStatusLines({
      eventLoop: {
        degraded: true,
        reasons: ["event_loop_delay", "cpu"],
        intervalMs: 62_000,
        delayP99Ms: 61_000,
        delayMaxMs: 62_000,
        utilization: 1,
        cpuCoreRatio: 1,
      },
      channelLabels: {},
      channelAccounts: {},
    });

    expect(lines.join("\n")).toMatch(/Gateway event loop degraded/);
    expect(lines.join("\n")).toMatch(/eventLoopDelayMaxMs=62000/);
  });

  it("surfaces transport liveness timestamps in channels status output", () => {
    const lines = formatGatewayChannelsStatusLines({
      channelLabels: {
        signal: "Signal",
      },
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: true,
            connected: true,
            lastTransportActivityAt: now - 2 * 60_000,
          },
        ],
      },
    });

    expect(lines.join("\n")).toContain("transport:");
  });

  it.each([
    ["ready", "readiness:ready"],
    ["account_missing", "readiness:account-missing"],
    ["unreachable", "readiness:daemon-unreachable"],
    ["receive_unavailable", "readiness:receive-unavailable"],
  ])("surfaces Signal %s probe readiness in channels status output", (readiness, expected) => {
    const lines = formatGatewayChannelsStatusLines({
      channelLabels: {
        signal: "Signal",
      },
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            probe: {
              ok: readiness === "ready",
              readiness,
            },
          },
        ],
      },
    });

    expect(lines.join("\n")).toContain(expected);
  });

  it("marks account-missing Signal probes as failed, not working", () => {
    const lines = formatGatewayChannelsStatusLines({
      channelLabels: {
        signal: "Signal",
      },
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            probe: {
              ok: false,
              readiness: "account_missing",
            },
          },
        ],
      },
    });

    const output = lines.join("\n");
    expect(output).toContain("readiness:account-missing");
    expect(output).toContain("probe failed");
    expect(output).not.toContain("works");
  });
});
