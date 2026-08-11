// Generate a fresh Ed25519 result-signing key as PEM on STDOUT — nothing
// else is printed there, so it pipes straight into Secrets Manager without
// the key ever touching a terminal scrollback or a log:
//
//   npx tsx tools/generate-signing-key.mjs | aws secretsmanager create-secret \
//     --name fobal/prod/match-server/signing-key \
//     --secret-string file:///dev/stdin --region sa-east-1
//
// Run ONCE per environment. Rotating it invalidates verification of every
// previously signed result against the new public key — treat it like the
// long-lived identity it is.
import { generateSigningKeys, exportPrivatePem } from '@fobal/match-server';

if (process.stdout.isTTY){
  console.error('refusing to print a signing key to a terminal — pipe it (see header comment)');
  process.exit(1);
}
const keys = generateSigningKeys();
process.stdout.write(exportPrivatePem(keys));
console.error('ed25519 signing key written to stdout (pipe target only)');
