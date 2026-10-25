// B1-01zzh brief B.4: infra/monitoring/rules/couli.yaml, a Prometheus rule file (groups[].rules[];
// each rule: alert / expr / for / labels.severity / annotations.summary). Rules are found by the
// metrics their expressions read, not by alert name. Thresholds: 规划/02 §11, §13 (evt oldest due
// created >60 s, sync watermark lag >30 min, generic 5-minute granularity), ADR-0001 §4.2 #17
// (Redis memory >70%). Parsed with the repository's strict YAML subset reader (tools/lib/yaml-lite).
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { METRIC_NAMES, ROOT } from './kit.ts';

const RULES = new URL('infra/monitoring/rules/couli.yaml', ROOT);

interface Rule {
  readonly alert: string;
  readonly expr: string;
  readonly for: string;
  readonly severity: unknown;
  readonly summary: unknown;
}

function record(value: unknown, where: string): Record<string, unknown> {
  expect(value, `${where} is a mapping`).toEqual(expect.any(Object));
  expect(Array.isArray(value), `${where} is a mapping`).toBe(false);
  return value as Record<string, unknown>;
}

function rules(): Rule[] {
  expect(existsSync(RULES), 'infra/monitoring/rules/couli.yaml exists').toBe(true);
  const doc = record(parseYamlLite(readFileSync(RULES, 'utf8')), 'document');
  expect(Array.isArray(doc['groups']), 'groups is a list').toBe(true);
  const groups = doc['groups'] as unknown[];
  expect(groups.length).toBeGreaterThan(0);
  const out: Rule[] = [];
  groups.forEach((value, g) => {
    const group = record(value, `groups[${g}]`);
    expect(group['name'], `groups[${g}].name`).toEqual(expect.any(String));
    expect(Array.isArray(group['rules']), `groups[${g}].rules is a list`).toBe(true);
    (group['rules'] as unknown[]).forEach((item, r) => {
      const where = `groups[${g}].rules[${r}]`;
      const rule = record(item, where);
      expect(rule['alert'], `${where}.alert`).toEqual(expect.any(String));
      expect(rule['expr'], `${where}.expr`).toEqual(expect.any(String));
      expect(rule['for'], `${where}.for`).toEqual(expect.any(String));
      const labels = record(rule['labels'], `${where}.labels`);
      const annotations = record(rule['annotations'], `${where}.annotations`);
      out.push({
        alert: rule['alert'] as string,
        expr: (rule['expr'] as string).trim(),
        for: rule['for'] as string,
        severity: labels['severity'],
        summary: annotations['summary'],
      });
    });
  });
  return out;
}

function seconds(duration: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(duration);
  expect(match, `duration ${JSON.stringify(duration)}`).not.toBeNull();
  const n = Number(match![1]);
  return { ms: n / 1000, s: n, m: n * 60, h: n * 3600 }[match![2] as 'ms' | 's' | 'm' | 'h'];
}

/** The one rule whose expression reads `metric` (a whole metric name). */
function ruleOf(all: readonly Rule[], metric: string): Rule {
  const found = all.filter((rule) => new RegExp(`\\b${metric}\\b`).test(rule.expr));
  expect(
    found.map((rule) => rule.alert),
    `exactly one rule reads ${metric}`,
  ).toHaveLength(1);
  return found[0]!;
}

/** The expression ends with `> threshold` (strictly greater). */
function expectAbove(rule: Rule, threshold: string): void {
  const escaped = threshold.replace('.', '\\.');
  expect(rule.expr, rule.alert).toMatch(new RegExp(`(^|[^<>=!])>\\s*${escaped}\\s*$`));
}

it('[AC-B1-01zzh#13] 规则文件结构：每条规则有唯一 alert 名、expr、for、severity（critical / warning）与 summary', () => {
  const all = rules();
  expect(all.length).toBeGreaterThanOrEqual(7);
  expect(new Set(all.map((rule) => rule.alert)).size).toBe(all.length);
  for (const rule of all) {
    expect(rule.alert, 'alert name').toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    expect(['critical', 'warning'], `${rule.alert}.labels.severity`).toContain(rule.severity);
    expect(rule.summary, `${rule.alert}.annotations.summary`).toEqual(expect.any(String));
    expect((rule.summary as string).trim().length, `${rule.alert} summary`).toBeGreaterThan(0);
    expect(seconds(rule.for), `${rule.alert}.for`).toBeGreaterThan(0);
  }
  // Every queue / evt / sync metric an expression names is one the worker exports.
  const named = all.flatMap((rule) => rule.expr.match(/\bcouli_(queue|evt|sync)_[a-z_]+/g) ?? []);
  expect(named.filter((name) => !METRIC_NAMES.includes(name))).toEqual([]);
});

it('[AC-B1-01zzh#14] 队列与同步告警：任一队列 failed>0、死信>0（通用 5m）；evt 最老已到期 created >60 秒（for ≤1m）、水位延迟 >1800 秒（for ≤5m）', () => {
  const all = rules();
  const failed = ruleOf(all, 'couli_queue_failed_jobs');
  expectAbove(failed, '0');
  expect(failed.for).toBe('5m');
  const dead = ruleOf(all, 'couli_queue_dead_letters');
  expectAbove(dead, '0');
  expect(dead.for).toBe('5m');
  const evt = ruleOf(all, 'couli_evt_oldest_due_created_age_seconds');
  expectAbove(evt, '60');
  // A 60-second threshold held for 5m would only fire after six minutes: the for stays ≤ 1m.
  expect(seconds(evt.for)).toBeLessThanOrEqual(60);
  const lag = ruleOf(all, 'couli_sync_watermark_lag_seconds');
  expectAbove(lag, '1800');
  // Either the generic 5m or a shorter for (brief B.4); never longer than the 5-minute granularity.
  expect(seconds(lag.for)).toBeLessThanOrEqual(300);
});

it('[AC-B1-01zzh#15] Redis 三条：不可达（redis_up == 0）、内存使用率 >70%、拒绝写入，均为通用 5m', () => {
  const all = rules();
  const down = ruleOf(all, 'redis_up');
  expect(down.expr).toMatch(/^redis_up(\{[^}]*\})?\s*==\s*0$/);
  expect(down.for).toBe('5m');

  const memory = ruleOf(all, 'redis_memory_used_bytes');
  expect(memory.expr).toMatch(/redis_memory_used_bytes\s*\/\s*redis_memory_max_bytes/);
  expect(memory.expr).toMatch(/(^|[^<>=!])>\s*(0\.70?|70)\s*$/);
  expect(memory.for).toBe('5m');

  // redis_exporter's refusal signals, one of which the rule names (brief B.4: choose and state it).
  const refusal = all.filter((rule) =>
    /\b(redis_rejected_connections_total|redis_errors_total|redis_rdb_last_bgsave_status)\b/.test(
      rule.expr,
    ),
  );
  expect(refusal.map((rule) => rule.alert)).toHaveLength(1);
  expect(refusal[0]!.expr).toMatch(/(^|[^<>=!])(>|==)\s*0\s*$/);
  expect(refusal[0]!.for).toBe('5m');
  expect(new Set([down.alert, memory.alert, refusal[0]!.alert]).size).toBe(3);
});

// be-tc-1 (D10-355 ③, B1-01zzh spec-test S2): #15 accepts `> 0` or `== 0` for whichever refusal
// signal is chosen, and `> 70` for the memory ratio without a percentage scale. Here the direction
// is bound to the metric: a counter only counts up, so it is compared after increase() / rate()
// with `> 0` (a bare counter `> 0` would stay true forever after one error; `== 0` would fire while
// healthy); redis_rdb_last_bgsave_status is 1 when the last save succeeded, so it fires on `== 0`;
// the used / max ratio is a fraction, so 70% is `> 0.7`, and `> 70` only with an explicit `* 100`.
const REDIS_COUNTER = /\bredis_[a-z_]+_total\b/g;
const WRAPPED = /\b(increase|rate)\(\s*redis_[a-z_]+_total(\{[^}]*\})?\[\d+(ms|s|m|h)\]\s*\)/g;
const RATE_OF = /\b(increase|rate)\(\s*(redis_rejected_connections_total|redis_errors_total)\b/;
const BGSAVE_RATE = /\b(increase|rate)\(\s*redis_rdb_last_bgsave_status\b/;

it('[AC-B1-01zzh#16] Redis 规则比较方向与指标绑定：计数器只在 increase()/rate()（带区间）内读且拒写告警以 > 0 触发；用 redis_rdb_last_bgsave_status 则 == 0；内存比率只接受 > 0.7（明确 * 100 时 > 70）', () => {
  const all = rules();

  // Every Redis counter any rule reads sits inside increase(...[range]) or rate(...[range]).
  for (const rule of all) {
    const bare = rule.expr.match(REDIS_COUNTER) ?? [];
    const wrapped = rule.expr.match(WRAPPED) ?? [];
    const why = `${rule.alert}: Redis counters only through increase()/rate()`;
    expect(wrapped.length, why).toBe(bare.length);
  }

  const refusal = all.filter((rule) =>
    /\b(redis_rejected_connections_total|redis_errors_total|redis_rdb_last_bgsave_status)\b/.test(
      rule.expr,
    ),
  );
  expect(refusal.map((rule) => rule.alert)).toHaveLength(1);
  const { expr, alert } = refusal[0]!;
  if (/\bredis_rdb_last_bgsave_status\b/.test(expr)) {
    // A gauge (1 = last save ok): read directly, never through increase()/rate(), fires on 0.
    expect(expr, alert).not.toMatch(BGSAVE_RATE);
    expect(expr, alert).toMatch(/==\s*0\s*$/);
  } else {
    expect(expr, alert).toMatch(RATE_OF);
    expect(expr, alert).toMatch(/(^|[^<>=!])>\s*0\s*$/);
    expect(expr, alert).not.toMatch(/==\s*0\s*$/);
  }

  const memory = ruleOf(all, 'redis_memory_used_bytes');
  const scaled = /\*\s*100(?![0-9.])/.test(memory.expr);
  const want = scaled ? /(^|[^<>=!])>\s*70\s*$/ : /(^|[^<>=!])>\s*0\.70?\s*$/;
  expect(memory.expr, memory.alert).toMatch(want);
});
