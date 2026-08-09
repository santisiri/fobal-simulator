// Durable lobby state: accounts and match records survive restarts;
// presence, login codes and pending challenges are deliberately ephemeral
// (seconds-to-minutes state). Two persistence layers, composable:
//   - file (storeRoot): local dev, and the task's scratch disk
//   - object store (S3 write-through + hydrate-on-boot): staging — Fargate
//     disks are ephemeral, so accounts live in the replay bucket under a
//     lobby/ prefix. Low write rate, tiny documents; DynamoDB only becomes
//     worth its machinery when accounts turn into a real product surface.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObjectStore } from '@fobal/match-server';

export interface Account {
  accountId: string;
  email: string;
  /** display + player-name base, derived from the email local part */
  handle: string;
  /** account-unique base for teamId/playerIds (handles can collide, keys must not) */
  teamKey: string;
  teamName: string;
  createdAt: string;
}

/** Cached POINTER to the signed result — the match server remains the sole
 *  author; the lobby copies the summary once the match finishes. */
export interface MatchResultSummary {
  finalScore: [number, number];
  /** teamId order matching finalScore (from the signed MatchResult) */
  teams: [string, string];
  finalStateHash: string;
  finishedAt: string;
}

export interface MatchRecord {
  matchId: string;
  /** public http(s) base of the match server (clients derive the ws url) */
  matchUrl: string;
  createdAt: string;
  spectatorToken: string;
  /** per-account join info; the OTHER player's token is never served to you */
  players: Record<string, { teamId: string; token: string }>;
  left: Record<string, boolean>;
  result?: MatchResultSummary;
}

const MAX_MATCH_RECORDS = 200;

export interface LobbyStoreOptions {
  /** local directory (dev); omitted → memory + optional object store */
  root?: string;
  /** durable mirror (staging: the replay bucket) — call hydrate() on boot */
  objectStore?: ObjectStore;
  /** object key prefix (default 'lobby/') */
  keyPrefix?: string;
  /** mirror failures land here (they must never crash a request) */
  onMirrorError?: (err: Error) => void;
}

export class LobbyStore {
  private accounts = new Map<string, Account>();
  private byEmail = new Map<string, string>();
  private matches: MatchRecord[] = [];
  private root?: string;
  private objects?: ObjectStore;
  private prefix: string;
  private onMirrorError: (err: Error) => void;

  constructor(rootOrOptions?: string | LobbyStoreOptions){
    const options = typeof rootOrOptions === 'string' ? { root: rootOrOptions } : rootOrOptions ?? {};
    this.root = options.root;
    this.objects = options.objectStore;
    this.prefix = options.keyPrefix ?? 'lobby/';
    this.onMirrorError = options.onMirrorError ?? (() => {});
    if (this.root){
      mkdirSync(this.root, { recursive: true });
      for (const account of this.readJson<Account[]>('accounts.json') ?? []){
        this.accounts.set(account.accountId, account);
        this.byEmail.set(account.email, account.accountId);
      }
      this.matches = this.readJson<MatchRecord[]>('matches.json') ?? [];
    }
  }

  /** Load state from the object store (staging boot: the local disk is
   *  empty, S3 is the memory). Object-store state wins over disk state. */
  async hydrate(): Promise<void> {
    if (!this.objects) return;
    const accounts = await this.objects.get(`${this.prefix}accounts.json`);
    if (accounts !== null){
      this.accounts.clear();
      this.byEmail.clear();
      for (const account of JSON.parse(accounts) as Account[]){
        this.accounts.set(account.accountId, account);
        this.byEmail.set(account.email, account.accountId);
      }
    }
    const matches = await this.objects.get(`${this.prefix}matches.json`);
    if (matches !== null) this.matches = JSON.parse(matches) as MatchRecord[];
  }

  private readJson<T>(file: string): T | null {
    try { return JSON.parse(readFileSync(join(this.root!, file), 'utf8')) as T; }
    catch { return null; }
  }

  private writeJson(file: string, value: unknown): void {
    const data = JSON.stringify(value, null, 2);
    if (this.root) writeFileSync(join(this.root, file), data);
    // fire-and-forget mirror: the local write already succeeded, a lost
    // mirror write only costs durability across a task replacement
    this.objects?.put(`${this.prefix}${file}`, data)
      .catch(err => this.onMirrorError(err as Error));
  }

  private persistAccounts(): void { this.writeJson('accounts.json', [...this.accounts.values()]); }
  private persistMatches(): void { this.writeJson('matches.json', this.matches); }

  getAccount(accountId: string): Account | null { return this.accounts.get(accountId) ?? null; }
  getAccountByEmail(email: string): Account | null {
    const id = this.byEmail.get(email);
    return id ? this.accounts.get(id) ?? null : null;
  }
  listAccounts(): Account[] { return [...this.accounts.values()]; }
  get accountCount(): number { return this.accounts.size; }

  saveAccount(account: Account): void {
    this.accounts.set(account.accountId, account);
    this.byEmail.set(account.email, account.accountId);
    this.persistAccounts();
  }

  saveMatch(record: MatchRecord): void {
    const i = this.matches.findIndex(m => m.matchId === record.matchId);
    if (i >= 0) this.matches[i] = record;
    else this.matches.push(record);
    if (this.matches.length > MAX_MATCH_RECORDS)
      this.matches.splice(0, this.matches.length - MAX_MATCH_RECORDS);
    this.persistMatches();
  }

  /** newest-first match records an account participates in */
  matchesFor(accountId: string): MatchRecord[] {
    return [...this.matches].reverse().filter(m => m.players[accountId] !== undefined);
  }
}
