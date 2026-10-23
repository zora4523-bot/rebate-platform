// F1-02zzi / D10-204: synthetic defaults only; CT-16 owns the actual bundled keys.
import type { FundTermKeys } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';

export const CONSENT_DEFAULTS = {
  'real_name.consent.title': '测试同意弹层标题',
  'real_name.consent.point.1': '测试同意弹层说明',
  'real_name.consent.agree': '测试同意按钮',
  'real_name.consent.body': '测试正文占位，不作为法务文案',
};
export const CONSENT_KEYS = Object.keys(CONSENT_DEFAULTS);

export const ORDINARY_SPEC: FundTermKeys = {
  fund_terms: { prefixes: [], keys: [], notify_templates: [] },
  ordinary: {
    prefixes: [],
    keys: [
      ...CONSENT_KEYS,
      'real_name.consentx',
      'real_name.consentx.title',
      'real_name.consent',
      'real_name.other',
      'privacy.btn.agree',
      'perm.btn.continue',
    ],
    notify_templates: [],
  },
  exempt: [],
};
