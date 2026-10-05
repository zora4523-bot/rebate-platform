import type { QueryClient } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';

export { useQueryClient } from '@tanstack/react-query';

export function createQueryClient(): QueryClient {
  throw new Error('NotImplemented: createQueryClient');
}

export function createQueryProvider(children: ReactNode, client: QueryClient): ReactElement {
  void children;
  void client;
  throw new Error('NotImplemented: createQueryProvider');
}
