// Build-time only. Run from the repository root with:
// node apps/api/src/modules/platform/specs/scripts/generate-material-channels.ts
// Writes ../material-channels.gen.ts (MATERIAL_CHANNELS) from specs/material-channels.yaml,
// keeping every field, the version string and the channel order, including channels with
// selectable: false (callers filter; BR-TEXT-17). Only the shape the runtime type promises is
// checked here. Rerun after changing the specification; the rule tests fail until it matches.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, isRecord, parseSpecYaml, renderModule } from './shared.ts';

export const materialChannelsSpecFile = new URL(
  '../../../../../../../specs/material-channels.yaml',
  import.meta.url,
);
export const materialChannelsGenFile = new URL('../material-channels.gen.ts', import.meta.url);

const SORT_BASES = new Set(['sales', 'popularity', 'personalized']);

/**
 * Build-time renderer: read the supplied YAML file and emit material-channels.gen.ts source,
 * exporting MATERIAL_CHANNELS. Preserve entries even when selectable is false.
 */
export async function materialChannelsSource(inputFile: URL): Promise<string> {
  const spec = await parseSpecYaml(inputFile);
  if (typeof spec['version'] !== 'string') fail(inputFile, 'version must be a string');
  const channels = spec['channels'];
  if (!Array.isArray(channels)) fail(inputFile, 'channels must be a list');
  channels.forEach((channel: unknown, index) => {
    if (
      !isRecord(channel) ||
      typeof channel['platform'] !== 'string' ||
      typeof channel['channel_id'] !== 'string' ||
      typeof channel['name'] !== 'string' ||
      typeof channel['sort_basis'] !== 'string' ||
      !SORT_BASES.has(channel['sort_basis']) ||
      typeof channel['selectable'] !== 'boolean' ||
      typeof channel['source'] !== 'string'
    ) {
      fail(
        inputFile,
        `channels[${String(index)}] must be {platform, channel_id, name, sort_basis, selectable, source}`,
      );
    }
  });
  return renderModule({
    source: 'specs/material-channels.yaml',
    script: 'generate-material-channels.ts',
    exportName: 'MATERIAL_CHANNELS',
    value: spec,
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(materialChannelsGenFile, await materialChannelsSource(materialChannelsSpecFile));
}
