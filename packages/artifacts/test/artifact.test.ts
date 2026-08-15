import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import {
  ARTIFACT_SCHEMA,
  ArtifactError,
  exportFindingArtifact,
  exportHarnessArtifact,
  importArtifact,
  importFindingArtifact,
  importHarnessArtifact,
} from "../src/index.js";

describe("Lathe artifact bundles", () => {
  it("round-trips a harness and disables imported scripts", () => {
    const bundle = exportHarnessArtifact({
      artifactId: "harness-1",
      generatorVersion: "0.1.0",
      metadata: { name: "Test harness", credentialRef: "provider-secret-1" },
      summaryMarkdown: "# Test harness\n",
      files: [
        {
          path: "prompts/system.md",
          data: "You are a test harness.",
          role: "prompt",
        },
        {
          path: "tools/scripts/fetch.js",
          data: "export function build(input) { return input; }",
          role: "tool-script",
        },
      ],
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });

    const imported = importHarnessArtifact(bundle);
    expect(imported.manifest.schema).toBe(ARTIFACT_SCHEMA);
    expect(imported.manifest.security.credentialsIncluded).toBe(false);
    expect(imported.files.find((file) => file.path.endsWith("fetch.js"))).toMatchObject({
      script: true,
      enabled: false,
    });
    expect(imported.trusted).toBe(false);
  });

  it("redacts secret values and credential-shaped JSON keys", () => {
    const bundle = exportFindingArtifact({
      artifactId: "finding-1",
      generatorVersion: "0.1.0",
      metadata: {
        title: "Header disclosure",
        credentialRef: "safe-reference",
        apiKey: "should-not-survive",
      },
      summaryMarkdown: "Authorization: Bearer very-secret-token\n",
      secretValues: ["very-secret-token", "should-not-survive"],
      files: [
        {
          path: "traces/request.json",
          data: JSON.stringify({ headers: { Authorization: "Bearer very-secret-token" } }),
          mediaType: "application/json",
        },
      ],
    });
    expect(Buffer.from(bundle).toString("utf8")).not.toContain("very-secret-token");

    const imported = importFindingArtifact(bundle);
    expect(JSON.stringify(imported.manifest)).not.toContain("should-not-survive");
    expect(imported.manifest.metadata).toMatchObject({ credentialRef: "safe-reference" });
    for (const file of imported.files) {
      expect(Buffer.from(file.data).toString("utf8")).not.toContain("very-secret-token");
    }
  });

  it("rejects traversal paths before extraction", () => {
    const malicious = zipSync({
      "../escape.txt": strToU8("owned"),
      "manifest.json": strToU8("{}"),
    });
    expect(() => importArtifact(malicious)).toThrowError(
      expect.objectContaining({ code: "invalid_path" }) as ArtifactError,
    );
  });

  it("rejects payloads that no longer match the manifest hash", () => {
    const valid = exportFindingArtifact({
      artifactId: "finding-1",
      generatorVersion: "0.1.0",
      metadata: { title: "Changed response" },
      summaryMarkdown: "# Finding\n",
      files: [{ path: "transcript/branch.md", data: "original" }],
    });
    const files = unzipSync(valid);
    files["transcript/branch.md"] = strToU8("tampered");
    const tampered = zipSync(files);

    expect(() => importFindingArtifact(tampered)).toThrowError(
      expect.objectContaining({ code: "hash_mismatch" }) as ArtifactError,
    );
  });

  it("rejects unexpected unmanifested entries", () => {
    const valid = exportFindingArtifact({
      artifactId: "finding-1",
      generatorVersion: "0.1.0",
      metadata: {},
      summaryMarkdown: "# Finding\n",
    });
    const files = unzipSync(valid);
    files["surprise.txt"] = strToU8("not declared");
    expect(() => importArtifact(zipSync(files))).toThrowError(
      expect.objectContaining({ code: "unexpected_entry" }) as ArtifactError,
    );
  });

  it("applies expansion limits before extracting archive contents", () => {
    const valid = exportFindingArtifact({
      artifactId: "finding-large",
      generatorVersion: "0.1.0",
      metadata: {},
      summaryMarkdown: "# Finding\n",
      files: [{ path: "attachments/repeated.txt", data: "x".repeat(32_000) }],
    });
    expect(() => importArtifact(valid, { maxTotalUncompressedBytes: 1_024 }))
      .toThrowError(expect.objectContaining({ code: "size_limit" }) as ArtifactError);
  });

  it("rejects paths that collide on case-insensitive filesystems", () => {
    expect(() => exportHarnessArtifact({
      artifactId: "harness-collision",
      generatorVersion: "0.1.0",
      metadata: {},
      summaryMarkdown: "# Harness\n",
      files: [
        { path: "prompts/System.md", data: "one" },
        { path: "prompts/system.md", data: "two" },
      ],
    })).toThrowError(expect.objectContaining({ code: "duplicate_path" }) as ArtifactError);
  });

  it("rejects manifests that attempt to enable imported scripts", () => {
    const valid = exportHarnessArtifact({
      artifactId: "harness-script",
      generatorVersion: "0.1.0",
      metadata: {},
      summaryMarkdown: "# Harness\n",
      files: [{ path: "tools/scripts/run.js", data: "function build() {}", role: "tool-script" }],
    });
    const files = unzipSync(valid);
    const manifest = JSON.parse(Buffer.from(files["manifest.json"]!).toString("utf8")) as { entries: Array<{ path: string; enabledOnImport: boolean }> };
    manifest.entries.find((entry) => entry.path.endsWith("run.js"))!.enabledOnImport = true;
    files["manifest.json"] = strToU8(JSON.stringify(manifest));
    expect(() => importHarnessArtifact(zipSync(files)))
      .toThrowError(expect.objectContaining({ code: "invalid_manifest" }) as ArtifactError);
  });
});
