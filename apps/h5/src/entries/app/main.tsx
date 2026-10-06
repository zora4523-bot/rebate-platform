// App-internal pages, opened in the trusted WebView (规划/03 §8.2).
import '../../shared/styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { call, has } from '@couli/bridge-sdk';
import { startWhitescreenWatch, type WhitescreenOptions } from '../../shared/whitescreen/index.ts';
import { defaultReport } from '../../shared/whitescreen/report.ts';
import { createAppShell } from './shell.ts';

const container = document.getElementById('root');
if (container === null) throw new Error('apps/h5 app entry: #root is missing');
createRoot(container).render(<StrictMode>{createAppShell()}</StrictMode>);

// White-screen check (规划/03 §8.3): starts at mount; platform and version stay null outside the
// App, when native does not declare app.getEnv, or when the call fails (no native detail kept).
const env: WhitescreenOptions['env'] = { platform: null, version: null };
const getEnv = has('app.getEnv');
if (getEnv !== null) {
  call(getEnv, {}).then(
    (result) => {
      env.platform = result.platform;
      env.version = result.app_version;
    },
    () => undefined,
  );
}
startWhitescreenWatch({ root: container, report: defaultReport, env });
