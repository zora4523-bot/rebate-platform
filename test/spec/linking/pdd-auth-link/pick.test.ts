import { expect, it } from 'vitest';
import { pddAuthorityLink } from '../../../../apps/api/src/modules/linking/application/pdd-authority.ts';

// B1-06zf (FU-PDD-AUTH-LINK, D10-647 ②): of a pddAuthorityUrl answer, the jump is built over
// schema_url, else mobile_short_url, else url — never short_url or browser_url ahead of them.
const SCHEMA = 'synthetic-schema://authority/b1-06zf';
const MOBILE_SHORT = 'https://short.example.invalid/m/b1-06zf';
const URL_FIELD = 'https://landing.example.invalid/authority/b1-06zf';
const SHORT = 'https://short.example.invalid/s/b1-06zf';
const BROWSER = 'https://browser.example.invalid/authority/b1-06zf';

it('[AC-B1-06zf#18] 有 schema_url 时取 schema_url（其余字段都在也不取）', () => {
  expect(
    pddAuthorityLink({
      url: URL_FIELD,
      schema_url: SCHEMA,
      mobile_short_url: MOBILE_SHORT,
      short_url: SHORT,
      browser_url: BROWSER,
    }),
  ).toBe(SCHEMA);
});

it('[AC-B1-06zf#19] 没有 schema_url 时取 mobile_short_url，不取 short_url / browser_url / url', () => {
  expect(
    pddAuthorityLink({
      url: URL_FIELD,
      mobile_short_url: MOBILE_SHORT,
      short_url: SHORT,
      browser_url: BROWSER,
    }),
  ).toBe(MOBILE_SHORT);
});

it('[AC-B1-06zf#20] schema_url 与 mobile_short_url 都没有时取 url，不取 short_url / browser_url', () => {
  expect(pddAuthorityLink({ url: URL_FIELD, short_url: SHORT, browser_url: BROWSER })).toBe(
    URL_FIELD,
  );
  expect(pddAuthorityLink({ url: URL_FIELD })).toBe(URL_FIELD);
});
