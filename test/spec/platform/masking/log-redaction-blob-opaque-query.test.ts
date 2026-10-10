// Contract addendum Q, supplementary cases (B1-01zq; source: couli-runs followups INDEX F-23):
// a blob: URL object whose inner part is not itself an absolute URL never writes its own query
// string or fragment.
//
// Rule Q is stated in the header comment of log-redaction-host-blob.test.ts (and of
// apps/api/src/modules/platform/logging/redaction.ts): wherever addendum M writes a URL object, a
// blob: URL is written as "blob:" followed by INNER; when new URL(url.pathname) throws, INNER is
// PATH (addendum M) applied to url.pathname, and "the query string and the fragment of the blob:
// URL itself are never written (as in G)". The cases in log-redaction-host-blob.test.ts that carry
// a query string and a fragment all have an absolute inner URL, so an implementation that appended
// url.search / url.hash only on the opaque branch would pass them; the cases below pin that branch
// (both parts, only "?", only "#", personal data in the query or fragment, personal data in the
// path next to them, a blob: inside a blob:). Expected values are written by hand per Q. This file
// covers URL objects only: a plain string such as 'blob:foo?x=1#h' is free text under the
// original contract and is not a URL object, so Q does not apply to it.
//
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  PinoNestLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { REDACTED, SAMPLES, capture, expectLine, snapshotOf } from './kit.ts';

/** pino's typings reject non-string messages; its runtime accepts them. */
type LooseLog = (...args: unknown[]) => void;

function loose(logger: RootLogger): LooseLog {
  return logger.info.bind(logger) as LooseLog;
}

/** blob: inputs (as given to new URL) whose inner part is not an absolute URL, and how Q writes them. */
const CASES = {
  both: ['blob:foo?x=1#h', 'blob:foo'],
  queryOnly: ['blob:foo?x=1', 'blob:foo'],
  fragmentOnly: ['blob:foo#h', 'blob:foo'],
  emptyParts: ['blob:foo?#', 'blob:foo'],
  pathPhone: [`blob:foo/u/${SAMPLES.phone}?x=1#h`, `blob:foo/u/${REDACTED}`],
  bareNumber: [`blob:${SAMPLES.phone}?x=1#h`, `blob:${REDACTED}`],
  queryPersonal: [`blob:null/abc?u=${SAMPLES.phone}#${SAMPLES.alipayEmail}`, 'blob:null/abc'],
  nested: ['blob:blob:foo?x=1#h', 'blob:blob:foo'],
} as const;

type CaseName = keyof typeof CASES;

const NAMES = Object.keys(CASES) as CaseName[];

function blob(name: CaseName): URL {
  return new URL(CASES[name][0]);
}

function written(name: CaseName): string {
  return CASES[name][1];
}

it('[AC-B1-01zq#1] 日志（补充 Q，补漏 F-23）：内层不是绝对 URL 的 blob: URL 对象作为结构化字段写出时不带查询串与片段——两者都有、只有 ?、只有 #、空的 ? 与 #、嵌套 blob:', () => {
  const key = (name: CaseName): string => `${name}_link`;
  const record = Object.fromEntries(NAMES.map((name) => [key(name), blob(name)]));
  const before = NAMES.map((name) => snapshotOf(record[key(name)] as URL));
  const { logger, lines } = capture();
  logger.info(record, 'opaque blobs');
  expect(lines).toHaveLength(1);
  expectLine(lines[0], {
    level: 30,
    ...Object.fromEntries(NAMES.map((name) => [key(name), written(name)])),
    msg: 'opaque blobs',
  });
  // The caller's URL objects are not modified.
  expect(NAMES.map((name) => snapshotOf(record[key(name)] as URL))).toEqual(before);
});

it('[AC-B1-01zq#2] 日志（补充 Q，补漏 F-23）：内层不是绝对 URL 的 blob: 路径里的手机号形状数字串整段替换为 [REDACTED]，查询串与片段里的号码、邮箱不写出', () => {
  const { logger, lines } = capture();
  logger.info(
    {
      links: [blob('pathPhone'), blob('bareNumber'), blob('queryPersonal')],
      nested: { deep: { target: blob('pathPhone') } },
    },
    'personal',
  );
  expect(lines).toHaveLength(1);
  expectLine(lines[0], {
    level: 30,
    links: [written('pathPhone'), written('bareNumber'), written('queryPersonal')],
    nested: { deep: { target: written('pathPhone') } },
    msg: 'personal',
  });
});

it('[AC-B1-01zq#3] 日志（补充 Q，补漏 F-23）：printf 的 %s、%j、%O 参数与 Nest 适配器参数里内层不是绝对 URL 的 blob: URL 同样不带查询串与片段', () => {
  const { logger, lines } = capture();
  loose(logger)('a %s b %j c %O', blob('both'), [blob('pathPhone')], blob('fragmentOnly'));
  const nest = new PinoNestLogger(logger);
  nest.warn('upload', blob('queryOnly'), { link: blob('queryPersonal') }, 'Upload');
  expect(lines).toHaveLength(2);
  expectLine(lines[0], {
    level: 30,
    msg: `a ${written('both')} b ["${written('pathPhone')}"] c '${written('fragmentOnly')}'`,
  });
  expectLine(lines[1], {
    level: 40,
    context: 'Upload',
    params: [written('queryOnly'), { link: written('queryPersonal') }],
    msg: 'upload',
  });
});
