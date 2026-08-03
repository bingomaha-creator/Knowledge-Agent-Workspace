import {
  createBrowserRouter,
  type RouteObject
} from 'react-router';
import { App } from './App';
import { workspaceModules } from './modules';
import { MigrationOverviewPage } from '@/pages/MigrationOverviewPage';
import { ModulePlaceholderPage } from '@/pages/ModulePlaceholderPage';

export const workspaceRoutes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      {
        index: true,
        element: <MigrationOverviewPage />
      },
      ...workspaceModules.map((module) => ({
        path: module.path,
        element: <ModulePlaceholderPage module={module} />
      }))
    ]
  }
];

export function createWorkspaceRouter() {
  return createBrowserRouter(workspaceRoutes);
}
