import { expect, vi } from 'vitest';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { TRACE } from '../errors/kit.ts';

// Exercise the real global filter with an in-memory HTTP host; no server or port is needed.
// The computed import keeps Nest decorators out of the erasable-only spec TS project.
export async function expectRequestFailure(
  operation: () => unknown,
  logger: RootLogger,
): Promise<void> {
  let failure: unknown;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  expect(failure, '媒体操作必须失败，不能返回伪造地址或成功结果').toBeInstanceOf(Error);

  const { GlobalErrorFilter } = (await import(
    new URL('../../../../apps/api/src/modules/platform/http/global-errors.ts', import.meta.url).href
  )) as {
    GlobalErrorFilter: new (
      adapter: object,
      logger: RootLogger,
    ) => {
      catch(error: unknown, host: object): void;
    };
  };
  const request = { id: TRACE };
  const response = {};
  const reply = vi.fn();
  const filter = new GlobalErrorFilter({ reply, isHeadersSent: () => false, end: vi.fn() }, logger);
  filter.catch(failure, {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getArgByIndex: (index: number) => [request, response][index],
  });
  expect(reply).toHaveBeenCalledExactlyOnceWith(
    response,
    expect.objectContaining({ code: 50001, trace_id: TRACE }),
    500,
  );
}
