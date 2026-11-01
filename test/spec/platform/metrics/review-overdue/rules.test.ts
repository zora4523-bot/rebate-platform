// B2-05o: infra/monitoring/rules/couli-fund.yaml gains the review overdue alert (BR-WDR-26「此时
// ① 告警财务（BR-WDR-24，不受夜间限制）」; BR-WDR-24「审核超时（BR-WDR-26）」). Exactly one rule reads
// couli_withdrawals_review_overdue, as `> 0` with the common 5m; labels fund 'true' (a string: fund
// alerts are pushed at night, 规划/02 §13) and severity critical. The expression is the comparison
// alone: no time-of-day condition keeps it quiet at night. couli.yaml (not night-pushed) never reads
// it. Rules are found by the metric their expressions read, not by alert name. Parsed with the
// repository's strict YAML subset reader (tools/lib/yaml-lite).
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../../tools/lib/yaml-lite.ts';
import { ROOT } from '../kit.ts';
import { OVERDUE_METRIC } from './kit.ts';

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

/** The one rule of couli-fund.yaml reading the overdue gauge. */
function overdueRule(): Rule {
  const found = readers(rules(FUND_RULES), OVERDUE_METRIC);
  expect(
    found.map((rule) => rule.alert),
    `exactly one rule of couli-fund.yaml reads ${OVERDUE_METRIC}`,
  ).toHaveLength(1);
  return found[0]!;
}

/**
 * `couli_withdrawals_review_overdue > 0` (optionally parenthesised, an empty `{}` selector allowed)
 * and nothing else: no other metric, no hour() / day_of_week() or other condition.
 */
const ABOVE_ZERO = new RegExp(`^\\(?\\s*${OVERDUE_METRIC}(\\{\\})?\\s*\\)?\\s*>\\s*0\\s*$`);

/** Whether `count > 0` holds as Prometheus evaluates the rule. */
function fires(count: number): boolean {
  return count > 0;
}

it('[AC-B2-05o#12] couli-fund.yaml 有且只有一条读 couli_withdrawals_review_overdue 的规则：expr 就是「> 0」（无夜间 / 时段条件）、for 5m、labels.fund 为字符串 "true"、severity critical、有 summary；alert 名在两个文件里唯一', () => {
  const rule = overdueRule();
  expect(rule.expr, `${rule.alert}: expr is ${OVERDUE_METRIC} > 0`).toMatch(ABOVE_ZERO);
  expect(rule.for, `${rule.alert}.for`).toBe('5m');
  expect(rule.labels['fund'], `${rule.alert}.labels.fund`).toBe('true');
  expect(rule.labels['severity'], `${rule.alert}.labels.severity`).toBe('critical');
  expect(rule.alert, 'alert name').toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
  expect(rule.summary, `${rule.alert}.annotations.summary`).toEqual(expect.any(String));
  expect((rule.summary as string).trim().length, `${rule.alert} summary`).toBeGreaterThan(0);
  const names = [...rules(FUND_RULES), ...rules(BASE_RULES)].map((r) => r.alert);
  expect(new Set(names).size, 'alert names unique across both files').toBe(names.length);
});

it('[AC-B2-05o#13] 阈值边界：0 张超时单不触发，1 张即触发（严格大于 0，不是 >= 0、不是 > 1）', () => {
  const rule = overdueRule();
  const match = ABOVE_ZERO.exec(rule.expr);
  expect(match, `${rule.alert}: expr is ${OVERDUE_METRIC} > 0, got ${rule.expr}`).not.toBeNull();
  expect(fires(0)).toBe(false);
  expect(fires(1)).toBe(true);
  // The comparison really is strict: neither >= nor a threshold other than 0.
  expect(rule.expr).not.toMatch(/>=/);
  expect(rule.expr).toMatch(/>\s*0\s*\)?\s*$/);
});

it('[AC-B2-05o#14] 规则读的 couli_withdrawals_review_* 只有 worker 导出的这一个名字；couli.yaml 不读它（夜间只推资金类）', () => {
  const rule = overdueRule();
  const all = rules(FUND_RULES);
  const named = all.flatMap((r) => r.expr.match(/\bcouli_withdrawals_review_[a-z0-9_]+/g) ?? []);
  expect(named.filter((name) => name !== OVERDUE_METRIC)).toEqual([]);
  expect(named.filter((name) => name === OVERDUE_METRIC)).toHaveLength(1);
  expect(rule.labels['fund'], rule.alert).toBe('true');
  const base = rules(BASE_RULES).flatMap((r) => r.expr.match(/\bcouli_[a-z0-9_]+/g) ?? []);
  expect(base.filter((name) => name.startsWith('couli_withdrawals_review_'))).toEqual([]);
});
