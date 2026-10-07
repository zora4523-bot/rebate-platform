// resolveRoute：BR-AI-14 细则「路由顺序」（千问 Flash 主 → Plus 备）、跨厂商兜底保持关闭、
// 「路由中的厂商 ⊆ specs/agent-consent-vendors」；BR-AI-21 只在已签字评测的条目之间选择（摘录）；
// 档位约束：主位只能是 Flash 档、备位只能是 Plus 档，违反的条目剔除为 tier_mismatch（口径见 tests-claude.md 第 2 次修改）。
// GLM 只登记离线用途（BR-AI-14 多厂商接入），即使同意清单误含 GLM 也不进线上路由。
// 期望值一律由 entry() 每次新建，不与被测函数拿到的表共享引用。
import { expect, it } from 'vitest';
import {
  resolveRoute,
  type RouteDrop,
  type RouteEntry,
  type RouteSelection,
  type RouteTable,
} from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import { entry, FLASH, FLASH_B } from './kit.ts';

function table(
  entries: RouteEntry[] = [entry('flash'), entry('plus')],
  crossVendor: string[] = [],
): RouteTable {
  return { entries, crossVendor };
}
const both: RouteSelection = { mode: 'models', primary: 'flash', backup: 'plus' };
const qwenOnly = { consentVendors: ['qwen'] };

it('[BR-AI-14 路由顺序] 两个条目都合格：attempts 依次为主（Flash）、备（Plus），没有剔除', () => {
  expect(resolveRoute(table(), both, qwenOnly)).toEqual({
    mode: 'models',
    attempts: [entry('flash'), entry('plus')],
    dropped: [],
  });
});

it('[BR-AI-14 路由顺序] 档位颠倒的选择（primary=plus、backup=flash）被拒绝：两条都剔除为 tier_mismatch，不尝试任何条目', () => {
  const got = resolveRoute(table(), { mode: 'models', primary: 'plus', backup: 'flash' }, qwenOnly);
  expect(got.mode).toBe('models');
  expect(got.attempts).toEqual([]);
  expect(got.dropped).toHaveLength(2);
  expect(got.dropped).toEqual(
    expect.arrayContaining([
      { id: 'plus', reason: 'tier_mismatch' },
      { id: 'flash', reason: 'tier_mismatch' },
    ]),
  );
});

it('[BR-AI-14 路由顺序] 两个 Flash 条目分别作主、备：备用位不是 Plus 档，剔除为 tier_mismatch，只尝试主', () => {
  const t = table([entry('flash'), entry('flash-b', { model: FLASH_B }), entry('plus')]);
  const got = resolveRoute(t, { mode: 'models', primary: 'flash', backup: 'flash-b' }, qwenOnly);
  expect(got.attempts).toEqual([entry('flash')]);
  expect(got.dropped).toEqual([{ id: 'flash-b', reason: 'tier_mismatch' }]);
});

it('[BR-AI-21 后台切换] 在同档位的已评测快照之间切换：主位换成另一个已签字的 Flash 快照，attempts=[新 Flash, Plus]', () => {
  const t = table([entry('flash'), entry('flash-b', { model: FLASH_B }), entry('plus')]);
  expect(resolveRoute(t, { mode: 'models', primary: 'flash-b', backup: 'plus' }, qwenOnly)).toEqual(
    {
      mode: 'models',
      attempts: [entry('flash-b', { model: FLASH_B }), entry('plus')],
      dropped: [],
    },
  );
});

it('[BR-AI-14 路由顺序] backup 为 null：只尝试主（Flash）', () => {
  expect(
    resolveRoute(table(), { mode: 'models', primary: 'flash', backup: null }, qwenOnly),
  ).toEqual({ mode: 'models', attempts: [entry('flash')], dropped: [] });
});

it('[BR-AI-14 路由顺序] 主备选成同一个 Flash 条目：Flash 只作主尝试一次，不再作为备用', () => {
  const got = resolveRoute(
    table(),
    { mode: 'models', primary: 'flash', backup: 'flash' },
    qwenOnly,
  );
  expect(got.mode).toBe('models');
  expect(got.attempts).toEqual([entry('flash')]);
});

interface DropCase {
  readonly name: string;
  readonly table: RouteTable;
  readonly selection: RouteSelection;
  readonly consent: string[];
  readonly attempts: RouteEntry[];
  readonly dropped: RouteDrop[];
}

const cases: DropCase[] = [
  {
    name: '[BR-AI-14 同意清单] 千问不在同意清单：两个条目都剔除为 vendor_not_consented',
    table: table(),
    selection: both,
    consent: [],
    attempts: [],
    dropped: [
      { id: 'flash', reason: 'vendor_not_consented' },
      { id: 'plus', reason: 'vendor_not_consented' },
    ],
  },
  {
    name: '[BR-AI-14 多厂商接入] GLM 条目即使同意清单含 glm 也剔除为 vendor_not_online',
    table: table([
      entry('flash'),
      entry('glm-b', { vendor: 'glm', tier: 'plus', model: 'glm-synthetic-2026-09-01' }),
    ]),
    selection: { mode: 'models', primary: 'flash', backup: 'glm-b' },
    consent: ['qwen', 'glm'],
    attempts: [entry('flash')],
    dropped: [{ id: 'glm-b', reason: 'vendor_not_online' }],
  },
  {
    name: '[BR-AI-14 快照锁定] 型号带 latest：剔除为 model_not_pinned',
    table: table([entry('flash'), entry('plus', { model: 'qwen-plus-latest' })]),
    selection: both,
    consent: ['qwen'],
    attempts: [entry('flash')],
    dropped: [{ id: 'plus', reason: 'model_not_pinned' }],
  },
  {
    name: '[BR-AI-14 快照锁定] 型号没有日期快照：剔除为 model_not_pinned',
    table: table([entry('flash', { model: 'qwen-flash' }), entry('plus')]),
    selection: both,
    consent: ['qwen'],
    attempts: [entry('plus')],
    dropped: [{ id: 'flash', reason: 'model_not_pinned' }],
  },
  {
    name: '[BR-AI-21] 没有评测报告：剔除为 not_evaluated',
    table: table([entry('flash', { evaluation: null }), entry('plus')]),
    selection: both,
    consent: ['qwen'],
    attempts: [entry('plus')],
    dropped: [{ id: 'flash', reason: 'not_evaluated' }],
  },
  {
    name: '[BR-AI-21] 评测报告未签字：剔除为 not_evaluated',
    table: table([
      entry('flash'),
      entry('plus', { evaluation: { report: 'reports/p.md', signed: false } }),
    ]),
    selection: both,
    consent: ['qwen'],
    attempts: [entry('flash')],
    dropped: [{ id: 'plus', reason: 'not_evaluated' }],
  },
  {
    name: '[BR-AI-21] 选择指向不存在的条目：记 unknown_entry',
    table: table(),
    selection: { mode: 'models', primary: 'flash-old', backup: 'plus' },
    consent: ['qwen'],
    attempts: [entry('plus')],
    dropped: [{ id: 'flash-old', reason: 'unknown_entry' }],
  },
  {
    name: '[BR-AI-14 跨厂商兜底关闭] crossVendor 槽位里的条目即使千问、已锁定、已签字也整槽剔除为 cross_vendor_closed',
    table: table([entry('flash'), entry('plus'), entry('qwen-x', { model: FLASH })], ['qwen-x']),
    selection: both,
    consent: ['qwen'],
    attempts: [entry('flash'), entry('plus')],
    dropped: [{ id: 'qwen-x', reason: 'cross_vendor_closed' }],
  },
];

it.each(cases)('$name', (c) => {
  const got = resolveRoute(c.table, c.selection, { consentVendors: c.consent });
  expect(got.mode).toBe('models');
  expect(got.attempts).toEqual(c.attempts);
  expect(got.dropped).toHaveLength(c.dropped.length);
  expect(got.dropped).toEqual(expect.arrayContaining(c.dropped));
});

it('[BR-AI-21 切无模型] 选择为 no_model：mode 为 no_model，不尝试任何条目', () => {
  expect(resolveRoute(table(), { mode: 'no_model' }, qwenOnly)).toEqual({
    mode: 'no_model',
    attempts: [],
    dropped: [],
  });
});
