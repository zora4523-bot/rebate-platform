import { expect, it } from 'vitest';
import {
  mergeFields,
  sectionEnvelopeFields,
  shapeIssueFields,
} from '../domain/pages/admin-sections.ts';
import { homeSectionsSchema } from '../infra/home-schema.ts';
import { createPageSectionsCheck } from './page-sections-check.ts';

const check = createPageSectionsCheck(homeSectionsSchema());
const ACTION = 'sections.0.data_source.items.0.action';
const banner = (id = 'banner_a', action: object = { route: 'Help' }) => ({
  id,
  type: 'banner',
  version: 1,
  data_source: { kind: 'static', items: [{ action }] },
});

it('[AC-F1-09f] shape errors become dotted paths; if-wrappers dropped, required / additional named', () => {
  expect(
    shapeIssueFields([
      { keyword: 'pattern', instancePath: '/sections/0/id', params: {} },
      { keyword: 'if', instancePath: '/sections/0', params: { failingKeyword: 'then' } },
      { keyword: 'required', instancePath: '/sections/1', params: { missingProperty: 'id' } },
      {
        keyword: 'additionalProperties',
        instancePath: '/sections/2/data_source',
        params: { additionalProperty: 'platforms' },
      },
      { keyword: 'oneOf', instancePath: '/sections/3', params: { passingSchemas: null } },
      { keyword: 'contains', instancePath: '/sections', params: {} },
      { keyword: 'type', instancePath: '/sections/4/a~1b', params: {} },
    ]),
  ).toEqual([
    'sections.0.id',
    'sections.1.id',
    'sections.2.data_source.platforms',
    'sections',
    'sections.4.a/b',
  ]);
});

it('[AC-F1-09f] duplicate ids and unregistered types are named; merge keeps first occurrence', () => {
  expect(
    sectionEnvelopeFields(
      [{ id: 'a', type: 'banner' }, { id: 'a', type: 'mystery' }, null],
      new Set(['banner']),
    ),
  ).toEqual(['sections.1.id', 'sections.1.type']);
  expect(sectionEnvelopeFields('x', new Set())).toEqual(['sections']);
  expect(mergeFields(['a', 'b'], ['b', 'c'], ['a'])).toEqual(['a', 'b', 'c']);
});

it('[AC-F1-09f] a registered banner with a plain route passes both validators', () => {
  expect(check([banner()], true)).toEqual([]);
  expect(check([], true)).toEqual([]);
  expect(check([banner('w', { route: 'Withdraw' })], true)).toEqual([]);
});

it('[AC-F1-09f] shape and business errors are merged, each path once', () => {
  const fields = check([banner('bad.id', { route: 'Withdraw', params: 42 })], true);
  expect(fields).toEqual(expect.arrayContaining(['sections.0.id', `${ACTION}.params`]));
  expect(new Set(fields).size).toBe(fields.length);
});

it('[AC-F1-09f] business-only errors stay exact (funds route params, unknown route)', () => {
  expect(check([banner('f', { route: 'Withdraw', params: { from: 'home' } })], true)).toEqual([
    `${ACTION}.params`,
  ]);
  expect(check([banner('u', { route: 'MissingSyntheticRoute' })], true)).toEqual([
    `${ACTION}.route`,
  ]);
});

it('[AC-F1-09f] home-schema-only rules: missing id, two popups, duplicate id, unknown type', () => {
  expect(check([{ type: 'banner', version: 1 }], true)).toContain('sections.0.id');
  expect(
    check(
      [
        { ...banner('one'), type: 'popup' },
        { ...banner('two'), type: 'popup' },
      ],
      true,
    ),
  ).toContain('sections');
  expect(check([banner('dup'), banner('dup')], true)).toEqual(['sections.1.id']);
  expect(check([{ id: 'x', type: 'mystery_card', version: 1 }], true)).toEqual(['sections.0.type']);
});
