// Renders the 分工 table of the root AGENTS.md from ops/risk-map.yaml (规划/11 §1.2).
import type { RiskMap } from './risk.ts';

export const TABLE_BEGIN = '<!-- risk-table:begin -->';
export const TABLE_END = '<!-- risk-table:end -->';

const NAMES: Record<string, string> = { codex: 'Codex', claude: 'Claude', none: '—' };

function who(value: string): string {
  return value
    .split('+')
    .map((part) => NAMES[part] ?? part)
    .join(' + ');
}

export function renderRiskTable(map: RiskMap): string {
  const rows = map.rules.map(
    (r) => `| \`${r.path}\` | ${who(r.impl)} | ${who(r.tester)} | ${who(r.review)} | ${r.risk} |`,
  );
  return [
    '| 路径 | 主实现 | 规则测试作者 | 对抗评审 | 风险级 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '| 其他（未列入的任何路径） | 见任务台账 | 见任务台账 | Claude + Codex | RV2 |',
  ].join('\n');
}

function markerPositions(text: string): { begin: number; end: number } {
  const begin = text.indexOf(TABLE_BEGIN);
  const end = text.indexOf(TABLE_END);
  if (begin === -1 || end === -1) {
    throw new Error(`AGENTS.md: markers "${TABLE_BEGIN}" and "${TABLE_END}" are required`);
  }
  if (
    end < begin ||
    text.indexOf(TABLE_BEGIN, begin + 1) !== -1 ||
    text.indexOf(TABLE_END, end + 1) !== -1
  ) {
    throw new Error('AGENTS.md: each risk-table marker must appear exactly once, begin before end');
  }
  return { begin, end };
}

/** The text between the markers, without surrounding blank lines. */
export function extractTable(text: string): string {
  const { begin, end } = markerPositions(text);
  return text.slice(begin + TABLE_BEGIN.length, end).trim();
}

/** Replaces the text between the markers with `table`, separated by blank lines. */
export function replaceTable(text: string, table: string): string {
  const { begin, end } = markerPositions(text);
  return `${text.slice(0, begin + TABLE_BEGIN.length)}\n\n${table}\n\n${text.slice(end)}`;
}
