// Canonical active-run identity shared by Gateway run registries.
// Execution ids stay process-private; public ids are the only client projection.

export type ActiveRunIdentity = Readonly<{
  executionRunId: string;
  publicRunId: string;
}>;

export type ActiveRunIdentityCarrier = {
  runIdentity?: ActiveRunIdentity;
};

export type IndexedActiveRun<T> = {
  entry: T;
  identity: ActiveRunIdentity;
};

/** Map-compatible active-run owner with stable execution and public indexes. */
export class ActiveRunRegistry<T extends ActiveRunIdentityCarrier> extends Map<string, T> {
  readonly #byIdentity = new Map<string, IndexedActiveRun<T>>();

  constructor(entries?: Iterable<readonly [string, T]> | null) {
    super();
    if (entries) {
      for (const [runId, entry] of entries) {
        this.set(runId, entry);
      }
    }
  }

  override set(executionRunId: string, entry: T): this {
    const identity = resolveActiveRunIdentity(executionRunId, entry);
    const executionOwner = this.#byIdentity.get(identity.executionRunId);
    if (executionOwner && executionOwner.identity.executionRunId !== identity.executionRunId) {
      throw new Error(
        `active run execution id is already a public alias: ${identity.executionRunId}`,
      );
    }
    const publicOwner = this.#byIdentity.get(identity.publicRunId);
    if (publicOwner && publicOwner.identity.executionRunId !== identity.executionRunId) {
      throw new Error(`active run public id is already registered: ${identity.publicRunId}`);
    }
    const previous = this.#byIdentity.get(identity.executionRunId);
    if (previous) {
      this.#byIdentity.delete(previous.identity.executionRunId);
      this.#byIdentity.delete(previous.identity.publicRunId);
    }
    super.set(identity.executionRunId, entry);
    const indexed = { entry, identity };
    this.#byIdentity.set(identity.executionRunId, indexed);
    this.#byIdentity.set(identity.publicRunId, indexed);
    return this;
  }

  override get(runId: string): T | undefined {
    return this.#byIdentity.get(runId.trim())?.entry;
  }

  override has(runId: string): boolean {
    return this.#byIdentity.has(runId.trim());
  }

  override delete(runId: string): boolean {
    const indexed = this.#byIdentity.get(runId.trim());
    if (!indexed) {
      return false;
    }
    this.#byIdentity.delete(indexed.identity.executionRunId);
    this.#byIdentity.delete(indexed.identity.publicRunId);
    return super.delete(indexed.identity.executionRunId);
  }

  override clear(): void {
    super.clear();
    this.#byIdentity.clear();
  }

  resolve(runId: string): IndexedActiveRun<T> | undefined {
    return this.#byIdentity.get(runId.trim());
  }
}

function normalizeRunId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

/** Build the immutable identity carried from run registration through client projection. */
export function createActiveRunIdentity(
  executionRunId: string,
  publicRunId?: string,
): ActiveRunIdentity {
  const execution = normalizeRunId(executionRunId);
  if (!execution) {
    throw new Error("active run execution id is required");
  }
  return {
    executionRunId: execution,
    publicRunId: normalizeRunId(publicRunId) ?? execution,
  };
}

/** Resolve a registration's canonical identity; ordinary runs use the execution id publicly. */
export function resolveActiveRunIdentity(
  executionRunId: string,
  carrier?: ActiveRunIdentityCarrier,
): ActiveRunIdentity {
  const registered = carrier?.runIdentity;
  if (!registered) {
    return createActiveRunIdentity(executionRunId);
  }
  // The map key is authoritative. Rebinding a carrier under another key must
  // never make cleanup target the previous execution capability.
  return createActiveRunIdentity(executionRunId, registered.publicRunId);
}

/** Ordered source/public aliases used for internal lookups and cleanup. */
export function activeRunIdentityAliases(identity: ActiveRunIdentity): readonly string[] {
  return identity.executionRunId === identity.publicRunId
    ? [identity.executionRunId]
    : [identity.executionRunId, identity.publicRunId];
}

/** Public-only wire projection. Internal execution ids never become fallback metadata. */
export function projectActiveRunIdentity(identity: ActiveRunIdentity): { runId: string } {
  return { runId: identity.publicRunId };
}

/** Resolve either an execution capability or its public alias to the owning run. */
export function resolveActiveRunByIdentity<T extends ActiveRunIdentityCarrier>(
  entries: ReadonlyMap<string, T>,
  runId: string,
): IndexedActiveRun<T> | undefined {
  if (entries instanceof ActiveRunRegistry) {
    return entries.resolve(runId);
  }
  const normalized = runId.trim();
  const direct = entries.get(normalized);
  return direct
    ? { entry: direct, identity: resolveActiveRunIdentity(normalized, direct) }
    : undefined;
}
