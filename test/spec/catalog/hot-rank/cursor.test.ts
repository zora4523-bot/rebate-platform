// B1-28h: a malformed cursor, or one issued for another platform, is 20001 (contract getHotRank:
// "a malformed or foreign cursor is 20001 with data.fields=[cursor]"; the field list is pinned at
// the HTTP layer in http.test.ts).
import { expect, it } from 'vitest';
import { PAGE_SIZE, TB_CHANNEL, channel, fixture, rejection, series } from './kit.ts';

it('[AC-B1-28h#14] 非法游标（任意字符串、空对象的 base64url、乱码）→ 20001，不登记链接', async () => {
  const f = fixture();
  f.setPage('taobao', TB_CHANNEL, null, 1, series('p1', PAGE_SIZE), true);
  f.setPage('taobao', TB_CHANNEL, null, 2, series('p2', 1, 21), false);

  for (const cursor of ['synthetic-not-a-cursor', 'e30', '!!!!', 'eyJwYWdlX25vIjowfQ']) {
    const error = await rejection(() => f.run({ cursor }));
    expect(error, cursor).toMatchObject({ code: 20001 });
  }
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B1-28h#15] 别的平台发出的游标拿到本平台用 → 20001，不按它取数', async () => {
  const f = fixture();
  f.setChannels([channel('taobao', TB_CHANNEL), channel('jd', 'synthetic_jd_sales')]);
  f.setPage('taobao', TB_CHANNEL, null, 1, series('tb', PAGE_SIZE), true);
  f.setPage('jd', 'synthetic_jd_sales', null, 2, series('jd', 1, 21, 'jd'), false);

  const taobao = await f.run({ platform: 'taobao' });
  expect(typeof taobao.next_cursor).toBe('string');
  const registered = f.register.mock.calls.length;

  const error = await rejection(() => f.run({ platform: 'jd', cursor: taobao.next_cursor! }));

  expect(error).toMatchObject({ code: 20001 });
  expect(f.page.mock.calls.filter(([input]) => input.platform === 'jd')).toEqual([]);
  expect(f.register.mock.calls.length).toBe(registered);
});
