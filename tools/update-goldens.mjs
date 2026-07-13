// Regenerates tests/characterization/goldens.json from the CURRENT index.html.
// Run this ONLY when a behavior change is intentional — and document the change
// in docs/behavior-changes.md. Usage: node tools/update-goldens.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './extract-inline-script.mjs';
import { bootGolden, fullHash } from '../tests/characterization/harness/boot.mjs';
import { sourceHash, squadFingerprint, stateTimeline, stepUntil, tacticsDiff } from '../tests/characterization/util.mjs';

const goldens = { sourceHash: sourceHash() };

// --- fixed timestep ---
{
  const h = bootGolden({ seed: 42 });
  h.step(60);
  goldens.fixedTimestep = { simTickAfter60: h.game.simTick, tMatchAfter60: h.game.match.tMatch };
}

// --- seeded rng / squads ---
{
  goldens.squads = {
    seed42: squadFingerprint(bootGolden({ seed: 42 })),
    seed1: squadFingerprint(bootGolden({ seed: 1 })),
    seed2: squadFingerprint(bootGolden({ seed: 2 })),
  };
}

// --- movement / long-run hashes + state timeline (seed 42) ---
{
  const h = bootGolden({ seed: 42 });
  h.step(300);
  const hash300 = fullHash(h);
  h.step(300);
  const hash600 = fullHash(h);
  const h2 = bootGolden({ seed: 42 });
  const timeline = stateTimeline(h2, 3600);
  goldens.seed42 = { hash300, hash600, hash3600: fullHash(h2), timeline3600: timeline };
}

// --- passing / shooting stats (seed 5, 3600 ticks) ---
{
  const h = bootGolden({ seed: 5 });
  h.step(3600);
  const t = i => {
    const team = h.game.teams[i];
    return { passAtt: team.passAtt, passCmp: team.passCmp, shots: team.shots, onTarget: team.onTarget };
  };
  goldens.passShoot = { seed: 5, ticks: 3600, home: t(0), away: t(1) };
}

// --- shooting-bearing window (seed 10 contains a goal by ~tick 5502, so the
// window is guaranteed to exercise shots and on-target accounting) ---
{
  const h = bootGolden({ seed: 10 });
  h.step(6000);
  const t = i => {
    const team = h.game.teams[i];
    return { passAtt: team.passAtt, passCmp: team.passCmp, shots: team.shots, onTarget: team.onTarget };
  };
  goldens.passShoot10 = { seed: 10, ticks: 6000, home: t(0), away: t(1) };
}

// --- first natural goal (seed 10) ---
{
  const h = bootGolden({ seed: 10 });
  const tick = stepUntil(h, g => g.match.score[0] + g.match.score[1] > 0);
  const doc = h.exportScript();
  const goalEv = doc.events.filter(e => e.type === 'goal').pop();
  goldens.goal = {
    seed: 10, firstGoalTick: tick, stateAtGoal: h.game.match.state,
    score: [...h.game.match.score], scorer: goalEv ? goalEv.actor : null,
  };
  // continue through the automatic replay + restart and pin the hash
  h.step(1500);
  goldens.goal.hashAfterReplay = fullHash(h);
}

// --- tactics defaults + coach phrase effects ---
{
  const base = bootGolden({ seed: 1 });
  const defaults = { ...base.game.teams[0].tactics };
  goldens.tacticsDefaults = Object.fromEntries(
    Object.entries(defaults).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v]));
  const phrases = ['park the bus', 'press high', 'attack the left wing', 'waste time', 'play long balls'];
  goldens.coach = {};
  for (const phrase of phrases){
    const h = bootGolden({ seed: 1 });
    const before = { ...h.game.teams[0].tactics };
    const msgs = h.coach(phrase);
    goldens.coach[phrase] = { understood: msgs.length > 0, changes: tacticsDiff(before, h.game.teams[0].tactics) };
  }
}

// --- script metadata ---
{
  const h = bootGolden({ seed: 5 });
  h.step(120);
  const doc = h.exportScript();
  goldens.script = { version: doc.version, kind: doc.kind };
}

const out = join(REPO_ROOT, 'tests', 'characterization', 'goldens.json');
writeFileSync(out, JSON.stringify(goldens, null, 2) + '\n');
console.log('wrote', out, '· sourceHash', goldens.sourceHash, '· goal tick', goldens.goal.firstGoalTick);
