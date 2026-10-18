import { vi } from 'vitest';
import type { Candidate } from '../../../../apps/api/src/modules/parsing/index.ts';
import type {
  LinkQuoteOutcome,
  LinkQuoteRunner,
} from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import type {
  AgentRunTexts,
  PathInput,
} from '../../../../apps/api/src/modules/agent/orchestrator/core/ports.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { input, proceed, productList } from '../orchestrator-core/kit.ts';

export function url(id: number, index = id * 50): Candidate & { kind: 'url' } {
  return { kind: 'url', raw: `https://item.example.invalid/syn/${id}`, index };
}

// Complete synthetic product wire shape; no catalog/parsing/registration internals under test.
export function success(id: number): Extract<LinkQuoteOutcome, { kind: 'ok' }> {
  const product = (productList(1).data['items'] as Record<string, unknown>[])[0]!;
  const card: UnnumberedCard = {
    type: 'rebate_quote',
    schema_version: 1,
    fallback_text: '请查看商品返利卡片。',
    data: {
      product: {
        ...product,
        product_key: `tb:synthetic-${id}`,
        link_id: `synthetic-link-${id}`,
        price_fen: 12345 + id,
        coupon_fen: 100,
        final_price_fen: 12245 + id,
        rebate_min_fen: 0,
        rebate_max_fen: 237,
        rebate_basis: 'normal',
        quoted_at: '2026-10-18T08:00:00+08:00',
      },
      material: null,
      tlj_kind: 'unknown',
    },
  };
  return {
    kind: 'ok',
    modelView: {},
    cards: [card],
    trace: {
      link_registrations: [
        { link_id: `synthetic-link-${id}`, product_key: `tb:synthetic-${id}`, ok: true },
      ],
    },
  };
}

export function request(links: readonly Candidate[] = [url(1)]): PathInput {
  return { input: input(), proceed: proceed({ links }) };
}

export function texts(): AgentRunTexts {
  return {
    text: vi.fn(async (_appId, key) => `固定文案:${key}`),
    toolDisplay: vi.fn(async (_appId, tool, phase) => `模板:${tool}:${phase}`),
  };
}

export function quotes(outcomes: readonly (LinkQuoteOutcome | Error)[] = [success(1)]) {
  let next = 0;
  return {
    run: vi.fn<LinkQuoteRunner['run']>(async () => {
      const outcome = outcomes[next++];
      if (outcome === undefined) throw new Error('Unexpected extra quote call');
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  };
}
