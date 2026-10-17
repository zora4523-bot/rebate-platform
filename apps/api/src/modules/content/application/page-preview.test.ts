import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { FixedClock, type AuditInput } from '../../platform/index.ts';
import {
  PREVIEW_TOKEN_AUDIT_ACTION,
  PREVIEW_TOKEN_TTL_MS,
  PagePreviewFieldsError,
  PagePreviewNotFoundError,
  PagePreviewService,
  previewTokenHash,
  type PagePreviewConsumeInput,
  type PagePreviewStore,
  type PagePreviewTokenRow,
} from './page-preview.ts';

const AT = new Date('2026-10-18T01:02:03.456Z');
const ACTOR = { appId: 'app', adminId: 'admin-1', ip: '127.0.0.1' };

interface Fake {
  store: PagePreviewStore;
  tokens: PagePreviewTokenRow[];
  audits: AuditInput[];
  consumed: PagePreviewConsumeInput[];
}

function fake(
  pages: Record<string, number[]>,
  consume: (input: PagePreviewConsumeInput) => number | undefined = () => undefined,
): Fake {
  const tokens: PagePreviewTokenRow[] = [];
  const audits: AuditInput[] = [];
  const consumed: PagePreviewConsumeInput[] = [];
  const store: PagePreviewStore = {
    async transaction(work) {
      const pendingTokens: PagePreviewTokenRow[] = [];
      const pendingAudits: AuditInput[] = [];
      const result = await work({
        pageHasVersions: async (_app, key) => (pages[key] ?? []).length > 0,
        versionExists: async (_app, key, version) => (pages[key] ?? []).includes(version),
        insertToken: async (row) => void pendingTokens.push(row),
        audit: async (input) => void pendingAudits.push(input),
      });
      tokens.push(...pendingTokens);
      audits.push(...pendingAudits);
      return result;
    },
    consume: async (input) => {
      consumed.push(input);
      return consume(input);
    },
    sections: async (_app, _key, version) => [{ id: `v${version}` }],
  };
  return { store, tokens, audits, consumed };
}

it('[AC-F1-09e#u1] issues a 32-byte base64url token, stores only its sha256 and audits without it', async () => {
  const f = fake({ home: [1, 2] });
  const service = new PagePreviewService({ store: f.store, clock: new FixedClock(AT) });
  const issued = await service.issue(ACTOR, 'home', 2);
  expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(issued.token, 'base64url')).toHaveLength(32);
  const expire = new Date(AT.getTime() + PREVIEW_TOKEN_TTL_MS).toISOString();
  expect(issued).toEqual({ token: issued.token, page_key: 'home', version: 2, expire_at: expire });
  const digest = createHash('sha256').update(issued.token, 'utf8').digest('hex');
  expect(f.tokens).toEqual([
    {
      tokenHash: digest,
      appId: 'app',
      pageKey: 'home',
      version: 2,
      createdBy: 'admin-1',
      createdAt: AT,
      expireAt: new Date(AT.getTime() + 600_000),
    },
  ]);
  expect(f.audits).toHaveLength(1);
  expect(f.audits[0]).toMatchObject({
    appId: 'app',
    actor: 'admin-1',
    action: PREVIEW_TOKEN_AUDIT_ACTION,
    after: { page_key: 'home', version: 2, expire_at: expire },
    ip: '127.0.0.1',
  });
  const audited = JSON.stringify(f.audits[0]);
  expect(audited).not.toContain(issued.token);
  expect(audited).not.toContain(digest);
  const again = await service.issue(ACTOR, 'home', 2);
  expect(again.token).not.toBe(issued.token);
});

it('[AC-F1-09e#u2] unknown page is 30701, unknown version is 20001 fields=[version], nothing written', async () => {
  const f = fake({ home: [1], empty: [] });
  const service = new PagePreviewService({ store: f.store, clock: new FixedClock(AT) });
  await expect(service.issue(ACTOR, 'custom:missing', 1)).rejects.toBeInstanceOf(
    PagePreviewNotFoundError,
  );
  await expect(service.issue(ACTOR, 'empty', 1)).rejects.toBeInstanceOf(PagePreviewNotFoundError);
  const missing = service.issue(ACTOR, 'home', 2);
  await expect(missing).rejects.toBeInstanceOf(PagePreviewFieldsError);
  await expect(missing).rejects.toMatchObject({ fields: ['version'] });
  expect(f.tokens).toEqual([]);
  expect(f.audits).toEqual([]);
});

it('[AC-F1-09e#u3] read consumes by hash, page, app and the injected clock; no match is 30701', async () => {
  const clock = new FixedClock(AT);
  const f = fake({}, (input) => (input.pageKey === 'home' ? 4 : undefined));
  const service = new PagePreviewService({ store: f.store, clock });
  expect(await service.read('app', 'home', 'abc')).toEqual({
    page_key: 'home',
    version: 4,
    sections: [{ id: 'v4' }],
  });
  expect(f.consumed).toEqual([
    { appId: 'app', pageKey: 'home', tokenHash: previewTokenHash('abc'), now: AT },
  ]);
  await expect(service.read('app', 'custom:other', 'abc')).rejects.toBeInstanceOf(
    PagePreviewNotFoundError,
  );
});

it('[AC-F1-09e#u4] a short random source is refused rather than issuing a weak token', async () => {
  const f = fake({ home: [1] });
  const service = new PagePreviewService({
    store: f.store,
    clock: new FixedClock(AT),
    random: (size) => Buffer.alloc(size - 1),
  });
  await expect(service.issue(ACTOR, 'home', 1)).rejects.toThrow('too short');
  expect(f.tokens).toEqual([]);
});
