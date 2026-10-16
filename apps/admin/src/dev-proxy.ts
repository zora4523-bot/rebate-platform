export function devProxy(
  target: string | undefined,
): Record<string, { target: string; changeOrigin: true }> | undefined {
  void target;
  throw new Error('NotImplemented: devProxy');
}
