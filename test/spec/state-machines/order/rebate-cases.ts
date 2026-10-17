// BR-FUND-01 的结构 oracle；不从生成物或 YAML 推导允许的起点、终点。
// R3/R3a 的上下文分流由调用方负责，二参数 API 不擅自求值守卫。
// R12 的目标只约束为非终态的未入账状态，不在本任务展开 BR-FUND-22 的守卫测试。
export interface RebateRule {
  id: string;
  from: (string | null)[];
  targets: string[];
  events?: string[];
  guardTerms?: string[];
  words?: string[];
}

export const REBATE_RULES: RebateRule[] = [
  { id: 'R1', from: [null], targets: ['UNATTRIBUTED'], words: ['入库未归因'] },
  { id: 'R2', from: [null], targets: ['ESTIMATED'], words: ['入库已归因'] },
  {
    id: 'R3',
    from: ['UNATTRIBUTED'],
    targets: ['ESTIMATED', 'WAITING'],
    events: ['CLAIM_APPROVED', 'ADMIN_REASSIGN'],
    guardTerms: ['locked=false'],
  },
  {
    id: 'R3a',
    from: ['UNATTRIBUTED'],
    targets: ['ESTIMATED', 'WAITING'],
    events: ['SYNC_ATTRIBUTED'],
    guardTerms: ['locked=false'],
  },
  {
    id: 'R3b',
    from: ['VOID'],
    targets: ['same'],
    events: ['ADMIN_REASSIGN', 'SYNC_ATTRIBUTED'],
    guardTerms: ['locked=false'],
  },
  {
    id: 'R4',
    from: ['ESTIMATED'],
    targets: ['WAITING'],
    guardTerms: ['received_at', 'BR-FUND-02'],
    words: ['platform_status', 'RECEIVED', 'SETTLED'],
  },
  {
    id: 'R5',
    from: ['WAITING'],
    targets: ['CREDITED'],
    events: ['SETTLE_BATCH_CREDIT'],
    guardTerms: ['BR-FUND-04', '④', '⑦'],
  },
  {
    id: 'R5a',
    from: ['CREDITED'],
    targets: ['same'],
    events: ['BENEFICIARY_RELEASE'],
    guardTerms: ['BR-FUND-04', '⑫', 'rights_pending=false', 'seq', '归属快照', '未完成'],
  },
  {
    id: 'R6',
    from: ['UNATTRIBUTED', 'ESTIMATED', 'WAITING'],
    targets: ['VOID'],
    guardTerms: ['DEPOSIT_PAID', 'null', 'BR-FUND-07'],
    words: ['整单失效', '全额维权', '处罚', '黑名单', 'B_est'],
  },
  {
    id: 'R7',
    from: ['ESTIMATED', 'WAITING'],
    targets: ['same'],
    guardTerms: ['null'],
    words: ['部分退款', '部分维权', '佣金变化'],
  },
  {
    id: 'R8',
    from: ['CREDITED'],
    targets: ['CLAWED_BACK'],
    words: ['BLACKLIST_CONFIRMED', '结算后退款或失效', '有效联盟佣金'],
  },
  {
    id: 'R9',
    from: ['CREDITED'],
    targets: ['same'],
    guardTerms: ['新基数大于 0', '新旧基数都为 0', '有效联盟佣金大于 0'],
    words: ['部分退款', '部分维权'],
  },
  {
    id: 'R9b',
    from: ['CREDITED'],
    targets: ['same'],
    words: ['结算记录未变而预估佣金变化'],
  },
  {
    id: 'R10',
    from: ['CREDITED'],
    targets: ['same'],
    guardTerms: ['BR-FUND-09', '新基数大于 0', '新旧基数都为 0'],
    words: ['负差', '正差补差候选获批'],
  },
  {
    id: 'R11',
    from: ['ESTIMATED', 'WAITING'],
    targets: ['same'],
    events: ['HOLD', 'UNHOLD'],
    guardTerms: ['BR-FUND-06'],
  },
  {
    id: 'R12',
    from: ['VOID'],
    targets: ['UNATTRIBUTED', 'ESTIMATED', 'WAITING'],
    events: ['ADMIN_RESTORE'],
    guardTerms: ['BR-FUND-22'],
  },
  {
    id: 'R13',
    from: ['CLAWED_BACK'],
    targets: ['CREDITED'],
    events: ['ADMIN_RESTORE'],
    guardTerms: ['BR-FUND-22'],
  },
  {
    id: 'R14',
    from: ['ESTIMATED', 'WAITING', 'CREDITED'],
    targets: ['same'],
    events: ['ADMIN_REASSIGN'],
    guardTerms: ['step-up'],
  },
];
