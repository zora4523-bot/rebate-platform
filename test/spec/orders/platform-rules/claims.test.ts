// B1-08za: 找回授权平台 (claimAuth), pinned through both readers of it before the refactor: the
// pinned claim entry (claim-entry.ts, BR-ATTR-17) and the claim evidence (claim-evidence.ts,
// BR-ATTR-18 / BR-ID-18). Each case has a control (the same row without no_rebate counts on every
// platform), so a false comes from the authorisation rule alone.
import { expect, it } from 'vitest';
import { claimEntryPinned } from '../../../../apps/api/src/modules/orders/domain/claim-entry.ts';
import { judgeClaimEvidence } from '../../../../apps/api/src/modules/orders/domain/claim-evidence.ts';
import type {
  ClaimEntryBinding,
  ClaimEntryLog,
  ClaimEvidenceLog,
} from '../../../../apps/api/src/modules/linking/index.ts';
import { PINNED, REGISTERED_PLATFORMS, rulesOf } from './kit.ts';

const NOW = new Date('2026-10-19T12:00:00Z');
const LOG_AT = new Date('2026-10-19T11:00:00Z');
const BOUND_AT = new Date('2026-10-19T11:30:00Z');
const BOUND_BEFORE_LOG = new Date('2026-10-19T10:59:59.999Z');
/** Contract PlatformCode values without a table entry, and spellings that are not platforms. */
const UNREGISTERED = ['meituan', 'vip', 'PDD', 'TAOBAO', ''];

function entryLog(platform: string | null, noRebate = true): ClaimEntryLog {
  return {
    app_id: 'app-1',
    user_id: 'user-1',
    id: 1n,
    opener_user_id: null,
    platform,
    event: 'convert',
    result_code: 0,
    pid_scene: 'self_buy',
    no_rebate: noRebate,
    no_rebate_reason: noRebate ? 'auth_declined' : null,
    created_at: LOG_AT,
  };
}

function entryBinding(
  platform: string,
  relationId: string | null,
  boundAt: Date = BOUND_AT,
  status = 'active',
): ClaimEntryBinding {
  return {
    app_id: 'app-1',
    user_id: 'user-1',
    platform,
    status,
    bound_at: boundAt,
    relation_id: relationId,
  };
}

function pinned(log: ClaimEntryLog, bindings: readonly ClaimEntryBinding[]): boolean {
  return claimEntryPinned({
    app_id: 'app-1',
    user_id: 'user-1',
    now: NOW,
    latest_order_attr_at: null,
    logs: [log],
    bindings,
  });
}

it('[AC-B1-08za#17] 找回授权平台（待跟单入口）：淘宝要 active 且 relation_id 可用（1–32 位）、拼多多 active 备案行即可、京东与未登记平台永不恢复授权类无返利记录', () => {
  const relations: readonly (string | null)[] = [null, '', 'rel-1', 'x'.repeat(32), 'x'.repeat(33)];
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    const auth = PINNED[platform].claimAuth;
    expect(rules.claimAuth, platform).toBe(auth);
    for (const relation of relations) {
      const usable = relation !== null && relation !== '' && relation.length <= 32;
      const expected = auth === 'filing' || (auth === 'relation_id' && usable);
      const label = `${platform} relation ${String(relation)}`;
      expect(pinned(entryLog(platform), [entryBinding(platform, relation)]), label).toBe(expected);
      // Control: an ordinary jump-out pins whatever the binding.
      expect(pinned(entryLog(platform, false), [entryBinding(platform, relation)]), label).toBe(
        true,
      );
      // Bound before the log, not active, or another platform's binding: never authorised since.
      expect(
        pinned(entryLog(platform), [entryBinding(platform, relation, BOUND_BEFORE_LOG)]),
        label,
      ).toBe(false);
      expect(
        pinned(entryLog(platform), [entryBinding(platform, relation, BOUND_AT, 'released')]),
        label,
      ).toBe(false);
      const other = REGISTERED_PLATFORMS.find((p) => p !== platform) ?? platform;
      expect(pinned(entryLog(platform), [entryBinding(other, relation)]), label).toBe(false);
    }
    expect(pinned(entryLog(platform), []), platform).toBe(false);
  }
  for (const platform of UNREGISTERED) {
    expect(pinned(entryLog(platform), [entryBinding(platform, 'rel-1')]), platform).toBe(false);
    expect(pinned(entryLog(platform, false), [entryBinding(platform, 'rel-1')]), platform).toBe(
      true,
    );
  }
  expect(pinned(entryLog(null), [])).toBe(false);
});

function evidenceLog(platform: string, noRebate = true): ClaimEvidenceLog {
  return {
    id: 7n,
    app_id: 'app-1',
    user_id: 'user-1',
    opener_user_id: null,
    platform,
    event: 'open',
    product_key: 'key-1',
    shop_id: null,
    result_code: 0,
    no_rebate: noRebate,
    no_rebate_reason: noRebate ? 'auth_failed' : null,
    created_at: LOG_AT,
    pid_scene: null,
    cache_hit: false,
    expired: false,
  };
}

function evidence(platform: string, log: ClaimEvidenceLog, bindingStatus: string | null) {
  return judgeClaimEvidence({
    appId: 'app-1',
    userId: 'user-1',
    platform,
    attrAt: NOW,
    productKey: 'key-1',
    shopId: null,
    windowHours: 360,
    logs: [log],
    bindings:
      bindingStatus === null
        ? []
        : [{ status: bindingStatus, bound_at: BOUND_AT, released_at: null }],
    conflicts: [],
  });
}

it('[AC-B1-08za#18] 找回授权平台（找回证据）：淘宝与拼多多有 active 绑定时授权类无返利记录算证据，京东与未登记平台不算', () => {
  const strong = { evidence: 'strong', evidence_link_log_ids: [7n] };
  const none = { evidence: 'none', evidence_link_log_ids: [] };
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    const auth = PINNED[platform].claimAuth;
    expect(rules.claimAuth, platform).toBe(auth);
    expect(evidence(platform, evidenceLog(platform), 'active'), platform).toEqual(
      auth === null ? none : strong,
    );
    // Control: the same row without no_rebate counts on every platform.
    expect(evidence(platform, evidenceLog(platform, false), 'active'), platform).toEqual(strong);
    expect(evidence(platform, evidenceLog(platform), null), platform).toEqual(none);
    expect(evidence(platform, evidenceLog(platform), 'released'), platform).toEqual(none);
  }
  for (const platform of UNREGISTERED) {
    expect(evidence(platform, evidenceLog(platform), 'active'), platform).toEqual(none);
    expect(evidence(platform, evidenceLog(platform, false), 'active'), platform).toEqual(strong);
  }
});
