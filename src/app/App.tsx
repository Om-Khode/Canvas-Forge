import { lazy, Suspense } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary';
import { LandingPage } from './routes/LandingPage';
import { RouteFallback } from './routes/RouteFallback';

/**
 * The editor is code-split away from the landing page. A recruiter opening the
 * link downloads the marketing page and nothing else; the engine, panels, and
 * export code arrive when they press "Start creating".
 */
const EditorPage = lazy(async () => {
  const module = await import('./routes/EditorPage');
  return { default: module.EditorPage };
});

const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  {
    path: '/editor',
    element: (
      <Suspense fallback={<RouteFallback />}>
        <EditorPage />
      </Suspense>
    ),
  },
  { path: '*', element: <LandingPage /> },
]);

export function App() {
  return (
    <ErrorBoundary label="CanvasForge">
      <RouterProvider router={router} />
    </ErrorBoundary>
  );
}
