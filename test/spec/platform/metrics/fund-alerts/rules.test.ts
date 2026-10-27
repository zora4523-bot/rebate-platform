// B1-01zzp: infra/monitoring/rules/couli-fund.yaml gains the two auto-payout daily cap alerts
// (规划/02 §13 资金类「自动到账日合计触顶」, night-pushed: labels fund 'true'; 规划/08 BR-WDR-30 「当日自动
// 到账合计达到 platform_daily_max_fen 的 80% 时告警财务」): one at 80 %, one at 100 % (触顶), both
// "reaching" the share, i.e. total / cap >= share. Each reads the worker's two gauges, total divided
// by cap per app_id; the common 5m. Rules are found by the metrics their expressions read, not by
// alert name. Parsed with the repository's strict YAML subset reader (tools/lib/yaml-lite).
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../../tools/lib/yaml-lite.ts';
import { ROOT } from '../kit.ts';
import { AUTO_METRIC_NAMES, CAP_METRIC, TOTAL_METRIC } from './kit.ts';

const FUND_RULES = new URL('infra/monitoring/rules/couli-fund.yaml', ROOT);
const BASE_RULES = new URL('infra/monitoring/rules/couli.yaml', ROOT);

interface Rule {
  readonly alert: string;
  readonly expr: string;
  readonly for: string;
  readonly labels: Readonly<Record<string, unknown>>;
  readonly summary: unknown;
}

function record(value: unknown, where: string): Record<string, unknown> {
  expect(value, `${where} is a mapping`).toEqual(expect.any(Object));
  expect(Array.isArray(value), `${where} is a mapping`).toBe(false);
  return value as Record<string, unknown>;
}

function rules(file: URL): Rule[] {
  expect(existsSync(file), `${file.pathname} exists`).toBe(true);
  const doc = record(parseYamlLite(readFileSync(file, 'utf8')), 'document');
  expect(Array.isArray(doc['groups']), 'groups is a list').toBe(true);
  const out: Rule[] = [];
  (doc['groups'] as unknown[]).forEach((value, g) => {
    const group = record(value, `groups[${g}]`);
    expect(Array.isArray(group['rules']), `groups[${g}].rules is a list`).toBe(true);
    (group['rules'] as unknown[]).forEach((item, r) => {
      const where = `groups[${g}].rules[${r}]`;
      const rule = record(item, where);
      expect(rule['alert'], `${where}.alert`).toEqual(expect.any(String));
      expect(rule['expr'], `${where}.expr`).toEqual(expect.any(String));
      expect(rule['for'], `${where}.for`).toEqual(expect.any(String));
      out.push({
        alert: rule['alert'] as string,
        expr: (rule['expr'] as string).trim(),
        for: rule['for'] as string,
        labels: record(rule['labels'], `${where}.labels`),
        summary: record(rule['annotations'], `${where}.annotations`)['summary'],
      });
    });
  });
  return out;
}

/** Every rule whose expression reads `metric` (a whole metric name). */
function readers(all: readonly Rule[], metric: string): Rule[] {
  return all.filter((rule) => new RegExp(`\\b${metric}\\b`).test(rule.expr));
}

/**
 * `total / cap >= t` (optionally parenthesised, `on(app_id)` matching, or `* 100` with t in
 * percent), selectors without matchers allowed only as `{}`. Returns the share t as a fraction.
 */
const RATIO = new RegExp(
  `^\\(?\\s*${TOTAL_METRIC}(\\{\\})?\\s*/\\s*(on\\s*\\(\\s*app_id\\s*\\)\\s*)?${CAP_METRIC}(\\{\\})?` +
    `\\s*\\)?\\s*(\\*\\s*100\\s*)?>=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*$`,
);

function shareOf(rule: Rule): number {
  const match = RATIO.exec(rule.expr);
  expect(match, `${rule.alert}: expr is total / cap >= share, got ${rule.expr}`).not.toBeNull();
  const threshold = Number(match![5]);
  return match![4] === undefined ? threshold : threshold / 100;
}

/** Whether `total / cap >= share` holds as Prometheus evaluates it (0 / 0 is NaN: never). */
function fires(share: number, totalFen: number, capFen: number): boolean {
  return totalFen / capFen >= share;
}

function capRules(): Rule[] {
  const all = rules(FUND_RULES);
  const found = readers(all, TOTAL_METRIC);
  expect(
    found.map((rule) => rule.alert),
    `exactly two rules read ${TOTAL_METRIC} (80 % and 100 %)`,
  ).toHaveLength(2);
  return found;
}

it('[AC-B1-01zzp#1] couli-fund.yaml 两条自动到账日合计告警：都读 合计 / 上限（按 app_id 相除），阈值分别为「达到」80% 与 100%（>=，不是 >），labels.fund 为字符串 "true"、severity 为 critical / warning、for 通用 5m、有 summary', () => {
  const found = capRules();
  const shares = found.map(shareOf).sort((x, y) => x - y);
  expect(shares).toEqual([0.8, 1]);
  for (const rule of found) {
    expect(rule.expr, rule.alert).toMatch(new RegExp(`\\b${CAP_METRIC}\\b`));
    expect(rule.labels['fund'], `${rule.alert}.labels.fund`).toBe('true');
    expect(['critical', 'warning'], `${rule.alert}.labels.severity`).toContain(
      rule.labels['severity'],
    );
    expect(rule.for, `${rule.alert}.for`).toBe('5m');
    expect(rule.alert, 'alert name').toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    expect(rule.summary, `${rule.alert}.annotations.summary`).toEqual(expect.any(String));
    expect((rule.summary as string).trim().length, `${rule.alert} summary`).toBeGreaterThan(0);
  }
  const names = [...rules(FUND_RULES), ...rules(BASE_RULES)].map((rule) => rule.alert);
  expect(new Set(names).size, 'alert names unique across both files').toBe(names.length);
});

it('[AC-B1-01zzp#2] 阈值边界：上限 200000 分时合计 159999 两条都不触发、160000 只触发 80%、199999 仍只 80%、200000 两条都触发；上限 0 且合计 0（不自动到账）不触发', () => {
  const found = capRules();
  const byShare = new Map(found.map((rule) => [shareOf(rule), rule] as const));
  const near = byShare.get(0.8);
  const full = byShare.get(1);
  expect(near, '80 % rule').toBeDefined();
  expect(full, '100 % rule').toBeDefined();
  const fired = (totalFen: number, capFen: number) =>
    [near!, full!].filter((rule) => fires(shareOf(rule), totalFen, capFen)).map((r) => r.alert);
  expect(fired(159_999, 200_000)).toEqual([]);
  expect(fired(160_000, 200_000)).toEqual([near!.alert]);
  expect(fired(199_999, 200_000)).toEqual([near!.alert]);
  expect(fired(200_000, 200_000)).toEqual([near!.alert, full!.alert]);
  expect(fired(0, 0)).toEqual([]);
  // The two are distinct alerts, so the 100 % one is not swallowed by the 80 % one.
  expect(near!.alert).not.toBe(full!.alert);
});

it('[AC-B1-01zzp#3] 上限 gauge 只在这两条的除法里读；规则读的 couli_auto_payout_* 都是 worker 导出的两个名字；couli.yaml 不读它们（夜间只推资金类）', () => {
  const all = rules(FUND_RULES);
  const capReaders = readers(all, CAP_METRIC)
    .map((rule) => rule.alert)
    .sort();
  const totalReaders = readers(all, TOTAL_METRIC)
    .map((rule) => rule.alert)
    .sort();
  expect(totalReaders).toHaveLength(2);
  expect(capReaders).toEqual(totalReaders);
  const named = all.flatMap((rule) => rule.expr.match(/\bcouli_auto_payout_[a-z0-9_]+/g) ?? []);
  expect(named.filter((name) => !AUTO_METRIC_NAMES.includes(name))).toEqual([]);
  const base = rules(BASE_RULES).flatMap((rule) => rule.expr.match(/\bcouli_[a-z0-9_]+/g) ?? []);
  expect(base.filter((name) => AUTO_METRIC_NAMES.includes(name))).toEqual([]);
});
