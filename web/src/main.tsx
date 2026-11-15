import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

async function boot() {
  // 今はモックだけで動かす。実際の API につなぐときは VITE_API_BASE を指定し、ここを外す
  if (!import.meta.env.VITE_API_BASE) {
    const { startMocking } = await import('./mocks/browser');
    await startMocking();
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
