// Append-only, file-backed persistence for official matches.
//
//   <root>/<matchId>/manifest.json          frozen input
//   <root>/<matchId>/commands.jsonl         accepted commands, append-only
//   <root>/<matchId>/events.jsonl           semantic events, append-only
//   <root>/<matchId>/snapshots/<tick>.json  protocol StateSnapshots
//   <root>/<matchId>/internal-latest.json   golden-core state for fast recovery
//   <root>/<matchId>/result.json            signed final result (written once)
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcceptedCommand, MatchEvent, MatchManifest, MatchResult, StateSnapshot } from '@fobal/protocol';

const SAFE_ID = /^(?!\.)[A-Za-z0-9_:.-]+$/;   // no leading dot: '.'/'..' can never traverse

/** Crash-safe whole-file write: temp file + atomic rename. */
function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export class MatchStore {
  constructor(private root: string){ mkdirSync(root, { recursive: true }); }

  private dir(matchId: string): string {
    if (!SAFE_ID.test(matchId)) throw new Error(`unsafe matchId ${matchId}`);
    return join(this.root, matchId);
  }

  ensure(matchId: string): void {
    mkdirSync(join(this.dir(matchId), 'snapshots'), { recursive: true });
  }

  exists(matchId: string): boolean { return existsSync(join(this.dir(matchId), 'manifest.json')); }

  saveManifest(manifest: MatchManifest): void {
    this.ensure(manifest.matchId);
    writeAtomic(join(this.dir(manifest.matchId), 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  loadManifest(matchId: string): MatchManifest {
    return JSON.parse(readFileSync(join(this.dir(matchId), 'manifest.json'), 'utf8'));
  }

  appendCommand(matchId: string, command: AcceptedCommand): void {
    appendFileSync(join(this.dir(matchId), 'commands.jsonl'), JSON.stringify(command) + '\n');
  }

  loadCommands(matchId: string): AcceptedCommand[] {
    return this.readJsonl(join(this.dir(matchId), 'commands.jsonl'));
  }

  appendEvent(matchId: string, event: MatchEvent): void {
    appendFileSync(join(this.dir(matchId), 'events.jsonl'), JSON.stringify(event) + '\n');
  }

  loadEvents(matchId: string): MatchEvent[] {
    return this.readJsonl(join(this.dir(matchId), 'events.jsonl'));
  }

  saveSnapshot(matchId: string, snapshot: StateSnapshot): void {
    writeAtomic(join(this.dir(matchId), 'snapshots', `${String(snapshot.tick).padStart(8, '0')}.json`),
      JSON.stringify(snapshot));
  }

  loadSnapshots(matchId: string): StateSnapshot[] {
    const dir = join(this.dir(matchId), 'snapshots');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).sort().map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }

  saveInternal(matchId: string, captured: unknown): void {
    writeAtomic(join(this.dir(matchId), 'internal-latest.json'), JSON.stringify(captured));
  }

  loadInternal(matchId: string): { tick: number; state: unknown; appliedThroughSeq: number; eventSeq: number } | null {
    const file = join(this.dir(matchId), 'internal-latest.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  /**
   * Idempotent result processing: the first write wins; every later call
   * returns the already-persisted result unchanged.
   */
  saveResultOnce(matchId: string, result: MatchResult): MatchResult {
    const file = join(this.dir(matchId), 'result.json');
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
    writeAtomic(file, JSON.stringify(result, null, 2));
    return result;
  }

  loadResult(matchId: string): MatchResult | null {
    const file = join(this.dir(matchId), 'result.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }

  listMatches(): string[] {
    return readdirSync(this.root).filter(d => this.exists(d));
  }

  saveClips(matchId: string, clips: unknown): void {
    writeAtomic(join(this.dir(matchId), 'clips.json'), JSON.stringify(clips));
  }

  loadClips(matchId: string): unknown | null {
    const file = join(this.dir(matchId), 'clips.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }

  private readJsonl<T>(file: string): T[] {
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const out: T[] = [];
    for (let i = 0; i < lines.length; i++){
      try { out.push(JSON.parse(lines[i]!)); }
      catch (err){
        // a torn FINAL line means the process died mid-append: drop it (its
        // command/event was never acked). Corruption anywhere else is fatal.
        if (i === lines.length - 1) break;
        throw err;
      }
    }
    return out;
  }
}
