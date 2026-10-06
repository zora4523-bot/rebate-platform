import type { TestProject } from 'vitest/node';

export default function setup(project: TestProject): never {
  void project;
  throw new Error('NotImplemented: setup');
}
