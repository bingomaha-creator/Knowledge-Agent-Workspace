import {
  createBrowserRouter,
  Navigate,
  type RouteObject
} from 'react-router';
import { App } from './App';
import { BugAgent } from '@/pages/BugAgent';
import { Chat } from '@/pages/Chat';
import { Knowledge } from '@/pages/Knowledge';
import { Memory } from '@/pages/Memory';
import { PageNotFound } from '@/pages/PageNotFound';
import { Research } from '@/pages/Research';

export const workspaceRoutes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      {
        index: true,
        element: <Navigate replace to="/chat" />
      },
      {
        path: 'chat/:sessionId?',
        element: <Chat />
      },
      {
        path: 'knowledge/:documentId?',
        element: <Knowledge />
      },
      {
        path: 'memory/:memoryId?',
        element: <Memory />
      },
      {
        path: 'research',
        element: <Research />
      },
      {
        path: 'bugs/:section?/:recordId?',
        element: <BugAgent />
      },
      {
        path: '*',
        element: <PageNotFound />
      },
    ]
  }
];

export function createWorkspaceRouter() {
  return createBrowserRouter(workspaceRoutes);
}
