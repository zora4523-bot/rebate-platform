// HTTP 层（不挂载，经后台入口上的探针）：所有 kind 要 order.claim；渠道单另要 risk.blocklist 与 totp 动态码
// （整份一次）；multipart 的表单项与文件；超过全局上限 413 / 20001 [body]；被拒的请求什么都不留下。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, open, type Fixture, type Harness } from './db-kit.ts';
import { BASE, BODY_LIMIT, STEP_UP, post, withProbe, type Response } from './http-kit.ts';
import { PNG, conforms, form, hex, ms, sheet } from './kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

const FROM = '2026-10-01T00:00:00+08:00';
const TO = '2026-11-01T00:00:00+08:00';

async function nothingLeft(f: Fixture) {
  expect(await f.state()).toEqual({ imports: [], failures: [], audits: [], sent: 0, puts: 0 });
}

function refused(response: Response, status: number, code: number, data?: object) {
  expect(response.statusCode).toBe(status);
  const body = response.json() as { code: number; data?: unknown; trace_id?: unknown };
  expect(body.code).toBe(code);
  if (data !== undefined) expect(body.data).toEqual(data);
  expect(body.trace_id).toBe(response.headers['x-trace-id']);
}

async function created(f: Fixture, response: Response) {
  expect(response.statusCode).toBe(200);
  const body = response.json() as { code: number; data: { import_id: string; status: string } };
  expect(body).toMatchObject({ code: 0, msg: '', data: { status: 'queued' } });
  await conforms(body, 'AdminRightsImportCreateResponse');
  const row = await f.task(body.data.import_id);
  expect(row, 'the task row of the answer').toBeDefined();
  return row!;
}

describe('[AC-B1-09g#19] 维权单 / 违规单：只要 order.claim，不要动态码', () => {
  it.each(['rights', 'punish'])('%s：multipart 表单项与文件 → 新任务 queued', async (kind) => {
    const f = await fixture(h);
    const bytes = sheet(['succeeded', 'skipped']);
    await withProbe(f, async (app) => {
      const response = await app.inject(
        post(form({ kind, platform: 'pdd', time_basis: 'paid', from: FROM, to: TO }, bytes)),
      );
      const row = await created(f, response);
      expect(row).toMatchObject({
        kind,
        platform: 'pdd',
        time_basis: 'paid',
        union_account_id: null,
        status: 'queued',
        created_by: f.adminId,
      });
      expect(ms(row.from)).toBe(new Date(FROM).getTime());
      expect(ms(row.to)).toBe(new Date(TO).getTime());
      expect(hex(await f.memory.get(row.file_path))).toBe(hex(bytes));
      expect(f.queue.sent).toHaveLength(1);
      expect((await f.state()).audits).toHaveLength(1);
    });
  });

  it('没有 order.claim → 10403，什么都不留下', async () => {
    const f = await fixture(h);
    await withProbe(f, async (app, probe) => {
      probe.guard.held.keys = ['order.view', 'risk.blocklist'];
      const response = await app.inject(
        post(form({ kind: 'rights', platform: 'taobao' }, sheet(['succeeded'])), {
          'x-step-up-token': STEP_UP,
        }),
      );
      refused(response, 403, 10403, { reason: 'admin_permission_denied' });
      await nothingLeft(f);
    });
  });
});

describe('[AC-B1-09g#20] 渠道单：另要 risk.blocklist 与 totp 动态码（整份一次）', () => {
  const channel = (f: Fixture) =>
    form(
      { kind: 'channel', platform: 'taobao', union_account_id: f.accountId },
      sheet(['succeeded']),
    );

  it('缺 risk.blocklist → 10403，什么都不留下', async () => {
    const f = await fixture(h);
    await withProbe(f, async (app, probe) => {
      probe.guard.held.keys = ['order.claim'];
      const response = await app.inject(post(channel(f), { 'x-step-up-token': STEP_UP }));
      refused(response, 403, 10403, { reason: 'admin_permission_denied' });
      await nothingLeft(f);
    });
  });

  it.each([
    ['动态码错', { 'x-step-up-token': 'wrong-plain-plain-plain' }],
    ['没带动态码', {}],
  ] as const)('%s → 10003（tier totp），什么都不留下', async (_label, headers) => {
    const f = await fixture(h);
    await withProbe(f, async (app, probe) => {
      probe.guard.held.keys = ['order.claim', 'risk.blocklist'];
      const response = await app.inject(post(channel(f), { ...headers }));
      refused(response, 403, 10003, { tier: 'totp' });
      await nothingLeft(f);
    });
  });

  it('两个权限点都有、动态码对 → 新任务 queued', async () => {
    const f = await fixture(h);
    await withProbe(f, async (app, probe) => {
      probe.guard.held.keys = ['order.claim', 'risk.blocklist'];
      const response = await app.inject(post(channel(f), { 'x-step-up-token': STEP_UP }));
      const row = await created(f, response);
      expect(row).toMatchObject({
        kind: 'channel',
        platform: 'taobao',
        union_account_id: f.accountId,
        time_basis: null,
        created_by: f.adminId,
      });
      expect(f.queue.sent).toHaveLength(1);
    });
  });

  it('维权单带着权限点与动态码也照常受理（不要求，也不妨碍）', async () => {
    const f = await fixture(h);
    await withProbe(f, async (app, probe) => {
      probe.guard.held.keys = ['order.claim', 'risk.blocklist'];
      const response = await app.inject(
        post(form({ kind: 'rights', platform: 'taobao' }, sheet(['succeeded'])), {
          'x-step-up-token': STEP_UP,
        }),
      );
      expect((await created(f, response)).kind).toBe('rights');
    });
  });
});

describe('[AC-B1-09g#21] 请求体与表单', () => {
  it(`请求体超过全局上限（${BODY_LIMIT} 字节）→ HTTP 413 / 20001 [body]，什么都不留下`, async () => {
    const f = await fixture(h);
    await withProbe(f, async (app) => {
      const big = Buffer.alloc(BODY_LIMIT + 4096, 0x41);
      const response = await app.inject(post(form({ kind: 'rights', platform: 'taobao' }, big)));
      refused(response, 413, 20001, { fields: ['body'] });
      await nothingLeft(f);
    });
  });

  it('不是 multipart → 400 / 20001，什么都不留下', async () => {
    const f = await fixture(h);
    await withProbe(f, async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: BASE,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ kind: 'rights', platform: 'taobao' }),
      });
      refused(response, 400, 20001);
      await nothingLeft(f);
    });
  });

  it('文件不是 xlsx → 400 / 20001 [file]', async () => {
    const f = await fixture(h);
    await withProbe(f, async (app) => {
      const response = await app.inject(post(form({ kind: 'rights', platform: 'taobao' }, PNG)));
      refused(response, 400, 20001, { fields: ['file'] });
      await nothingLeft(f);
    });
  });

  it('组合不合（渠道单带 time_basis）→ 400 / 20001 [time_basis]', async () => {
    const f = await fixture(h);
    await withProbe(f, async (app, probe) => {
      probe.guard.held.keys = ['order.claim', 'risk.blocklist'];
      const parts = form(
        {
          kind: 'channel',
          platform: 'taobao',
          union_account_id: f.accountId,
          time_basis: 'paid',
        },
        sheet(['succeeded']),
      );
      const response = await app.inject(post(parts, { 'x-step-up-token': STEP_UP }));
      refused(response, 400, 20001, { fields: ['time_basis'] });
      await nothingLeft(f);
    });
  });

  it('kind 不在枚举 → 400 / 20001 [kind]', async () => {
    const f = await fixture(h);
    await withProbe(f, async (app) => {
      const response = await app.inject(
        post(form({ kind: 'refund', platform: 'taobao' }, sheet(['succeeded']))),
      );
      refused(response, 400, 20001, { fields: ['kind'] });
      await nothingLeft(f);
    });
  });
});

describe('[AC-B1-09g#22] 列表 / 详情：order.claim 只读，App 取自操作人', () => {
  it('列表与详情只读本 App；别的 App 的任务 → 400 / 20001 [import_id]；守卫只读、不要动态码', async () => {
    const f = await fixture(h);
    const other = await fixture(h);
    const own = await f.seed();
    const theirs = await other.seed();
    await withProbe(f, async (app, probe) => {
      const list = await app.inject({ method: 'GET', url: `${BASE}?page=1&page_size=20` });
      expect(list.statusCode).toBe(200);
      const page = list.json() as { code: number; data: { items: { import_id: string }[] } };
      expect(page.code).toBe(0);
      expect(page.data.items.map((i) => i.import_id)).toEqual([own.id]);
      await conforms(page, 'AdminRightsImportPageResponse');

      const detail = await app.inject({ method: 'GET', url: `${BASE}/${own.id}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ code: 0, data: { import_id: own.id, failures: [] } });
      await conforms(detail.json(), 'AdminRightsImportDetailResponse');

      refused(await app.inject({ method: 'GET', url: `${BASE}/${theirs.id}` }), 400, 20001, {
        fields: ['import_id'],
      });
      expect(probe.guard.calls.length).toBeGreaterThanOrEqual(3);
      for (const call of probe.guard.calls) {
        expect(call).toMatchObject({ permission: 'order.claim', readOnly: true });
      }
    });
  });

  it('没有 order.claim → 10403', async () => {
    const f = await fixture(h);
    const own = await f.seed();
    await withProbe(f, async (app, probe) => {
      probe.guard.held.keys = ['order.view'];
      refused(await app.inject({ method: 'GET', url: BASE }), 403, 10403);
      refused(await app.inject({ method: 'GET', url: `${BASE}/${own.id}` }), 403, 10403);
    });
  });
});
