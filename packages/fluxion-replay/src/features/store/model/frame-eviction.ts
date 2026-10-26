import { isQuotaExceededError } from "../../../shared/lib/is-quota-exceeded-error";

/** New schemas persist cleanup intent atomically; legacy schemas return a retry batch. */
export const GARBAGE_STORE = "video-garbage";
export interface Garbage {
  channelId: string;
  t: number;
}

/** Deletes the chunk files of `entries`; failures for absent files are ignored. */
export type RemoveChunkFiles = (entries: Garbage[]) => Promise<void>;

/** Metric rows carry `video: false`; video rows and pre-marker (legacy) rows may own a chunk. */
function garbageOf(frame: {
  channelId: string;
  t: number;
  video?: boolean;
}): Garbage | null {
  return frame.video === false ? null : { channelId: frame.channelId, t: frame.t };
}

/**
 * Delete up to `limit` rows older than `cutoff`. With a persistent outbox the
 * rows and their cleanup intents commit together. At quota that transaction
 * cannot commit (it writes the intents), so `removeFiles` deletes the chunks
 * first and the rows go in a delete-only transaction — the pre-0.13.3 order,
 * where a crash leaves rows pointing at missing files (read as absent), never
 * orphaned files.
 */
export async function deleteFrameBatch(
  db: IDBDatabase,
  cutoff: number,
  limit: number,
  removeFiles?: RemoveChunkFiles,
): Promise<Garbage[]> {
  const persistent = db.objectStoreNames.contains(GARBAGE_STORE);
  try {
    return await deleteRows(db, cutoff, limit, persistent);
  } catch (error) {
    if (!persistent || !removeFiles || !isQuotaExceededError(error)) throw error;
    await removeFiles(await oldestGarbage(db, cutoff, limit));
    await deleteRows(db, cutoff, limit, false);
    return [];
  }
}

function deleteRows(
  db: IDBDatabase,
  cutoff: number,
  limit: number,
  withIntents: boolean,
): Promise<Garbage[]> {
  const removed: Garbage[] = [];
  return new Promise<Garbage[]>((resolve, reject) => {
    const tx = db.transaction(
      withIntents ? ["frames", GARBAGE_STORE] : "frames",
      "readwrite",
    );
    const garbage = withIntents ? tx.objectStore(GARBAGE_STORE) : null;
    const req = tx
      .objectStore("frames")
      .index("by_t")
      .openCursor(IDBKeyRange.upperBound(cutoff, true));
    let deleted = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || deleted >= limit) return;
      const entry = garbageOf(cursor.value);
      if (entry) {
        removed.push(entry);
        garbage?.put(entry, [entry.channelId, entry.t]);
      }
      cursor.delete();
      deleted++;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(withIntents ? [] : removed);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/** The rows `deleteRows` would visit, read-only (reads need no quota). */
function oldestGarbage(
  db: IDBDatabase,
  cutoff: number,
  limit: number,
): Promise<Garbage[]> {
  return new Promise((resolve, reject) => {
    const out: Garbage[] = [];
    const req = db
      .transaction("frames")
      .objectStore("frames")
      .index("by_t")
      .openCursor(IDBKeyRange.upperBound(cutoff, true));
    let seen = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || seen >= limit) return resolve(out);
      const entry = garbageOf(cursor.value);
      if (entry) out.push(entry);
      seen++;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** An absent file, or a channel id OPFS cannot name (e.g. "/robot/odom"). */
export function isGone(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "NotFoundError")
  );
}

/** Remove `<root>/<channelId>/<t>.chunk`; resolves for absent files and unnameable channels. */
export function chunkRemover(root: FileSystemDirectoryHandle) {
  const directories = new Map<string, Promise<FileSystemDirectoryHandle | null>>();
  return async (channelId: string, t: number): Promise<void> => {
    let directory = directories.get(channelId);
    if (!directory) {
      directory = root.getDirectoryHandle(channelId).catch((error) => {
        if (isGone(error)) return null;
        throw error;
      });
      directories.set(channelId, directory);
    }
    const dir = await directory;
    try {
      await dir?.removeEntry(`${t}.chunk`);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  };
}

/**
 * Bounded cleanup. Persistent outboxes survive crashes; legacy retry batches
 * stay in memory. Each entry is independent: one that keeps failing stays
 * queued for a later pass without blocking (or failing) the others.
 */
export async function collectVideoGarbage(
  db: IDBDatabase,
  root: FileSystemDirectoryHandle,
  limit: number,
  protectedFrame: (channelId: string, t: number) => boolean = () => false,
  legacyGarbage: Garbage[] = [],
  legacyRoot: FileSystemDirectoryHandle | null = null,
): Promise<void> {
  const persistent = db.objectStoreNames.contains(GARBAGE_STORE);
  const entries = persistent
    ? await new Promise<Garbage[]>((resolve, reject) => {
        const req = db
          .transaction(GARBAGE_STORE)
          .objectStore(GARBAGE_STORE)
          .getAll(undefined, limit);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
    : legacyGarbage.slice(0, limit);
  if (entries.length === 0) return;
  const referenced = await new Promise<boolean[]>((resolve, reject) => {
    const tx = db.transaction("frames");
    const index = tx.objectStore("frames").index("by_channel_t");
    const found = entries.map(() => false);
    entries.forEach((entry, i) => {
      const req = index.count([entry.channelId, entry.t]);
      req.onsuccess = () => {
        found[i] = req.result > 0;
      };
    });
    tx.oncomplete = () => resolve(found);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
  const remove = chunkRemover(root);
  // Releases up to 0.13.2 wrote chunks at the origin root and reclaimed them
  // with their rows; do the same so an upgraded recording does not leak them.
  // New rows' timestamps never match those files, and an absent directory is
  // looked up once per channel.
  const removeLegacy = legacyRoot ? chunkRemover(legacyRoot) : null;
  const completed: Garbage[] = [];
  for (let offset = 0; offset < entries.length; offset += 64) {
    await Promise.all(
      entries.slice(offset, offset + 64).map(async (entry, i) => {
        if (protectedFrame(entry.channelId, entry.t)) return;
        try {
          if (!referenced[offset + i]) {
            await remove(entry.channelId, entry.t);
            await removeLegacy?.(entry.channelId, entry.t);
          }
          completed.push(entry);
        } catch {
          // Left queued: retried by a later pass.
        }
      }),
    );
  }
  if (!persistent) {
    const done = new Set(completed);
    const retained = legacyGarbage.filter((entry) => !done.has(entry));
    legacyGarbage.length = 0;
    for (const entry of retained) legacyGarbage.push(entry);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(GARBAGE_STORE, "readwrite");
    for (const entry of completed)
      tx.objectStore(GARBAGE_STORE).delete([entry.channelId, entry.t]);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
