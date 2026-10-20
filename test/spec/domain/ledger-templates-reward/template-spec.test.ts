import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { LEDGER_TEMPLATE_ROWS } from '../../../../packages/domain/src/ledger/templates.gen.ts';
import { readTemplates } from '../ledger-templates/fixtures.ts';

// Independent decision-37 oracle: no expectation is derived from the generated implementation.
const expected = [
  {
    template_id: 'REWARD:INVITE',
    ledger_type: 'REWARD',
    sub_type: 'invite',
    uniq_key_pattern: 'INVITE_REWARD:{invitee_user_id}:{side}',
    line: '1',
    account_owner: 'platform',
    subject: 'MKT_EXPENSE',
    sub_account: 'available',
    sign: 'debit',
    amount_ref: 'reward_fen',
  },
  {
    template_id: 'REWARD:INVITE',
    ledger_type: 'REWARD',
    sub_type: 'invite',
    uniq_key_pattern: 'INVITE_REWARD:{invitee_user_id}:{side}',
    line: '2',
    account_owner: 'user',
    subject: 'USER_BALANCE',
    sub_account: 'available',
    sign: 'credit',
    amount_ref: 'reward_fen',
  },
];

it('[AC-B2-16a#9] CSV 与生成表均登记两行邀请奖励，方向、键、金额名与依据保持一致', () => {
  const csv = readTemplates().get('REWARD:INVITE') ?? [];
  const generated = LEDGER_TEMPLATE_ROWS.filter((row) => row.template_id === 'REWARD:INVITE');
  for (const rows of [csv, generated]) {
    expect(rows).toHaveLength(2);
    expect(
      rows.map(({ note, ...fields }) => {
        expect(note).toContain('BR-INV-24');
        expect(note).toContain('BR-FUND-15');
        expect(note).toContain('BR-FUND-01');
        expect(note).toMatch(/代理起草.*待财务确认/);
        return fields;
      }),
    ).toEqual(expected);
  }
  expect(generated).toEqual(csv);
});

it('[AC-B2-16a#12] 账务规格说明 invite 单独发放、仍属 P1 的新人签到奖与待定税务', () => {
  const markdown = readFileSync(
    new URL('../../../../specs/ledger-rules.md', import.meta.url),
    'utf8',
  );
  const section =
    /^### 4\.10[^\n]*\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/m.exec(markdown)?.[1] ?? '';
  for (const term of [
    'REWARD:INVITE',
    'invite',
    'USER_BALANCE',
    'available',
    'MKT_EXPENSE',
    'INVITE_REWARD:{invitee_user_id}:{side}',
    'reward_fen',
    'inviter',
    'invitee',
    'newbie',
    'checkin',
    'P1',
    'BR-INV-24',
    'BR-FUND-15',
    'BR-FUND-01',
    'Q-F6',
  ])
    expect(section, term).toContain(term);
  expect(section).toMatch(/不(伴随|随)订单迁移/);
  expect(section).toMatch(/(每|各)[^\n]*(受益方|方)[^\n]*一张凭证/);
  expect(section).toMatch(/待[^\n]*(税务|Q-F6)|(?:税务|Q-F6)[^\n]*待/);
});
