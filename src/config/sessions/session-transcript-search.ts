// Session transcript search maintains the per-agent FTS index and bounded backfill.
import fsp from "node:fs/promises";
import path from "node:path";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  resolveStoredSessionKeyForAgentStore,
  resolveStoredSessionOwnerAgentId,
} from "../../gateway/session-store-key.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { parseSessionArchiveTimestamp } from "./artifacts.js";
import { resolveSessionFilePath } from "./paths.js";
import { loadSessionStore } from "./store.js";
import { resolveAgentSessionStoreTargetsSync } from "./targets.js";
import {
  isCanonicalSessionTranscriptEntry,
  isSessionTranscriptLeafControl,
  parseSessionTranscriptTreeEntry,
} from "./transcript-tree.js";

const log = createSubsystemLogger("sessions/search-index");
const INDEX_SLICE_MAX_BYTES = 1024 * 1024;
const INDEX_SLICE_MAX_LINES = 512;
const INDEX_READ_CHUNK_BYTES = 64 * 1024;
const INDEX_RECORD_MAX_BYTES = 256 * 1024;
const INDEX_RECORD_METADATA_BYTES = 64 * 1024;
const INDEX_BATCH_MAX_TEXT_BYTES = 1024 * 1024;
const SEARCH_SNIPPET_MAX_CHARS = 500;
const SEARCH_LIMIT_MAX = 25;
const SEARCH_QUERY_MAX_CHARS = 4096;

type SessionTranscriptCursorDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_transcript_files"
>;
type AgentDatabaseRegistry = Pick<OpenClawStateKyselyDatabase, "agent_databases">;
type TranscriptRebuildNodeDatabase = {
  session_transcript_rebuild_nodes: {
    is_invalid_leaf: number;
    is_leaf: number;
    message_id: string | null;
    node_id: string;
    parent_id: string | null;
    rebuild_id: string;
    role: "assistant" | "user" | null;
    text: string | null;
    timestamp: number | null;
  };
};

type TranscriptTarget = {
  sessionId: string;
  sessionKey: string;
  transcriptPath: string;
};

type IndexedMessage = {
  messageId: string;
  role: "assistant" | "user";
  text: string;
  timestamp: number;
};

type ParsedTranscriptEntry = {
  message?: IndexedMessage;
  record: Record<string, unknown>;
};

type TranscriptCursor = {
  indexed_bytes: number;
  leaf_id: string | null;
  mtime: number;
  path: string;
  session_key: string;
  size: number;
};

export type SessionTranscriptSearchHit = {
  sessionKey: string;
  sessionId: string;
  messageId: string;
  role: "assistant" | "user";
  timestamp: number;
  snippet: string;
  score: number;
};

export type SessionTranscriptSearchResult = {
  hits: SessionTranscriptSearchHit[];
  indexing: boolean;
  truncated: boolean;
};

const appendIndexQueue = new KeyedAsyncQueue();
const pendingAppendIndexes = new Set<Promise<void>>();
const pendingAppendIndexCounts = new Map<string, number>();
const transcriptOwnersByPath = new Map<string, { agentId: string; target: TranscriptTarget }>();
const transcriptGenerations = new Map<string, number>();
const rebuildTempStoreDatabases = new WeakSet<object>();
let nextRebuildId = 0;
const reconcileStates = new Map<
  string,
  { dirty: boolean; indexing: boolean; promise: Promise<void> }
>();

function readMessageText(message: unknown): IndexedMessage["text"] | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const record = message as { content?: unknown; role?: unknown; text?: unknown };
  if (record.role !== "user" && record.role !== "assistant") {
    return undefined;
  }
  if (typeof record.content === "string") {
    return record.content.trim() || undefined;
  }
  if (typeof record.text === "string") {
    return record.text.trim() || undefined;
  }
  if (!Array.isArray(record.content)) {
    return undefined;
  }
  const parts = record.content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return [];
    }
    const part = block as { text?: unknown; type?: unknown };
    if (part.type !== "text" && part.type !== "input_text" && part.type !== "output_text") {
      return [];
    }
    return typeof part.text === "string" && part.text.trim() ? [part.text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function parseTranscriptEntry(line: string): ParsedTranscriptEntry | undefined {
  try {
    const entry = JSON.parse(line) as Record<string, unknown> & {
      id?: unknown;
      message?: unknown;
      timestamp?: unknown;
      type?: unknown;
    };
    const message = ((): IndexedMessage | undefined => {
      if (entry.type !== "message" || typeof entry.id !== "string") {
        return undefined;
      }
      const value = entry.message as { role?: unknown } | undefined;
      const role = value?.role;
      if (role !== "user" && role !== "assistant") {
        return undefined;
      }
      const text = readMessageText(value);
      if (!text) {
        return undefined;
      }
      const timestamp =
        typeof entry.timestamp === "number"
          ? entry.timestamp
          : typeof entry.timestamp === "string"
            ? Date.parse(entry.timestamp)
            : Number.NaN;
      return {
        messageId: entry.id,
        role,
        text,
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      };
    })();
    return { record: entry, ...(message ? { message } : {}) };
  } catch {
    return undefined;
  }
}

async function readTranscriptSlice(params: {
  start: number;
  statSize: number;
  transcriptPath: string;
}): Promise<{ entries: ParsedTranscriptEntry[]; nextOffset: number }> {
  if (params.start >= params.statSize) {
    return { entries: [], nextOffset: params.statSize };
  }
  const handle = await fsp.open(params.transcriptPath, "r");
  const entries: ParsedTranscriptEntry[] = [];
  const chunks: Buffer[] = [];
  let recordBytes = 0;
  let recordPrefix = Buffer.alloc(0);
  let recordSuffix = Buffer.alloc(0);
  let oversized = false;
  let nextOffset = params.start;
  let lineCount = 0;

  const appendRecordBytes = (segment: Buffer): void => {
    if (segment.length === 0) {
      return;
    }
    recordBytes += segment.length;
    if (recordPrefix.length < INDEX_RECORD_METADATA_BYTES) {
      const needed = INDEX_RECORD_METADATA_BYTES - recordPrefix.length;
      recordPrefix = Buffer.concat([recordPrefix, segment.subarray(0, needed)]);
    }
    recordSuffix = Buffer.concat([recordSuffix, segment]).subarray(-INDEX_RECORD_METADATA_BYTES);
    if (oversized) {
      return;
    }
    if (recordBytes > INDEX_RECORD_MAX_BYTES) {
      oversized = true;
      chunks.length = 0;
      return;
    }
    chunks.push(Buffer.from(segment));
  };
  const finishRecord = (): void => {
    const entry = oversized
      ? parseOversizedTranscriptEntry(recordPrefix.toString("utf8"), recordSuffix.toString("utf8"))
      : parseTranscriptEntry(Buffer.concat(chunks).toString("utf8").replace(/\r$/u, ""));
    if (entry) {
      entries.push(entry);
    }
    chunks.length = 0;
    recordBytes = 0;
    recordPrefix = Buffer.alloc(0);
    recordSuffix = Buffer.alloc(0);
    oversized = false;
    lineCount += 1;
  };

  try {
    const buffer = Buffer.allocUnsafe(INDEX_READ_CHUNK_BYTES);
    let position = params.start;
    while (position < params.statSize) {
      const readLength = Math.min(buffer.length, params.statSize - position);
      const { bytesRead } = await handle.read(buffer, 0, readLength, position);
      if (bytesRead <= 0) {
        break;
      }
      let segmentStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) {
          continue;
        }
        appendRecordBytes(buffer.subarray(segmentStart, index));
        finishRecord();
        nextOffset = position + index + 1;
        segmentStart = index + 1;
        if (
          nextOffset - params.start >= INDEX_SLICE_MAX_BYTES ||
          lineCount >= INDEX_SLICE_MAX_LINES
        ) {
          return { entries, nextOffset };
        }
      }
      appendRecordBytes(buffer.subarray(segmentStart, bytesRead));
      position += bytesRead;
      if (position < params.statSize) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (position >= params.statSize) {
        break;
      }
    }
    if (recordBytes > 0) {
      finishRecord();
    }
    nextOffset = params.statSize;
  } finally {
    await handle.close();
  }
  return { entries, nextOffset };
}

function extractJsonString(source: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "u").exec(source);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    const value = JSON.parse(match[1]) as unknown;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function extractJsonNullableString(source: string, field: string): string | null | undefined {
  const nullMatch = new RegExp(`"${field}"\\s*:\\s*null`, "u").exec(source);
  return nullMatch ? null : extractJsonString(source, field);
}

function parseOversizedTranscriptEntry(
  prefix: string,
  suffix: string,
): ParsedTranscriptEntry | undefined {
  // Own transcripts serialize navigation metadata before message content. Keep only that bounded
  // prefix (plus the terminal side-append marker) so huge tool/image rows never reach JSON.parse.
  const beforeMessage = prefix.split(/"message"\s*:/u, 1)[0] ?? prefix;
  const type = extractJsonString(beforeMessage, "type");
  const id = extractJsonString(beforeMessage, "id");
  if (!type || !id) {
    return undefined;
  }
  const parentId = extractJsonNullableString(beforeMessage, "parentId");
  const targetId = extractJsonNullableString(beforeMessage, "targetId");
  const appendParentId = extractJsonNullableString(beforeMessage, "appendParentId");
  const sideAppend = /,"appendMode"\s*:\s*"side"\s*\}\s*$/u.test(suffix);
  return {
    record: {
      type,
      id,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(targetId !== undefined ? { targetId } : {}),
      ...(appendParentId !== undefined ? { appendParentId } : {}),
      ...(sideAppend ? { appendMode: "side" } : {}),
    },
  };
}

function readCursor(agentId: string, sessionId: string): TranscriptCursor | undefined {
  const database = openOpenClawAgentDatabase({ agentId });
  const db = getNodeSqliteKysely<SessionTranscriptCursorDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_transcript_files")
      .select(["indexed_bytes", "leaf_id", "mtime", "path", "session_key", "size"])
      .where("session_id", "=", sessionId),
  );
}

function writeTranscriptCursor(params: {
  agentId: string;
  nextOffset: number;
  leafId: string | null;
  stat: { mtimeMs: number; size: number };
  target: TranscriptTarget;
}): void {
  runOpenClawAgentWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<SessionTranscriptCursorDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("session_transcript_files")
          .values({
            session_id: params.target.sessionId,
            session_key: params.target.sessionKey,
            path: params.target.transcriptPath,
            indexed_bytes: params.nextOffset,
            leaf_id: params.leafId,
            mtime: Math.trunc(params.stat.mtimeMs),
            size: params.stat.size,
            updated_at: Date.now(),
          })
          .onConflict((conflict) =>
            conflict.column("session_id").doUpdateSet({
              session_key: params.target.sessionKey,
              path: params.target.transcriptPath,
              indexed_bytes: params.nextOffset,
              leaf_id: params.leafId,
              mtime: Math.trunc(params.stat.mtimeMs),
              size: params.stat.size,
              updated_at: Date.now(),
            }),
          ),
      );
    },
    { agentId: params.agentId },
  );
}

function writeTranscriptMessages(params: {
  agentId: string;
  messages: IndexedMessage[];
  target: TranscriptTarget;
}): void {
  if (params.messages.length === 0) {
    return;
  }
  runOpenClawAgentWriteTransaction(
    (database) => {
      // FTS5 virtual-table writes have no portable Kysely representation.
      const deleteMessage = database.db.prepare(
        "DELETE FROM session_transcript_fts WHERE session_id = ? AND message_id = ?",
      );
      const insertMessage = database.db.prepare(
        "INSERT INTO session_transcript_fts (text, session_key, session_id, message_id, role, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const message of params.messages) {
        deleteMessage.run(params.target.sessionId, message.messageId);
        insertMessage.run(
          message.text,
          params.target.sessionKey,
          params.target.sessionId,
          message.messageId,
          message.role,
          message.timestamp,
        );
      }
    },
    { agentId: params.agentId },
  );
}

function resetIndexedTranscript(agentId: string, sessionId: string): void {
  runOpenClawAgentWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<SessionTranscriptCursorDatabase>(database.db);
      database.db.prepare("DELETE FROM session_transcript_fts WHERE session_id = ?").run(sessionId);
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("session_transcript_files").where("session_id", "=", sessionId),
      );
    },
    { agentId },
  );
}

function writeTranscriptSlice(params: {
  agentId: string;
  messages: IndexedMessage[];
  nextOffset: number;
  leafId: string | null;
  stat: { mtimeMs: number; size: number };
  target: TranscriptTarget;
}): void {
  writeTranscriptMessages(params);
  writeTranscriptCursor(params);
}

function transcriptPathKey(transcriptPath: string): string {
  return path.resolve(transcriptPath);
}

function rememberTranscriptOwner(agentId: string, target: TranscriptTarget): string {
  const key = transcriptPathKey(target.transcriptPath);
  transcriptOwnersByPath.set(key, { agentId, target });
  return key;
}

type TranscriptRebuildNode = TranscriptRebuildNodeDatabase["session_transcript_rebuild_nodes"];
type AgentDatabase = ReturnType<typeof openOpenClawAgentDatabase>;

function prepareTranscriptRebuild(database: AgentDatabase, rebuildId: string): void {
  // Temp storage keeps branch metadata disk-backed and heap-bounded; the table is process-local
  // scratch state and is removed after the selected ancestry has been copied into FTS.
  if (!rebuildTempStoreDatabases.has(database.db)) {
    database.db.exec("PRAGMA temp_store = FILE");
    rebuildTempStoreDatabases.add(database.db);
  }
  database.db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS session_transcript_rebuild_nodes (
      rebuild_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      parent_id TEXT,
      is_leaf INTEGER NOT NULL,
      is_invalid_leaf INTEGER NOT NULL,
      message_id TEXT,
      role TEXT,
      text TEXT,
      timestamp INTEGER,
      PRIMARY KEY (rebuild_id, node_id)
    ) WITHOUT ROWID;
  `);
  const db = getNodeSqliteKysely<TranscriptRebuildNodeDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_transcript_rebuild_nodes").where("rebuild_id", "=", rebuildId),
  );
}

function readTranscriptRebuildNode(
  database: AgentDatabase,
  rebuildId: string,
  nodeId: string,
): TranscriptRebuildNode | undefined {
  const db = getNodeSqliteKysely<TranscriptRebuildNodeDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_transcript_rebuild_nodes")
      .selectAll()
      .where("rebuild_id", "=", rebuildId)
      .where("node_id", "=", nodeId),
  );
}

function writeTranscriptRebuildNode(database: AgentDatabase, node: TranscriptRebuildNode): void {
  const db = getNodeSqliteKysely<TranscriptRebuildNodeDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_transcript_rebuild_nodes")
      .values(node)
      .onConflict((conflict) =>
        conflict.columns(["rebuild_id", "node_id"]).doUpdateSet({
          parent_id: node.parent_id,
          is_leaf: node.is_leaf,
          is_invalid_leaf: node.is_invalid_leaf,
          message_id: node.message_id,
          role: node.role,
          text: node.text,
          timestamp: node.timestamp,
        }),
      ),
  );
}

function deleteTranscriptRebuild(database: AgentDatabase, rebuildId: string): void {
  const db = getNodeSqliteKysely<TranscriptRebuildNodeDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_transcript_rebuild_nodes").where("rebuild_id", "=", rebuildId),
  );
}

function resolveRebuildParentId(
  database: AgentDatabase,
  rebuildId: string,
  parentId: string | null,
): { valid: true; parentId: string | null } | { valid: false } {
  let currentId = parentId;
  const visited = new Set<string>();
  while (currentId !== null) {
    if (visited.has(currentId)) {
      // Duplicate control ids can create cycles in malformed transcripts; reject that entry
      // instead of blocking synchronous reconciliation forever.
      return { valid: false };
    }
    visited.add(currentId);
    const parent = readTranscriptRebuildNode(database, rebuildId, currentId);
    if (!parent || parent.is_leaf === 0) {
      return { valid: true, parentId: currentId };
    }
    currentId = parent.parent_id;
  }
  return { valid: true, parentId: null };
}

function isKnownRebuildNode(
  database: AgentDatabase,
  rebuildId: string,
  nodeId: string | null,
): boolean {
  if (nodeId === null) {
    return true;
  }
  const node = readTranscriptRebuildNode(database, rebuildId, nodeId);
  return Boolean(node && node.is_invalid_leaf === 0);
}

function stageTranscriptRebuildEntry(params: {
  appendParentId: string | null;
  database: AgentDatabase;
  entry: ParsedTranscriptEntry;
  leafId: string | null;
  rebuildId: string;
}): { appendParentId: string | null; leafId: string | null; nodeCount: number } {
  const { record } = params.entry;
  const explicitTreeEntry = parseSessionTranscriptTreeEntry(record);
  const invalidLeafControl = Boolean(
    explicitTreeEntry?.leafId !== undefined &&
    isSessionTranscriptLeafControl(record) &&
    (!isKnownRebuildNode(params.database, params.rebuildId, explicitTreeEntry.leafId) ||
      !isKnownRebuildNode(params.database, params.rebuildId, explicitTreeEntry.appendParentId)),
  );
  if (invalidLeafControl && explicitTreeEntry) {
    writeTranscriptRebuildNode(params.database, {
      rebuild_id: params.rebuildId,
      node_id: explicitTreeEntry.id,
      parent_id: record.parentId as string | null,
      is_leaf: 1,
      is_invalid_leaf: 1,
      message_id: null,
      role: null,
      text: null,
      timestamp: null,
    });
    return {
      appendParentId: params.appendParentId,
      leafId: params.leafId,
      nodeCount: 1,
    };
  }

  const parentlessId =
    isCanonicalSessionTranscriptEntry(record) &&
    !Object.hasOwn(record, "parentId") &&
    typeof record.id === "string" &&
    record.id.trim()
      ? record.id
      : undefined;
  if (!explicitTreeEntry && !parentlessId) {
    return { appendParentId: params.appendParentId, leafId: params.leafId, nodeCount: 0 };
  }
  const nodeId = explicitTreeEntry?.id ?? parentlessId;
  if (!nodeId) {
    return { appendParentId: params.appendParentId, leafId: params.leafId, nodeCount: 0 };
  }
  const appendMode = explicitTreeEntry?.appendMode ?? record.appendMode;
  const rawParentId = explicitTreeEntry?.parentId ?? params.leafId;
  const logicalParentId =
    explicitTreeEntry &&
    isCanonicalSessionTranscriptEntry(record) &&
    appendMode !== "side" &&
    rawParentId === params.appendParentId &&
    params.leafId !== params.appendParentId
      ? params.leafId
      : rawParentId;
  const parentResolution = isCanonicalSessionTranscriptEntry(record)
    ? resolveRebuildParentId(params.database, params.rebuildId, logicalParentId)
    : { valid: true as const, parentId: rawParentId };
  if (!parentResolution.valid) {
    return { appendParentId: params.appendParentId, leafId: params.leafId, nodeCount: 0 };
  }
  const message = params.entry.message;
  writeTranscriptRebuildNode(params.database, {
    rebuild_id: params.rebuildId,
    node_id: nodeId,
    parent_id: parentResolution.parentId,
    is_leaf: isSessionTranscriptLeafControl(record) ? 1 : 0,
    is_invalid_leaf: 0,
    message_id: message?.messageId ?? null,
    role: message?.role ?? null,
    text: message?.text ?? null,
    timestamp: message?.timestamp ?? null,
  });
  const nextLeafId =
    explicitTreeEntry?.leafId !== undefined
      ? explicitTreeEntry.leafId
      : isCanonicalSessionTranscriptEntry(record) && appendMode !== "side"
        ? nodeId
        : params.leafId;
  return {
    appendParentId: explicitTreeEntry?.appendParentId ?? nodeId,
    leafId: nextLeafId,
    nodeCount: 1,
  };
}

function buildIncrementalTranscriptIndex(
  entries: ParsedTranscriptEntry[],
  initialLeafId: string | null,
): { leafId: string | null; messages: IndexedMessage[] } | undefined {
  const messages: IndexedMessage[] = [];
  let leafId = initialLeafId;
  for (const entry of entries) {
    const { record } = entry;
    if (record.type === "session") {
      continue;
    }
    if (isSessionTranscriptLeafControl(record)) {
      return undefined;
    }
    const treeEntry = parseSessionTranscriptTreeEntry(record);
    if (treeEntry) {
      if (!isCanonicalSessionTranscriptEntry(record)) {
        return undefined;
      }
      if (treeEntry.appendMode === "side") {
        continue;
      }
      if (treeEntry.parentId !== leafId) {
        return undefined;
      }
      leafId = treeEntry.id;
      if (entry.message) {
        messages.push(entry.message);
      }
      continue;
    }
    if (!isCanonicalSessionTranscriptEntry(record)) {
      continue;
    }
    if (Object.hasOwn(record, "parentId")) {
      return undefined;
    }
    if (record.appendMode === "side") {
      continue;
    }
    if (typeof record.id !== "string" || !record.id) {
      return undefined;
    }
    leafId = record.id;
    if (entry.message) {
      messages.push(entry.message);
    }
  }
  return { leafId, messages };
}

async function rebuildTranscriptIndex(params: {
  agentId: string;
  generation: number;
  pathKey: string;
  stat: { mtimeMs: number; size: number };
  target: TranscriptTarget;
}): Promise<void> {
  const rebuildId = `${params.target.sessionId}:${params.generation}:${nextRebuildId++}`;
  const database = openOpenClawAgentDatabase({ agentId: params.agentId });
  prepareTranscriptRebuild(database, rebuildId);
  let appendParentId: string | null = null;
  let leafId: string | null = null;
  let nodeCount = 0;
  try {
    let offset = 0;
    while (offset < params.stat.size) {
      const slice = await readTranscriptSlice({
        start: offset,
        statSize: params.stat.size,
        transcriptPath: params.target.transcriptPath,
      });
      runOpenClawAgentWriteTransaction(
        () => {
          for (const entry of slice.entries) {
            const staged = stageTranscriptRebuildEntry({
              appendParentId,
              database,
              entry,
              leafId,
              rebuildId,
            });
            appendParentId = staged.appendParentId;
            leafId = staged.leafId;
            nodeCount += staged.nodeCount;
          }
        },
        { agentId: params.agentId },
      );
      if (slice.nextOffset <= offset) {
        break;
      }
      offset = slice.nextOffset;
      if (offset < params.stat.size) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    if ((transcriptGenerations.get(params.pathKey) ?? 0) !== params.generation) {
      return;
    }

    resetIndexedTranscript(params.agentId, params.target.sessionId);
    const messages: IndexedMessage[] = [];
    let messageBytes = 0;
    let currentId: string | null = leafId;
    let remainingNodes = nodeCount;
    while (currentId !== null && remainingNodes > 0) {
      const node = readTranscriptRebuildNode(database, rebuildId, currentId);
      if (!node) {
        break;
      }
      if (node.message_id && node.role && node.text !== null && node.timestamp !== null) {
        messages.push({
          messageId: node.message_id,
          role: node.role,
          text: node.text,
          timestamp: node.timestamp,
        });
        messageBytes += Buffer.byteLength(node.text);
      }
      if (messages.length >= INDEX_SLICE_MAX_LINES || messageBytes >= INDEX_BATCH_MAX_TEXT_BYTES) {
        if ((transcriptGenerations.get(params.pathKey) ?? 0) !== params.generation) {
          return;
        }
        writeTranscriptMessages({
          agentId: params.agentId,
          messages,
          target: params.target,
        });
        messages.length = 0;
        messageBytes = 0;
      }
      currentId = node.parent_id;
      remainingNodes -= 1;
    }
    if ((transcriptGenerations.get(params.pathKey) ?? 0) !== params.generation) {
      return;
    }
    writeTranscriptMessages({
      agentId: params.agentId,
      messages,
      target: params.target,
    });
    writeTranscriptCursor({
      agentId: params.agentId,
      nextOffset: params.stat.size,
      leafId,
      stat: params.stat,
      target: params.target,
    });
  } finally {
    deleteTranscriptRebuild(database, rebuildId);
  }
}

async function indexTranscriptToCurrent(params: {
  agentId: string;
  forceRebuild?: boolean;
  target: TranscriptTarget;
  trustedAppend?: boolean;
}): Promise<void> {
  const pathKey = rememberTranscriptOwner(params.agentId, params.target);
  const generation = transcriptGenerations.get(pathKey) ?? 0;
  const stat = await fsp.stat(params.target.transcriptPath);
  if (!stat.isFile()) {
    return;
  }
  const cursor = readCursor(params.agentId, params.target.sessionId);
  const fileMetadataChanged = Boolean(
    cursor && (cursor.size !== stat.size || cursor.mtime !== Math.trunc(stat.mtimeMs)),
  );
  const reset = Boolean(
    params.forceRebuild ||
    (cursor &&
      (cursor.path !== params.target.transcriptPath ||
        cursor.session_key !== params.target.sessionKey ||
        cursor.indexed_bytes > stat.size ||
        (!params.trustedAppend && fileMetadataChanged) ||
        (cursor.indexed_bytes === stat.size && fileMetadataChanged))),
  );
  if (!cursor || reset) {
    await rebuildTranscriptIndex({ ...params, generation, pathKey, stat });
    return;
  }
  if (cursor.indexed_bytes >= stat.size) {
    return;
  }
  if (stat.size - cursor.indexed_bytes > INDEX_SLICE_MAX_BYTES) {
    await rebuildTranscriptIndex({ ...params, generation, pathKey, stat });
    return;
  }
  let offset = cursor.indexed_bytes;
  let leafId = cursor.leaf_id;
  while (offset < stat.size) {
    const slice = await readTranscriptSlice({
      start: offset,
      statSize: stat.size,
      transcriptPath: params.target.transcriptPath,
    });
    const incremental = buildIncrementalTranscriptIndex(slice.entries, leafId);
    if (!incremental) {
      await rebuildTranscriptIndex({ ...params, generation, pathKey, stat });
      return;
    }
    if (slice.nextOffset <= offset || (transcriptGenerations.get(pathKey) ?? 0) !== generation) {
      return;
    }
    writeTranscriptSlice({
      agentId: params.agentId,
      messages: incremental.messages,
      nextOffset: slice.nextOffset,
      leafId: incremental.leafId,
      stat,
      target: params.target,
    });
    offset = slice.nextOffset;
    leafId = incremental.leafId;
  }
}

function trackIndexTask(agentId: string, pending: Promise<void>): void {
  pendingAppendIndexCounts.set(agentId, (pendingAppendIndexCounts.get(agentId) ?? 0) + 1);
  pendingAppendIndexes.add(pending);
  void pending.finally(() => {
    pendingAppendIndexes.delete(pending);
    const remaining = (pendingAppendIndexCounts.get(agentId) ?? 1) - 1;
    if (remaining > 0) {
      pendingAppendIndexCounts.set(agentId, remaining);
    } else {
      pendingAppendIndexCounts.delete(agentId);
    }
  });
}

function invalidateCompletedReconcile(agentId: string): void {
  const state = reconcileStates.get(agentId);
  if (state?.indexing) {
    state.dirty = true;
  } else {
    reconcileStates.delete(agentId);
  }
}

/** Queue append-path indexing without extending the transcript write critical path. */
export function queueSessionTranscriptIndex(params: {
  agentId?: string;
  config?: OpenClawConfig;
  forceRebuild?: boolean;
  sessionId?: string;
  sessionKey?: string;
  transcriptPath: string;
}): void {
  const sessionId = params.sessionId?.trim();
  const sessionKey = params.sessionKey?.trim();
  if (!sessionId || !sessionKey) {
    return;
  }
  const agentId =
    params.agentId?.trim() || resolveSessionAgentId({ sessionKey, config: params.config });
  const reconcileState = reconcileStates.get(agentId);
  if (reconcileState?.indexing) {
    // The reconcile snapshot may predate this append; force one later pass so stale orphan
    // cleanup cannot make the just-indexed session disappear permanently.
    reconcileState.dirty = true;
  }
  const pathKey = transcriptPathKey(params.transcriptPath);
  // Queue order follows transcript order; a failed task leaves its byte gap for the next task or
  // reconcile, while transcript persistence remains successful and latency-independent.
  const pending = appendIndexQueue
    .enqueue(pathKey, async () => {
      await indexTranscriptToCurrent({
        agentId,
        forceRebuild: params.forceRebuild,
        target: { sessionId, sessionKey, transcriptPath: params.transcriptPath },
        trustedAppend: true,
      });
    })
    .catch((error: unknown) => {
      invalidateCompletedReconcile(agentId);
      log.warn(
        `session transcript index append failed path=${JSON.stringify(params.transcriptPath)} error=${error instanceof Error ? error.message : String(error)}`,
      );
    });
  trackIndexTask(agentId, pending);
}

function deleteIndexedTranscript(agentId: string, sessionId: string): void {
  runOpenClawAgentWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<SessionTranscriptCursorDatabase>(database.db);
      // FTS5 deletes require the virtual table's raw SQLite statement.
      database.db.prepare("DELETE FROM session_transcript_fts WHERE session_id = ?").run(sessionId);
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("session_transcript_files").where("session_id", "=", sessionId),
      );
    },
    { agentId },
  );
}

function resolveArchivedSourcePath(transcriptPath: string): string | undefined {
  const fileName = path.basename(transcriptPath);
  for (const reason of ["bak", "reset", "deleted"] as const) {
    if (parseSessionArchiveTimestamp(fileName, reason) === null) {
      continue;
    }
    const markerIndex = transcriptPath.lastIndexOf(`.${reason}.`);
    return markerIndex > 0 ? transcriptPath.slice(0, markerIndex) : undefined;
  }
  return undefined;
}

function invalidateOwnedTranscript(pathKey: string): void {
  const owner = transcriptOwnersByPath.get(pathKey) ?? findPersistedTranscriptOwner(pathKey);
  if (!owner) {
    return;
  }
  transcriptOwnersByPath.set(pathKey, owner);
  transcriptGenerations.set(pathKey, (transcriptGenerations.get(pathKey) ?? 0) + 1);
  deleteIndexedTranscript(owner.agentId, owner.target.sessionId);
}

function findPersistedTranscriptOwner(
  pathKey: string,
): { agentId: string; target: TranscriptTarget } | undefined {
  // Archive events can precede this process's first reconcile. The shared registry is the durable
  // path to the owning per-agent cursor, so restart cannot leave retired FTS rows searchable.
  const stateDatabase = openOpenClawStateDatabase();
  const registry = getNodeSqliteKysely<AgentDatabaseRegistry>(stateDatabase.db);
  const databases = executeSqliteQuerySync(
    stateDatabase.db,
    registry
      .selectFrom("agent_databases")
      .select(["agent_id", "path"])
      .orderBy("agent_id")
      .orderBy("path"),
  ).rows;
  for (const registered of databases) {
    try {
      const agentDatabase = openOpenClawAgentDatabase({
        agentId: registered.agent_id,
        path: registered.path,
      });
      const db = getNodeSqliteKysely<SessionTranscriptCursorDatabase>(agentDatabase.db);
      const cursor = executeSqliteQueryTakeFirstSync(
        agentDatabase.db,
        db
          .selectFrom("session_transcript_files")
          .select(["session_id", "session_key", "path"])
          .where("path", "=", pathKey),
      );
      if (cursor) {
        return {
          agentId: registered.agent_id,
          target: {
            sessionId: cursor.session_id,
            sessionKey: cursor.session_key,
            transcriptPath: cursor.path,
          },
        };
      }
    } catch (error) {
      log.warn(
        `session transcript owner lookup failed agent=${registered.agent_id} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return undefined;
}

onInternalSessionTranscriptUpdate((update) => {
  if (!update.sessionFile) {
    return;
  }
  const updatePath = transcriptPathKey(update.sessionFile);
  const archivedSource = resolveArchivedSourcePath(updatePath);
  if (archivedSource) {
    // Reset/delete/compaction archives retire searchable rows immediately; the generation guard
    // prevents an already-running append task from restoring pre-mutation content afterward.
    invalidateOwnedTranscript(archivedSource);
    return;
  }
  const forceRebuild = update.mutation !== "append" && !update.messageId;
  const owner =
    transcriptOwnersByPath.get(updatePath) ??
    (update.target
      ? {
          agentId: update.target.agentId,
          target: {
            sessionId: update.target.sessionId,
            sessionKey: update.target.sessionKey,
            transcriptPath: updatePath,
          },
        }
      : forceRebuild
        ? findPersistedTranscriptOwner(updatePath)
        : undefined);
  if (!owner) {
    // SessionManager does not know the owning store key. Invalidate completed one-shot snapshots;
    // the next search performs a bounded reconcile instead of leaving a new session invisible.
    for (const [agentId, state] of reconcileStates) {
      if (state.indexing) {
        state.dirty = true;
      } else {
        reconcileStates.delete(agentId);
      }
    }
    return;
  }
  transcriptOwnersByPath.set(updatePath, owner);
  if (forceRebuild) {
    // Replacement events retire the old branch before the queued rebuild can yield, so searches
    // never expose content that the transcript already removed.
    invalidateOwnedTranscript(updatePath);
  }
  const pending = appendIndexQueue
    .enqueue(updatePath, async () => {
      await indexTranscriptToCurrent({
        ...owner,
        forceRebuild,
        trustedAppend: update.mutation === "append" || Boolean(update.messageId),
      });
    })
    .catch((error: unknown) => {
      invalidateCompletedReconcile(owner.agentId);
      log.warn(
        `session transcript mutation index failed path=${JSON.stringify(updatePath)} error=${error instanceof Error ? error.message : String(error)}`,
      );
    });
  trackIndexTask(owner.agentId, pending);
});

function collectTranscriptTargets(params: {
  agentId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): TranscriptTarget[] {
  const targetsByKey = new Map<string, { target: TranscriptTarget; updatedAt: number }>();
  const stores = resolveAgentSessionStoreTargetsSync(params.config, params.agentId, {
    env: params.env,
  });
  for (const storeTarget of stores) {
    const store = loadSessionStore(storeTarget.storePath, { skipCache: true });
    for (const [storedKey, entry] of Object.entries(store).toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!entry?.sessionId) {
        continue;
      }
      try {
        const ownerAgentId = resolveStoredSessionOwnerAgentId({
          cfg: params.config,
          agentId: params.agentId,
          sessionKey: storedKey,
        });
        if (ownerAgentId && ownerAgentId !== normalizeAgentId(params.agentId)) {
          continue;
        }
        const sessionKey = resolveStoredSessionKeyForAgentStore({
          cfg: params.config,
          agentId: params.agentId,
          sessionKey: storedKey,
        });
        const updatedAt = entry.updatedAt ?? 0;
        const existing = targetsByKey.get(sessionKey);
        if (existing && existing.updatedAt > updatedAt) {
          continue;
        }
        // Gateway reads select the freshest canonical-key row across duplicate stores; indexing
        // must make the same choice or stale shadow transcripts become searchable by that key.
        targetsByKey.set(sessionKey, {
          updatedAt,
          target: {
            sessionId: entry.sessionId,
            sessionKey,
            transcriptPath: resolveSessionFilePath(
              entry.sessionId,
              entry.sessionFile ? { sessionFile: entry.sessionFile } : undefined,
              { agentId: params.agentId, sessionsDir: path.dirname(storeTarget.storePath) },
            ),
          },
        });
      } catch {
        continue;
      }
    }
  }
  const targetsBySessionId = new Map<string, TranscriptTarget>();
  for (const { target } of targetsByKey.values()) {
    targetsBySessionId.set(target.sessionId, target);
  }
  return [...targetsBySessionId.values()];
}

function deleteOrphanedTranscripts(agentId: string, activeSessionIds: Set<string>): void {
  runOpenClawAgentWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<SessionTranscriptCursorDatabase>(database.db);
      const cursors = executeSqliteQuerySync(
        database.db,
        db.selectFrom("session_transcript_files").select(["session_id", "path"]),
      ).rows;
      const deleteFts = database.db.prepare(
        "DELETE FROM session_transcript_fts WHERE session_id = ?",
      );
      for (const cursor of cursors) {
        if (activeSessionIds.has(cursor.session_id)) {
          continue;
        }
        const pathKey = transcriptPathKey(cursor.path);
        transcriptOwnersByPath.delete(pathKey);
        transcriptGenerations.delete(pathKey);
        deleteFts.run(cursor.session_id);
        executeSqliteQuerySync(
          database.db,
          db.deleteFrom("session_transcript_files").where("session_id", "=", cursor.session_id),
        );
      }
    },
    { agentId },
  );
}

/** Reconcile all current store transcripts in bounded slices, then remove orphaned index rows. */
export async function reconcileSessionTranscriptIndex(params: {
  agentId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const targets = collectTranscriptTargets(params);
  let firstFailure: unknown;
  for (const target of targets) {
    const stat = await fsp.stat(target.transcriptPath).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    try {
      await appendIndexQueue.enqueue(transcriptPathKey(target.transcriptPath), async () => {
        await indexTranscriptToCurrent({ agentId: params.agentId, target });
      });
    } catch (error) {
      firstFailure ??= error;
      // One raced or unreadable transcript must not block later sessions or orphan cleanup.
      log.warn(
        `session transcript reconcile target failed path=${JSON.stringify(target.transcriptPath)} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const activeSessionIds = new Set<string>();
  for (const target of collectTranscriptTargets(params)) {
    const stat = await fsp.stat(target.transcriptPath).catch(() => null);
    if (stat?.isFile()) {
      activeSessionIds.add(target.sessionId);
    }
  }
  deleteOrphanedTranscripts(params.agentId, activeSessionIds);
  if (firstFailure) {
    // Reject after useful work completes so startReconcile drops its completed-state cache and
    // retries transiently failed transcripts on the next search.
    throw firstFailure;
  }
}

function startReconcile(params: {
  agentId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const existing = reconcileStates.get(params.agentId);
  if (existing) {
    return existing.indexing;
  }
  // One process-owned promise performs all filesystem reconciliation; completed searches read only
  // SQLite until the gateway restarts or an append event advances the index.
  const state = { dirty: false, indexing: true, promise: Promise.resolve() };
  state.promise = reconcileSessionTranscriptIndex(params)
    .catch((error: unknown) => {
      reconcileStates.delete(params.agentId);
      log.warn(
        `session transcript reconcile failed agent=${params.agentId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      const current = reconcileStates.get(params.agentId);
      if (current === state) {
        if (current.dirty) {
          reconcileStates.delete(params.agentId);
        } else {
          current.indexing = false;
        }
      }
    });
  reconcileStates.set(params.agentId, state);
  return true;
}

function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/u)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
}

/** Search the current per-agent FTS snapshot and start one background reconcile if needed. */
export function searchSessionTranscripts(params: {
  agentId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  query: string;
  sessionKeys?: string[];
}): SessionTranscriptSearchResult {
  const query = params.query.trim();
  if (!query) {
    throw new Error("query must not be empty");
  }
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new Error(`query must not exceed ${SEARCH_QUERY_MAX_CHARS} characters`);
  }
  const indexing =
    startReconcile(params) || (pendingAppendIndexCounts.get(params.agentId) ?? 0) > 0;
  const database = openOpenClawAgentDatabase({ agentId: params.agentId, env: params.env });
  const limit = Math.min(Math.max(1, params.limit ?? 10), SEARCH_LIMIT_MAX);
  const sessionKeys = params.sessionKeys ?? [];
  const whereSession =
    sessionKeys.length > 0 ? ` AND session_key IN (${sessionKeys.map(() => "?").join(", ")})` : "";
  // MATCH, snippet(), and bm25() are FTS5 primitives without a Kysely representation.
  const statement = database.db.prepare(`
    SELECT session_key, session_id, message_id, role, timestamp,
      snippet(session_transcript_fts, 0, '', '', ' … ', 48) AS snippet,
      bm25(session_transcript_fts) AS rank
    FROM session_transcript_fts
    WHERE session_transcript_fts MATCH ?${whereSession}
    ORDER BY rank ASC, timestamp DESC, message_id ASC
    LIMIT ?
  `);
  const values = [toFtsQuery(query), ...sessionKeys, limit + 1];
  const rows = statement.all(...values) as Array<{
    message_id: unknown;
    rank: unknown;
    role: unknown;
    session_id: unknown;
    session_key: unknown;
    snippet: unknown;
    timestamp: unknown;
  }>;
  const hits = rows.flatMap((row): SessionTranscriptSearchHit[] => {
    if (
      typeof row.session_key !== "string" ||
      typeof row.session_id !== "string" ||
      typeof row.message_id !== "string" ||
      (row.role !== "user" && row.role !== "assistant") ||
      typeof row.snippet !== "string"
    ) {
      return [];
    }
    const timestamp = typeof row.timestamp === "number" ? row.timestamp : Number(row.timestamp);
    const rank = typeof row.rank === "number" ? row.rank : Number(row.rank);
    return [
      {
        sessionKey: row.session_key,
        sessionId: row.session_id,
        messageId: row.message_id,
        role: row.role,
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        snippet:
          row.snippet.length > SEARCH_SNIPPET_MAX_CHARS
            ? `${truncateUtf16Safe(row.snippet, SEARCH_SNIPPET_MAX_CHARS)}…`
            : row.snippet,
        score: Number.isFinite(rank) ? -rank : 0,
      },
    ];
  });
  return { hits: hits.slice(0, limit), indexing, truncated: hits.length > limit };
}

/** Await queued append indexing in focused tests. */
export async function waitForSessionTranscriptIndexForTest(): Promise<void> {
  await Promise.all([...pendingAppendIndexes]);
}

/** Await active reconcile passes in focused tests. */
export async function waitForSessionTranscriptReconcileForTest(): Promise<void> {
  await Promise.all([...reconcileStates.values()].map((state) => state.promise));
}

/** Reset process-local reconcile state between focused tests. */
export function resetSessionTranscriptSearchForTest(): void {
  reconcileStates.clear();
  pendingAppendIndexes.clear();
  pendingAppendIndexCounts.clear();
  transcriptOwnersByPath.clear();
  transcriptGenerations.clear();
}
