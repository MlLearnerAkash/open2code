// SQLite snapshot and swap helpers.
//
// `sqlite3 .backup` produces a consistent copy while the server keeps writing,
// so the standby DB can be refreshed without stopping the active server.
// After a snapshot is restored, the destination's stale -wal/-shm files must be
// removed so they are not replayed against the new database.

import { execFile } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"

const run = promisify(execFile)
const sidecars = ["-wal", "-shm"]

export async function snapshotSqlite(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`)
  const dir = mkdtempSync(path.join(os.tmpdir(), "open2code-snap-"))
  const file = path.join(dir, "opencode.db")
  await run("sqlite3", [dbPath, `.backup '${file}'`])
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function replaceLocalDb(dbPath, sourceFile) {
  mkdirSync(path.dirname(dbPath), { recursive: true })
  for (const suffix of ["", ...sidecars]) rmSync(`${dbPath}${suffix}`, { force: true })
  copyFileSync(sourceFile, dbPath)
}
