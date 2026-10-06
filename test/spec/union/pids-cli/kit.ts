import { vi } from 'vitest';
import type { UnionPidCliDeps } from '../../../../apps/api/scripts/union-pids.ts';
import type { UnionAccountRow, UnionPidRow } from '../../../../apps/api/src/modules/union/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';

export const APP = 'synthetic-cli-app';
export const ADMIN = '019a0000-0000-7000-8000-000000000001';
export const ACCOUNT = '019a0000-0000-7000-8000-000000000002';
export const PID = '019a0000-0000-7000-8000-000000000003';
export const START = '2031-05-06T07:08:09.000Z';
export const GENERATED = 'synthetic-cli-operation-001';
export const EXPLICIT = 'synthetic-cli-operation-002';
export const CODE = '287082';
export const EVIDENCE = 'synthetic-evidence/花卷云确认.png';

export function accountRow(): UnionAccountRow {
  return {
    id: ACCOUNT,
    app_id: APP,
    platform: 'jd',
    account_name: 'synthetic account',
    status: 'pending',
    sync_start_at: null,
    auth_status: 'active',
    auth_expires_at: null,
    auth_renewed_at: null,
    auth_renewed_by: null,
    alert_stage: 'none',
    last_probe_at: null,
    last_probe_ok: null,
    last_probe_error: null,
    row_version: 0,
    created_at: new Date(START),
    updated_at: new Date(START),
  };
}

export function pidRow(): UnionPidRow {
  return {
    id: PID,
    app_id: APP,
    platform: 'jd',
    union_account_id: ACCOUNT,
    site_id: null,
    pid: 'synthetic-pid-001',
    pid_scene: 'self_buy',
    status: 'pending',
    hjy_ignore_confirmed_at: null,
    hjy_ignore_evidence_path: null,
    row_version: 0,
    created_at: new Date(START),
    updated_at: new Date(START),
  };
}

export const WRITES = [
  {
    name: 'register-account',
    method: 'registerAccount',
    args: ['--platform', 'jd', '--account-name', 'synthetic account', '--auth-status', 'active'],
    expected: {
      platform: 'jd',
      accountName: 'synthetic account',
      authStatus: 'active',
      authExpiresAt: null,
    },
  },
  {
    name: 'register-pid',
    method: 'registerPid',
    args: [
      '--platform',
      'taobao',
      '--union-account-id',
      ACCOUNT,
      '--pid',
      'mm_000_000_000',
      '--site-id',
      '000',
      '--pid-scene',
      'share',
    ],
    expected: {
      platform: 'taobao',
      unionAccountId: ACCOUNT,
      pid: 'mm_000_000_000',
      siteId: '000',
      pidScene: 'share',
    },
  },
  {
    name: 'confirm-hjy',
    method: 'confirmHjyIgnore',
    args: ['--pid-id', PID, '--evidence-path', EVIDENCE],
    expected: { pidId: PID, evidencePath: EVIDENCE, confirmedAt: new Date(START) },
  },
  {
    name: 'activate',
    method: 'setPidStatus',
    args: ['--pid-id', PID],
    expected: { pidId: PID, status: 'active' },
  },
  {
    name: 'retire',
    method: 'setPidStatus',
    args: ['--pid-id', PID],
    expected: { pidId: PID, status: 'retired' },
  },
] as const;

export function argv(command: (typeof WRITES)[number]): string[] {
  return [command.name, '--app', APP, '--admin', ADMIN, ...command.args];
}

export function fixture() {
  const output: string[] = [];
  const errors: string[] = [];
  const clock = new FixedClock(START);
  const service = {
    registerAccount: vi.fn<UnionPidCliDeps['service']['registerAccount']>(async () => accountRow()),
    registerPid: vi.fn<UnionPidCliDeps['service']['registerPid']>(async () => pidRow()),
    confirmHjyIgnore: vi.fn<UnionPidCliDeps['service']['confirmHjyIgnore']>(async () => pidRow()),
    setPidStatus: vi.fn<UnionPidCliDeps['service']['setPidStatus']>(async () => pidRow()),
  };
  const queries = {
    listAccounts: vi.fn<UnionPidCliDeps['queries']['listAccounts']>(async () => [accountRow()]),
    listPids: vi.fn<UnionPidCliDeps['queries']['listPids']>(async () => [pidRow()]),
  };
  const readCode = vi.fn(async (): Promise<string | null> => CODE);
  const newIdempotencyKey = vi.fn(() => GENERATED);
  const deps: UnionPidCliDeps = {
    service,
    queries,
    clock,
    newIdempotencyKey,
    terminal: {
      isTTY: true,
      readCode,
      write: (message) => {
        output.push(message);
      },
      error: (message) => {
        errors.push(message);
      },
    },
  };
  return {
    deps,
    service,
    queries,
    clock,
    readCode,
    newIdempotencyKey,
    output,
    errors,
    printed: () => [...output, ...errors].join('\n'),
    writeCount: () =>
      Object.values(service).reduce((sum, method) => sum + method.mock.calls.length, 0),
  };
}
