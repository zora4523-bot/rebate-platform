import { expect, it } from 'vitest';
import {
  at,
  check,
  compile,
  contract,
  examples,
  historyMedia,
  list,
  object,
  streamDefinition,
  text,
  visitKeys,
} from './kit.ts';

it('[AC-CT-08e#5] 全部历史示例过 schema、消息正序，覆盖双方、两种游标和带卡的终态回复', async () => {
  const media = historyMedia(await contract());
  const validate = compile(at(media, 'schema'));
  const roles = new Set<unknown>();
  const cursors = new Set<string>();
  const expiredValues = new Set<unknown>();
  let finishedWithCard = false;
  for (const example of examples(media)) {
    check(validate, example, true);
    const data = at(example, 'data');
    cursors.add(data['next_cursor'] === null ? 'null' : typeof data['next_cursor']);
    expiredValues.add(data['expired']);
    let previous = Number.NEGATIVE_INFINITY;
    const cardIds = new Set<string>();
    visitKeys(example, (key, value) => {
      expect(['tool.status', 'ping', 'suggestions', 'meta']).not.toContain(key);
      if (key === 'card_id') {
        const id = text(value);
        expect(cardIds.has(id), `同一示例重复 card_id=${id}`).toBe(false);
        cardIds.add(id);
      }
    });
    for (const item of list(data['items']).map(object)) {
      roles.add(item['role']);
      const createdAt = Date.parse(text(item['created_at']));
      expect(Number.isFinite(createdAt)).toBe(true);
      expect(createdAt, '页内消息时间不降序').toBeGreaterThanOrEqual(previous);
      previous = createdAt;
      const cards = list(item['cards']);
      if (item['role'] === 'user') {
        expect(item['finish_reason']).toBeNull();
        expect(cards).toEqual([]);
      } else if (cards.length > 0 && item['finish_reason'] !== null) {
        finishedWithCard = true;
      }
    }
  }
  expect(roles).toEqual(new Set(['user', 'assistant']));
  expect(cursors).toEqual(new Set(['string', 'null']));
  expect(expiredValues, '示例覆盖过期（BR-AI-20 只读）与未过期会话').toEqual(
    new Set([true, false]),
  );
  expect(finishedWithCard).toBe(true);
});

it('[AC-CT-08e#5] 示例逐卡按流协议校验，收益卡仅保留 as_of/actions 且拒绝实时金额', async () => {
  const media = historyMedia(await contract());
  let earningsCards = 0;
  for (const example of examples(media)) {
    for (const item of list(at(example, 'data')['items']).map(object)) {
      for (const card of list(item['cards']).map(object)) {
        const type = text(card['type']);
        const data = at(card, 'data');
        const definition =
          type === 'earnings_summary' ? 'earnings_summary_history' : `card_${type}`;
        const validate = streamDefinition(definition);
        check(validate, data, true);
        if (type === 'earnings_summary') {
          earningsCards++;
          expect(Object.keys(data).toSorted()).toEqual(['actions', 'as_of']);
          visitKeys(data, (key) => {
            expect(key.endsWith('_fen')).toBe(false);
            expect(key).not.toBe('latest_withdrawal');
          });
          const live = {
            ...data,
            withdrawable_fen: 123,
            estimated_total_fen: 456,
            next_credit_period: '2026-11',
            credit_overdue: false,
            latest_withdrawal: null,
          };
          check(validate, live, false);
          // 逐字段负测，防止仅因其他实时字段被拒而漏掉金额或提现摘要。
          for (const [key, value] of Object.entries(live)) {
            if (key !== 'as_of' && key !== 'actions') {
              check(validate, { ...data, [key]: value }, false);
            }
          }
        }
      }
    }
  }
  expect(earningsCards, '历史示例必须覆盖收益卡的留存投影').toBeGreaterThan(0);
});
