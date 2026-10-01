import { describe, expect, it } from 'vitest';
import { lintSchema } from './schema-lint.ts';

const GOOD = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'line'],
        properties: {
          severity: { type: 'string', enum: ['S0', 'S1', 'S2'], description: 'see 规划/11 §3.1' },
          line: { type: 'integer' },
        },
      },
    },
  },
};

function clone(): typeof GOOD {
  return structuredClone(GOOD);
}

describe('lintSchema', () => {
  it('accepts a strict schema', () => {
    expect(lintSchema(GOOD, 'review.schema.json')).toEqual([]);
  });

  it('requires additionalProperties:false on every object, also inside items', () => {
    const top = clone() as Record<string, unknown>;
    delete top['additionalProperties'];
    expect(lintSchema(top, 's')).toEqual(['s: $: object must set "additionalProperties": false']);

    const nested = clone();
    (nested.properties.findings.items as Record<string, unknown>)['additionalProperties'] = true;
    expect(lintSchema(nested, 's')).toEqual([
      's: $.properties.findings.items: object must set "additionalProperties": false',
    ]);
  });

  it('requires every property to be listed in required, and nothing else', () => {
    const missing = clone();
    missing.required = ['verdict'];
    expect(lintSchema(missing, 's')).toEqual([
      's: $: property "findings" is missing from "required"',
    ]);

    const nested = clone();
    nested.properties.findings.items.required = ['severity', 'line', 'ghost'];
    expect(lintSchema(nested, 's')).toEqual([
      's: $.properties.findings.items: "required" names unknown property "ghost"',
    ]);

    const none = clone() as Record<string, unknown>;
    delete none['required'];
    expect(lintSchema(none, 's')).toEqual(['s: $: object must list every property in "required"']);
  });

  it('allows only the agreed keywords', () => {
    const extra = clone();
    (extra.properties.verdict as Record<string, unknown>)['minLength'] = 1;
    (extra.properties as Record<string, unknown>)['more'] = { anyOf: [{ type: 'string' }] };
    extra.required.push('more');
    expect(lintSchema(extra, 's')).toEqual([
      's: $.properties.verdict: keyword "minLength" is not allowed',
      's: $.properties.more: keyword "anyOf" is not allowed',
      's: $.properties.more: "type" is required',
    ]);
  });

  it('requires items on arrays and a valid type everywhere', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['list', 'odd'],
      properties: { list: { type: 'array' }, odd: { type: 'text' } },
    };
    expect(lintSchema(schema, 's')).toEqual([
      's: $.properties.list: array must declare "items"',
      's: $.properties.odd: "type" has an unknown value',
    ]);
  });

  it('rejects object keywords on non-objects and non-object roots', () => {
    expect(lintSchema({ type: 'string', required: [] }, 's')).toEqual([
      's: $: "required" is only valid on an object',
      's: $: the root of an output schema must be an object',
    ]);
    expect(lintSchema([], 's')).toEqual(['s: $: a schema node must be an object']);
  });

  it('treats a node with properties as an object even without a type', () => {
    expect(lintSchema({ properties: {} }, 's')).toEqual([
      's: $: "type" is required',
      's: $: object must set "additionalProperties": false',
      's: $: object must list every property in "required"',
      's: $: the root of an output schema must be an object',
    ]);
  });
});
