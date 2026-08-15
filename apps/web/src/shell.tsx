import { useEffect, useState, type PropsWithChildren, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PanelLeftClose, PanelLeftOpen, Settings2 } from "lucide-react";
import { api, hasLaunchToken } from "./api.js";
import type { Project } from "./types.js";

interface AppConfig {
  version: string;
  databaseDialect: string;
  dataDirectory: string;
}

const PROJECT_RAIL_STORAGE_KEY = "lathe.project-rail-collapsed";

function savedProjectRailState(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const saved = window.localStorage.getItem(PROJECT_RAIL_STORAGE_KEY);
    if (saved !== null) return saved === "true";
    return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 600px)").matches;
  } catch {
    return false;
  }
}

interface ProjectRailLayoutProps {
  children: ReactNode;
  projects?: Project[];
  projectsLoading?: boolean;
  version?: string;
}

export function ProjectRailLayout({ children, projects = [], projectsLoading = false, version = "0.1.0" }: ProjectRailLayoutProps) {
  const [collapsed, setCollapsed] = useState(savedProjectRailState);

  useEffect(() => {
    try {
      window.localStorage.setItem(PROJECT_RAIL_STORAGE_KEY, String(collapsed));
    } catch {
      // A blocked storage API should not prevent the operator from using the rail.
    }
  }, [collapsed]);

  const toggleLabel = collapsed ? "Expand projects sidebar" : "Collapse projects sidebar";

  return (
    <div className={`body-shell${collapsed ? " project-rail-collapsed" : ""}`}>
      <aside className="project-rail" aria-label="Projects sidebar" data-collapsed={collapsed}>
        <div className="rail-header">
          <div className="rail-heading">Projects</div>
          <button
            type="button"
            className="rail-toggle"
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
            aria-controls="project-navigation"
            title={toggleLabel}
            onClick={() => setCollapsed((current) => !current)}
          >
            {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        </div>
        <nav id="project-navigation" aria-label="Projects">
          {projects.map((project) => (
            <a
              href={`/?project=${project.id}`}
              key={project.id}
              className="project-link"
              aria-label={collapsed ? project.name : undefined}
              title={collapsed ? project.name : undefined}
            >
              <span className="project-avatar" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
              <span className="project-name">{project.name}</span>
            </a>
          ))}
          {projectsLoading && <div className="skeleton-line" />}
        </nav>
        <div className="rail-footer">v{version}</div>
      </aside>
      <main className="main-stage">{children}</main>
    </div>
  );
}

export function Shell({ children }: PropsWithChildren) {
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ projects: Project[] }>("/api/projects"),
    enabled: hasLaunchToken()
  });
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => api<AppConfig>("/api/config"),
    enabled: hasLaunchToken()
  });

  if (!hasLaunchToken()) {
    return (
      <main className="locked-screen">
        <div className="locked-card">
          <div className="brand-mark">L</div>
          <h1>Launch token missing</h1>
          <p>Open the tokenized Lathe URL printed by <code>pnpm dev</code> or <code>pnpm start</code>.</p>
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">L</span>
          <span><strong>LATHE</strong><small>red-team workbench</small></span>
        </Link>
        <div className="topbar-meta">
          <span className="status-dot" /> local · {config.data?.databaseDialect ?? "…"}
          <Link to="/settings" className="icon-button" aria-label="Settings"><Settings2 size={17} /></Link>
        </div>
      </header>
      <ProjectRailLayout
        projects={projects.data?.projects ?? []}
        projectsLoading={projects.isLoading}
        version={config.data?.version ?? "0.1.0"}
      >
        {children}
      </ProjectRailLayout>
    </div>
  );
}
