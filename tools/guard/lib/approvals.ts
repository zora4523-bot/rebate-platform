// Owner approvals (规划/11 §3.2 "批准记录", §7.3): only ops/approvals.yaml counts.
import { parseYamlLite } from '../../lib/yaml-lite.ts';

export type Approval = {
  id: number;
  row: number;
  title: string;
  granted: boolean;
  date: string;
  note: string;
};

export type ApprovalsFile = { source: string; spec_ref: string; approvals: Approval[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Parses the conventions-C10 format; throws one Error listing every problem. */
export function parseApprovals(text: string): ApprovalsFile {
  const doc = parseYamlLite(text);
  if (!isRecord(doc)) throw new Error('approvals.yaml: the document must be a mapping');
  const problems: string[] = [];
  if (typeof doc['source'] !== 'string' || doc['source'] === '') {
    problems.push('source: must be a non-empty string');
  }
  if (typeof doc['spec_ref'] !== 'string' || doc['spec_ref'] === '') {
    problems.push('spec_ref: must be a non-empty string');
  }
  const approvals: Approval[] = [];
  const list = doc['approvals'];
  if (!Array.isArray(list)) {
    problems.push('approvals: must be a list');
  } else {
    const seen = new Set<number>();
    list.forEach((raw, index) => {
      const at = `approvals[${index}]`;
      if (!isRecord(raw)) {
        problems.push(`${at}: must be a mapping`);
        return;
      }
      const before = problems.length;
      if (!isIndex(raw['id'])) problems.push(`${at}.id: must be a non-negative integer`);
      else if (seen.has(raw['id'])) problems.push(`${at}.id: duplicate id ${raw['id']}`);
      else seen.add(raw['id']);
      if (!isIndex(raw['row'])) problems.push(`${at}.row: must be a non-negative integer`);
      if (typeof raw['title'] !== 'string' || raw['title'] === '') {
        problems.push(`${at}.title: must be a non-empty string`);
      }
      if (typeof raw['granted'] !== 'boolean')
        problems.push(`${at}.granted: must be true or false`);
      if (typeof raw['date'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw['date'])) {
        problems.push(`${at}.date: must be a quoted date like "2026-10-01"`);
      }
      if (typeof raw['note'] !== 'string') problems.push(`${at}.note: must be a string`);
      if (problems.length === before) {
        approvals.push({
          id: raw['id'] as number,
          row: raw['row'] as number,
          title: raw['title'] as string,
          granted: raw['granted'] as boolean,
          date: raw['date'] as string,
          note: raw['note'] as string,
        });
      }
    });
  }
  if (problems.length > 0) {
    throw new Error(`approvals.yaml: invalid\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return { source: doc['source'] as string, spec_ref: doc['spec_ref'] as string, approvals };
}

export function findApproval(file: ApprovalsFile, id: number): Approval | null {
  return file.approvals.find((a) => a.id === id) ?? null;
}

/** True only for an entry that exists and is `granted: true`. */
export function isGranted(file: ApprovalsFile, id: number): boolean {
  return findApproval(file, id)?.granted === true;
}
