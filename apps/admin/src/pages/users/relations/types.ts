import type { AccessControl } from '../../../providers/access-control/index.ts';
import type { UserDetail } from '../model.ts';

export interface UserRelationsCardProps {
  readonly user: UserDetail;
  readonly access: AccessControl;
  readonly onOpenUser: (userId: string) => void;
  readonly onUserChange: (user: UserDetail) => void;
}

export interface RelationChangeDialogProps {
  readonly user: UserDetail;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onUserChange: (user: UserDetail) => void;
  /** 关闭动画结束后调用（触发按钮据此取回焦点）。 */
  readonly afterClose?: () => void;
}

export interface InviteesDrawerProps {
  readonly userId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenUser: (userId: string) => void;
  /** 关闭动画结束后调用（触发按钮据此取回焦点）。 */
  readonly afterClose?: () => void;
}
