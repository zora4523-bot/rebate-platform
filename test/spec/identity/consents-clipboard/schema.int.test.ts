// Query the migrated database as couli_app. This deliberately does not inspect SQL spelling
// or depend on a migration number. Assert the column before using it: baseline red is an
// assertion failure, never PostgreSQL's undefined-column error.
import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedUser } from '../registration/kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 }).withSchema('app');
}, 180_000);
afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

it('[AC-B1-02zc#20] version_label 为可空 text；设备剪贴板与其他类型的配对约束拒绝所有非法组合', async () => {
  const columns = await sql<{ column_name: string; data_type: string; is_nullable: string }>`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'consent_records'
      AND column_name IN ('version', 'version_label') ORDER BY column_name
  `.execute(db);
  expect(columns.rows).toEqual([
    { column_name: 'version', data_type: 'integer', is_nullable: 'NO' },
    { column_name: 'version_label', data_type: 'text', is_nullable: 'YES' },
  ]);
  const appId = `clipboard_${randomUUID().replaceAll('-', '')}`;
  const userId = await seedUser(db, appId);
  const deviceId = randomUUID();
  const at = new Date('2026-10-18T00:00:00Z');
  await db
    .insertInto('devices')
    .values({
      id: deviceId,
      app_id: appId,
      device_hash: randomBytes(32).toString('hex'),
      id_source: 'idfv',
      install_secret_cipher: Buffer.from('fixture-not-used-for-signing'),
      platform: 'ios',
      app_version: '2.0.0',
      last_seen_at: at,
    })
    .execute();
  // Supply BOTH subject identifiers: a rejection must come from the new pairing rule,
  // not the existing non-null subject check. Labor's existing required fields are valid too.
  async function insert(type: string, subject: string, version: number, label: string | null) {
    return sql<{ id: bigint; version: number; version_label: string | null }>`
      INSERT INTO app.consent_records
        (app_id, subject_type, user_id, device_id, type, version, version_label,
         accepted, channel, client_at, server_at, created_at, text_sha256, signer_snapshot)
      VALUES (${appId}, ${subject}, ${userId}, ${deviceId}, ${type}, ${version}, ${label},
        true, ${type === 'labor_agreement' ? 'withdraw_flow' : 'privacy_center'},
        ${at}, ${at}, ${at}, ${type === 'labor_agreement' ? 'a'.repeat(64) : null},
        ${type === 'labor_agreement' ? '{}' : null}::jsonb)
      RETURNING id, version, version_label
    `.execute(db);
  }

  let validCount = 0;
  for (const subject of ['device', 'user']) {
    for (const version of [0, 1, -1]) {
      for (const label of [null, '2026-10-17']) {
        if (subject === 'device' && version === 0 && label !== null) {
          const result = await insert('clipboard_auto_import', subject, version, label);
          expect(result.rows).toEqual([
            expect.objectContaining({ version: 0, version_label: label }),
          ]);
          validCount++;
        } else {
          await expect(
            insert('clipboard_auto_import', subject, version, label),
          ).rejects.toMatchObject({ code: '23514' });
        }
      }
    }
  }
  for (const type of [
    'privacy',
    'agreement',
    'ai_third_party',
    'id_verification',
    'personalization',
    'labor_agreement',
  ]) {
    for (const subject of type === 'labor_agreement' ? ['user'] : ['device', 'user']) {
      const result = await insert(type, subject, 3, null);
      expect(result.rows).toEqual([expect.objectContaining({ version: 3, version_label: null })]);
      validCount++;
      await expect(insert(type, subject, 3, '2026-10-17')).rejects.toMatchObject({ code: '23514' });
    }
  }
  expect(
    await db.selectFrom('consent_records').selectAll().where('app_id', '=', appId).execute(),
  ).toHaveLength(validCount);

  // Omitting the new nullable column keeps existing integer writers compatible.
  const legacy = await db
    .insertInto('consent_records')
    .values({
      app_id: appId,
      subject_type: 'device',
      device_id: deviceId,
      type: 'privacy',
      version: 1,
      channel: 'first_launch',
      accepted: true,
      client_at: at,
      server_at: at,
      created_at: at,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  expect(legacy).toMatchObject({ version: 1, version_label: null });
});
