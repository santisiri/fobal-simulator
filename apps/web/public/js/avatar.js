// Faithful JS port of contracts/src/FobalAvatarRenderer.sol — the same 24x24
// pixel footballer the chain mints from a player's immutable `appearance`
// nibbles + `dna`. Kept byte-for-byte structural so the onboarding preview
// IS the on-chain art. Palettes are the contract's exact hex triplets.
const PAL = {
  BG:   ['1b2432','20303f','28323c','2d2438','1f3630','33272b','1e2a44','3a3226'],
  SKIN: ['f2c9a4','e0ac69','c68642','8d5524','5c3317','f8d9c0','a86b3c','713f17'],
  HAIR: ['1a1512','5b3a1d','c8a24a','9c2b1f','2e2e34','e8e4da','763fb8','1f6b3a'],
  KIT:  ['d8342c','57b8e8','2be08f','e0c04a','8a5cf6','e8712f','2f2f38','f2ece0'],
};

const trait = (appearance, slot) => (appearance >> (slot * 4)) & 0x0f;

function hairBack(style, hair) {
  return style === 3 ? `<rect x="7" y="4" width="10" height="10" fill="#${hair}"/>` : '';
}
function hairFront(style, hair) {
  if (style === 0) return '';
  if (style === 1) return `<rect x="8" y="3" width="8" height="2" fill="#${hair}"/>`;
  if (style === 2) return `<rect x="8" y="3" width="8" height="2" fill="#${hair}"/><rect x="10" y="2" width="4" height="1" fill="#${hair}"/>`;
  if (style === 3) return `<rect x="8" y="3" width="8" height="2" fill="#${hair}"/>`;
  return `<rect x="11" y="1" width="2" height="4" fill="#${hair}"/>`; // mohawk
}
function eyes(eyeTrait, dna) {
  const y = (Number(dna & 1n) === 0) ? '7' : '6';
  const color = eyeTrait % 3 === 0 ? '1a1512' : (eyeTrait % 3 === 1 ? '2456a8' : '2e6b2e');
  return `<rect x="9" y="${y}" width="2" height="2" fill="#${color}"/><rect x="13" y="${y}" width="2" height="2" fill="#${color}"/>`;
}
function accessory(kind, hair, accent) {
  if (kind === 1) return `<rect x="8" y="4" width="8" height="1" fill="#${accent}"/>`;   // headband
  if (kind === 2) return `<rect x="9" y="10" width="6" height="2" fill="#${hair}"/>`;      // beard
  if (kind === 3) return '<rect x="8" y="6" width="8" height="1" fill="#00000055"/>';       // visor
  return '';
}
function badge(position, kitA) {
  const h = position === 0 ? 1 : position === 1 ? 2 : position === 2 ? 3 : 4;
  return `<rect x="1" y="${23 - h}" width="2" height="${h}" fill="#${kitA}"/>`;
}

/**
 * @param {{appearance:number, dna:bigint, position:number, kit?:{primary?:string,secondary?:string}}} p
 * Returns an <svg> string. `kit` overrides shirt/shorts (as the game applies a
 * club's chosen colors over the golden defaults); the GK keeps a distinct
 * keeper kit for readability, matching in-game convention.
 */
export function avatarSvg(p) {
  const a = p.appearance;
  const bg = PAL.BG[trait(a, 0) % 8];
  const skin = PAL.SKIN[trait(a, 1) % 8];
  const hair = PAL.HAIR[trait(a, 2) % 8];
  let kitA = PAL.KIT[trait(a, 5) % 8];
  let kitB = PAL.KIT[(trait(a, 5) + 3) % 8];
  if (p.position === 0) { kitA = 'e0c04a'; kitB = '1a1a1a'; }          // keeper kit
  else if (p.kit) {
    if (p.kit.primary) kitA = p.kit.primary.replace('#', '');
    if (p.kit.secondary) kitB = p.kit.secondary.replace('#', '');
  }
  const style3 = trait(a, 3) % 5;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">',
    `<rect width="24" height="24" fill="#${bg}"/>`,
    hairBack(style3, hair),
    `<rect x="8" y="4" width="8" height="8" fill="#${skin}"/>`,
    hairFront(style3, hair),
    eyes(trait(a, 4), p.dna),
    '<rect x="11" y="10" width="2" height="1" fill="#00000033"/>',
    `<rect x="7" y="12" width="10" height="7" fill="#${kitA}"/>`,
    `<rect x="7" y="12" width="10" height="2" fill="#${kitB}"/>`,
    `<rect x="5" y="13" width="2" height="5" fill="#${kitA}"/>`,
    `<rect x="17" y="13" width="2" height="5" fill="#${kitA}"/>`,
    `<rect x="5" y="18" width="2" height="1" fill="#${skin}"/>`,
    `<rect x="17" y="18" width="2" height="1" fill="#${skin}"/>`,
    `<rect x="8" y="19" width="8" height="2" fill="#${kitB}"/>`,
    `<rect x="9" y="21" width="2" height="2" fill="#${skin}"/>`,
    `<rect x="13" y="21" width="2" height="2" fill="#${skin}"/>`,
    accessory(trait(a, 6) % 4, hair, kitB),
    badge(p.position, kitA),
    '</svg>',
  ].join('');
}

/** A data: URI, handy for <img src>. */
export function avatarDataUri(p) {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(avatarSvg(p));
}
