// ---------------------------------------------------------------------------
// BrowserClaw — Entry point
// ---------------------------------------------------------------------------

import { AppUI } from './ui/app.js';
import './ui/styles.css';

async function main(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) {
    throw new Error('Missing #app element');
  }

  const app = new AppUI(root);
  await app.init();
}

main().catch((err) => {
  console.error('BrowserClaw failed to start:', err);
  document.body.innerHTML = `
    <div style="
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      background: #0f0f23;
      color: #ff6b6b;
      font-family: monospace;
      padding: 20px;
      text-align: center;
    ">
      <div>
        <h1>BrowserClaw failed to start</h1>
        <p style="color: #8892b0; margin-top: 12px;">${err instanceof Error ? err.message : String(err)}</p>
        <p style="color: #5a6080; margin-top: 8px; font-size: 12px;">Check the browser console for details.</p>
      </div>
    </div>
  `;
});
