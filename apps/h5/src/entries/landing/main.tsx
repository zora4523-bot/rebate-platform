// App-external landing pages (规划/03 §8.2): no bridge, no token manager, and a first screen that
// does not depend on React (blocked B-6, default A). This entry renders the shell in plain DOM, so
// no React DOM `createRoot` runs here and the whole first-screen JS stays inside the 03 §12 budget.
import '../../shared/styles/index.css';
import { renderLandingShell } from './render.ts';

const container = document.getElementById('root');
if (container === null) throw new Error('apps/h5 landing entry: #root is missing');
renderLandingShell(container);
