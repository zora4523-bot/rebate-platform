// Container-only HTTP/SQL helpers; no direct @couli/db/testing import or destructive cleanup.
import { randomUUID } from 'node:crypto';
import type { KyselyPlugin } from 'kysely';
import { expect } from 'vitest';
import { seed } from '../../admin/accounts/kit.ts';
import { fixture, signedIn, type Harness } from '../../admin/auth/kit.ts';
import { getItem } from '../config-items/kit.ts';
import { KEY } from './oracle.ts';

export { useHarness } from '../../admin/auth/kit.ts';

export async function setup(h: Harness) {
  const queries: string[] = [];
  const capture: KyselyPlugin = {
    transformQuery({ node }) {
      queries.push(
        JSON.stringify(node, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      );
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  const f = await fixture({ ...h, db: h.db.withPlugin(capture) });
  const appId = `f1-02zx-${randomUUID()}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  return { ...f, appId, actor, token: session.admin_token, queries };
}

export type Setup = Awaited<ReturnType<typeof setup>>;

/** Unknown-key rejection must not masquerade as correct range/permission validation. */
export async function registered(f: Setup, value: unknown = null, version = 0) {
  expect(await getItem(f, KEY)).toMatchObject({
    key: KEY,
    value,
    version,
    permission: 'config.business',
    admin_editable: true,
    value_type: 'number',
  });
}

export function noCampaignLock(f: Setup, start: number) {
  expect(
    f.queries
      .slice(start)
      .filter(
        (query) =>
          query.includes('pg_advisory') && query.includes(`content.invite_reward:${f.appId}`),
      ),
  ).toStrictEqual([]);
}
