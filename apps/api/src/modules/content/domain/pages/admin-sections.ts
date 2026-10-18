// F1-09f: the console's page save / publish checks around the two validators (编排者裁定 7, F5):
// contracts/home-schema.json (shape, via Ajv; its errors become dotted paths here) plus F1-09c
// validatePageSections (jump targets, data sources). Two rules the schema cannot express are
// checked here (CT-07a C5 / C6): section ids unique per page, and an unregistered section type is
// refused on save. Pure: the caller supplies the Ajv errors and the registered types.

/** The parts of an Ajv error this file reads (keyword, JSON-pointer instancePath, params). */
export interface ShapeIssue {
  readonly keyword: string;
  readonly instancePath: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * Ajv errors → `data.fields` paths, as platform's request validation names them: the pointer
 * segments unescaped and joined with '.', plus `missingProperty` of a `required` error and
 * `additionalProperty` of an `additionalProperties` error. Wrapper errors that only repeat their
 * branches' own errors (`if` → "must match then", a `oneOf` that no branch passed) are dropped.
 */
export function shapeIssueFields(issues: readonly ShapeIssue[]): string[] {
  const fields: string[] = [];
  for (const issue of issues) {
    if (issue.keyword === 'if') continue;
    if (issue.keyword === 'oneOf' && issue.params['passingSchemas'] === null) continue;
    const segments =
      issue.instancePath === ''
        ? []
        : issue.instancePath
            .slice(1)
            .split('/')
            .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    const property =
      issue.keyword === 'required'
        ? issue.params['missingProperty']
        : issue.keyword === 'additionalProperties'
          ? issue.params['additionalProperty']
          : undefined;
    if (typeof property === 'string') segments.push(property);
    fields.push(segments.length > 0 ? segments.join('.') : 'sections');
  }
  return fields;
}

/** Duplicate section ids (the later occurrences) and unregistered section types. */
export function sectionEnvelopeFields(
  sections: unknown,
  registeredTypes: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(sections)) return ['sections'];
  const fields: string[] = [];
  const ids = new Set<string>();
  sections.forEach((section: unknown, index) => {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) return;
    const { id, type } = section as { id?: unknown; type?: unknown };
    if (typeof id === 'string') {
      if (ids.has(id)) fields.push(`sections.${index}.id`);
      ids.add(id);
    }
    if (typeof type === 'string' && !registeredTypes.has(type)) {
      fields.push(`sections.${index}.type`);
    }
  });
  return fields;
}

/** Concatenates the lists, keeping each path once in first-seen order. */
export function mergeFields(...lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())];
}
