// B1-22r / orchestrator ruling D10-427 ① (B1-22g money review S2), SPEC_REF 37808a5: POST
// /admin/v1/union-accounts/alert-phones with a reason holding a Unicode Cc control character passes
// the route schema (1–200 characters, no pattern) and used to reach content's write port, which
// refuses it: a 5XX. It is 20001 with data.fields=[reason]; the group, its history and the audit
// stay as they were. DELETE takes no reason (contract: identifiers only), so only the add carries
// one. Real admin HTTP (Fastify inject) + business-role PG through the B1-22g kit.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACTIONS,
  accepted,
  audits,
  maskedOf,
  masked,
  mobiles,
  rejected,
  seedPhones,
  serialized,
  setup,
  snapshot,
  stored,
} from '../admin-alert-phones/kit.ts';
import { NAMED_CONTROLS, VALID_REASONS, controlReasons, shown } from './kit.ts';

const h = useHarness();

/** No error line (a 5XX is logged at error level) and no plaintext number in the log. */
function quietLog(lines: readonly string[], phones: readonly string[]) {
  for (const line of lines) {
    const entry = JSON.parse(line) as { level?: number; msg?: unknown };
    expect(entry.level ?? 0, line).toBeLessThan(50);
    for (const phone of phones) expect(line).not.toContain(phone);
  }
}

it('[B1-22r][D10-427 ①] 新增告警手机号：reason 含 \\n \\t \\u0000 \\u007f → 20001 [reason]，号码组、配置历史与审计都不变，不再 5XX', async () => {
  const s = await setup(h);
  const [kept, phone] = mobiles(2);
  await seedPhones(s, [kept!], 3);
  const before = await snapshot(s);
  for (const reason of controlReasons()) {
    await rejected(await s.add({ phone, expected_version: 3, reason }), 'add', 20001, {
      fields: ['reason'],
    });
    expect(await snapshot(s), shown(reason)).toEqual(before);
  }
  expect(await stored(s)).toEqual([kept]);
  quietLog(s.f.lines, [kept!, phone!]);
});

it('[B1-22r][D10-427 ①] 新增告警手机号：控制字符的 reason 在组从未写过（版本 0）时也是 20001 [reason]、不建行；同号重复添加也不写审计', async () => {
  const s = await setup(h);
  const [phone] = mobiles(1);
  for (const control of NAMED_CONTROLS) {
    await rejected(
      await s.add({ phone, expected_version: 0, reason: `首次添加${control}` }),
      'add',
      20001,
      { fields: ['reason'] },
    );
  }
  expect(await snapshot(s)).toEqual({ config: undefined, history: [], audits: [] });

  // The same number again normally succeeds without a write but with an audit row; a control
  // character in its reason is refused before that audit row too.
  await seedPhones(s, [phone!], 2);
  const before = await snapshot(s);
  await rejected(
    await s.add({ phone: `+86${phone!}`, expected_version: 2, reason: '重复\n添加' }),
    'add',
    20001,
    { fields: ['reason'] },
  );
  expect(await snapshot(s)).toEqual(before);
  expect(await audits(s)).toEqual([]);
});

it('[B1-22r][D10-427 ①] 新增告警手机号：控制字符被拒之后，不含控制字符的合法 reason 照常成功并记入审计（200 字、中文、空格）', async () => {
  const s = await setup(h);
  const numbers = mobiles(VALID_REASONS.length);
  await rejected(
    await s.add({ phone: numbers[0], expected_version: 0, reason: '换号\u0000' }),
    'add',
    20001,
    { fields: ['reason'] },
  );
  let version = 0;
  for (const [index, reason] of VALID_REASONS.entries()) {
    const data = await accepted(
      await s.add({ phone: numbers[index], expected_version: version, reason }),
      'add',
    );
    expect(data.version, shown(reason)).toBe(version + 1);
    version = data.version;
  }
  expect(maskedOf(await accepted(await s.listPhones(), 'list'))).toEqual(
    numbers.map((phone) => masked(phone)).sort(),
  );
  const rows = await audits(s);
  expect(rows.map((row) => row.action)).toEqual(VALID_REASONS.map(() => ACTIONS.add));
  for (const [index, reason] of VALID_REASONS.entries()) {
    expect(rows[index]!.after, shown(reason)).toMatchObject({ reason });
    expect(serialized(rows[index])).not.toContain(numbers[index]);
  }
});
