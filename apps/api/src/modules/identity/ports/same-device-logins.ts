import type { SameDeviceLoginReader } from '../../risk/index.ts';

/** Query only through the handle passed to read(); identity owns login_logs and merge metadata. */
export function createSameDeviceLoginReader(): SameDeviceLoginReader {
  throw new Error('NotImplemented: createSameDeviceLoginReader');
}
