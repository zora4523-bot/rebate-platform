// Only the container runner invokes these HTTP/SQL helpers. Reuse the existing harness;
// no direct @couli/db/testing import, destructive cleanup, or production adapter.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { seed } from '../../admin/accounts/kit.ts';
import {
  fixture,
  signedIn,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';
import * as configs from '../config-items/kit.ts';
import * as switches from '../kill-switches/kit.ts';
import { AMOUNT, DAILY, ENABLED, TOTAL } from './oracle.ts';

export { useHarness } from '../../admin/auth/kit.ts';
export { current, getItem, putRow, putVersion, snapshot } from '../config-items/kit.ts';
export type Operation = 'switch' | 'update' | 'batch' | 'rollback';

export async function setup(h: Harness) {
  const f = await fixture(h);
  const appId = `f1-02zn-${randomUUID()}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  return { ...f, appId, actor, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;
export type Request = (app?: HttpApp) => Promise<Response>;

/** Mint the step-up token BEFORE taking snapshots (step-up has its own audit). */
export async function prepare(
  f: Setup,
  operation: Operation,
  key: string,
  body: Record<string, unknown>,
): Promise<Request> {
  const stepUp = await configs.stepUp(f);
  return async (app = f.app) =>
    operation === 'switch'
      ? (await switches.put(app, f, key, body, stepUp)).response
      : configs.call({ ...f, app }, operation, { key, body, stepUp });
}

export async function checkSuccess(response: Response, operation: Operation) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, operation);
}

export async function checkRejected(response: Response, operation: Operation, fields: string[]) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001, data: { fields } });
  expect(response.json().data).toStrictEqual({ fields });
  await validate(response, operation);
}

async function validate(response: Response, operation: Operation) {
  if (operation === 'switch') await switches.validate(response, 'update');
  else await configs.validate(response, operation);
}

export async function unchanged(
  h: Harness,
  f: Setup,
  request: Request,
  operation: Operation,
  fields: string[],
) {
  const before = await configs.snapshot(h, f.appId);
  const logStart = f.lines.length;
  await checkRejected(await request(), operation, fields);
  expect(await configs.snapshot(h, f.appId)).toStrictEqual(before);
  expect(switches.alertLines(f.lines, logStart)).toStrictEqual([]);
}

/** Low-entropy amounts; each app is isolated and fixtures only INSERT. */
export async function positive(h: Harness, f: Setup, except?: string) {
  for (const key of [AMOUNT, DAILY, TOTAL]) {
    if (key !== except) await configs.putRow(h, f.appId, key, 100);
  }
}

export async function enable(f: Setup, expectedVersion = 0) {
  const request = await prepare(f, 'switch', ENABLED, {
    value: true,
    expected_version: expectedVersion,
  });
  await checkSuccess(await request(), 'switch');
}
