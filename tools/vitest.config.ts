// Unit tests for everything under tools/ (lib, guard, ops, agent, ci).
// Protected path, class 2 (verify config): changing it needs owner approval (规划/11 §4.4).
import { mergeConfig } from 'vitest/config';
import { unitConfig } from '../vitest.shared.ts';

// Many of these tests start child processes (git, node, bash, perl). Under load, for example
// inside the verify container or while turbo runs every package in parallel, the 5 s default
// was exceeded at integration (2 of 3 container runs), so the per-test limit is raised here.
export default mergeConfig(unitConfig(['**/*.test.ts']), { test: { testTimeout: 30_000 } });
