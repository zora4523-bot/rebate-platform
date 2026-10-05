import { expect, it } from 'vitest';
import { createHttpApp } from '../../bootstrap.ts';
import {
  AUDIT_PORT,
  FixedClock,
  createRootLogger,
  loadConfig,
  type AuditPort,
} from '../platform/index.ts';
import { TOTP_REPLAY_STORE } from './admin.module.ts';
import type { TotpReplayStore } from './domain/totp.ts';

it('[AC-F1-06b-WIRE#1] the app provides AUDIT_PORT globally; without a database it refuses writes', async () => {
  const app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2031-01-01T00:00:00Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  try {
    await app.init();
    const port = app.get<AuditPort>(AUDIT_PORT);
    expect(typeof port.append).toBe('function');
    await expect(
      port.append({
        appId: 'couli',
        actor: '019a0000-0000-7000-8000-000000000001',
        action: 'fixture.action',
        target: null,
        before: null,
        after: null,
        ip: null,
      }),
    ).rejects.toThrow(/no database/);
  } finally {
    await app.close();
  }
});

it('[AC-F1-06b-WIRE#2] the admin module provides the TOTP replay store; without a database it fails closed', async () => {
  const app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2031-01-01T00:00:00Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  try {
    await app.init();
    const store = app.get<TotpReplayStore>(TOTP_REPLAY_STORE);
    await expect(
      store.consume({
        appId: 'couli',
        adminId: '019a0000-0000-7000-8000-000000000001',
        timeStep: 1n,
      }),
    ).rejects.toThrow(/no database/);
  } finally {
    await app.close();
  }
});
