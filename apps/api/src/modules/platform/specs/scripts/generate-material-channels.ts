/**
 * Build-time renderer: read the supplied YAML file and emit material-channels.gen.ts source,
 * exporting MATERIAL_CHANNELS. Preserve entries even when selectable is false.
 */
export async function materialChannelsSource(inputFile: URL): Promise<string> {
  void inputFile;
  throw new Error('NotImplemented: materialChannelsSource');
}
