import { Alert, Button, Flex, Modal, Typography, theme } from 'antd';
import { InfoCircleOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { platformIconsTexts as t } from '../../texts/platform-icons.ts';
import { currentLabel, time, type ActionError, type Confirmation } from './model.ts';
import { builtinRow, Preview, type PreviewRow } from './Preview.tsx';
import { VersionDetails } from './VersionDetails.tsx';
import { PermissionLine } from './PermissionLine.tsx';

export function ConfirmationModal({
  action,
  busy,
  error,
  onCancel,
  onConfirm,
  onRefresh,
  onAudit,
  onRegister,
}: {
  readonly action: Confirmation;
  readonly busy: boolean;
  readonly error: ActionError | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onRefresh: () => void;
  readonly onAudit: () => void;
  readonly onRegister: () => void;
}) {
  const { token } = theme.useToken();
  const { icon, kind, target } = action;
  const platform = t.names[icon.key];
  const n = target?.version ?? 0;
  const title =
    kind === 'restore'
      ? t.restoreTitle(platform)
      : kind === 'rollback'
        ? t.rollbackName(platform, n)
        : t.publishName(platform, n);
  const rows: PreviewRow[] = [];
  if (kind === 'restore') rows.push(builtinRow(icon.key, t.builtinRestored));
  else if (target)
    rows.push({
      label: kind === 'rollback' ? t.afterRollback(n) : t.afterPublish(n),
      url: target.url,
    });
  if (icon.current)
    rows.push({ label: t.currentVersion(icon.current.version), url: icon.current.url });
  if (kind !== 'restore')
    rows.push(builtinRow(icon.key, icon.current ? t.builtin : t.builtinCurrent));
  const effect =
    kind === 'restore'
      ? t.restoreEffect(platform)
      : kind === 'rollback'
        ? t.rollbackEffect(n)
        : t.publishEffect(n);
  const retained =
    kind === 'restore'
      ? t.restoreRetained(icon.latest_version ?? 0)
      : kind === 'rollback'
        ? t.rollbackRetained(action.retained)
        : t.publishLock(n);
  const needsRefresh = error !== undefined && error.kind !== 'source';
  const latest = error?.kind === 'conflict' ? error.latest : undefined;
  const conflict = error?.kind === 'conflict';
  return (
    <Modal
      open
      centered
      width={640}
      title={
        <div>
          {title}
          <div style={{ fontSize: 12, fontWeight: 400, color: token.colorTextSecondary }}>
            {conflict ? icon.key : t.currentSubtitle(icon.key, currentLabel(icon))}
          </div>
        </div>
      }
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      onCancel={onCancel}
      footer={
        <Flex justify="end" gap={8}>
          {!conflict && (
            <Button disabled={busy} onClick={onCancel}>
              {t.cancel}
            </Button>
          )}
          {needsRefresh ? (
            <>
              <Button disabled={busy} onClick={onAudit}>
                {t.audit}
              </Button>
              <Button
                disabled={busy}
                type="primary"
                icon={<ReloadOutlined aria-hidden />}
                onClick={onRefresh}
              >
                {t.refreshHistory}
              </Button>
            </>
          ) : error?.kind === 'source' ? (
            <Button type="primary" onClick={onRegister}>
              {t.register}
            </Button>
          ) : (
            <Button type="primary" disabled={busy} aria-busy={busy} onClick={onConfirm}>
              {t.confirm[kind]}
            </Button>
          )}
        </Flex>
      }
    >
      <Flex vertical gap={16} style={{ paddingTop: 16, paddingBottom: 8 }}>
        {error && (
          <Alert
            role="alert"
            type="error"
            showIcon
            icon={<WarningOutlined aria-hidden style={{ fontSize: 14, marginTop: 4 }} />}
            style={{
              padding: 12,
              border: 0,
              alignItems: 'flex-start',
              background: 'var(--color-status-error-background)',
            }}
            message={
              <Flex vertical gap={4} style={{ color: token.colorError }}>
                <div style={{ fontWeight: 600 }}>
                  {error.kind === 'conflict'
                    ? t.conflictTitle(t[kind])
                    : error.kind === 'version'
                      ? t.versionInvalid
                      : error.kind === 'source'
                        ? t.sourceMissing
                        : t.writeFailed}
                </div>
                {error.kind === 'conflict' && (
                  <>
                    <div>{t.conflict(platform)}</div>
                    {latest && (
                      <div>
                        {t.latest(
                          currentLabel(latest),
                          time(latest.updated_at, true),
                          latest.updated_by ?? t.dash,
                        )}{' '}
                        {t.reconsider(
                          kind === 'restore'
                            ? t.restore
                            : kind === 'rollback'
                              ? t.rollbackDecision(n)
                              : t.publishDecision(n),
                        )}
                      </div>
                    )}
                  </>
                )}
              </Flex>
            }
          />
        )}
        {conflict ? (
          <div>
            <Typography.Paragraph strong style={{ marginBottom: 8 }}>
              {t.openedState}
            </Typography.Paragraph>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr',
                padding: 12,
                borderRadius: token.borderRadius,
                background: token.colorInfoBg,
              }}
            >
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t.current}
                </Typography.Text>
                <div>{currentLabel(icon)}</div>
              </div>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t.targetVersion}
                </Typography.Text>
                <div>{kind === 'restore' ? t.builtin : t.version(n)}</div>
              </div>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t.opened}
                </Typography.Text>
                <div>{time(action.openedAt, true)}</div>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div>
              <Typography.Paragraph strong style={{ marginBottom: 8 }}>
                {t.preview}
              </Typography.Paragraph>
              <Preview iconKey={icon.key} rows={rows} large />
            </div>
            {target && (
              <div
                style={{
                  padding: 12,
                  borderRadius: token.borderRadius,
                  background: token.colorInfoBg,
                }}
              >
                <VersionDetails
                  version={target}
                  confirmation={kind === 'rollback' ? 'rollback' : 'publish'}
                />
              </div>
            )}
            <Alert
              role="note"
              type="info"
              showIcon
              icon={<InfoCircleOutlined aria-hidden style={{ marginTop: 4 }} />}
              style={{ alignItems: 'flex-start' }}
              message={
                <>
                  <div>{effect}</div>
                  <div style={{ marginTop: 4 }}>{retained}</div>
                </>
              }
            />
            <PermissionLine />
          </>
        )}
      </Flex>
    </Modal>
  );
}
