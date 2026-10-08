import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { sql } from 'kysely';
import type { RiskState } from '../../../../packages/contracts-ts/src/index.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import {
  riskStateServiceToken,
  type RiskStateService,
} from '../../../../apps/api/src/modules/risk/index.ts';
import type { Response } from '../../identity/sms-codes/http-kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { openHttp, type Fixture } from '../../platform/idempotency/abandon-route/http-kit.ts';
import { envelopeValidator } from '../../platform/errors/kit.ts';
import { sign } from '../signature/kit.ts';
export { openHttp };
export type { Fixture };

interface App {
  inject(input: {
    method: string;
    url: string;
    payload?: string;
    headers: Record<string, string>;
  }): Promise<Response>;
}
export const SEARCH = '/v1/products/search?platform=taobao&q=fixture';
export async function client(f: Fixture, state: RiskState = 'banned') {
  // A real application DI lookup. No test-installed stage ⑤ guard or hook; the token skeleton
  // throws inside the test until implemented, instead of failing module loading / suite setup.
  const risk = f.app.get<RiskStateService>(riskStateServiceToken());
  const app = f.app as unknown as App;
  const appId = `risk_${randomBytes(10).toString('hex')}`;
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const device = await app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(device.json()).toMatchObject({ code: 0 });
  const data = device.json<{ data: { device_id: string; install_secret: string } }>().data;
  const uid = await seedUser(f.db, appId);
  const tokens = f.app.get<TokenService>(TOKEN_SERVICE);
  const session = await f.db
    .transaction()
    .execute((trx) =>
      createSession(
        trx,
        { uid, app_id: appId, device_id: data.device_id, scp: 'full' },
        { clock: f.clock, tokens },
      ),
    );
  const set = (next: RiskState) =>
    f.db.transaction().execute((trx) =>
      risk.setRiskState(trx, {
        app_id: appId,
        user_id: uid,
        state: next,
        reason: 'private rule details never returned',
        reason_category: next === 'normal' ? null : 'other',
        frozen_until: null,
        changed_by: 'fixture_operator',
      }),
    );
  await set(state);
  return {
    appId,
    uid,
    session,
    risk,
    set,
    async send(
      method: string,
      url: string,
      body?: unknown,
      extra: Record<string, string> = {},
      authenticated = true,
    ) {
      const raw = body === undefined && method === 'GET' ? '' : JSON.stringify(body ?? {});
      const timestamp = String(Math.floor(f.clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const path = url.split('?')[0]!;
      return app.inject({
        method,
        url,
        ...(raw === '' ? {} : { payload: raw }),
        headers: {
          ...headers,
          'x-device-id': data.device_id,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': sign(method, path, Buffer.from(raw), timestamp, nonce, data.install_secret),
          'x-trace-id': randomUUID(),
          'idempotency-key': randomUUID(),
          ...(authenticated ? { authorization: `Bearer ${session.access_token}` } : {}),
          ...extra,
        },
      });
    },
    async appeal(
      previous: 'banned' | 'frozen',
      status: 'processing' | 'upheld' = 'processing',
      user = uid,
      app_id = appId,
    ) {
      await sql`INSERT INTO app.appeals (id, app_id, user_id, target_type, target_id, prev_risk_state, status, content, deadline_at, handler_id, closed_at)
        VALUES (${randomUUID()}, ${app_id}, ${user}, 'account', ${user}, ${previous}, ${status}, 'fixture appeal', ${new Date(f.clock.now().getTime() + 86400_000)}, ${status === 'processing' ? null : 'fixture_handler'}, ${status === 'processing' ? null : f.clock.now()})`.execute(
        f.db,
      );
    },
  };
}

export async function banned(response: Response) {
  expect(response.statusCode).toBe(403);
  const body = response.json<{ code: number; trace_id: string }>();
  expect(body).toMatchObject({
    code: 10006,
    msg: expect.any(String),
    trace_id: expect.any(String),
  });
  const validate = await envelopeValidator();
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(response.headers['x-trace-id']).toBe(body.trace_id);
  // 10006 declares no data in error-codes.yaml; reason/category come from GET /v1/me.
  expect(body).not.toHaveProperty('data');
}

export function allowed(response: Response) {
  const code = response.json<{ code: number }>().code;
  expect(code).not.toBe(10006);
  // A signature/token failure would make a vacuous whitelist test. Planned 404 is permitted.
  expect([10001, 10002, 10401, 10402, 10405]).not.toContain(code);
}
