// B3-05g · BR-AI-05 / B3-05i: the decorator puts server notices in front of the handler's cards
// (BR-AI-08: the notice goes before the products it explains). A handler's cardReference(ctx, i)
// addresses its own outcome.cards[i], and the core resolves references against the final cards
// array, so every reference of this call is re-issued for its shifted position: i → i + offset.
// The new reference is issued through the core's cardReference on the same ctx, so it stays bound
// to the call the core opened (no copy of the placeholders table, no hand-made token).
//
// Server-side runs outside the model loop (refinement, 第 N 个) open their own scope with the core's
// openCardCall, exactly as the core does per model call, and close it after delivery.
import { cardReference, openCardCall } from '../core/card-references.ts';
import type { CardCall, CardReferenceContext } from '../core/card-references.ts';

/** @card-ref:<32 hex nonce>:<encodeURIComponent(callId), no ':'>:<index> (card-references.ts). */
const REFERENCE = /^(@card-ref:[0-9a-f]{32}:[^:]*:)(\d+)$/u;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * value with every whole-string reference of ctx's call moved by `offset` cards. The value is
 * returned as is when nothing changes (offset 0, no reference, or a ctx the core did not open).
 * A look-alike string from another call or from catalog text is left alone: only this call's
 * prefix (learned from the core) is rewritten.
 */
export function shiftCardReferences(
  value: unknown,
  ctx: CardReferenceContext,
  offset: number,
): unknown {
  if (offset === 0) return value;
  let prefix: string | null | undefined;

  function own(candidate: string): string | null {
    if (prefix === undefined) {
      try {
        const probe = cardReference(ctx, 0);
        prefix = probe.slice(0, probe.lastIndexOf(':') + 1);
      } catch {
        // Not a context the core opened, or already settled: nothing can be re-issued.
        prefix = null;
      }
    }
    return prefix !== null && candidate === prefix ? prefix : null;
  }

  function walk(item: unknown): unknown {
    if (typeof item === 'string') {
      const match = REFERENCE.exec(item);
      if (match === null || own(match[1] ?? '') === null) return item;
      return cardReference(ctx, Number(match[2]) + offset);
    }
    if (Array.isArray(item)) {
      let changed = false;
      const out = (item as readonly unknown[]).map((entry) => {
        const next = walk(entry);
        if (next !== entry) changed = true;
        return next;
      });
      return changed ? out : item;
    }
    if (plainObject(item)) {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item)) {
        const next = walk(entry);
        if (next !== entry) changed = true;
        // defineProperty: a "__proto__" key stays an own data field.
        Object.defineProperty(out, key, {
          value: next,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return changed ? out : item;
    }
    return item;
  }

  return walk(value);
}

/** A card-reference scope for one server-built tool call, as the core opens per model call. */
export function openServerCall(callId: string, placeholders: Readonly<Record<string, string>>) {
  // A fresh frozen copy: its identity binds the scope to this call alone (card-references.ts).
  const table = Object.freeze({ ...placeholders });
  const refs: CardCall = openCardCall(callId, table);
  return { placeholders: table, refs };
}
