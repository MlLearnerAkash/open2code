// Configuration for the open2code local-first failover supervisor.
//
// The supervisor runs one active OpenCode server at a time and keeps the other
// side as a continuously synced warm standby, so a session that starts on one
// side is present on the other when traffic switches over.
//
// See ../README.md for the full field reference and setup instructions.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const defaultListenPort = 4000
const defaultIntervalMs = 2_000
const defaultLocalPort = 4096
const defaultCloudPort = 4096
const defaultTunnelPort = 4097
const defaultCloudDb = "~/.local/share/opencode/opencode.db"

export function configPath(env = process.env, home = homedir()) {
  return env.OPEN2CODE_FAILOVER_CONFIG ?? path.join(home, ".config", "open2code", "failover.json")
}

export function statePath(env = process.env, home = homedir()) {
  return env.OPEN2CODE_FAILOVER_STATE ?? path.join(home, ".local", "state", "open2code", "failover.json")
}

// Reads config.json plus the private state file (generated cloud password) and
// folds environment overrides on top. Unknown fields are ignored so older
// supervisors tolerate newer config files.
export function loadConfig({ env = process.env, home = homedir(), readFile = readJsonFile } = {}) {
  const file = configPath(env, home)
  const raw = readFile(file) ?? {}
  const state = readFile(statePath(env, home)) ?? {}

  const local = raw.local ?? {}
  const cloud = raw.cloud ?? {}

  return {
    file,
    stateFile: statePath(env, home),
    listen: {
      host: raw.listen?.host ?? "127.0.0.1",
      port: number(env.OPEN2CODE_LISTEN_PORT, raw.listen?.port, defaultListenPort),
    },
    prefer: env.OPEN2CODE_PREFER ?? raw.prefer ?? "local",
    failback: bool(env.OPEN2CODE_FAILBACK, raw.failback, true),
    intervalMs: number(env.OPEN2CODE_INTERVAL_MS, raw.intervalMs, defaultIntervalMs),
    local: {
      mode: local.mode ?? "service",
      url: env.OPEN2CODE_LOCAL_URL ?? local.url ?? null,
      port: number(env.OPEN2CODE_LOCAL_PORT, local.port, defaultLocalPort),
      password: local.password ?? null,
      db: env.OPEN2CODE_LOCAL_DB ?? local.db ?? null,
      start: local.start ?? null,
      stop: local.stop ?? null,
    },
    cloud: {
      mode: cloud.mode ?? "serve",
      ssh: env.OPEN2CODE_CLOUD_SSH ?? cloud.ssh ?? null,
      sshPort: number(env.OPEN2CODE_CLOUD_SSH_PORT, cloud.sshPort, null),
      sshArgs: cloud.sshArgs ?? [],
      remoteHost: cloud.remoteHost ?? "127.0.0.1",
      remotePort: number(env.OPEN2CODE_CLOUD_PORT, cloud.remotePort, defaultCloudPort),
      tunnelPort: number(env.OPEN2CODE_TUNNEL_PORT, cloud.tunnelPort, defaultTunnelPort),
      password: cloud.password ?? state.cloudPassword ?? null,
      db: cloud.db ?? defaultCloudDb,
      start: cloud.start ?? null,
      stop: cloud.stop ?? null,
    },
  }
}

// Persists a generated cloud password so restarts reuse the same credential.
export function saveState(file, state, { readFile = readJsonFile, writeFile = writeJsonFile } = {}) {
  const existing = readFile(file) ?? {}
  writeFile(file, { ...existing, ...state })
}

export function validate(config) {
  const problems = []
  if (config.prefer !== "local" && config.prefer !== "cloud") problems.push(`prefer must be "local" or "cloud", got ${config.prefer}`)
  if (!Number.isInteger(config.listen.port) || config.listen.port <= 0 || config.listen.port > 65_535)
    problems.push(`listen.port must be 1-65535, got ${config.listen.port}`)
  if (config.cloud.mode === "serve" && !config.cloud.ssh) problems.push("cloud.ssh is required (ssh host alias or user@host)")
  if (config.cloud.ssh && !Number.isInteger(config.cloud.tunnelPort)) problems.push("cloud.tunnelPort must be a port number")
  if (config.local.mode === "serve" && !Number.isInteger(config.local.port)) problems.push("local.port must be a port number")
  return problems
}

function readJsonFile(file) {
  if (!file || !existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`Failed to read ${file}: ${error.message}`)
  }
}

function writeJsonFile(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function number(envValue, fileValue, fallback) {
  if (envValue !== undefined && envValue !== "") return Number(envValue)
  if (typeof fileValue === "number") return fileValue
  return fallback
}

function bool(envValue, fileValue, fallback) {
  if (envValue !== undefined && envValue !== "") return envValue !== "false" && envValue !== "0"
  if (typeof fileValue === "boolean") return fileValue
  return fallback
}
