import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { PlatformIconFieldsError, type PlatformIconVersionRow } from './platform-icon-reader.ts';
import {
  PlatformIconConflictError,
  PlatformIconWriter,
  transitionAction,
  type PlatformIconMarkState,
  type PlatformIconRegistration,
  type PlatformIconWriteTx,
} from './platform-icon-writer.ts';

const BASE = 'https://media.example.invalid/m/';
const AT = new Date('2026-10-16T00:00:00.000Z');
const ACTOR = { appId: 'app', adminId: 'admin-1', loginName: 'ops', ip: '127.0.0.1' };

function versionRow(patch: Partial<PlatformIconVersionRow> = {}): PlatformIconVersionRow {
  return {
    version: 1,
    sha256: 'a'.repeat(64),
    format: 'svg',
    bytes: 10,
    sanitized: true,
    sourceUrl: 'https://source.example.invalid/x',
    downloadedOn: '2026-10-01',
    everPublished: false,
    revision: 2,
    createdBy: 'ops',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...patch,
  };
}

function fake(
  mark: PlatformIconMarkState,
  registration: PlatformIconRegistration | undefined,
  updated?: PlatformIconVersionRow,
) {
  const tx = {
    lockMark: vi.fn(() => Promise.resolve(mark)),
    registration: vi.fn(() => Promise.resolve(registration)),
    updateRegistration: vi.fn(() => Promise.resolve(updated)),
    version: vi.fn(() => Promise.resolve(undefined)),
    setCurrent: vi.fn(() => Promise.resolve(true)),
    markPublished: vi.fn(() => Promise.resolve()),
    touchMark: vi.fn(() => Promise.resolve()),
    icon: vi.fn(() => Promise.resolve({ row: undefined, latestVersion: null })),
    audit: vi.fn(() => Promise.resolve()),
  } satisfies PlatformIconWriteTx;
  const transaction = vi.fn();
  const store = {
    transaction<T>(work: (t: PlatformIconWriteTx) => Promise<T>): Promise<T> {
      transaction();
      return work(tx);
    },
  };
  const writer = new PlatformIconWriter(store, new FixedClock(AT), BASE);
  return { tx, transaction, writer };
}

const registered = { hasSourceUrl: true, hasDownloadedOn: true, everPublished: false };

it('[AC-F1-06y#7] older than current is rollback, from built-in always publish, null is restore', () => {
  expect(transitionAction(2, 1)).toBe('rollback');
  expect(transitionAction(1, 2)).toBe('publish');
  expect(transitionAction(null, 1)).toBe('publish');
  expect(transitionAction(1, null)).toBe('restore_builtin');
});

it('[AC-F1-06y#16] an unknown key is 20001 [key] before any transaction', async () => {
  const { writer, transaction } = fake({ currentVersion: null, revision: 0 }, registered);
  await expect(
    writer.publish(ACTOR, 'constructor', { version: 1, expected_revision: 0 }),
  ).rejects.toMatchObject({ fields: ['key'] });
  await expect(writer.restore(ACTOR, 'TAOBAO', { expected_revision: 0 })).rejects.toBeInstanceOf(
    PlatformIconFieldsError,
  );
  expect(transaction).not.toHaveBeenCalled();
});

it('[AC-F1-06y#10] publishing the current version with a matching revision writes nothing', async () => {
  const { writer, tx } = fake({ currentVersion: 1, revision: 3 }, registered);
  await writer.publish(ACTOR, 'jd', { version: 1, expected_revision: 3 });
  expect(tx.setCurrent).not.toHaveBeenCalled();
  expect(tx.markPublished).not.toHaveBeenCalled();
  expect(tx.audit).not.toHaveBeenCalled();
});

it('[AC-F1-06y#12] a stale revision is 20902 before reading the version', async () => {
  const { writer, tx } = fake({ currentVersion: 1, revision: 3 }, registered);
  await expect(
    writer.publish(ACTOR, 'jd', { version: 1, expected_revision: 2 }),
  ).rejects.toBeInstanceOf(PlatformIconConflictError);
  await expect(writer.restore(ACTOR, 'jd', { expected_revision: 4 })).rejects.toBeInstanceOf(
    PlatformIconConflictError,
  );
  expect(tx.registration).not.toHaveBeenCalled();
  expect(tx.setCurrent).not.toHaveBeenCalled();
});

it('[AC-F1-06y#8] a draft lists every missing registration', async () => {
  const { writer, tx } = fake(
    { currentVersion: null, revision: 0 },
    { hasSourceUrl: false, hasDownloadedOn: false, everPublished: false },
  );
  await expect(
    writer.publish(ACTOR, 'jd', { version: 1, expected_revision: 0 }),
  ).rejects.toMatchObject({ fields: ['source_url', 'downloaded_on'] });
  expect(tx.setCurrent).not.toHaveBeenCalled();
});

it('[AC-F1-06y#7] a rollback bumps the revision, marks the version and audits from / to', async () => {
  const { writer, tx } = fake({ currentVersion: 3, revision: 5 }, registered);
  await writer.publish(ACTOR, 'jd', { version: 2, expected_revision: 5 });
  expect(tx.setCurrent).toHaveBeenCalledWith('app', 'jd', 5, 2, {
    adminId: 'admin-1',
    loginName: 'ops',
    at: AT,
  });
  expect(tx.markPublished).toHaveBeenCalledWith('app', 'jd', 2);
  expect(tx.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'rollback',
      actor: 'admin-1',
      after: expect.objectContaining({ key: 'jd', from_version: 3, to_version: 2, revision: 6 }),
    }),
  );
});

it('[AC-F1-06y#11] restoring a mark already on the built-in image writes nothing', async () => {
  const { writer, tx } = fake({ currentVersion: null, revision: 9 }, undefined);
  await writer.restore(ACTOR, 'jd', { expected_revision: 9 });
  expect(tx.setCurrent).not.toHaveBeenCalled();
  expect(tx.audit).not.toHaveBeenCalled();
});

it('[AC-F1-06y#3] a missed registration CAS on a published or unknown version is 20001 [version]', async () => {
  for (const registration of [undefined, { ...registered, everPublished: true }]) {
    const { writer, tx } = fake({ currentVersion: null, revision: 0 }, registration);
    await expect(
      writer.register(ACTOR, 'jd', '1', { expected_revision: 1, source_url: 'https://x.test/' }),
    ).rejects.toMatchObject({ fields: ['version'] });
    expect(tx.touchMark).not.toHaveBeenCalled();
    expect(tx.audit).not.toHaveBeenCalled();
  }
});

it('[AC-F1-06y#2] a missed registration CAS on an editable version is 20902', async () => {
  const { writer, tx } = fake({ currentVersion: null, revision: 0 }, registered);
  await expect(
    writer.register(ACTOR, 'jd', '1', { expected_revision: 1, downloaded_on: '2026-10-02' }),
  ).rejects.toBeInstanceOf(PlatformIconConflictError);
  expect(tx.lockMark).toHaveBeenCalledBefore(tx.updateRegistration);
});

it('[AC-F1-06y#1] a registration passes only the given fields and audits version_source', async () => {
  const { writer, tx } = fake(
    { currentVersion: null, revision: 0 },
    registered,
    versionRow({ revision: 6 }),
  );
  const result = await writer.register(ACTOR, 'jd', '1', {
    expected_revision: 5,
    source_url: 'https://source.example.invalid/x',
  });
  expect(tx.updateRegistration).toHaveBeenCalledWith('app', 'jd', 1, 5, {
    sourceUrl: 'https://source.example.invalid/x',
  });
  expect(tx.touchMark).toHaveBeenCalledOnce();
  expect(tx.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'version_source' }));
  expect(result).toMatchObject({
    revision: 6,
    publishable: true,
    url: `https://media.example.invalid/m/${'a'.repeat(64)}.svg`,
  });
});
