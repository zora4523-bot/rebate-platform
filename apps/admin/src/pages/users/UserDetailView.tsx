// User detail (design-hifi AdmUserDetail): the masked projection of GET /admin/v1/users/{user_id}
// (basic information and read-only union bindings) and 【查看】 for the full phone number:
// reason → totp step-up (/admin/v1/auth/step-up) → one POST …/reveal with X-Step-Up-Token. The
// full number lives in this view's memory only: leaving the view (or opening another user)
// drops it, and a late answer for a view that is gone is ignored.
import type { Schema } from '@couli/contracts-ts';
import { ArrowLeftOutlined, EyeOutlined, SafetyOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Result,
  Table,
  Tag,
  Typography,
  theme,
  type DescriptionsProps,
  type TableColumnsType,
} from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import { createAccessControl, type AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { usersTexts } from '../../texts/users.ts';
import {
  beijingTime,
  bindingStatusLabel,
  bindingTagColor,
  blockedReasonLabel,
  platformLabel,
  readFailure,
  registerMethodLabel,
  revealErrorText,
  type UnionBinding,
  type UserDetail,
} from './model.ts';
import { ReasonModal } from './ReasonModal.tsx';
import { LevelChangeDialog, UserRelationsCard } from './relations.ts';
import { RiskTag } from './RiskTag.tsx';

const t = usersTexts.detail;
const STEP_UP_URL = '/admin/v1/auth/step-up';
const USERS_URL = '/admin/v1/users';

export interface UserDetailViewProps {
  readonly userId: string;
  /** The user as the lookup returned it (no second read). */
  readonly initial?: UserDetail | undefined;
  readonly canReveal: boolean;
  /**
   * 【调等级】【改上级】【查看直推名单】按权限点显示；不传时（顶栏搜索打开的详情）这些入口都不
   * 显示，只读展示当前上级。
   */
  readonly access?: AccessControl | undefined;
  readonly onBack: () => void;
  readonly onOpenUser: (userId: string) => void;
}

type LoadStatus = 'loading' | 'ready' | 'failed' | 'forbidden' | 'missing';

type RevealPhase = 'idle' | 'reason' | 'verify' | 'revealing';

interface Reveal {
  readonly phase: RevealPhase;
  readonly reason: string;
  /** The last reveal was refused for its step-up token (10003): verify again, then resend. */
  readonly again: boolean;
}

const IDLE: Reveal = { phase: 'idle', reason: '', again: false };

/** 没有传入权限时：关系区的读写入口一律不显示。 */
const NO_ACCESS = createAccessControl({ isSuper: false, permissions: [] });

export function UserDetailView({
  userId,
  initial,
  canReveal,
  access = NO_ACCESS,
  onBack,
  onOpenUser,
}: UserDetailViewProps): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [user, setUser] = useState<UserDetail | undefined>(initial);
  const [status, setStatus] = useState<LoadStatus>(initial === undefined ? 'loading' : 'ready');
  const [attempt, setAttempt] = useState(0);
  const [reveal, setRevealState] = useState<Reveal>(IDLE);
  const [phone, setPhone] = useState<string>();
  const [revealError, setRevealError] = useState<string>();
  const revealRef = useRef<Reveal>(IDLE);
  // Bumped on unmount: answers for a view that is gone never show.
  const alive = useRef(0);

  const setReveal = useCallback((next: Reveal) => {
    revealRef.current = next;
    setRevealState(next);
  }, []);

  const customOf = () => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
  };

  useEffect(() => {
    const generation = alive.current;
    return () => {
      if (alive.current === generation) alive.current += 1;
    };
  }, []);

  useEffect(() => {
    if (status !== 'loading') return;
    let current = true;
    getProvider()
      .getOne<UserDetail>({ resource: 'users', id: userId })
      .then(
        (response) => {
          if (!current) return;
          setUser(response.data);
          setStatus('ready');
        },
        (cause: unknown) => {
          if (!current) return;
          setStatus(readFailure(cause));
        },
      );
    return () => {
      current = false;
    };
    // `attempt` re-runs the read after 【重试】.
  }, [getProvider, userId, attempt, status]);

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const startReveal = () => {
    if (revealRef.current.phase !== 'idle') return;
    setRevealError(undefined);
    setReveal({ ...IDLE, phase: 'reason' });
  };

  const cancelReveal = () => {
    if (revealRef.current.phase === 'revealing') return;
    setReveal(IDLE);
  };

  const verifyCode = async (code: string): Promise<StepUpResult> => {
    const request: Schema<'AdminStepUpRequest'> = { tier: 'totp', code };
    try {
      const response = await customOf()<Schema<'AdminStepUpResponse'>['data']>({
        url: STEP_UP_URL,
        method: 'post',
        payload: request,
      });
      return { ok: true, stepUpToken: response.data.step_up_token };
    } catch (cause) {
      if (cause instanceof AdminApiError)
        return cause.retryAfterSeconds === undefined
          ? { ok: false, code: cause.code }
          : { ok: false, code: cause.code, retryAfterSeconds: cause.retryAfterSeconds };
      return { ok: false, code: 0 };
    }
  };

  const send = async (target: Reveal, stepUpToken: string): Promise<void> => {
    const generation = alive.current;
    const payload: Schema<'AdminUserRevealRequest'> = { field: 'phone', reason: target.reason };
    try {
      const response = await customOf()<Schema<'AdminUserRevealResponse'>['data']>({
        url: `${USERS_URL}/${encodeURIComponent(userId)}/reveal`,
        method: 'post',
        payload,
        meta: { stepUpToken },
      });
      if (generation !== alive.current) return;
      setPhone(response.data.value);
      setReveal(IDLE);
    } catch (cause) {
      if (generation !== alive.current) return;
      if (cause instanceof AdminApiError && cause.code === 10003) {
        // The token was not accepted: verify again (never resend the old token), then resend.
        setReveal({ ...target, phase: 'verify', again: true });
        return;
      }
      setReveal(IDLE);
      setRevealError(revealErrorText(cause));
    }
  };

  const onVerified = (stepUpToken: string) => {
    const current = revealRef.current;
    if (current.phase !== 'verify') return;
    const sending: Reveal = { ...current, phase: 'revealing' };
    setReveal(sending);
    void send(sending, stepUpToken);
  };

  const shownUser = status === 'ready' ? user : undefined;
  const header = (
    <Flex justify="space-between" align="center" wrap gap={8}>
      <Flex align="center" gap={12} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontFamily: token.fontFamilyCode }}>
          {shownUser?.user_id ?? userId}
        </Typography.Text>
        {shownUser === undefined ? null : <RiskTag state={shownUser.risk.state} />}
      </Flex>
      <Button icon={<ArrowLeftOutlined aria-hidden />} onClick={onBack}>
        {t.back}
      </Button>
    </Flex>
  );

  let body: ReactElement;
  if (status === 'loading') {
    body = (
      <Card>
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Card>
    );
  } else if (status === 'forbidden') {
    body = (
      <Card>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
      </Card>
    );
  } else if (status === 'missing') {
    body = (
      <Card>
        <Result status="404" title={t.notFoundTitle} subTitle={t.notFoundDescription} />
      </Card>
    );
  } else if (status === 'failed' || user === undefined) {
    body = (
      <Card>
        <Result
          status="error"
          title={t.loadFailedTitle}
          subTitle={t.loadFailedDescription}
          extra={<Button onClick={retry}>{usersTexts.retry}</Button>}
        />
      </Card>
    );
  } else {
    body = (
      <DetailBody
        user={user}
        phone={phone}
        canReveal={canReveal}
        access={access}
        revealBusy={reveal.phase !== 'idle'}
        revealError={revealError}
        onReveal={startReveal}
        onCloseError={() => setRevealError(undefined)}
        onOpenUser={onOpenUser}
        onUserChange={setUser}
      />
    );
  }

  return (
    <Flex vertical gap={16}>
      {header}
      {body}
      {reveal.phase === 'reason' ? (
        <ReasonModal
          initialReason={reveal.reason}
          onCancel={cancelReveal}
          onConfirm={(reason) => {
            if (revealRef.current.phase !== 'reason') return;
            setReveal({ phase: 'verify', reason, again: false });
          }}
        />
      ) : null}
      <StepUpModal
        open={reveal.phase === 'verify'}
        tier="totp"
        operation={usersTexts.reveal.operation}
        details={[
          usersTexts.reveal.stepUpDetail(userId),
          ...(reveal.again ? [usersTexts.reveal.stepUpAgain] : []),
        ]}
        onSubmit={verifyCode}
        onClose={cancelReveal}
        onVerified={onVerified}
      />
    </Flex>
  );
}

interface DetailBodyProps {
  readonly user: UserDetail;
  readonly phone: string | undefined;
  readonly canReveal: boolean;
  readonly access: AccessControl;
  readonly revealBusy: boolean;
  readonly revealError: string | undefined;
  readonly onReveal: () => void;
  readonly onCloseError: () => void;
  readonly onOpenUser: (userId: string) => void;
  readonly onUserChange: (user: UserDetail) => void;
}

function DetailBody({
  user,
  phone,
  canReveal,
  access,
  revealBusy,
  revealError,
  onReveal,
  onCloseError,
  onOpenUser,
  onUserChange,
}: DetailBodyProps): ReactElement {
  const f = t.fields;
  const { token } = theme.useToken();
  const canChangeLevel = access.can('user.level');
  const [levelOpen, setLevelOpen] = useState(false);
  const levelTrigger = useRef<HTMLButtonElement>(null);
  const code = { fontFamily: token.fontFamilyCode } as const;
  const inviter = user.inviter_user_id;
  const phoneValue =
    phone !== undefined ? (
      <Flex align="center" gap={8} wrap>
        <Typography.Text strong>{phone}</Typography.Text>
        <Tag>{usersTexts.reveal.revealed}</Tag>
      </Flex>
    ) : (
      <Flex align="center" gap={8} wrap>
        <Typography.Text>{user.phone_masked ?? usersTexts.dash}</Typography.Text>
        {canReveal && user.phone_masked !== null ? (
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined aria-hidden />}
            style={{ paddingInline: 0 }}
            loading={revealBusy}
            onClick={onReveal}
          >
            {usersTexts.reveal.action}
          </Button>
        ) : null}
      </Flex>
    );
  const items: DescriptionsProps['items'] = [
    {
      key: 'uid',
      label: f.uid,
      children: <span style={code}>{user.user_id}</span>,
    },
    { key: 'nickname', label: f.nickname, children: user.nickname },
    { key: 'phone', label: f.phone, children: phoneValue },
    {
      key: 'inviteCode',
      label: f.inviteCode,
      children: <span style={code}>{user.invite_code}</span>,
    },
    {
      key: 'inviter',
      label: f.inviter,
      children:
        inviter === null ? (
          usersTexts.dash
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
    {
      key: 'level',
      label: f.level,
      children: canChangeLevel ? (
        <Flex align="center" gap={8} wrap>
          <span>{user.level}</span>
          <Button
            ref={levelTrigger}
            type="link"
            size="small"
            icon={<SafetyOutlined aria-hidden />}
            style={{ paddingInline: 0 }}
            onClick={() => setLevelOpen(true)}
          >
            {usersTexts.relations.changeLevel}
          </Button>
        </Flex>
      ) : (
        user.level
      ),
    },
    {
      key: 'risk',
      label: f.risk,
      children: <RiskTag state={user.risk.state} />,
    },
    {
      key: 'registerMethod',
      label: f.registerMethod,
      children: registerMethodLabel(user.register_method),
    },
    {
      key: 'registeredChannel',
      label: f.registeredChannel,
      children: user.registered_channel ?? usersTexts.dash,
    },
    { key: 'createdAt', label: f.createdAt, children: beijingTime(user.created_at) },
  ];

  const columns: TableColumnsType<UnionBinding> = [
    {
      key: 'platform',
      title: t.bindingColumns.platform,
      width: 120,
      render: (_, binding) => platformLabel(binding.platform),
    },
    {
      key: 'status',
      title: t.bindingColumns.status,
      width: 260,
      render: (_, binding) => (
        <Flex vertical gap={4}>
          <Flex align="center" gap={8} wrap>
            <Tag color={bindingTagColor(binding.status)} style={{ marginInlineEnd: 0 }}>
              {bindingStatusLabel(binding.status)}
            </Tag>
            <Typography.Text type="secondary" style={{ ...code, fontSize: token.fontSizeSM }}>
              {binding.status}
            </Typography.Text>
            {binding.blocked_reason === null ? null : (
              <Typography.Text type="secondary">
                {blockedReasonLabel(binding.blocked_reason)}
              </Typography.Text>
            )}
          </Flex>
          {binding.reason === null ? null : (
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {binding.reason}
            </Typography.Text>
          )}
        </Flex>
      ),
    },
    {
      key: 'boundAt',
      title: t.bindingColumns.boundAt,
      width: 170,
      render: (_, binding) => beijingTime(binding.bound_at),
    },
    {
      key: 'releasedAt',
      title: t.bindingColumns.releasedAt,
      width: 170,
      render: (_, binding) => beijingTime(binding.released_at),
    },
    {
      key: 'cooldownUntil',
      title: t.bindingColumns.cooldownUntil,
      render: (_, binding) => beijingTime(binding.cooldown_until),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Card title={t.basicTitle}>
        <Flex vertical gap={12}>
          {revealError === undefined ? null : (
            <Alert type="error" showIcon closable message={revealError} onClose={onCloseError} />
          )}
          <Descriptions layout="vertical" bordered column={4} items={items} />
        </Flex>
      </Card>
      <Card title={t.bindingsTitle} styles={{ body: { paddingTop: 0 } }}>
        <Table<UnionBinding>
          aria-label={t.bindingsTitle}
          rowKey="platform"
          columns={columns}
          dataSource={user.union_bindings}
          pagination={false}
          locale={{
            emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t.bindingsEmpty} />,
          }}
        />
      </Card>
      <UserRelationsCard
        user={user}
        access={access}
        onOpenUser={onOpenUser}
        onUserChange={onUserChange}
      />
      {canChangeLevel ? (
        <LevelChangeDialog
          user={user}
          open={levelOpen}
          onClose={() => setLevelOpen(false)}
          onUserChange={onUserChange}
          afterClose={() => levelTrigger.current?.focus()}
        />
      ) : null}
    </Flex>
  );
}
