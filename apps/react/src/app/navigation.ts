export type WorkspaceModule = {
  path: 'chat' | 'knowledge' | 'memory' | 'bugs' | 'research-new' | 'bug-review';
  label: string;
  eyebrow: string;
  description: string;
};

export const workspaceModules: readonly WorkspaceModule[] = [
  { path: 'bug-review', label: 'Bug 复盘（试用）', eyebrow: 'BUG REVIEW', description: '从已合入 PR 沉淀修复经验。' },
  {
    path: 'chat',
    label: '对话',
    eyebrow: 'CHAT',
    description: '流式回答、上下文装配与运行诊断。'
  },
  {
    path: 'knowledge',
    label: '资料库',
    eyebrow: 'KNOWLEDGE',
    description: '资料范围、索引生命周期与证据准入。'
  },
  {
    path: 'memory',
    label: '记忆中心',
    eyebrow: 'MEMORY',
    description: '候选、人工审核与相关记忆召回。'
  },
  {
    path: 'bugs',
    label: 'Bug 案例',
    eyebrow: 'BUG AGENT',
    description: '现场证据、根因假设与案例沉淀。'
  },
  {
    path: 'research-new',
    label: '深度研究',
    eyebrow: 'RESEARCH',
    description: '以资料证据为依据生成研究报告。'
  }
];

export function findWorkspaceModule(pathname: string) {
  if (pathname === '/research' || pathname.startsWith('/research/')) {
    return getWorkspaceModule('research-new');
  }
  return workspaceModules.find((module) =>
    pathname === `/${module.path}` || pathname.startsWith(`/${module.path}/`)
  );
}

export function getWorkspaceModule(path: WorkspaceModule['path']) {
  const module = workspaceModules.find((item) => item.path === path);

  if (!module) {
    throw new Error(`Unknown workspace module: ${path}`);
  }

  return module;
}
