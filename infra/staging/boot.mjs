// Preloaded into each of the five staging processes before its entry module (B1-01zc):
//   node --import ./infra/staging/boot.mjs apps/api/dist/main.<entry>.js
// No shell, nothing on the command line, nothing printed from the files it reads.
import { appendFileSync, readFileSync } from 'node:fs';

// 1. Start counter for the compose health checks. /tmp lives in the container's writable layer:
//    it survives an automatic restart of the same container and starts empty in every container
//    that deploy.sh recreates. A process that started more than once before its first healthy
//    check (an early crash of worker or payout, say) therefore never reports healthy, so
//    `up --wait` fails and deploy.sh rolls back.
appendFileSync('/tmp/couli-starts', `${String(Date.now())}\n`);

// 2. api only: the access-token signing key (contract in apps/api/src/modules/platform/config/
//    jwt.ts) comes from read-only mounted files, so the PEM never sits in an env file, in
//    `docker inspect` or on a command line. COULI_JWT_DIR is set by compose for api alone; the
//    other entries must not see a key id without a key (loadConfig rejects half a pair).
const jwtDir = process.env['COULI_JWT_DIR'];
if (jwtDir !== undefined && jwtDir !== '') {
  try {
    process.env['JWT_PRIVATE_KEY_PEM'] = readFileSync(`${jwtDir}/es256.pem`, 'utf8');
    process.env['JWT_KEY_ID'] = readFileSync(`${jwtDir}/key-id`, 'utf8').trim();
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
    process.stderr.write(`[boot] cannot read the signing key files in ${jwtDir} (${code})\n`);
    process.exit(1);
  }
}
