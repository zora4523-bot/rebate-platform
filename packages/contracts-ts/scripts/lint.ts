// Runs `redocly lint` on contracts/openapi.yaml with contracts/redocly.yaml and propagates the
// exit code. The environment switches off telemetry and the update check so the command never
// waits on the network (the verify container and the Codex sandbox have none).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { contractsDir, openapiFile, packageDir, redoclyConfigFile } from './paths.ts';

const redoclyBin = join(packageDir, 'node_modules', '.bin', 'redocly');
if (!existsSync(redoclyBin)) {
  console.error(`contract:lint: ${redoclyBin} not found; run pnpm install first.`);
  process.exit(2);
}

const result = spawnSync(
  redoclyBin,
  [
    'lint',
    openapiFile,
    '--config',
    redoclyConfigFile,
    '--format',
    'stylish',
    ...process.argv.slice(2),
  ],
  {
    cwd: contractsDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      REDOCLY_TELEMETRY: 'off',
      REDOCLY_SUPPRESS_UPDATE_NOTICE: 'true',
    },
  },
);

if (result.error !== undefined) {
  console.error(`contract:lint: failed to start redocly: ${result.error.message}`);
  process.exit(2);
}
if (result.signal !== null) {
  console.error(`contract:lint: redocly was killed by ${result.signal}`);
  process.exit(2);
}
process.exit(result.status ?? 2);
