// B1-01za: contracts/openapi.yaml ErrorEnvelope; error-codes.yaml 20001 / 50001.
// Each test covers a currently missing boundary; existing behavior is asserted alongside its
// related boundary so the first-red run does not mislabel passing regression cases as toothless.
// Error logs carry trace_id, error_class and stack when available on Error; error_class is
// Error's constructor name, typeof for non-Error values, or 'null' for null, without request bodies.
import { beforeAll, expect, it } from 'vitest';
import {
  BODY_MARKER,
  ENTRIES,
  ERROR_MARKER,
  TRACE,
  businessBody,
  envelopeValidator,
  expectEnvelope,
  request,
  withApp,
  type Response,
} from './kit.ts';

let validate: Awaited<ReturnType<typeof envelopeValidator>>;
beforeAll(async () => {
  validate = await envelopeValidator();
});

it('[AC-B1-01za#1][AC-B1-01za#7] 损坏 JSON 返回 body 字段错误且不泄露片段，正常契约校验保留字段名', async () => {
  for (const entry of ENTRIES) {
    await withApp(entry, async (app, lines) => {
      // Fastify 5.12.5 uses FST_ERR_CTP_INVALID_JSON_BODY without quoting the input;
      // keep both markers as regression protection against request-body disclosure.
      for (const payload of [`${BODY_MARKER}{`, `{"note":"${BODY_MARKER}",}`]) {
        lines.length = 0;
        const response = await app.inject(request('parse', payload));
        expectEnvelope(response, validate, 20001, `${entry}: malformed JSON`, ['body']);
        expect.soft(response.body).not.toContain(BODY_MARKER);
        expect.soft(lines.join('')).not.toContain(BODY_MARKER);
      }
      // Also covers requirement #7: retain the existing contract validation fields.
      const invalid = await app.inject(request('checked', '{"device_hash":"bad"}'));
      expectEnvelope(invalid, validate, 20001, `${entry}: schema validation`, ['device_hash']);
    });
  }
}, 30_000);

it('[AC-B1-01za#2] application/json 空体返回 400 / 20001 与 fields=[body]', async () => {
  for (const entry of ENTRIES) {
    await withApp(entry, async (app) => {
      const response = await app.inject(request('parse', ''));
      expectEnvelope(response, validate, 20001, `${entry}: empty JSON`, ['body']);
    });
  }
}, 30_000);

it('[AC-B1-01za#3] 不支持的 Content-Type 返回 415 + 契约错误体 20001、fields=[body]', async () => {
  // Frozen B1-01r test/spec/platform/tracing/trace-id-response-header.test.ts and the
  // orchestrator's ruling require HTTP 415. There is no 415-specific code, so use 20001;
  // its HTTP 400 mapping in error-codes.yaml remains a contract follow-up.
  for (const entry of ENTRIES) {
    await withApp(entry, async (app, lines) => {
      lines.length = 0;
      const response = await app.inject(request('parse', BODY_MARKER, 'application/x-za-probe'));
      expectEnvelope(response, validate, 20001, `${entry}: unsupported media type`, ['body'], 415);
      expect.soft(response.body).not.toContain(BODY_MARKER);
      expect.soft(lines.join('')).not.toContain(BODY_MARKER);
    });
  }
}, 30_000);

it('[AC-B1-01za#4][AC-B1-01za#5][AC-B1-01za#7][AC-B1-01za#8] guard 与控制器统一分类未知异常，保留业务异常及 outcome_unknown', async () => {
  // Also covers requirements #5 (controller), #7 (business/unknown outcome) and #8 (statusCode).
  for (const entry of ENTRIES) {
    await withApp(entry, async (app, lines) => {
      for (const origin of ['guard', 'controller']) {
        for (const [kind, errorClass] of [
          ['error', 'TypeError'],
          ['text', 'string'],
          ['object', 'object'],
          ['status-object', 'object'],
          ['null', 'null'],
          ['status', 'Error'],
          ['internal', 'IdempotencyError'],
        ]) {
          lines.length = 0;
          const label = `${entry}: ${origin}/${kind}`;
          const response = await app.inject(
            request(`${origin}/${kind}`, JSON.stringify({ note: BODY_MARKER })),
          );
          expectEnvelope(response, validate, 50001, label);
          expect.soft(response.body, label).not.toContain(ERROR_MARKER);
          expect.soft(response.body, label).not.toContain('probe failure');
          expect.soft(response.body, label).not.toContain(BODY_MARKER);
          const logs = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
          const failures = logs.filter((line) => line['error_class'] === errorClass);
          expect.soft(failures.length, `${label}: error category logged`).toBeGreaterThan(0);
          expect
            .soft(failures, label)
            .toEqual(
              expect.arrayContaining([
                expect.objectContaining({ trace_id: TRACE, error_class: errorClass }),
              ]),
            );
          if (kind === 'error' || kind === 'status' || kind === 'internal') {
            expect
              .soft(
                failures.some(
                  (line) => typeof line['stack'] === 'string' && line['stack'].includes('\n'),
                ),
                `${label}: stack logged`,
              )
              .toBe(true);
          }
          expect.soft(lines.join(''), label).not.toContain(BODY_MARKER);
          expect.soft(lines.join(''), label).not.toContain(ERROR_MARKER);
          for (const line of failures) {
            expect.soft(line, label).not.toHaveProperty('body');
            expect.soft(line, label).not.toHaveProperty('privateDetail');
          }
        }
        const business = await app.inject(request(`${origin}/business`));
        const body = expectEnvelope(business, validate, 20001, `${entry}: ${origin}/business`, [
          'device_hash',
        ]);
        expect.soft(body).toStrictEqual(businessBody(TRACE));
        // No ErrorEnvelope is possible here: LightMyRequest rejects with the actual close code,
        // matching apps/api/src/modules/platform/idempotency/http.test.ts;
        // do not accept arbitrary errors or timeouts.
        await expect.soft(app.inject(request(`${origin}/uncertain`))).rejects.toMatchObject({
          code: 'LIGHT_ECONNRESET',
        });
      }
    });
  }
}, 30_000);

it('[AC-B1-01za#6] bigint 响应序列化失败及时返回 500 / 50001，随后仍可处理请求', async () => {
  for (const entry of ENTRIES) {
    await withApp(entry, async (app) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        app.inject(request('serialize')).then(
          (response) => ({ kind: 'response' as const, response }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        ),
        new Promise<{ kind: 'hung' }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'hung' }), 2_000);
        }),
      ]).finally(() => clearTimeout(timer));
      // A hang or disconnect is an assertion failure, never an accepted serialization result.
      expect(result.kind, `${entry}: serialization must finish with a response`).toBe('response');
      const response = (result as { kind: 'response'; response: Response }).response;
      expectEnvelope(response, validate, 50001, `${entry}: bigint serialization`);
      const next = await app.inject(request('checked', '{"device_hash":"bad"}'));
      expectEnvelope(next, validate, 20001, `${entry}: next request`, ['device_hash']);
    });
  }
}, 30_000);
