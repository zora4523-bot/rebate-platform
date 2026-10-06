// B3-03a rule tests: seq, meta first, one terminal frame, frame-by-frame schema check (规划/04
// §8.1 「seq 在 run 内自增；done 与 error 是唯一终止事件」, §8.2; contracts/agent-stream.schema.json:
// seq ≥ 1, meta is the first frame). Top-level it() only.
import { expect, it } from 'vitest';
import {
  StreamProtocolError,
  StreamWriter,
  type FrameValidator,
  type StreamEvent,
  type StreamFrame,
  type StreamProtocolErrorCode,
} from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';
import { inputOf, META, readFixture, readSse, recordingSink } from './kit.ts';

const TOOL = { tool: 'search_products', phase: 'start', display_text: '正在查询京东商品' } as const;
const DONE = { finish_reason: 'stop', quota_left: 29 } as const;
const ERROR = {
  code: 50302,
  msg: 'AI 暂不可用，可以先用搜索找货',
  retryable: true,
  fallback: 'search_page',
};

function refused(action: () => unknown, code: StreamProtocolErrorCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(StreamProtocolError);
  expect((caught as StreamProtocolError).code).toBe(code);
}

it('[04 §8.1 seq] seq 从 1 起每帧加 1，id = seq；text.delta、tool.status、card 的 data.seq 等于 id，其余事件不带 seq', () => {
  const sink = recordingSink();
  const writer = new StreamWriter({ sink });
  expect(writer.seq).toBe(0);
  const card = {
    card_id: 'c1',
    type: 'future_card',
    schema_version: 2,
    data: { x: 1 },
    fallback_text: '请升级',
  };
  const frames: StreamFrame[] = [
    writer.emit('meta', META),
    writer.emit('tool.status', TOOL),
    writer.emit('text.delta', { delta: '为你找到' }),
    writer.emit('card', card),
    writer.emit('suggestions', { items: [{ text: '换一批', send_text: '请换一批商品' }] }),
    writer.emit('done', DONE),
  ];
  expect(frames.map((frame) => frame.id)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(writer.seq).toBe(6);
  expect(frames.map((frame) => frame.data['seq'])).toEqual([
    undefined,
    2,
    3,
    4,
    undefined,
    undefined,
  ]);
  expect(readSse(sink.chunks.join(''))).toEqual(frames);
});

it('[04 §8.1 心跳] ping 不占 seq：ping 前后两帧 id 连续，ping 写出 `: ping`', () => {
  const sink = recordingSink();
  const writer = new StreamWriter({ sink });
  writer.emit('meta', META);
  writer.ping();
  writer.ping();
  expect(writer.emit('text.delta', { delta: '好的' }).id).toBe(2);
  expect(sink.chunks.slice(1, 3)).toEqual([': ping\n\n', ': ping\n\n']);
});

it('[04 §8.1 帧格式] 每帧、每个 ping 各用一次 sink.write 写出完整一块，帧之间不会被拆开或拼接', () => {
  const sink = recordingSink();
  const writer = new StreamWriter({ sink });
  writer.emit('meta', META);
  writer.emit('text.delta', { delta: '多行\n文本' });
  writer.ping();
  writer.emit('done', DONE);
  expect(sink.chunks).toHaveLength(4);
  for (const chunk of sink.chunks) expect(readSse(chunk)).toHaveLength(1);
});

it('[contracts meta 为首帧] meta 之前的任何帧被拒（meta_order）、不写出、不占 seq；meta 只能写一次', () => {
  const sink = recordingSink();
  const writer = new StreamWriter({ sink });
  refused(() => writer.emit('text.delta', { delta: '早到的文本' }), 'meta_order');
  refused(() => writer.emit('done', DONE), 'meta_order');
  expect(sink.chunks).toEqual([]);
  expect(writer.closed).toBe(false);
  expect(writer.emit('meta', META).id).toBe(1);
  refused(() => writer.emit('meta', META), 'meta_order');
  expect(writer.emit('done', DONE).id).toBe(2);
  expect(sink.chunks).toHaveLength(2);
});

it('[04 §8.1 唯一终止事件] done 之后再写 done、error、其他事件或 ping 都被拒（stream_closed），一个字节也不写', () => {
  for (const terminal of ['done', 'error'] as const) {
    const sink = recordingSink();
    const writer = new StreamWriter({ sink });
    writer.emit('meta', META);
    expect(writer.closed).toBe(false);
    if (terminal === 'done') writer.emit('done', DONE);
    else writer.emit('error', ERROR);
    expect(writer.closed).toBe(true);
    const written = sink.chunks.join('');
    refused(() => writer.emit('done', DONE), 'stream_closed');
    refused(() => writer.emit('error', ERROR), 'stream_closed');
    refused(() => writer.emit('text.delta', { delta: '迟到' }), 'stream_closed');
    refused(() => writer.emit('meta', META), 'stream_closed');
    refused(() => writer.ping(), 'stream_closed');
    expect(sink.chunks.join(''), terminal).toBe(written);
    expect(writer.seq, terminal).toBe(2);
  }
});

it('[04 §8.1 逐帧校验] 形状不符契约的帧被拒（invalid_frame）：不写出、不占 seq、流不关闭，之后的合法帧 id 连续', () => {
  const invalid: [StreamEvent, unknown][] = [
    ['text.delta', { delta: '' }],
    ['tool.status', { ...TOOL, phase: 'running' }],
    ['tool.status', { ...TOOL, args: { keyword: '原文' } }],
    [
      'card',
      {
        card_id: 'c1',
        type: 'notice',
        schema_version: 1,
        data: { level: 'loud' },
        fallback_text: '提示',
      },
    ],
    [
      'card',
      { card_id: 'c1', type: 'future_card', schema_version: 1, data: {}, fallback_text: '' },
    ],
    [
      'suggestions',
      { items: [1, 2, 3, 4].map((n) => ({ text: `追问${n}`, send_text: `追问${n}` })) },
    ],
    ['error', { ...ERROR, code: 999 }],
    ['done', { finish_reason: 'ok', quota_left: 1 }],
    ['done', { finish_reason: 'stop', quota_left: -1 }],
    ['progress' as StreamEvent, { percent: 50 }],
  ];
  const sink = recordingSink();
  const writer = new StreamWriter({ sink });
  writer.emit('meta', META);
  for (const [event, data] of invalid) {
    refused(() => writer.emit(event, data as never), 'invalid_frame');
    expect(writer.closed, JSON.stringify(data)).toBe(false);
  }
  expect(sink.chunks).toHaveLength(1);
  expect(writer.seq).toBe(1);
  expect(writer.emit('text.delta', { delta: '继续' }).id).toBe(2);
  expect(writer.emit('done', DONE).id).toBe(3);
});

it('[contracts 未知卡片] 未注册的卡片类型只校验外壳，data 原样写出', () => {
  const sink = recordingSink();
  const writer = new StreamWriter({ sink });
  writer.emit('meta', META);
  const data = { future_field: { nested: ['未来扩展字段'] } };
  const card = {
    card_id: 'c1',
    type: 'future_card',
    schema_version: 2,
    data,
    fallback_text: '请升级',
  };
  writer.emit('card', card);
  expect(readSse(sink.chunks.join(''))[1]).toEqual({
    event: 'card',
    id: 2,
    data: { seq: 2, ...card },
  });
});

it('[04 §8.1 逐帧校验] 写出前把完整的帧（含 id 与 data.seq）交给校验器；校验器拒绝时不写出', () => {
  const seen: unknown[] = [];
  let accept = true;
  const validator: FrameValidator = (frame) => {
    seen.push(structuredClone(frame));
    return accept ? { ok: true } : { ok: false, errors: ['rejected by test'] };
  };
  const sink = recordingSink();
  const writer = new StreamWriter({ sink, validator });
  writer.emit('meta', META);
  writer.emit('text.delta', { delta: '你好' });
  expect(seen).toEqual(readSse(sink.chunks.join('')));
  accept = false;
  refused(() => writer.emit('done', DONE), 'invalid_frame');
  expect(seen.at(-1)).toEqual({ event: 'done', id: 3, data: DONE });
  expect(sink.chunks).toHaveLength(2);
  expect(writer.closed).toBe(false);
});

it('[04 §8.2] 写出不改调用方传入的 data 对象（seq 只加在写出的帧上）', () => {
  const writer = new StreamWriter({ sink: recordingSink() });
  writer.emit('meta', META);
  const input = { delta: '原样' };
  const frame = writer.emit('text.delta', input);
  expect(input).toEqual({ delta: '原样' });
  expect(frame.data).toEqual({ seq: 2, delta: '原样' });
});

it('[04 §8.2 卡片] 嵌套卡片数据（商品列表 items、价格）不被改动：调用方对象与写出的帧都等于原样例', () => {
  // Expected: an independent read of the fixture; the input is a separate deep copy.
  const pristine = readFixture('normal').find((line) => 'event' in line && line.event === 'card');
  const source = readFixture('normal').find((line) => 'event' in line && line.event === 'card');
  if (
    pristine === undefined ||
    !('event' in pristine) ||
    source === undefined ||
    !('event' in source)
  )
    throw new Error('normal.ndjson has no card frame');
  const input = inputOf(source);
  const untouched = structuredClone(input);
  const sink = recordingSink();
  const writer = new StreamWriter({ sink });
  writer.emit('meta', META);
  for (let n = 2; n < pristine.id; n += 1) writer.emit('text.delta', { delta: `占位${n}` });
  const frame = writer.emit('card', input as never);
  expect(input).toEqual(untouched);
  expect(frame).toEqual(pristine);
  expect(readSse(sink.chunks.join('')).at(-1)).toEqual(pristine);
});
