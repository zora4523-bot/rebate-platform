import { unitConfig } from '../../vitest.shared.ts';

// scripts/*.test.ts cover the contract checks that read specs/ through tools/lib/yaml-lite.ts.
export default unitConfig(['src/**/*.test.ts', 'scripts/**/*.test.ts']);
