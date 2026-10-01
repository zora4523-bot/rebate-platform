import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../lib/paths.ts';
import { parseAllow, parseTerms, scanText } from './banned-terms.ts';

const guardDir = join(repoRoot(), 'tools', 'guard');
const terms = parseTerms(readFileSync(join(guardDir, 'banned-terms.txt'), 'utf8'));
const allow = parseAllow(readFileSync(join(guardDir, 'banned-terms.allow.txt'), 'utf8'));

function hitTerms(file: string, text: string, withAllow = true): string[] {
  return scanText(file, text, terms, withAllow ? allow : []).map((h) => `${h.line}:${h.term}`);
}

describe('banned-terms.txt', () => {
  it('lists the names superseded by ADR-0001 §3', () => {
    expect(terms.map((t) => `${t.wholeWord ? 'word:' : ''}${t.text}`)).toEqual([
      'Prisma',
      'BullMQ',
      'Supertest',
      'react-vant',
      'X-Clock',
      'outbox',
      'word:relay',
      'queue Redis',
    ]);
  });
});

describe('scanText', () => {
  it('matches case-insensitively and reports each term per line', () => {
    expect(
      hitTerms(
        'brief.md',
        ['用 prisma 读库', '没有问题的一行', 'BullMQ 加 OUTBOX 表', '请求头 x-clock'].join('\n'),
      ),
    ).toEqual(['1:Prisma', '3:BullMQ', '3:outbox', '4:X-Clock']);
  });

  it('matches "relay" only as a whole word', () => {
    expect(hitTerms('brief.md', 'the relay process')).toEqual(['1:relay']);
    expect(hitTerms('brief.md', '启动relay进程')).toEqual(['1:relay']);
    expect(hitTerms('brief.md', 'relayed, relays_table, prelay')).toEqual([]);
  });

  it('matches multi-word terms across any whitespace and substrings of identifiers', () => {
    expect(hitTerms('brief.md', '独立  queue   redis 实例')).toEqual(['1:queue Redis']);
    expect(hitTerms('brief.md', 'outbox_events 表')).toEqual(['1:outbox']);
    expect(hitTerms('brief.md', 'queue 与 Redis 分开写')).toEqual([]);
  });

  it('gives an excerpt around the match', () => {
    const [hit] = scanText(
      'brief.md',
      `${'前'.repeat(60)} Supertest ${'后'.repeat(60)}`,
      terms,
      [],
    );
    expect(hit?.excerpt).toContain('Supertest');
    expect(hit?.excerpt.length).toBeLessThan(80);
  });
});

describe('allow list', () => {
  const prohibition =
    '| 数据访问 | Kysely + pg | 不要引入 Prisma 或第二种数据访问方式；不要手改生成的类型 |';

  it('ignores a line only for the listed file', () => {
    expect(hitTerms('规划/02_系统架构.md', prohibition, false)).toEqual(['1:Prisma']);
    expect(hitTerms('规划/02_系统架构.md', prohibition)).toEqual([]);
    expect(hitTerms('规划/05_里程碑与任务拆分.md', prohibition)).toEqual(['1:Prisma']);
    expect(hitTerms('/somewhere/couli-runs/B2-03/brief.md', prohibition)).toEqual(['1:Prisma']);
  });

  it('does not excuse other lines of the same file', () => {
    expect(hitTerms('规划/02_系统架构.md', `${prohibition}\n数据访问层用 Prisma`)).toEqual([
      '2:Prisma',
    ]);
  });

  it('holds only narrow entries for 规划/02 and 规划/08 13', () => {
    expect(allow.map((e) => e.glob)).toEqual([
      '规划/02_系统架构.md',
      '规划/02_系统架构.md',
      '规划/02_系统架构.md',
      '规划/08_业务规则/13_命名与编码对照.md',
      '规划/08_业务规则/13_命名与编码对照.md',
      '规划/08_业务规则/13_命名与编码对照.md',
    ]);
    for (const entry of allow) expect(entry.re.source.length).toBeGreaterThan(15);
  });
});

describe('parsers', () => {
  it('skips comments and blank lines in the term list', () => {
    expect(parseTerms('# c\n\nFoo\n word:bar \n').map((t) => [t.text, t.wholeWord])).toEqual([
      ['Foo', false],
      ['bar', true],
    ]);
    expect(() => parseTerms('word:\n')).toThrow(/empty term/);
  });

  it('rejects malformed allow lines', () => {
    expect(() => parseAllow('docs/** no-tab-here\n')).toThrow(/line 1 must be/);
    expect(() => parseAllow('docs/**\t(unclosed\n')).toThrow(/line 1/);
    expect(parseAllow('# comment\n\ndocs/**\tfoo.*bar\n')).toHaveLength(1);
  });
});
