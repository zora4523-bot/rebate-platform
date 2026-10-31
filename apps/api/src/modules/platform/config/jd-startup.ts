// Starting the real Jingdong adapter (B1-04ze). Skeleton of the rule-test round: the signature the
// rule tests in test/spec/union/jd-live-wiring/ import.
import type { AppEnv } from './app-env.ts';
import type { JdAppConfig } from './jd.ts';

export interface JdAppCredentials {
  readonly appKey: string;
  readonly appSecret: string;
}

export async function openJdCredentials(
  appEnv: AppEnv,
  jd: JdAppConfig | null | undefined,
): Promise<() => Promise<JdAppCredentials>> {
  void appEnv;
  void jd;
  throw new Error('NotImplemented: openJdCredentials');
}
