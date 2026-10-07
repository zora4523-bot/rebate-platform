// Offline renderer. Execute only in the isolated verification/load environment.
import { buildLoadImport, readUnionRecordings, type LoadStubOptions } from './stubs.ts';
import { object } from './recordings.ts';

const [root, optionsJson = '{}', ...extra] = process.argv.slice(2);
if (root === undefined || extra.length > 0) {
  throw new Error('Usage: node infra/load/wiremock/render.ts <recordings-root> [options-json]');
}
const options = object(JSON.parse(optionsJson) as unknown);
if (
  Object.keys(options).some(
    (key) => !['delayMs', 'faultPercent', 'faultKind', 'toolCall'].includes(key),
  )
) {
  throw new Error('Unknown load stub option');
}
process.stdout.write(
  `${JSON.stringify(buildLoadImport(readUnionRecordings(root), options as LoadStubOptions), null, 2)}\n`,
);
