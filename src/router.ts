import { defineComponent } from 'vue';
import {
  createRouter,
  createWebHistory,
  type RouterHistory
} from 'vue-router';

const WorkspaceRoutePlaceholder = defineComponent({
  name: 'WorkspaceRoutePlaceholder',
  render: () => null
});

export function createWorkspaceRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({
    history,
    routes: [
      { path: '/', redirect: '/chat' },
      { path: '/chat', name: 'chat', component: WorkspaceRoutePlaceholder },
      { path: '/knowledge', name: 'knowledge', component: WorkspaceRoutePlaceholder },
      { path: '/memory', name: 'memory', component: WorkspaceRoutePlaceholder },
      { path: '/bugs', name: 'bugs', component: WorkspaceRoutePlaceholder },
      { path: '/research', name: 'research', component: WorkspaceRoutePlaceholder },
      {
        path: '/research/:taskId',
        name: 'research-task',
        component: WorkspaceRoutePlaceholder,
        props: true
      },
      { path: '/:pathMatch(.*)*', redirect: '/chat' }
    ]
  });
}

export const router = createWorkspaceRouter();
