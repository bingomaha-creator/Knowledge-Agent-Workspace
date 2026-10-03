import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { AppLayout } from '@/ui/AppLayout';
import { findWorkspaceModule, workspaceModules } from './navigation';
import { WorkspaceHeader } from './WorkspaceHeader';
import { WorkspaceSidebar } from './WorkspaceSidebar';

export function App() {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const activeModule = findWorkspaceModule(location.pathname) ?? workspaceModules[0];
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    closeSidebar();
  }, [closeSidebar, location.pathname]);

  return (
    <AppLayout
      sidebar={(
        <WorkspaceSidebar
          modules={workspaceModules}
          open={sidebarOpen}
          onClose={closeSidebar}
        />
      )}
      header={(
        <WorkspaceHeader
          modules={workspaceModules}
          activeModule={activeModule}
          sidebarOpen={sidebarOpen}
          onOpenSidebar={() => setSidebarOpen(true)}
        />
      )}
    >
      <Outlet />
    </AppLayout>
  );
}
