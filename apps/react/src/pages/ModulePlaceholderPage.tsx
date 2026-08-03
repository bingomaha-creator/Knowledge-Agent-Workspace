import type { WorkspaceModule } from '@/app/modules';

type ModulePlaceholderPageProps = {
  module: WorkspaceModule;
};

export function ModulePlaceholderPage({ module }: ModulePlaceholderPageProps) {
  return (
    <section className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">{module.eyebrow}</p>
          <h2>{module.label}</h2>
          <p>{module.description}</p>
        </div>
        <span className="phase-badge">Vue parity pending</span>
      </header>

      <div className="placeholder-panel">
        <span className="placeholder-icon" aria-hidden="true">↗</span>
        <div>
          <h3>此模块将在后续 vertical slice 中迁移</h3>
          <p>
            当前页面只验证 React 路由、布局与 Provider seam，不复制尚未验证的业务实现。
          </p>
        </div>
      </div>
    </section>
  );
}
