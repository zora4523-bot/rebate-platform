import type { CSSProperties, ReactElement } from 'react';

export interface SkeletonProps {
  width: CSSProperties['width'];
  height: CSSProperties['height'];
}

/** Busy wrapper contains one aria-hidden block with data-slot="skeleton-block". */
export function Skeleton(props: SkeletonProps): ReactElement {
  void props;
  throw new Error('NotImplemented: Skeleton');
}
