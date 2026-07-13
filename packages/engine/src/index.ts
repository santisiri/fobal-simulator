export { MatchEngine } from './engine.js';
export type { SubmitOutcome } from './engine.js';
export { ratingToAttribute, attributeToRating, ratingsToAttributes } from './normalize.js';
export { IdMap } from './ids.js';
export { bootGoldenCore, officialHash, goldenSource } from './goldenRuntime.js';
export type { GoldenHandle } from './goldenRuntime.js';
export { assignSlots, imposeManifest, translateTactics } from './adapter.js';
export { EventTap, formatClock } from './events.js';
