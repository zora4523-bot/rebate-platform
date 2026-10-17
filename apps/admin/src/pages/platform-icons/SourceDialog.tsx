import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Flex, Modal, Typography, theme } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { AdminApiError } from '../../providers/data/index.ts';
import { platformIconsTexts as t } from '../../texts/platform-icons.ts';
import { fileLabel, time, type Version } from './model.ts';
import { SourceFields, sourcePayload, validSourceUrl, type SourceValues } from './SourceFields.tsx';
import { errorFields } from './upload-error.ts';
import type { SourceDialogProps } from './upload-types.ts';

export function SourceDialog({
  iconKey,
  version,
  onClose,
  onSaved,
  onRefresh,
  onUnknownKey,
}: SourceDialogProps) {
  const provider = useDataProvider();
  const { token } = theme.useToken();
  const [source, setSource] = useState<SourceValues>({
    sourceUrl: version.source_url ?? '',
    downloadedOn: version.downloaded_on ?? '',
  });
  const [invalidSource, setInvalidSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'version' | 'conflict' | 'failed' | 'key'>();
  const writing = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const platform = t.names[iconKey];
  const action = version.publishable ? t.editSource : t.register;
  // The contract does not accept null/empty registrations. Omitted fields stay unchanged.
  const filled = sourcePayload(source);
  const changes = {
    ...(filled.source_url && filled.source_url !== version.source_url
      ? { source_url: filled.source_url }
      : {}),
    ...(filled.downloaded_on && filled.downloaded_on !== version.downloaded_on
      ? { downloaded_on: filled.downloaded_on }
      : {}),
  };
  const hasChanges = Object.keys(changes).length > 0;
  const close = () => {
    if (!writing.current) onClose();
  };
  const save = async () => {
    if (writing.current || error || !hasChanges) return;
    if (!validSourceUrl(source.sourceUrl)) {
      setInvalidSource(true);
      return;
    }
    writing.current = true;
    setBusy(true);
    try {
      const custom = provider().custom;
      if (!custom) throw new Error('Missing custom data provider');
      const payload: Schema<'AdminPlatformIconSourceRequest'> = {
        expected_revision: version.revision,
        ...changes,
      };
      const response = await custom<Version>({
        url: `/admin/v1/platform-icons/${iconKey}/versions/${version.version}`,
        method: 'patch',
        payload,
      });
      if (active.current) onSaved(response.data);
    } catch (cause) {
      if (!active.current) return;
      const fields = errorFields(cause);
      if (fields.includes('key')) {
        if (onUnknownKey) onUnknownKey(iconKey);
        else setError('key');
      } else if (fields.includes('version')) setError('version');
      else if (cause instanceof AdminApiError && cause.code === 20902) setError('conflict');
      else setError('failed');
    } finally {
      writing.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <Modal
      open
      centered
      width={560}
      title={
        <div>
          {t.sourceTitle(action, platform, version.version)}
          <div style={{ fontSize: 12, fontWeight: 400, color: token.colorTextSecondary }}>
            {t.sourceSubtitle(iconKey, version.publishable)}
          </div>
        </div>
      }
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      onCancel={close}
      footer={
        <Flex justify="end" gap={8}>
          <Button disabled={busy} onClick={close}>
            {t.cancel}
          </Button>
          {error ? (
            <Button type="primary" onClick={onRefresh}>
              {t.refreshHistory}
            </Button>
          ) : (
            <Button
              type="primary"
              disabled={busy || !hasChanges}
              aria-busy={busy}
              onClick={() => {
                void save();
              }}
            >
              {t.saveRegister}
            </Button>
          )}
        </Flex>
      }
    >
      <Flex vertical gap={16} style={{ paddingTop: 16, paddingBottom: 8 }}>
        {error && (
          <Alert
            type="error"
            showIcon
            message={
              error === 'version'
                ? t.versionNotEditable
                : error === 'conflict'
                  ? t.conflictTitle(action)
                  : error === 'key'
                    ? t.unknownKey
                    : t.writeFailed
            }
            description={error === 'conflict' ? t.sourceConflict(platform) : undefined}
          />
        )}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 16,
            background: token.colorInfoBg,
            borderRadius: token.borderRadius,
            padding: 12,
          }}
        >
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t.file}
            </Typography.Text>
            <div>{fileLabel(version)}</div>
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t.saved}
            </Typography.Text>
            <div>
              {version.created_by} · {time(version.created_at, true)}
            </div>
          </div>
        </div>
        <SourceFields
          values={source}
          onChange={(values) => {
            setSource(values);
            setInvalidSource(false);
          }}
          disabled={busy || Boolean(error)}
          invalid={invalidSource}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t.registerNote(version.version)}
        </Typography.Text>
      </Flex>
    </Modal>
  );
}
