// S3-durable persistence: local disk stays the synchronous authority the
// match loop writes through (persist-before-apply is untouched), and every
// mutation schedules an asynchronous, per-key-coalesced upload of the whole
// file to the object store. On boot, hydrate() pulls persisted matches from
// the bucket onto the (ephemeral) disk so the ordinary resume path works
// after a task replacement.
//
// Durability semantics, deliberately: at-least-once whole-object uploads,
// serialized per key, latest-content-wins. A hard crash can lose the last
// few seconds of appends from the mirror — acceptable for staging, and
// documented in docs/PROJECT_STATUS.md's extraction sequence. Graceful
// shutdown must await drain().
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MatchStore, SAFE_ID, writeAtomic } from './store.js';
import type { ObjectStore } from './objectStore.js';

const REL_PATHS = /^(manifest\.json|commands\.jsonl|events\.jsonl|internal-latest\.json|result\.json|clips\.json|snapshots\/\d{8}\.json)$/;

interface KeyState { dirty: boolean }

export interface MirroredStoreOptions {
  /** object key prefix, e.g. 'matches/' */
  keyPrefix?: string;
  /** coalescing delay before uploading append-heavy .jsonl files */
  jsonlDelayMs?: number;
  /** upload attempts before giving up until the next mutation re-marks */
  maxAttempts?: number;
}

export class MirroredMatchStore extends MatchStore {
  private remote: ObjectStore;
  private keyPrefix: string;
  private jsonlDelayMs: number;
  private maxAttempts: number;
  private states = new Map<string, KeyState>();
  private inflight = new Set<Promise<void>>();

  constructor(root: string, remote: ObjectStore, options: MirroredStoreOptions = {}){
    super(root);
    this.remote = remote;
    this.keyPrefix = options.keyPrefix ?? 'matches/';
    this.jsonlDelayMs = options.jsonlDelayMs ?? 500;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  protected override touched(matchId: string, relPath: string): void {
    const rel = `${matchId}/${relPath}`;
    const state = this.states.get(rel);
    if (state){ state.dirty = true; return; }
    const fresh: KeyState = { dirty: false };
    this.states.set(rel, fresh);
    const upload = this.pump(matchId, relPath, fresh)
      .finally(() => { this.states.delete(rel); this.inflight.delete(upload); });
    this.inflight.add(upload);
  }

  /** Upload loop for one key: re-reads the file each round, so concurrent
   *  mutations coalesce into the next upload instead of queueing one each. */
  private async pump(matchId: string, relPath: string, state: KeyState): Promise<void> {
    do {
      state.dirty = false;
      if (this.jsonlDelayMs > 0 && relPath.endsWith('.jsonl'))
        await sleep(this.jsonlDelayMs);
      let body: string;
      try { body = readFileSync(join(this.dir(matchId), relPath), 'utf8'); }
      catch { continue; }   // file vanished (test teardown) — nothing to mirror
      await this.putWithRetry(`${this.keyPrefix}${matchId}/${relPath}`, body);
    } while (state.dirty);
  }

  private async putWithRetry(key: string, body: string): Promise<void> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++){
      try { await this.remote.put(key, body); return; }
      catch (err){
        console.error(JSON.stringify({
          msg: 'mirror_upload_failed', key, attempt, of: this.maxAttempts,
          error: (err as Error).message,
        }));
        if (attempt < this.maxAttempts) await sleep(250 * attempt);
      }
    }
    // gave up: the local copy is intact and the next mutation of this file
    // re-marks it, so persistent outages self-heal once S3 is reachable
  }

  /** Resolve once every scheduled upload (including coalesced re-runs) has
   *  finished. Call on graceful shutdown, after the server is closed. */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /**
   * Pull every mirrored match file that is missing locally onto disk.
   * Local files are never overwritten: within a task's lifetime the disk is
   * strictly fresher than the mirror. Returns the hydrated matchIds.
   */
  async hydrate(): Promise<string[]> {
    const hydrated = new Set<string>();
    for (const key of await this.remote.list(this.keyPrefix)){
      const rel = key.slice(this.keyPrefix.length);
      const slash = rel.indexOf('/');
      if (slash < 1) continue;
      const matchId = rel.slice(0, slash);
      const relPath = rel.slice(slash + 1);
      // bucket contents are data, not paths: only known layouts may land on disk
      if (!SAFE_ID.test(matchId) || !REL_PATHS.test(relPath)) continue;
      const local = join(this.dir(matchId), relPath);
      if (existsSync(local)) continue;
      const body = await this.remote.get(key);
      if (body === null) continue;
      mkdirSync(dirname(local), { recursive: true });
      writeAtomic(local, body);
      hydrated.add(matchId);
    }
    return [...hydrated].sort();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
