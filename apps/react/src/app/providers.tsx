import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { GlobalStyles } from '@/styles/GlobalStyles';

export function createWorkspaceQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: 15_000
      },
      mutations: {
        retry: false
      }
    }
  });
}

type AppProvidersProps = {
  children: ReactNode;
  queryClient?: QueryClient;
};

export function AppProviders({ children, queryClient }: AppProvidersProps) {
  const [client] = useState(() => queryClient ?? createWorkspaceQueryClient());

  return (
    <>
      <GlobalStyles />
      <QueryClientProvider client={client}>
        {children}
      </QueryClientProvider>
    </>
  );
}
