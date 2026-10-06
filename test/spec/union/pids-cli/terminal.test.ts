import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { expect, it, vi } from 'vitest';
import { readHiddenCode } from '../../../../apps/api/scripts/union-pids.ts';
import { CODE } from './kit.ts';

function terminal(initialRaw = false) {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: initialRaw });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  const printed: string[] = [];
  output.on('data', (chunk: Buffer) => {
    printed.push(chunk.toString('utf8'));
  });
  const setRawMode = vi.fn((raw: boolean) => {
    input.isRaw = raw;
    return input;
  });
  Object.assign(input, { setRawMode });
  return {
    input,
    output,
    printed,
    setRawMode,
    read: () => readHiddenCode(input as unknown as ReadStream, output as unknown as WriteStream),
    close: () => {
      input.destroy();
      output.destroy();
    },
  };
}

it.each([false, true])(
  '[AC-B1-19c#16] 输入不回显，结束后恢复原 raw=%s 并释放输入监听',
  async (initialRaw) => {
    const f = terminal(initialRaw);
    const counts = ['data', 'end', 'error'].map((event) => f.input.listenerCount(event));
    try {
      const reading = f.read();
      queueMicrotask(() => {
        f.input.write(`${CODE}\r`);
      });
      expect(await reading).toBe(CODE);
      expect(f.printed.join('')).not.toContain(CODE);
      expect(f.printed.join('')).not.toMatch(/[0278]/);
      expect(f.setRawMode).toHaveBeenCalledWith(true);
      expect(f.input.isRaw).toBe(initialRaw);
      expect(['data', 'end', 'error'].map((event) => f.input.listenerCount(event))).toEqual(counts);
    } finally {
      f.close();
    }
  },
  2_000,
);

it('[AC-B1-19c#17] 分块输入与退格只修改内存缓冲，不能打印输入片段', async () => {
  const f = terminal();
  try {
    const reading = f.read();
    queueMicrotask(() => {
      f.input.write('28709');
      f.input.write('\u007f82');
      f.input.write('\n');
    });
    expect(await reading).toBe(CODE);
    expect(f.printed.join('')).not.toMatch(/[02789]/);
    expect(f.input.isRaw).toBe(false);
  } finally {
    f.close();
  }
}, 2_000);

it.each(['interrupt', 'eot', 'eof'] as const)(
  '[AC-B1-19c#18] %s 丢弃半截动态码，恢复终端并结束等待',
  async (mode) => {
    const f = terminal();
    try {
      const reading = f.read();
      queueMicrotask(() => {
        f.input.write('287');
        if (mode === 'eof') f.input.end();
        else f.input.write(mode === 'interrupt' ? '\u0003' : '\u0004');
      });
      expect(await reading).toBeNull();
      expect(f.printed.join('')).not.toContain('287');
      expect(f.input.isRaw).toBe(false);
      expect(f.input.listenerCount('data')).toBe(0);
    } finally {
      f.close();
    }
  },
  2_000,
);

it.each(['input', 'output'] as const)(
  '[AC-B1-19c#19] %s 不是终端时不从管道取码',
  async (side) => {
    const f = terminal();
    f[side].isTTY = false;
    try {
      expect(await f.read()).toBeNull();
      expect(f.setRawMode).not.toHaveBeenCalled();
      expect(f.input.listenerCount('data')).toBe(0);
    } finally {
      f.close();
    }
  },
  2_000,
);
