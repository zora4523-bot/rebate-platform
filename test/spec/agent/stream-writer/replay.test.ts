// B3-03a rule tests: SSE encoding and fixture replay (规划/04 §8.1 帧格式、§8.2 事件;
// contracts/agent-stream.schema.json; contracts/fixtures/agent-streams/*.ndjson). Each run fixture
// is written through StreamWriter (data without seq, pings where the fixture has them) and the
// output, read back as SSE, must be the fixture again. Top-level it() only.
import { expect, it } from 'vitest';
import {
  createFrameValidator,
  encodeFrame,
  encodePing,
  StreamWriter,
  type StreamEvent,
} from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';
import {
  frameIsValid,
  inputOf,
  META,
  readFixture,
  readSse,
  recordingSink,
  RUN_FIXTURES,
} from './kit.ts';

it('[04 §8.1 帧格式] encodeFrame：event、id、data 三行按此顺序，空行结束，data 是一行 JSON', () => {
  const data = { finish_reason: 'stop', quota_left: 29 };
  const text = encodeFrame({ event: 'done', id: 10, data });
  const lines = text.split('\n');
  expect(lines).toHaveLength(5);
  expect(lines.slice(0, 2)).toEqual(['event: done', 'id: 10']);
  expect(lines[2]?.startsWith('data: ')).toBe(true);
  expect(JSON.parse(lines[2]!.slice('data: '.length))).toEqual(data);
  expect(lines.slice(3)).toEqual(['', '']);
});

it('[04 §8.1 帧格式] 文本含 CR、LF、CRLF、U+2028 时 data 仍是一行，读回原文不变', () => {
  const delta = '第一行\n第二行\r第三行\r\n第四行\u2028第五行';
  const text = encodeFrame({ event: 'text.delta', id: 3, data: { seq: 3, delta } });
  expect(text).not.toMatch(/\r/);
  expect(text.split('\n')).toHaveLength(5);
  expect(readSse(text)).toEqual([{ event: 'text.delta', id: 3, data: { seq: 3, delta } }]);
});

it('[04 §8.1 心跳] encodePing 是注释行 `: ping` 加空行，不是帧（无 event、无 id）', () => {
  expect(encodePing()).toBe(': ping\n\n');
});

it('[04 §8.1–8.2 样例回放] 10 个 run 样例经 StreamWriter 写出后逐帧与样例相同（含 ping 位置）', () => {
  for (const name of RUN_FIXTURES) {
    // Expected: a fresh read of the fixture that the writer never sees.
    const expected = readFixture(name);
    const sink = recordingSink();
    const writer = new StreamWriter({ sink });
    for (const line of readFixture(name)) {
      if ('comment' in line) writer.ping();
      else writer.emit(line.event as StreamEvent, inputOf(line) as never);
    }
    expect(readSse(sink.chunks.join('')), name).toEqual(expected);
  }
});

it('[04 §8.1–8.2 样例回放] 回放写出的每一帧都通过 agent-stream.schema.json 校验；终止帧有且只有一个且在最后', () => {
  for (const name of RUN_FIXTURES) {
    const sink = recordingSink();
    const writer = new StreamWriter({ sink });
    for (const line of readFixture(name)) {
      if ('comment' in line) writer.ping();
      else writer.emit(line.event as StreamEvent, inputOf(line) as never);
    }
    const frames = readSse(sink.chunks.join('')).filter((line) => !('comment' in line));
    for (const frame of frames)
      expect(frameIsValid(frame), `${name} ${JSON.stringify(frame)}`).toBe(true);
    const terminals = frames.filter(
      (frame) => 'event' in frame && ['done', 'error'].includes(frame.event),
    );
    // disconnected 是断线样例，没有终止帧（contracts/README.md）。
    expect(terminals.length, name).toBe(name === 'disconnected' ? 0 : 1);
    expect(writer.closed, name).toBe(name !== 'disconnected');
    if (terminals.length === 1) expect(frames.at(-1), name).toBe(terminals[0]);
  }
});

it('[04 §8.1 逐帧校验] createFrameValidator 默认读契约 schema：样例帧全部通过，形状不符的帧不通过并给出原因', () => {
  const validate = createFrameValidator();
  for (const name of RUN_FIXTURES) {
    for (const line of readFixture(name)) {
      if (!('comment' in line)) expect(validate(line), `${name} ${line.id}`).toEqual({ ok: true });
    }
  }
  const bad = [
    { event: 'done', id: 1, data: { finish_reason: 'ok', quota_left: 1 } },
    { event: 'text.delta', id: 2, data: { seq: 2, delta: '' } },
    { event: 'meta', id: 0, data: { ...META, extra: 1 } },
    { event: 'progress', id: 3, data: {} },
  ];
  for (const frame of bad) {
    const result = validate(frame);
    expect(result.ok, JSON.stringify(frame)).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  }
});
