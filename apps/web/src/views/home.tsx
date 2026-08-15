import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, GitFork, Pencil, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { api, jsonBody } from "../api.js";
import { Button, EmptyState, Field, Input, Select, Textarea } from "../components/forms.js";
import { useOperatorDialog } from "../components/operator-dialog.js";
import type { AssetRevision, Project, SafeProvider, Session } from "../types.js";

function useSelectedProject(projects: Project[]): Project | null {
  return useMemo(() => {
    const requested = new URLSearchParams(window.location.search).get("project");
    return projects.find((project) => project.id === requested) ?? projects[0] ?? null;
  }, [projects]);
}

interface ProjectFormValue {
  name: string;
  description: string;
  targetName: string;
  workspaceRoot: string | null;
}

export function HomePage() {
  const dialogs = useOperatorDialog();
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
  const [projectEditOpen, setProjectEditOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [sessionName, setSessionName] = useState("");
  const [sessionDescription, setSessionDescription] = useState("");
  const [providerSelection, setProviderSelection] = useState("");
  const [harnessId, setHarnessId] = useState("builtin-harness-blank-r1");

  const createProject = useMutation({
    mutationFn: (value: ProjectFormValue) => api<{ project: Project }>("/api/projects", { method: "POST", ...jsonBody(value) }),
    onSuccess: ({ project: created }) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setProjectOpen(false);
      window.location.assign(`/?project=${created.id}`);
    }
  });
  const updateProject = useMutation({
    mutationFn: (value: ProjectFormValue) => {
      if (!project) throw new Error("Select a project first");
      return api<{ project: Project }>(`/api/projects/${project.id}`, { method: "PATCH", ...jsonBody(value) });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setProjectEditOpen(false);
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
          description: sessionDescription,
          harnessRevisionId: harnessId || null,
          providerProfileId: providerProfileId || null,
          modelId: modelId || null
        })
      });
    },
    onSuccess: ({ session }) => {
      setSessionName("");
      setSessionDescription("");
      void queryClient.invalidateQueries({ queryKey: ["sessions", project?.id] });
      window.location.assign(`/projects/${session.projectId}/sessions/${session.id}`);
    }
  });
  const updateSession = useMutation({
    mutationFn: ({ id, name, description }: { id: string; name: string; description: string }) => api<{ session: Session }>(`/api/sessions/${id}/metadata`, { method: "PATCH", ...jsonBody({ name, description }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", project?.id] });
      setEditingSession(null);
    }
  });
  const deleteProject = useMutation({
    mutationFn: (selected: Project) => api(`/api/projects/${selected.id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      window.location.assign("/");
    }
  });
  const deleteSession = useMutation({
    mutationFn: (selected: Session) => api(`/api/sessions/${selected.id}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sessions", project?.id] })
  });
  const requestProjectDelete = async () => {
    if (!project) return;
    const count = sessionsQuery.data?.sessions.length ?? 0;
    const approved = await dialogs.confirm({
      title: `Delete project “${project.name}”?`,
      description: `This permanently deletes the project and its ${count} session${count === 1 ? "" : "s"}, conversation trees, runs, findings, jobs, and attachment records. Shared library revisions are not deleted.`,
      confirmLabel: "Delete project",
      danger: true
    });
    if (approved) deleteProject.mutate(project);
  };
  const requestSessionDelete = async (session: Session) => {
    const approved = await dialogs.confirm({
      title: `Delete session “${session.name}”?`,
      description: "This permanently deletes its conversation tree, branches, checkpoints, runs, findings, and automation jobs. Shared library revisions remain available.",
      confirmLabel: "Delete session",
      danger: true
    });
    if (approved) deleteSession.mutate(session);
  };

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
        <div><span className="eyebrow">WORKSPACE</span><h2>{project?.name ?? "No projects yet"}</h2>{project && (project.targetName || project.description) && <p className="project-brief"><strong>{project.targetName || "Unspecified target"}</strong>{project.description && <span>{project.description}</span>}</p>}</div>
        <div className="section-heading-actions">
          {project && <Button variant="secondary" onClick={() => setProjectEditOpen(true)}><Pencil size={14} /> Edit project</Button>}
          {project && <Button variant="danger" onClick={() => void requestProjectDelete()} disabled={deleteProject.isPending}><Trash2 size={14} /> Delete project</Button>}
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
          {project && <Dialog.Root open={projectEditOpen} onOpenChange={setProjectEditOpen}>
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="dialog-content">
                <Dialog.Title>Edit project briefing</Dialog.Title>
                <Dialog.Description>The target and briefing can be included in payload-generator context.</Dialog.Description>
                <ProjectForm initialValue={project} submitLabel="Save project" pendingLabel="Saving…" pending={updateProject.isPending} error={updateProject.error?.message} onSubmit={(value) => updateProject.mutate(value)} />
                <Dialog.Close className="dialog-close" aria-label="Close"><X size={17} /></Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>}
        </div>
      </section>
      {deleteProject.error && <div className="form-error home-delete-error">{deleteProject.error.message}</div>}

      {!project ? (
        <EmptyState title="Create your first project"><p>A project is the stable container around related attack sessions and findings.</p></EmptyState>
      ) : (
        <div className="dashboard-grid">
          <section className="panel session-list-panel">
            <div className="panel-title"><GitFork size={16} /><span>Sessions</span><small>{sessionsQuery.data?.sessions.length ?? 0}</small></div>
            <div className="session-list">
              {sessionsQuery.data?.sessions.map((session) => (
                <div className="session-row" key={session.id}>
                  <Link to="/projects/$projectId/sessions/$sessionId" params={{ projectId: project.id, sessionId: session.id }} className="session-row-link">
                    <span className="session-status" />
                    <span><strong>{session.name}</strong>{session.description && <small className="session-description">{session.description}</small>}<small>{session.modelId ?? "No model selected"} · {new Date(session.updatedAt).toLocaleString()}</small></span>
                    <ArrowRight size={16} />
                  </Link>
                  <div className="session-row-actions"><Button variant="ghost" onClick={() => setEditingSession(session)} title={`Edit ${session.name}`} aria-label={`Edit ${session.name} session`}><Pencil size={13} /></Button><Button variant="ghost" className="session-delete" onClick={() => void requestSessionDelete(session)} disabled={deleteSession.isPending && deleteSession.variables?.id === session.id} title={`Delete ${session.name}`} aria-label={`Delete ${session.name} session`}><Trash2 size={13} /></Button></div>
                </div>
              ))}
              {sessionsQuery.data?.sessions.length === 0 && <div className="quiet">No sessions in this project.</div>}
              {deleteSession.error && <div className="form-error session-delete-error">{deleteSession.error.message}</div>}
            </div>
          </section>

          <section className="panel new-session-panel">
            <div className="panel-title"><ShieldCheck size={16} /><span>Start a session</span></div>
            <form onSubmit={(event) => { event.preventDefault(); createSession.mutate(); }}>
              <Field label="Session name"><Input value={sessionName} onChange={(event) => setSessionName(event.target.value)} placeholder="Tool result injection" required /></Field>
              <Field label="Session briefing" hint="Optional context for payload generation; describe the objective, assumptions, or target surface."><Textarea value={sessionDescription} onChange={(event) => setSessionDescription(event.target.value)} rows={4} maxLength={4_000} /></Field>
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
      {editingSession && <Dialog.Root open onOpenChange={(next) => { if (!next) setEditingSession(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>Edit session briefing</Dialog.Title>
            <Dialog.Description>Session metadata is available to payload context without changing the conversation transcript.</Dialog.Description>
            <SessionMetadataForm session={editingSession} pending={updateSession.isPending} error={updateSession.error?.message} onSubmit={(value) => updateSession.mutate({ id: editingSession.id, ...value })} />
            <Dialog.Close className="dialog-close" aria-label="Close"><X size={17} /></Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>}
    </div>
  );
}

function ProjectForm({ initialValue, submitLabel = "Create project", pendingLabel = "Creating…", pending, error, onSubmit }: { initialValue?: ProjectFormValue; submitLabel?: string; pendingLabel?: string; pending: boolean; error: string | undefined; onSubmit(value: ProjectFormValue): void }) {
  const [name, setName] = useState(initialValue?.name ?? "");
  const [description, setDescription] = useState(initialValue?.description ?? "");
  const [targetName, setTargetName] = useState(initialValue?.targetName ?? "");
  const [workspaceRoot, setWorkspaceRoot] = useState(initialValue?.workspaceRoot ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({ name, description, targetName, workspaceRoot: workspaceRoot || null });
  };
  return <form onSubmit={submit} className="dialog-form">
    <Field label="Name"><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} required /></Field>
    <Field label="Target name" hint="The system, model, application, or organization under test."><Input value={targetName} onChange={(event) => setTargetName(event.target.value)} maxLength={200} placeholder="Acme support assistant" /></Field>
    <Field label="Description"><Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></Field>
    <Field label="Workspace root" hint="Optional. MCP roots default to none."><Input value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} placeholder="/absolute/path" /></Field>
    {error && <div className="form-error">{error}</div>}
    <Button disabled={pending}>{pending ? pendingLabel : submitLabel}</Button>
  </form>;
}

function SessionMetadataForm({ session, pending, error, onSubmit }: { session: Session; pending: boolean; error: string | undefined; onSubmit(value: { name: string; description: string }): void }) {
  const [name, setName] = useState(session.name);
  const [description, setDescription] = useState(session.description);
  return <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); onSubmit({ name, description }); }}>
    <Field label="Session name"><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></Field>
    <Field label="Session briefing"><Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} maxLength={4_000} /></Field>
    {error && <div className="form-error">{error}</div>}
    <Button disabled={pending || !name.trim()}>{pending ? "Saving…" : "Save session"}</Button>
  </form>;
}
