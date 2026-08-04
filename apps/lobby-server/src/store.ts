// Durable lobby state. v0 is a small file-backed store: accounts and match
// records survive restarts; presence, login codes and pending challenges are
// deliberately ephemeral (they are seconds-to-minutes state). The DynamoDB
// backend (B4, infra agent) arrives behind this same surface.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

export interface MatchRecord {
  matchId: string;
  /** public http(s) base of the match server (clients derive the ws url) */
  matchUrl: string;
  createdAt: string;
  spectatorToken: string;
  /** per-account join info; the OTHER player's token is never served to you */
  players: Record<string, { teamId: string; token: string }>;
  left: Record<string, boolean>;
}

const MAX_MATCH_RECORDS = 200;

export class LobbyStore {
  private accounts = new Map<string, Account>();
  private byEmail = new Map<string, string>();
  private matches: MatchRecord[] = [];

  constructor(private root?: string){
    if (!root) return;
    mkdirSync(root, { recursive: true });
    for (const account of this.readJson<Account[]>('accounts.json') ?? []){
      this.accounts.set(account.accountId, account);
      this.byEmail.set(account.email, account.accountId);
    }
    this.matches = this.readJson<MatchRecord[]>('matches.json') ?? [];
  }

  private readJson<T>(file: string): T | null {
    try { return JSON.parse(readFileSync(join(this.root!, file), 'utf8')) as T; }
    catch { return null; }
  }

  private writeJson(file: string, value: unknown): void {
    if (!this.root) return;
    writeFileSync(join(this.root, file), JSON.stringify(value, null, 2));
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
