// The protected-paths CI workflow cannot check out the repository (规划/11 §4.4), so it embeds a
// copy of protected-paths.json and a copy of lib/owner-approval.mjs (the owner-approval label
// check that guard-git and evidence-check import). This check keeps both copies identical to
// their sources.
export const EMBED_BEGIN = '# BEGIN protected-paths.json';
export const EMBED_END = '# END protected-paths.json';
export const SCRIPT_BEGIN = '// BEGIN owner-approval.mjs';
export const SCRIPT_END = '// END owner-approval.mjs';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Parses the JSON between the marker lines of the workflow text. The lines may be indented
 * (inside a YAML block scalar) and may all carry a leading `# `.
 */
export function extractEmbedded(workflow: string): unknown {
  const lines = workflow.split(/\r?\n/);
  const begins = lines.flatMap((l, i) => (l.trim() === EMBED_BEGIN ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === EMBED_END ? [i] : []));
  const begin = begins[0];
  const end = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || begin === undefined || end === undefined) {
    throw new Error(`each of "${EMBED_BEGIN}" and "${EMBED_END}" must appear exactly once`);
  }
  if (end < begin) throw new Error('the END marker comes before the BEGIN marker');
  let body = lines.slice(begin + 1, end).filter((l) => l.trim() !== '');
  if (body.length === 0) throw new Error('nothing between the markers');
  if (body.every((l) => l.trimStart().startsWith('#'))) {
    body = body.map((l) => l.trimStart().replace(/^# ?/, ''));
  }
  try {
    return JSON.parse(body.join('\n')) as unknown;
  } catch (err) {
    throw new Error(
      `the embedded block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Problems found when comparing the embedded copy with the parsed source file. */
export function compareEmbedded(source: unknown, workflow: string): string[] {
  let embedded: unknown;
  try {
    embedded = extractEmbedded(workflow);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  return canonical(embedded) === canonical(source)
    ? []
    : ['the embedded copy differs from tools/guard/protected-paths.json'];
}

/**
 * The lines between the script marker lines of the workflow text, with the indentation of the
 * BEGIN line removed (the copy sits inside a YAML block scalar).
 */
export function extractEmbeddedScript(workflow: string): string {
  const lines = workflow.split(/\r?\n/);
  const begins = lines.flatMap((l, i) => (l.trim() === SCRIPT_BEGIN ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === SCRIPT_END ? [i] : []));
  const begin = begins[0];
  const end = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || begin === undefined || end === undefined) {
    throw new Error(`each of "${SCRIPT_BEGIN}" and "${SCRIPT_END}" must appear exactly once`);
  }
  if (end < begin) throw new Error('the script END marker comes before the BEGIN marker');
  const indent = (lines[begin] ?? '').length - (lines[begin] ?? '').trimStart().length;
  const body = lines.slice(begin + 1, end).map((line) => {
    if (line.trim() === '') return '';
    if (line.length - line.trimStart().length < indent) {
      throw new Error(`a line of the embedded script is indented less than its BEGIN marker`);
    }
    return line.slice(indent);
  });
  return body.join('\n');
}

/** Problems found when comparing the embedded script with the text of its source file. */
export function compareEmbeddedScript(source: string, workflow: string): string[] {
  let embedded: string;
  try {
    embedded = extractEmbeddedScript(workflow);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  const normal = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return normal(embedded) === normal(source)
    ? []
    : ['the embedded copy differs from tools/guard/lib/owner-approval.mjs'];
}
