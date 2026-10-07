import { StreamProtocolError } from '../writer/index.ts';
import type { NumberedCard, UnnumberedCard } from './index.ts';

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StreamProtocolError('invalid_frame', 'Card data must be an object');
  }
  return value as Record<string, unknown>;
}

/** Number the envelope before its embedded products, without changing the caller's snapshot. */
export function numberCard(input: UnnumberedCard, firstNo: number): NumberedCard {
  let card: UnnumberedCard;
  try {
    card = structuredClone(input);
  } catch {
    throw new StreamProtocolError('invalid_frame', 'Card must be cloneable');
  }
  let used = 0;
  const next = (): string => {
    const n = firstNo + used;
    if (!Number.isSafeInteger(n) || n < 1) {
      throw new StreamProtocolError('invalid_frame', 'Invalid session card sequence');
    }
    used += 1;
    return `c${n}`;
  };
  const cardId = next();
  const data = object(card.data);
  if (card.type === 'product_list') {
    const items = data['items'];
    if (!Array.isArray(items)) {
      throw new StreamProtocolError('invalid_frame', 'Product list requires items');
    }
    for (const item of items) object(item)['card_id'] = next();
  } else if (card.type === 'rebate_quote') {
    object(data['product'])['card_id'] = next();
  }
  return { card: { ...card, card_id: cardId }, used };
}
