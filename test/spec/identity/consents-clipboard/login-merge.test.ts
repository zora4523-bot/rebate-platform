import { expect, it } from 'vitest';

// Use the existing production merge decision. An absent user record would otherwise
// qualify for copying, for either an acceptance or a withdrawal.
it.each([true, false])(
  '[AC-B1-02zc#30] login_merge 排除剪贴板 accepted=%s，保留普通同意合并与已有排除项',
  async (accepted) => {
    const { loginMergeCopies } =
      await import('../../../../apps/api/src/modules/identity/domain/login.ts');
    const older = new Date('2026-10-17T00:00:00Z');
    const newer = new Date('2026-10-18T00:00:00Z');
    const clipboard = {
      id: 1n,
      type: 'clipboard_auto_import',
      version: 0,
      version_label: '2026-10-17',
      accepted,
      client_at: older,
      server_at: newer,
    };
    const regular = {
      ...clipboard,
      id: 2n,
      type: 'personalization',
      version: 3,
      version_label: null,
    };
    const devices = [
      clipboard,
      regular,
      { ...regular, id: 3n, type: 'ai_third_party' },
      { ...regular, id: 4n, type: 'labor_agreement' },
    ];
    expect(loginMergeCopies(devices, [])).toEqual([regular]);
  },
);
