import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  computeManifest,
  gradeCase,
  RecordingStore,
  runReplay,
} from '../../../packages/evals/src/index.ts';
import type { EvalCase, TurnOutput } from '../../../packages/evals/src/index.ts';
import { frame, identityFields, meta } from '../evals-replay/fixtures.ts';

function smokeFixture(): { c: EvalCase; out: TurnOutput } {
  const cases = readFileSync(
    new URL('../../../packages/evals/samples/smoke/find.jsonl', import.meta.url),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as EvalCase);
  const c = cases.find((item) => item.id === 'smoke-syn-t1-03')!;
  expect(c).toBeDefined();
  // B3-01e §9 / B3-05e：真实流的形状，全部内容为合成素材；不调用 Agent 实现。
  const out: TurnOutput = {
    frames: [
      frame('card', {
        seq: 1,
        card_id: 'synthetic-card-1003',
        type: 'rebate_quote',
        schema_version: 1,
        data: {
          product: {
            card_id: 'synthetic-card-1003',
            product_key: 'tb:synthetic-1003',
            item_ref: 'synthetic-ref-1003',
            platform: 'taobao',
            shop_type: null,
            title: '合成保温杯',
            image: 'https://image.example.invalid/synthetic.png',
            shop_name: '合成店铺',
            price_fen: 1000,
            coupon_fen: 0,
            final_price_fen: 1000,
            est_net_price_fen: null,
            rebate_min_fen: null,
            rebate_max_fen: null,
            rebate_basis: 'login_required',
            benefit_tags: [],
            match_tag: 'matched',
            spec_text: null,
            is_presale: false,
            tlj: null,
            link_id: 'synthetic-link-1003',
            cta: { text_key: 'product.buy' },
            quoted_at: '2026-10-18T08:00:00+08:00',
            stale: false,
            age_sec: 0,
            source: 'taobao_union',
            disclaimer_keys: ['price_basis.general'],
            ad_label: null,
            availability: 'ok',
          },
          material: null,
          tlj_kind: 'unknown',
        },
        fallback_text: '合成商品返利卡片',
      }),
      frame('done', { finish_reason: 'stop', quota_left: 4 }, 2),
    ],
    trace: {
      intent: 'find_by_link',
      tool_calls: [
        {
          name: 'get_rebate_quote',
          args: { raw: 'https://item.example.invalid/syn/1003' },
          status: 'ok',
        },
      ],
      link_registrations: [
        { link_id: 'synthetic-link-1003', product_key: 'tb:synthetic-1003', ok: true },
      ],
    },
  };
  return { c, out };
}

it('[AC-B3-01e#4][BR-AI-21] smoke-syn-t1-03 的返利卡及登记 trace 判分通过', () => {
  const { c, out } = smokeFixture();
  expect(gradeCase(c, [out], identityFields)).toMatchObject({
    result: 'pass',
    first_failed_layer: null,
    problems: [],
  });
});

it('[AC-B3-01e#4][BR-AI-21] smoke-syn-t1-03 经空录制仓回放后不再产生覆盖缺口', async () => {
  const { c, out } = smokeFixture();
  const manifest = computeManifest('smoke', 'synthetic-b3-01e', [c]);
  const report = await runReplay({
    cases: [c],
    store: new RecordingStore(),
    agent: async () => out,
    meta: meta(manifest),
  });
  expect(report.summary).toMatchObject({ total: 1, pass: 1, coverage_gap: 0, fail: 0, error: 0 });
  expect(report.cases).toMatchObject([{ id: 'smoke-syn-t1-03', result: 'pass', problems: [] }]);
});
