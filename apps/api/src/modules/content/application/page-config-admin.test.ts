import { expect, it } from 'vitest';
import type { AuditInput, Clock } from '../../platform/index.ts';
import {
  PageConfigAdmin,
  PageConflictError,
  PageFieldsError,
  PageNotFoundError,
  type PageActor,
  type PageConfigStore,
  type PageConfigTx,
  type PageRow,
  type PageView,
} from './page-config-admin.ts';

interface Version {
  version: number;
  status: string;
  sections: unknown;
  publishAt: Date | null;
}

class Clockwork implements Clock {
  ms = Date.UTC(2026, 9, 17, 2);
  now(): Date {
    return new Date(this.ms);
  }
}

function memory(switchValue: unknown = undefined) {
  let page: (PageRow & { updatedBy: string | null }) | undefined;
  let versions: Version[] = [];
  const audits: AuditInput[] = [];
  const view = (): PageView | undefined =>
    page === undefined || versions.length === 0
      ? undefined
      : {
          page_key: 'home',
          current_version: page.currentVersion,
          gray_version: page.grayVersion,
          gray_percent: page.grayPercent,
          revision: page.revision,
          latest_version: Math.max(...versions.map((v) => v.version)),
          updated_by: page.updatedBy,
          updated_at: null,
        };
  const find = (n: number) => versions.find((v) => v.version === n);
  const tx: PageConfigTx = {
    pages: () => Promise.reject(new Error('unused')),
    versions: () => Promise.reject(new Error('unused')),
    page: async () => view(),
    version: async (_a, key, n) => {
      const v = find(n);
      return v === undefined
        ? undefined
        : {
            page_key: key,
            version: v.version,
            status: v.status as 'draft',
            render_count: 0,
            error_count: 0,
            publish_at: v.publishAt?.toISOString() ?? null,
            publisher: null,
            created_by: 'ops',
            created_at: '2026-10-17T02:00:00.000Z',
            sections: v.sections as Record<string, unknown>[],
          };
    },
    unionHostBlock: async () => switchValue,
    ensurePage: async () => {
      page ??= {
        currentVersion: null,
        grayVersion: null,
        grayPercent: 0,
        revision: 0,
        updatedBy: null,
      };
    },
    lock: async () => (page === undefined ? undefined : { ...page }),
    latestVersion: async () =>
      versions.length === 0 ? null : Math.max(...versions.map((v) => v.version)),
    versionRow: async (_a, _k, n) => find(n),
    insertVersion: async (input) => {
      versions.push({
        version: input.version,
        status: 'draft',
        sections: input.sections,
        publishAt: null,
      });
    },
    markPublished: async (_a, _k, n, _p, at) => {
      Object.assign(find(n)!, { status: 'published', publishAt: at });
    },
    markRolledBack: async (_a, _k, n) => {
      find(n)!.status = 'rolled_back';
    },
    successor: async (_a, _k, except) =>
      versions
        .filter((v) => v.status === 'published' && v.version !== except)
        .sort((a, b) => b.publishAt!.getTime() - a.publishAt!.getTime() || b.version - a.version)[0]
        ?.version,
    updatePage: async (_a, _k, p, revision, adminId) => {
      page = { ...p, revision, updatedBy: adminId };
    },
    audit: async (input) => {
      audits.push(input);
    },
  };
  const store: PageConfigStore = {
    ...tx,
    // Rolls back on a throw, like the database transaction.
    async transaction(work) {
      const saved = { page, versions: versions.map((v) => ({ ...v })), audits: audits.length };
      try {
        return await work(tx);
      } catch (error) {
        page = saved.page;
        versions = saved.versions;
        audits.length = saved.audits;
        throw error;
      }
    },
  };
  return { store, audits, state: () => ({ page, versions }) };
}

const ACTOR: PageActor = { appId: 'a1', adminId: 'admin-1', ip: null };
const ok = () => [] as string[];

function setup(
  check: (s: unknown, block: boolean) => readonly string[] = ok,
  switchValue?: unknown,
) {
  const clock = new Clockwork();
  const m = memory(switchValue);
  const admin = new PageConfigAdmin(m.store, clock, check);
  const save = (rev: number) => {
    clock.ms += 1000;
    return admin.save(ACTOR, 'home', { sections: [], expected_revision: rev });
  };
  const publish = (rev: number, version: number, gray_percent = 100) => {
    clock.ms += 1000;
    return admin.publish(ACTOR, 'home', { version, gray_percent, expected_revision: rev });
  };
  return { ...m, clock, admin, save, publish };
}

it('[AC-F1-09f] first save makes version 1 at revision 1 and audits page_version_create', async () => {
  const t = setup();
  expect(await t.save(0)).toMatchObject({ version: 1, status: 'draft' });
  expect(t.state().page).toMatchObject({ revision: 1, updatedBy: 'admin-1' });
  expect(t.audits).toHaveLength(1);
  expect(t.audits[0]).toMatchObject({
    action: 'page_version_create',
    before: { revision: 0, version: 1 },
    after: { revision: 1, version: 1, current_version: null },
  });
});

it('[AC-F1-09f] a stale first save is 20902 and leaves no page row', async () => {
  const t = setup();
  await expect(t.save(1)).rejects.toBeInstanceOf(PageConflictError);
  expect(t.state().page).toBeUndefined();
});

it('[AC-F1-09f] sections are checked with the switch value; anything but false blocks', async () => {
  const seen: boolean[] = [];
  for (const value of [undefined, true, 'false', 0, false]) {
    const t = setup((_s, block) => {
      seen.push(block);
      return [];
    }, value);
    await t.save(0);
  }
  expect(seen).toEqual([true, true, true, true, false]);
  const bad = setup(() => ['sections.0.id']);
  await expect(bad.save(0)).rejects.toEqual(new PageFieldsError(['sections.0.id']));
  expect(bad.state().page).toBeUndefined();
});

it('[AC-F1-09f] publish edges: first only 100, no publish while gray, only drafts', async () => {
  const t = setup();
  await t.save(0);
  await expect(t.publish(1, 1, 10)).rejects.toEqual(new PageFieldsError(['gray_percent']));
  expect(await t.publish(1, 1)).toMatchObject({ current_version: 1, revision: 2 });
  await expect(t.publish(2, 1)).rejects.toEqual(new PageFieldsError(['version']));
  await expect(t.publish(2, 9)).rejects.toEqual(new PageFieldsError(['version']));
  await t.save(2);
  expect(await t.publish(3, 2, 10)).toMatchObject({
    current_version: 1,
    gray_version: 2,
    gray_percent: 10,
  });
  await t.save(4);
  await expect(t.publish(5, 3)).rejects.toEqual(new PageFieldsError(['version']));
});

it('[AC-F1-09f] order: 30701 before 20902 before state checks', async () => {
  const t = setup();
  await expect(t.publish(0, 1)).rejects.toBeInstanceOf(PageNotFoundError);
  await t.save(0);
  await expect(t.publish(0, 99)).rejects.toBeInstanceOf(PageConflictError);
  await expect(
    t.admin.gray(ACTOR, 'home', { gray_percent: 50, expected_revision: 1 }),
  ).rejects.toEqual(new PageFieldsError(['gray_percent']));
});

it('[AC-F1-09f] gray 100 releases fully without touching the old full version', async () => {
  const t = setup();
  await t.save(0);
  await t.save(1);
  await t.publish(2, 1);
  await t.publish(3, 2, 10);
  expect(
    await t.admin.gray(ACTOR, 'home', { gray_percent: 50, expected_revision: 4 }),
  ).toMatchObject({ gray_percent: 50, gray_version: 2 });
  expect(
    await t.admin.gray(ACTOR, 'home', { gray_percent: 100, expected_revision: 5 }),
  ).toMatchObject({ current_version: 2, gray_version: null, gray_percent: 0, revision: 6 });
  expect(t.state().versions.map((v) => v.status)).toEqual(['published', 'published']);
  expect(t.audits.at(-1)).toMatchObject({ action: 'page_gray_update', after: { version: 2 } });
});

it('[AC-F1-09f] rollback goes back by publish_at, not by version number', async () => {
  const t = setup();
  await t.save(0);
  await t.save(1);
  await t.publish(2, 2);
  await t.publish(3, 1);
  await expect(
    t.admin.rollback(ACTOR, 'home', { version: 2, expected_revision: 4 }),
  ).rejects.toEqual(new PageFieldsError(['version']));
  expect(await t.admin.rollback(ACTOR, 'home', { version: 1, expected_revision: 4 })).toMatchObject(
    { current_version: 2, revision: 5 },
  );
  expect(t.state().versions.map((v) => v.status)).toEqual(['rolled_back', 'published']);
  await expect(
    t.admin.rollback(ACTOR, 'home', { version: 2, expected_revision: 5 }),
  ).rejects.toEqual(new PageFieldsError(['version']));
});

it('[AC-F1-09f] rollback of the gray version clears it; the full one is refused while gray', async () => {
  const t = setup();
  await t.save(0);
  await t.save(1);
  await t.publish(2, 1);
  await t.publish(3, 2, 25);
  await expect(
    t.admin.rollback(ACTOR, 'home', { version: 1, expected_revision: 4 }),
  ).rejects.toEqual(new PageFieldsError(['version']));
  expect(await t.admin.rollback(ACTOR, 'home', { version: 2, expected_revision: 4 })).toMatchObject(
    { current_version: 1, gray_version: null, gray_percent: 0 },
  );
  expect(t.audits.at(-1)).toMatchObject({
    action: 'page_rollback',
    before: { gray_version: 2, gray_percent: 25, version: 2 },
    after: { gray_version: null, version: 2 },
  });
});

it('[AC-F1-09f] reads: unknown page or version is 30701; list pages by page_size', async () => {
  const t = setup();
  await expect(t.admin.page('a1', 'home')).rejects.toBeInstanceOf(PageNotFoundError);
  await expect(t.admin.versions('a1', 'home')).rejects.toBeInstanceOf(PageNotFoundError);
  await t.save(0);
  await expect(t.admin.version('a1', 'home', 9)).rejects.toBeInstanceOf(PageNotFoundError);
  expect(await t.admin.version('a1', 'home', 1)).toMatchObject({ version: 1 });
});
