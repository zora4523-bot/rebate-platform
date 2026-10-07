// B1-06e: the open use case the HTTP controller calls — B1-06d (whom the open serves) and B1-06k
// (price re-check, idempotency, single flight, link_logs, attempts) composed with the jd / pdd
// server conversion (link-open-conversion.ts). Amounts leave here as safe JSON integers.
import type { components } from '@couli/contracts-ts';
import type { HandlerResult } from '../../platform/index.ts';
import { createLinkOpenConversion, type LinkConversionOptions } from './link-open-conversion.ts';
import {
  createLinkOpenRequote,
  type LinkOpenRequoteInput,
  type LinkOpenRequoteOptions,
  type LinkOpenRequoteResult,
} from './link-open-requote.ts';

export interface LinkOpenInput extends LinkOpenRequoteInput {
  readonly noRebateReason?: components['schemas']['OpenLinkRequest']['no_rebate_reason'];
}

/** HTTP injection token. Controller takes identity from CallerContext, never body fields. */
export class LinkOpenService {
  open(input: LinkOpenInput): Promise<HandlerResult> {
    void input;
    return Promise.reject(new Error('linking: open service is not composed in this process'));
  }
}

type OpenLinkResult = components['schemas']['OpenLinkResult'];

const STATUS: Readonly<Record<number, number>> = {
  0: 200,
  10001: 401,
  20001: 400,
  30141: 422,
  30144: 404,
  30602: 422,
  50301: 503,
  50303: 503,
};

/** Fallback texts only; clients show the dictionary text error.<code> (BR-TEXT-14). */
const MESSAGES: Readonly<Record<number, string>> = {
  0: 'ok',
  10001: '请先登录',
  20001: '参数错误',
  30141: '商品已下架',
  30144: '链接不存在',
  30602: '淘礼金已领完',
  50301: '该平台暂时无法购买，请稍后再试',
  50303: '暂时无法确认价格或生成链接，请稍后再试',
};

/** A decimal fen string as a JSON integer; beyond the safe range it is a server fault. */
function fenNumber(value: string | null): number | null {
  if (value === null) return null;
  const fen = BigInt(value);
  if (fen > BigInt(Number.MAX_SAFE_INTEGER) || fen < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('linking: fen amount outside the safe JSON integer range');
  }
  return Number(fen);
}

function wire(data: LinkOpenRequoteResult): OpenLinkResult {
  return {
    ...data,
    old_final_price_fen: fenNumber(data.old_final_price_fen),
    new_final_price_fen: fenNumber(data.new_final_price_fen),
    new_rebate_min_fen: fenNumber(data.new_rebate_min_fen),
    new_rebate_max_fen: fenNumber(data.new_rebate_max_fen),
  } as OpenLinkResult;
}

class ComposedLinkOpen extends LinkOpenService {
  readonly #requote: ReturnType<typeof createLinkOpenRequote>;

  constructor(requote: ReturnType<typeof createLinkOpenRequote>) {
    super();
    this.#requote = requote;
  }

  override async open(input: LinkOpenInput): Promise<HandlerResult> {
    const outcome = await this.#requote.open(input);
    if (outcome.code === 0 && outcome.data !== null) {
      return {
        status: 200,
        envelope: { code: 0, msg: MESSAGES[0]!, data: wire(outcome.data), trace_id: input.traceId },
      };
    }
    // Error envelopes carry no data here (ErrorEnvelope: data only for codes that define it).
    return {
      status: STATUS[outcome.code] ?? 500,
      envelope: {
        code: outcome.code,
        msg: MESSAGES[outcome.code] ?? '服务端错误',
        trace_id: input.traceId,
      },
    };
  }
}

/** Compose ownership/requote with server conversion; serialize fen as safe JSON integers. */
export function createLinkOpen(
  options: Omit<LinkOpenRequoteOptions, 'conversion'> & LinkConversionOptions,
): LinkOpenService {
  const conversion = createLinkOpenConversion(options);
  return new ComposedLinkOpen(createLinkOpenRequote({ ...options, conversion }));
}
