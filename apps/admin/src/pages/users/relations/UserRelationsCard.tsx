// 「上级与直推」卡（design-hifi AdmUserDetail）：当前上级来自 adminGetUser 的 inviter_user_id
// （无上级如实显示）；契约没有的绑定方式、绑定时间、直推人数不显示。【改上级】只对持 user.inviter
// 的账号显示，【查看直推名单】对持 user.lookup 或 user.list 的账号显示。对话框与抽屉关闭后焦点回
// 触发按钮。
import { SafetyOutlined } from '@ant-design/icons';
import { Button, Card, Descriptions, Flex, theme } from 'antd';
import { useRef, useState, type ReactElement } from 'react';
import { usersTexts } from '../../../texts/users.ts';
import { InviteesDrawer } from './InviteesDrawer.tsx';
import { InviterChangeDialog } from './InviterChangeDialog.tsx';
import type { UserRelationsCardProps } from './types.ts';

const t = usersTexts.relations;

export function UserRelationsCard({
  user,
  access,
  onOpenUser,
  onUserChange,
}: UserRelationsCardProps): ReactElement {
  const { token } = theme.useToken();
  const canChange = access.can('user.inviter');
  const canList = access.can('user.lookup') || access.can('user.list');
  const [changing, setChanging] = useState(false);
  const [listing, setListing] = useState(false);
  const changeTrigger = useRef<HTMLButtonElement>(null);
  const listTrigger = useRef<HTMLButtonElement>(null);
  const inviter = user.inviter_user_id;
  const code = { fontFamily: token.fontFamilyCode } as const;

  const actions =
    canChange || canList ? (
      <Flex gap={12} wrap>
        {canChange ? (
          <Button
            ref={changeTrigger}
            type="link"
            size="small"
            icon={<SafetyOutlined aria-hidden />}
            style={{ paddingInline: 0 }}
            onClick={() => setChanging(true)}
          >
            {t.changeInviter}
          </Button>
        ) : null}
        {canList ? (
          <Button
            ref={listTrigger}
            type="link"
            size="small"
            style={{ paddingInline: 0 }}
            onClick={() => setListing(true)}
          >
            {t.viewInvitees}
          </Button>
        ) : null}
      </Flex>
    ) : null;

  return (
    <Card title={t.title} extra={actions}>
      <Descriptions
        layout="vertical"
        colon={false}
        column={4}
        items={[
          {
            key: 'inviter',
            label: t.currentInviter,
            children:
              inviter === null ? (
                t.noInviter
              ) : (
                <Button
                  type="link"
                  size="small"
                  style={{
                    paddingInline: 0,
                    height: 'auto',
                    whiteSpace: 'normal',
                    wordBreak: 'break-all',
                    textAlign: 'start',
                    textDecoration: 'underline',
                    ...code,
                  }}
                  onClick={() => onOpenUser(inviter)}
                >
                  {inviter}
                </Button>
              ),
          },
        ]}
      />
      {canChange ? (
        <InviterChangeDialog
          user={user}
          open={changing}
          onClose={() => setChanging(false)}
          onUserChange={onUserChange}
          afterClose={() => changeTrigger.current?.focus()}
        />
      ) : null}
      {canList ? (
        <InviteesDrawer
          userId={user.user_id}
          open={listing}
          onClose={() => setListing(false)}
          onOpenUser={onOpenUser}
          afterClose={() => listTrigger.current?.focus()}
        />
      ) : null}
    </Card>
  );
}
