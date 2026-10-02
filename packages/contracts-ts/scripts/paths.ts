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
export const enumsDir = join(contractsDir, 'enums');
export const errorCodesFile = join(contractsDir, 'error-codes.yaml');
export const enumsGeneratedFile = join(packageDir, 'src', 'enums.gen.ts');
export const errorCodesGeneratedFile = join(packageDir, 'src', 'error-codes.gen.ts');
export const bridgeFile = join(contractsDir, 'bridge.schema.json');
export const routesFile = join(contractsDir, 'routes.json');
export const appsFile = join(contractsDir, 'apps.json');
export const bridgeGeneratedFile = join(packageDir, 'src', 'bridge.gen.ts');
