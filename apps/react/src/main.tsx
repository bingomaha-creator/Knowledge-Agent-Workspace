import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { AppProviders } from '@/app/providers';
import { createWorkspaceRouter } from '@/app/router';
import '@/styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('React root element was not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={createWorkspaceRouter()} />
    </AppProviders>
  </StrictMode>
);
