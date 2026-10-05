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
  throw new Error('NotImplemented: getMaterialChannels');
}
