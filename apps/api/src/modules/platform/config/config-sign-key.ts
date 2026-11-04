import type { KeyObject } from 'node:crypto';
import type { AppEnv } from './app-env.ts';

export interface ConfigSignKeyConfig {
  readonly file: string;
  readonly kid: string;
}

export interface ConfigSignKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export function loadConfigSignKey(
  appEnv: AppEnv,
  config: ConfigSignKeyConfig | null,
): Promise<ConfigSignKey> {
  void appEnv;
  void config;
  throw new Error('NotImplemented: loadConfigSignKey');
}
