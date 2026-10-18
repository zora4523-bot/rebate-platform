// B1-08j 源码旁单元测试：来源回填纯匹配与 lk 解析（BR-ATTR-15；窗口 BR-ATTR-13 ③）。
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  matchExactLink,
  matchOrderSource,
  parseLinkCode,
  type LinkLogCandidate,
  type MatchOrderSourceInput,
} from './source-backfill.ts';

const at = (iso: string) => new FixedClock(iso).now();
const ATTR = '2026-10-20T04:00:00.000Z';

function row(patch: Partial<LinkLogCandidate> = {}): LinkLogCandidate {
  return {
    id: 10n,
    link_id: 'link-a',
    user_id: 'u1',
    platform: 'jd',
    product_key: 'jd:1',
    shop_id: 's1',
    event: 'convert',
    result_code: 0,
    pid_scene: 'share',
    scene: 'share',
    agent_session_id: null,
    created_at: at('2026-10-19T04:00:00.000Z'),
    ...patch,
  };
}

function input(patch: Partial<MatchOrderSourceInput> = {}): MatchOrderSourceInput {
  return {
    userId: 'u1',
    platform: 'jd',
    productKey: 'jd:1',
    shopId: 's1',
    pidScene: 'share',
    attrAt: at(ATTR),
    windowHours: 360,
    exactLink: null,
    candidates: [row()],
    ...patch,
  };
}

it('[AC-B1-08j#U1] exact 只认属于订单 user_id 的 link；user_id 为空的 link 不算 exact', () => {
  const link = { link_id: 'exact', user_id: 'u1', scene: 'agent', agent_session_id: 'S1' };
  expect(matchOrderSource(input({ exactLink: link }))).toEqual({
    source_match: 'exact',
    link_id: 'exact',
    source_scene: 'agent',
    agent_session_id: 'S1',
  });
  expect(matchOrderSource(input({ exactLink: { ...link, user_id: null } })).source_match).toBe(
    'product',
  );
});

it('[AC-B1-08j#U15] matchExactLink：只认属于订单 user_id 的 link；反查不到、无主、属他人 → null', () => {
  const link = { link_id: 'exact', user_id: 'u1', scene: null, agent_session_id: null };
  expect(matchExactLink(link, 'u1')).toEqual({
    source_match: 'exact',
    link_id: 'exact',
    source_scene: null,
    agent_session_id: null,
  });
  expect(matchExactLink(null, 'u1')).toBeNull();
  expect(matchExactLink({ ...link, user_id: null }, 'u1')).toBeNull();
  expect(matchExactLink({ ...link, user_id: 'u2' }, 'u1')).toBeNull();
});

it('[AC-B1-08j#U2] 窗口按绝对毫秒闭区间；同刻按 bigint id 取大；返回值是新对象', () => {
  const edge = row({ created_at: at('2026-10-05T04:00:00.000Z'), link_id: 'edge' });
  expect(matchOrderSource(input({ candidates: [edge] })).link_id).toBe('edge');
  const before = row({ created_at: at('2026-10-05T03:59:59.999Z') });
  expect(matchOrderSource(input({ candidates: [before] })).source_match).toBe('none');
  const a = row({ id: 2n ** 63n - 2n, link_id: 'a' });
  const b = row({ id: 2n ** 63n - 1n, link_id: 'b' });
  expect(matchOrderSource(input({ candidates: [b, a] })).link_id).toBe('b');
  const first = matchOrderSource(input({ candidates: [] }));
  const second = matchOrderSource(input({ candidates: [] }));
  expect(first).toEqual(second);
  expect(first).not.toBe(second);
});

it('[AC-B1-08j#U3] fallback 推广位不限 pid_scene；其余场景（含 BR-ATTR-08 名单外）按字面比较', () => {
  const other = row({ pid_scene: 'agent' });
  expect(matchOrderSource(input({ pidScene: 'fallback', candidates: [other] })).source_match).toBe(
    'product',
  );
  expect(matchOrderSource(input({ pidScene: 'share', candidates: [other] })).source_match).toBe(
    'none',
  );
  expect(matchOrderSource(input({ pidScene: 'Fallback', candidates: [other] })).source_match).toBe(
    'none',
  );
});

it('[AC-B1-08j#U10] 推广位场景未知（null）不当作 fallback：② / ③ 不匹配任何场景的点击，exact 照常', () => {
  const clicks = [
    row({ pid_scene: 'share', link_id: 'share' }),
    row({ pid_scene: 'self_buy', link_id: 'self' }),
    row({ pid_scene: 'fallback', link_id: 'fb' }),
    row({ pid_scene: null, link_id: 'nil' }),
  ];
  expect(matchOrderSource(input({ pidScene: null, candidates: clicks }))).toEqual({
    source_match: 'none',
    link_id: null,
    source_scene: null,
    agent_session_id: null,
  });
  expect(
    matchOrderSource(input({ pidScene: null, productKey: null, candidates: clicks })).source_match,
  ).toBe('none');
  const link = { link_id: 'exact', user_id: 'u1', scene: 'agent', agent_session_id: 'S1' };
  expect(matchOrderSource(input({ pidScene: null, exactLink: link, candidates: clicks }))).toEqual({
    source_match: 'exact',
    link_id: 'exact',
    source_scene: 'agent',
    agent_session_id: 'S1',
  });
  expect(
    matchOrderSource(
      input({ pidScene: null, exactLink: { ...link, user_id: 'u2' }, candidates: clicks }),
    ).source_match,
  ).toBe('none');
});

it('[AC-B1-08j#U4] parseLinkCode 只看本平台字段：京东第 2 组、拼多多 JSON 对象 lk、淘宝恒空', () => {
  const params = {
    relation_id: 'r',
    sub_union_id: 'n_abcd1234_xyz9',
    custom_parameters: '{"app":"n","uid":"abcd1234","lk":"q1w2e3"}',
  };
  expect(parseLinkCode('jd', params)).toBe('xyz9');
  expect(parseLinkCode('pdd', params)).toBe('q1w2e3');
  expect(parseLinkCode('taobao', params)).toBeNull();
  expect(parseLinkCode('pdd', { ...params, custom_parameters: '' })).toBeNull();
  expect(parseLinkCode('jd', { ...params, sub_union_id: '' })).toBeNull();
});
