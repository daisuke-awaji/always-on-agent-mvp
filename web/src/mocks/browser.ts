import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import { resumeAll } from './simulator';

export async function startMocking(): Promise<void> {
  const worker = setupWorker(...handlers);
  await worker.start({
    // GitHub Pages などのサブパスでも動くよう、BASE_URL からの相対で登録する
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    onUnhandledFrame: 'bypass',
    quiet: true,
  });
  resumeAll();
}
