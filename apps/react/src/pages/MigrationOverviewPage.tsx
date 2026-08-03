import { Link } from 'react-router';
import { workspaceModules } from '@/app/modules';

export function MigrationOverviewPage() {
  return (
    <section className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">REACT MIGRATION</p>
          <h2>双版本迁移基线</h2>
          <p>
            React 已拥有独立入口、路由和服务端状态 Provider，当前尚未迁移业务行为。
          </p>
        </div>
        <span className="phase-badge">Foundation · Phase 0</span>
      </header>

      <div className="migration-banner">
        <strong>稳定原则</strong>
        <p>
          Vue 继续作为默认产品版本；每个 React vertical slice 通过回归后再进入下一模块。
        </p>
      </div>

      <div className="module-grid" aria-label="Migration modules">
        {workspaceModules.map((module, index) => (
          <Link className="module-card" to={`/${module.path}`} key={module.path}>
            <span className="module-index">{String(index + 1).padStart(2, '0')}</span>
            <p className="eyebrow">{module.eyebrow}</p>
            <h3>{module.label}</h3>
            <p>{module.description}</p>
            <span className="module-state">等待迁移</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
