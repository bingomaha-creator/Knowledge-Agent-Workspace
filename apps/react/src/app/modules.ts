export type WorkspaceModule = {
  path: string;
  label: string;
  eyebrow: string;
  description: string;
};

export const workspaceModules: WorkspaceModule[] = [
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
    path: 'research',
    label: '深度研究',
    eyebrow: 'RESEARCH',
    description: '研究计划、证据装配与报告生成。'
  }
];
