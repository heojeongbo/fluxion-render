/** Durable outbox: metadata deletion and file cleanup intent commit together. */
export const GARBAGE_STORE = "video-garbage";
interface Garbage {
  channelId: string;
  t: number;
  video?: boolean;
}

export async function deleteFrameBatch(
  db: IDBDatabase,
  cutoff: number,
  limit: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["frames", GARBAGE_STORE], "readwrite");
    const garbage = tx.objectStore(GARBAGE_STORE);
    const req = tx
      .objectStore("frames")
      .index("by_t")
      .openCursor(IDBKeyRange.upperBound(cutoff, true));
    let deleted = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || deleted >= limit) return;
      const frame = cursor.value as Garbage;
      if (frame.video !== false)
        garbage.put({ channelId: frame.channelId, t: frame.t }, [
          frame.channelId,
          frame.t,
        ]);
      cursor.delete();
      deleted++;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/** Retryable, bounded cleanup. A crash leaves the remaining outbox entries intact. */
export async function collectVideoGarbage(
  db: IDBDatabase,
  root: FileSystemDirectoryHandle,
  limit: number,
  protectedFrame: (channelId: string, t: number) => boolean = () => false,
): Promise<void> {
  const entries = await new Promise<Garbage[]>((resolve, reject) => {
    const req = db
      .transaction(GARBAGE_STORE)
      .objectStore(GARBAGE_STORE)
      .getAll(undefined, limit);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
  const directories = new Map<string, Promise<FileSystemDirectoryHandle | null>>();
  const completed: Garbage[] = [];
  for (let offset = 0; offset < entries.length; offset += 64) {
    await Promise.all(
      entries.slice(offset, offset + 64).map(async (entry, i) => {
        if (protectedFrame(entry.channelId, entry.t)) return;
        if (!referenced[offset + i]) {
          let directory = directories.get(entry.channelId);
          if (!directory) {
            directory = root.getDirectoryHandle(entry.channelId).catch((error) => {
              if (error instanceof DOMException && error.name === "NotFoundError")
                return null;
              throw error;
            });
            directories.set(entry.channelId, directory);
          }
          const dir = await directory;
          try {
            await dir?.removeEntry(`${entry.t}.chunk`);
          } catch (error) {
            if (!(error instanceof DOMException && error.name === "NotFoundError"))
              throw error;
          }
        }
        completed.push(entry);
      }),
    );
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(GARBAGE_STORE, "readwrite");
    for (const entry of completed)
      tx.objectStore(GARBAGE_STORE).delete([entry.channelId, entry.t]);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
