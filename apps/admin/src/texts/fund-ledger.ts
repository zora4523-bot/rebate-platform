// 平台资金台账页文案（规格 admin-fund-dashboard.md「按日台账」，画板 AdmFundLedger；F1-08ga 只读段：
// 按日台账 = 资产快照视图，字段以契约 listAdminAssetSnapshots 为准）。平台名照现有后台页面先例
// （字典有键用字典，否则用这里的名字，再缺显示编码）。错误措辞按 contracts/error-codes.yaml。
export const fundLedgerTexts = {
  title: '平台资金台账',
  listTitle: '按日台账',
  dash: '—',
  loading: '正在加载按日台账…',
  empty: '暂无资产快照',
  emptyHint: '所选区间内没有写入快照的日子；快照每日凌晨生成，没写快照的日子不补行。',
  total: (total: number): string => `共 ${total} 天`,
  loadFailedTitle: '按日台账加载失败',
  loadFailedDescription: '网络错误或服务异常，点【重试】重新请求。',
  invalidTitle: '查询条件不正确',
  invalidDescription: '请核对快照日期区间后再查。',
  retryLoad: '重试',
  forbiddenTitle: '无权限查看平台资金台账',
  forbiddenDescription: '当前账号缺少资金查看权限点（fund.view），请联系超管勾选。',
  readOnlyNotice:
    '录入企业支付宝余额、录入联盟回款、台账概览与垫资水位、导出等功能尚未接入，接口定稿后开放；本页先提供按日台账只读查看。',
  snapshotNotice:
    '按日台账即每日资产快照：金额照快照原样显示，不在页面上重算；没写快照的日子没有行。',
  notComparable: '不可比',
  notComparableHint: '该日快照确认晚于时限，已收货待结算与预估合计不可与其他日子直接比较。',
  filter: {
    dateFrom: '快照日期起',
    dateTo: '快照日期止',
    datePlaceholder: 'YYYY-MM-DD',
    query: '查询',
    reset: '重置',
    dateInvalid: '日期写成 YYYY-MM-DD',
    dateRange: '起始日期不能晚于截止日期',
    serverInvalid: '日期格式或区间不正确（起始不能晚于截止）',
  },
  columns: {
    date: '快照日期',
    receivables: '已入账未回款',
    available: '可用余额合计',
    negative: '负余额合计',
    frozen: '冻结合计',
    waiting: '已收货待结算合计',
    estimated: '预估合计',
  },
  platforms: {
    taobao: '淘宝',
    jd: '京东',
    pdd: '拼多多',
    meituan: '美团',
    vip: '唯品会',
    douyin: '抖音',
    eleme: '饿了么',
    kuaishou: '快手',
  } as Readonly<Record<string, string>>,
} as const;
