// Bridge conformance page (规划/03 §8.2): debug / staging builds only (see vite.config.ts).
import '../../shared/styles/index.css';
import { createRoot } from 'react-dom/client';
import { createConformanceShell } from './shell.ts';

const container = document.getElementById('root');
if (container === null) throw new Error('apps/h5 conformance entry: #root is missing');
// No StrictMode: its development double effects would send every probe to native twice, and the
// native UI suites count calls.
createRoot(container).render(createConformanceShell());
