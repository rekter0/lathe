import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
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
});
