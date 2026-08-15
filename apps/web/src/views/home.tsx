import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, GitFork, Plus, ShieldCheck, X } from "lucide-react";
import { api, jsonBody } from "../api.js";
import { Button, EmptyState, Field, Input, Select, Textarea } from "../components/forms.js";
import type { AssetRevision, Project, SafeProvider, Session } from "../types.js";

function useSelectedProject(projects: Project[]): Project | null {
  return useMemo(() => {
    const requested = new URLSearchParams(window.location.search).get("project");
    return projects.find((project) => project.id === requested) ?? projects[0] ?? null;
  }, [projects]);
}

export function HomePage() {
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => api<{ projects: Project[] }>("/api/projects") });
  const project = useSelectedProject(projectsQuery.data?.projects ?? []);
  const sessionsQuery = useQuery({
    queryKey: ["sessions", project?.id],
    queryFn: () => api<{ sessions: Session[] }>(`/api/sessions?projectId=${encodeURIComponent(project?.id ?? "")}`),
    enabled: Boolean(project)
  });
  const providersQuery = useQuery({ queryKey: ["providers"], queryFn: () => api<{ providers: SafeProvider[] }>("/api/providers") });
  const harnessesQuery = useQuery({ queryKey: ["assets", "harness"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=harness") });
  const [projectOpen, setProjectOpen] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [providerSelection, setProviderSelection] = useState("");
  const [harnessId, setHarnessId] = useState("builtin-harness-blank-r1");

  const createProject = useMutation({
    mutationFn: (value: { name: string; description: string; workspaceRoot: string | null }) => api<{ project: Project }>("/api/projects", { method: "POST", ...jsonBody(value) }),
    onSuccess: ({ project: created }) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setProjectOpen(false);
      window.location.assign(`/?project=${created.id}`);
    }
  });
  const createSession = useMutation({
    mutationFn: async () => {
      if (!project) throw new Error("Create a project first");
      const [providerProfileId, modelId] = providerSelection.split("::");
      return api<{ session: Session }>("/api/sessions", {
        method: "POST",
        ...jsonBody({
          projectId: project.id,
          name: sessionName,
          harnessRevisionId: harnessId || null,
          providerProfileId: providerProfileId || null,
          modelId: modelId || null
        })
      });
    },
    onSuccess: ({ session }) => {
      setSessionName("");
      void queryClient.invalidateQueries({ queryKey: ["sessions", project?.id] });
      window.location.assign(`/projects/${session.projectId}/sessions/${session.id}`);
    }
  });

  return (
    <div className="home-view">
      <section className="home-hero">
        <div>
          <span className="eyebrow">THE HANDS-ON BENCH</span>
          <h1>Explore the path.<br /><em>Keep every branch.</em></h1>
          <p>Manual AI red teaming without transcript bookkeeping. Fork, rewind, vary, and preserve the evidence.</p>
        </div>
        <div className="hero-diagram" aria-hidden="true">
          <span className="diagram-node root-node" /><span className="diagram-line line-a" /><span className="diagram-line line-b" />
          <span className="diagram-node node-a" /><span className="diagram-node node-b" /><span className="diagram-node node-c" />
        </div>
      </section>

      <section className="section-heading">
        <div><span className="eyebrow">WORKSPACE</span><h2>{project?.name ?? "No projects yet"}</h2></div>
        <Dialog.Root open={projectOpen} onOpenChange={setProjectOpen}>
          <Dialog.Trigger asChild><Button variant="secondary"><Plus size={15} /> New project</Button></Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="dialog-content">
              <Dialog.Title>Create a project</Dialog.Title>
              <Dialog.Description>Projects group sessions, findings, attachments, and an optional workspace root.</Dialog.Description>
              <ProjectForm pending={createProject.isPending} error={createProject.error?.message} onSubmit={(value) => createProject.mutate(value)} />
              <Dialog.Close className="dialog-close" aria-label="Close"><X size={17} /></Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </section>

      {!project ? (
        <EmptyState title="Create your first project"><p>A project is the stable container around related attack sessions and findings.</p></EmptyState>
      ) : (
        <div className="dashboard-grid">
          <section className="panel session-list-panel">
            <div className="panel-title"><GitFork size={16} /><span>Sessions</span><small>{sessionsQuery.data?.sessions.length ?? 0}</small></div>
            <div className="session-list">
              {sessionsQuery.data?.sessions.map((session) => (
                <Link key={session.id} to="/projects/$projectId/sessions/$sessionId" params={{ projectId: project.id, sessionId: session.id }} className="session-row">
                  <span className="session-status" />
                  <span><strong>{session.name}</strong><small>{session.modelId ?? "No model selected"} · {new Date(session.updatedAt).toLocaleString()}</small></span>
                  <ArrowRight size={16} />
                </Link>
              ))}
              {sessionsQuery.data?.sessions.length === 0 && <div className="quiet">No sessions in this project.</div>}
            </div>
          </section>

          <section className="panel new-session-panel">
            <div className="panel-title"><ShieldCheck size={16} /><span>Start a session</span></div>
            <form onSubmit={(event) => { event.preventDefault(); createSession.mutate(); }}>
              <Field label="Session name"><Input value={sessionName} onChange={(event) => setSessionName(event.target.value)} placeholder="Tool result injection" required /></Field>
              <Field label="Harness">
                <Select value={harnessId} onChange={(event) => setHarnessId(event.target.value)}>
                  {harnessesQuery.data?.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                </Select>
              </Field>
              <Field label="Provider / model" hint={providersQuery.data?.providers.length ? undefined : "Add a provider in Settings; you can also configure this later."}>
                <Select value={providerSelection} onChange={(event) => setProviderSelection(event.target.value)}>
                  <option value="">Configure later</option>
                  {providersQuery.data?.providers.flatMap((provider) => provider.models.map((model) => (
                    <option key={`${provider.id}:${model.id}`} value={`${provider.id}::${model.id}`}>{provider.label} · {model.label}</option>
                  )))}
                </Select>
              </Field>
              {createSession.error && <div className="form-error">{createSession.error.message}</div>}
              <Button disabled={!sessionName || createSession.isPending}>{createSession.isPending ? "Creating…" : "Open workbench"}<ArrowRight size={15} /></Button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

function ProjectForm({ pending, error, onSubmit }: { pending: boolean; error: string | undefined; onSubmit(value: { name: string; description: string; workspaceRoot: string | null }): void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({ name, description, workspaceRoot: workspaceRoot || null });
  };
  return <form onSubmit={submit} className="dialog-form">
    <Field label="Name"><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} required /></Field>
    <Field label="Description"><Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></Field>
    <Field label="Workspace root" hint="Optional. MCP roots default to none."><Input value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} placeholder="/absolute/path" /></Field>
    {error && <div className="form-error">{error}</div>}
    <Button disabled={pending}>{pending ? "Creating…" : "Create project"}</Button>
  </form>;
}
