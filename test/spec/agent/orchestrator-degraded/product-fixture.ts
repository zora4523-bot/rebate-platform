import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';

/** Synthetic card matching contracts/agent-stream.schema.json card_product_list.
 * quoted_at uses the required +08:00 offset; numberCard supplies card IDs later.
 */
export function syntheticProductList(): UnnumberedCard {
  return {
    type: 'product_list',
    schema_version: 1,
    fallback_text: '合成商品列表',
    data: {
      result_set_id: 'synthetic-results',
      layout: 'list',
      items: [
        {
          product_key: 'tb:synthetic-0',
          item_ref: 'synthetic-ref',
          platform: 'taobao',
          shop_type: null,
          title: '合成商品0',
          image: 'https://example.invalid/synthetic.png',
          shop_name: '合成店铺',
          price_fen: 1000,
          coupon_fen: 0,
          final_price_fen: 1000,
          est_net_price_fen: null,
          rebate_min_fen: null,
          rebate_max_fen: null,
          rebate_basis: 'amount_unknown',
          benefit_tags: [],
          match_tag: 'matched',
          spec_text: null,
          is_presale: false,
          tlj: null,
          link_id: 'synthetic-link-0',
          cta: { text_key: 'product.buy' },
          quoted_at: '2026-10-15T08:00:00+08:00',
          stale: false,
          age_sec: 0,
          source: 'taobao_union',
          disclaimer_keys: ['price_basis.general'],
          ad_label: null,
          availability: 'ok',
        },
      ],
    },
  };
}
