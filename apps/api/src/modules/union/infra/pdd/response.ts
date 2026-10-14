import type { UnionTransportResponse } from '../replay.ts';

/** Deliberately contains neither credentials nor upstream message/request contents. */
export interface PddWarning {
  readonly error_code: string;
  readonly type: string;
}

/** Internal gateway envelope decoder, not a product/order DTO mapper. */
export function unwrapPddResponse(
  method: string,
  response: UnionTransportResponse,
  warn?: (event: PddWarning) => void,
): unknown {
  void method;
  void response;
  void warn;
  throw new Error('NotImplemented: unwrapPddResponse');
}
