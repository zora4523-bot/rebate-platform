// B3-05g · BR-AI-05: in-memory ResultSetStore (tests and local wiring). The PG store of
// agent_result_sets belongs to B3-09c; it must keep the same semantics: conditions and delivered
// cards are kept apart, every lookup is scoped by app and session, takeOnce is atomic.
import type { ClarificationScope, ClarifySlot } from '../intents/types.ts';
import type { DeliveredProduct, ResultSetInput, ResultSetStore, StoredResultSet } from './types.ts';

interface Row {
  input: ResultSetInput;
  delivered: DeliveredProduct[];
}

function snapshot(row: Row): StoredResultSet {
  return { ...row.input, delivered: [...row.delivered] };
}

function sameDomain(row: Row, appId: string, sessionId: string): boolean {
  return row.input.appId === appId && row.input.sessionId === sessionId;
}

export function createMemoryResultSetStore(): ResultSetStore {
  // Save order is the recency order; a re-save of the same id keeps its place and receipts.
  const rows: Row[] = [];
  const byId = new Map<string, Row>();
  const asked = new Set<string>();

  return {
    async save(value) {
      const existing = byId.get(value.id);
      if (existing !== undefined) {
        existing.input = value;
        return;
      }
      const row: Row = { input: value, delivered: [] };
      rows.push(row);
      byId.set(value.id, row);
    },

    async recordDelivered(resultSetId, items) {
      const row = byId.get(resultSetId);
      // A receipt for a set never saved has no trusted app/session: it is ignored.
      if (row === undefined) return;
      for (const item of items) {
        if (!row.delivered.some((entry) => entry.card_id === item.card_id)) {
          row.delivered.push(item);
        }
      }
    },

    async latestWithProducts(appId, sessionId) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row !== undefined && sameDomain(row, appId, sessionId) && row.delivered.length > 0) {
          return snapshot(row);
        }
      }
      return null;
    },

    async findDelivered(appId, sessionId, cardId) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row === undefined || !sameDomain(row, appId, sessionId)) continue;
        const found = row.delivered.find((entry) => entry.card_id === cardId);
        if (found !== undefined) return found;
      }
      return null;
    },

    async takeOnce(scope: ClarificationScope, slot: ClarifySlot) {
      // Check and insert run without an await in between: concurrent callers see one winner.
      const key = JSON.stringify([scope.appId, scope.sessionId, scope.chainId, slot]);
      if (asked.has(key)) return false;
      asked.add(key);
      return true;
    },
  };
}
