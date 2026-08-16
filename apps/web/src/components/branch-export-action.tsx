import { useMutation } from "@tanstack/react-query";
import { Download, ShieldAlert } from "lucide-react";
import { downloadApiFile } from "../api.js";
import type { BranchRef } from "../types.js";
import { Button } from "./forms.js";

export function branchExportFileName(branchName: string): string {
  const stem = branchName
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120);
  return `${stem || "branch"}.json`;
}

export function BranchExportAction({ branch }: { branch: Pick<BranchRef, "id" | "name" | "sessionId"> }) {
  const exportBranch = useMutation({
    mutationFn: () => downloadApiFile(
      `/api/sessions/${encodeURIComponent(branch.sessionId)}/branches/${encodeURIComponent(branch.id)}/export`,
      branchExportFileName(branch.name)
    )
  });

  return <>
    <Button
      type="button"
      variant="ghost"
      onClick={() => exportBranch.mutate()}
      title={exportBranch.isPending ? "Preparing branch export…" : "Export the active branch as LLM API request JSON using the current session configuration"}
      aria-label={`Export ${branch.name} branch as LLM API JSON`}
      aria-busy={exportBranch.isPending}
      disabled={exportBranch.isPending}
    >
      <Download size={15} />
    </Button>
    {exportBranch.error && <span className="branch-export-error" role="alert">
      <ShieldAlert size={13} aria-hidden="true" />
      <span>{exportBranch.error.message}</span>
    </span>}
  </>;
}
