// Board copy (AdmPlatformIconUpload*, AdmPlatformIconSaved, AdmPlatformIconSourceRegister;
// decisions-r20 §3), shared by the jsdom, browser and source tests; no imports (the source test
// runs in plain Node). The size limit is the default 200KB (orchestrator: no config read API yet).
export const COPY = {
  requirements: '文件要求',
  rule1:
    '支持 SVG，或边长不小于 512px 的透明底 PNG；单张不超过 200KB（配置中心 content.platform_icon.max_bytes，当前值）。',
  rule2:
    'SVG 会先保真转换、再按白名单清洗，去掉脚本、外部引用等不允许的内容；无法保真转换的整份拒收，请换一份官方 SVG 或改传 PNG。',
  rule3: '上传只生成清洗后的预览，不会生效；存为版本、发布是后面两步。',
  noFile: '未选择文件 · SVG 或 PNG',
  choose: '选择文件',
  upload: '上传并预览',
  uploading: '正在上传并清洗…',
  discard: '取消即丢弃这次上传，不会生成预览或版本。',
  cleanedTag: '已清洗',
  reselect: '重新选择文件',
  sanitizedTitle: '已清除不安全内容',
  sanitizedBody:
    '清洗后的文件与原文件不同：已按白名单去掉不允许的元素或属性。请对照下方预览，确认没有变形、裁切或改色后再保存。',
  previewTitle: '预览（清洗后的文件，与内置图并排）',
  confirm: '我已核对清洗后的预览',
  confirmHint: '清洗后与原文件不同，勾选后才能保存',
  sourceSection: '来源登记',
  sourceLabel: /^来源页地址（发布前必填）/,
  dateLabel: /^下载日期（发布前必填）/,
  sourceHelp: '官方品牌或素材下载页的地址',
  draftNote: '两项缺任一项也能保存，但只是草稿，不能发布；可在版本历史里补登。',
  saveNote: (n: number) => `保存为版本 ${n}，不会立即生效；发布在版本历史里操作。`,
  save: '存为版本',
  failedTag: '未通过',
  notUploaded: '文件没有上传成功，没有生成预览，也没有存为版本。',
  formatInvalid: '请上传 SVG，或边长不小于 512px 的透明底 PNG',
  tooLarge: '文件超过大小上限（当前 200KB）',
  unconvertible: '请换一份不含样式表或外部引用的官方 SVG，或改传 PNG',
  uploadExpired: '上传已失效，请重新上传',
  unconfirmed: '已清除不安全内容，请确认预览后再保存',
  unknownKey: '没有这个平台标识',
  saved: (n: number) => `已存为版本 ${n}。`,
  savedPublishable: (n: number) =>
    `已存为版本 ${n}。还没有发布，App 与 H5 仍显示内置图；核对预览后点【发布】。`,
  registerNote: (n: number) =>
    `只能给从未发布过的版本登记或改正；两项都登记后，版本 ${n} 变为可发布。`,
  saveRegister: '保存登记',
  versionNotEditable: '这个版本已发布过或不存在，来源登记不能再改；请刷新版本历史',
  refreshHistory: '刷新版本历史',
} as const;
