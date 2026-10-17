import { ConfigProvider, DatePicker, Form, Input, Typography } from 'antd';
import dayjs from 'dayjs';
import { useId } from 'react';
import { platformIconsTexts as t } from '../../texts/platform-icons.ts';

export interface SourceValues {
  readonly sourceUrl: string;
  readonly downloadedOn: string;
}

export function validSourceUrl(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return value.trim().length <= 2048 && (url.protocol === 'http:' || url.protocol === 'https:');
  } catch {
    return false;
  }
}

export function sourcePayload(values: SourceValues) {
  return {
    ...(values.sourceUrl.trim() ? { source_url: values.sourceUrl.trim() } : {}),
    ...(values.downloadedOn ? { downloaded_on: values.downloadedOn } : {}),
  };
}

export function SourceFields({
  values,
  onChange,
  disabled,
  invalid = false,
}: {
  readonly values: SourceValues;
  readonly onChange: (values: SourceValues) => void;
  readonly disabled: boolean;
  readonly invalid?: boolean;
}) {
  const id = useId();
  return (
    <ConfigProvider
      theme={{
        components: {
          Input: { controlHeight: 36 },
          DatePicker: { controlHeight: 36 },
          Form: { labelFontSize: 12, verticalLabelPadding: '0 0 4px' },
        },
      }}
    >
      <Form layout="vertical" disabled={disabled} requiredMark={false}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 200px', gap: 16 }}>
          <Form.Item
            label={t.sourceLabel}
            htmlFor={`${id}-url`}
            validateStatus={invalid ? 'error' : ''}
            help={invalid ? t.sourceInvalid : undefined}
            style={{ marginBottom: 0 }}
          >
            <Input
              id={`${id}-url`}
              value={values.sourceUrl}
              placeholder={t.sourcePlaceholder}
              maxLength={2048}
              onChange={(event) => onChange({ ...values, sourceUrl: event.target.value })}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t.sourceHelp}
            </Typography.Text>
          </Form.Item>
          <Form.Item label={t.dateLabel} htmlFor={`${id}-date`} style={{ marginBottom: 0 }}>
            <DatePicker
              id={`${id}-date`}
              value={values.downloadedOn ? dayjs(values.downloadedOn) : null}
              format="YYYY-MM-DD"
              placeholder={t.datePlaceholder}
              style={{ width: '100%' }}
              onChange={(date) =>
                onChange({ ...values, downloadedOn: date ? date.format('YYYY-MM-DD') : '' })
              }
            />
          </Form.Item>
        </div>
      </Form>
    </ConfigProvider>
  );
}
