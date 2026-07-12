import { describe, expect, test } from 'vitest';
import { StateSnapshot } from '@fobal/protocol';
import { sampleManifest, sampleTeam } from '@fobal/protocol/samples';
import { MatchEngine, ratingToAttribute, attributeToRating } from '../src/index.js';

describe('rating normalization (the single conversion point)', () => {
  test('0-100 maps linearly onto 0..1 and round-trips', () => {
    expect(ratingToAttribute(0)).toBe(0);
    expect(ratingToAttribute(100)).toBe(1);
    expect(ratingToAttribute(50)).toBe(0.5);
    expect(attributeToRating(0.73)).toBe(73);
    expect(() => ratingToAttribute(Number.NaN)).toThrow();
  });
});

describe('manifest adapter', () => {
  test('the manifest is validated and frozen', () => {
    expect(() => MatchEngine.create({ nonsense: true })).toThrow();
    const engine = MatchEngine.create(sampleManifest());
    expect(Object.isFrozen(engine.manifest)).toBe(true);
    expect(Object.isFrozen(engine.manifest!.teams[0])).toBe(true);
  });

  test('snapshots and events speak ONLY external ids — internal pids never leak', () => {
    const engine = MatchEngine.create(sampleManifest());
    engine.run(900);
    const snapshot = engine.snapshot();
    expect(StateSnapshot.safeParse(snapshot).success).toBe(true);
    const manifestIds = new Set(
      engine.manifest!.teams.flatMap(t => t.players.map(p => p.playerId)));
    for (const p of snapshot.players) expect(manifestIds.has(p.playerId)).toBe(true);
    const serialized = JSON.stringify({ snapshot, events: engine.events() });
    expect(serialized).not.toMatch(/home_\d|away_\d/);
    expect(snapshot.teams[0].teamId).toBe('team-rhinos');
    expect(snapshot.teams[1].teamId).toBe('team-comets');
  });

  test('all 22 starters are on the pitch and the manifest GK keeps goal', () => {
    const engine = MatchEngine.create(sampleManifest());
    engine.run(600);
    const snapshot = engine.snapshot();
    expect(snapshot.players.filter(p => p.onPitch).length).toBe(22);
    const gkInternal = (engine as any).handle.game.teams[0].gk;
    const gkExternal = (engine as any).ids.external(gkInternal.pid);
    expect(gkExternal).toBe('rhinos-player-01'); // the manifest's GK entry
    expect(gkInternal.isGK).toBe(true);
  });

  test('manifest tactics land through the tactical funnel', () => {
    const m = sampleManifest();
    m.teams[0].tactics = { pressing: 0.9, attackSide: 'right', timeWaste: 0.7 };
    const engine = MatchEngine.create(m);
    const tactics = engine.snapshot().teams[0].tactics;
    expect(tactics.pressing).toBe(0.9);
    expect(tactics.attackSide).toBe('right');
    expect(tactics.timeWaste).toBe(0.7);
  });

  test('ratings observably drive play: a far faster squad covers more ground', () => {
    const fast = sampleTeam('speed', 'SPEEDSTERS');
    const slow = sampleTeam('slugs', 'SLUGGARDS');
    for (const p of fast.players){ p.ratings.pace = 95; p.ratings.accel = 95; p.ratings.stamina = 95; }
    for (const p of slow.players){ p.ratings.pace = 25; p.ratings.accel = 25; p.ratings.stamina = 60; }
    const engine = MatchEngine.create(sampleManifest({ teams: [fast, slow], matchId: 'match-pace-ab' }));
    // accumulate PATH LENGTH per team (net displacement only measures where
    // the formation drifted, not how fast anyone runs)
    const covered = { speed: 0, slugs: 0 };
    let last = new Map(engine.snapshot().players.map(p => [p.playerId, p.position]));
    for (let i = 0; i < 90; i++){
      engine.run(20);
      const now = new Map(engine.snapshot().players.map(p => [p.playerId, p.position]));
      for (const [id, pos] of now){
        const prev = last.get(id);
        if (!prev) continue;
        const d = Math.hypot(pos.x - prev.x, pos.y - prev.y);
        if (id.startsWith('speed')) covered.speed += d; else covered.slugs += d;
      }
      last = now;
    }
    expect(covered.speed).toBeGreaterThan(covered.slugs * 1.2);
  });

  test('identical manifests with different seeds still impose identical squads', () => {
    const a = MatchEngine.create(sampleManifest({ seed: 111 }));
    const b = MatchEngine.create(sampleManifest({ seed: 222 }));
    const names = (e: MatchEngine) => e.snapshot().players.map(p => p.playerId).sort().join(',');
    expect(names(a)).toBe(names(b));
    expect(a.finalStateHash()).not.toBe(b.finalStateHash()); // seeds still matter
  });
});
