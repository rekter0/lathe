import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { Check } from "lucide-react";
import type { JsonObject, JsonValue } from "@lathe/domain";
import { api, jsonBody } from "../api.js";
import { Button, Field, Input } from "./forms.js";

type McpApprovalOutcome = "approved" | "denied" | "cancelled";

export function McpApprovalResolver({ runId, record, onChanged }: { runId: string; record: JsonObject; onChanged(): void }) {
  const kind = typeof record.kind === "string" ? record.kind : "unknown";
  const requiresOperatorResponse = kind === "elicitation";
  const [response, setResponse] = useState("");
  const [reason, setReason] = useState("");
  const resolve = useMutation({
    mutationFn: (outcome: McpApprovalOutcome) => {
      let resolution: JsonObject;
      if (outcome === "approved" && requiresOperatorResponse) {
        if (!response.trim()) throw new Error("An approved MCP elicitation requires an explicit JSON response");
        let parsed: JsonValue;
        try {
          parsed = JSON.parse(response) as JsonValue;
        } catch (error) {
          throw new Error(`MCP elicitation response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        resolution = { outcome, response: parsed };
      } else {
        resolution = { outcome, ...(!reason.trim() || outcome === "approved" ? {} : { reason: reason.trim() }) };
      }
      return api(`/api/runs/${runId}/mcp-approvals/${encodeURIComponent(String(record.id))}/resolve`, { method: "POST", ...jsonBody({ resolution }) });
    },
    onSuccess: onChanged
  });

  return <article className="mcp-approval">
    <div className="resolver-heading"><strong>{kind}</strong><span className="pill">pending</span></div>
    <label>Untrusted server request</label>
    <pre>{JSON.stringify(record.request ?? record, null, 2)}</pre>
    {kind === "sampling" && <p className="mcp-approval-notice">Approving starts a nested model run with this session&apos;s provider and model. The model response is generated and recorded by Lathe; it is not authored here.</p>}
    {requiresOperatorResponse && <Field label="Explicit elicitation response (JSON)" hint="Required when approving this elicitation request."><CodeMirror value={response} onChange={setResponse} extensions={[json()]} height="105px" theme="dark" /></Field>}
    <Field label="Denial / cancellation reason"><Input value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
    <div className="mcp-approval-actions"><Button onClick={() => resolve.mutate("approved")} disabled={resolve.isPending || (requiresOperatorResponse && !response.trim())}><Check size={12} /> {kind === "sampling" ? "Run sampling" : "Approve"}</Button><Button variant="danger" onClick={() => resolve.mutate("denied")} disabled={resolve.isPending}>Deny</Button><Button variant="secondary" onClick={() => resolve.mutate("cancelled")} disabled={resolve.isPending}>Cancel</Button></div>
    {resolve.error && <div className="form-error">{resolve.error.message}</div>}
  </article>;
}
