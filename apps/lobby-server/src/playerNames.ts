// Deterministic footballer names. Every generated player gets a name that
// reads like a professional — "Mateo Ferreyra", "Luca Moretti" — instead of
// an inventory label. The generator is PURE: the same key always produces
// the same name, which is what makes generated squads reproducible across
// devices and what makes minted names (immutable on-chain from the seed's
// name field) predictable before the transaction is sent.
//
// Region pools pair first names and surnames from the same football
// culture, so combinations stay coherent. Pools are curated: plausible,
// international, and deliberately avoiding the exact full names of famous
// real players (shared FIRST names or shared SURNAMES alone are normal —
// football has ten thousand Silvas — but no pool pair reproduces a star).

interface Region { firsts: string[]; surnames: string[] }

const REGIONS: Region[] = [
  { // rioplatense
    firsts: ['Mateo', 'Nicolás', 'Santiago', 'Joaquín', 'Tomás', 'Facundo', 'Agustín', 'Ramiro', 'Bautista', 'Gonzalo'],
    surnames: ['Ferreyra', 'Barreto', 'Salvatierra', 'Quiroga', 'Ledesma', 'Arrieta', 'Villalba', 'Maidana', 'Roldán', 'Sarmiento'],
  },
  { // brazilian
    firsts: ['Thiago', 'João', 'Rafael', 'Bruno', 'Caio', 'Gustavo', 'Matheus', 'Otávio', 'Vitor', 'Henrique'],
    surnames: ['Cardoso', 'Valente', 'Vieira', 'Peixoto', 'Farias', 'Moraes', 'Sales', 'Bittencourt', 'Camargo', 'Drummond'],
  },
  { // italian
    firsts: ['Luca', 'Marco', 'Matteo', 'Davide', 'Lorenzo', 'Emiliano', 'Pietro', 'Federico', 'Simone', 'Tommaso'],
    surnames: ['Moretti', 'Bellini', 'Fontana', 'Marchetti', 'Grassi', 'Caruso', 'Santoro', 'Vitale', 'Pellegrino', 'Ferraro'],
  },
  { // iberian
    firsts: ['Alejandro', 'Pablo', 'Álvaro', 'Diego', 'Rubén', 'Adrián', 'Iván', 'Marcos', 'Hugo', 'Raúl'],
    surnames: ['Montenegro', 'Navarro', 'Ibáñez', 'Herrera', 'Escudero', 'Salcedo', 'Peñalver', 'Otero', 'Cabrera', 'Villar'],
  },
  { // west african / french
    firsts: ['Amadou', 'Moussa', 'Yann', 'Théo', 'Ousmane', 'Ibrahima', 'Sékou', 'Antoine', 'Cheikh', 'Karim'],
    surnames: ['Sylla', 'Camara', 'Bakayoko', 'Doucouré', 'Fofana', 'Lemaire', 'Ndiaye', 'Berthier', 'Sarr', 'Duval'],
  },
  { // northern european
    firsts: ['Jonas', 'Felix', 'Lukas', 'Daan', 'Emil', 'Oliver', 'Callum', 'Sander', 'Niklas', 'Rory'],
    surnames: ['Berger', 'Visser', 'Lindqvist', 'Andersen', 'Whitmore', 'Krüger', 'Bennett', 'Sørensen', 'Dijkstra', 'Halvorsen'],
  },
  { // balkan
    firsts: ['Marko', 'Nikola', 'Ivan', 'Ante', 'Dario', 'Miloš', 'Bojan', 'Petar', 'Zvonimir', 'Stefan'],
    surnames: ['Kovač', 'Jurić', 'Petrović', 'Vuković', 'Šimunić', 'Radić', 'Babić', 'Zorić', 'Marinković', 'Tomić'],
  },
];

/** FNV-1a → xorshift32: tiny, deterministic, good enough spread for names */
const hash32 = (s: string): number => {
  let h = 0x811c9dc5;
  for (const c of s) { h ^= c.codePointAt(0)!; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};
const xorshift = (state: number) => () => {
  state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
  return (state >>>= 0) / 0x100000000;
};

/** One deterministic footballer name for a string key. */
export function playerName(key: string): string {
  const rand = xorshift(hash32(key) || 1);
  const region = REGIONS[Math.floor(rand() * REGIONS.length)]!;
  const first = region.firsts[Math.floor(rand() * region.firsts.length)]!;
  const surname = region.surnames[Math.floor(rand() * region.surnames.length)]!;
  return `${first} ${surname}`;
}

/** Deterministic names for a whole squad, unique within the squad. The
 *  surname is the identity a commentator uses — collisions retry with a
 *  salted key, and the salt walk is deterministic, so squad N of key K is
 *  the same forever. Pool math: 7 regions × 10×10 names ≈ 700 surnames →
 *  16 draws collide occasionally, never irrecoverably. */
export function squadNames(key: string, count: number): string[] {
  const names: string[] = [];
  const usedSurnames = new Set<string>();
  for (let i = 0; i < count; i++) {
    let name = playerName(`${key}:${i}`);
    for (let salt = 1; usedSurnames.has(name.split(' ').pop()!) && salt <= 12; salt++)
      name = playerName(`${key}:${i}:${salt}`);
    usedSurnames.add(name.split(' ').pop()!);
    names.push(name);
  }
  return names;
}
