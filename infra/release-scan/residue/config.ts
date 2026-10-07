import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';
import { defaultDetectOptions } from '../detect/index.ts';
import type { ApprovalRecord, ClientPlatform, DetectOptions } from '../detect/index.ts';

export interface Arguments {
  path: string;
  platform: ClientPlatform;
  manifest: string;
  approvals: string;
  release: boolean;
  routes: string | URL;
  thresholds: DetectOptions;
}

export function readArguments(argv: readonly string[]): Arguments {
  const invalid = (): never => {
    throw new Error('Invalid scan arguments');
  };
  const values = new Map<string, string>();
  let path: string | undefined;
  let release = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--release') {
      if (release) invalid();
      release = true;
    } else if (
      [
        '--platform',
        '--manifest',
        '--approvals',
        '--routes',
        '--min-length',
        '--min-entropy',
      ].includes(arg)
    ) {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith('--') || values.has(arg)) invalid();
      values.set(arg, value!);
    } else if (arg.startsWith('-') || path !== undefined || !arg.trim()) invalid();
    else path = arg;
  }
  const platform = values.get('--platform');
  const manifest = values.get('--manifest');
  const approvals = values.get('--approvals');
  if (
    !path ||
    !platform ||
    !['ios', 'android', 'harmony', 'h5', 'admin'].includes(platform) ||
    !manifest ||
    !approvals
  )
    return invalid();
  const thresholds = defaultDetectOptions();
  for (const [flag, key] of [
    ['--min-length', 'minLength'],
    ['--min-entropy', 'minEntropy'],
  ] as const) {
    const value = values.get(flag);
    if (value === undefined) continue;
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) invalid();
    const n = Number(value);
    if (
      !Number.isFinite(n) ||
      n < 0 ||
      n > thresholds[key] ||
      (key === 'minLength' && (!Number.isSafeInteger(n) || n < 1))
    )
      invalid();
    thresholds[key] = n;
  }
  return {
    path,
    platform: platform as ClientPlatform,
    manifest,
    approvals,
    release,
    routes: values.get('--routes') ?? new URL('../../../contracts/routes.json', import.meta.url),
    thresholds,
  };
}

export function readApprovals(yaml: string): ApprovalRecord[] {
  const root = parseYamlLite(yaml) as { approvals?: unknown } | null;
  if (!root || !Array.isArray(root.approvals)) throw new Error('Invalid approvals');
  const seen = new Set<number>();
  return root.approvals.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid approval');
    const { id, granted } = value as Record<string, unknown>;
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id < 0 ||
      seen.has(id) ||
      typeof granted !== 'boolean'
    )
      throw new Error('Invalid approval');
    seen.add(id);
    return { id, granted };
  });
}
