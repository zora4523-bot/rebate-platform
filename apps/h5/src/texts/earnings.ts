// 收益看板页（F1-12a）的文案。earnings.* 先取契约字典 contracts/texts.default.json（经 t()），
// 字典还没有的键用这里的包内默认：「全部」胶囊与问号按钮的读屏名取自规格 design/specs/app-earnings.md
// 画板原文（08 尚无字典键，由编排者登记补键）；字典补上后以字典为准。
import { t } from '../shared/texts.ts';

/** 字典缺键时的包内默认，键名与字典同形。 */
const earningsDefaults: Readonly<Record<string, string>> = {
  'earnings.platform.all': '全部',
  'earnings.period.label': '统计期间',
  'earnings.platform.label': '平台筛选',
  'earnings.metric.note_label': '{name}说明',
};

/** 字典有值用字典（含占位符填充），否则用包内默认；都没有返回空串。 */
export function earningsText(key: string, params: Readonly<Record<string, string>> = {}): string {
  const contract = t(key, params);
  if (contract !== '') return contract;
  const local = Object.hasOwn(earningsDefaults, key) ? earningsDefaults[key] : undefined;
  if (local === undefined) return '';
  return local.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? (params[name] ?? whole) : whole,
  );
}

/** 08 没有字典键的页面文字（编排者登记补键）。 */
export const earningsTexts = {
  /** 统计时点的列表写法（BR-TEXT-11）。 */
  today: '今天',
  yesterday: '昨天',
  /** 指标说明弹层的关闭与确认按钮（画板 EarningsMetricNote-v2）。 */
  close: '关闭',
  confirm: '知道了',
  /** 已有数据时下拉刷新进行中。 */
  refreshing: '正在刷新…',
} as const;
