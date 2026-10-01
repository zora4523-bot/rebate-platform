// Agent output schemas must be accepted by the structured-output endpoint (规划/11 §2.4
// "schema 写法"): every object node has `additionalProperties: false` and lists all of its
// properties in `required`; only a small keyword set is used.
const STRUCTURAL = new Set([
  'type',
  'enum',
  'properties',
  'items',
  'required',
  'additionalProperties',
]);
// Annotations that carry no validation semantics are tolerated.
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description']);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lintNode(node: unknown, at: string, problems: string[]): void {
  if (!isRecord(node)) {
    problems.push(`${at}: a schema node must be an object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!STRUCTURAL.has(key) && !ANNOTATIONS.has(key)) {
      problems.push(`${at}: keyword "${key}" is not allowed`);
    }
  }
  const type = node['type'];
  const types = Array.isArray(type) ? type : [type];
  if (type === undefined) {
    problems.push(`${at}: "type" is required`);
  } else if (!types.every((t) => typeof t === 'string' && TYPES.has(t))) {
    problems.push(`${at}: "type" has an unknown value`);
  }
  if ('enum' in node && (!Array.isArray(node['enum']) || node['enum'].length === 0)) {
    problems.push(`${at}: "enum" must be a non-empty array`);
  }

  const isObject = types.includes('object') || 'properties' in node;
  if (isObject) {
    const properties = node['properties'];
    if (node['additionalProperties'] !== false) {
      problems.push(`${at}: object must set "additionalProperties": false`);
    }
    if (!isRecord(properties)) {
      problems.push(`${at}: object must declare "properties"`);
    } else {
      const names = Object.keys(properties);
      const required = node['required'];
      if (!Array.isArray(required)) {
        problems.push(`${at}: object must list every property in "required"`);
      } else {
        const listed = new Set(required.filter((r): r is string => typeof r === 'string'));
        for (const name of names) {
          if (!listed.has(name))
            problems.push(`${at}: property "${name}" is missing from "required"`);
        }
        for (const name of listed) {
          if (!names.includes(name))
            problems.push(`${at}: "required" names unknown property "${name}"`);
        }
      }
      for (const name of names) lintNode(properties[name], `${at}.properties.${name}`, problems);
    }
  } else {
    for (const key of ['properties', 'required', 'additionalProperties']) {
      if (key in node) problems.push(`${at}: "${key}" is only valid on an object`);
    }
  }

  const isArray = types.includes('array') || 'items' in node;
  if (isArray) {
    if (!('items' in node)) problems.push(`${at}: array must declare "items"`);
    else lintNode(node['items'], `${at}.items`, problems);
  }
}

/** Returns the problems of one parsed schema document; `label` prefixes each message. */
export function lintSchema(schema: unknown, label: string): string[] {
  const problems: string[] = [];
  lintNode(schema, '$', problems);
  if (isRecord(schema) && schema['type'] !== 'object') {
    problems.push('$: the root of an output schema must be an object');
  }
  return problems.map((p) => `${label}: ${p}`);
}
