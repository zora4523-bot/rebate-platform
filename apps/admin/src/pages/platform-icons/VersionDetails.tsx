import { Typography } from 'antd';
import type { ReactNode } from 'react';
import { platformIconsTexts as t } from '../../texts/platform-icons.ts';
import { fileLabel, time, type Version } from './model.ts';
import { StatusTag } from './StatusTag.tsx';

export function VersionDetails({
  version,
  confirmation = false,
}: {
  readonly version: Version;
  readonly confirmation?: false | 'publish' | 'rollback';
}) {
  const entries: readonly (readonly [string, ReactNode])[] = [
    [
      confirmation === 'rollback' ? t.targetVersion : t.file,
      `${confirmation === 'rollback' ? `${t.version(version.version)} · ` : ''}${fileLabel(version)}`,
    ],
    [t.source, version.source_url ?? <StatusTag tone="warning">{t.missing}</StatusTag>],
    [t.downloadDate, version.downloaded_on ?? <StatusTag tone="warning">{t.missing}</StatusTag>],
    [t.saved, `${version.created_by} · ${time(version.created_at, true)}`],
  ];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: confirmation ? '1fr 1fr' : '76px minmax(0, 1fr)',
        gap: confirmation ? 12 : '4px 8px',
        minWidth: 0,
        overflowWrap: 'anywhere',
      }}
    >
      {(confirmation === 'publish'
        ? [entries[0]!, entries[3]!, entries[1]!, entries[2]!]
        : entries
      ).map(([label, value]) =>
        confirmation ? (
          <div key={label}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {label}
            </Typography.Text>
            <div>{value}</div>
          </div>
        ) : (
          <Detail key={label} label={label} value={value} />
        ),
      )}
    </div>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return (
    <>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
      <span>{value}</span>
    </>
  );
}
