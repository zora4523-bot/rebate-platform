import { expect, it, vi } from 'vitest';
import { bytes, elements, inspect, options, parse, rendered, success, svg } from './kit.ts';

it.each([8, 32])(
  '[AC-F1-06v#54] stops polling and rejects all output when the deadline expires at check %i during repeated expansion',
  (expireAt) => {
    // One reference hop, well below all non-time budgets; no cloneNode implementation hook.
    const source = svg(
      '<defs><path id="shape" d="M0 0L1 1"/></defs>' + '<use href="#shape"/>'.repeat(1024),
    );
    const baseline = parse(success(inspect(source), bytes(source)).bytes);
    expect(rendered(baseline, 'path')).toHaveLength(1024);
    expect(elements(baseline, 'use')).toHaveLength(0);

    let checks = 0;
    const remainingMs = vi.fn(() => {
      checks++;
      // A late guard must fail even if application code catches its exception.
      expect(checks).toBeLessThanOrEqual(expireAt);
      return checks < expireAt ? 1 : -1;
    });
    const result = inspect(source, { ...options(), deadline: { remainingMs } });
    expect(result).toEqual({ ok: false, reason: 'icon_svg_unconvertible' });
    expect(remainingMs).toHaveBeenCalledTimes(expireAt);
    expect(checks).toBe(expireAt);
  },
);
