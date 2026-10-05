// specs/fund-term-keys.yaml (08 BR-TEXT-12 细则「资金术语键」, CT-19b): an independent reading of
// the classification that scripts/fund-term-keys.ts enforces in `pnpm contracts:check`. The file
// is read with a small line reader for its own layout (two segments of block lists, then exempt);
// the full structure check stays with the script.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { notify_template_code } from './index.ts';

type Segment = { prefixes: string[]; keys: string[]; notify_templates: string[] };

const raw = readFileSync(new URL('../../../specs/fund-term-keys.yaml', import.meta.url), 'utf8');
const texts = (
  JSON.parse(
    readFileSync(new URL('../../../contracts/texts.default.json', import.meta.url), 'utf8'),
  ) as { texts: Record<string, string> }
).texts;

function read(): { segs: Record<string, Segment>; exempt: Map<string, string> } {
  const segs: Record<string, Segment> = {};
  const exempt = new Map<string, string>();
  let top = '';
  let list: keyof Segment | null = null;
  let lastExempt = '';
  for (const line of raw.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const t = /^([a-z_]+):\s*$/.exec(line);
    if (t !== null) {
      top = t[1] ?? '';
      if (top !== 'exempt') segs[top] = { prefixes: [], keys: [], notify_templates: [] };
      continue;
    }
    const l = /^ {2}(prefixes|keys|notify_templates):\s*$/.exec(line);
    if (l !== null) {
      list = l[1] as keyof Segment;
      continue;
    }
    const item = /^ {4}- (\S+)$/.exec(line);
    if (item !== null && top !== 'exempt' && list !== null) {
      segs[top]?.[list].push(item[1] ?? '');
      continue;
    }
    const ek = /^ {2}- key: (\S+)$/.exec(line);
    if (ek !== null && top === 'exempt') {
      lastExempt = ek[1] ?? '';
      exempt.set(lastExempt, '');
      continue;
    }
    const er = /^ {4}reason: (.+)$/.exec(line);
    if (er !== null && top === 'exempt') {
      exempt.set(lastExempt, er[1] ?? '');
      continue;
    }
    throw new Error(`unexpected line: ${line}`);
  }
  return { segs, exempt };
}

const { segs, exempt } = read();
const fund = segs['fund_terms'] as Segment;
const ordinary = segs['ordinary'] as Segment;

it('[AC-CT-19c#4] fund_terms.keys 包含 btn.buy.rebate_suffix', () => {
  expect(fund.keys).toContain('btn.buy.rebate_suffix');
});

function segmentsOf(key: string): string[] {
  return Object.entries(segs)
    .filter(([, s]) => s.keys.includes(key) || s.prefixes.some((p) => key.startsWith(p)))
    .map(([name]) => name);
}

/** Keyword cross-check of 08: amount placeholders, BR-TEXT-01 user terms, keywords. */
function hits(text: string): boolean {
  const amount = /\{(amount|rebate|rebate_sum|sum|promo_sum|net|fee|tax|max)\}/;
  const words = [
    ...['预估返', '预估收益', '推广收益', '已结算', '实返', '可提现', '待抵扣', '冻结中'],
    ...['已到账', '已提现', '实际到账', '跟单成功', '已失效', '已扣回'],
    ...['返利', '收益', '提现', '到账', '余额', '冻结', '扣回', '结算', '入账', '抵扣'],
  ];
  return amount.test(text) || words.some((w) => text.includes(w));
}

it('has exactly the two segments and the exempt table', () => {
  expect(Object.keys(segs).sort()).toEqual(['fund_terms', 'ordinary']);
  expect(exempt.size).toBeGreaterThan(0);
});

it('every text key falls in exactly one segment', () => {
  for (const key of Object.keys(texts)) expect(segmentsOf(key), key).toHaveLength(1);
});

it('every notify template code falls in exactly one segment', () => {
  expect([...fund.notify_templates, ...ordinary.notify_templates].sort()).toEqual(
    [...notify_template_code].sort(),
  );
  expect([...ordinary.notify_templates].sort()).toEqual([
    'SMS_CODE',
    'UNION_AUTH_EXPIRED',
    'UNION_AUTH_EXPIRING',
  ]);
});

it('the two segments cannot cover the same key', () => {
  for (const p of fund.prefixes) {
    for (const q of ordinary.prefixes)
      expect(p.startsWith(q) || q.startsWith(p), p + q).toBe(false);
  }
  for (const key of [...fund.keys, ...ordinary.keys]) expect(segmentsOf(key), key).toHaveLength(1);
});

it('classifies the keys 08 and contract row b5-28 name', () => {
  const asFund = [
    'withdraw.all',
    'withdraw_detail.copy',
    'ledger.balance_after',
    'external_page.product_unresolved',
    'error.30303.below_min',
    'error.30202.ORDER_INVALID',
    'order_status.CREDITED.summary',
    'order_status_group.no_rebate',
    'order_list.deposit_amount',
    'pending_confirm.withdraw.desc',
    'invite.notice_inviter',
  ];
  for (const k of asFund) expect(segmentsOf(k), k).toEqual(['fund_terms']);
  const asOrdinary = [
    'external_page.load_failed',
    'external_page.retry',
    'external_page.close',
    'error.30101',
    'error.30111',
    'clipboard.prompt',
    'app_update.unavailable',
    'order_timeline.deposit_paid',
    'agent.notice.search_disabled',
  ];
  for (const k of asOrdinary) expect(segmentsOf(k), k).toEqual(['ordinary']);
  expect(ordinary.prefixes).not.toContain('external_page.');
});

it('exempt holds exactly the ordinary texts that hit the keyword cross-check, with a reason', () => {
  const expected = Object.entries(texts)
    .filter(([key, text]) => segmentsOf(key)[0] === 'ordinary' && hits(text))
    .map(([key]) => key)
    .sort();
  expect([...exempt.keys()].sort()).toEqual(expected);
  for (const [key, reason] of exempt) expect(reason.trim(), key).not.toBe('');
});
