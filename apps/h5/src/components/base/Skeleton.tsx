import type { CSSProperties, ReactElement } from 'react';

export interface SkeletonProps {
  width: CSSProperties['width'];
  height: CSSProperties['height'];
}

/** Busy wrapper contains one aria-hidden block with data-slot="skeleton-block". */
export function Skeleton({ width, height }: SkeletonProps): ReactElement {
  return (
    <div aria-busy="true">
      <div
        data-slot="skeleton-block"
        aria-hidden="true"
        className="rounded-couli-small bg-couli-background-placeholder motion-safe:animate-pulse"
        style={{ width, height }}
      />
    </div>
  );
}
