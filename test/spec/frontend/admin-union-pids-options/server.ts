// F1-10gc (CT-24s, D10-243): the fake /admin/v1 backend of the 推广位 tab with the permission
// points of the contract — GET /admin/v1/union-accounts (and below) needs union.account_auth,
// /admin/v1/union-pids (and below) needs union.pid, GET /admin/v1/union/account-options needs
// either. A missing point is 10403 admin_permission_denied. Every request is recorded here, the
// allowed ones are answered by the admin-union-pids fake server (which records them too). No
// testing-library import: the browser test uses this file as well.
import {
  ACCOUNTS,
  OPTIONS,
  PIDS,
  createServer,
  failure,
  pids,
  type Account,
  type Server,
} from '../admin-union-pids/fixtures.ts';
import { rows as accountRows } from '../admin-unions/fixtures.ts';

export const ACCOUNT_AUTH = 'union.account_auth';
export const PID_PERMISSION = 'union.pid';
export const OPTIONS_OPERATION = 'adminListUnionAccountOptions';

/** A second taobao account (only in the platform-filter cases). */
export const SPARE_TAOBAO_ACCOUNT = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a04';
export const SPARE_TAOBAO_NAME = '测试淘宝备用账号';

/** The accounts of admin-unions plus a second taobao account. */
export function accountsWithSpare(): Account[] {
  const base = accountRows();
  return [
    ...base,
    { ...base[0]!, union_account_id: SPARE_TAOBAO_ACCOUNT, account_name: SPARE_TAOBAO_NAME },
  ];
}

/** How GET /admin/v1/union/account-options answers. */
export type OptionsMode = 'normal' | 'error' | 'forbidden' | 'offline';

export interface Hit {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Headers;
}

export interface BackendOptions {
  /** Permission points the signed-in admin holds. */
  readonly granted: readonly string[];
  readonly server?: Server | undefined;
  readonly optionsMode?: OptionsMode | undefined;
}

const under = (path: string, base: string): boolean => path === base || path.startsWith(`${base}/`);

function denied(): Response {
  return failure(10403, { reason: 'admin_permission_denied' });
}

export function backend(options: BackendOptions) {
  const server = options.server ?? createServer(pids());
  const mode = options.optionsMode ?? 'normal';
  const hits: Hit[] = [];
  let pending = 0;
  const can = (point: string): boolean => options.granted.includes(point);

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const path = url.pathname;
    hits.push({
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
    });
    pending += 1;
    try {
      if (under(path, ACCOUNTS) && !can(ACCOUNT_AUTH)) return denied();
      if (under(path, PIDS) && !can(PID_PERMISSION)) return denied();
      if (path === OPTIONS) {
        if (!can(PID_PERMISSION) && !can(ACCOUNT_AUTH)) return denied();
        if (mode === 'error') return failure(50000);
        if (mode === 'forbidden') return denied();
        if (mode === 'offline') throw new Error('offline');
      }
      return await server.fetch(input, init);
    } finally {
      pending -= 1;
    }
  };

  return {
    server,
    fetch,
    hits,
    get pending() {
      return pending;
    },
    /** Requests of `method` to `path` (exact) or below a path matching `path` (RegExp). */
    sent(method: string, path: string | RegExp): Hit[] {
      return hits.filter(
        (hit) =>
          hit.method === method &&
          (typeof path === 'string' ? hit.path === path : path.test(hit.path)),
      );
    },
    /** Every request to /admin/v1/union-accounts or below it. */
    accountReads(): Hit[] {
      return hits.filter((hit) => under(hit.path, ACCOUNTS));
    },
    /** Every request to GET /admin/v1/union/account-options. */
    optionReads(): Hit[] {
      return hits.filter((hit) => hit.path === OPTIONS);
    },
  };
}
export type Backend = ReturnType<typeof backend>;
