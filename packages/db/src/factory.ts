import { chmod, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { ContentStore } from "./content-store.js";
import { DrizzleLatheRepository, type LatheRepository } from "./repository.js";
import { postgresSchema } from "./schema.postgres.js";
import { sqliteSchema } from "./schema.sqlite.js";

export interface DatabaseEnvironment {
  databaseUrl?: string;
  dataDirectory?: string;
}

export interface LathePersistence {
  repository: LatheRepository;
  contentStore: ContentStore;
  dataDirectory: string;
}

export function defaultDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.LATHE_DATA_DIR) return resolve(environment.LATHE_DATA_DIR);
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Lathe");
  return join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "lathe");
}

function sqlitePathFromUrl(url: string | undefined, dataDirectory: string): string {
  if (!url) return join(dataDirectory, "lathe.sqlite");
  if (url === ":memory:" || url === "file::memory:") return ":memory:";
  const stripped = url.startsWith("file:") ? url.slice(5) : url.startsWith("sqlite:") ? url.slice(7) : url;
  return isAbsolute(stripped) ? stripped : resolve(stripped);
}

function assertSecurePostgresUrl(value: string): void {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const sslMode = url.searchParams.get("sslmode");
  if (!local && !["require", "verify-ca", "verify-full"].includes(sslMode ?? "")) {
    throw new Error("Remote PostgreSQL requires sslmode=require, verify-ca, or verify-full");
  }
}

export async function createPersistence(environment: DatabaseEnvironment = {}): Promise<LathePersistence> {
  const dataDirectory = environment.dataDirectory ?? defaultDataDirectory();
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700).catch(() => undefined);
  const contentStore = new ContentStore(dataDirectory);
  await contentStore.initialize();
  const databaseUrl = environment.databaseUrl ?? process.env.LATHE_DATABASE_URL;

  if (databaseUrl?.startsWith("postgresql:") || databaseUrl?.startsWith("postgres:")) {
    assertSecurePostgresUrl(databaseUrl);
    const client = postgres(databaseUrl, { max: 10, onnotice: () => undefined });
    const db = drizzlePostgres(client, { schema: postgresSchema });
    await migratePostgres(db, { migrationsFolder: fileURLToPath(new URL("../drizzle/postgres", import.meta.url)) });
    const repository = new DrizzleLatheRepository("postgres", db, postgresSchema, async () => {
      await client.end();
    });
    await repository.markRunningJobsInterrupted();
    return { repository, contentStore, dataDirectory };
  }

  const databasePath = sqlitePathFromUrl(databaseUrl, dataDirectory);
  if (databasePath !== ":memory:") await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const client = new Database(databasePath);
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  if (databasePath !== ":memory:") client.pragma("journal_mode = WAL");
  const db = drizzleSqlite(client, { schema: sqliteSchema });
  migrateSqlite(db, { migrationsFolder: fileURLToPath(new URL("../drizzle/sqlite", import.meta.url)) });
  if (databasePath !== ":memory:") await chmod(databasePath, 0o600).catch(() => undefined);
  const repository = new DrizzleLatheRepository("sqlite", db, sqliteSchema, async () => {
    client.close();
  });
  await repository.markRunningJobsInterrupted();
  return { repository, contentStore, dataDirectory };
}
