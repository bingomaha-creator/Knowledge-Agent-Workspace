import {
  createBrowserRouter,
  Navigate,
  type RouteObject
} from 'react-router';
import { App } from './App';
import { BugReview } from '@/pages/BugReview';
import { BugRetired } from '@/pages/BugRetired';
import { Chat } from '@/pages/Chat';
import { Knowledge } from '@/pages/Knowledge';
import { Memory } from '@/pages/Memory';
import { PageNotFound } from '@/pages/PageNotFound';
import { ResearchRetired } from '@/pages/ResearchRetired';
import { ResearchNew } from '@/pages/ResearchNew';

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
        element: <Navigate replace to="/research-new" />
      },
      {
        path: 'research/new',
        element: <Navigate replace to="/research-new/new" />
      },
      {
        path: 'research/*',
        element: <ResearchRetired />
      },
      {
        path: 'research-new/:runId?',
        element: <ResearchNew />
      },
      {
        path: 'bug-review/:section?/:reviewId?',
        element: <BugReview />
      },
      {
        path: 'bugs/:section?/:recordId?',
        element: <BugRetired />
      },
      {
        path: 'bugs/*',
        element: <BugRetired />
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
