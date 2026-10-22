// BR-FUND-06 / D10-152⑨: only a sub-order is a command target; parent hits are diagnostic.
// SQL is compiled by Kysely with a socket-free driver. Real PG constraints belong to B1-09e.
import { expect, it } from 'vitest';
import {
  findOrderForRights,
  type RightsOrderLookupInput,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { APP, database, order, type Statement } from './kit.ts';

function equalParameter(statement: Statement, column: string): unknown {
  // Accept qualified or unqualified column names, but require a bound equality predicate.
  const match = new RegExp(`"${column}" = \\$(\\d+)`).exec(statement.sql);
  expect(match, `missing equality for ${column}: ${statement.sql}`).not.toBeNull();
  return match === null ? undefined : statement.parameters[Number(match[1]) - 1];
}

function scopedReads(statements: readonly Statement[], input: RightsOrderLookupInput) {
  expect(statements.length).toBeGreaterThan(0);
  for (const statement of statements) {
    expect(statement.sql).toMatch(/^select\b/i);
    expect(statement.sql).toContain('"app"."orders"');
    expect(statement.sql).not.toMatch(/\b(?:insert|update|delete|like|ilike|or)\b/i);
    expect(equalParameter(statement, 'app_id')).toBe(input.app_id);
    expect(equalParameter(statement, 'platform')).toBe(input.platform);
  }
}

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B1-09c#20] %s 精确定位一个子订单，返回原有付款/收货时间以供上层筛选',
  async (platform) => {
    const row = order({ platform });
    const d = database([[row]]);
    const input = { app_id: APP, platform, platform_order_no: row.sub_order_id };
    expect(await findOrderForRights(d.db, input)).toEqual({ kind: 'found', order: row });
    scopedReads(d.statements, input);
    expect(equalParameter(d.statements[0]!, 'sub_order_id')).toBe(row.sub_order_id);
    expect(d.statements).toHaveLength(1);
  },
);

it.each(['260101-123456789012345', '260101123456789012345', '260101-123456-789012345'])(
  '[AC-B1-09c#21] 拼多多 %s 去连字符后按子订单号精确匹配，不转 number 丢精度',
  async (platform_order_no) => {
    const row = order({ platform: 'pdd', sub_order_id: '260101123456789012345' });
    const d = database([[row]]);
    const input = { app_id: APP, platform: 'pdd' as const, platform_order_no };
    const saved = { ...input };
    expect(await findOrderForRights(d.db, input)).toEqual({ kind: 'found', order: row });
    expect(input).toEqual(saved);
    scopedReads(d.statements, input);
    expect(equalParameter(d.statements[0]!, 'sub_order_id')).toBe('260101123456789012345');
  },
);

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-09c#22] %s 不套用拼多多的去连字符规则，保留前导零和完整号码',
  async (platform) => {
    const row = order({ platform, sub_order_id: '000123-456789012345678' });
    const d = database([[row]]);
    const input = { app_id: APP, platform, platform_order_no: row.sub_order_id };
    expect(await findOrderForRights(d.db, input)).toEqual({ kind: 'found', order: row });
    scopedReads(d.statements, input);
    expect(equalParameter(d.statements[0]!, 'sub_order_id')).toBe('000123-456789012345678');
  },
);

it.each([
  { app_id: APP, platform: 'taobao', platform_order_no: '880012340001' },
  { app_id: 'rights-app-b', platform: 'taobao', platform_order_no: '880012340001' },
  { app_id: APP, platform: 'jd', platform_order_no: '880012340001' },
  { app_id: APP, platform: 'pdd', platform_order_no: '880012340001' },
] satisfies RightsOrderLookupInput[])(
  '[AC-B1-09c#23] $app_id/$platform 同号查询的子单与主单探测都受 app 和平台限制',
  async (input) => {
    const d = database([[], []]);
    expect(await findOrderForRights(d.db, input)).toEqual({ kind: 'not_found' });
    scopedReads(d.statements, input);
    expect(equalParameter(d.statements[0]!, 'sub_order_id')).toBe(input.platform_order_no);
    expect(equalParameter(d.statements[1]!, 'parent_order_id')).toBe(input.platform_order_no);
    expect(d.statements).toHaveLength(2);
  },
);

it.each([1, 2])(
  '[AC-B1-09c#24] 主订单有 %s 个子项也只返回 sub_order_no_missing，不选第一个且不展开',
  async (children) => {
    const rows = [order(), order({ sub_order_id: '880012340002', order_id: 'other-child' })].slice(
      0,
      children,
    );
    const d = database([[], rows]);
    const input = { app_id: APP, platform: 'taobao' as const, platform_order_no: '880012340000' };
    expect(await findOrderForRights(d.db, input)).toEqual({ kind: 'sub_order_no_missing' });
    scopedReads(d.statements, input);
    expect(equalParameter(d.statements[0]!, 'sub_order_id')).toBe('880012340000');
    expect(equalParameter(d.statements[1]!, 'parent_order_id')).toBe('880012340000');
    expect(d.statements).toHaveLength(2);
  },
);

it('[AC-B1-09c#25] 拼多多只给主单号时，主单探测也去连字符但仍禁止展开', async () => {
  const row = order({ platform: 'pdd', parent_order_id: '260101123456789012345' });
  const d = database([[], [row]]);
  const input = {
    app_id: APP,
    platform: 'pdd' as const,
    platform_order_no: '260101-123456789012345',
  };
  expect(await findOrderForRights(d.db, input)).toEqual({ kind: 'sub_order_no_missing' });
  scopedReads(d.statements, input);
  expect(equalParameter(d.statements[0]!, 'sub_order_id')).toBe('260101123456789012345');
  expect(equalParameter(d.statements[1]!, 'parent_order_id')).toBe('260101123456789012345');
});

it('[AC-B1-09c#26] 子订单号与主订单号相同仍优先子单精确命中，不误判只给了主单号', async () => {
  const row = order({ parent_order_id: '880012340001' });
  const d = database([[row], [order({ sub_order_id: 'sibling' })]]);
  const input = { app_id: APP, platform: 'taobao' as const, platform_order_no: row.sub_order_id };
  expect(await findOrderForRights(d.db, input)).toEqual({ kind: 'found', order: row });
  scopedReads(d.statements, input);
  expect(equalParameter(d.statements[0]!, 'sub_order_id')).toBe(row.sub_order_id);
  expect(d.statements).toHaveLength(1);
});

it.each(['88001234', '880012340001-extra', '019a0000-0000-7000-8000-000000000001', "x' OR '1'='1"])(
  '[AC-B1-09c#27] 不做前缀/模糊/内部 order_id 回退，未知号码仅作绑定参数：%s',
  async (platform_order_no) => {
    const d = database([[], []]);
    const input = { app_id: APP, platform: 'taobao' as const, platform_order_no };
    expect(await findOrderForRights(d.db, input)).toEqual({ kind: 'not_found' });
    scopedReads(d.statements, input);
    expect(equalParameter(d.statements[0]!, 'sub_order_id')).toBe(platform_order_no);
    for (const statement of d.statements) {
      expect(statement.sql).not.toContain(platform_order_no);
      expect(statement.sql).not.toMatch(/"order_id" =/);
    }
  },
);

it.each(['UNATTRIBUTED', 'ESTIMATED', 'WAITING', 'CREDITED', 'VOID', 'CLAWED_BACK'])(
  '[AC-B1-09c#28] 定位不因 %s/暂停/维权标记或无收货时间而藏掉子单，业务守卫留给调用方',
  async (rebate_status) => {
    const row = order({ rebate_status, hold: true, rights_pending: true, received_at: null });
    const d = database([[row]]);
    const input = { app_id: APP, platform: 'taobao' as const, platform_order_no: row.sub_order_id };
    expect(await findOrderForRights(d.db, input)).toEqual({ kind: 'found', order: row });
    scopedReads(d.statements, input);
    expect(equalParameter(d.statements[0]!, 'sub_order_id')).toBe(row.sub_order_id);
    expect(d.statements[0]!.sql).not.toMatch(
      /"(?:rebate_status|hold|rights_pending|received_at)" (?:=|is|[<>])/i,
    );
  },
);
