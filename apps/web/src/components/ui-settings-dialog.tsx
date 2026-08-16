import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Accessibility, Cog, EyeOff, RotateCcw, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { api, jsonBody } from "../api.js";
import { Button } from "./forms.js";
import { useOperatorDialog } from "./operator-dialog.js";
import { DEFAULT_UI_FONT_SCALE, MAX_UI_FONT_SCALE, MIN_UI_FONT_SCALE, readUiPreferences, saveUiPreferences, uiFontSizePixels } from "../ui-preferences.js";

const fontScalePresets = [
  { value: 90, label: "Compact" },
  { value: 100, label: "Default" },
  { value: 115, label: "Large" },
  { value: 130, label: "Extra large" }
] as const;

interface ApplicationSettings {
  redactionEnabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface ApplicationSettingsResponse {
  settings: ApplicationSettings;
}

const applicationSettingsQueryKey = ["application-settings"] as const;

export function UiSettingsDialog() {
  const [open, setOpen] = useState(false);
  const [preferences, setPreferences] = useState(readUiPreferences);
  const dialogs = useOperatorDialog();
  const queryClient = useQueryClient();
  const applicationSettings = useQuery({
    queryKey: applicationSettingsQueryKey,
    queryFn: () => api<ApplicationSettingsResponse>("/api/application-settings"),
    retry: false
  });
  const updateEvidenceRedaction = useMutation({
    mutationFn: (redactionEnabled: boolean) => api<ApplicationSettingsResponse>("/api/application-settings", {
      method: "PATCH",
      ...jsonBody({ redactionEnabled })
    }),
    onSuccess: (response) => queryClient.setQueryData(applicationSettingsQueryKey, response)
  });
  const updateFontScale = (fontScalePercent: number) => setPreferences(saveUiPreferences({ fontScalePercent }));
  const pixels = uiFontSizePixels(preferences);
  const pixelLabel = Number.isInteger(pixels) ? String(pixels) : pixels.toFixed(1);
  const evidenceRedactionEnabled = applicationSettings.data?.settings.redactionEnabled;
  const evidenceRedactionOff = evidenceRedactionEnabled === false;
  const settingsError = applicationSettings.error instanceof Error ? applicationSettings.error.message : applicationSettings.error ? String(applicationSettings.error) : null;
  const updateError = updateEvidenceRedaction.error instanceof Error ? updateEvidenceRedaction.error.message : updateEvidenceRedaction.error ? String(updateEvidenceRedaction.error) : null;

  const changeEvidenceRedaction = async (enabled: boolean) => {
    updateEvidenceRedaction.reset();
    if (!enabled) {
      const approved = await dialogs.confirm({
        title: "Disable evidence redaction?",
        description: "New provider, MCP, and helper-model evidence will preserve credential-shaped fields and text instead of applying Lathe's heuristic redaction. Downloaded traces and exports may contain sensitive test content, and re-enabling redaction will not rewrite existing evidence. Exact credentials managed by Lathe and ordinary credential APIs remain protected.",
        confirmLabel: "Disable redaction",
        danger: true
      });
      if (!approved) return;
    }
    await updateEvidenceRedaction.mutateAsync(enabled).catch(() => undefined);
  };

  return <Dialog.Root open={open} onOpenChange={setOpen}>
    {evidenceRedactionOff && <span className="topbar-raw-indicator" role="status" title="Evidence redaction is disabled">RAW</span>}
    <Dialog.Trigger asChild><button type="button" className={`icon-button ui-settings-trigger${evidenceRedactionOff ? " redaction-off" : ""}`} aria-label={evidenceRedactionOff ? "Interface settings — evidence redaction off" : "Interface settings"} title={evidenceRedactionOff ? "Interface settings · evidence redaction is off" : "Interface settings"}><Cog size={17} /></button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content ui-settings-dialog">
        <div className="ui-settings-heading">
          <div className="ui-settings-heading-icon"><Cog size={18} /></div>
          <div><Dialog.Title>Interface settings</Dialog.Title><Dialog.Description>Display preferences and evidence-capture controls for this Lathe installation.</Dialog.Description></div>
        </div>
        <div className="ui-settings-body">
          <section className="ui-settings-control">
            <div className="interface-setting-heading">
              <div><strong><Accessibility size={15} /> Interface text size</strong><small>Scales text across navigation, transcripts, inspectors, dialogs, forms, and code editors.</small></div>
              <output htmlFor="ui-font-scale" aria-live="polite">{preferences.fontScalePercent}% <small>· {pixelLabel} px</small></output>
            </div>
            <input
              id="ui-font-scale"
              className="ui-font-scale"
              type="range"
              min={MIN_UI_FONT_SCALE}
              max={MAX_UI_FONT_SCALE}
              step={5}
              value={preferences.fontScalePercent}
              aria-label="Interface text size"
              aria-valuetext={`${preferences.fontScalePercent} percent`}
              onChange={(event) => updateFontScale(Number(event.target.value))}
            />
            <div className="ui-font-presets" aria-label="Text size presets">
              {fontScalePresets.map((preset) => <button key={preset.value} type="button" aria-pressed={preferences.fontScalePercent === preset.value} onClick={() => updateFontScale(preset.value)}><strong>{preset.label}</strong><span>{preset.value}%</span></button>)}
            </div>
            <p className="ui-preference-note">Saved automatically in this browser. Transcript content and exported findings are unchanged.</p>
          </section>
          <section className="ui-font-preview" aria-label="Text size preview">
            <span className="eyebrow">LIVE PREVIEW</span>
            <strong>Readable at a glance.</strong>
            <p>Important model behavior, reasoning, and evidence should remain comfortable to inspect during a long session.</p>
            <code>provider.output · preserved exactly</code>
          </section>
          <section className={`evidence-redaction-setting${evidenceRedactionOff ? " redaction-off" : ""}`} aria-labelledby="evidence-redaction-heading">
            <div className="interface-setting-heading">
              <div>
                <strong id="evidence-redaction-heading">{evidenceRedactionOff ? <EyeOff size={15} /> : <ShieldCheck size={15} />} Evidence redaction</strong>
                <small>Controls sanitization of newly captured provider, MCP, and helper-model evidence. This installation-wide setting does not change existing traces.</small>
              </div>
              {applicationSettings.isLoading
                ? <span className="evidence-redaction-loading" role="status">Loading…</span>
                : applicationSettings.isError
                  ? <Button type="button" variant="secondary" onClick={() => void applicationSettings.refetch()}>Retry</Button>
                  : <label className="evidence-redaction-switch">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label="Evidence redaction"
                        checked={evidenceRedactionEnabled === true}
                        disabled={updateEvidenceRedaction.isPending}
                        onChange={(event) => void changeEvidenceRedaction(event.target.checked)}
                      />
                      <span aria-hidden="true" />
                      <b>{evidenceRedactionEnabled ? "Enabled" : "Disabled"}</b>
                    </label>}
            </div>
            {settingsError && <div className="form-error" role="alert">Evidence-redaction settings could not be loaded: {settingsError}</div>}
            {updateError && <div className="form-error" role="alert">Evidence redaction could not be updated: {updateError}</div>}
            {evidenceRedactionOff && <div className="evidence-redaction-warning" role="alert">
              <TriangleAlert size={16} />
              <div><strong>Raw evidence capture is active.</strong><span>New live events, normalized output, traces, and exports may preserve sensitive-looking test content. Re-enabling redaction affects only future operations. Exact credentials managed by Lathe remain protected.</span></div>
            </div>}
          </section>
        </div>
        <div className="ui-settings-footer"><Button type="button" variant="secondary" onClick={() => updateFontScale(DEFAULT_UI_FONT_SCALE)} disabled={preferences.fontScalePercent === DEFAULT_UI_FONT_SCALE}><RotateCcw size={13} /> Reset text size</Button><Dialog.Close asChild><Button type="button">Done</Button></Dialog.Close></div>
        <Dialog.Close className="dialog-close" aria-label="Close"><X size={16} /></Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
