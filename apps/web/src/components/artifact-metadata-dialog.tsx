import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button, Field, Input, Textarea } from "./forms.js";

export interface ArtifactMetadata {
  name: string;
  description: string;
  tags: string[];
}

export interface ArtifactMetadataDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  defaultValue?: Partial<ArtifactMetadata>;
  pending?: boolean;
  error?: string;
  onOpenChange(open: boolean): void;
  onSubmit(value: ArtifactMetadata): void;
}

export function parseArtifactTags(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

export function ArtifactMetadataDialog({ open, title, description, confirmLabel, defaultValue, pending = false, error, onOpenChange, onSubmit }: ArtifactMetadataDialogProps) {
  const defaultName = defaultValue?.name ?? "";
  const defaultDescription = defaultValue?.description ?? "";
  const defaultTags = defaultValue?.tags?.join(", ") ?? "";
  const [name, setName] = useState(defaultName);
  const [details, setDetails] = useState(defaultDescription);
  const [tags, setTags] = useState(defaultTags);
  const parsedTags = parseArtifactTags(tags);
  const tagsError = parsedTags.length > 100
    ? "Use no more than 100 tags."
    : parsedTags.some((tag) => tag.length > 120) ? "Each tag must be 120 characters or fewer." : null;

  useEffect(() => {
    if (!open) return;
    setName(defaultName);
    setDetails(defaultDescription);
    setTags(defaultTags);
  }, [defaultDescription, defaultName, defaultTags, open]);

  return <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!pending) onOpenChange(nextOpen); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay artifact-metadata-overlay" />
      <Dialog.Content className="dialog-content artifact-metadata-dialog">
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description>{description}</Dialog.Description>
        <form className="dialog-form" onSubmit={(event) => {
          event.preventDefault();
          const normalizedName = name.trim();
          if (!normalizedName || pending || tagsError) return;
          onSubmit({ name: normalizedName, description: details.trim(), tags: parsedTags });
        }}>
          <Field label="Name"><Input autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="Description"><Textarea rows={4} maxLength={4_000} value={details} onChange={(event) => setDetails(event.target.value)} /></Field>
          <Field label="Tags" hint="Comma-separated labels used by Arsenal search and filters."><Input aria-label="Tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="encoding, reusable" /></Field>
          {tagsError && <div className="form-error" role="alert">{tagsError}</div>}
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="dialog-actions">
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || Boolean(tagsError) || pending}>{pending ? "Saving…" : confirmLabel}</Button>
          </div>
        </form>
        <button type="button" className="dialog-close" aria-label="Close recipe details" disabled={pending} onClick={() => onOpenChange(false)}><X size={17} /></button>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
