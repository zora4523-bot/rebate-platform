import { malformed } from './errors.ts';
import type { SseChunkParser } from './types.ts';

/** 传输边界与 SSE 行边界无关；支持 LF、CRLF、CR 和多行 data。 */
export function createSseChunkParser(): SseChunkParser {
  let line = '';
  let data: string[] = [];
  let size = 0;
  let afterCr = false;
  let started = false;
  let finished = false;
  let ended = false;
  const dispatch = (chunks: unknown[]): void => {
    if (data.length === 0) return;
    const payload = data.join('\n');
    data = [];
    size = 0;
    if (payload.trim() === '[DONE]') {
      finished = true;
      return;
    }
    try {
      chunks.push(JSON.parse(payload) as unknown);
    } catch {
      throw malformed();
    }
  };
  const consumeLine = (chunks: unknown[]): void => {
    if (line === '') dispatch(chunks);
    else if (line === 'data' || line.startsWith('data:')) {
      let value = line === 'data' ? '' : line.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      data.push(value);
      size += value.length + 1;
    }
    line = '';
  };
  return {
    get finished() {
      return finished;
    },
    push(text) {
      if (finished || ended) return [];
      const chunks: unknown[] = [];
      for (const char of text) {
        if (!started) {
          started = true;
          if (char === '\uFEFF') continue;
        }
        if (afterCr) {
          afterCr = false;
          if (char === '\n') continue;
        }
        if (char === '\r' || char === '\n') {
          consumeLine(chunks);
          afterCr = char === '\r';
          if (finished) break;
        } else {
          line += char;
        }
        // 限制单事件缓冲，防止无分隔符响应无限占用内存。
        if (line.length + size > 1024 * 1024) throw malformed();
      }
      return chunks;
    },
    end() {
      if (finished || ended) return [];
      ended = true;
      const chunks: unknown[] = [];
      if (line !== '') consumeLine(chunks);
      dispatch(chunks);
      return chunks;
    },
  };
}
