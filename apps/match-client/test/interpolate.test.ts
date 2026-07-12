import { describe, expect, test } from 'vitest';
import { buildFrame, frameFromSnapshot, InterpolationBuffer } from '../src/interpolate.js';

const snap = (tick: number, ballX: number, px: number) => ({
  tick, clock: '1:00', matchState: 'PLAYING', score: [0, 0] as [number, number], half: 1,
  ball: { position: { x: ballX, y: 34, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
  players: [{
    playerId: 'p1', position: { x: px, y: 30 }, velocity: { x: 0, y: 0 },
    facing: 0, stamina: 1, action: 'jog', onPitch: true, yellow: 0, red: false,
  }],
  teams: [] as never, stateHash: '00000000',
});

describe('frames', () => {
  test('buildFrame applies sparse patches on top of the previous frame', () => {
    const base = frameFromSnapshot(snap(100, 50, 10));
    const next = buildFrame(base, {
      tick: 106,
      players: [{ playerId: 'p1', position: { x: 12, y: 30 } }],
    });
    expect(next.tick).toBe(106);
    expect(next.players.get('p1')!.position.x).toBe(12);
    expect(next.players.get('p1')!.action).toBe('jog');       // inherited
    expect(next.ball.position.x).toBe(50);                    // unchanged
    expect(next.score).toEqual([0, 0]);
  });
});

describe('InterpolationBuffer', () => {
  test('samples an interpolated position between straddling frames', () => {
    const buf = new InterpolationBuffer({ delayTicks: 5 });
    buf.push(frameFromSnapshot(snap(100, 40, 10)));
    buf.push(frameFromSnapshot(snap(110, 60, 20)));
    // target = 110 - 5 = 105 → halfway
    const f = buf.sample()!;
    expect(f.interpolated).toBe(true);
    expect(f.ball.position.x).toBeCloseTo(50, 5);
    expect(f.players.get('p1')!.position.x).toBeCloseTo(15, 5);
  });

  test('out-of-order frames are sorted in; duplicates replace', () => {
    const buf = new InterpolationBuffer({ delayTicks: 0 });
    buf.push(frameFromSnapshot(snap(110, 60, 20)));
    buf.push(frameFromSnapshot(snap(100, 40, 10)));
    buf.push(frameFromSnapshot(snap(110, 61, 21)));
    expect(buf.frames.map((f: { tick: number }) => f.tick)).toEqual([100, 110]);
    expect(buf.frames[1].ball.position.x).toBe(61);
  });

  test('reset drops history (authoritative resync)', () => {
    const buf = new InterpolationBuffer({ delayTicks: 5 });
    buf.push(frameFromSnapshot(snap(100, 40, 10)));
    buf.reset(frameFromSnapshot(snap(500, 80, 50)));
    expect(buf.frames.length).toBe(1);
    expect(buf.sample()!.ball.position.x).toBe(80);
  });

  test('a single frame samples as itself', () => {
    const buf = new InterpolationBuffer();
    buf.push(frameFromSnapshot(snap(42, 33, 5)));
    const f = buf.sample()!;
    expect(f.tick).toBe(42);
    expect(f.interpolated).toBe(false);
  });
});
