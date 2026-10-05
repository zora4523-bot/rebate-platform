// Build-time helpers shared by the spec generators. Never imported at run time.
import { fileURLToPath } from 'node:url';
import { parse } from '@readme/openapi-parser';

/** Parse one YAML file as plain data, keeping key and list order; no $ref resolution. */
export async function parseSpecYaml(inputFile: URL): Promise<Record<string, unknown>> {
  const value: unknown = await parse(fileURLToPath(inputFile));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fileURLToPath(inputFile)}: top level must be a mapping`);
  }
  return value as Record<string, unknown>;
}

export function fail(file: URL, message: string): never {
  throw new Error(`${fileURLToPath(file)}: ${message}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Emit the generated module text: the parsed value as-is, with no imports (the runtime interface
 * in the sibling module checks it where the getter returns it, without an import cycle).
 */
export function renderModule(options: {
  readonly source: string;
  readonly script: string;
  readonly exportName: string;
  readonly value: unknown;
}): string {
  return (
    `// Generated from ${options.source} by platform/specs/scripts/${options.script}.\n` +
    '// Do not edit by hand. Regenerate after changing the specification.\n' +
    `export const ${options.exportName} = ${JSON.stringify(options.value, null, 2)} as const;\n`
  );
}
