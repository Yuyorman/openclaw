// Signal plugin module implements setup core behavior.
import {
  createCliPathTextInput,
  createDelegatedSetupWizardProxy,
  createDelegatedTextInputShouldPrompt,
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
  DEFAULT_ACCOUNT_ID,
  mergeAllowFromEntries,
  parseSetupEntriesAllowingWildcard,
  patchChannelConfigForAccount,
  promptParsedAllowFromForAccount,
  setAccountAllowFromForChannel,
  setSetupChannelEnabled,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type ChannelSetupWizardTextInput,
  type OpenClawConfig,
  createSetupTranslator,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveDefaultSignalAccountId, resolveSignalAccount } from "./accounts.js";
import type { SignalApiMode } from "./client-adapter.js";

const t = createSetupTranslator();

const channel = "signal" as const;
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
const SIGNAL_SETUP_TRANSPORT_KEY = "signalTransport";
const SIGNAL_SETUP_CANCELLED_KEY = "signalSetupCancelled";
const SIGNAL_SETUP_ORIGINAL_CHANNEL_KEY = "signalSetupOriginalChannel";
const SIGNAL_SETUP_ORIGINAL_CHANNEL_ABSENT = "__absent__";
const DEFAULT_SIGNAL_NATIVE_HTTP_HOST = "127.0.0.1";
const DEFAULT_SIGNAL_NATIVE_HTTP_PORT = 8080;
const SIGNAL_STATUS_PROBE_COMMAND = formatCliCommand("openclaw channels status --probe");
const SIGNAL_PHONE_NUMBER_EXAMPLE = "+15555550123";
const DEFAULT_SIGNAL_SETUP_ACCOUNT_SCOPED_ROOT_KEYS = new Set([
  "account",
  "accountUuid",
  "cliPath",
  "configPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "autoStart",
]);

export type SignalSetupTransport = "native" | "external-native";

export type SignalSetupServerProbeParams = {
  httpUrl: string;
  account: string;
  apiMode: SignalApiMode;
};

export type SignalSetupServerProbeResult =
  | {
      ok: true;
      version?: string | null;
    }
  | {
      ok: false;
      error: string;
    };

export type SignalSetupServerProbe = (
  params: SignalSetupServerProbeParams,
) => Promise<SignalSetupServerProbeResult>;

let signalSetupServerProbeForTest: SignalSetupServerProbe | undefined;

export function setSignalSetupServerProbeForTest(probe: SignalSetupServerProbe | undefined): void {
  signalSetupServerProbeForTest = probe;
}

export function normalizeSignalAccountInput(value: string | null | undefined): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  const phoneInput = trimmed.replace(/^signal:/i, "").trim();
  // Setup accepts formatting punctuation, but embedded or duplicate pluses are invalid input.
  const plusCount = phoneInput.match(/\+/g)?.length ?? 0;
  if (plusCount > 1 || (plusCount === 1 && !phoneInput.startsWith("+"))) {
    return null;
  }
  const normalized = normalizeE164(phoneInput);
  const digits = normalized.slice(1);
  if (!DIGITS_ONLY.test(digits)) {
    return null;
  }
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    return null;
  }
  return `+${digits}`;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseSignalAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    if (normalizeLowercaseStringOrEmpty(entry).startsWith("uuid:")) {
      const id = entry.slice("uuid:".length).trim();
      if (!id) {
        return { error: "Invalid uuid entry" };
      }
      return { value: `uuid:${id}` };
    }
    if (isUuidLike(entry)) {
      return { value: `uuid:${entry}` };
    }
    const normalized = normalizeSignalAccountInput(entry);
    if (!normalized) {
      return { error: `Invalid entry: ${entry}` };
    }
    return { value: normalized };
  });
}

function buildSignalSetupPatch(input: {
  signalNumber?: string;
  cliPath?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
  existingApiMode?: SignalApiMode;
  existingHttpHost?: string;
  existingHttpPort?: number;
  existingHttpUrl?: string;
}) {
  const externalDaemonPatch = input.httpUrl ? { autoStart: false, apiMode: "auto" as const } : {};
  const shouldResetNativeEndpoint =
    input.existingApiMode === "container" || Boolean(input.existingHttpUrl);
  const nativeDaemonPatch =
    !input.httpUrl && (input.cliPath || input.httpHost || input.httpPort)
      ? {
          autoStart: true,
          apiMode: "native" as const,
          ...(shouldResetNativeEndpoint
            ? {
                httpUrl: "",
                httpHost: input.httpHost ?? DEFAULT_SIGNAL_NATIVE_HTTP_HOST,
                httpPort: input.httpPort ? Number(input.httpPort) : DEFAULT_SIGNAL_NATIVE_HTTP_PORT,
              }
            : {}),
          ...(!shouldResetNativeEndpoint && input.httpHost ? { httpHost: input.httpHost } : {}),
          ...(!shouldResetNativeEndpoint && input.httpPort
            ? { httpPort: Number(input.httpPort) }
            : {}),
        }
      : {};
  return {
    ...(input.signalNumber ? { account: input.signalNumber } : {}),
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
    ...(input.httpHost ? { httpHost: input.httpHost } : {}),
    ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
    ...externalDaemonPatch,
    ...nativeDaemonPatch,
  };
}

function buildSignalSetupPatchForAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: Parameters<NonNullable<ChannelSetupAdapter["applyAccountConfig"]>>[0]["input"];
}) {
  const existingAccount = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  }).config;
  return buildSignalSetupPatch({
    ...params.input,
    existingApiMode: existingAccount.apiMode,
    existingHttpHost: normalizeOptionalString(existingAccount.httpHost),
    existingHttpPort: existingAccount.httpPort,
    existingHttpUrl: normalizeOptionalString(existingAccount.httpUrl),
  });
}

function buildNativeSignalSetupPatch(params: {
  accountId: string;
  scopeDefaultToAccount?: boolean;
  existingApiMode?: SignalApiMode;
  existingHttpHost?: string;
  existingHttpPort?: number;
  existingHttpUrl?: string;
  account?: string;
  cliPath?: string;
  configPath?: string;
}): Record<string, unknown> {
  const shouldResetNativeEndpoint =
    params.existingApiMode === "container" || Boolean(params.existingHttpUrl);
  const defaultPatch = {
    ...(params.account ? { account: params.account } : {}),
    ...(params.cliPath ? { cliPath: params.cliPath } : {}),
    autoStart: true,
    ...(shouldResetNativeEndpoint ? { apiMode: "native" } : {}),
    httpUrl: undefined,
    httpHost: shouldResetNativeEndpoint ? undefined : params.existingHttpHost,
    httpPort: shouldResetNativeEndpoint ? undefined : params.existingHttpPort,
    configPath: params.configPath ?? undefined,
  };
  if (params.accountId === DEFAULT_ACCOUNT_ID && !params.scopeDefaultToAccount) {
    return defaultPatch;
  }
  return {
    ...(params.account ? { account: params.account } : {}),
    ...(params.cliPath ? { cliPath: params.cliPath } : {}),
    autoStart: true,
    apiMode: "native",
    httpUrl: "",
    httpHost: shouldResetNativeEndpoint
      ? DEFAULT_SIGNAL_NATIVE_HTTP_HOST
      : (params.existingHttpHost ?? DEFAULT_SIGNAL_NATIVE_HTTP_HOST),
    httpPort: shouldResetNativeEndpoint
      ? DEFAULT_SIGNAL_NATIVE_HTTP_PORT
      : (params.existingHttpPort ?? DEFAULT_SIGNAL_NATIVE_HTTP_PORT),
    configPath: params.configPath ?? "",
  };
}

function hasSignalAccountEntries(cfg: OpenClawConfig): boolean {
  const accounts = cfg.channels?.signal?.accounts;
  return Boolean(accounts && typeof accounts === "object" && Object.keys(accounts).length > 0);
}

function shouldScopeDefaultSignalSetupPatch(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): boolean {
  return params.accountId === DEFAULT_ACCOUNT_ID && hasSignalAccountEntries(params.cfg);
}

function cloneSignalSetupConfigValue(value: unknown): unknown {
  if (value && typeof value === "object") {
    return structuredClone(value);
  }
  return value;
}

function preserveInheritedSignalSetupFields(params: {
  channelConfig: Record<string, unknown>;
  accounts: Record<string, Record<string, unknown>>;
}): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(params.accounts).map(([accountId, account]) => {
      let nextAccount = account;
      for (const key of DEFAULT_SIGNAL_SETUP_ACCOUNT_SCOPED_ROOT_KEYS) {
        if (Object.hasOwn(account, key) || !Object.hasOwn(params.channelConfig, key)) {
          continue;
        }
        if (nextAccount === account) {
          nextAccount = { ...account };
        }
        nextAccount[key] = cloneSignalSetupConfigValue(params.channelConfig[key]);
      }
      return [accountId, nextAccount];
    }),
  );
}

function copySignalSetupAccountScopedRootFields(channelConfig: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};
  for (const key of DEFAULT_SIGNAL_SETUP_ACCOUNT_SCOPED_ROOT_KEYS) {
    if (Object.hasOwn(channelConfig, key)) {
      fields[key] = cloneSignalSetupConfigValue(channelConfig[key]);
    }
  }
  return fields;
}

function patchSignalSetupConfigForAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  if (!shouldScopeDefaultSignalSetupPatch({ cfg: params.cfg, accountId: params.accountId })) {
    return patchChannelConfigForAccount({
      cfg: params.cfg,
      channel,
      accountId: params.accountId,
      patch: params.patch,
    });
  }
  const channelConfig = params.cfg.channels?.signal ?? {};
  const accounts = channelConfig.accounts ?? {};
  const preservedAccounts = preserveInheritedSignalSetupFields({ channelConfig, accounts });
  const existingDefault =
    preservedAccounts[DEFAULT_ACCOUNT_ID] ?? copySignalSetupAccountScopedRootFields(channelConfig);
  const nextChannel = { ...channelConfig };
  for (const key of DEFAULT_SIGNAL_SETUP_ACCOUNT_SCOPED_ROOT_KEYS) {
    delete nextChannel[key as keyof typeof nextChannel];
  }
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      signal: {
        ...nextChannel,
        enabled: true,
        accounts: {
          ...preservedAccounts,
          [DEFAULT_ACCOUNT_ID]: {
            ...existingDefault,
            enabled: true,
            ...params.patch,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function serializeSignalSetupOriginalChannel(cfg: OpenClawConfig): string {
  const channelConfig = cfg.channels?.signal;
  return channelConfig === undefined
    ? SIGNAL_SETUP_ORIGINAL_CHANNEL_ABSENT
    : JSON.stringify(channelConfig);
}

function restoreSignalSetupOriginalChannel(params: {
  cfg: OpenClawConfig;
  credentialValues: Record<string, string | undefined>;
}): OpenClawConfig {
  const serialized = params.credentialValues[SIGNAL_SETUP_ORIGINAL_CHANNEL_KEY];
  if (!serialized) {
    return params.cfg;
  }
  const nextChannels = { ...params.cfg.channels };
  if (serialized === SIGNAL_SETUP_ORIGINAL_CHANNEL_ABSENT) {
    delete nextChannels.signal;
  } else {
    nextChannels.signal = JSON.parse(serialized);
  }
  const next = { ...params.cfg } as OpenClawConfig;
  if (Object.keys(nextChannels).length > 0) {
    next.channels = nextChannels as OpenClawConfig["channels"];
  } else {
    delete next.channels;
  }
  return next;
}

function resolveSignalSetupTransportFromConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): SignalSetupTransport {
  const account = resolveSignalAccount(params).config;
  if (normalizeOptionalString(account.httpUrl) || account.autoStart === false) {
    return "external-native";
  }
  return "native";
}

function resolveSignalSetupChoiceFromConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): SignalSetupTransport {
  const account = resolveSignalAccount(params).config;
  if (normalizeOptionalString(account.httpUrl) || account.autoStart === false) {
    return "external-native";
  }
  return "native";
}

function resolveSignalSetupTransport(
  value: unknown,
  fallback: SignalSetupTransport,
): SignalSetupTransport {
  return value === "native" || value === "external-native" ? value : fallback;
}

export function resolveSignalSetupTransportFromCredentialValues(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, unknown>;
}): SignalSetupTransport {
  return resolveSignalSetupTransport(
    params.credentialValues[SIGNAL_SETUP_TRANSPORT_KEY],
    resolveSignalSetupTransportFromConfig(params),
  );
}

async function defaultSignalSetupServerProbe(
  params: SignalSetupServerProbeParams,
): Promise<SignalSetupServerProbeResult> {
  const { probeSignal } = await import("./probe.js");
  const probe = await probeSignal(params.httpUrl, 5_000, {
    account: params.account,
    apiMode: params.apiMode,
  });
  if (probe.ok) {
    const apiMode = await resolveSignalSetupProbeApiMode(params);
    if (apiMode === "container" && normalizeOptionalString(params.account)) {
      const { validateSignalContainerLinkedAccount } = await import("./client-container.js");
      const account = await validateSignalContainerLinkedAccount({
        httpUrl: params.httpUrl,
        account: params.account,
        timeoutMs: 5_000,
      });
      if (!account.ok) {
        return account;
      }
    }
    return { ok: true, version: probe.version };
  }
  return {
    ok: false,
    error: probe.error ?? `Signal server was not ready (${probe.readiness})`,
  };
}

async function resolveSignalSetupProbeApiMode(
  params: SignalSetupServerProbeParams,
): Promise<"native" | "container"> {
  if (params.apiMode === "native" || params.apiMode === "container") {
    return params.apiMode;
  }
  const { detectSignalApiMode } = await import("./client-adapter.js");
  return detectSignalApiMode(params.httpUrl, 5_000);
}

function resolveSignalSetupServerProbe(): SignalSetupServerProbe {
  return signalSetupServerProbeForTest ?? defaultSignalSetupServerProbe;
}

async function promptReachableSignalServerUrl(params: {
  prompter: WizardPrompter;
  title: string;
  message: string;
  initialValue: string;
  placeholder: string;
  account: string;
  apiMode: SignalApiMode;
}): Promise<string | null> {
  while (true) {
    const httpUrl = normalizeOptionalString(
      await params.prompter.text({
        message: params.message,
        initialValue: params.initialValue,
        placeholder: params.placeholder,
        validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
      }),
    );
    if (!httpUrl) {
      throw new Error("Signal server URL is required.");
    }

    const progress = params.prompter.progress("Testing Signal server URL");
    try {
      progress.update(`Testing ${httpUrl}`);
      const probe = await resolveSignalSetupServerProbe()({
        httpUrl,
        account: params.account,
        apiMode: params.apiMode,
      });
      if (probe.ok) {
        progress.stop("Signal server reachable");
        return httpUrl;
      }
      progress.stop();
      await params.prompter.note(
        [
          `OpenClaw could not reach a working Signal server at ${httpUrl}.`,
          `Error: ${probe.error}`,
          "",
          "Start or fix the Signal helper, then try this URL again. OpenClaw will not save this setup until the server check passes.",
        ].join("\n"),
        params.title,
      );
    } catch (error) {
      progress.stop();
      await params.prompter.note(
        [
          `OpenClaw could not check the Signal server at ${httpUrl}.`,
          `Error: ${String(error)}`,
          "",
          "Start or fix the Signal helper, then try this URL again. OpenClaw will not save this setup until the server check passes.",
        ].join("\n"),
        params.title,
      );
    }

    const retry = await params.prompter.confirm({
      message: "Try the Signal server URL again?",
      initialValue: true,
    });
    if (!retry) {
      return null;
    }
    params.initialValue = httpUrl;
  }
}

async function promptSignalAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return promptParsedAllowFromForAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    defaultAccountId: resolveDefaultSignalAccountId(params.cfg),
    prompter: params.prompter,
    noteTitle: t("wizard.signal.allowlistTitle"),
    noteLines: [
      t("wizard.signal.allowlistIntro"),
      "Use phone numbers in international format, or uuid:... if Signal only exposes a sender UUID.",
      "Use * only if you want to allow anyone.",
      "Examples:",
      `- ${SIGNAL_PHONE_NUMBER_EXAMPLE}`,
      "- uuid:123e4567-e89b-12d3-a456-426614174000",
      "- *",
      t("wizard.signal.multipleEntries"),
      `Docs: ${formatDocsLink("/signal", "signal")}`,
    ],
    message: t("wizard.signal.allowFromPrompt"),
    placeholder: `${SIGNAL_PHONE_NUMBER_EXAMPLE}, uuid:123e4567-e89b-12d3-a456-426614174000`,
    parseEntries: parseSignalAllowFromEntries,
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveSignalAccount({ cfg, accountId }).config.allowFrom ?? [],
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setAccountAllowFromForChannel({
        cfg,
        channel,
        accountId,
        allowFrom,
      }),
  });
}

export const signalDmPolicy = {
  label: "Signal",
  channel,
  policyKey: "channels.signal.dmPolicy",
  allowFromKey: "channels.signal.allowFrom",
  resolveConfigKeys: (cfg: OpenClawConfig, accountId?: string) =>
    (accountId ?? resolveDefaultSignalAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.dmPolicy`,
          allowFromKey: `channels.signal.accounts.${accountId ?? resolveDefaultSignalAccountId(cfg)}.allowFrom`,
        }
      : {
          policyKey: "channels.signal.dmPolicy",
          allowFromKey: "channels.signal.allowFrom",
        },
  getCurrent: (cfg: OpenClawConfig, accountId?: string) =>
    resolveSignalAccount({ cfg, accountId: accountId ?? resolveDefaultSignalAccountId(cfg) }).config
      .dmPolicy ?? "pairing",
  setPolicy: (
    cfg: OpenClawConfig,
    policy: "pairing" | "allowlist" | "open" | "disabled",
    accountId?: string,
  ) =>
    patchChannelConfigForAccount({
      cfg,
      channel,
      accountId: accountId ?? resolveDefaultSignalAccountId(cfg),
      patch:
        policy === "open"
          ? {
              dmPolicy: "open",
              allowFrom: mergeAllowFromEntries(
                resolveSignalAccount({
                  cfg,
                  accountId: accountId ?? resolveDefaultSignalAccountId(cfg),
                }).config.allowFrom,
                ["*"],
              ),
            }
          : { dmPolicy: policy },
    }),
  promptAllowFrom: promptSignalAllowFrom,
};

function resolveSignalCliPath(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, unknown>;
}) {
  if (resolveSignalSetupTransportFromCredentialValues(params) !== "native") {
    return undefined;
  }
  return (
    (typeof params.credentialValues.cliPath === "string"
      ? params.credentialValues.cliPath
      : undefined) ??
    resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config.cliPath ??
    "signal-cli"
  );
}

export function createSignalCliPathTextInput(
  shouldPrompt: NonNullable<ChannelSetupWizardTextInput["shouldPrompt"]>,
): ChannelSetupWizardTextInput {
  return {
    ...createCliPathTextInput({
      inputKey: "cliPath",
      message: "signal-cli path",
      helpTitle: "signal-cli path",
      helpLines: [
        "This is the command OpenClaw runs for local signal-cli setup.",
        "Use the full path if it is not on PATH, for example /opt/homebrew/bin/signal-cli.",
      ],
      resolvePath: ({ cfg, accountId, credentialValues }) =>
        resolveSignalCliPath({ cfg, accountId, credentialValues }),
      shouldPrompt,
    }),
    applySet: ({ cfg, accountId, value }) =>
      patchSignalSetupConfigForAccount({
        cfg,
        accountId,
        patch: { cliPath: normalizeOptionalString(value) ?? "signal-cli" },
      }),
  };
}

export const signalNumberTextInput: ChannelSetupWizardTextInput = {
  inputKey: "signalNumber",
  message: t("wizard.signal.botNumberPrompt"),
  placeholder: SIGNAL_PHONE_NUMBER_EXAMPLE,
  helpTitle: "Signal phone number",
  helpLines: [
    "Enter the phone number for the Signal account OpenClaw will use.",
    `Use international format with + and country code, for example ${SIGNAL_PHONE_NUMBER_EXAMPLE}.`,
  ],
  currentValue: ({ cfg, accountId }) =>
    normalizeSignalAccountInput(resolveSignalAccount({ cfg, accountId }).config.account) ??
    undefined,
  shouldPrompt: ({ cfg, accountId, credentialValues }) =>
    resolveSignalSetupTransportFromCredentialValues({ cfg, accountId, credentialValues }) !==
    "external-native",
  keepPrompt: (value) => t("wizard.signal.accountKeep", { value }),
  validate: ({ value }) =>
    normalizeSignalAccountInput(value)
      ? undefined
      : `Enter a Signal phone number in international format, for example ${SIGNAL_PHONE_NUMBER_EXAMPLE}.`,
  normalizeValue: ({ value }) => normalizeSignalAccountInput(value) ?? value,
};

export const signalCompletionNote: NonNullable<ChannelSetupWizard["completionNote"]> = {
  title: t("wizard.signal.nextStepsTitle"),
  lines: [
    "Signal uses a real Signal account/device, not a Telegram-style token bot account.",
    "Use a dedicated Signal number for bot-like operation when possible.",
    t("wizard.signal.nextLinkDevice"),
    t("wizard.signal.nextScanQr"),
    `Then run: ${SIGNAL_STATUS_PROBE_COMMAND}`,
    `Docs: ${formatDocsLink("/signal", "signal")}`,
  ],
  shouldShow: (params) => params.credentialValues[SIGNAL_SETUP_CANCELLED_KEY] !== "true",
};

const signalSetupBaseAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: createSetupInputPresenceValidator({
    validate: ({ cfg, accountId, input }) => {
      const account =
        normalizeSignalAccountInput(input.signalNumber) ??
        normalizeOptionalString(resolveSignalAccount({ cfg, accountId }).config.account);
      const hasServerInput = Boolean(
        normalizeOptionalString(input.httpUrl) ||
        normalizeOptionalString(input.httpHost) ||
        input.httpPort != null ||
        normalizeOptionalString(input.cliPath),
      );
      if (!account && !hasServerInput) {
        return "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.";
      }
      return null;
    },
  }),
  buildPatch: (input) => buildSignalSetupPatch(input),
});

export const signalSetupAdapter: ChannelSetupAdapter = {
  ...signalSetupBaseAdapter,
  applyAccountConfig: (params) => {
    const patch = buildSignalSetupPatchForAccount(params);
    const named =
      signalSetupBaseAdapter.applyAccountName?.({
        cfg: params.cfg,
        accountId: params.accountId,
        name: params.input.name,
      }) ?? params.cfg;
    if (
      !shouldScopeDefaultSignalSetupPatch({
        cfg: params.cfg,
        accountId: params.accountId,
      })
    ) {
      return patchChannelConfigForAccount({
        cfg: named,
        channel,
        accountId: params.accountId,
        patch,
      });
    }
    return patchSignalSetupConfigForAccount({
      cfg: named,
      accountId: params.accountId,
      patch,
    });
  },
};

export async function prepareSignalSetupWizard(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, string | undefined>;
  runtime: Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0]["runtime"];
  prompter: WizardPrompter;
  options?: Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0]["options"];
}) {
  await params.prompter.note(
    [
      "Signal uses a real Signal account with a phone number, not a bot token.",
      "",
      "It is usually best to give OpenClaw its own Signal account and phone number. That keeps OpenClaw messages separate from your personal Signal messages.",
    ].join("\n"),
    "Signal",
  );
  let initialValue = resolveSignalSetupChoiceFromConfig(params);
  const baseCredentialValues: Record<string, string | undefined> = {
    ...params.credentialValues,
    [SIGNAL_SETUP_ORIGINAL_CHANNEL_KEY]: serializeSignalSetupOriginalChannel(params.cfg),
  };

  while (true) {
    const transport = await params.prompter.select<SignalSetupTransport>({
      message: "How do you want to set up Signal for OpenClaw?",
      initialValue,
      options: [
        {
          value: "native",
          label: "Use local signal-cli",
          hint: "OpenClaw starts the local signal-cli daemon for this account.",
        },
        {
          value: "external-native",
          label: "Connect to an existing Signal server",
          hint: "OpenClaw stores the URL and auto-detects the server protocol.",
        },
      ],
    });

    const credentialValues: Record<string, string | undefined> = {
      ...baseCredentialValues,
      [SIGNAL_SETUP_TRANSPORT_KEY]: transport,
    };

    if (transport !== "native" || !params.options?.allowSignalInstall) {
      return { credentialValues };
    }

    const currentCliPath =
      (typeof credentialValues.cliPath === "string" ? credentialValues.cliPath : undefined) ??
      resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config.cliPath ??
      "signal-cli";
    const { detectBinary } = await import("openclaw/plugin-sdk/setup-tools");
    const cliDetected = await detectBinary(currentCliPath);
    const wantsInstall = await params.prompter.confirm({
      message: cliDetected ? t("wizard.signal.reinstallPrompt") : t("wizard.signal.installPrompt"),
      initialValue: !cliDetected,
    });
    if (!wantsInstall) {
      return { credentialValues };
    }
    try {
      const { installSignalCli } = await import("./install-signal-cli.js");
      const result = await installSignalCli(params.runtime);
      if (result.ok && result.cliPath) {
        await params.prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
        return {
          credentialValues: {
            ...credentialValues,
            cliPath: result.cliPath,
          },
        };
      }
      if (!result.ok) {
        await params.prompter.note(result.error ?? "signal-cli install failed.", "Signal");
      }
    } catch (error) {
      await params.prompter.note(`signal-cli install failed: ${String(error)}`, "Signal");
    }
    initialValue = "native";
  }
}

export async function finalizeSignalSetupWizard(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: Record<string, string | undefined>;
  prompter: WizardPrompter;
}) {
  const transport = resolveSignalSetupTransportFromCredentialValues(params);
  let next = params.cfg;
  if (transport === "native") {
    const existingAccount = resolveSignalAccount({ cfg: next, accountId: params.accountId }).config;
    const existingConfigPath = normalizeOptionalString(existingAccount.configPath);
    const account =
      normalizeSignalAccountInput(params.credentialValues.signalNumber) ??
      normalizeOptionalString(existingAccount.account);
    if (!account) {
      await params.prompter.note(
        "Signal setup was not saved. Enter a Signal phone number before saving setup.",
        "Signal account",
      );
      return {
        cfg: restoreSignalSetupOriginalChannel({
          cfg: next,
          credentialValues: params.credentialValues,
        }),
        credentialValues: { [SIGNAL_SETUP_CANCELLED_KEY]: "true" },
      };
    }
    await params.prompter.note(
      [
        "Optional. This is the folder where signal-cli stores its local account data.",
        "Leave it blank unless you use a custom signal-cli data directory.",
        "Example: ~/.local/share/signal-cli",
      ].join("\n"),
      "signal-cli config path",
    );
    const configPath = normalizeOptionalString(
      await params.prompter.text({
        message: "signal-cli config path (optional)",
        initialValue: existingConfigPath,
        placeholder: "~/.local/share/signal-cli",
      }),
    );
    const scopeDefaultToAccount = shouldScopeDefaultSignalSetupPatch({
      cfg: next,
      accountId: params.accountId,
    });
    next = patchSignalSetupConfigForAccount({
      cfg: next,
      accountId: params.accountId,
      patch: buildNativeSignalSetupPatch({
        accountId: params.accountId,
        scopeDefaultToAccount,
        existingApiMode: existingAccount.apiMode,
        existingHttpHost: normalizeOptionalString(existingAccount.httpHost),
        existingHttpPort: existingAccount.httpPort,
        existingHttpUrl: normalizeOptionalString(existingAccount.httpUrl),
        account,
        cliPath:
          normalizeOptionalString(params.credentialValues.cliPath) ??
          normalizeOptionalString(existingAccount.cliPath),
        configPath,
      }),
    });
    return { cfg: next };
  }

  await params.prompter.note(
    [
      "Use the HTTP URL for the Signal helper OpenClaw should talk to.",
      "For a local helper, this usually looks like http://127.0.0.1:8080.",
      "Setup checks native servers for daemon/RPC reachability. Container servers are also checked for a linked account and receive endpoint readiness.",
    ].join("\n"),
    "Signal server URL",
  );
  const resolvedAccount = resolveSignalAccount({ cfg: next, accountId: params.accountId });
  const credentialAccount = normalizeSignalAccountInput(params.credentialValues.signalNumber);
  const existingAccount = normalizeSignalAccountInput(resolvedAccount.config.account);
  const account = normalizeSignalAccountInput(
    await params.prompter.text({
      message: "Signal phone number",
      initialValue: credentialAccount ?? existingAccount ?? undefined,
      placeholder: SIGNAL_PHONE_NUMBER_EXAMPLE,
      validate: (value) =>
        normalizeSignalAccountInput(value)
          ? undefined
          : `Enter a Signal phone number in international format, for example ${SIGNAL_PHONE_NUMBER_EXAMPLE}.`,
    }),
  );
  if (!account) {
    await params.prompter.note(
      "Signal server URL was not saved. Enter a Signal phone number before saving setup.",
      "Signal account",
    );
    return {
      cfg: restoreSignalSetupOriginalChannel({
        cfg: next,
        credentialValues: params.credentialValues,
      }),
      credentialValues: { [SIGNAL_SETUP_CANCELLED_KEY]: "true" },
    };
  }
  const httpUrl = await promptReachableSignalServerUrl({
    prompter: params.prompter,
    title: "Signal server URL",
    message: "Signal server URL",
    initialValue:
      normalizeOptionalString(resolvedAccount.config.httpUrl) ?? resolvedAccount.baseUrl,
    placeholder: "http://127.0.0.1:8080",
    account,
    apiMode: "auto",
  });
  if (!httpUrl) {
    await params.prompter.note(
      "Signal server URL was not saved. Start or fix the Signal helper, then run setup again.",
      "Signal server URL",
    );
    return {
      cfg: restoreSignalSetupOriginalChannel({
        cfg: next,
        credentialValues: params.credentialValues,
      }),
      credentialValues: { [SIGNAL_SETUP_CANCELLED_KEY]: "true" },
    };
  }
  next = patchSignalSetupConfigForAccount({
    cfg: next,
    accountId: params.accountId,
    patch: {
      ...(account ? { account } : {}),
      httpUrl,
      autoStart: false,
      apiMode: "auto",
    },
  });
  return { cfg: next };
}

export function createSignalSetupWizardProxy(loadWizard: () => Promise<ChannelSetupWizard>) {
  return createDelegatedSetupWizardProxy({
    channel,
    loadWizard,
    status: {
      configuredLabel: t("wizard.channels.statusConfigured"),
      unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
      configuredHint: t("wizard.channels.statusSignalCliFound"),
      unconfiguredHint: t("wizard.channels.statusSignalCliMissing"),
      configuredScore: 1,
      unconfiguredScore: 0,
    },
    delegatePrepare: true,
    delegateFinalize: true,
    credentials: [],
    textInputs: [
      createSignalCliPathTextInput(
        createDelegatedTextInputShouldPrompt({
          loadWizard,
          inputKey: "cliPath",
        }),
      ),
      signalNumberTextInput,
    ],
    completionNote: signalCompletionNote,
    dmPolicy: signalDmPolicy,
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
  });
}
