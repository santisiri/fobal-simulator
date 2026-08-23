// Money, formatted without ever becoming a float.
//
// Prices arrive as decimal strings of wei because they are uint96 on chain
// and overflow a JS number well below one ETH's worth of precision. Every
// function here takes and returns strings, and the arithmetic is BigInt.
// Nothing in this file may introduce a Number.

const WEI_PER_ETH = 10n ** 18n;

/** wei → a short human ETH figure: '2.5', '0.015', '1,240' */
export function formatEth(wei, { maxDecimals = 4 } = {}) {
  let value;
  try { value = BigInt(wei ?? 0); } catch { return '—'; }
  const negative = value < 0n;
  if (negative) value = -value;

  const whole = value / WEI_PER_ETH;
  const fraction = value % WEI_PER_ETH;

  // pad to 18, cut to the places we show, then drop trailing zeros
  let decimals = fraction.toString().padStart(18, '0').slice(0, maxDecimals).replace(/0+$/, '');
  // a non-zero price must never render as a flat 0
  if (!decimals && fraction > 0n) decimals = '0'.repeat(maxDecimals - 1) + '1';
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${decimals ? `.${decimals}` : ''}`;
}

/** the asset's ticker — ETH is address zero; anything else shows short */
export function assetLabel(asset) {
  return /^0x0{40}$/i.test(String(asset ?? '')) ? 'ETH' : `${String(asset).slice(0, 6)}…`;
}

/** '2.5 ETH' */
export const priceLabel = (wei, asset) => `${formatEth(wei)} ${assetLabel(asset)}`;

/** how a price moved between two sales: {direction, percent} or null */
export function priceMove(previousWei, latestWei) {
  let a, b;
  try { a = BigInt(previousWei); b = BigInt(latestWei); } catch { return null; }
  if (a === 0n) return null;
  const deltaBps = ((b - a) * 10_000n) / a;               // basis points, integer
  if (deltaBps === 0n) return { direction: 'flat', percent: '0' };
  const percent = (deltaBps < 0n ? -deltaBps : deltaBps).toString();
  const whole = percent.length > 2 ? percent.slice(0, -2) : '0';
  const rest = percent.padStart(3, '0').slice(-2).replace(/0+$/, '');
  return {
    direction: deltaBps > 0n ? 'up' : 'down',
    percent: rest ? `${whole}.${rest}` : whole,
  };
}
