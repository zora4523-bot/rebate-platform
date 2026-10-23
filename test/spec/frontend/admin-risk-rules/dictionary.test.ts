// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { rows } from './fixtures.ts';
import { loaded, mount, row } from './helpers.ts';

vi.mock('../../../../contracts/texts.admin.default.json', () => ({ default: { texts: {} } }));

it('[AC-F1-10fa-DICT#1] 后台字典缺键时所有动作与两个状态显示编码，不硬编码中文或显示 undefined', async () => {
  await mount();
  await loaded('PASS_REGISTER');
  for (const entry of rows()) {
    expect(row(entry.rule_id).textContent).toContain(entry.risk_action);
    expect(row(entry.rule_id).textContent).toContain(entry.status);
    expect(row(entry.rule_id).textContent).not.toMatch(/undefined|admin_dict\./);
  }
});
