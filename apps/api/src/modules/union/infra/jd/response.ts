// 京东联盟网关响应解包与错误分类（B1-04za）。规则测试：test/spec/union/jd-core/response.test.ts、
// lossless.test.ts。外层键与结果键由调用方按接口登记，不由方法名推导；内层 code 决定成败。
// 骨架：实现阶段补函数体。
import type { UnionErrorCode } from '../../domain/types.ts';
import type { UnionTransportResponse } from '../replay.ts';

/** Sent once for gateway code 28 and inner code 403; carries only the method and the code text. */
export interface JdWarning {
  readonly method: string;
  readonly code: string;
}

/** Per-method refinement of the inner code (string form); rate limiting is judged first. */
export type JdInnerCodeMap = Readonly<Record<string, UnionErrorCode>>;

/** The keys registered for one method; never derived from the method name. */
export interface JdResponseKeys {
  /** The outer `*_responce` key. */
  readonly envelope: string;
  /** The outer key holding the inner JSON string (queryResult / getResult …). */
  readonly resultKey: string;
}

/** The parsed inner object: every JSON number in it, at any depth, is a JdRawNumber. */
export type JdInner = Readonly<Record<string, unknown>>;

/** A JSON number of the inner result as its exact source text; it never passes through a number. */
export class JdRawNumber {
  declare readonly text: string;

  constructor(text: string) {
    void text;
    throw new Error('NotImplemented: JdRawNumber');
  }
}

/** Internal gateway decoder, not a product / order / link DTO mapper. */
export function unwrapJdResponse(
  method: string,
  keys: JdResponseKeys,
  response: UnionTransportResponse,
  warn?: (event: JdWarning) => void,
  innerCodes?: JdInnerCodeMap,
): JdInner {
  void method;
  void keys;
  void response;
  void warn;
  void innerCodes;
  throw new Error('NotImplemented: unwrapJdResponse');
}
