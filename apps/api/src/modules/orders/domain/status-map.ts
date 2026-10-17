export type PlatformStatusEvent =
  | 'PLATFORM_DEPOSIT_PAID'
  | 'PLATFORM_PAID'
  | 'PLATFORM_RECEIVED'
  | 'PLATFORM_SETTLED'
  | 'PLATFORM_INVALID'
  | 'PLATFORM_PUNISH'
  | 'PLATFORM_RIGHTS';

export interface StatusMapEntry {
  readonly event: PlatformStatusEvent;
  readonly source: string;
  readonly verified: boolean;
  readonly note: string;
}

export interface StatusMap {
  readonly platform: string;
  readonly entries: ReadonlyMap<string, StatusMapEntry>;
}

export type PlatformStatusMapping =
  | { readonly kind: 'event'; readonly event: PlatformStatusEvent; readonly verified: boolean }
  | { readonly kind: 'unmapped'; readonly rawCode: string | null };

export function loadStatusMap(platform: string, csvText: string | null): StatusMap {
  void platform;
  void csvText;
  throw new Error('NotImplemented: loadStatusMap');
}

export function mapPlatformStatus(map: StatusMap, rawCode: string | null): PlatformStatusMapping {
  void map;
  void rawCode;
  throw new Error('NotImplemented: mapPlatformStatus');
}
