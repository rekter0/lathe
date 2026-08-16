import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { emptyResolvedConfig } from "@lathe/domain";
import { createPersistence } from "../src/index.js";
import { repositoryContract } from "./contract.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SQLite repository", () => {
  it("satisfies the repository contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lathe-db-"));
    directories.push(directory);
    const persistence = await createPersistence({ dataDirectory: directory });
    try {
      expect(persistence.repository.dialect).toBe("sqlite");
      await repositoryContract(persistence.repository);
    } finally {
      await persistence.repository.close();
    }
  });

  it("stores content by digest and deduplicates bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lathe-store-"));
    directories.push(directory);
    const persistence = await createPersistence({ dataDirectory: directory });
    try {
      const first = await persistence.contentStore.put(Buffer.from("evidence"));
      const second = await persistence.contentStore.put(Buffer.from("evidence"));
      expect(first.sha256).toBe(second.sha256);
      expect((await persistence.contentStore.get(first.sha256)).toString()).toBe("evidence");
    } finally {
      await persistence.repository.close();
    }
  });

  it("persists application settings across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lathe-settings-"));
    directories.push(directory);
    const first = await createPersistence({ dataDirectory: directory });
    try {
      expect(await first.repository.getApplicationSettings()).toMatchObject({ redactionEnabled: true });
      await first.repository.upsertApplicationSettings({ redactionEnabled: false });
    } finally {
      await first.repository.close();
    }

    const reopened = await createPersistence({ dataDirectory: directory });
    try {
      expect(await reopened.repository.getApplicationSettings()).toMatchObject({ id: "global", redactionEnabled: false });
    } finally {
      await reopened.repository.close();
    }
  });

  it("migrates existing checkpoint-state databases without losing project or session data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lathe-migration-"));
    directories.push(directory);
    const databasePath = join(directory, "legacy.sqlite");
    const client = new Database(databasePath);
    try {
      const initial = await readFile(fileURLToPath(new URL("../drizzle/sqlite/0000_initial.sql", import.meta.url)), "utf8");
      const checkpointState = await readFile(fileURLToPath(new URL("../drizzle/sqlite/0001_checkpoint_session_state.sql", import.meta.url)), "utf8");
      client.exec(initial);
      client.prepare(`INSERT INTO projects (
        id, name, description, default_harness_revision_id, workspace_root, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("legacy-project", "Legacy", "Existing briefing", null, null, now(), now());
      client.prepare(`INSERT INTO sessions (
        id, project_id, name, provider_profile_id, model_id, active_branch_id, draft_config,
        auto_continue_tools, auto_continue_limit, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "legacy-session", "legacy-project", "Legacy session", null, null, null,
        JSON.stringify(emptyResolvedConfig()), 0, 8, now(), now()
      );
      client.exec(checkpointState);
      client.exec(`CREATE TABLE __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )`);
      client.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run("legacy-checkpoint-state", 1786752001000);
    } finally {
      client.close();
    }

    const persistence = await createPersistence({ databaseUrl: `sqlite:${databasePath}`, dataDirectory: directory });
    try {
      expect(await persistence.repository.getProject("legacy-project")).toMatchObject({
        description: "Existing briefing",
        targetName: ""
      });
      expect(await persistence.repository.getSession("legacy-session")).toMatchObject({ description: "" });
      expect(await persistence.repository.getPayloadWorkbenchSettings()).toBeNull();
      expect(await persistence.repository.getSessionPayloadWorkbenchSettings("legacy-session")).toBeNull();
      expect(await persistence.repository.getApplicationSettings()).toMatchObject({ id: "global", redactionEnabled: true });
      expect(await persistence.repository.upsertPayloadWorkbenchSettings({
        defaultGeneratorProfileRevisionId: null,
        defaultInstructionRevisionId: null,
        contextMode: "none",
        includeProjectBrief: false,
        includeSessionBrief: false,
        includeTargetConfig: false,
        budgetChars: 2_000
      })).toMatchObject({ id: "global", candidateCount: 1, diversity: "balanced" });
    } finally {
      await persistence.repository.close();
    }
  });
});

function now(): string {
  return "2026-08-15T00:00:00.000Z";
}
