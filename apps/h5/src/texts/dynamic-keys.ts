// 动态文案键的登记（F1-01t）。H5 源码里以模板或拼接方式拼出的字典键，必须被这里的某个模式覆盖；
// 构建期收集器（apps/h5/build/trim-texts.ts）按这些模式与源码中的字面键，从契约字典里挑出打进包的键，
// 没被覆盖的动态键让构建失败。模式里的 `*` 匹配任意非空片段（可含点号）。
// 登记的是键族（前缀 / 模式），不是现有键的快照：契约往这些族补键时自动进包。
// 本文件只由收集器静态读取：值必须是字符串字面量组成的数组字面量。
export const H5_TEXT_KEY_PATTERNS = [
  // 余额流水名称与说明（pages/ledger/format.ts）：ledger_type.<CODE>.name / name_<sub> / hint_<sub> / hint。
  'ledger_type.*',
  // 找回记录状态与说明（pages/find-order/records-model.ts）。
  'claim.records.status.*',
  'claim.records.desc.*',
  // 找回驳回原因（pages/find-order/records-model.ts）。
  'claim_reject_reason.*.title',
  // 错误码文案 error.<code> 与 error.30202.<reason>（pages/find-order/submit.ts）。
  'error.*',
] as const;
