// Real AppModule + HTTP + PG through the shared kit; container execution only.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import * as review from '../../../../apps/api/src/modules/agent/stream/mount/review.ts';
import type { AppConfig } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { fixture as businessFixture, TOKEN } from '../stream-assembly/kit.ts';
import {
  APP,
  fileText,
  framesOf,
  message,
  newGuest,
  runsOf,
  usePgEach,
} from '../stream-mount/kit.ts';
import { credentials, requestContent, transport } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

interface App {
  init(): Promise<unknown>;
  close(): Promise<void>;
  inject(options: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload?: unknown;
  }): Promise<{ statusCode: number; body: string }>;
}

it.each([
  { appEnv: 'staging', configured: true, endpoint: 'https://configured-review.example.invalid/' },
  { appEnv: 'staging', configured: false, endpoint: 'https://configured-review.example.invalid/' },
  { appEnv: 'staging', configured: true, endpoint: undefined },
  { appEnv: 'test', configured: false, endpoint: 'https://configured-review.example.invalid/' },
] as const)(
  '[AC-B3-03m#21][BR-AI-18] 真实 stream 入口读取配置并审核 HTTP 消息：%j',
  async ({ appEnv, configured, endpoint }) => {
    const caller = await newGuest(pg.db);
    const f = await businessFixture(pg.db, caller);
    const wire = transport();
    vi.stubEnv('APP_ENV', appEnv);
    vi.stubEnv(
      'AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID',
      configured ? credentials.accessKeyId : undefined,
    );
    vi.stubEnv(
      'AGENT_REVIEW_ALIYUN_ACCESS_KEY_SECRET',
      configured ? credentials.accessKeySecret : undefined,
    );
    vi.stubEnv('AGENT_REVIEW_ALIYUN_ENDPOINT', endpoint);

    // Only transport/nonce are replaced through the existing optional seam. In particular,
    // never inject appEnv, credentials, endpoint, inputCheck, assembly or business ports here.
    // A root that forgets safety configuration must still fail this test.
    const originalReview = review.createStreamReview;
    const assembled = vi.spyOn(review, 'createStreamReview').mockImplementation((deps) =>
      originalReview(
        deps.options === undefined
          ? deps
          : {
              ...deps,
              options: { ...deps.options, fetch: wire.fetch, nonce: () => 'synthetic-root-nonce' },
            },
      ),
    );
    const body = vi.spyOn(core, 'createAgentRunBody');
    const resolve = vi.spyOn(DemoUnionAdapter.prototype, 'resolveLink');
    const search = vi.spyOn(DemoUnionAdapter.prototype, 'searchItems');
    const convert = vi.spyOn(DemoUnionAdapter.prototype, 'convert');

    // URL imports match AC-B3-03j#11: Nest sources use api's decorator-enabled compilation.
    const src = (path: string) => new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;
    const boot = (await import(src('bootstrap.ts'))) as {
      createHttpApp(entry: string, overrides: object): Promise<App>;
    };
    const platform = (await import(src('modules/platform/index.ts'))) as {
      JOB_QUEUE: symbol;
      FIELD_CRYPTO: symbol;
      loadConfig(env: Record<string, string | undefined>): AppConfig;
      PlatformModule: { forRoot(options: object): { providers?: unknown[]; exports?: unknown[] } };
    };
    const keyProvider = new LocalKeyProvider(randomBytes(32), 'synthetic-review-root');
    const fieldCrypto = await openFieldCrypto(await createWrappedKeyring(keyProvider), keyProvider);
    const originalPlatform = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
    vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((value) => {
      const module = originalPlatform(value);
      return {
        ...module,
        exports: [...(module.exports ?? []), platform.FIELD_CRYPTO],
        providers: [
          ...(module.providers ?? []).map((provider) =>
            typeof provider === 'object' &&
            provider !== null &&
            'provide' in provider &&
            provider.provide === platform.JOB_QUEUE
              ? {
                  provide: platform.JOB_QUEUE,
                  useValue: {
                    send: async () => null,
                    register: vi.fn(),
                    start: async () => undefined,
                    stop: async () => undefined,
                  },
                }
              : provider,
          ),
          { provide: platform.FIELD_CRYPTO, useValue: fieldCrypto },
        ],
      };
    });
    // Read the real environment configuration with synthetic values. Replace only the
    // unrelated on-disk keyring with in-memory crypto; no file or KMS access occurs.
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const config: AppConfig = {
      ...platform.loadConfig({
        APP_ENV: appEnv,
        AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID: configured ? credentials.accessKeyId : undefined,
        AGENT_REVIEW_ALIYUN_ACCESS_KEY_SECRET: configured ? credentials.accessKeySecret : undefined,
        AGENT_REVIEW_ALIYUN_ENDPOINT: endpoint,
        FIELD_KEY_PROVIDER: appEnv === 'staging' ? 'kms' : undefined,
        FIELD_KEYRING_FILE:
          appEnv === 'staging'
            ? new URL('../../../../.tmp/stream-review/unused-keyring.json', import.meta.url)
                .pathname
            : undefined,
        JWT_KEY_ID: 'synthetic-stream-review',
        JWT_PRIVATE_KEY_PEM: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      keyring: null,
    };
    const app = await boot.createHttpApp('stream', {
      config,
      clock: f.time.clock,
      logger: f.logs.logger,
      dbHandles: { db: pg.db, dbRead: null, close: async () => undefined },
    });
    try {
      await app.init();
      expect(wire.calls).toEqual([]);
      const headers = {
        'x-app-id': APP,
        'x-device-id': caller.deviceId,
        'x-platform': 'ios',
        'x-channel': 'appstore',
        'x-app-version': '2.0.0',
      };
      const created = await app.inject({ method: 'POST', url: '/v1/agent/sessions', headers });
      expect(created.statusCode, created.body).toBe(200);
      const envelope = JSON.parse(created.body) as { code: number; data: { session_id: string } };
      expect(envelope.code).toBe(0);
      const sessionId = envelope.data.session_id;
      const sent = await app.inject({
        method: 'POST',
        url: `/v1/agent/sessions/${sessionId}/messages`,
        headers,
        payload: message(`请解析这个商品 ${TOKEN}`),
      });
      expect(sent.statusCode, sent.body).toBe(200);
      const frames = framesOf([sent.body]);
      // This also makes the no-key cases red on the old root that never assembles review.
      expect(assembled).toHaveBeenCalledTimes(1);
      expect(assembled.mock.calls[0]?.[0].options).toMatchObject({ appEnv });
      expect(body).toHaveBeenCalledTimes(1);
      const ports = assembled.mock.results[0]?.value as review.StreamReviewPorts;
      expect(body.mock.calls[0]?.[0].inputCheck).toBe(ports.inputCheck);
      expect(body.mock.calls[0]?.[0].review).toBe(ports.review);
      const rows = await runsOf(pg.db, sessionId);
      expect(rows).toHaveLength(1);
      if (appEnv === 'staging' && configured && endpoint !== undefined) {
        expect(assembled.mock.calls[0]?.[0].options).toMatchObject({ credentials, endpoint });
        const inputCalls = wire.calls.filter(
          ({ init }) => requestContent(init).service === 'llm_query_moderation',
        );
        expect(inputCalls).toHaveLength(1);
        expect(inputCalls[0]?.url).toBe(endpoint);
        // B3-05d audits the preprocessed text; the token stays on the deterministic path.
        expect(requestContent(inputCalls[0]!.init).content).toBe('请解析这个商品 ');
        const inputHeaders = Object.fromEntries(
          Object.entries(inputCalls[0]!.init.headers).map(([name, value]) => [
            name.toLowerCase(),
            value,
          ]),
        );
        expect(inputHeaders['x-acs-action']).toBe('TextModerationPlus');
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(frames.filter((frame) => frame.event === 'card')).toEqual([
          expect.objectContaining({
            data: expect.objectContaining({
              type: 'notice',
              data: expect.objectContaining({ text_key: 'error.30132' }),
            }),
          }),
        ]);
        expect(frames.at(-1)).toMatchObject({ event: 'done', data: { finish_reason: 'stop' } });
        expect(rows[0]).toMatchObject({ settle_result: 'counted', card_delivered: false });
      } else {
        expect(wire.calls).toEqual([]);
        expect(resolve).not.toHaveBeenCalled();
        expect(frames.filter((frame) => frame.event === 'card')).toEqual([]);
        expect(
          frames
            .filter((frame) => frame.event === 'text.delta')
            .map((frame) => frame.data['delta'])
            .join(''),
        ).toBe(fileText('agent.refuse.safety_unavailable'));
        expect(frames.at(-1)).toMatchObject({ event: 'done', data: { finish_reason: 'safety' } });
        expect(rows[0]).toMatchObject({
          end_reason: 'input_review_timeout',
          settle_result: 'refunded',
          card_delivered: false,
        });
      }
      expect(search).not.toHaveBeenCalled();
      expect(convert).not.toHaveBeenCalled();
      expect(wire.unexpectedFetch).not.toHaveBeenCalled();
      expect(f.logs.lines.join('\n')).not.toContain(credentials.accessKeySecret);
    } finally {
      await app.close();
    }
  },
  120_000,
);
