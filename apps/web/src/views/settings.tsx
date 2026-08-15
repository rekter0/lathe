import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { Braces, Cable, Download, KeyRound, Library, PackageOpen, Plus, RefreshCw, ShieldCheck, TerminalSquare, Upload } from "lucide-react";
import { api, downloadApiFile, jsonBody } from "../api.js";
import { Button, Field, Input, Select, Textarea } from "../components/forms.js";
import type { AssetRevision, SafeProvider } from "../types.js";
import type { ModelCapabilities, SecretMetadata } from "@lathe/domain";

interface DiscoveredModel {
  id: string;
  label?: string;
  source: "manual" | "discovered";
  capabilities?: ModelCapabilities;
}

const defaultDiscoveredCapabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  images: false,
  files: false,
  jsonMode: false,
  maxContextTokens: null
};

export function SettingsPage() {
  return <div className="settings-view">
    <div className="page-heading"><span className="eyebrow">GLOBAL LIBRARY</span><h1>Workbench settings</h1><p>Providers and versioned assets are shared across projects. Secrets never appear again after saving.</p></div>
    <Tabs.Root defaultValue="providers" className="settings-tabs">
      <Tabs.List className="tabs-list">
        <Tabs.Trigger value="providers"><KeyRound size={15} /> Providers</Tabs.Trigger>
        <Tabs.Trigger value="prompts"><Library size={15} /> Prompts</Tabs.Trigger>
        <Tabs.Trigger value="tools"><TerminalSquare size={15} /> Tools</Tabs.Trigger>
        <Tabs.Trigger value="connections"><Cable size={15} /> Targets & MCP</Tabs.Trigger>
        <Tabs.Trigger value="artifacts"><PackageOpen size={15} /> Artifacts</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="providers"><ProviderSettings /></Tabs.Content>
      <Tabs.Content value="prompts"><AssetSettings kind="prompt" /></Tabs.Content>
      <Tabs.Content value="tools"><AssetSettings kind="tool-spec" /></Tabs.Content>
      <Tabs.Content value="connections"><ConnectionSettings /></Tabs.Content>
      <Tabs.Content value="artifacts"><ArtifactSettings /></Tabs.Content>
    </Tabs.Root>
  </div>;
}

function ProviderSettings() {
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => api<{ providers: SafeProvider[] }>("/api/providers") });
  const [label, setLabel] = useState("");
  const [protocol, setProtocol] = useState<SafeProvider["protocol"]>("openai-responses");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com");
  const [endpointOverride, setEndpointOverride] = useState("");
  const [credential, setCredential] = useState("");
  const [modelId, setModelId] = useState("");
  const [headers, setHeaders] = useState("{}");
  const [extraBody, setExtraBody] = useState("{}");
  const create = useMutation({
    mutationFn: () => api("/api/providers", {
      method: "POST",
      ...jsonBody({
        label, protocol, baseUrl, endpointOverride: endpointOverride || null, credential,
        headers: JSON.parse(headers), extraBody: JSON.parse(extraBody),
        models: modelId ? [{ id: modelId, label: modelId, discovered: false, capabilities: { streaming: true, tools: true, images: false, files: false, jsonMode: false, maxContextTokens: null } }] : []
      })
    }),
    onSuccess: () => {
      setLabel(""); setCredential(""); setModelId(""); setEndpointOverride("");
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
    }
  });
  const discover = useMutation({
    mutationFn: (providerId: string) => api<{ models: DiscoveredModel[]; warnings: string[] }>(`/api/providers/${providerId}/discover`, { method: "POST" })
  });
  const saveCatalog = useMutation({
    mutationFn: ({ providerId, models }: { providerId: string; models: DiscoveredModel[] }) => api(`/api/providers/${providerId}/revisions`, {
      method: "POST",
      ...jsonBody({ models: models.map((model) => ({
        id: model.id,
        label: model.label ?? model.id,
        discovered: model.source === "discovered",
        capabilities: model.capabilities ?? defaultDiscoveredCapabilities
      })) })
    }),
    onSuccess: () => {
      discover.reset();
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
    }
  });
  const submit = (event: FormEvent) => { event.preventDefault(); create.mutate(); };
  return <div className="settings-grid">
    <section className="panel library-list">
      <div className="panel-title"><KeyRound size={16} /> Saved providers</div>
      {providers.data?.providers.map((provider) => <article className="library-card" key={provider.id}>
        <div><strong>{provider.label}</strong><small>{provider.protocol}</small></div><Button variant="ghost" onClick={() => discover.mutate(provider.id)} title="Discover compatible models" disabled={discover.isPending && discover.variables === provider.id}><RefreshCw size={13} className={discover.isPending && discover.variables === provider.id ? "spin-icon" : ""} /></Button>
        <code>{provider.baseUrl}</code>
        <p>{provider.models.length} models · credential {provider.hasCredential ? "stored" : "not set"}</p>
        {discover.variables === provider.id && discover.data && <div className="discovery-result"><strong>{discover.data.models.length} models discovered</strong>{discover.data.models.slice(0, 12).map((model) => <code key={model.id}>{model.id}</code>)}{discover.data.models.length > 12 && <small>+{discover.data.models.length - 12} more</small>}{discover.data.warnings.map((warning) => <small className="warning" key={warning}>{warning}</small>)}<Button variant="secondary" onClick={() => saveCatalog.mutate({ providerId: provider.id, models: discover.data.models })} disabled={discover.data.models.length === 0 || saveCatalog.isPending}><SaveCatalogIcon />{saveCatalog.isPending ? "Saving revision…" : "Save discovered catalog"}</Button>{saveCatalog.error && <div className="form-error">{saveCatalog.error.message}</div>}</div>}
      </article>)}
      {providers.data?.providers.length === 0 && <p className="quiet">No provider profiles yet.</p>}
    </section>
    <section className="panel editor-panel">
      <div className="panel-title"><Plus size={16} /> New provider profile</div>
      <form onSubmit={submit}>
        <div className="two-fields"><Field label="Label"><Input value={label} onChange={(event) => setLabel(event.target.value)} required /></Field>
          <Field label="Protocol"><Select value={protocol} onChange={(event) => setProtocol(event.target.value as SafeProvider["protocol"])}>
            <option value="openai-responses">OpenAI Responses</option><option value="openai-chat">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option>
          </Select></Field></div>
        <Field label="Base URL"><Input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></Field>
        <Field label="Generation endpoint override" hint="Optional full path/URL for compatible gateways with a non-standard generation endpoint."><Input value={endpointOverride} onChange={(event) => setEndpointOverride(event.target.value)} placeholder="https://gateway.example/v1/responses" /></Field>
        <div className="two-fields"><Field label="API credential"><Input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} autoComplete="off" /></Field>
          <Field label="Initial model ID"><Input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="model-id" /></Field></div>
        <Field label="Custom headers (JSON)"><CodeMirror value={headers} onChange={setHeaders} extensions={[json()]} height="88px" theme="dark" /></Field>
        <Field label="Extra request body (JSON)" hint="Core model/input/tools/stream fields are protected."><CodeMirror value={extraBody} onChange={setExtraBody} extensions={[json()]} height="88px" theme="dark" /></Field>
        {create.error && <div className="form-error">{create.error.message}</div>}
        <Button disabled={!label || !baseUrl || create.isPending}>Save provider</Button>
      </form>
    </section>
  </div>;
}

function SaveCatalogIcon() { return <span aria-hidden="true">↳</span>; }

function AssetSettings({ kind }: { kind: "prompt" | "tool-spec" }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["assets", kind], queryFn: () => api<{ assets: AssetRevision[] }>(`/api/assets?kind=${kind}`) });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [schema, setSchema] = useState('{\n  "type": "object",\n  "properties": {}\n}');
  const create = useMutation({
    mutationFn: () => api("/api/library/assets", {
      method: "POST",
      ...jsonBody({
        kind, name, description, tags: [], trusted: true, provenance: { operatorAuthored: true },
        value: kind === "prompt" ? { content } : { name, description, inputSchema: JSON.parse(schema) }
      })
    }),
    onSuccess: () => { setName(""); setDescription(""); setContent(""); void queryClient.invalidateQueries({ queryKey: ["assets", kind] }); }
  });
  return <><div className="settings-grid">
    <section className="panel library-list"><div className="panel-title"><Library size={16} /> Versioned {kind === "prompt" ? "prompts" : "tool specifications"}</div>
      {query.data?.assets.map((asset) => <article className="library-card" key={asset.id}><div><strong>{asset.name}</strong><small>revision {asset.revision}</small></div><span className={`pill ${asset.trusted ? "pill-safe" : ""}`}>{asset.trusted ? "trusted" : "disabled"}</span><p>{asset.description || "No description"}</p><code>{asset.contentHash.slice(0, 16)}…</code></article>)}
    </section>
    <section className="panel editor-panel"><div className="panel-title"><Plus size={16} /> New {kind === "prompt" ? "prompt" : "tool"}</div>
      <form onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
        <Field label="Label"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
        <Field label="Description"><Input value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        {kind === "prompt" ? <Field label="System prompt"><Textarea value={content} onChange={(event) => setContent(event.target.value)} rows={12} required /></Field>
          : <Field label="JSON Schema"><CodeMirror value={schema} onChange={setSchema} extensions={[json()]} height="260px" theme="dark" /></Field>}
        {create.error && <div className="form-error">{create.error.message}</div>}<Button disabled={!name || create.isPending}>Save immutable revision</Button>
      </form>
    </section>
  </div>{kind === "tool-spec" && <ToolImplementationEditor />}</>;
}

function ToolImplementationEditor() {
  const queryClient = useQueryClient();
  const implementations = useQuery({ queryKey: ["assets", "tool-implementation"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=tool-implementation") });
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"real" | "mock">("real");
  const [source, setSource] = useState(`function build(input) {\n  return { program: "/usr/bin/printf", args: ["%s", String(input.arguments.value)] };\n}\n\nfunction formatResult(result) {\n  return { output: result.stdout.text, exitCode: result.exitCode };\n}`);
  const [mockResult, setMockResult] = useState('{\n  "ok": true\n}');
  const create = useMutation({
    mutationFn: () => api("/api/library/assets", { method: "POST", ...jsonBody({
      kind: "tool-implementation", name, description: mode === "real" ? "QuickJS command handler" : "Deterministic mock response",
      tags: [mode], provenance: { operatorAuthored: true }, trusted: true,
      value: mode === "real" ? { source } : { result: JSON.parse(mockResult) }
    }) }),
    onSuccess: () => { setName(""); void queryClient.invalidateQueries({ queryKey: ["assets", "tool-implementation"] }); }
  });
  const trust = useMutation({
    mutationFn: (asset: AssetRevision) => api("/api/library/assets", { method: "POST", ...jsonBody({
      assetId: asset.assetId,
      kind: "tool-implementation",
      name: asset.name,
      description: asset.description,
      tags: asset.tags,
      provenance: { ...asset.provenance, trustedFromRevisionId: asset.id, operatorTrustedAt: new Date().toISOString() },
      value: asset.value,
      trusted: true
    }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["assets", "tool-implementation"] })
  });
  return <section className="panel implementation-panel"><div className="panel-title"><Braces size={16} /> Tool implementations</div><div className="implementation-layout"><div className="library-list compact-list">{implementations.data?.assets.map((asset) => {
    const latest = implementations.data.assets.filter((candidate) => candidate.assetId === asset.assetId).toSorted((left, right) => right.revision - left.revision)[0];
    const mayTrust = !asset.trusted && latest?.id === asset.id;
    return <article className="library-card" key={asset.id}><div><strong>{asset.name}</strong><small>{asset.tags.join(" · ") || "implementation"} · revision {asset.revision}</small></div><span className={`pill ${asset.trusted ? "pill-safe" : ""}`}>{asset.trusted ? "enabled" : "disabled"}</span><code>{asset.contentHash.slice(0, 16)}…</code>{mayTrust && <Button variant="danger" className="trust-action" onClick={() => { if (window.confirm(`Create a new trusted revision of ${asset.name}? Its handler may prepare commands, but every real execution still requires operator approval.`)) trust.mutate(asset); }} disabled={trust.isPending}><ShieldCheck size={12} /> Trust as new revision</Button>}</article>;
  })}{trust.error && <div className="form-error implementation-error">{trust.error.message}</div>}</div><form onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
    <div className="two-fields"><Field label="Label"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="Mode"><Select value={mode} onChange={(event) => setMode(event.target.value as "real" | "mock")}><option value="real">Real command handler</option><option value="mock">Deterministic mock</option></Select></Field></div>
    {mode === "real" ? <Field label="Synchronous QuickJS source" hint="Expose build(input) and formatResult(result). No imports, filesystem, network, process, or environment access."><CodeMirror value={source} onChange={setSource} height="260px" theme="dark" /></Field> : <Field label="Mock JSON result"><CodeMirror value={mockResult} onChange={setMockResult} extensions={[json()]} height="160px" theme="dark" /></Field>}
    {create.error && <div className="form-error">{create.error.message}</div>}<Button disabled={!name || create.isPending}>Save implementation revision</Button>
  </form></div></section>;
}

function ConnectionSettings() {
  const queryClient = useQueryClient();
  const targets = useQuery({ queryKey: ["assets", "target"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=target") });
  const servers = useQuery({ queryKey: ["assets", "mcp-server"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=mcp-server") });
  const secrets = useQuery({ queryKey: ["secrets"], queryFn: () => api<{ secrets: SecretMetadata[] }>("/api/secrets") });
  const [secretLabel, setSecretLabel] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [targetName, setTargetName] = useState("");
  const [targetJson, setTargetJson] = useState('{\n  "id": "container",\n  "label": "Existing container",\n  "kind": "container",\n  "runtime": "docker",\n  "container": "container-name"\n}');
  const [mcpName, setMcpName] = useState("");
  const [mcpKind, setMcpKind] = useState<"stdio" | "streamableHttp">("stdio");
  const [mcpAddress, setMcpAddress] = useState("");
  const [mcpTargetId, setMcpTargetId] = useState("");
  const [mcpRoots, setMcpRoots] = useState("[]");
  const [secretId, setSecretId] = useState("");
  const createSecret = useMutation({ mutationFn: () => api("/api/secrets", { method: "POST", ...jsonBody({ label: secretLabel, value: secretValue }) }), onSuccess: () => { setSecretLabel(""); setSecretValue(""); void queryClient.invalidateQueries({ queryKey: ["secrets"] }); } });
  const createTarget = useMutation({ mutationFn: () => api("/api/library/assets", { method: "POST", ...jsonBody({ kind: "target", name: targetName, description: "Operator-authored execution target", tags: [], provenance: { operatorAuthored: true }, trusted: true, value: JSON.parse(targetJson) }) }), onSuccess: () => { setTargetName(""); void queryClient.invalidateQueries({ queryKey: ["assets", "target"] }); } });
  const createMcp = useMutation({ mutationFn: () => {
    const id = crypto.randomUUID();
    const transport = mcpKind === "stdio"
      ? { kind: "stdio", command: mcpAddress, args: [], ...(mcpTargetId ? { executionTargetId: mcpTargetId } : {}), ...(secretId ? { env: { LATHE_MCP_TOKEN: { kind: "secret", secretId } } } : {}) }
      : { kind: "streamableHttp", url: mcpAddress, ...(secretId ? { headers: { Authorization: { kind: "secret", secretId, prefix: "Bearer " } } } : {}) };
    return api("/api/library/assets", { method: "POST", ...jsonBody({ kind: "mcp-server", name: mcpName, description: "Operator-authored MCP server", tags: [mcpKind], provenance: { operatorAuthored: true }, trusted: true, value: { id, revision: "1", name: mcpName, transport, roots: JSON.parse(mcpRoots) } }) });
  }, onSuccess: () => { setMcpName(""); setMcpAddress(""); setMcpTargetId(""); setMcpRoots("[]"); void queryClient.invalidateQueries({ queryKey: ["assets", "mcp-server"] }); } });
  const inspectMcp = useMutation({ mutationFn: (revisionId: string) => api<{ snapshot: unknown; traceHash: string }>(`/api/mcp/${revisionId}/capabilities`, { method: "POST" }) });
  const trustConnection = useMutation({
    mutationFn: (asset: AssetRevision) => {
      if (asset.kind !== "target" && asset.kind !== "mcp-server") throw new Error("Only target and MCP server revisions can be trusted here");
      return api("/api/library/assets", { method: "POST", ...jsonBody({
        assetId: asset.assetId,
        kind: asset.kind,
        name: asset.name,
        description: asset.description,
        tags: asset.tags,
        provenance: { ...asset.provenance, trustedFromRevisionId: asset.id, operatorTrustedAt: new Date().toISOString() },
        value: asset.value,
        trusted: true
      }) });
    },
    onSuccess: (_result, asset) => void queryClient.invalidateQueries({ queryKey: ["assets", asset.kind] })
  });
  return <><div className="connection-grid">
    <section className="panel"><div className="panel-title"><TerminalSquare size={16} /> Execution targets</div><p className="quiet">Host execution is built in. Container and SSH targets are versioned global assets and always require approval by default.</p>
      {targets.data?.assets.map((asset) => {
        const latest = targets.data.assets.filter((candidate) => candidate.assetId === asset.assetId).toSorted((left, right) => right.revision - left.revision)[0];
        const mayTrust = !asset.trusted && latest?.id === asset.id;
        return <article className="library-card" key={asset.id}><div><strong>{asset.name}</strong><small>revision {asset.revision}</small></div><span className={`pill ${asset.trusted ? "pill-safe" : ""}`}>{asset.trusted ? "enabled" : "disabled"}</span><code>{JSON.stringify(asset.value)}</code>{mayTrust && <Button variant="danger" className="trust-action" onClick={() => { if (window.confirm(`Create a new trusted revision of ${asset.name}? This target may launch host, container, or SSH commands after per-call approval.`)) trustConnection.mutate(asset); }} disabled={trustConnection.isPending}><ShieldCheck size={12} /> Trust as new revision</Button>}</article>;
      })}<form className="connection-form" onSubmit={(event) => { event.preventDefault(); createTarget.mutate(); }}><Field label="Target label"><Input value={targetName} onChange={(event) => setTargetName(event.target.value)} required /></Field><Field label="Target JSON"><CodeMirror value={targetJson} onChange={setTargetJson} extensions={[json()]} height="175px" theme="dark" /></Field><Button disabled={!targetName}>Save target</Button></form></section>
    <section className="panel"><div className="panel-title"><Cable size={16} /> MCP servers</div><p className="quiet">Stdio and Streamable HTTP are supported. Prompts and resources remain untrusted until explicitly imported.</p>
      {servers.data?.assets.map((asset) => {
        const latest = servers.data.assets.filter((candidate) => candidate.assetId === asset.assetId).toSorted((left, right) => right.revision - left.revision)[0];
        const mayTrust = !asset.trusted && latest?.id === asset.id;
        return <article className="library-card" key={asset.id}><div><strong>{asset.name}</strong><small>{asset.tags.join(" · ")} · revision {asset.revision}</small></div><span className={`pill ${asset.trusted ? "pill-safe" : ""}`}>{asset.trusted ? "enabled" : "disabled"}</span><Button variant="ghost" onClick={() => inspectMcp.mutate(asset.id)} title="Inspect capabilities" disabled={!asset.trusted}><Cable size={13} /></Button><code>{asset.contentHash.slice(0, 16)}…</code>{mayTrust && <Button variant="danger" className="trust-action" onClick={() => { if (window.confirm(`Create a new trusted revision of ${asset.name}? Inspecting or using it may connect to a server or launch its stdio command.`)) trustConnection.mutate(asset); }} disabled={trustConnection.isPending}><ShieldCheck size={12} /> Trust as new revision</Button>}</article>;
      })}<form className="connection-form" onSubmit={(event) => { event.preventDefault(); createMcp.mutate(); }}><div className="two-fields"><Field label="Server label"><Input value={mcpName} onChange={(event) => setMcpName(event.target.value)} required /></Field><Field label="Transport"><Select value={mcpKind} onChange={(event) => setMcpKind(event.target.value as typeof mcpKind)}><option value="stdio">stdio</option><option value="streamableHttp">Streamable HTTP</option></Select></Field></div><Field label={mcpKind === "stdio" ? "Command" : "URL"}><Input value={mcpAddress} onChange={(event) => setMcpAddress(event.target.value)} required /></Field>{mcpKind === "stdio" && <Field label="Execution target" hint="Host is the default. Select a trusted revision to launch stdio through Docker, Podman, or SSH."><Select value={mcpTargetId} onChange={(event) => setMcpTargetId(event.target.value)}><option value="">Host process</option>{targets.data?.assets.filter((asset) => asset.trusted).map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · r{asset.revision}</option>)}</Select></Field>}<Field label="Optional credential"><Select value={secretId} onChange={(event) => setSecretId(event.target.value)}><option value="">None</option>{secrets.data?.secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.label}</option>)}</Select></Field><Field label="Roots (JSON array)" hint="Roots default to none. Adding one explicitly exposes that URI and its contents to the MCP server."><CodeMirror value={mcpRoots} onChange={setMcpRoots} extensions={[json()]} height="85px" theme="dark" /></Field><Button disabled={!mcpName || !mcpAddress}>Save MCP profile</Button></form>{trustConnection.error && <div className="form-error">{trustConnection.error.message}</div>}{inspectMcp.error && <div className="form-error">{inspectMcp.error.message}</div>}{inspectMcp.data && <pre className="capability-result">{JSON.stringify(inspectMcp.data, null, 2)}</pre>}</section>
    <section className="panel boundary-card"><Braces size={22} /><h3>Raw configuration API</h3><p>Target and MCP profile creation is available through the typed asset API while the guided editors mature. Imported scripts are disabled until trusted.</p></section>
  </div><section className="panel secret-panel"><div className="panel-title"><KeyRound size={16} /> Secret references</div><p className="quiet">Values are stored plaintext in v1 but are never returned after saving. MCP profiles reference only secret IDs.</p><div className="secret-list">{secrets.data?.secrets.map((secret) => <span className="pill" key={secret.id}>{secret.label}</span>)}</div><form className="connection-form inline-secret" onSubmit={(event) => { event.preventDefault(); createSecret.mutate(); }}><Field label="Label"><Input value={secretLabel} onChange={(event) => setSecretLabel(event.target.value)} required /></Field><Field label="Value"><Input type="password" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} required autoComplete="off" /></Field><Button disabled={!secretLabel || !secretValue}>Store secret</Button></form></section></>;
}

interface ArtifactImportResult {
  manifest: { artifactId: string; kind: "harness" | "finding"; generator: { name: "lathe"; version: string } };
  importedAsset?: AssetRevision;
  project?: { id: string; name: string };
  session?: { id: string; projectId: string };
  scriptsEnabled: boolean;
}

function ArtifactSettings() {
  const queryClient = useQueryClient();
  const harnesses = useQuery({ queryKey: ["assets", "harness"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=harness") });
  const [file, setFile] = useState<File | null>(null);
  const importBundle = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Select a Lathe artifact bundle");
      const form = new FormData();
      form.set("file", file);
      return api<ArtifactImportResult>("/api/artifacts/import", { method: "POST", body: form });
    },
    onSuccess: () => {
      setFile(null);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["assets", "harness"] });
    }
  });
  const exportHarness = useMutation({
    mutationFn: (harness: AssetRevision) => downloadApiFile(`/api/harnesses/${harness.id}/export`, `${harness.name}.lathe-harness`)
  });
  return <div className="artifact-grid">
    <section className="panel library-list"><div className="panel-title"><Download size={16} /> Export reusable harnesses <small>{harnesses.data?.assets.length ?? 0}</small></div>
      <p className="quiet artifact-intro">Bundles include the versioned harness, referenced prompt/tool specifications, a manifest, and SHA-256 checksums. Credentials are never exported.</p>
      {harnesses.data?.assets.map((harness) => <article className="library-card artifact-card" key={harness.id}><div><strong>{harness.name}</strong><small>revision {harness.revision} · {harness.trusted ? "trusted" : "disabled"}</small></div><Button variant="ghost" onClick={() => exportHarness.mutate(harness)} title="Export harness bundle"><Download size={14} /></Button><p>{harness.description || "No description"}</p><code>{harness.contentHash.slice(0, 16)}…</code></article>)}
      {harnesses.data?.assets.length === 0 && <p className="quiet">No harness revisions available.</p>}
      {exportHarness.error && <div className="form-error artifact-error">{exportHarness.error.message}</div>}
    </section>
    <section className="panel artifact-import-panel"><div className="panel-title"><Upload size={16} /> Import an artifact</div>
      <form onSubmit={(event) => { event.preventDefault(); importBundle.mutate(); }}>
        <div className="artifact-drop"><PackageOpen size={28} /><strong>{file?.name ?? "Choose a Lathe bundle"}</strong><small>.lathe-harness, .lathe-finding, or ZIP</small><Input type="file" accept=".lathe-harness,.lathe-finding,.zip,application/zip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></div>
        <p className="warning">Archives are checked for path traversal, malformed schemas, invalid hashes, and expansion limits. Imported scripts remain disabled until explicitly trusted.</p>
        {importBundle.error && <div className="form-error">{importBundle.error.message}</div>}
        <Button disabled={!file || importBundle.isPending}>{importBundle.isPending ? "Verifying bundle…" : "Verify and import"}</Button>
      </form>
      {importBundle.data && <div className="import-result"><span className="pill pill-safe">Imported</span><h3>{importBundle.data.manifest.kind === "harness" ? importBundle.data.importedAsset?.name : importBundle.data.project?.name}</h3><code>{importBundle.data.manifest.artifactId}</code><p>Generated by {importBundle.data.manifest.generator.name} v{importBundle.data.manifest.generator.version} · scripts {importBundle.data.scriptsEnabled ? "enabled" : "disabled"}</p>{importBundle.data.session && <a href={`/projects/${importBundle.data.session.projectId}/sessions/${importBundle.data.session.id}`}>Open imported evidence →</a>}</div>}
    </section>
  </div>;
}
