// AGENTS.md / CLAUDE.md pairing and line caps (规划/11 §5.1, §5.5).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ROOT_AGENTS_MAX_LINES = 150;
export const NESTED_AGENTS_MAX_LINES = 60;
const CLAUDE_CONTENT = '@AGENTS.md';

function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function sibling(file: string, name: string): string {
  const dir = dirname(file);
  return dir === '.' ? name : `${dir}/${name}`;
}

/**
 * `files` are repo-relative paths (node_modules, .tmp and dist are already excluded by the
 * tree listing). Returns one problem per violation.
 */
export function checkAgentsPairs(root: string, files: readonly string[]): string[] {
  const problems: string[] = [];
  const set = new Set(files);
  if (!set.has('AGENTS.md')) problems.push('AGENTS.md: the root rules file is missing');
  for (const file of files) {
    const name = file.split('/').pop();
    if (name === 'AGENTS.md') {
      const claude = sibling(file, 'CLAUDE.md');
      if (!set.has(claude)) {
        problems.push(`${file}: no sibling CLAUDE.md`);
      } else if (readFileSync(join(root, claude), 'utf8').trim() !== CLAUDE_CONTENT) {
        problems.push(`${claude}: must contain exactly one line "${CLAUDE_CONTENT}"`);
      }
      const max = file === 'AGENTS.md' ? ROOT_AGENTS_MAX_LINES : NESTED_AGENTS_MAX_LINES;
      const lines = lineCount(readFileSync(join(root, file), 'utf8'));
      if (lines > max) problems.push(`${file}: ${lines} lines, the cap is ${max}`);
    } else if (name === 'CLAUDE.md' && !set.has(sibling(file, 'AGENTS.md'))) {
      problems.push(`${file}: no sibling AGENTS.md`);
    }
  }
  return problems;
}
