export { startMatchServer } from './hub.js';
export type { MatchServer, MatchServerOptions } from './hub.js';
export { MatchRoom } from './room.js';
export type { RoomClient, RoomOptions } from './room.js';
export { MatchStore } from './store.js';
export { signToken, verifyToken } from './tokens.js';
export type { TokenPayload } from './tokens.js';
export { generateSigningKeys, keysFromPem, exportPrivatePem, signResult, verifyResult } from './signing.js';
export type { SigningKeys } from './signing.js';
export { extractGoalClips } from './replays.js';
export type { GoalClip, GoalClipFrame } from './replays.js';

// CLI entry: PORT, FOBAL_SECRET, FOBAL_CREATE_KEY, FOBAL_STORE
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]){
  const { startMatchServer } = await import('./hub.js');
  const server = await startMatchServer({
    port: Number(process.env.PORT ?? 8473),
    secret: process.env.FOBAL_SECRET,
    createKey: process.env.FOBAL_CREATE_KEY,
    storeRoot: process.env.FOBAL_STORE ?? 'var/matches',
    autoDrive: true,   // drive created matches in real time; resume unfinished ones on boot
  });
  console.log(`fobal match server listening on :${server.port}`);
  console.log(`match creation key: ${server.createKey}`);
}
