// B3-03n §9 item 4 · BR-AI-18: the input review budget is agent.safety.timeout_ms of the request's
// app, read through the content configuration port on every request: two apps with different
// values each get their own; a missing key is the default 1000 ms; a value the configuration
// layer does not accept (not a finite positive number) takes that same default and is never an
// unlimited wait. The review request itself hangs (synthetic transport of the stream-review kit).
import { afterEach, expect, it, vi } from 'vitest';
import {
  createStreamReview,
  type StreamReviewConfigReader,
  type StreamReviewDeps,
} from '../../../../apps/api/src/modules/agent/stream/mount/review.ts';
import { Logs } from '../stream-recovery/kit.ts';
import { credentials, endpoint, transport } from '../stream-review/kit.ts';
import { ManualTime } from '../stream-run/kit.ts';
import { expectInputBudget, TIMEOUT_KEY } from './kit.ts';

afterEach(() => vi.unstubAllGlobals());

const APP_A = 'synthetic-app-a';
const APP_B = 'synthetic-app-b';

function setup(values: Readonly<Record<string, unknown>>) {
  const table = new Map<string, unknown>(Object.entries(values));
  const configValue = vi.fn<StreamReviewConfigReader['configValue']>(async (appId, key) =>
    key === TIMEOUT_KEY && table.has(appId) ? { value: table.get(appId) } : null,
  );
  const time = new ManualTime();
  const wire = transport(['hang']);
  const deps: StreamReviewDeps = {
    options: {
      appEnv: 'staging',
      credentials,
      endpoint,
      fetch: wire.fetch,
      nonce: () => 'synthetic-nonce',
    },
    clock: time.clock,
    scheduler: time.scheduler,
    logger: new Logs().logger,
    texts: { text: async (_appId, key) => `固定文案:${key}` },
    config: { configValue },
  };
  const ports = createStreamReview(deps);
  const probe = (appId: string, budgetMs: number) =>
    expectInputBudget(ports.inputCheck, wire, time, appId, budgetMs);
  return { table, configValue, wire, probe };
}

it('[AC-B3-03n#7][BR-AI-18] 输入审核时限按请求的 app 读 agent.safety.timeout_ms：两个 app 配不同值各自生效，交替请求互不串用', async () => {
  const s = setup({ [APP_A]: 300, [APP_B]: 2500 });
  for (const [appId, budget] of [
    [APP_A, 300],
    [APP_B, 2500],
    [APP_A, 300],
    [APP_B, 2500],
  ] as const) {
    const reads = s.configValue.mock.calls.length;
    await s.probe(appId, budget);
    expect(s.configValue.mock.calls.length, `${appId}: read for this request`).toBeGreaterThan(
      reads,
    );
    expect(s.configValue).toHaveBeenLastCalledWith(appId, TIMEOUT_KEY);
  }
  expect(s.wire.unexpectedFetch).not.toHaveBeenCalled();
});

it('[AC-B3-03n#8][BR-AI-18] 未配置 agent.safety.timeout_ms 的 app 用 BR-AI-18 默认 1000ms，与已配置的 app 互不影响', async () => {
  const s = setup({ [APP_A]: 300 });
  await s.probe(APP_B, 1000);
  expect(s.configValue).toHaveBeenCalledWith(APP_B, TIMEOUT_KEY);
  await s.probe(APP_A, 300);
  await s.probe(APP_B, 1000);
  expect(s.configValue).toHaveBeenLastCalledWith(APP_B, TIMEOUT_KEY);
});

// One-element rows: it.each spreads an array row, and [1500] must reach the test as an array.
const INVALID: [unknown][] = [[0], [-100], ['1500'], [null], [false], [[1500]], [{ ms: 1500 }]];

it.each(INVALID)(
  '[AC-B3-03n#9][BR-AI-18] 非法值 %j 按配置层既有口径取默认 1000ms，不放宽为无限等待；另一 app 的合法值照常生效',
  async (value) => {
    const s = setup({ [APP_A]: value, [APP_B]: 2500 });
    await s.probe(APP_A, 1000);
    expect(s.configValue).toHaveBeenCalledWith(APP_A, TIMEOUT_KEY);
    await s.probe(APP_B, 2500);
    await s.probe(APP_A, 1000);
  },
);

it('[AC-B3-03n#10][BR-AI-18] 每次请求按当前 app 现读：同一 app 改值、删除后，下一次请求即按新值或默认值', async () => {
  const s = setup({ [APP_A]: 300 });
  await s.probe(APP_A, 300);
  s.table.set(APP_A, 1800);
  await s.probe(APP_A, 1800);
  s.table.delete(APP_A);
  await s.probe(APP_A, 1000);
  s.table.set(APP_A, 450);
  await s.probe(APP_A, 450);
  expect(
    s.configValue.mock.calls.filter(([appId, key]) => appId === APP_A && key === TIMEOUT_KEY)
      .length,
  ).toBeGreaterThanOrEqual(4);
});
