import type { PropsWithChildren } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Settings2 } from "lucide-react";
import { api, hasLaunchToken } from "./api.js";
import type { Project } from "./types.js";

interface AppConfig {
  version: string;
  databaseDialect: string;
  dataDirectory: string;
  warnings: string[];
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
      {config.data?.warnings[0] && (
        <div className="security-banner"><AlertTriangle size={14} /> {config.data.warnings[0]}</div>
      )}
      <div className="body-shell">
        <aside className="project-rail">
          <div className="rail-heading">Projects</div>
          <nav>
            {projects.data?.projects.map((project) => (
              <a href={`/?project=${project.id}`} key={project.id} className="project-link">
                <span>{project.name.slice(0, 1).toUpperCase()}</span>{project.name}
              </a>
            ))}
            {projects.isLoading && <div className="skeleton-line" />}
          </nav>
          <div className="rail-footer">v{config.data?.version ?? "0.1.0"}</div>
        </aside>
        <main className="main-stage">{children}</main>
      </div>
    </div>
  );
}
