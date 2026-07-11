// Serializes lifecycle mutations and work admission for logical session identities.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { resolveCanonicalSessionStorePath } from "../config/sessions/paths.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  GatewayDrainingError,
  isGatewaySubordinateWorkAdmissionClosed,
} from "../process/gateway-work-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";

export const SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS = 15_000;
type SessionWorkBarrierOwnerGrant = {
  isActive: () => boolean;
  owner: object;
};

declare const SESSION_WORK_ADMISSION_BARRIER_GRANT: unique symbol;
/** Opaque one-shot capability issued by the barrier that owns one admitted run. */
export type SessionWorkAdmissionBarrierGrant = {
  readonly [SESSION_WORK_ADMISSION_BARRIER_GRANT]: true;
};

type SessionWorkAdmissionBarrierGrantState = SessionWorkBarrierOwnerGrant & {
  consumed: boolean;
  identities: readonly string[];
};

type SessionWorkAdmission = {
  barrierOwnerGrant?: SessionWorkBarrierOwnerGrant;
  interrupt?: () => void;
  isReleased?: boolean;
  released: Promise<void>;
};

type SessionWorkAdmissionRunContext = {
  active: boolean;
  admission: SessionWorkAdmission;
  barrierOwnerGrant?: SessionWorkBarrierOwnerGrant;
};

type CurrentSessionWorkAdmission = SessionWorkAdmission | SessionWorkAdmissionRunContext;

type SessionLifecycleAdmissionState = {
  lifecycleQueues: Map<string, StoreWriterQueue>;
  mutationQueues: Map<string, StoreWriterQueue>;
  activeAdmissions: Map<string, Set<SessionWorkAdmission>>;
  activeMutations: Map<string, number>;
  activeMutationRuns?: Set<object>;
  activeMutationKinds: Map<string, Map<SessionLifecycleMutationKind, number>>;
  idleWaiters: Map<string, Set<() => void>>;
  currentAdmissions: AsyncLocalStorage<ReadonlySet<CurrentSessionWorkAdmission>>;
  durableBarriers?: Map<string, Set<object>>;
};

export type SessionLifecycleMutationKind = "compaction";

// Runtime chunks can load separate module instances while still coordinating
// the same sessions. One shared state keeps every lock and admission visible.
const SESSION_LIFECYCLE_ADMISSION_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionLifecycleAdmissionState"),
  (): SessionLifecycleAdmissionState => ({
    lifecycleQueues: new Map(),
    mutationQueues: new Map(),
    activeAdmissions: new Map(),
    activeMutations: new Map(),
    activeMutationRuns: new Set(),
    activeMutationKinds: new Map(),
    idleWaiters: new Map(),
    currentAdmissions: new AsyncLocalStorage(),
    durableBarriers: new Map(),
  }),
);
const {
  lifecycleQueues: SESSION_LIFECYCLE_QUEUES,
  mutationQueues: SESSION_LIFECYCLE_MUTATION_QUEUES,
  activeAdmissions: ACTIVE_SESSION_WORK_ADMISSIONS,
  activeMutations: ACTIVE_SESSION_LIFECYCLE_MUTATIONS,
  activeMutationKinds: ACTIVE_SESSION_LIFECYCLE_MUTATION_KINDS,
  idleWaiters: SESSION_LIFECYCLE_IDLE_WAITERS,
  currentAdmissions: CURRENT_SESSION_WORK_ADMISSIONS,
} = SESSION_LIFECYCLE_ADMISSION_STATE;
// Older runtime chunks can create the shared state without this newer index.
const ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS =
  (SESSION_LIFECYCLE_ADMISSION_STATE.activeMutationRuns ??= new Set());
const ACTIVE_SESSION_WORK_BARRIERS = (SESSION_LIFECYCLE_ADMISSION_STATE.durableBarriers ??=
  new Map());
const SESSION_WORK_ADMISSION_BARRIER_GRANTS = resolveGlobalSingleton<
  WeakMap<object, SessionWorkAdmissionBarrierGrantState>
>(Symbol.for("openclaw.sessionLifecycleAdmission.barrierGrants"), () => new WeakMap());

export class SessionWorkAdmissionBlockedError extends Error {
  constructor() {
    super("session has unfinished durable work");
    this.name = "SessionWorkAdmissionBlockedError";
  }
}

export type SessionWorkAdmissionBarrier = {
  issueGrant: (params: { identities: Iterable<string | undefined> }) => {
    grant: SessionWorkAdmissionBarrierGrant;
    revoke: () => void;
  };
  release: () => void;
};

export type SessionWorkAdmissionLease = {
  release: () => void;
  run: <T>(run: () => Promise<T>) => Promise<T>;
};

function normalizeSessionScope(scope: string): string {
  const normalized = scope.trim();
  if (!normalized) {
    throw new Error("session lifecycle scope is required");
  }
  return path.isAbsolute(normalized) ? resolveCanonicalSessionStorePath(normalized) : normalized;
}

function normalizeSessionIdentities(
  scope: string,
  identities: Iterable<string | undefined>,
): string[] {
  const normalizedScope = normalizeSessionScope(scope);
  return Array.from(
    new Set(
      Array.from(identities, (identity) => identity?.trim()).filter(
        (identity): identity is string => Boolean(identity),
      ),
    ),
  )
    .map((identity) => JSON.stringify([normalizedScope, identity]))
    .toSorted();
}

function assertNoForeignSessionWorkBarrier(
  identities: readonly string[],
  owner: object | undefined,
): void {
  for (const identity of identities) {
    const barriers = ACTIVE_SESSION_WORK_BARRIERS.get(identity);
    if (barriers && [...barriers].some((candidate) => candidate !== owner)) {
      throw new SessionWorkAdmissionBlockedError();
    }
  }
}

function isSessionWorkAdmissionRunContext(
  value: CurrentSessionWorkAdmission,
): value is SessionWorkAdmissionRunContext {
  return "admission" in value;
}

function resolveInheritedSessionWorkBarrierOwner(): SessionWorkBarrierOwnerGrant | undefined {
  const current = CURRENT_SESSION_WORK_ADMISSIONS.getStore();
  if (!current) {
    return undefined;
  }
  // The newest run is the capability boundary. Never fall back to an outer
  // owner after that run ends or its lease releases.
  for (const entry of [...current].toReversed()) {
    if (!isSessionWorkAdmissionRunContext(entry)) {
      return undefined;
    }
    const { admission, barrierOwnerGrant } = entry;
    if (!entry.active || admission.isReleased || !barrierOwnerGrant?.isActive()) {
      return undefined;
    }
    return {
      owner: barrierOwnerGrant.owner,
      isActive: () => entry.active && !admission.isReleased && barrierOwnerGrant.isActive(),
    };
  }
  return undefined;
}

function collectCurrentSessionWorkAdmissions(): Set<SessionWorkAdmission> {
  const current = CURRENT_SESSION_WORK_ADMISSIONS.getStore();
  if (!current) {
    return new Set();
  }
  const contextualAdmissions = new Set<SessionWorkAdmission>();
  const activeAdmissions = new Set<SessionWorkAdmission>();
  for (const entry of current) {
    if (!isSessionWorkAdmissionRunContext(entry)) {
      continue;
    }
    contextualAdmissions.add(entry.admission);
    if (entry.active && !entry.admission.isReleased) {
      activeAdmissions.add(entry.admission);
    }
  }
  // Raw entries preserve coordination with older runtime chunks sharing this
  // AsyncLocalStorage. New entries are paired with a scoped context above.
  for (const entry of current) {
    if (!isSessionWorkAdmissionRunContext(entry) && !contextualAdmissions.has(entry)) {
      activeAdmissions.add(entry);
    }
  }
  return activeAdmissions;
}

function hasForeignSessionWorkAdmission(
  identities: readonly string[],
  admission: SessionWorkAdmission,
): boolean {
  for (const identity of identities) {
    const admissions = ACTIVE_SESSION_WORK_ADMISSIONS.get(identity);
    if (admissions && [...admissions].some((candidate) => candidate !== admission)) {
      return true;
    }
  }
  return false;
}

/**
 * Blocks fresh work for a durable turn while still allowing its named recovery owner.
 * The caller must release the barrier only after terminal or explicit cancellation state is durable.
 */
export function registerSessionWorkAdmissionBarrier(params: {
  scope: string;
  identities: Iterable<string | undefined>;
}): SessionWorkAdmissionBarrier {
  const identities = normalizeSessionIdentities(params.scope, params.identities);
  const owner = {};
  for (const identity of identities) {
    const barriers = ACTIVE_SESSION_WORK_BARRIERS.get(identity) ?? new Set();
    barriers.add(owner);
    ACTIVE_SESSION_WORK_BARRIERS.set(identity, barriers);
  }
  let released = false;
  return {
    issueGrant: (grantParams) => {
      if (released) {
        throw new SessionWorkAdmissionBlockedError();
      }
      const grantIdentities = normalizeSessionIdentities(params.scope, grantParams.identities);
      if (identities.some((identity) => !grantIdentities.includes(identity))) {
        throw new SessionWorkAdmissionBlockedError();
      }
      const grant = {} as SessionWorkAdmissionBarrierGrant;
      let revoked = false;
      SESSION_WORK_ADMISSION_BARRIER_GRANTS.set(grant, {
        consumed: false,
        identities: grantIdentities,
        isActive: () => !released && !revoked,
        owner,
      });
      return {
        grant,
        revoke: () => {
          revoked = true;
        },
      };
    },
    release: () => {
      if (released) {
        return;
      }
      released = true;
      for (const identity of identities) {
        const barriers = ACTIVE_SESSION_WORK_BARRIERS.get(identity);
        barriers?.delete(owner);
        if (!barriers?.size) {
          ACTIVE_SESSION_WORK_BARRIERS.delete(identity);
        }
      }
    },
  };
}

function consumeSessionWorkAdmissionBarrierGrant(
  grant: SessionWorkAdmissionBarrierGrant,
  identities: readonly string[],
): SessionWorkBarrierOwnerGrant {
  const state = SESSION_WORK_ADMISSION_BARRIER_GRANTS.get(grant);
  if (
    !state ||
    state.consumed ||
    !state.isActive() ||
    state.identities.length !== identities.length ||
    state.identities.some((identity, index) => identity !== identities[index])
  ) {
    throw new SessionWorkAdmissionBlockedError();
  }
  state.consumed = true;
  return { owner: state.owner, isActive: state.isActive };
}

function decodeSessionIdentity(
  normalizedIdentity: string,
): { scope: string; identity: string } | undefined {
  try {
    const decoded: unknown = JSON.parse(normalizedIdentity);
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      typeof decoded[1] !== "string"
    ) {
      return undefined;
    }
    return { scope: decoded[0], identity: decoded[1] };
  } catch {
    return undefined;
  }
}

async function runWithSessionIdentityLocks<T>(
  identities: readonly string[],
  index: number,
  run: () => Promise<T>,
): Promise<T> {
  const identity = identities[index];
  if (!identity) {
    return await run();
  }
  return await runQueuedStoreWrite({
    queues: SESSION_LIFECYCLE_QUEUES,
    storePath: identity,
    label: "runExclusiveSessionLifecycle",
    reentrant: true,
    fn: async () => await runWithSessionIdentityLocks(identities, index + 1, run),
  });
}

async function runWithSessionMutationIdentityLocks<T>(
  identities: readonly string[],
  index: number,
  run: () => Promise<T>,
): Promise<T> {
  const identity = identities[index];
  if (!identity) {
    return await run();
  }
  return await runQueuedStoreWrite({
    queues: SESSION_LIFECYCLE_MUTATION_QUEUES,
    storePath: identity,
    label: "runExclusiveSessionLifecycleMutation",
    reentrant: true,
    fn: async () => await runWithSessionMutationIdentityLocks(identities, index + 1, run),
  });
}

function hasActiveSessionLifecycleMutation(identities: readonly string[]): boolean {
  return identities.some((identity) => (ACTIVE_SESSION_LIFECYCLE_MUTATIONS.get(identity) ?? 0) > 0);
}

function hasOnlyActiveSessionLifecycleMutationKind(
  identities: readonly string[],
  kind: SessionLifecycleMutationKind,
): boolean {
  let foundActiveMutation = false;
  for (const identity of identities) {
    const activeCount = ACTIVE_SESSION_LIFECYCLE_MUTATIONS.get(identity) ?? 0;
    if (activeCount === 0) {
      continue;
    }
    foundActiveMutation = true;
    if ((ACTIVE_SESSION_LIFECYCLE_MUTATION_KINDS.get(identity)?.get(kind) ?? 0) !== activeCount) {
      return false;
    }
  }
  return foundActiveMutation;
}

async function waitForNormalizedSessionLifecycleMutationIdle(
  identities: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const activeIdentities = identities.filter(
    (identity) => (ACTIVE_SESSION_LIFECYCLE_MUTATIONS.get(identity) ?? 0) > 0,
  );
  if (activeIdentities.length === 0) {
    return;
  }
  signal?.throwIfAborted();
  const idle = Promise.all(
    activeIdentities.map(
      (identity) =>
        new Promise<void>((resolve) => {
          const waiters = SESSION_LIFECYCLE_IDLE_WAITERS.get(identity) ?? new Set();
          waiters.add(resolve);
          SESSION_LIFECYCLE_IDLE_WAITERS.set(identity, waiters);
        }),
    ),
  );
  if (!signal) {
    await idle;
    return;
  }
  let rejectAborted = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("session work admission aborted"),
      );
    signal.addEventListener("abort", rejectAborted, { once: true });
  });
  try {
    await Promise.race([idle, aborted]);
  } finally {
    signal.removeEventListener("abort", rejectAborted);
  }
}

export async function runExclusiveSessionLifecycle<T>(params: {
  scope: string;
  identities: Iterable<string | undefined>;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  const identities = normalizeSessionIdentities(params.scope, params.identities);
  while (true) {
    params.signal?.throwIfAborted();
    if (hasActiveSessionLifecycleMutation(identities)) {
      await waitForNormalizedSessionLifecycleMutationIdle(identities, params.signal);
      continue;
    }
    const attempt = await runWithSessionIdentityLocks(identities, 0, async () => {
      params.signal?.throwIfAborted();
      if (hasActiveSessionLifecycleMutation(identities)) {
        return { blocked: true as const };
      }
      return { blocked: false as const, value: await params.run() };
    });
    if (!attempt.blocked) {
      return attempt.value;
    }
    await waitForNormalizedSessionLifecycleMutationIdle(identities, params.signal);
  }
}

export async function runExclusiveSessionLifecycleMutation<T>(params: {
  scope: string;
  identities: Iterable<string | undefined>;
  kind?: SessionLifecycleMutationKind;
  /** Reserved for mutations that first durably cancel the exact blocked turn. */
  bypassDurableBarrier?: boolean;
  prepare?: () => Promise<void>;
  run: () => Promise<T>;
  signal?: AbortSignal;
}): Promise<T> {
  const identities = normalizeSessionIdentities(params.scope, params.identities);
  const signal = params.signal;
  signal?.throwIfAborted();
  const callerAdmissions = new Set(CURRENT_SESSION_WORK_ADMISSIONS.getStore());
  const mutationRun = {};
  let mutationActivated = false;
  let removeAbortListener = () => {};
  const mutation = runWithSessionMutationIdentityLocks(
    identities,
    0,
    async () =>
      await CURRENT_SESSION_WORK_ADMISSIONS.run(callerAdmissions, async () => {
        await runWithSessionIdentityLocks(identities, 0, async () => {
          signal?.throwIfAborted();
          if (!params.bypassDurableBarrier) {
            assertNoForeignSessionWorkBarrier(identities, undefined);
          }
          mutationActivated = true;
          removeAbortListener();
          ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS.add(mutationRun);
          for (const identity of identities) {
            ACTIVE_SESSION_LIFECYCLE_MUTATIONS.set(
              identity,
              (ACTIVE_SESSION_LIFECYCLE_MUTATIONS.get(identity) ?? 0) + 1,
            );
            if (params.kind) {
              const kinds = ACTIVE_SESSION_LIFECYCLE_MUTATION_KINDS.get(identity) ?? new Map();
              kinds.set(params.kind, (kinds.get(params.kind) ?? 0) + 1);
              ACTIVE_SESSION_LIFECYCLE_MUTATION_KINDS.set(identity, kinds);
            }
          }
        });
        // Cancellation may abandon a queued contender, but never an active
        // mutation whose caller must observe cleanup and completion.
        try {
          await params.prepare?.();
          return await runWithSessionIdentityLocks(identities, 0, params.run);
        } finally {
          await runWithSessionIdentityLocks(identities, 0, async () => {
            for (const identity of identities) {
              if (params.kind) {
                const kinds = ACTIVE_SESSION_LIFECYCLE_MUTATION_KINDS.get(identity);
                const remainingKindCount = (kinds?.get(params.kind) ?? 1) - 1;
                if (remainingKindCount > 0) {
                  kinds?.set(params.kind, remainingKindCount);
                } else {
                  kinds?.delete(params.kind);
                  if (kinds?.size === 0) {
                    ACTIVE_SESSION_LIFECYCLE_MUTATION_KINDS.delete(identity);
                  }
                }
              }
              const remaining = (ACTIVE_SESSION_LIFECYCLE_MUTATIONS.get(identity) ?? 1) - 1;
              if (remaining > 0) {
                ACTIVE_SESSION_LIFECYCLE_MUTATIONS.set(identity, remaining);
                continue;
              }
              ACTIVE_SESSION_LIFECYCLE_MUTATIONS.delete(identity);
              const waiters = SESSION_LIFECYCLE_IDLE_WAITERS.get(identity);
              SESSION_LIFECYCLE_IDLE_WAITERS.delete(identity);
              for (const resolve of waiters ?? []) {
                resolve();
              }
            }
            ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS.delete(mutationRun);
          });
        }
      }),
  );
  if (!signal) {
    return await mutation;
  }
  if (mutationActivated) {
    return await mutation;
  }
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => {
      if (mutationActivated) {
        return;
      }
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  try {
    return await Promise.race([mutation, aborted]);
  } finally {
    removeAbortListener();
  }
}

export function isSessionLifecycleMutationActive(
  scope: string,
  identities: Iterable<string | undefined>,
): boolean {
  return hasActiveSessionLifecycleMutation(normalizeSessionIdentities(scope, identities));
}

export function hasOnlySessionLifecycleMutationKindActive(
  scope: string,
  identities: Iterable<string | undefined>,
  kind: SessionLifecycleMutationKind,
): boolean {
  return hasOnlyActiveSessionLifecycleMutationKind(
    normalizeSessionIdentities(scope, identities),
    kind,
  );
}

export function isSessionWorkAdmissionActive(
  scope: string,
  identities: Iterable<string | undefined>,
): boolean {
  return normalizeSessionIdentities(scope, identities).some(
    (identity) =>
      (ACTIVE_SESSION_WORK_ADMISSIONS.get(identity)?.size ?? 0) > 0 ||
      (ACTIVE_SESSION_WORK_BARRIERS.get(identity)?.size ?? 0) > 0,
  );
}

/** Active session identities for one store/lifecycle scope. */
export function collectActiveSessionWorkAdmissionIdentities(scope: string): Set<string> {
  const normalizedScope = normalizeSessionScope(scope);
  const identities = new Set<string>();
  for (const [normalizedIdentity, admissions] of ACTIVE_SESSION_WORK_ADMISSIONS) {
    if (admissions.size === 0) {
      continue;
    }
    const decoded = decodeSessionIdentity(normalizedIdentity);
    if (decoded?.scope === normalizedScope) {
      identities.add(decoded.identity);
    }
  }
  for (const [normalizedIdentity, barriers] of ACTIVE_SESSION_WORK_BARRIERS) {
    if (barriers.size === 0) {
      continue;
    }
    const decoded = decodeSessionIdentity(normalizedIdentity);
    if (decoded?.scope === normalizedScope) {
      identities.add(decoded.identity);
    }
  }
  return identities;
}

/** Unique admitted turns; one lease can be indexed under several identities. */
export function getActiveSessionWorkAdmissionCount(): number {
  const admissions = new Set<SessionWorkAdmission>();
  for (const active of ACTIVE_SESSION_WORK_ADMISSIONS.values()) {
    for (const admission of active) {
      admissions.add(admission);
    }
  }
  return admissions.size;
}

/** Unique active lifecycle mutations; one run can be indexed under several identities. */
export function getActiveSessionLifecycleMutationCount(): number {
  if (ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS.size > 0) {
    return ACTIVE_SESSION_LIFECYCLE_MUTATION_RUNS.size;
  }
  // A mutation from an older loaded chunk may only populate the identity index.
  return ACTIVE_SESSION_LIFECYCLE_MUTATIONS.size > 0 ? 1 : 0;
}

export async function beginSessionWorkAdmission(params: {
  scope: string;
  identities: Iterable<string | undefined>;
  assertAllowed: () => Promise<void> | void;
  /** Final writer-ordered validation; the concurrency fact excludes this admission's own lease. */
  revalidateAllowed?: (facts: { hasConcurrentAdmissions: boolean }) => Promise<void> | void;
  onInterrupt?: () => void;
  signal?: AbortSignal;
  /** Opaque one-shot capability for the recovery turn that owns this barrier. */
  barrierGrant?: SessionWorkAdmissionBarrierGrant;
}): Promise<SessionWorkAdmissionLease> {
  if (isGatewaySubordinateWorkAdmissionClosed()) {
    throw new GatewayDrainingError();
  }
  const identities = normalizeSessionIdentities(params.scope, params.identities);
  const barrierOwnerGrant: SessionWorkBarrierOwnerGrant | undefined =
    params.barrierGrant === undefined
      ? resolveInheritedSessionWorkBarrierOwner()
      : consumeSessionWorkAdmissionBarrierGrant(params.barrierGrant, identities);
  const resolveBarrierOwner = () =>
    barrierOwnerGrant?.isActive() ? barrierOwnerGrant.owner : undefined;
  return await runExclusiveSessionLifecycle({
    scope: params.scope,
    identities: params.identities,
    signal: params.signal,
    run: async () => {
      assertNoForeignSessionWorkBarrier(identities, resolveBarrierOwner());
      await params.assertAllowed();
      assertNoForeignSessionWorkBarrier(identities, resolveBarrierOwner());
      // assertAllowed can yield while a host suspension acquires its fence.
      // Recheck immediately before registration to close that admission race.
      if (isGatewaySubordinateWorkAdmissionClosed()) {
        throw new GatewayDrainingError();
      }
      let resolveReleased = () => {};
      const admission: SessionWorkAdmission = {
        barrierOwnerGrant,
        interrupt: params.onInterrupt,
        isReleased: false,
        released: new Promise<void>((resolve) => {
          resolveReleased = resolve;
        }),
      };
      for (const identity of identities) {
        const active = ACTIVE_SESSION_WORK_ADMISSIONS.get(identity) ?? new Set();
        active.add(admission);
        ACTIVE_SESSION_WORK_ADMISSIONS.set(identity, active);
      }
      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        admission.isReleased = true;
        for (const identity of identities) {
          const active = ACTIVE_SESSION_WORK_ADMISSIONS.get(identity);
          active?.delete(admission);
          if (!active?.size) {
            ACTIVE_SESSION_WORK_ADMISSIONS.delete(identity);
          }
        }
        resolveReleased();
      };
      const lease: SessionWorkAdmissionLease = {
        release,
        run: async <T>(run: () => Promise<T>) => {
          const current = new Set(CURRENT_SESSION_WORK_ADMISSIONS.getStore());
          const context: SessionWorkAdmissionRunContext = {
            active: true,
            admission,
            barrierOwnerGrant: admission.barrierOwnerGrant,
          };
          // Keep the raw admission for older loaded chunks that share this ALS.
          current.add(admission);
          current.add(context);
          try {
            return await CURRENT_SESSION_WORK_ADMISSIONS.run(current, run);
          } finally {
            context.active = false;
          }
        },
      };
      const signal = params.signal;
      let writerBarrierStarted = false;
      let removeAbortListener = () => {};
      try {
        const queuedAbort = signal
          ? new Promise<never>((_, reject) => {
              const onAbort = () => {
                if (writerBarrierStarted) {
                  return;
                }
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("session work admission aborted"),
                );
              };
              removeAbortListener = () => signal.removeEventListener("abort", onAbort);
              signal.addEventListener("abort", onAbort, { once: true });
              if (signal.aborted) {
                onAbort();
              }
            })
          : undefined;
        // Register before crossing the writer barrier. Earlier maintenance then
        // either preserves this admission or commits first and fails revalidation.
        const writerBarrier = runExclusiveSessionStoreWrite(
          params.scope,
          async () => {
            writerBarrierStarted = true;
            params.signal?.throwIfAborted();
            assertNoForeignSessionWorkBarrier(identities, resolveBarrierOwner());
            if (params.revalidateAllowed) {
              await params.revalidateAllowed({
                hasConcurrentAdmissions: hasForeignSessionWorkAdmission(identities, admission),
              });
            } else {
              await params.assertAllowed();
            }
            assertNoForeignSessionWorkBarrier(identities, resolveBarrierOwner());
          },
          // Writer-owned rollover callbacks can open replacement admissions.
          // Reenter that lane or the writer waits on work queued behind itself.
          { reentrant: true },
        );
        await (queuedAbort ? Promise.race([writerBarrier, queuedAbort]) : writerBarrier);
        return lease;
      } catch (error) {
        release();
        throw error;
      } finally {
        removeAbortListener();
      }
    },
  });
}

export async function interruptSessionWorkAdmissions(params: {
  scope: string;
  identities: Iterable<string | undefined>;
  timeoutMs?: number;
}): Promise<boolean> {
  const admissions = new Set<SessionWorkAdmission>();
  const currentAdmissions = collectCurrentSessionWorkAdmissions();
  for (const identity of normalizeSessionIdentities(params.scope, params.identities)) {
    for (const admission of ACTIVE_SESSION_WORK_ADMISSIONS.get(identity) ?? []) {
      // In-band lifecycle commands suspend their own admitted turn while the
      // mutation runs. Interrupt competing work, not the initiating stack.
      if (currentAdmissions.has(admission)) {
        continue;
      }
      admissions.add(admission);
    }
  }
  for (const admission of admissions) {
    admission.interrupt?.();
  }
  const released = Promise.all(Array.from(admissions, (admission) => admission.released));
  if (params.timeoutMs === undefined) {
    await released;
    return true;
  }
  const timeoutMs = params.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      released.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
