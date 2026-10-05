import { MATERIAL_CHANNELS } from './material-channels.gen.ts';

/** Runtime snapshot of specs/material-channels.yaml, including non-selectable entries. */
export interface MaterialChannelsSpec {
  readonly version: string;
  readonly channels: readonly {
    readonly platform: string;
    readonly channel_id: string;
    readonly name: string;
    readonly sort_basis: 'sales' | 'popularity' | 'personalized';
    readonly selectable: boolean;
    readonly source: string;
  }[];
}

/** Read the generated snapshot without loading YAML at runtime. */
export function getMaterialChannels(): MaterialChannelsSpec {
  // The generated constant itself, so every caller shares one table.
  return MATERIAL_CHANNELS;
}
