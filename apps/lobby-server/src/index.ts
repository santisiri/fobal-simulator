export { startLobbyServer } from './hub.js';
export type { LobbyServer, LobbyServerOptions } from './hub.js';
export { LobbyStore } from './store.js';
export type { Account, MatchRecord, MatchResultSummary, LobbyStoreOptions } from './store.js';
export { signSession, verifySession, SESSION_MAX_AGE_MS } from './sessions.js';
export type { SessionPayload } from './sessions.js';
export { buildTeam, buildManifest } from './teams.js';
export { createSesDeliverer } from './email.js';
export type { SesDelivererOptions } from './email.js';

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
//   FOBAL_EMAIL_BACKEND     'ses' → deliver codes by email (SESv2)
//   FOBAL_EMAIL_FROM        verified sender identity (required for ses)
//   FOBAL_TEST_LOGIN_KEY    secret; requests with x-fobal-test-key equal to
//                           it receive the code in the response (acceptance)
//   FOBAL_CORS_ORIGIN       Access-Control-Allow-Origin (default '*')
//   FOBAL_LOBBY_BACKEND     'file' (default) or 's3' (hydrate + write-through
//                           mirror; Fargate disks are ephemeral)
//   FOBAL_LOBBY_BUCKET      S3 bucket for the s3 backend (the replay bucket)
//   FOBAL_LOBBY_S3_PREFIX   object key prefix (default lobby/)
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]){
  const { startLobbyServer } = await import('./hub.js');
  const { LobbyStore } = await import('./store.js');

  const createKey = process.env.FOBAL_CREATE_KEY;
  if (!createKey){
    console.error('FOBAL_CREATE_KEY is required (the lobby creates matches on the match server)');
    process.exit(1);
  }
  const storeRoot = process.env.FOBAL_LOBBY_STORE ?? 'var/lobby';
  let store: InstanceType<typeof LobbyStore>;
  if ((process.env.FOBAL_LOBBY_BACKEND ?? 'file') === 's3'){
    const bucket = process.env.FOBAL_LOBBY_BUCKET;
    if (!bucket){
      console.error('FOBAL_LOBBY_BACKEND=s3 requires FOBAL_LOBBY_BUCKET');
      process.exit(1);
    }
    const { S3ObjectStore } = await import('@fobal/match-server');
    store = new LobbyStore({
      root: storeRoot,
      objectStore: new S3ObjectStore(bucket),
      keyPrefix: process.env.FOBAL_LOBBY_S3_PREFIX ?? 'lobby/',
      onMirrorError: err => console.error(JSON.stringify({ msg: 'lobby_mirror_error', error: err.message })),
    });
    await store.hydrate();
    console.log(JSON.stringify({ msg: 'lobby_store_hydrated', bucket, accounts: store.accountCount }));
  } else {
    store = new LobbyStore(storeRoot);
  }
  const devAuth = process.env.FOBAL_DEV_AUTH === '1';
  let deliverCode;
  if (process.env.FOBAL_EMAIL_BACKEND === 'ses'){
    const from = process.env.FOBAL_EMAIL_FROM;
    if (!from){
      console.error('FOBAL_EMAIL_BACKEND=ses requires FOBAL_EMAIL_FROM (a verified SES identity)');
      process.exit(1);
    }
    const { createSesDeliverer } = await import('./email.js');
    deliverCode = createSesDeliverer({ from });
    console.log(JSON.stringify({ msg: 'email_delivery', backend: 'ses', from }));
  }
  const server = await startLobbyServer({
    port: Number(process.env.PORT ?? 8475),
    secret: process.env.FOBAL_LOBBY_SECRET,
    store,
    deliverCode,
    testLoginKey: process.env.FOBAL_TEST_LOGIN_KEY,
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
