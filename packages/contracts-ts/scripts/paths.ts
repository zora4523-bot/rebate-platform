// Locations shared by the contract scripts. Paths are derived from this file so the scripts
// work from any working directory (the repository path contains non-ASCII characters).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

export const packageDir = dirname(scriptsDir);
export const repoRoot = dirname(dirname(packageDir));
export const contractsDir = join(repoRoot, 'contracts');
export const openapiFile = join(contractsDir, 'openapi.yaml');
export const redoclyConfigFile = join(contractsDir, 'redocly.yaml');
export const generatedFile = join(packageDir, 'src', 'openapi.gen.ts');
