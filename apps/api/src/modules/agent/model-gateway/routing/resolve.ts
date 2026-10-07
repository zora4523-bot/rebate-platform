import { assertOnlineVendor } from '../vendors/index.ts';
import { assertPinnedModel, quirksFor } from '../openai-compat/index.ts';
import type {
  ResolvedRoute,
  RouteDrop,
  RouteDropReason,
  RouteEntry,
  RouteGates,
  RouteSelection,
  RouteTable,
} from './types.ts';

function dropReason(
  entry: RouteEntry,
  tier: RouteEntry['tier'],
  gates: RouteGates,
): RouteDropReason | null {
  try {
    assertOnlineVendor(entry.vendor);
  } catch {
    return 'vendor_not_online';
  }
  if (!gates.consentVendors.includes(entry.vendor)) return 'vendor_not_consented';
  if (entry.tier !== tier) return 'tier_mismatch';
  try {
    assertPinnedModel(entry.model, quirksFor(entry.vendor));
  } catch {
    return 'model_not_pinned';
  }
  if (entry.evaluation?.signed !== true || !entry.evaluation.report.trim()) {
    return 'not_evaluated';
  }
  return null;
}

export function resolveRoute(
  table: RouteTable,
  selection: RouteSelection,
  gates: RouteGates,
): ResolvedRoute {
  if (selection.mode === 'no_model') return { mode: 'no_model', attempts: [], dropped: [] };
  const attempts: RouteEntry[] = [];
  const closed = new Set(table.crossVendor);
  const dropped: RouteDrop[] = [...closed].map((id) => ({ id, reason: 'cross_vendor_closed' }));
  const seen = new Set<string>();
  const selected = [
    [selection.primary, 'flash'],
    [selection.backup, 'plus'],
  ] as const;
  for (const [id, tier] of selected) {
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    if (closed.has(id)) continue;
    const entry = table.entries.find((candidate) => candidate.id === id);
    const reason = entry === undefined ? 'unknown_entry' : dropReason(entry, tier, gates);
    if (reason !== null) dropped.push({ id, reason });
    else if (entry !== undefined) attempts.push(structuredClone(entry));
  }
  return { mode: 'models', attempts, dropped };
}
