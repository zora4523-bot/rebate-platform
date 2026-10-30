import { vi } from 'vitest';
import { ViewerContext, type Viewer } from '../../../../apps/api/src/modules/catalog/index.ts';
import { ParsingModule } from '../../../../apps/api/src/modules/parsing/index.ts';
import { buildApp, type HttpApp } from '../http/kit.ts';

export function viewerOf(viewer: Viewer): ViewerContext {
  return { current: async () => viewer };
}

/**
 * The frozen http kit's app with a stand-in ViewerContext among ParsingModule's own providers:
 * Nest looks there first, so it wins over any global provider of the same token. Only the viewer
 * is replaced; the request checks, the route and every other provider stay the real assembly.
 */
export async function buildViewerApp(lines: string[], context: ViewerContext): Promise<HttpApp> {
  const forRoot = ParsingModule.forRoot;
  const spy = vi.spyOn(ParsingModule, 'forRoot').mockImplementation((...args) => {
    const module = forRoot(...args);
    return {
      ...module,
      providers: [...(module.providers ?? []), { provide: ViewerContext, useValue: context }],
    };
  });
  try {
    return await buildApp(lines);
  } finally {
    spy.mockRestore();
  }
}
