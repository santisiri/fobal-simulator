export { startLobbyServer } from './hub.js';
export type { LobbyServer, LobbyServerOptions } from './hub.js';
export { LobbyStore } from './store.js';
export type { Account, MatchRecord } from './store.js';
export { signSession, verifySession, SESSION_MAX_AGE_MS } from './sessions.js';
export type { SessionPayload } from './sessions.js';
export { buildTeam, buildManifest } from './teams.js';

// CLI entry — configuration is environment-only:
//   PORT                    listen port (default 8475)
//   FOBAL_LOBBY_SECRET      session HMAC secret (generated when unset)
//   FOBAL_LOBBY_STORE       store root (default var/lobby)
//   FOBAL_MATCH_URL         match server the lobby creates matches on
//                           (default http://localhost:8473)
//   FOBAL_PUBLIC_MATCH_URL  match server base handed to browsers
//                           (default: FOBAL_MATCH_URL)
//   FOBAL_CREATE_KEY        match-server create key (REQUIRED)
//   FOBAL_DEV_AUTH          '1' → login codes returned in the response (dev)
//   FOBAL_CORS_ORIGIN       Access-Control-Allow-Origin (default '*')
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]){
  const { startLobbyServer } = await import('./hub.js');

  const createKey = process.env.FOBAL_CREATE_KEY;
  if (!createKey){
    console.error('FOBAL_CREATE_KEY is required (the lobby creates matches on the match server)');
    process.exit(1);
  }
  const devAuth = process.env.FOBAL_DEV_AUTH === '1';
  const server = await startLobbyServer({
    port: Number(process.env.PORT ?? 8475),
    secret: process.env.FOBAL_LOBBY_SECRET,
    storeRoot: process.env.FOBAL_LOBBY_STORE ?? 'var/lobby',
    matchServer: {
      url: process.env.FOBAL_MATCH_URL ?? 'http://localhost:8473',
      publicUrl: process.env.FOBAL_PUBLIC_MATCH_URL,
      createKey,
    },
    devAuth,
    corsOrigin: process.env.FOBAL_CORS_ORIGIN,
  });
  console.log(JSON.stringify({ msg: 'lobby_listening', port: server.port, accounts: server.store.accountCount }));
  if (devAuth) console.log('DEV AUTH ENABLED — login codes are returned to the browser; never run staging like this');

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ msg: 'shutdown', signal }));
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
