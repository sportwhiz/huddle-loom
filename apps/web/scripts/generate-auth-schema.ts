import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { libraryOptions } from "../src/auth/library";
import type { NativeEnv } from "../src/auth/types";
const database = new DatabaseSync(":memory:");
const env = {
  AUTH_ORIGIN: "http://localhost:5180",
  ENVIRONMENT: "test",
  AUTH_SECRET: "schema-generation-test-secret-not-for-deployment",
  MAIL_PROVIDER: "test",
  MAIL_FROM: "test@example.invalid",
  CATALOG: {},
} as NativeEnv;
const migrations = await getMigrations(libraryOptions(env, {}, {}, database));
await writeFile(
  "migrations/0005_native_auth_library.sql",
  `-- Generated from Better Auth 1.7.7 and passkey 1.7.7; review before changing.\n${await migrations.compileMigrations()}\n`,
);
database.close();
