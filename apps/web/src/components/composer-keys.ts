export function isComposerSubmitKey(input: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean {
  return input.key === "Enter" && !input.shiftKey && !input.isComposing;
}
