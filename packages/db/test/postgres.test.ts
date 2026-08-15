import { describe, it } from "vitest";
import { createPersistence } from "../src/index.js";
import { repositoryContract } from "./contract.js";

describe.skipIf(!process.env.LATHE_TEST_POSTGRES_URL)("PostgreSQL repository", () => {
  it("satisfies the repository contract", async () => {
    const persistence = await createPersistence({
      databaseUrl: process.env.LATHE_TEST_POSTGRES_URL,
      dataDirectory: process.env.RUNNER_TEMP ?? "/tmp/lathe-postgres-test"
    });
    try {
      await repositoryContract(persistence.repository);
    } finally {
      await persistence.repository.close();
    }
  });
});
