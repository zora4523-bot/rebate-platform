import type { ReactElement } from 'react';
import type { Schema } from '@couli/contracts-ts';
import type { AccessControl } from '../../providers/access-control/index.ts';

export interface UserRelationsCardProps {
  readonly user: Schema<'AdminUserDetail'>;
  readonly access: AccessControl;
  readonly onOpenUser: (userId: string) => void;
  readonly onUserChange: (user: Schema<'AdminUserDetail'>) => void;
}

export interface RelationChangeDialogProps {
  readonly user: Schema<'AdminUserDetail'>;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onUserChange: (user: Schema<'AdminUserDetail'>) => void;
}

export interface InviteesDrawerProps {
  readonly userId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenUser: (userId: string) => void;
}

export function UserRelationsCard(props: UserRelationsCardProps): ReactElement {
  void props;
  throw new Error('NotImplemented: UserRelationsCard');
}

export function LevelChangeDialog(props: RelationChangeDialogProps): ReactElement {
  void props;
  throw new Error('NotImplemented: LevelChangeDialog');
}

export function InviterChangeDialog(props: RelationChangeDialogProps): ReactElement {
  void props;
  throw new Error('NotImplemented: InviterChangeDialog');
}

export function InviteesDrawer(props: InviteesDrawerProps): ReactElement {
  void props;
  throw new Error('NotImplemented: InviteesDrawer');
}
