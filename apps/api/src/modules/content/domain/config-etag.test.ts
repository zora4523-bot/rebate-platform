import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { MaterialChannelsSpec } from '../../platform/index.ts';
import { canonicalJson, configEtag, ifNoneMatchHits, rankPlatforms } from './config-etag.ts';

it('[AC-F1-02h] canonical JSON sorts keys recursively, keeps array order, follows JSON for undefined', () => {
  expect(canonicalJson({ b: [3, { y: 1, x: undefined }], a: '"', '10': null, '2': true })).toBe(
    '{"10":null,"2":true,"a":"\\"","b":[3,{"y":1}]}',
  );
  expect(canonicalJson([undefined, 1])).toBe('[null,1]');
});

it('[AC-F1-02h] configEtag is the quoted first 32 hex of sha256 of the canonical text', () => {
  const data = { texts: { b: '2', a: '1' } } as never;
  const digest = createHash('sha256').update('{"texts":{"a":"1","b":"2"}}').digest('hex');
  expect(configEtag(data)).toBe(`"${digest.slice(0, 32)}"`);
});

const TAG = '"0123456789abcdef0123456789abcdef"';
it('[AC-F1-02h] If-None-Match uses weak comparison over a comma list', () => {
  expect(ifNoneMatchHits(TAG, TAG)).toBe(true);
  expect(ifNoneMatchHits(` "a" ,W/${TAG}`, TAG)).toBe(true);
  expect(ifNoneMatchHits('*', TAG)).toBe(true);
  expect(ifNoneMatchHits(undefined, TAG)).toBe(false);
  expect(ifNoneMatchHits('', TAG)).toBe(false);
  expect(ifNoneMatchHits(TAG.slice(1, -1), TAG)).toBe(false);
  expect(ifNoneMatchHits(`W/W/${TAG}`, TAG)).toBe(false);
  expect(ifNoneMatchHits('"*"', TAG)).toBe(false);
});

it('[AC-F1-02h] rank platforms: selectable sales / popularity only, PlatformCode order, deduplicated', () => {
  const ch = (
    platform: string,
    selectable: boolean,
    sort_basis: 'sales' | 'popularity' | 'personalized' = 'popularity',
  ) => ({
    platform,
    channel_id: platform,
    name: 'n',
    sort_basis,
    selectable,
    source: 's',
  });
  const spec: MaterialChannelsSpec = {
    version: 'x',
    channels: [
      ch('suning', true),
      ch('jd', true),
      ch('jd', true, 'sales'),
      ch('pdd', false),
      ch('x', true),
      ch('taobao', true, 'personalized'),
    ],
  };
  expect(rankPlatforms(spec)).toEqual(['jd', 'suning']);
  expect(rankPlatforms({ version: 'x', channels: [] })).toEqual([]);
});

it('[AC-F1-02h] rank platforms: a platform with only personalized channels is left out', () => {
  const spec: MaterialChannelsSpec = {
    version: 'x',
    channels: [
      {
        platform: 'taobao',
        channel_id: 't1',
        name: 'n',
        sort_basis: 'personalized',
        selectable: true,
        source: 's',
      },
      {
        platform: 'pdd',
        channel_id: 'p1',
        name: 'n',
        sort_basis: 'personalized',
        selectable: true,
        source: 's',
      },
      {
        platform: 'pdd',
        channel_id: 'p2',
        name: 'n',
        sort_basis: 'sales',
        selectable: true,
        source: 's',
      },
    ],
  };
  expect(rankPlatforms(spec)).toEqual(['pdd']);
});
