import { z } from 'zod';

/** Bumped on any breaking change to the shapes in this package. */
export const PROTOCOL_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Identifiers
//
// Every official entity carries a stable, EXTERNALLY SUPPLIED id. The engine's
// internal `home_10`-style pids are an implementation detail that must never
// leak through this protocol; the engine adapter owns the mapping. Ids are
// opaque strings — token ids, UUIDs, DB keys — constrained only enough to be
// safe in URLs, logs and filenames.
// ---------------------------------------------------------------------------
export const ExternalId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_:.-]+$/,
  'ids must be URL/log-safe: alphanumerics, _ : . -');
export type ExternalId = z.infer<typeof ExternalId>;

export const MatchId = ExternalId;
export const TeamId = ExternalId;
export const PlayerId = ExternalId;

export const Seed = z.number().int().min(0).max(0xffffffff);
export const Tick = z.number().int().min(0);
export const Seq = z.number().int().min(0);

export const Vec2 = z.object({ x: z.number().finite(), y: z.number().finite() });
export type Vec2 = z.infer<typeof Vec2>;

export const Vec3 = Vec2.extend({ z: z.number().finite() });
export type Vec3 = z.infer<typeof Vec3>;

/** Football roles understood by the engine. */
export const Role = z.enum(['GK', 'CB', 'LB', 'RB', 'CM', 'LM', 'RM', 'LW', 'RW', 'ST']);
export type Role = z.infer<typeof Role>;

export const Formation = z.enum(['442', '433', '352']);
export type Formation = z.infer<typeof Formation>;

export const MatchStateName = z.enum([
  'KICKOFF', 'PLAYING', 'THROWIN', 'CORNER', 'GOALKICK', 'FREEKICK',
  'GOAL', 'RESET', 'HALFTIME', 'FULLTIME',
]);
export type MatchStateName = z.infer<typeof MatchStateName>;

// ---------------------------------------------------------------------------
// Canonical JSON — stable stringification used for hashing and signing.
// Object keys are sorted recursively; arrays keep order. undefined is dropped.
// ---------------------------------------------------------------------------
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype){
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()){
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortValue(val);
    }
    return out;
  }
  return v;
}

/** FNV-1a 32-bit over a string — matches the characterization harness digest. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
