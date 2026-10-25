// 不连库的常量、合成 xlsx / multipart 与假端口；连库的夹具在 db-kit.ts，数据库生命周期只在 *.int.test.ts
// 管理。取值依据：契约 adminCreateRightsImport / adminListRightsImports / adminGetRightsImport（CT-24n）、
// 迁移 0084（rights_imports / rights_import_failures）、08 BR-FUND-06 细则「维权导入任务」、任务书补充
// （复用 order-sync 队列、任务名 rights_import；表头模板待负责人样例 K-3，测试用合成表头注入登记）。
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import type {
  RightsImportProcessors,
  RightsImportRow,
  RightsImportRowProcessor,
  RightsImportTaskInfo,
  RightsImportTemplate,
  RightsImportTemplates,
} from '../../../../apps/api/src/modules/orders/application/rights-import-ports.ts';
import type {
  RightsImportFailureReason,
  RightsImportKind,
  RightsImportRowOutcome,
} from '../../../../apps/api/src/modules/orders/domain/rights-import.ts';
import { QUEUE_CATALOG } from '../../../../apps/api/src/modules/platform/queue/catalog.ts';
import type {
  JobPayload,
  JobQueue,
  ReceivedJob,
  SendOptions,
} from '../../../../apps/api/src/modules/platform/queue/types.ts';
import { validateSend } from '../../../../apps/api/src/modules/platform/queue/validation.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

/** 契约：xlsx 至多 1 万行。 */
export const MAX_ROWS = 10_000;
/** orders 自有队列与本任务的任务名（任务书补充第 5 条；不新建队列）。 */
export const QUEUE = 'order-sync';
export const JOB = 'rights_import';
export const AUDIT_ACTION = 'rights_import_create';
export const NOW = '2026-10-22T02:00:00.000Z';
export const FILENAME = '维权单-private-filename.xlsx';
/** 文件里的一格私密内容：不得进日志、任务载荷或审计。 */
export const PRIVATE_CELL = 'private-cell-plain-plain';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const fieldsError = (...fields: string[]) => ({ code: 20001, data: { fields } });

/** 合成表头（K-3 之前没有真实模板）：模板列名 → 文件里的表头文字。 */
export const TEMPLATE: RightsImportTemplate = {
  columns: { sub_order_id: '子订单号（合成）', expect: '期望结果（合成）' },
};
export const HEADER = ['子订单号（合成）', '期望结果（合成）', '备注（合成）'] as const;

// ---------------------------------------------------------------- xlsx（真实 zip 字节，不用写库）

const escapeXml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function column(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function sheetXml(rows: readonly (readonly (string | null)[])[]): string {
  const body = rows
    .map((cells, r) => {
      const xml = cells
        .map((cell, c) =>
          cell === null
            ? ''
            : `<c r="${column(c)}${r + 1}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`,
        )
        .join('');
      return `<row r="${r + 1}">${xml}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

/** A plain zip (deflate entries, UTF-8 names), as any spreadsheet program writes one. */
export function zip(files: readonly { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const packed = deflateRawSync(file.data);
    const crc = crc32(file.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** One-sheet xlsx with inline strings; `null` leaves the cell empty. Row 1 is whatever comes first. */
export function xlsx(rows: readonly (readonly (string | null)[])[]): Buffer {
  const text = (value: string) => Buffer.from(value, 'utf8');
  return zip([
    {
      name: '[Content_Types].xml',
      data: text(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: text(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: text(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: text(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>',
      ),
    },
    { name: 'xl/worksheets/sheet1.xml', data: text(sheetXml(rows)) },
  ]);
}

/** Header plus one data row per expectation: [sub-order, expectation, the private note]. */
export function sheet(expectations: readonly string[], header: readonly string[] = HEADER) {
  return xlsx([header, ...expectations.map((e, i) => [`SUB-${i + 1}`, e, PRIVATE_CELL])]);
}

/** Header plus `count` data rows that all succeed. */
export function rowsSheet(count: number) {
  return sheet(Array.from({ length: count }, () => 'succeeded'));
}

/** Bytes that are certainly not an xlsx: a PNG signature with some data after it. */
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(PRIVATE_CELL),
]);

export const upload = (bytes: Buffer, filename = FILENAME) => ({
  bytes: new Uint8Array(bytes),
  filename,
  mimetype: XLSX_MIME,
});

// ---------------------------------------------------------------- multipart wire bytes

const BOUNDARY = 'couli-b1-09g-boundary';
export const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;

export type Part =
  | { readonly name: string; readonly value: string }
  | { readonly name: string; readonly file: Buffer; readonly filename?: string };

/** Real wire bytes of a multipart/form-data body (no FormData, no plugin mock). */
export function multipart(parts: readonly Part[]): Buffer {
  return Buffer.concat([
    ...parts.flatMap((part) => {
      const disposition = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"`;
      if ('file' in part) {
        const head =
          `${disposition}; filename="${part.filename ?? 'import.xlsx'}"\r\n` +
          `Content-Type: ${XLSX_MIME}\r\n\r\n`;
        return [Buffer.from(head, 'utf8'), part.file, Buffer.from('\r\n')];
      }
      return [Buffer.from(`${disposition}\r\n\r\n${part.value}\r\n`, 'utf8')];
    }),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ]);
}

/** The text parts of a form plus its file. */
export function form(fields: Readonly<Record<string, string>>, file?: Buffer): Part[] {
  return [
    ...Object.entries(fields).map(([name, value]) => ({ name, value })),
    ...(file === undefined ? [] : [{ name: 'file', file, filename: 'import.xlsx' }]),
  ];
}

// ---------------------------------------------------------------- queue

export interface Sent {
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
  readonly options: SendOptions;
  /** Whether the task row was visible on the send's own transaction (same-transaction enqueue). */
  readonly rowVisible: boolean;
}

/**
 * A JobQueue that applies the platform's own send checks (validateSend over the catalog spec of the
 * queue: job name rule, payload rule, singletonKey of an exclusive queue) and records every send.
 */
export function fakeQueue() {
  const sent: Sent[] = [];
  const queue: JobQueue = {
    async send(name, job, payload, options) {
      const spec = QUEUE_CATALOG.find((q) => q.name === name);
      expect(spec, `queue ${name} is in the platform catalog`).toBeDefined();
      validateSend(spec!, job, payload, options);
      const importId = payload['import_id'];
      let rowVisible = false;
      if (options.trx !== null && typeof importId === 'string') {
        const trx = options.trx as Transaction<DB>;
        const rows = await trx
          .selectFrom('rights_imports')
          .select('id')
          .where('id', '=', importId)
          .execute();
        rowVisible = rows.length === 1;
      }
      sent.push({ queue: name, name: job, payload: structuredClone(payload), options, rowVisible });
      return randomUUID();
    },
  };
  return { queue, sent };
}

/** The job the worker would receive for one recorded send. */
export function received(send: Sent, attempt = 1): ReceivedJob {
  return Object.freeze({
    id: randomUUID(),
    queue: send.queue,
    name: send.name,
    payload: structuredClone(send.payload),
    attempt,
  });
}

// ---------------------------------------------------------------- processors and templates

/** `succeeded`, `skipped`, `duplicate` or `failed:<reason>` in the expectation column. */
export function outcomeOf(expectation: unknown): RightsImportRowOutcome {
  if (expectation === 'succeeded' || expectation === 'skipped' || expectation === 'duplicate') {
    return { kind: expectation };
  }
  const reason = String(expectation).replace(/^failed:/, '') as RightsImportFailureReason;
  return { kind: 'failed', reason };
}

export interface ProcessorCall {
  readonly kind: RightsImportKind;
  readonly task: RightsImportTaskInfo;
  readonly row: RightsImportRow;
}

/** One fake processor per kind (or only `kinds`): answers what the row's expectation says. */
export function fakeProcessors(
  kinds: readonly RightsImportKind[] = ['rights', 'punish', 'channel'],
  during?: (call: ProcessorCall) => Promise<void>,
) {
  const calls: ProcessorCall[] = [];
  const make = (kind: RightsImportKind): RightsImportRowProcessor => ({
    process: vi.fn(async (task: RightsImportTaskInfo, row: RightsImportRow) => {
      const call = { kind, task, row };
      calls.push(call);
      await during?.(call);
      return outcomeOf(row.values['expect']);
    }),
  });
  const processors = Object.fromEntries(kinds.map((k) => [k, make(k)])) as RightsImportProcessors;
  return { processors, calls };
}

/** A registry with the synthetic template under the given (kind, platform) pairs. */
export function templates(
  entries: readonly (readonly [RightsImportKind, string])[] = [
    ['rights', 'taobao'],
    ['punish', 'taobao'],
    ['channel', 'taobao'],
  ],
  template: RightsImportTemplate = TEMPLATE,
) {
  const registered = new Set(entries.map(([kind, platform]) => `${kind}:${platform}`));
  return {
    find: vi.fn<RightsImportTemplates['find']>((kind, platform) =>
      registered.has(`${kind}:${platform}`) ? template : undefined,
    ),
  } satisfies RightsImportTemplates;
}

// ---------------------------------------------------------------- contract

const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
interface Document {
  components: { schemas: Record<string, JsonSchema> };
}
let document: Promise<Document> | undefined;
function contract(): Promise<Document> {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Document>;
  };
  document ??= parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  return document;
}

/** Asserts `value` against a component schema of contracts/openapi.yaml. */
export async function conforms(value: unknown, name: string): Promise<void> {
  const schema = (await contract()).components.schemas[name];
  expect(schema, `schema ${name}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
}

/** Content of a byte view, comparable whatever its class (Buffer or a plain Uint8Array). */
export const hex = (bytes: Uint8Array | null | undefined) =>
  bytes === null || bytes === undefined ? bytes : Buffer.from(bytes).toString('hex');

export const ms = (value: string | Date | null | undefined) =>
  value === null || value === undefined ? null : new Date(value).getTime();

export type Db = Kysely<DB>;
