import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

// 元数据查询不引用尚未建立的列；先红必须是断言失败，不是 SQL undefined_column。
// couli_app 没有默认分区的直接权限，information_schema 会隐藏它，故查系统目录。
export async function feeColumns(db: Kysely<DB>) {
  return (
    await sql<{
      table_name: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>`select c.relname::text as table_name, t.typname::text as udt_name,
        case when a.attnotnull then 'NO' else 'YES' end as is_nullable,
        pg_get_expr(d.adbin, d.adrelid) as column_default
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = c.oid
      join pg_catalog.pg_type t on t.oid = a.atttypid
      left join pg_catalog.pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
      where n.nspname = 'app' and c.relname in ('orders', 'orders_default')
        and a.attname = 'service_fee_fen' and a.attnum > 0 and not a.attisdropped
      order by c.relname`.execute(db)
  ).rows;
}

export async function requireFeeColumn(db: Kysely<DB>) {
  expect(await feeColumns(db)).toEqual([
    { table_name: 'orders', udt_name: 'int8', is_nullable: 'YES', column_default: null },
    { table_name: 'orders_default', udt_name: 'int8', is_nullable: 'YES', column_default: null },
  ]);
}

// 新列由编排生成类型；测试不修改生成物，也不把 bigint 转成 number。
export async function readFee(db: Kysely<DB>, appId: string) {
  return db
    .selectFrom('orders')
    .select(['order_id', sql<bigint | null>`service_fee_fen`.as('service_fee_fen')])
    .where('app_id', '=', appId)
    .orderBy('sub_order_id')
    .execute();
}

export async function setFee(db: Kysely<DB>, appId: string, value: bigint | null) {
  await sql`update app.orders set service_fee_fen = ${value}
    where app_id = ${appId}`.execute(db);
}
