import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export async function columns(db: Kysely<DB>, table: string) {
  return (
    await sql<{
      name: string;
      type: string;
      nullable: boolean;
      expression: string | null;
      identity: string;
      generated: string;
    }>`SELECT column_name AS name, udt_name AS type, is_nullable = 'YES' AS nullable,
      column_default AS expression, is_identity AS identity, is_generated AS generated
    FROM information_schema.columns WHERE table_schema = 'app' AND table_name = ${table}
  `.execute(db)
  ).rows;
}

export async function constraints(db: Kysely<DB>, table: string) {
  return (
    await sql<{
      name: string;
      kind: string;
      keys: string[];
      target_schema: string | null;
      target: string | null;
      target_keys: string[];
      target_kind: string | null;
      on_update: string;
      on_delete: string;
      validated: boolean;
      definition: string;
    }>`SELECT c.conname AS name, c.contype::text AS kind,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) k(num)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num) AS keys,
    n.nspname AS target_schema, t.relname AS target, t.relkind::text AS target_kind,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) k(num)
      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num) AS target_keys,
    c.confupdtype::text AS on_update, c.confdeltype::text AS on_delete,
    c.convalidated AS validated, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c LEFT JOIN pg_class t ON t.oid = c.confrelid
    LEFT JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype IN ('p','u','f','c')
  `.execute(db)
  ).rows;
}

export async function indexes(db: Kysely<DB>, table: string) {
  return (
    await sql<{
      name: string;
      keys: string[];
      descending: string[];
      predicate: string | null;
      valid: boolean;
      ready: boolean;
      unique: boolean;
    }>`SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready,
      i.indisunique AS unique, pg_get_expr(i.indpred, i.indrelid) AS predicate,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.pos <= i.indnkeyatts) AS keys,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.pos <= i.indnkeyatts AND (i.indoption[(k.pos - 1)::int] & 1) = 1) AS descending
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = to_regclass(${`app.${table}`})`.execute(db)
  ).rows;
}
