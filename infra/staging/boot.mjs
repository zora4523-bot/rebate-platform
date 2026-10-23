// Preloaded into each of the five staging processes before its entry module (B1-01zc):
//   node --import ./infra/staging/boot.mjs apps/api/dist/main.<entry>.js
// No shell, nothing on the command line, nothing printed from the files it reads.
import { appendFileSync, readFileSync } from 'node:fs';

// 1. Start counter for the compose health checks. /tmp lives in the container's writable layer:
//    it survives an automatic restart of the same container and starts empty in every container
//    that deploy.sh recreates. A process that started more than once before deploy.sh marks the
//    deployment settled (/tmp/couli-settled, after all five are healthy with RestartCount 0)
//    therefore never reports healthy, so `up --wait` fails and deploy.sh rolls back.
appendFileSync('/tmp/couli-starts', `${String(Date.now())}\n`);

// 2. Access-token key material comes from read-only mounted files, so a PEM never sits in an
//    env file, in `docker inspect` or on a command line (contract in
//    apps/api/src/modules/platform/config/jwt.ts). compose sets at most one of the two
//    directories per entry; the other entries must not see a key id without a key (loadConfig
//    rejects half a pair).
//    - COULI_JWT_DIR, api only: the signing key (es256.pem) and its key-id.
//    - COULI_JWT_PUB_DIR, stream only: the matching verification public key (es256.pub.pem)
//      and the same key-id. stream never gets the private key, even if one lies in that
//      directory by mistake.
const jwtDir = process.env['COULI_JWT_DIR'];
const jwtPubDir = process.env['COULI_JWT_PUB_DIR'];
const signs = jwtDir !== undefined && jwtDir !== '';
const verifies = jwtPubDir !== undefined && jwtPubDir !== '';

function readKeyFiles(directory, pemFile, pemVariable, what) {
  try {
    const pem = readFileSync(`${directory}/${pemFile}`, 'utf8');
    const keyId = readFileSync(`${directory}/key-id`, 'utf8').trim();
    process.env[pemVariable] = pem;
    process.env['JWT_KEY_ID'] = keyId;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
    process.stderr.write(`[boot] cannot read the ${what} files in ${directory} (${code})\n`);
    process.exit(1);
  }
}

if (signs && verifies) {
  process.stderr.write('[boot] COULI_JWT_DIR and COULI_JWT_PUB_DIR are mutually exclusive\n');
  process.exit(1);
}
if (signs) readKeyFiles(jwtDir, 'es256.pem', 'JWT_PRIVATE_KEY_PEM', 'signing key');
if (verifies) readKeyFiles(jwtPubDir, 'es256.pub.pem', 'JWT_PUBLIC_KEY_PEM', 'verification key');
