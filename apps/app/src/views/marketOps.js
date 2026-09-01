// Pure decisions for the market view — which trade a viewer is actually
// offered, and nothing they cannot do. The chain re-checks everything at
// `buy`; this only decides what the sheet SHOWS.

/**
 * @param {{ wallet?: string|null } | null} me        the signed-in account (or null)
 * @param {{ listing?: { seller: string }|null, player?: { owner?: string }|null }} lot
 * @returns {{ kind: 'signin'|'cancel'|'buy'|'list'|'none', line: string }}
 */
export function tradeChoice(me, lot) {
  const wallet = me?.wallet ? String(me.wallet).toLowerCase() : null;
  const owner = lot?.player?.owner ? String(lot.player.owner).toLowerCase() : null;
  const seller = lot?.listing?.seller ? String(lot.listing.seller).toLowerCase() : null;

  if (!wallet) {
    return { kind: 'signin', line: 'Sign in with your wallet to buy or sell — email accounts can only window-shop.' };
  }
  if (seller && seller === wallet) {
    return { kind: 'cancel', line: 'Your listing.' };
  }
  if (lot?.listing) {
    return { kind: 'buy', line: 'Your wallet sends the payment; the contract does the swap.' };
  }
  if (owner && owner === wallet) {
    return { kind: 'list', line: 'He is yours. Name your price.' };
  }
  return { kind: 'none', line: 'Not for sale, and not yours.' };
}
