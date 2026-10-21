import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { RequestLog } from '../admin-kill-switches/fixtures.ts';
import { createServer, detail, rows, DETAIL, ok, failure } from '../admin-users/fixtures.ts';

export * from '../admin-users/fixtures.ts';
export const LEVEL = `${DETAIL}/level`;
export const INVITER = `${DETAIL}/inviter`;
export const INVITEES = `${DETAIL}/invitees`;
export const NEW_PARENT = rows()[2]!.user_id;
export const CHANGE_REASON = '已核实用户申请，修正登记信息';
export type Reply = (request: RequestLog) => Response | Promise<Response>;

export function invitees(): Schema<'AdminInviteeListItem'>[] {
  return rows()
    .slice(1)
    .map((row) => ({
      user_id: row.user_id,
      phone_masked: row.phone_masked,
      nickname: row.nickname,
      registered_at: row.created_at,
      level: row.level,
    }));
}

/** Extend the existing HTTP fake, preserving its logs, pending counter and detail routes. */
export function createRelationsServer(items = invitees()) {
  const base = createServer();
  const overrides: { method: string; path: string; reply: Reply }[] = [];
  const owns = (path: string) => [LEVEL, INVITER, INVITEES].includes(path);
  function normal(request: RequestLog): Response {
    if (request.path === INVITEES && request.method === 'GET') {
      const page = Number(request.query['page']);
      const size = Number(request.query['page_size']);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 200)
        return failure(20001, { fields: ['page_size'] });
      return ok({
        items: items.slice((page - 1) * size, page * size),
        page,
        page_size: size,
        total: items.length,
      });
    }
    if (request.method !== 'POST') return failure(20001, { fields: ['path'] });
    if (!request.headers.get('X-Step-Up-Token')) return failure(10003, { tier: 'totp' });
    if (request.path === LEVEL) {
      const body = request.body as Schema<'AdminUserLevelChangeRequest'>;
      return ok({ ...detail(), level: body.level });
    }
    const body = request.body as Schema<'AdminUserInviterChangeRequest'>;
    return ok({ ...detail(), inviter_user_id: body.inviter_user_id });
  }
  const fetch: typeof globalThis.fetch = (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (owns(path))
      base.once(method, path, (request) => {
        const index = overrides.findIndex(
          (entry) => entry.method === method && entry.path === path,
        );
        return index < 0 ? normal(request) : overrides.splice(index, 1)[0]!.reply(request);
      });
    return base.fetch(input, init);
  };
  function once(method: string, path: string, reply: Reply): void {
    if (owns(path)) overrides.push({ method, path, reply });
    else base.once(method, path, reply);
  }
  return {
    ...base,
    fetch,
    once,
    get pending() {
      return base.pending;
    },
    hold(method: string, path: string) {
      if (!owns(path)) return base.hold(method, path);
      const gate = Promise.withResolvers<void>();
      once(method, path, async (request) => {
        await gate.promise;
        return normal(request);
      });
      return gate.resolve;
    },
  };
}
export type RelationsServer = ReturnType<typeof createRelationsServer>;
