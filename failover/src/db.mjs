// SQLite snapshot and swap helpers.
//
// `sqlite3 .backup` produces a consistent copy while the server keeps writing,
// so the standby DB can be refreshed without stopping the active server.
// After a snapshot is restored, the destination's stale -wal/-shm files must be
// removed so they are not replayed against the new database.

import { execFile } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"

const run = promisify(execFile)
const sidecars = ["-wal", "-shm"]

export async function snapshotSqlite(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`)
  const dir = mkdtempSync(path.join(os.tmpdir(), "open2code-snap-"))
  const file = path.join(dir, "opencode.db")
  try {
    await run("sqlite3", [dbPath, `.backup '${file}'`])
  } catch (error) {
    // Fall back to Python's sqlite3 module when the sqlite3 CLI is unavailable.
    if (error.code !== "ENOENT") throw error
    await run("python3", [backupProgram, dbPath, file])
  }
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export const backupProgram =
  "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()"

// Swaps in a new database from a snapshot path or an in-memory Buffer, writing
// through a temp file so the destination is replaced atomically.
export function replaceLocalDb(dbPath, source) {
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const tmp = `${dbPath}.tmp`
  writeFileSync(tmp, Buffer.isBuffer(source) ? source : readFileSync(source))
  for (const suffix of sidecars) rmSync(`${dbPath}${suffix}`, { force: true })
  renameSync(tmp, dbPath)
}
