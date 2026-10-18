import { createHmac, randomBytes } from 'node:crypto';
import type { FactoryProvider } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  APP_CONFIG,
  DB,
  FIELD_CRYPTO,
  tokenPrincipal,
  type AppConfig,
  type FieldCrypto,
} from '../../../platform/index.ts';
import type { AgentCaller } from '../../http/index.ts';
import { isUuid } from '../../store/index.ts';

/** Implemented by identity and passed in by app.module; agent owns no identity tables. */
export interface AgentCallerReader {
  phoneBound(appId: string, userId: string): Promise<boolean>;
  deviceHash(appId: string, deviceId: string): Promise<string | null>;
}

export type AgentCallerReaderFactory = (options: { db: Kysely<Database> }) => AgentCallerReader;

export interface AgentStreamRequest {
  readonly id: string;
  readonly ip: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params: { readonly id?: string; readonly run_id?: string };
  readonly body?: unknown;
}

export type AgentCallerResolver = (request: AgentStreamRequest) => Promise<AgentCaller>;
export const AGENT_CALLER = Symbol('AGENT_CALLER');
const IP_CONTEXT = 'agent.quota.ip';

export function agentCallerProvider(readerFactory: AgentCallerReaderFactory): FactoryProvider {
  return {
    provide: AGENT_CALLER,
    inject: [APP_CONFIG, { token: DB, optional: true }, { token: FIELD_CRYPTO, optional: true }],
    useFactory: (
      config: AppConfig,
      db?: Kysely<Database>,
      crypto?: FieldCrypto,
    ): AgentCallerResolver | null => {
      if (db === undefined) return null;
      // Across production replicas/restarts the existing field keyring supplies the same key.
      // An ephemeral key is only suitable for local/test processes without a keyring.
      if (crypto === undefined && config.appEnv !== 'local' && config.appEnv !== 'test') {
        throw new Error('Agent caller requires the field keyring');
      }
      const localKey = crypto === undefined ? randomBytes(32) : undefined;
      const reader = readerFactory({ db: db.withSchema('app') });
      return async (request) => {
        const principal = tokenPrincipal(request);
        const appId = principal?.app_id ?? header(request, 'x-app-id');
        const deviceId = principal?.device_id ?? header(request, 'x-device-id');
        const userId = principal?.uid ?? null;
        if (!appId || !isUuid(deviceId) || (userId !== null && !isUuid(userId))) {
          throw new Error('Agent caller identity unavailable');
        }
        const deviceHash = await reader.deviceHash(appId, deviceId);
        if (deviceHash === null) throw new Error('Agent caller device unavailable');
        const phoneBound = userId !== null && (await reader.phoneBound(appId, userId));
        // request.ip is resolved by bootstrap's trusted proxy policy, never by a raw header.
        const ipKey =
          crypto === undefined
            ? createHmac('sha256', localKey!).update(`${IP_CONTEXT}\0${request.ip}`).digest('hex')
            : crypto.blindIndex(request.ip, IP_CONTEXT);
        return { appId, deviceId, userId, deviceHash, phoneBound, ipKey, traceId: request.id };
      };
    },
  };
}

function header(request: AgentStreamRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}
