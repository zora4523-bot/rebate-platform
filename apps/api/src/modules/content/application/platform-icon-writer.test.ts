import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { PlatformIconFieldsError, type PlatformIconVersionRow } from './platform-icon-reader.ts';
import {
  PlatformIconConflictError,
  PlatformIconWriter,
  transitionAction,
  type PlatformIconMarkState,
  type PlatformIconNewVersion,
  type PlatformIconUploadState,
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
  saving: {
    upload?: PlatformIconUploadState;
    saved?: PlatformIconVersionRow;
    latest?: number;
  } = {},
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
    upload: vi.fn(() => Promise.resolve(saving.upload)),
    savedVersion: vi.fn(() => Promise.resolve(saving.saved)),
    latestVersion: vi.fn(() => Promise.resolve(saving.latest ?? 0)),
    insertVersion: vi.fn((input: PlatformIconNewVersion) =>
      Promise.resolve(
        versionRow({
          version: input.version,
          sanitized: input.sanitized,
          sourceUrl: input.sourceUrl,
          downloadedOn: input.downloadedOn,
          revision: 1,
          createdBy: input.editor.loginName,
          createdAt: input.editor.at,
        }),
      ),
    ),
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

const UPLOAD_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';

function staged(patch: Partial<PlatformIconUploadState> = {}): PlatformIconUploadState {
  return {
    appId: 'app',
    key: 'jd',
    sha256: 'a'.repeat(64),
    format: 'svg',
    bytes: 10,
    sanitized: false,
    expiresAt: new Date('2026-10-17T00:00:00.000Z'),
    ...patch,
  };
}

const unlocked = { currentVersion: null, revision: 0 };

it.each([
  ['missing', undefined],
  ['other app', staged({ appId: 'other' })],
  ['other key', staged({ key: 'tmall' })],
])(
  '[AC-F1-06x#14] a %s upload is 20001 [upload_id] before the mark is locked',
  async (_n, upload) => {
    const { writer, tx } = fake(
      unlocked,
      undefined,
      undefined,
      upload === undefined ? {} : { upload },
    );
    await expect(writer.create(ACTOR, 'jd', { upload_id: UPLOAD_ID })).rejects.toMatchObject({
      fields: ['upload_id'],
    });
    expect(tx.lockMark).not.toHaveBeenCalled();
    expect(tx.insertVersion).not.toHaveBeenCalled();
  },
);

it('[AC-F1-06x#14] a malformed upload_id is 20001 [upload_id] before any transaction', async () => {
  const { writer, transaction, tx } = fake(unlocked, undefined, undefined, { upload: staged() });
  await expect(writer.create(ACTOR, 'jd', { upload_id: 'not-a-uuid' })).rejects.toMatchObject({
    fields: ['upload_id'],
  });
  expect(transaction).not.toHaveBeenCalled();
  expect(tx.upload).not.toHaveBeenCalled();
});

it('[AC-F1-06x#14] an unsaved upload expired at the instant is 20001 [upload_id] under the lock, nothing written', async () => {
  const { writer, tx } = fake(unlocked, undefined, undefined, {
    upload: staged({ expiresAt: AT }),
  });
  await expect(writer.create(ACTOR, 'jd', { upload_id: UPLOAD_ID })).rejects.toMatchObject({
    fields: ['upload_id'],
  });
  expect(tx.savedVersion.mock.invocationCallOrder[0]!).toBeGreaterThan(
    tx.lockMark.mock.invocationCallOrder[0]!,
  );
  expect(tx.latestVersion).not.toHaveBeenCalled();
  expect(tx.insertVersion).not.toHaveBeenCalled();
  expect(tx.touchMark).not.toHaveBeenCalled();
  expect(tx.audit).not.toHaveBeenCalled();
});

it('[AC-F1-06x#17] a retry after expires_at of an upload already saved answers the same version, no second version or audit', async () => {
  const saved = versionRow({ version: 1, revision: 1, sanitized: true });
  const { writer, tx } = fake(unlocked, undefined, undefined, {
    // Saved before expiry; the clock (AT) is now past expires_at.
    upload: staged({ sanitized: true, expiresAt: new Date(AT.getTime() - 1) }),
    saved,
  });
  const result = await writer.create(ACTOR, 'jd', {
    upload_id: UPLOAD_ID,
    sanitized_confirmed: false,
  });
  expect(result).toMatchObject({ version: 1, revision: 1 });
  expect(tx.lockMark).toHaveBeenCalledOnce();
  expect(tx.savedVersion).toHaveBeenCalledWith('app', 'jd', UPLOAD_ID);
  expect(tx.latestVersion).not.toHaveBeenCalled();
  expect(tx.insertVersion).not.toHaveBeenCalled();
  expect(tx.touchMark).not.toHaveBeenCalled();
  expect(tx.audit).not.toHaveBeenCalled();
});

it('[AC-F1-06x#17] an upload already saved answers that version under the lock, before the confirmation check', async () => {
  const saved = versionRow({ version: 4, revision: 3, everPublished: true });
  const { writer, tx } = fake(unlocked, undefined, undefined, {
    upload: staged({ sanitized: true }),
    saved,
  });
  const result = await writer.create(ACTOR, 'jd', {
    upload_id: UPLOAD_ID,
    sanitized_confirmed: false,
    source_url: 'https://ignored.example.invalid',
  });
  expect(result).toMatchObject({ version: 4, revision: 3, ever_published: true });
  expect(tx.lockMark).toHaveBeenCalledOnce();
  expect(tx.savedVersion).toHaveBeenCalledWith('app', 'jd', UPLOAD_ID);
  expect(tx.insertVersion).not.toHaveBeenCalled();
  expect(tx.touchMark).not.toHaveBeenCalled();
  expect(tx.audit).not.toHaveBeenCalled();
});

it('[AC-F1-06x#15] a sanitized upload needs sanitized_confirmed=true', async () => {
  const { writer, tx } = fake(unlocked, undefined, undefined, {
    upload: staged({ sanitized: true }),
  });
  await expect(writer.create(ACTOR, 'jd', { upload_id: UPLOAD_ID })).rejects.toMatchObject({
    fields: ['sanitized_confirmed'],
  });
  expect(tx.insertVersion).not.toHaveBeenCalled();
});

it('[AC-F1-06x#12] a new version is max + 1, a draft without registration, audited as version_create', async () => {
  const { writer, tx } = fake(unlocked, undefined, undefined, { upload: staged(), latest: 2 });
  const result = await writer.create(ACTOR, 'jd', {
    upload_id: UPLOAD_ID,
    source_url: 'https://source.example.invalid/jd',
  });
  expect(result).toMatchObject({ version: 3, revision: 1, publishable: false, created_by: 'ops' });
  expect(tx.insertVersion).toHaveBeenCalledWith(
    expect.objectContaining({
      version: 3,
      uploadId: UPLOAD_ID,
      sourceUrl: 'https://source.example.invalid/jd',
      downloadedOn: null,
      editor: { adminId: 'admin-1', loginName: 'ops', at: AT },
    }),
  );
  const order = [tx.lockMark, tx.savedVersion, tx.latestVersion, tx.insertVersion].map(
    (mock) => mock.mock.invocationCallOrder[0]!,
  );
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(tx.touchMark).toHaveBeenCalledWith('app', 'jd', expect.objectContaining({ at: AT }));
  expect(tx.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'version_create',
      target: 'platform_icons:jd',
      after: { key: 'jd', version: 3, upload_id: UPLOAD_ID },
    }),
  );
});

it('[AC-F1-06x#19] a unique conflict on upload_id answers the version that holds it', async () => {
  const saved = versionRow({ version: 1, revision: 1 });
  let attempt = 0;
  const tx = {
    savedVersion: vi.fn(() => Promise.resolve(saved)),
  } as unknown as PlatformIconWriteTx;
  const store = {
    transaction<T>(work: (t: PlatformIconWriteTx) => Promise<T>): Promise<T> {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(
          Object.assign(new Error('duplicate'), {
            code: '23505',
            constraint: 'platform_icon_versions_upload_id_key',
          }),
        );
      }
      return work(tx);
    },
  };
  const writer = new PlatformIconWriter(store, new FixedClock(AT), BASE);
  await expect(writer.create(ACTOR, 'jd', { upload_id: UPLOAD_ID })).resolves.toMatchObject({
    version: 1,
  });
  expect(attempt).toBe(2);
});
