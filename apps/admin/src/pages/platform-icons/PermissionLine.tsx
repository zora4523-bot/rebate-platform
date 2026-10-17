import { Typography, theme } from 'antd';
import { platformIconsTexts as t } from '../../texts/platform-icons.ts';

export function PermissionLine() {
  const { token } = theme.useToken();
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {t.permissionLabel}{' '}
      <span style={{ fontFamily: token.fontFamilyCode }}>{t.permissionKey}</span> {t.noStepUp}
    </Typography.Text>
  );
}
