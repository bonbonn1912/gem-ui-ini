import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { runMigrations } from "./migrations";

export const APP_DATABASE_DIRECTORY = "data";
export const APP_DATABASE_FILE = "gem-ui.sqlite3";

export type SqliteDatabase = Database.Database;

export function getAppDatabasePath(userDataDirectory: string): string {
  if (!path.isAbsolute(userDataDirectory)) {
    throw new TypeError("The Electron userData directory must be absolute");
  }

  return path.join(
    userDataDirectory,
    APP_DATABASE_DIRECTORY,
    APP_DATABASE_FILE,
  );
}

export function openAppDatabase(userDataDirectory: string): SqliteDatabase {
  const databasePath = getAppDatabasePath(userDataDirectory);
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  return openSqliteDatabase(databasePath);
}

export function openSqliteDatabase(databasePath: string): SqliteDatabase {
  const database = new Database(databasePath);

  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("synchronous = NORMAL");
    if (databasePath !== ":memory:") {
      database.pragma("journal_mode = WAL");
    }
    runMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
