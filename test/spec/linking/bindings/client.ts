import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { sign } from '../../risk/signature/kit.ts';
import type { Fixture } from './kit.ts';

export interface RequestOptions {
  key?: string;
  trace?: string;
  token?: string | null;
  platform?: string;
  reportedClient?: string;
}
export async function client(
  f: Fixture,
  options: {
    appId?: string;
    uid?: string;
    deviceClient?: 'ios' | 'android' | 'harmony';
  } = {},
) {
  const appId = options.appId ?? `binding_${randomUUID().replaceAll('-', '')}`;
  const deviceClient = options.deviceClient ?? 'ios';
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': deviceClient,
    'x-app-version': '2.0.0',
    'x-channel': 'synthetic',
  };
  const registered = await f.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: deviceClient === 'ios' ? 'idfv' : 'oaid',
    }),
  });
  expect(registered.statusCode).toBe(200);
  const { data } = registered.json<{ data: { device_id: string; install_secret: string } }>();
  expect(data).toMatchObject({ device_id: expect.any(String), install_secret: expect.any(String) });
  const uid = options.uid ?? (await seedUser(f.db, appId));
  if (options.uid === undefined) {
    await f.db
      .insertInto('user_risk_state')
      .values({
        app_id: appId,
        user_id: uid,
        state: 'normal',
        changed_by: 'synthetic',
        changed_at: f.clock.now(),
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .execute();
  }
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
  function request(
    method: 'POST' | 'GET',
    body: Record<string, unknown> | undefined,
    requestOptions: RequestOptions = {},
  ) {
    const url =
      method === 'GET'
        ? '/v1/unions/bindings'
        : `/v1/unions/${requestOptions.platform ?? 'taobao'}/bindings`;
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(f.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const token = requestOptions.token === undefined ? session.access_token : requestOptions.token;
    return f.app.inject({
      method,
      url,
      ...(method === 'POST' ? { payload: raw } : {}),
      headers: {
        ...headers,
        'x-platform': requestOptions.reportedClient ?? deviceClient,
        'x-device-id': data.device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign(method, url, Buffer.from(raw), timestamp, nonce, data.install_secret),
        'x-trace-id': requestOptions.trace ?? randomUUID(),
        ...(method === 'POST' ? { 'idempotency-key': requestOptions.key ?? randomUUID() } : {}),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
    });
  }
  return {
    appId,
    uid,
    deviceId: data.device_id,
    deviceClient,
    post: (body: Record<string, unknown>, opts?: RequestOptions) => request('POST', body, opts),
    list: (opts?: RequestOptions) => request('GET', undefined, opts),
  };
}
export type Client = Awaited<ReturnType<typeof client>>;
export async function loginAs(f: Fixture, c: Client, uid: string) {
  const session = await f.db
    .transaction()
    .execute((trx) =>
      createSession(
        trx,
        { uid, app_id: c.appId, device_id: c.deviceId, scp: 'full' },
        { clock: f.clock, tokens: f.app.get<TokenService>(TOKEN_SERVICE) },
      ),
    );
  return session.access_token;
}
export function web(state: string, code = 'synthetic-code-value') {
  return { state, auth_method: 'web_code', code };
}
export function sdk(state: string) {
  return {
    state,
    auth_method: 'sdk_token',
    access_token: Buffer.from('synthetic sdk credential', 'ascii').toString('hex'),
    expires_in: 3600,
  };
}
