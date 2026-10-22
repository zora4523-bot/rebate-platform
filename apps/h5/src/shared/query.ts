import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';

export { useQueryClient } from '@tanstack/react-query';

/** One client per mounted shell; nothing is shared between entries or pages loaded twice. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // No blind retries: the API client owns the single token replay, pages act on ApiError.action.
      mutations: { retry: false },
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
}

export function createQueryProvider(children: ReactNode, client: QueryClient): ReactElement {
  return createElement(QueryClientProvider, { client }, children);
}

/**
 * Account switch or logout: cancel every query first (a response that arrives later is dropped
 * by its cancelled fetch), then clear all queries and mutations, active or not.
 */
export function clearAccountData(client: QueryClient): void {
  void client.cancelQueries();
  client.clear();
}
