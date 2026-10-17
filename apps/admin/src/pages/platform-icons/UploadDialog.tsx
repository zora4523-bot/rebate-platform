import type { Schema } from '@couli/contracts-ts';
import {
  ClockCircleOutlined,
  FileOutlined,
  UploadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Checkbox, Flex, List, Modal, Space, Typography, Upload, theme } from 'antd';
import { useEffect, useId, useRef, useState } from 'react';
import { platformIconsTexts as t } from '../../texts/platform-icons.ts';
import { currentLabel, time, type Version } from './model.ts';
import { builtinRow, Preview } from './Preview.tsx';
import { SourceFields, sourcePayload, validSourceUrl, type SourceValues } from './SourceFields.tsx';
import { StatusTag } from './StatusTag.tsx';
import { errorFields, uploadErrorMessage } from './upload-error.ts';
import type { UploadDialogProps } from './upload-types.ts';

type CleanedUpload = Schema<'AdminPlatformIconUpload'>;

export function UploadDialog({ icon, onClose, onSaved, onUnknownKey }: UploadDialogProps) {
  const provider = useDataProvider();
  const { token } = theme.useToken();
  const hintId = useId();
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<CleanedUpload>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'upload' | 'save'>();
  const [uploadError, setUploadError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [expired, setExpired] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [source, setSource] = useState<SourceValues>({ sourceUrl: '', downloadedOn: '' });
  const [invalidSource, setInvalidSource] = useState(false);
  const active = useRef(true);
  const operation = useRef<'upload' | 'save' | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);

  const close = () => {
    if (operation.current === 'save') return;
    active.current = false;
    controller.current?.abort();
    onClose();
  };
  const choose = (selected: File) => {
    if (operation.current) return;
    setFile(selected);
    setPreview(undefined);
    setConfirmed(false);
    setExpired(false);
    setUnconfirmed(false);
    setUploadError(undefined);
    setSaveError(undefined);
  };
  const upload = async () => {
    if (!file || operation.current || uploadError || !active.current) return;
    operation.current = 'upload';
    setBusy('upload');
    const abort = new AbortController();
    controller.current = abort;
    try {
      const custom = provider().custom;
      if (!custom) throw new Error('Missing custom data provider');
      const payload = new FormData();
      payload.append('file', file);
      const response = await custom<CleanedUpload>({
        url: `/admin/v1/platform-icons/${icon.key}/uploads`,
        method: 'post',
        payload,
        meta: { signal: abort.signal },
      });
      if (!active.current || abort.signal.aborted) return;
      setPreview(response.data);
      setConfirmed(false);
    } catch (cause) {
      if (!active.current || abort.signal.aborted) return;
      if (errorFields(cause).includes('key')) onUnknownKey(icon.key);
      else setUploadError(uploadErrorMessage(cause));
    } finally {
      operation.current = undefined;
      if (active.current) setBusy(undefined);
    }
  };
  const save = async () => {
    if (!preview || operation.current || expired || (preview.sanitized && !confirmed)) return;
    if (!validSourceUrl(source.sourceUrl)) {
      setInvalidSource(true);
      return;
    }
    operation.current = 'save';
    setBusy('save');
    setSaveError(undefined);
    try {
      const custom = provider().custom;
      if (!custom) throw new Error('Missing custom data provider');
      const payload: Schema<'AdminPlatformIconVersionCreateRequest'> = {
        upload_id: preview.upload_id,
        ...(preview.sanitized ? { sanitized_confirmed: true } : {}),
        ...sourcePayload(source),
      };
      const response = await custom<Version>({
        url: `/admin/v1/platform-icons/${icon.key}/versions`,
        method: 'post',
        payload,
      });
      if (active.current) onSaved(response.data);
    } catch (cause) {
      if (!active.current) return;
      const fields = errorFields(cause);
      if (fields.includes('key')) onUnknownKey(icon.key);
      else if (fields.includes('upload_id')) {
        setExpired(true);
        setSaveError(t.uploadExpired);
      } else if (fields.includes('sanitized_confirmed')) {
        setConfirmed(false);
        setUnconfirmed(true);
      } else setSaveError(t.writeFailed);
    } finally {
      operation.current = undefined;
      if (active.current) setBusy(undefined);
    }
  };
  const chooser = (
    <Upload
      accept=".svg,.png,image/svg+xml,image/png"
      multiple={false}
      maxCount={1}
      showUploadList={false}
      fileList={[]}
      disabled={busy !== undefined}
      beforeUpload={(selected) => {
        choose(selected);
        return false;
      }}
    >
      <Button
        size={file ? 'small' : 'middle'}
        disabled={busy !== undefined}
        icon={!file ? <FileOutlined aria-hidden /> : undefined}
      >
        {file ? t.reselect : t.chooseFile}
      </Button>
    </Upload>
  );
  return (
    <Modal
      open
      centered
      width={preview ? 720 : 640}
      title={
        <div>
          {t.uploadTitle(t.names[icon.key])}
          <div style={{ fontSize: 12, fontWeight: 400, color: token.colorTextSecondary }}>
            {t.uploadSubtitle(t.names[icon.key], icon.key, currentLabel(icon))}
          </div>
        </div>
      }
      closable={busy !== 'save'}
      maskClosable={busy !== 'save'}
      keyboard={busy !== 'save'}
      onCancel={close}
      footer={
        <Flex justify={preview ? 'space-between' : 'end'} align="center" gap={12} wrap>
          {preview && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t.saveNote((icon.latest_version ?? 0) + 1)}
            </Typography.Text>
          )}
          <Space size={8}>
            <Button disabled={busy === 'save'} onClick={close}>
              {t.cancel}
            </Button>
            {preview ? (
              <Button
                type="primary"
                disabled={busy !== undefined || expired || (preview.sanitized && !confirmed)}
                aria-busy={busy === 'save'}
                onClick={() => {
                  void save();
                }}
              >
                {t.saveVersion}
              </Button>
            ) : (
              <Button
                type="primary"
                disabled={!file || busy !== undefined || Boolean(uploadError)}
                aria-busy={busy === 'upload'}
                onClick={() => {
                  void upload();
                }}
              >
                {busy === 'upload' ? t.uploadingButton : t.uploadPreview}
              </Button>
            )}
          </Space>
        </Flex>
      }
    >
      <Flex vertical gap={16} style={{ paddingTop: 16, paddingBottom: 8 }}>
        {file ? (
          <Flex
            align="center"
            gap={12}
            style={{
              border: `1px solid ${uploadError ? token.colorError : token.colorBorderSecondary}`,
              borderRadius: token.borderRadius,
              padding: 12,
            }}
          >
            <FileOutlined aria-hidden style={{ color: token.colorTextSecondary }} />
            <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
              <div>{file.name}</div>
              <Typography.Text ellipsis type="secondary" style={{ fontSize: 12, width: '100%' }}>
                {preview
                  ? `${t.cleanedSize(file.size, preview.bytes)} · ${preview.format.toUpperCase()} · ${t.previewExpires(time(preview.expires_at))}`
                  : `${t.fileSize(file.size)} · ${file.type === 'image/png' || /\.png$/i.test(file.name) ? 'PNG' : 'SVG'}`}
              </Typography.Text>
            </div>
            {preview?.sanitized && <StatusTag tone="warning">{t.cleaned}</StatusTag>}
            {uploadError && <StatusTag tone="error">{t.failedTag}</StatusTag>}
            {busy === 'upload' ? (
              <StatusTag>
                <ClockCircleOutlined aria-hidden /> {t.uploading}
              </StatusTag>
            ) : (
              chooser
            )}
          </Flex>
        ) : (
          <Flex
            vertical
            align="center"
            gap={8}
            style={{
              padding: 24,
              border: `1px dashed ${token.colorBorder}`,
              borderRadius: token.borderRadius,
              background: token.colorBgLayout,
            }}
          >
            <UploadOutlined aria-hidden style={{ fontSize: 20, color: token.colorTextSecondary }} />
            {chooser}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t.noFile}
            </Typography.Text>
          </Flex>
        )}
        {busy === 'upload' && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t.discardUpload}
          </Typography.Text>
        )}
        {uploadError && (
          <Flex vertical gap={16}>
            <Typography.Text role="alert" type="danger" style={{ fontSize: 12, marginTop: -12 }}>
              <WarningOutlined aria-hidden /> {uploadError}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t.notUploaded}
            </Typography.Text>
          </Flex>
        )}
        {saveError && <Alert type="error" showIcon message={saveError} />}
        {preview ? (
          <>
            {preview.sanitized && (
              <Alert
                type="warning"
                showIcon
                icon={<WarningOutlined aria-hidden style={{ fontSize: 14, marginTop: 4 }} />}
                message={<Typography.Text strong>{t.sanitized}</Typography.Text>}
                description={t.sanitizedBody}
                style={{
                  border: 0,
                  padding: 12,
                  background: 'var(--color-status-warning-background)',
                }}
              />
            )}
            <Flex vertical gap={8}>
              <Typography.Text strong>{t.cleanedPreview}</Typography.Text>
              <Preview
                iconKey={icon.key}
                rows={[{ label: t.cleanedRow, url: preview.url }, builtinRow(icon.key)]}
                large
              />
            </Flex>
            {preview.sanitized && (
              <Flex vertical gap={2}>
                <Checkbox
                  checked={confirmed}
                  style={{ fontWeight: 600 }}
                  disabled={busy !== undefined}
                  aria-describedby={hintId}
                  onChange={(event) => {
                    setConfirmed(event.target.checked);
                    setUnconfirmed(false);
                  }}
                >
                  {t.confirmPreview}
                </Checkbox>
                <Typography.Text
                  id={hintId}
                  type={unconfirmed ? 'danger' : 'secondary'}
                  style={{ fontSize: 12, paddingLeft: 24 }}
                >
                  {unconfirmed ? t.unconfirmed : t.confirmPreviewHint}
                </Typography.Text>
              </Flex>
            )}
            <Flex vertical gap={8}>
              <Typography.Text strong>{t.sourceSection}</Typography.Text>
              <SourceFields
                values={source}
                onChange={(values) => {
                  setSource(values);
                  setInvalidSource(false);
                }}
                disabled={busy !== undefined}
                invalid={invalidSource}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t.draftNote}
              </Typography.Text>
            </Flex>
          </>
        ) : (
          <div>
            <Typography.Text strong>{t.requirements}</Typography.Text>
            <List
              split={false}
              style={{ marginTop: 8, paddingLeft: 20 }}
              dataSource={[...t.uploadRules]}
              renderItem={(rule) => (
                <List.Item
                  style={{ display: 'list-item', listStyle: 'disc', padding: 0, marginBottom: 4 }}
                >
                  {rule}
                </List.Item>
              )}
            />
          </div>
        )}
      </Flex>
    </Modal>
  );
}
