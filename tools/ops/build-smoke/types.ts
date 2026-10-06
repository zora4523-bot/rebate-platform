export type BuildSmokeEntries = Record<
  'app' | 'landing' | 'conformance' | 'admin',
  { url: string; distDir: string }
>;

declare module 'vitest' {
  interface ProvidedContext {
    buildSmoke: { entries: BuildSmokeEntries };
  }
}
