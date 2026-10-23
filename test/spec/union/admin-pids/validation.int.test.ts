import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { JPEG } from './image-fixtures.ts';
import {
  CONFIRMED,
  PNG,
  WRITES,
  accepted,
  bodyFor,
  rejected,
  seedAccount,
  seedPid,
  setup,
  snapshot,
  validate,
} from './kit.ts';

const h = useHarness();

for (const action of ['create', 'update'] as const) {
  it.each([
    ['platform', 'unknown'],
    ['pid_scene', 'unknown'],
    ['pid', ''],
    ['pid', 'a'.repeat(65)],
    ['pid', 'has space'],
    ['pid', '中文'],
    ['site_id', ''],
    ['site_id', 'x'.repeat(65)],
    ['site_id', 'a/b'],
  ])(`[AC-B1-22h#20] ${action} 校验 %s=%s，失败不写库`, async (field, value) => {
    const s = await setup(h);
    const row = await seedPid(s, { platform: 'taobao' });
    const before = await snapshot(s);
    await rejected(
      await s.write(action, row.id, { ...bodyFor(action, row), [field!]: value }),
      20001,
      { fields: [field] },
    );
    expect(await snapshot(s)).toEqual(before);
  });

  it.each(['taobao', 'jd', 'pdd'])(
    `[AC-B1-22h#21] ${action} site_id 的有无必须匹配平台 %s`,
    async (platform) => {
      const s = await setup(h);
      const row = await seedPid(s, { platform });
      const before = await snapshot(s);
      await rejected(
        await s.write(action, row.id, {
          ...bodyFor(action, row),
          site_id: platform === 'taobao' ? null : '123',
        }),
        20001,
        { fields: ['site_id'] },
      );
      expect(await snapshot(s)).toEqual(before);
    },
  );

  it(`[AC-B1-22h#22] ${action} 拒绝未知、跨 app 和平台不匹配的联盟账号`, async () => {
    const s = await setup(h);
    const other = await setup(h);
    const row = await seedPid(s);
    const foreign = await seedAccount(other);
    const wrongPlatform = await seedAccount(s, { platform: 'pdd' });
    const before = await snapshot(s);
    const foreignBefore = await snapshot(other);
    for (const id of [randomUUID(), foreign.id, wrongPlatform.id]) {
      await rejected(
        await s.write(action, row.id, { ...bodyFor(action, row), union_account_id: id }),
        20001,
        { fields: ['union_account_id'] },
      );
    }
    expect(await snapshot(s)).toEqual(before);
    expect(await snapshot(other)).toEqual(foreignBefore);
  });

  it.each(['x', 'A_-09'.repeat(12) + 'ABCD'])(
    `[AC-B1-22h#23] ${action} 接受 1 和 64 字符编码`,
    async (pid) => {
      const s = await setup(h);
      const row = await seedPid(s, { platform: 'taobao' });
      const data = await accepted(
        await s.write(action, row.id, { ...bodyFor(action, row), pid, site_id: pid }),
      );
      expect(data).toMatchObject({ pid, site_id: pid, status: 'pending' });
    },
  );
}

it('[AC-B1-22h#24] 修改校验最终合并行，单改平台不能留下旧账号和 site_id', async () => {
  const s = await setup(h);
  const row = await seedPid(s, { platform: 'taobao' });
  const before = await snapshot(s);
  const response = await s.write('update', row.id, {
    platform: 'jd',
    expected_row_version: row.row_version,
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().code).toBe(20001);
  const fields = response.json<{ data: { fields: string[] } }>().data.fields;
  expect(fields.some((field) => ['union_account_id', 'site_id'].includes(field))).toBe(true);
  await validate(response);
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-22h#25] pending 改成其他行的 pid 拒绝，自身相同 pid 不视为重复', async () => {
  const s = await setup(h);
  const row = await seedPid(s);
  const sibling = await seedPid(s, { status: 'retired' });
  const before = await snapshot(s);
  await rejected(
    await s.write('update', row.id, { pid: sibling.pid, expected_row_version: row.row_version }),
    20001,
    { fields: ['pid'] },
  );
  expect(await snapshot(s)).toEqual(before);
  expect(
    (
      await accepted(
        await s.write('update', row.id, { pid: row.pid, expected_row_version: row.row_version }),
      )
    ).pid,
  ).toBe(row.pid);
});

it('[AC-B1-22h#26] 只给版本和原因不是修改字段，拒绝空修改', async () => {
  const s = await setup(h);
  const row = await seedPid(s);
  const before = await snapshot(s);
  await rejected(
    await s.write('update', row.id, { expected_row_version: row.row_version, reason: '仅写原因' }),
    20001,
    { fields: ['body'] },
  );
  expect(await snapshot(s)).toEqual(before);
});

for (const action of WRITES) {
  it.each(['', '因'.repeat(201)])(
    `[AC-B1-22h#27] ${action} 原因若给出必须 1–200 字`,
    async (reason) => {
      const s = await setup(h);
      const row = await seedPid(s, { status: action === 'retire' ? 'active' : 'pending' });
      const before = await snapshot(s);
      await rejected(await s.write(action, row.id, { ...bodyFor(action, row), reason }), 20001, {
        fields: ['reason'],
      });
      expect(await snapshot(s)).toEqual(before);
    },
  );
  it.each(['因', '因'.repeat(200)])(`[AC-B1-22h#28] ${action} 原因长度合法边界`, async (reason) => {
    const s = await setup(h);
    const row = await seedPid(s, { status: action === 'retire' ? 'active' : 'pending' });
    const data = await accepted(await s.write(action, row.id, { ...bodyFor(action, row), reason }));
    expect(data.pid_id).toEqual(expect.any(String));
    expect(await s.audits()).toHaveLength(1);
  });
}

for (const action of ['update', 'activate', 'retire'] as const) {
  it.each([undefined, -1, 1.5, 'not-an-integer'])(
    `[AC-B1-22h#29] ${action} 版本号必须给出非负整数：%s`,
    async (expected) => {
      const s = await setup(h);
      const row = await seedPid(s, { status: action === 'retire' ? 'active' : 'pending' });
      const before = await snapshot(s);
      await rejected(
        await s.write(action, row.id, { ...bodyFor(action, row), expected_row_version: expected }),
        20001,
        { fields: ['expected_row_version'] },
      );
      expect(await snapshot(s)).toEqual(before);
    },
  );
}

it.each([
  [true, true, ['hjy_ignore_confirmed_at', 'hjy_ignore_evidence']],
  [true, false, ['hjy_ignore_confirmed_at']],
  [false, true, ['hjy_ignore_evidence']],
] as const)(
  '[AC-B1-22h#30] 花卷云确认缺失时间=%s、截图=%s 精确报告缺失字段',
  async (missingTime, missingFile, fields) => {
    const s = await setup(h);
    // Stored evidence cannot replace parts required in this activation request.
    const row = await seedPid(s, {
      hjy_ignore_confirmed_at: new Date(CONFIRMED),
      hjy_ignore_evidence_path: 'fixtures/old.png',
    });
    const before = await snapshot(s);
    await rejected(
      await s.write(
        'activate',
        row.id,
        {
          expected_row_version: row.row_version,
          ...(missingTime ? {} : { hjy_ignore_confirmed_at: CONFIRMED }),
        },
        {
          file: missingFile ? null : { bytes: PNG, contentType: 'image/png', filename: 'hjy.png' },
        },
      ),
      20001,
      { fields: [...fields] },
    );
    expect(await snapshot(s)).toEqual(before);
  },
);

it.each(['2026-10-10T00:00:00.000Z', 'not-a-date'])(
  '[AC-B1-22h#31] 花卷云确认时刻必须合法且不能晚于注入时钟：%s',
  async (confirmed) => {
    const s = await setup(h);
    const row = await seedPid(s);
    const before = await snapshot(s);
    await rejected(
      await s.write('activate', row.id, {
        ...bodyFor('activate', row),
        hjy_ignore_confirmed_at: confirmed,
      }),
      20001,
      { fields: ['hjy_ignore_confirmed_at'] },
    );
    expect(await snapshot(s)).toEqual(before);
  },
);

it('[AC-B1-22h#32] 确认时刻可以等于当前时刻', async () => {
  const s = await setup(h);
  const row = await seedPid(s);
  const token = await s.issue();
  const now = s.f.clock.now().toISOString();
  expect(
    (
      await accepted(
        await s.write(
          'activate',
          row.id,
          { ...bodyFor('activate', row), hjy_ignore_confirmed_at: now },
          { token },
        ),
      )
    ).hjy_ignore_confirmed_at,
  ).toBe(now);
});

it.each(['image/gif', 'application/pdf'])(
  '[AC-B1-22h#33] 截图只收 PNG/JPEG，拒绝 %s 且不留下确认字段',
  async (contentType) => {
    const s = await setup(h);
    const row = await seedPid(s);
    const before = await snapshot(s);
    await rejected(
      await s.write('activate', row.id, bodyFor('activate', row), {
        file: {
          bytes: Buffer.from('synthetic unsupported file'),
          contentType,
          filename: 'evidence.dat',
        },
      }),
      20001,
      { fields: ['hjy_ignore_evidence'] },
    );
    expect(await snapshot(s)).toEqual(before);
  },
);

it('[AC-B1-22h#34] 启用校验顺序：未知 pid 先于缺花卷云字段，缺字段先于状态和场景冲突', async () => {
  const s = await setup(h);
  const row = await seedPid(s, { status: 'retired' });
  await seedPid(s, { status: 'active' });
  const before = await snapshot(s);
  await rejected(
    await s.write('activate', randomUUID(), { expected_row_version: 0 }, { file: null }),
    20001,
    { fields: ['pid_id'] },
  );
  await rejected(
    await s.write('activate', row.id, { expected_row_version: 0 }, { file: null }),
    20001,
    { fields: ['hjy_ignore_confirmed_at', 'hjy_ignore_evidence'] },
  );
  await rejected(await s.write('activate', row.id, bodyFor('activate', row)), 20902, {
    resource: 'union_pid',
  });
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-22h#44] JPEG 截图也可以启用，并持久化私有对象路径', async () => {
  const s = await setup(h);
  const row = await seedPid(s);
  const data = await accepted(
    await s.write('activate', row.id, bodyFor('activate', row), {
      file: { bytes: JPEG, contentType: 'image/jpeg', filename: 'hjy.jpg' },
    }),
  );
  expect(data.status).toBe('active');
  expect(data.hjy_ignore_evidence_path).toEqual(expect.any(String));
  expect(data.hjy_ignore_evidence_path).not.toMatch(/^https?:\/\//);
});

it('[AC-B1-22h#45] 整体请求超全局上限仍为 413 body，推广位与审计不变', async () => {
  const s = await setup(h);
  const row = await seedPid(s);
  // A successful list makes this red even if the generic 413 handler already exists.
  const read = await s.list();
  expect(read.statusCode).toBe(200);
  const server = s.f.app.getHttpAdapter().getInstance() as unknown as {
    initialConfig: { bodyLimit: number };
  };
  const before = await snapshot(s);
  const response = await s.write('activate', row.id, bodyFor('activate', row), {
    file: {
      bytes: Buffer.concat([PNG, Buffer.alloc(server.initialConfig.bodyLimit + 1)]),
      contentType: 'image/png',
      filename: 'large.png',
    },
  });
  expect(response.statusCode).toBe(413);
  expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['body'] } });
  await validate(response);
  expect(await snapshot(s)).toEqual(before);
});
