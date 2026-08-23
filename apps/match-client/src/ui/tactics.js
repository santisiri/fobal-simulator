// The tactics board: the engine's OWN fields, grouped so a manager can
// read them. Every key here exists in the protocol's TacticalState, which
// adapter.ts applies at kickoff — there is no second tactical model and no
// setting that does nothing.
//
// PRESETS are the shortcuts, and they are deliberately the SAME patches the
// spoken commands compile to (packages/protocol/src/orders.ts). A test
// asserts that equality, so the board and the touchline can never drift:
// tapping PRESS HIGH here and shouting "press high" mid-match do one thing.

/** 0..1 sliders, grouped, with the ends named in football rather than maths */
export const TACTIC_GROUPS = [
  {
    key: 'shape', label: 'Shape',
    fields: [
      { key: 'width', label: 'Width', low: 'Narrow', high: 'Wide' },
      { key: 'defLine', label: 'Defensive line', low: 'Deep', high: 'High' },
      { key: 'compactness', label: 'Compactness', low: 'Spread', high: 'Tight' },
    ],
  },
  {
    key: 'attack', label: 'In possession',
    fields: [
      { key: 'mentality', label: 'Mentality', low: 'Cautious', high: 'Attacking' },
      { key: 'tempo', label: 'Tempo', low: 'Patient', high: 'Urgent' },
      { key: 'risk', label: 'Risk', low: 'Safe', high: 'Ambitious' },
      { key: 'crossing', label: 'Crossing', low: 'Rarely', high: 'Often' },
      { key: 'shootTendency', label: 'Shoot on sight', low: 'Work it in', high: 'Let fly' },
      { key: 'overlap', label: 'Overlaps', low: 'Hold', high: 'Get forward' },
      { key: 'counter', label: 'Counter', low: 'Rebuild', high: 'Break fast' },
    ],
  },
  {
    key: 'press', label: 'Out of possession',
    fields: [
      { key: 'pressing', label: 'Pressing', low: 'Contain', high: 'Hunt' },
      { key: 'pressAfterLoss', label: 'Press after loss', low: 'Drop off', high: 'Swarm' },
      { key: 'defAggression', label: 'Aggression', low: 'Jockey', high: 'Commit' },
      { key: 'trap', label: 'Offside trap', low: 'Never', high: 'Spring it' },
    ],
  },
  {
    key: 'game', label: 'Game management',
    fields: [
      { key: 'timeWaste', label: 'Time wasting', low: 'Play on', high: 'Kill it' },
      { key: 'gkLong', label: 'Keeper distribution', low: 'Play short', high: 'Go long' },
    ],
  },
];

/** the enumerated choices, exactly as TacticalState declares them */
export const TACTIC_CHOICES = [
  { key: 'style', label: 'Style',
    options: ['mixed', 'possession', 'direct', 'counter'] },
  { key: 'attackSide', label: 'Attack down', options: ['both', 'left', 'right'] },
  { key: 'scheme', label: 'Marking', options: ['zonal', 'man', 'trap'] },
];

/** One tap, several fields — identical to the spoken command's patch.
 *  Keys are the TeamIntent names; see the coherence test. */
export const PRESETS = [
  { intent: 'press_high', label: 'PRESS HIGH', patch: { pressing: 0.85 } },
  { intent: 'park_the_bus', label: 'PARK THE BUS',
    patch: { mentality: 0.1, defLine: 0.12, compactness: 0.9, timeWaste: 0.7 } },
  { intent: 'all_out_attack', label: 'ALL-OUT ATTACK',
    patch: { mentality: 0.95, defLine: 0.85, risk: 0.9 } },
  { intent: 'retain_possession', label: 'KEEP THE BALL',
    patch: { style: 'possession', risk: 0.25, tempo: 0.35 } },
  { intent: 'counterattack', label: 'ON THE COUNTER',
    patch: { style: 'counter', counter: 0.9 } },
];

/** every slider key the board can set — used to build a complete tactic */
export const SLIDER_KEYS = TACTIC_GROUPS.flatMap(g => g.fields.map(f => f.key));
