// Environment definitions (M3): one parameterized stack, two worlds.
// Staging values are EXACTLY the constants the deployed stack was born
// with — the multi-env refactor must keep its template byte-stable.
export interface FobalEnvConfig {
  /** resource-name prefix: fobal-staging | fobal-prod */
  prefix: string;
  /** role-name infix: Fobal-<infix>-… (staging | prod) */
  roleInfix: string;
  /** Environment tag value (boundary conditions must allow it) */
  environmentTag: string;
  matchesHostname: string;
  lobbyHostname: string;
  playHostname: string;
  /** EMF namespace + match-server log group (identical, historical) */
  namespace: string;
  lobbyLogGroup: string;
  /** Secrets Manager prefix: fobal/staging | fobal/prod */
  secretsPrefix: string;
  /** FOBAL_WS_ORIGINS value (prod pins to the prod origin ONLY) */
  wsOrigins: string;
  /** import fobal/<env>/match-server/signing-key and inject
   *  FOBAL_SIGNING_KEY (prod: results must verify across task restarts) */
  stableSigningKey: boolean;
  /** lobby login codes in responses (staging keeps the SES+test-key combo;
   *  neither env uses open dev auth) */
  taskCpu: number;
  taskMemoryMiB: number;
  /** FOBAL_MAX_ROOMS override; undefined → server default 25 (SCALE.md) */
  maxRooms?: string;
  /** context keys for the listener certificate ARNs */
  certContextKey: string;
  wildcardCertContextKey: string;
  /** SNS email endpoint for alarms. Deliberately IN CODE, not a deploy
   *  context: a context forgotten on one deploy would silently delete the
   *  subscription. The recipient must click Confirm subscription once per
   *  topic; remove the field to run alarms actionless. */
  alarmEmail?: string;
  /** M5: chain config for the lobby's D1 reader (FOBAL_RPC_URL /
   *  FOBAL_CHAIN_PLAYER / FOBAL_CHAIN_REGISTRY). IN CODE for the same
   *  reason as alarmEmail — a forgotten context would silently unlink every
   *  player's NFT squad on the next deploy. Fill in when the Base Sepolia
   *  deploy lands (addresses from contracts/deployments/<chainId>.json);
   *  undefined ships the lobby dark (/squad/chain answers 501). */
  chain?: { rpcUrl: string; playerAddress: string; registryAddress: string };
}

export const ENVS: Record<'staging' | 'production', FobalEnvConfig> = {
  staging: {
    prefix: 'fobal-staging',
    roleInfix: 'staging',
    environmentTag: 'staging',
    matchesHostname: 'matches-staging.fobal.ai',
    lobbyHostname: 'lobby-staging.fobal.ai',
    playHostname: 'play-staging.fobal.ai',
    namespace: '/fobal/staging/match-server',
    lobbyLogGroup: '/fobal/staging/lobby-server',
    secretsPrefix: 'fobal/staging',
    wsOrigins: 'https://play-staging.fobal.ai,http://localhost:8471,http://localhost:8474',
    stableSigningKey: false,
    taskCpu: 256,
    taskMemoryMiB: 512,
    certContextKey: 'certificateArn',
    wildcardCertContextKey: 'wildcardCertificateArn',
    alarmEmail: 'santisiri@gmail.com',
  },
  production: {
    prefix: 'fobal-prod',
    roleInfix: 'prod',
    environmentTag: 'production',
    matchesHostname: 'matches.fobal.ai',
    lobbyHostname: 'lobby.fobal.ai',
    playHostname: 'play.fobal.ai',
    namespace: '/fobal/prod/match-server',
    lobbyLogGroup: '/fobal/prod/lobby-server',
    secretsPrefix: 'fobal/prod',
    // prod origin ONLY — no localhost escape hatches
    wsOrigins: 'https://play.fobal.ai',
    stableSigningKey: true,
    // SCALE.md capacity rung: 0.5 vCPU / 1 GB → ~90 rooms
    taskCpu: 512,
    taskMemoryMiB: 1024,
    maxRooms: '90',
    certContextKey: 'prodCertificateArn',
    wildcardCertContextKey: 'prodWildcardCertificateArn',
    alarmEmail: 'santisiri@gmail.com',
  },
};
