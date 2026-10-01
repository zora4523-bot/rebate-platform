import { describe, expect, it } from 'vitest';
import { UsageError, parseArgs, result, skipped } from './cli.ts';

describe('parseArgs', () => {
  const spec = { values: ['base', 'cwd'], flags: ['json'] };

  it('parses value options in both forms, flags and positionals', () => {
    const args = parseArgs(['--base', 'main', '--cwd=/a b/c', '--json', 'x', 'y'], spec);
    expect(args.values.get('base')).toBe('main');
    expect(args.values.get('cwd')).toBe('/a b/c');
    expect(args.flags.has('json')).toBe(true);
    expect(args.rest).toEqual(['x', 'y']);
  });

  it('treats everything after "--" as positional', () => {
    expect(parseArgs(['--json', '--', '--base', 'x'], spec).rest).toEqual(['--base', 'x']);
  });

  it('rejects unknown options, missing values and values on flags', () => {
    expect(() => parseArgs(['--nope'], spec)).toThrow(UsageError);
    expect(() => parseArgs(['--base'], spec)).toThrow(/needs a value/);
    expect(() => parseArgs(['--json=1'], spec)).toThrow(/does not take a value/);
  });
});

describe('result helpers', () => {
  it('derives the status from the problems', () => {
    expect(result('x', []).status).toBe('pass');
    expect(result('x', ['bad']).status).toBe('fail');
    expect(skipped('x', 'why')).toEqual({
      name: 'x',
      status: 'skip',
      problems: [],
      notices: ['why'],
    });
  });
});
