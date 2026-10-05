import { mergeConfig } from 'vitest/config';
import { unitConfig } from '../../vitest.shared.ts';

// Component tests (.test.tsx) run in jsdom; JSX follows tsconfig.json (`jsx: react-jsx`).
export default mergeConfig(unitConfig(['src/**/*.test.{ts,tsx}']), {
  test: { environment: 'jsdom' },
});
