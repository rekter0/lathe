import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Accessibility, Cog, RotateCcw, X } from "lucide-react";
import { Button } from "./forms.js";
import { DEFAULT_UI_FONT_SCALE, MAX_UI_FONT_SCALE, MIN_UI_FONT_SCALE, readUiPreferences, saveUiPreferences, uiFontSizePixels } from "../ui-preferences.js";

const fontScalePresets = [
  { value: 90, label: "Compact" },
  { value: 100, label: "Default" },
  { value: 115, label: "Large" },
  { value: 130, label: "Extra large" }
] as const;

export function UiSettingsDialog() {
  const [open, setOpen] = useState(false);
  const [preferences, setPreferences] = useState(readUiPreferences);
  const updateFontScale = (fontScalePercent: number) => setPreferences(saveUiPreferences({ fontScalePercent }));
  const pixels = uiFontSizePixels(preferences);
  const pixelLabel = Number.isInteger(pixels) ? String(pixels) : pixels.toFixed(1);

  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button type="button" className="icon-button ui-settings-trigger" aria-label="Interface settings" title="Interface settings"><Cog size={17} /></button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content ui-settings-dialog">
        <div className="ui-settings-heading">
          <div className="ui-settings-heading-icon"><Cog size={18} /></div>
          <div><Dialog.Title>Interface settings</Dialog.Title><Dialog.Description>Personal display preferences for this browser.</Dialog.Description></div>
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
        </div>
        <div className="ui-settings-footer"><Button type="button" variant="secondary" onClick={() => updateFontScale(DEFAULT_UI_FONT_SCALE)} disabled={preferences.fontScalePercent === DEFAULT_UI_FONT_SCALE}><RotateCcw size={13} /> Reset text size</Button><Dialog.Close asChild><Button type="button">Done</Button></Dialog.Close></div>
        <Dialog.Close className="dialog-close" aria-label="Close"><X size={16} /></Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
