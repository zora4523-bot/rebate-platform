import { fileURLToPath } from 'node:url';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { expect } from 'vitest';
import { apiRequire, ROOT } from '../signature/kit.ts';
import { client, openHttp, type Fixture } from '../risk-state/http-kit.ts';
import type { Response } from '../../identity/sms-codes/http-kit.ts';
export { client, openHttp };
export type { Fixture, Response };
export const PATH = '/v1/me/appeals';
export type Client = Awaited<ReturnType<typeof client>>;

interface Operation {
  responses: Record<string, { content: Record<string, { schema: object }> }>;
}
type Validator = ((data: unknown) => boolean) & { errors?: unknown };
let validators: Promise<Record<'get' | 'post' | 'error', Validator>> | undefined;
async function responseValidators() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ paths: Record<string, { get: Operation; post: Operation }> }>;
  };
  const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
  const { createValidatorCompiler } = (await import(
    new URL('apps/api/src/modules/platform/validation/index.ts', ROOT).href
  )) as { createValidatorCompiler(): (input: { schema: object; httpPart: string }) => Validator };
  const compile = createValidatorCompiler();
  const route = doc.paths[PATH]!;
  return {
    get: compile({
      schema: route.get.responses['200']!.content['application/json']!.schema,
      httpPart: 'body',
    }),
    post: compile({
      schema: route.post.responses['200']!.content['application/json']!.schema,
      httpPart: 'body',
    }),
    error: compile({
      schema: route.post.responses['4XX']!.content['application/json']!.schema,
      httpPart: 'body',
    }),
  };
}
async function conform(response: Response, kind: 'get' | 'post' | 'error') {
  validators ??= responseValidators();
  const validate = (await validators)[kind];
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
  expect(response.headers['x-trace-id']).toBe(response.json<{ trace_id: string }>().trace_id);
}
export async function accepted(response: Response) {
  expect(response.statusCode).toBe(200);
  await conform(response, 'post');
  const body = response.json<Schema<'AppealResponse'>>();
  expect(body.code).toBe(0);
  return body.data;
}
export async function listed(response: Response) {
  expect(response.statusCode).toBe(200);
  await conform(response, 'get');
  const body = response.json<Schema<'AppealListResponse'>>();
  expect(body.code).toBe(0);
  return body.data;
}
export async function rejected(response: Response, status: number, code: number) {
  expect(response.statusCode).toBe(status);
  await conform(response, 'error');
  expect(response.json()).toMatchObject({ code });
}
export function appeals(f: Fixture, c: Client) {
  return f.db
    .withSchema('app')
    .selectFrom('appeals')
    .selectAll()
    .where('app_id', '=', c.appId)
    .execute();
}
export function states(f: Fixture, c: Client) {
  return f.db
    .withSchema('app')
    .selectFrom('user_risk_state')
    .selectAll()
    .where('app_id', '=', c.appId)
    .execute();
}
export function events(f: Fixture, c: Client) {
  return f.db
    .withSchema('app')
    .selectFrom('event_log')
    .selectAll()
    .where('app_id', '=', c.appId)
    .where('name', '=', 'risk.state_changed')
    .execute();
}
