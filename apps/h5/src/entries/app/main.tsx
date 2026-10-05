// App-internal pages, opened in the trusted WebView (规划/03 §8.2).
import '../../shared/styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAppShell } from './shell.ts';

const container = document.getElementById('root');
if (container === null) throw new Error('apps/h5 app entry: #root is missing');
createRoot(container).render(<StrictMode>{createAppShell()}</StrictMode>);
