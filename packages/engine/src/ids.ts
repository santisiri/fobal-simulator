// Bidirectional mapping between externally supplied protocol ids and the
// golden core's internal pids/team indices. Internal ids must never leak
// past this boundary.
export class IdMap {
  private extToPid = new Map<string, string>();
  private pidToExt = new Map<string, string>();
  private teamExtToIdx = new Map<string, 0 | 1>();
  private teamIdxToExt: [string, string] = ['', ''];

  bindTeam(externalId: string, index: 0 | 1): void {
    this.teamExtToIdx.set(externalId, index);
    this.teamIdxToExt[index] = externalId;
  }

  bindPlayer(externalId: string, pid: string): void {
    if (this.extToPid.has(externalId)) throw new Error(`duplicate external id ${externalId}`);
    if (this.pidToExt.has(pid)) throw new Error(`internal pid ${pid} bound twice`);
    this.extToPid.set(externalId, pid);
    this.pidToExt.set(pid, externalId);
  }

  pid(externalId: string): string {
    const pid = this.extToPid.get(externalId);
    if (!pid) throw new Error(`unknown playerId ${externalId}`);
    return pid;
  }

  hasExternal(externalId: string): boolean { return this.extToPid.has(externalId); }

  external(pid: string): string {
    const ext = this.pidToExt.get(pid);
    if (!ext) throw new Error(`internal pid ${pid} has no external id`);
    return ext;
  }

  externalOrNull(pid: string | null | undefined): string | null {
    return pid ? this.pidToExt.get(pid) ?? null : null;
  }

  teamIndex(externalId: string): 0 | 1 {
    const idx = this.teamExtToIdx.get(externalId);
    if (idx === undefined) throw new Error(`unknown teamId ${externalId}`);
    return idx;
  }

  teamExternal(index: 0 | 1): string { return this.teamIdxToExt[index]; }
}
