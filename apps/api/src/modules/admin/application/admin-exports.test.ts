import { describe, expect, it } from 'vitest';
import { filtersSummary } from './admin-exports.ts';

describe('filtersSummary', () => {
  it('[AC-B1-34f] users: risk state name, or 全部 without a filter', () => {
    expect(filtersSummary('users', {})).toBe('风控状态：全部');
    expect(filtersSummary('users', { risk_state: 'frozen' })).toBe('风控状态：冻结');
    expect(filtersSummary('users', { risk_state: 'banned' })).toBe('风控状态：封禁');
  });

  it('[AC-B1-34f] audit_logs: time range at +08:00 and the other filters', () => {
    expect(
      filtersSummary('audit_logs', {
        from: '2026-10-18T00:00:00+08:00',
        to: '2026-10-18T16:00:00Z',
      }),
    ).toBe('时间：2026-10-18 00:00 至 2026-10-19 00:00');
    expect(filtersSummary('audit_logs', {})).toBe('时间：全部');
    expect(filtersSummary('audit_logs', { target_type: 'admin_users' })).toBe(
      '对象类型：admin_users',
    );
  });

  it('[AC-B1-34f] the summary never exceeds 500 characters', () => {
    expect(Array.from(filtersSummary('audit_logs', { target_id: '对'.repeat(600) })).length).toBe(
      500,
    );
  });
});
