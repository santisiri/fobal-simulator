// MINT MY TEAM — the three-transaction squad mint, moved from lobby.html
// into the app (J4) and onto the one tx-lifecycle panel.
//
// The lobby signs the SquadMint permit server-side (/mint/prepare); YOUR
// wallet sends the prepared transactions (create team → mint 11 NFTs →
// declare roster) and owns everything. Progress (teamId, tokenIds) is read
// out of the receipts this module already holds — the server says which
// log topics to match — and persisted per wallet, so a cancelled or
// crashed run resumes instead of starting over.

/** the golden roles → on-chain position codes (GK/DF/MF/FW) */
export const ROLE_POS = { GK: 0, CB: 1, LB: 1, RB: 1, CM: 2, LM: 2, RM: 2, LW: 3, RW: 3, ST: 3 };

/** fair flat ratings, GK skill in lane 11 — the same squad shape the
 *  generator signs for every founder */
export function packFlatSkills(isGk) {
  let packed = 0n;
  for (let lane = 0; lane < 12; lane++)
    packed |= BigInt(lane === 11 ? (isGk ? 85 : 10) : 55) << BigInt(lane * 8);
  return packed.toString();
}

/** pull the id(s) the next step needs from a receipt's logs — pure */
export function idsFromReceipt(receipt, parse) {
  const ids = (receipt.logs ?? [])
    .filter((l) => l.topics?.[0] === parse.topic0
      && (!parse.requireTopic1 || l.topics[1] === parse.requireTopic1))
    .map((l) => BigInt(l.topics[parse.idTopic]).toString());
  if (!ids.length) throw new Error('confirmed, but the receipt has no matching event — try again to resume');
  return parse.many ? ids : ids[ids.length - 1];
}

const randomDna = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

async function waitReceipt(provider, txHash) {
  for (let i = 0; i < 60; i++) {
    const r = await provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
    if (r) {
      if (r.status !== '0x1') throw new Error('transaction reverted on-chain');
      return r;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('transaction not confirmed after 2 minutes — check your wallet');
}

export const MINT_LEGS = 3;
const LEG_LABEL = { 'create-team': 'create team', 'mint-squad': 'mint 11 players', 'declare-roster': 'declare roster' };

/**
 * Run the whole mint against the signed-in wallet account. Resolves with
 * { teamId, teamName } once the squad is minted AND linked; throws the
 * normalized-able original error otherwise (caller renders it).
 * @param {{ auth: any, flow: any, provider?: any, storage?: Storage }} options
 */
export async function runMintFlow({ auth, flow, provider = /** @type {any} */ (globalThis).ethereum, storage = localStorage }) {
  if (!provider) throw { message: 'wallet disconnected — no extension detected' };
  flow.preparing('permit');
  const squadRes = await auth.api('/squad');
  if (!squadRes.ok) throw new Error('could not load your squad');
  const squad = await squadRes.json();
  const [from] = await provider.request({ method: 'eth_requestAccounts' });
  const progressKey = `fobal.mint.${from.toLowerCase()}`;
  let progress = {};
  try { progress = JSON.parse(storage.getItem(progressKey) ?? '{}') ?? {}; } catch { /* fresh run */ }

  // mint the XI the user built: their names, fair flat ratings, fresh dna
  const seeds = squad.players.slice(0, 11).map((p) => {
    const dna = randomDna();
    return {
      name: p.name, dna,
      skills: packFlatSkills(p.role === 'GK'),
      appearance: (BigInt(dna) & 0xffffffffn).toString(),
      generation: 1, country: 32, position: ROLE_POS[p.role] ?? 2,
    };
  });
  const teamName = squad.teamName;

  for (let step = 0; step < 5; step++) {
    flow.preparing(flow.snapshot.leg);
    const planRes = await auth.api('/mint/prepare', { method: 'POST', body: { teamName, seeds, progress } });
    const plan = await planRes.json().catch(() => ({}));
    if (!planRes.ok) {
      // stale progress (team gone, wrong wallet) — wipe it and start over
      if (planRes.status === 403 && Object.keys(progress).length) {
        storage.removeItem(progressKey);
        progress = {};
        continue;
      }
      throw new Error(plan.error ?? `mint prepare failed (${planRes.status})`);
    }
    if (plan.done) {
      flow.indexing();
      const link = await auth.api('/squad/chain', { method: 'POST', body: { teamId: plan.teamId } });
      const out = await link.json().catch(() => ({}));
      if (!link.ok) throw new Error(out.error ?? 'link failed');
      storage.removeItem(progressKey);
      flow.success();
      return { teamId: plan.teamId, teamName: out.team?.name ?? teamName };
    }
    flow.wallet(LEG_LABEL[plan.tx.step] ?? plan.tx.step);
    const txHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: plan.tx.to, data: plan.tx.data }],
    });
    flow.submitted(txHash);
    flow.confirming();
    const receipt = await waitReceipt(provider, txHash);
    if (plan.tx.step === 'create-team') progress.teamId = idsFromReceipt(receipt, plan.tx.parse);
    else if (plan.tx.step === 'mint-squad') progress.tokenIds = idsFromReceipt(receipt, plan.tx.parse);
    else if (plan.tx.step === 'declare-roster') progress.declared = true;
    storage.setItem(progressKey, JSON.stringify(progress));
    flow.legDone();
  }
  throw new Error('mint did not complete — try again to resume');
}
