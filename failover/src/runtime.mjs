// Wires the failover supervisor to the real world: OpenCode CLI discovery,
// the SSH tunnel, per-side start/stop, health probes, and DB replication.

import { execFile, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { randomBytes } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"
import { promisify } from "node:util"
import path from "node:path"
import { probe } from "./health.mjs"
import { createTunnel, remoteRun } from "./ssh.mjs"
import { replaceLocalDb, snapshotSqlite } from "./db.mjs"
import { saveState } from "./config.mjs"

const exec = promisify(execFile)
const remoteSnapshotFile = "/tmp/open2code-failover-snap.db"

export function createRuntime({ config, log = () => {}, env = process.env }) {
  const tunnel = createTunnel(config.cloud, { log })
  const home = homedir()
  const pidFile = path.join(home, ".local", "state", "open2code", "cloud.pid")
  let identity

  async function tryExec(command, args, options) {
    try {
      const { stdout } = await exec(command, args, { encoding: "utf8", ...options })
      return stdout.trim()
    } catch {
      return undefined
    }
  }

  // Resolve the local server's URL, password, and DB path once and refresh the
  // URL on demand: the managed service port is stable but can change after a
  // restart or channel switch.
  async function resolveLocal({ refreshUrl = false } = {}) {
    if (identity && !refreshUrl) return identity
    const local = config.local
    const url =
      local.url ??
      (local.mode === "service" ? await tryExec("opencode", ["service", "status"]) : undefined) ??
      identity?.url ??
      `http://127.0.0.1:${local.port}`
    const password =
      local.password ??
      (local.mode === "service" ? await tryExec("opencode", ["service", "get", "password"]) : undefined) ??
      identity?.password
    const db =
      local.db ??
      (await tryExec("opencode", ["debug", "paths", "db"])) ??
      identity?.db ??
      path.join(home, ".local", "share", "opencode", "opencode.db")
    identity = { url, password, db }
    return identity
  }

  function resolveCloudPassword() {
    if (config.cloud.password) return config.cloud.password
    const generated = randomBytes(24).toString("base64url")
    saveState(config.stateFile, { cloudPassword: generated })
    config.cloud.password = generated
    log("generated a cloud server password and stored it in the state file")
    return generated
  }

  const api = {
    tunnel,
    local: () => resolveLocal(),
    localUrl: async () => (await resolveLocal({ refreshUrl: true })).url,
    cloudUrl: () => `${tunnel.url}/`,
    cloudPassword: () => resolveCloudPassword(),

    async probeLocal() {
      const local = await resolveLocal({ refreshUrl: true })
      return probe(local.url, { password: local.password })
    },

    async probeCloud() {
      return probe(tunnel.url, { password: resolveCloudPassword() })
    },

    ensureTunnel: () => tunnel.ensure(),
    stopTunnel: () => tunnel.stop(),

    async start(side) {
      if (side === "local") {
        if (config.local.mode === "service") {
          await tryExec("opencode", ["service", "start"])
          return
        }
        const local = await resolveLocal()
        mkdirSync(path.dirname(pidFile), { recursive: true })
        const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(config.local.port)], {
          detached: true,
          stdio: "ignore",
          env: {
            ...env,
            OPENCODE_PASSWORD: local.password ?? resolveCloudPassword(),
            OPENCODE_DB: local.db,
          },
        })
        child.unref()
        writeFileSync(pidFile, String(child.pid))
        return
      }

      if (config.cloud.start) {
        await remoteRun(config.cloud, config.cloud.start, { log })
        return
      }
      const db = remotePath(config.cloud.db)
      const password = resolveCloudPassword()
      const command =
        `BIN=$HOME/.opencode/bin/opencode; [ -x "$BIN" ] || BIN="$(command -v opencode)"; ` +
        `mkdir -p "$(dirname ${db})"; ` +
        `OPENCODE_PASSWORD=${shq(password)} OPENCODE_DB=${db} ` +
        `nohup "$BIN" serve --hostname ${config.cloud.remoteHost} --port ${config.cloud.remotePort} ` +
        `> "$HOME/.open2code-failover.log" 2>&1 < /dev/null & echo $! > "$HOME/.open2code-failover.pid"`
      await remoteRun(config.cloud, command, { log })
    },

    async stop(side) {
      if (side === "local") {
        if (config.local.mode === "service") {
          await tryExec("opencode", ["service", "stop"])
          return
        }
        if (!existsSync(pidFile)) return
        const pid = Number(readFileSync(pidFile, "utf8").trim())
        try {
          process.kill(pid, "SIGTERM")
        } catch {}
        rmSync(pidFile, { force: true })
        return
      }

      if (config.cloud.stop) {
        await remoteRun(config.cloud, config.cloud.stop, { log })
        return
      }
      await remoteRun(
        config.cloud,
        `[ -f "$HOME/.open2code-failover.pid" ] && kill "$(cat "$HOME/.open2code-failover.pid")" 2>/dev/null; rm -f "$HOME/.open2code-failover.pid"; true`,
        { log },
      )
    },

    // Best-effort copy of the active server's database onto the standby.
    async sync(from) {
      const to = from === "local" ? "cloud" : "local"
      try {
        if (from === "local") {
          const local = await resolveLocal()
          const snapshot = await snapshotSqlite(local.db)
          try {
            if (to === "cloud") await writeCloud(snapshot.file)
          } finally {
            snapshot.cleanup()
          }
          return
        }
        const buffer = await readCloud()
        if (to === "local") {
          const local = await resolveLocal()
          replaceLocalDb(local.db, buffer)
        }
      } catch (error) {
        log(`replication ${from}->${to} skipped: ${error.message}`)
      }
    },

    async status() {
      const local = await resolveLocal()
      return { local: { url: local.url, db: local.db }, cloud: { url: tunnel.url, db: config.cloud.db } }
    },
  }

  async function readCloud() {
    const db = remotePath(config.cloud.db)
    const python =
      `python3 -c 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); ` +
      `d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()' ${db} ${remoteSnapshotFile}`
    const result = await remoteRun(
      config.cloud,
      `[ -f ${db} ] || { echo "no database at ${db}" >&2; exit 3; }; ` +
        `if python3 -c 'import sqlite3' 2>/dev/null; then ${python}; else sqlite3 ${db} ".backup '${remoteSnapshotFile}'"; fi ` +
        `&& gzip -c ${remoteSnapshotFile} && rm -f ${remoteSnapshotFile}`,
      { log },
    )
    if (result.code !== 0) throw new Error(result.stderr.trim() || `ssh exited ${result.code}`)
    if (result.stdout.length === 0) throw new Error("cloud returned an empty snapshot")
    return gunzipSync(result.stdout)
  }

  async function writeCloud(file) {
    const db = remotePath(config.cloud.db)
    // Compress the snapshot (SQLite compresses well) and swap it in through a
    // temp file, so the transfer is smaller and a reader never sees a partial
    // database.
    const result = await remoteRun(
      config.cloud,
      `mkdir -p "$(dirname ${db})"; rm -f ${db}.tmp ${db}-wal ${db}-shm; gzip -dc > ${db}.tmp && mv -f ${db}.tmp ${db}`,
      { input: gzipSync(readFileSync(file)), log },
    )
    if (result.code !== 0) throw new Error(result.stderr.trim() || `ssh exited ${result.code}`)
  }

  return api
}

// `~` must expand on the remote shell, so it becomes $HOME before quoting.
function remotePath(db) {
  return db.startsWith("~/") ? `$HOME/${db.slice(2)}` : db
}

function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
