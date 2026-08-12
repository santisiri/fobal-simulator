export { startMatchServer } from './hub.js';
export type { MatchServer, MatchServerOptions } from './hub.js';
export { MatchRoom } from './room.js';
export type { RoomClient, RoomOptions } from './room.js';
export { MatchStore } from './store.js';
export { signToken, verifyToken } from './tokens.js';
export type { TokenPayload } from './tokens.js';
export { generateSigningKeys, keysFromPem, exportPrivatePem, signResult, verifyResult } from './signing.js';
export type { SigningKeys } from './signing.js';
export { extractGoalClips, extractReplayStream } from './replays.js';
export type { GoalClip, GoalClipFrame, ReplayStream, ReplayStreamFrame } from './replays.js';
export { MirroredMatchStore } from './mirroredStore.js';
export type { MirroredStoreOptions } from './mirroredStore.js';
export { MemoryObjectStore, S3ObjectStore } from './objectStore.js';
export type { ObjectStore } from './objectStore.js';
export { createCoachInterpreter } from './coach.js';
export type { CoachContext, CoachInterpretation, CoachInterpreter, CoachInterpreterOptions } from './coach.js';
export { createTelemetry, noopTelemetry } from './telemetry.js';
export { createTranscriber } from './stt.js';
export type { SttOptions, Transcriber } from './stt.js';
export type { Telemetry, TelemetryOptions, MetricUnit } from './telemetry.js';

// CLI entry — configuration is environment-only (ECS injects the secrets
// from Secrets Manager; see infra/cdk/lib/fobal-staging-stack.ts):
//   PORT                  listen port (default 8473)
//   FOBAL_SECRET          token HMAC secret (generated when unset)
//   FOBAL_CREATE_KEY      match-creation bearer key (generated when unset)
//   FOBAL_STORE           local store root (default var/matches)
//   FOBAL_STORE_BACKEND   'file' (default) or 's3'
//   FOBAL_REPLAY_BUCKET   S3 bucket (required for the s3 backend)
//   FOBAL_S3_PREFIX       object key prefix (default matches/)
//   FOBAL_SIGNING_KEY     PEM Ed25519 private key; ephemeral per boot when unset
//   FOBAL_CLOUDWATCH_NAMESPACE  EMF metrics namespace (unset → plain log lines)
//   FOBAL_WS_ORIGINS      comma-separated browser Origin allowlist for WS
//                         upgrades (unset → allow all; tools always pass)
//   FOBAL_MAX_CONN_PER_IP concurrent sockets per client IP (default 20)
//   FOBAL_MAX_CONN        total concurrent sockets (default 500)
//   FOBAL_TRUST_PROXY     '1' → client IP from x-forwarded-for (behind ALB)
//   FOBAL_MAX_ROOMS       concurrent room cap (default 25; docs/SCALE.md)
//   FOBAL_STT_API_KEY     hosted STT key (M4 voice); unset → 501 fallback
//   FOBAL_STT_URL         OpenAI-compatible transcriptions endpoint
//   FOBAL_STT_MODEL       e.g. whisper-1 (OpenAI) / whisper-large-v3-turbo (Groq)
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]){
  const { startMatchServer } = await import('./hub.js');
  const { MatchStore } = await import('./store.js');
  const { keysFromPem } = await import('./signing.js');
  const { createTelemetry } = await import('./telemetry.js');

  const telemetry = createTelemetry({
    metricsNamespace: process.env.FOBAL_CLOUDWATCH_NAMESPACE,
  });
  const backend = process.env.FOBAL_STORE_BACKEND ?? 'file';
  const storeRoot = process.env.FOBAL_STORE ?? 'var/matches';
  let store: InstanceType<typeof MatchStore>;
  let drain: () => Promise<void> = async () => {};
  if (backend === 's3'){
    const bucket = process.env.FOBAL_REPLAY_BUCKET;
    if (!bucket){
      console.error('FOBAL_STORE_BACKEND=s3 requires FOBAL_REPLAY_BUCKET');
      process.exit(1);
    }
    const { MirroredMatchStore } = await import('./mirroredStore.js');
    const { S3ObjectStore } = await import('./objectStore.js');
    const mirrored = new MirroredMatchStore(storeRoot, new S3ObjectStore(bucket), {
      keyPrefix: process.env.FOBAL_S3_PREFIX ?? 'matches/',
    });
    const hydrated = await mirrored.hydrate();
    telemetry.log('store_hydrated', { backend, bucket, matches: hydrated.length });
    store = mirrored;
    drain = () => mirrored.drain();
  } else if (backend === 'file'){
    store = new MatchStore(storeRoot);
  } else {
    console.error(`unknown FOBAL_STORE_BACKEND '${backend}' (expected 'file' or 's3')`);
    process.exit(1);
  }

  const server = await startMatchServer({
    port: Number(process.env.PORT ?? 8473),
    secret: process.env.FOBAL_SECRET,
    createKey: process.env.FOBAL_CREATE_KEY,
    store,
    keys: process.env.FOBAL_SIGNING_KEY ? keysFromPem(process.env.FOBAL_SIGNING_KEY) : undefined,
    corsOrigin: process.env.FOBAL_CORS_ORIGIN,
    // C2: the LLM coach interpreter activates when a key is present
    // (staging: Secrets Manager → env); FOBAL_AI_MODEL overrides the model
    coach: { apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.FOBAL_AI_MODEL },
    stt: {
      apiKey: process.env.FOBAL_STT_API_KEY,
      url: process.env.FOBAL_STT_URL,
      model: process.env.FOBAL_STT_MODEL,
    },
    telemetry,
    wsOrigins: process.env.FOBAL_WS_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean),
    maxConnectionsPerIp: process.env.FOBAL_MAX_CONN_PER_IP ? Number(process.env.FOBAL_MAX_CONN_PER_IP) : undefined,
    maxConnections: process.env.FOBAL_MAX_CONN ? Number(process.env.FOBAL_MAX_CONN) : undefined,
    trustProxy: process.env.FOBAL_TRUST_PROXY === '1',
    maxRooms: process.env.FOBAL_MAX_ROOMS ? Number(process.env.FOBAL_MAX_ROOMS) : undefined,
    autoDrive: true,   // drive created matches in real time; resume unfinished ones on boot
  });
  telemetry.log('listening', { port: server.port, backend, activeRooms: server.rooms.size });
  // dev convenience only — a provisioned key must never reach the logs
  if (!process.env.FOBAL_CREATE_KEY)
    console.log(`generated match creation key: ${server.createKey}`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    telemetry.log('shutdown', { signal });
    await server.close();       // stops rooms; last internal snapshots already on disk
    await drain();              // then let the S3 mirror finish uploading
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
