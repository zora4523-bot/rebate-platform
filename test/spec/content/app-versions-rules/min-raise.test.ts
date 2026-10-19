import { expect, it } from 'vitest';
import { isMinSupportedRaise } from '../../../../apps/api/src/modules/content/domain/app-versions/index.ts';

// Z4: reusable by F1-02zc step-up; no store state or other version columns involved.
it.each([
  { label: '新建并设置', before: null, after: '1.0.0', raised: true },
  { label: '新建零版本', before: null, after: '0.0.0', raised: true },
  { label: '新建不设', before: null, after: null, raised: false },
  { label: '空值首次设置', before: { min_supported_version: null }, after: '1.0.0', raised: true },
  { label: '空值保持', before: { min_supported_version: null }, after: null, raised: false },
  { label: '清空', before: { min_supported_version: '1.1.0' }, after: null, raised: false },
  { label: '相等', before: { min_supported_version: '1.1.0' }, after: '1.1.0', raised: false },
  { label: '降低', before: { min_supported_version: '1.1.0' }, after: '1.0.0', raised: false },
  { label: '提高补丁', before: { min_supported_version: '1.0.9' }, after: '1.0.10', raised: true },
  {
    label: '提高次版本',
    before: { min_supported_version: '1.9.0' },
    after: '1.10.0',
    raised: true,
  },
  {
    label: '降低次版本',
    before: { min_supported_version: '1.10.0' },
    after: '1.9.0',
    raised: false,
  },
  {
    label: '提高主版本',
    before: { min_supported_version: '1.99.99' },
    after: '2.0.0',
    raised: true,
  },
  {
    label: '降低主版本',
    before: { min_supported_version: '2.0.0' },
    after: '1.99.99',
    raised: false,
  },
  {
    label: '超安全整数仍精确',
    before: { min_supported_version: '9007199254740992.0.0' },
    after: '9007199254740993.0.0',
    raised: true,
  },
])('[AC-F1-02zb#46] $label 的 min 提高判定为 $raised', ({ before, after, raised }) => {
  expect(isMinSupportedRaise(before, { min_supported_version: after })).toBe(raised);
});
