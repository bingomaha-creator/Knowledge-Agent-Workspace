import { QueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppProviders } from './providers';
import { workspaceRoutes } from './router';

function renderRoute(path: string) {
  const router = createMemoryRouter(workspaceRoutes, {
    initialEntries: [path]
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  );
}

describe('React workspace shell', () => {
  it('renders the migration overview without replacing the Vue baseline', () => {
    renderRoute('/');

    expect(screen.getByRole('heading', { name: '双版本迁移基线' })).toBeInTheDocument();
    expect(screen.getByText('Vue baseline remains active')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(10);
  });

  it('routes to a module placeholder through the shared workspace layout', () => {
    renderRoute('/knowledge');

    expect(screen.getByRole('heading', { name: '资料库' })).toBeInTheDocument();
    expect(screen.getByText('Vue parity pending')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Workspace modules' })).toBeInTheDocument();
  });
});
