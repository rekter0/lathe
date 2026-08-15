import { canonicalJson, sha256, type JsonObject, type MessagePart, type ResolvedConfig } from "@lathe/domain";

export type PayloadContextMode = "none" | "minimal" | "full";

export interface PayloadContextNode {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly parts: readonly MessagePart[];
  readonly reasoning?: string | null;
}

export interface PayloadContextOptions {
  readonly mode: PayloadContextMode;
  readonly includeProjectBrief: boolean;
  readonly includeSessionBrief: boolean;
  readonly includeTargetConfig: boolean;
  readonly budgetChars: number;
}

export interface PayloadContextManifestBlock {
  readonly kind: "project" | "session" | "target-config" | "turn";
  readonly nodeIds: readonly string[];
  readonly characters: number;
  readonly sha256: string;
  readonly originalCharacters: number;
  readonly originalSha256: string;
  readonly truncated: boolean;
}

export interface PayloadContextManifest {
  readonly mode: PayloadContextMode;
  readonly budgetChars: number;
  readonly characterCount: number;
  readonly approximateTokens: number;
  readonly includedNodeIds: readonly string[];
  readonly omittedTurnCount: number;
  readonly blocks: readonly PayloadContextManifestBlock[];
  readonly warnings: readonly string[];
  readonly fits: boolean;
  readonly requiredMinimumChars: number | null;
  readonly contextHash: string;
}

export interface CompiledPayloadContext {
  readonly text: string;
  readonly manifest: PayloadContextManifest;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function takeCodePoints(value: string, count: number): string {
  return [...value].slice(0, count).join("");
}

function serializeToolResult(part: Extract<MessagePart, { type: "tool-result" }>, minimal: boolean): string {
  const serialized = canonicalJson(part.result);
  if (!minimal || codePointLength(serialized) <= 100) return serialized;
  return `${takeCodePoints(serialized, 100)}… [truncated from ${codePointLength(serialized)} chars; sha256 ${sha256(serialized)}]`;
}

function serializeNode(node: PayloadContextNode, minimal: boolean): string {
  const blocks: string[] = [`[${node.role.toUpperCase()} node=${node.id}]`];
  if (node.reasoning) blocks.push(`[REASONING]\n${node.reasoning}`);
  for (const part of node.parts) {
    if (part.type === "text") blocks.push(part.text);
    else if (part.type === "tool-call") blocks.push(`[TOOL CALL ${part.name} id=${part.callId}]\n${canonicalJson(part.arguments)}`);
    else if (part.type === "tool-result") blocks.push(`[TOOL RESULT ${part.name} id=${part.callId}${part.isError ? " error" : ""}]\n${serializeToolResult(part, minimal)}`);
    else blocks.push(`[ATTACHMENT ${part.name} mediaType=${part.mediaType} id=${part.attachmentId}; bytes not included]`);
  }
  return blocks.join("\n");
}

function groupTurns(nodes: readonly PayloadContextNode[], minimal: boolean): Array<{ nodeIds: string[]; text: string; originalText: string }> {
  const groups: Array<{ nodeIds: string[]; chunks: string[]; originalChunks: string[] }> = [];
  for (const node of nodes) {
    if (node.role === "user" || groups.length === 0) groups.push({ nodeIds: [], chunks: [], originalChunks: [] });
    const group = groups.at(-1);
    if (!group) continue;
    group.nodeIds.push(node.id);
    group.chunks.push(serializeNode(node, minimal));
    group.originalChunks.push(serializeNode(node, false));
  }
  return groups.map((group) => ({
    nodeIds: group.nodeIds,
    text: group.chunks.join("\n\n"),
    originalText: group.originalChunks.join("\n\n")
  }));
}

function safeTargetConfig(config: ResolvedConfig): JsonObject {
  return {
    systemPromptBlocks: config.promptBlocks
      .filter((block) => block.enabled)
      .toSorted((left, right) => left.order - right.order)
      .map((block) => ({ name: block.name, content: block.content })),
    tools: config.tools
      .filter((tool) => tool.enabled)
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens
  };
}

function block(
  kind: PayloadContextManifestBlock["kind"],
  text: string,
  nodeIds: readonly string[] = [],
  originalText = text
): PayloadContextManifestBlock {
  return {
    kind,
    nodeIds,
    characters: codePointLength(text),
    sha256: sha256(text),
    originalCharacters: codePointLength(originalText),
    originalSha256: sha256(originalText),
    truncated: text !== originalText
  };
}

export function compilePayloadContext(input: {
  readonly project: { readonly name: string; readonly description: string; readonly targetName?: string | null };
  readonly session: { readonly name: string; readonly description: string; readonly config: ResolvedConfig };
  readonly branch: { readonly name: string; readonly nodes: readonly PayloadContextNode[] };
  readonly options: PayloadContextOptions;
}): CompiledPayloadContext {
  const { options } = input;
  const warnings: string[] = [];
  const fixed: Array<{ kind: "project" | "session" | "target-config"; text: string }> = [];
  if (options.includeProjectBrief) {
    fixed.push({ kind: "project", text: `[PROJECT]\nName: ${input.project.name}\nTarget: ${input.project.targetName ?? ""}\nBriefing:\n${input.project.description}` });
  }
  if (options.includeSessionBrief) fixed.push({ kind: "session", text: `[SESSION]\nName: ${input.session.name}\nBriefing:\n${input.session.description}` });
  if (options.includeTargetConfig) fixed.push({ kind: "target-config", text: `[CURRENT TARGET CONFIGURATION]\n${canonicalJson(safeTargetConfig(input.session.config))}` });

  const fixedCharacters = fixed.reduce((sum, item, index) => sum + codePointLength(item.text) + (index === 0 ? 0 : 2), 0);
  const groups = options.mode === "none" ? [] : groupTurns(input.branch.nodes, options.mode === "minimal");
  const selected: typeof groups = [];
  let used = fixedCharacters;
  let requiredMinimumChars: number | null = null;
  let fits = fixedCharacters <= options.budgetChars;
  if (!fits) {
    requiredMinimumChars = fixedCharacters;
    warnings.push(`Selected briefing and target configuration require ${fixedCharacters} characters, exceeding the ${options.budgetChars} character budget.`);
  } else if (groups.length > 0) {
    const newest = groups.at(-1);
    const newestCost = newest ? codePointLength(newest.text) + (fixed.length > 0 ? 2 : 0) : 0;
    if (newest && used + newestCost > options.budgetChars) {
      requiredMinimumChars = used + newestCost;
      fits = false;
      warnings.push(`The newest complete turn requires a context budget of at least ${requiredMinimumChars} characters.`);
    } else {
      for (let index = groups.length - 1; index >= 0; index -= 1) {
        const current = groups[index];
        if (!current) continue;
        const separator = fixed.length + selected.length > 0 ? 2 : 0;
        const cost = codePointLength(current.text) + separator;
        if (used + cost > options.budgetChars) break;
        selected.unshift(current);
        used += cost;
      }
    }
  }
  const omittedTurnCount = groups.length - selected.length;
  if (omittedTurnCount > 0) warnings.push(`${omittedTurnCount} older complete turn${omittedTurnCount === 1 ? " was" : "s were"} omitted by the context budget.`);
  const truncatedTurnCount = selected.filter((item) => item.text !== item.originalText).length;
  if (truncatedTurnCount > 0) warnings.push(`Minimal context truncated tool results in ${truncatedTurnCount} included turn${truncatedTurnCount === 1 ? "" : "s"}; original lengths and hashes are recorded below.`);
  const pieces = [
    ...fixed.map((item) => item.text),
    ...selected.map((item) => item.text)
  ];
  const text = pieces.join("\n\n");
  const blocks: PayloadContextManifestBlock[] = [
    ...fixed.map((item) => block(item.kind, item.text)),
    ...selected.map((item) => block("turn", item.text, item.nodeIds, item.originalText))
  ];
  const characterCount = codePointLength(text);
  return {
    text,
    manifest: {
      mode: options.mode,
      budgetChars: options.budgetChars,
      characterCount,
      approximateTokens: Math.ceil(characterCount / 4),
      includedNodeIds: selected.flatMap((item) => item.nodeIds),
      omittedTurnCount,
      blocks,
      warnings,
      fits,
      requiredMinimumChars,
      contextHash: sha256(text)
    }
  };
}
