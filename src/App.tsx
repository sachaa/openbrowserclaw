// ---------------------------------------------------------------------------
// OpenBrowserClaw — App shell
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { Orchestrator } from './orchestrator.js';
import { initOrchestratorStore, useOrchestratorStore } from './stores/orchestrator-store.js';
import { Layout } from './components/layout/Layout.js';
import { ChatPage } from './components/chat/ChatPage.js';
import { FilesPage } from './components/files/FilesPage.js';
import { TasksPage } from './components/tasks/TasksPage.js';
import { SettingsPage } from './components/settings/SettingsPage.js';

export function App() {
  const orchRef = useRef<Orchestrator | null>(null);
  const [loading, setLoading] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const ready = useOrchestratorStore((s) => s.ready);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const orch = new Orchestrator();
        orchRef.current = orch;
        await orch.init();
        await initOrchestratorStore(orch);
        if (!cancelled) setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setInitError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    }

    boot();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <span className="loading loading-spinner loading-lg text-primary" />
      </div>
    );
  }

  if (initError) {
    return (
      <div className="flex items-center justify-center h-screen p-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-error mb-3">Failed to start</h1>
          <p className="text-base-content/70">{initError}</p>
          <p className="text-base-content/40 text-sm mt-2">
            Check the browser console for details.
          </p>
        </div>
      </div>
    );
  }

  const isConfigured = orchRef.current?.isConfigured() ?? false;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to={isConfigured ? '/chat' : '/settings'} replace />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="files" element={<FilesPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
