import { expect, it } from 'vitest';
import { createOutputGuard } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import type {
  GuardEmit,
  ReviewVerdict,
} from '../../../../apps/api/src/modules/agent/guard/index.ts';
import { reviewScript, runGuard, textOf } from './kit.ts';

it('[AC-B3-06a#12] 跨 push 与 end 最多两句，第三句不送审并记录截断', async () => {
  const review = reviewScript();
  const guard = createOutputGuard({ review: review.port });
  expect(await guard.push('第一句。')).toEqual([{ kind: 'text', text: '第一句。' }]);
  expect(await guard.push('第二句！')).toEqual([{ kind: 'text', text: '第二句！' }]);
  expect(guard.summary().outputTruncated).toBe(false);
  expect(await guard.push('第三句')).toEqual([]);
  expect(await guard.end()).toEqual([]);
  expect(review.calls).toEqual(['第一句。', '第二句！']);
  expect(guard.summary().outputTruncated).toBe(true);
});

it('[AC-B3-06a#12] 同一 delta 内的第三句也丢弃，恰两句不记截断', async () => {
  const two = await runGuard(['甲。乙！']);
  const three = await runGuard(['甲。乙！丙？']);
  expect(two.text).toBe('甲。乙！');
  expect(two.summary.outputTruncated).toBe(false);
  expect(three.text).toBe(two.text);
  expect(three.calls).toEqual(two.calls);
  expect(three.summary.outputTruncated).toBe(true);
});

it('[AC-B3-06a#13] 空白、纯标点和删空的句子不下发、不计数、不送审', async () => {
  const result = await runGuard([
    ' \t。！？；!?\n',
    '$AbCd1234$。',
    'https://x.com/a\n',
    '甲。乙。',
  ]);
  expect(result.text).toBe('甲。乙。');
  expect(result.calls).toEqual(['甲。', '乙。']);
  expect(result.summary.outputTruncated).toBe(false);
  expect(result.summary.outputFiltered).toBe(true);
  expect(new Set(result.summary.filterHits)).toEqual(new Set(['tpwd', 'url']));
});

it('[AC-B3-06a#13] 60 字切开的长句仍只占一整句，片段分别送审', async () => {
  const long = '好'.repeat(121) + '。';
  const result = await runGuard([long, '第二句。', '第三句。']);
  expect(result.text).toBe(long + '第二句。');
  expect(result.calls).toEqual(['好'.repeat(60), '好'.repeat(60), '好。', '第二句。']);
  expect(result.summary.outputTruncated).toBe(true);
});

it('[AC-B3-06a#14] 每个下发片段恰送审一次且送的是过滤后的文本', async () => {
  const result = await runGuard(['价格29元。', '点https://x.com/a看看！']);
  expect(result.calls).toEqual(['价格见卡片。', '点看看！']);
  expect(result.emits).toEqual(result.calls.map((text) => ({ kind: 'text', text })));
});

it('[AC-B3-06a#14] 审核 Promise 未完成前 push 不得交付文本', async () => {
  const pending = Promise.withResolvers<ReviewVerdict>();
  const entered = Promise.withResolvers<string>();
  const guard = createOutputGuard({
    review: {
      review(text) {
        entered.resolve(text);
        return pending.promise;
      },
    },
  });
  let delivered: GuardEmit[] | undefined;
  const pushing = guard.push('价格29元。').then((emits) => {
    delivered = emits;
    return emits;
  });
  expect(await entered.promise).toBe('价格见卡片。');
  await Promise.resolve();
  expect(delivered).toBeUndefined();
  pending.resolve('pass');
  expect(await pushing).toEqual([{ kind: 'text', text: '价格见卡片。' }]);
});

it('[AC-B3-06a#15] block 保留已通过文字，替换命中句并立即停止', async () => {
  const review = reviewScript(['pass', 'block']);
  const guard = createOutputGuard({ review: review.port });
  expect(await guard.push('已通过。')).toEqual([{ kind: 'text', text: '已通过。' }]);
  expect(await guard.push('不通过。后续文本。')).toEqual([
    { kind: 'fixed', key: 'agent.refuse.output_blocked' },
  ]);
  expect(guard.stopped).toBe(true);
  expect(guard.summary().safety).toBe('blocked');
  expect(await guard.push('不能再次输出。')).toEqual([]);
  expect(await guard.end()).toEqual([]);
  expect(review.calls).toEqual(['已通过。', '不通过。']);
});

it.each(['pass', 'block', 'timeout'] as const)(
  '[AC-B3-06a#16] timeout 后 end 整段复审一次：%s',
  async (last) => {
    const review = reviewScript(['timeout', last]);
    const guard = createOutputGuard({ review: review.port });
    expect(await guard.push('价格29元。')).toEqual([]);
    expect(await guard.push('点https://x.com/a看看。第三句不审。')).toEqual([]);
    expect(review.calls).toEqual(['价格见卡片。']);
    const emits = await guard.end();
    expect(review.calls).toEqual(['价格见卡片。', '价格见卡片。点看看。']);
    expect(guard.summary().outputTruncated).toBe(true);
    expect(guard.summary().outputFiltered).toBe(true);
    expect(new Set(guard.summary().filterHits)).toEqual(new Set(['amount', 'url']));
    if (last === 'pass') {
      expect(textOf(emits)).toBe('价格见卡片。点看看。');
      expect(emits.every((emit) => emit.kind === 'text')).toBe(true);
      expect(guard.stopped).toBe(false);
      expect(guard.summary().safety).toBe('none');
    } else {
      expect(emits).toEqual([
        {
          kind: 'fixed',
          key: last === 'block' ? 'agent.refuse.output_blocked' : 'agent.refuse.safety_timeout',
        },
      ]);
      expect(guard.stopped).toBe(last === 'block');
      expect(guard.summary().safety).toBe(last === 'block' ? 'blocked' : 'timeout_replaced');
      if (last === 'block') {
        expect(await guard.push('后续不得下发。')).toEqual([]);
        expect(await guard.end()).toEqual([]);
        expect(review.calls).toHaveLength(2);
      }
    }
  },
);

it('[AC-B3-06a#16] 先通过再超时，复审不得重复已下发的句子', async () => {
  const review = reviewScript(['pass', 'timeout', 'pass']);
  const guard = createOutputGuard({ review: review.port });
  expect(textOf(await guard.push('已经通过。'))).toBe('已经通过。');
  expect(await guard.push('还有29元')).toEqual([]);
  expect(textOf(await guard.end())).toBe('还有见卡片');
  expect(review.calls).toEqual(['已经通过。', '还有见卡片', '还有见卡片']);
  expect(guard.stopped).toBe(false);
});

it('[AC-B3-06a#16] 强制片段超时后扣住同句剩余部分，复审保留长句及第二句', async () => {
  const review = reviewScript(['timeout', 'pass']);
  const guard = createOutputGuard({ review: review.port });
  expect(await guard.push('好'.repeat(60))).toEqual([]);
  expect(await guard.push('尾29元。第二句。第三句。')).toEqual([]);
  expect(review.calls).toEqual(['好'.repeat(60)]);
  const expected = '好'.repeat(60) + '尾见卡片。第二句。';
  expect(textOf(await guard.end())).toBe(expected);
  expect(review.calls).toEqual(['好'.repeat(60), expected]);
});

it.each(['pass', 'timeout', 'error'] as const)(
  '[AC-B3-06a#17] 审核抛错等同 timeout；复审 %s',
  async (last) => {
    const review = reviewScript([
      new Error('synthetic review error'),
      last === 'error' ? new Error('synthetic retry error') : last,
    ]);
    const guard = createOutputGuard({ review: review.port });
    expect(await guard.push('尚未审核。')).toEqual([]);
    const emits = await guard.end();
    expect(review.calls).toEqual(['尚未审核。', '尚未审核。']);
    expect(emits).toEqual(
      last === 'pass'
        ? [{ kind: 'text', text: '尚未审核。' }]
        : [{ kind: 'fixed', key: 'agent.refuse.safety_timeout' }],
    );
    expect(guard.stopped).toBe(false);
    expect(guard.summary().safety).toBe(last === 'pass' ? 'none' : 'timeout_replaced');
  },
);

it('[AC-B3-06a#18] 摘要只含实际命中类型且跨片段去重', async () => {
  const clean = await runGuard(['普通说明。']);
  expect(clean.summary).toEqual({
    outputFiltered: false,
    filterHits: [],
    outputTruncated: false,
    safety: 'none',
  });
  const mixed = await runGuard(['29元，https://x.com/a，$AbCd1234$。', '39元，https://x.cn/b。']);
  expect(mixed.summary.outputFiltered).toBe(true);
  expect([...mixed.summary.filterHits].sort()).toEqual(['amount', 'tpwd', 'url']);
});

it('[AC-B3-06a#17] 端口在返回 Promise 前同步抛错也按 timeout 处理', async () => {
  const calls: string[] = [];
  const guard = createOutputGuard({
    review: {
      review(text) {
        calls.push(text);
        throw new Error('synthetic synchronous review error');
      },
    },
  });
  expect(await guard.push('说明。')).toEqual([]);
  expect(await guard.end()).toEqual([{ kind: 'fixed', key: 'agent.refuse.safety_timeout' }]);
  expect(calls).toEqual(['说明。', '说明。']);
  expect(guard.summary().safety).toBe('timeout_replaced');
  expect(guard.stopped).toBe(false);
});

it.each(['淘宝', '京东', '拼多多'])(
  '[AC-B3-06a#23] O-G5 已下发复制后，跨句打开%s仍按口令删除',
  async (platform) => {
    const result = await runGuard(['请复制。', `然后打开${platform}看看。`]);
    expect(result.text).toBe('请复制。然后看看。');
    expect(result.calls).toEqual(['请复制。', '然后看看。']);
    expect(result.summary.filterHits).toEqual(['tpwd']);
  },
);
