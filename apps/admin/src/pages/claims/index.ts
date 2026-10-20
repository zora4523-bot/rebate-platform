import type { ReactElement } from 'react';
import type { AccessControl } from '../../providers/access-control/index.ts';

export function ClaimsPage(props: { readonly access: AccessControl }): ReactElement {
  void props;
  throw new Error('NotImplemented: ClaimsPage');
}

export function ClaimReviewPage(props: {
  readonly access: AccessControl;
  readonly claimId: string;
}): ReactElement {
  void props;
  throw new Error('NotImplemented: ClaimReviewPage');
}
