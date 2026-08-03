import { NavLink, Outlet } from 'react-router';
import { workspaceModules } from './modules';

export function App() {
  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar">
        <div className="brand-card">
          <span className="brand-mark" aria-hidden="true">✦</span>
          <div>
            <p className="eyebrow">MATTHEW&apos;S AI WORKSPACE</p>
            <h1>Matthew&apos;s Workspace</h1>
            <p>React migration preview</p>
          </div>
        </div>

        <nav className="workspace-nav" aria-label="Workspace modules">
          {workspaceModules.map((module) => (
            <NavLink
              key={module.path}
              to={`/${module.path}`}
              className={({ isActive }) => isActive ? 'nav-link is-active' : 'nav-link'}
            >
              <span>{module.label}</span>
              <small>{module.eyebrow}</small>
            </NavLink>
          ))}
        </nav>

        <div className="baseline-note">
          <span className="status-dot" aria-hidden="true" />
          <div>
            <strong>Vue baseline remains active</strong>
            <p>React 将按 vertical slice 逐步追平。</p>
          </div>
        </div>
      </aside>

      <main className="workspace-main">
        <Outlet />
      </main>
    </div>
  );
}
