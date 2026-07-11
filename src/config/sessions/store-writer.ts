// Session store writes are serialized per store path to avoid lost updates.
import path from "node:path";
import { runQueuedStoreWrite } from "../../shared/store-writer-queue.js";
import { resolveCanonicalSessionStorePath } from "./paths.js";
import { WRITER_QUEUES } from "./store-writer-state.js";

export type RunExclusiveSessionStoreWriteOptions = {
  reentrant?: boolean;
};

export async function runExclusiveSessionStoreWrite<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: RunExclusiveSessionStoreWriteOptions = {},
): Promise<T> {
  // The writer is a physical-store critical section. Resolve aliases before
  // queue and reentrancy lookup so symlinked paths cannot write concurrently.
  const writerScope = path.isAbsolute(storePath)
    ? resolveCanonicalSessionStorePath(storePath)
    : storePath;
  return await runQueuedStoreWrite({
    queues: WRITER_QUEUES,
    storePath: writerScope,
    label: "runExclusiveSessionStoreWrite",
    fn,
    reentrant: opts.reentrant,
  });
}
