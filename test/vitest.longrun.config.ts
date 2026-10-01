import { longrunConfig } from '../vitest.shared.ts';

// Long-run property tier (规划/11 §3.2, §4.2): run with PROP_RUNS=1000000.
export default longrunConfig(['properties/**/*.test.ts']);
