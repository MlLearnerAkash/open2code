import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { replaceLocalDb, snapshotSqlite } from "../src/db.mjs"

const hasSqlite = spawnSync("sqlite3", ["--version"]).status === 0

test("snapshots a live database and swaps it into the standby location", { skip: !hasSqlite }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "open2code-db-"))
  const primary = path.join(dir, "primary.db")
  const standby = path.join(dir, "standby.db")

  execFileSync("sqlite3", [primary, "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT);"])
  execFileSync("sqlite3", [primary, "INSERT INTO session VALUES ('ses_1', 'hello');"])

  // A stale WAL beside the standby must not survive the swap.
  execFileSync("sqlite3", [standby, "CREATE TABLE stale (x INTEGER);"])

  return snapshotSqlite(primary)
    .then((snapshot) => {
      const rows = execFileSync("sqlite3", [snapshot.file, "SELECT id, title FROM session;"]).toString().trim()
      assert.equal(rows, "ses_1|hello")

      replaceLocalDb(standby, snapshot.file)
      const copied = execFileSync("sqlite3", [standby, "SELECT id, title FROM session;"]).toString().trim()
      assert.equal(copied, "ses_1|hello")

      const stale = spawnSync("sqlite3", [standby, "SELECT name FROM sqlite_master WHERE name='stale';"]).stdout.toString().trim()
      assert.equal(stale, "")

      snapshot.cleanup()
    })
    .finally(() => rmSync(dir, { recursive: true, force: true }))
})
