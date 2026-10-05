// App-external landing pages (规划/03 §8.2): no bridge, smallest first-screen JS. The entry chunk
// holds only this bootstrap; React DOM and the shell load as dynamic chunks right away, so the
// first paint never waits on them (03 §12: landing first-screen JS budget).
import '../../shared/styles/index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('apps/h5 landing entry: #root is missing');
void Promise.all([import('react-dom/client'), import('./shell.ts')]).then(
  ([{ createRoot }, { createLandingShell }]) => {
    createRoot(container).render(createLandingShell());
  },
);
