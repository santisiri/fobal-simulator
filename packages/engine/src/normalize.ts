// THE single place where external 0–100 integer ratings become the engine's
// internal 0..1 attribute space. Nothing else in the platform may perform
// this conversion.
import type { PlayerRatings } from '@fobal/protocol';

/** 0–100 external rating → 0..1 internal attribute. */
export function ratingToAttribute(rating: number): number {
  if (!Number.isFinite(rating)) throw new Error(`invalid rating ${rating}`);
  return Math.min(1, Math.max(0, rating / 100));
}

/** 0..1 internal attribute → 0–100 external rating (for snapshots/results). */
export function attributeToRating(attribute: number): number {
  return Math.round(Math.min(1, Math.max(0, attribute)) * 100);
}

export function ratingsToAttributes(ratings: PlayerRatings): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(ratings)) out[key] = ratingToAttribute(value);
  return out;
}
