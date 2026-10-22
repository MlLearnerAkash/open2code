#!/usr/bin/env node
// Launch-time wrapper around the OpenCode TUI.
//
// It makes sure the failover supervisor is running, then starts the TUI against
// the supervisor's stable local port instead of a specific server. The TUI's own
// reconnect logic re-attaches to the supervisor after any disruption, and the
// supervisor routes to whichever server is healthy.
//
// Usage: open2code [--ssh <host>] [opencode args...]
//
// --ssh <host> overrides cloud.ssh for this launch (an SSH host alias or
// user@host); the environment override is inherited by the supervisor.

import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { loadConfig, validate } from "../src/config.mjs"
import { STATUS_PATH } from "../src/proxy.mjs"

const { args, ssh } = parseArgs(process.argv.slice(2))
if (ssh) process.env.OPEN2CODE_CLOUD_SSH = ssh

const config = loadConfig()
const problems = validate(config)
if (problems.length > 0) {
  console.error("open2code: invalid configuration:")
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

const endpoint = `http://${config.listen.host}:${config.listen.port}`

// Expose the effective host to the TUI (and any installed plugin) for display.
if (config.cloud.ssh) process.env.OPEN2CODE_SSH = config.cloud.ssh

// Brand the terminal title. The TUI otherwise sets a hardcoded "OpenCode"
// title, so disable its title handling and set ours instead (and restore it
// when the TUI clears the title on exit).
const title = "open2code"
process.env.OPENCODE_CONFIG_CONTENT = withTitleDisabled(process.env.OPENCODE_CONFIG_CONTENT)
writeTitle(title)

await ensureSupervisor()
const code = await runTui(args)
writeTitle(title)
process.exit(code ?? 0)

function withTitleDisabled(existing) {
  let base = {}
  try {
    base = existing ? JSON.parse(existing) : {}
  } catch {
    base = {}
  }
  const terminal = typeof base.terminal === "object" && base.terminal ? base.terminal : {}
  return JSON.stringify({ ...base, terminal: { ...terminal, title: false } })
}

function writeTitle(value) {
  process.stdout.write(`\u001b]0;${value}\u0007`)
}

function parseArgs(argv) {
  const args = []
  let ssh
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--ssh") {
      ssh = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith("--ssh=")) {
      ssh = arg.slice("--ssh=".length)
      continue
    }
    args.push(arg)
  }
  return { args, ssh }
}

async function ensureSupervisor() {
  if (await healthy()) return

  const stateDir = path.join(homedir(), ".local", "state", "open2code")
  mkdirSync(stateDir, { recursive: true })
  const logFd = openSync(path.join(stateDir, "supervisor.log"), "a")

  const supervisor = new URL("./supervisor.mjs", import.meta.url)
  const child = spawn(process.execPath, [supervisor.pathname], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  })
  child.unref()
  closeSync(logFd)

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await delay(300)
    if (await healthy()) return
  }
  console.error(`open2code: supervisor did not become ready on ${endpoint}; see ${stateDir}/supervisor.log`)
  process.exit(1)
}

async function healthy() {
  try {
    const response = await fetch(`${endpoint}${STATUS_PATH}`, { signal: AbortSignal.timeout(1_000) })
    return response.ok
  } catch {
    return false
  }
}

function runTui(args) {
  return new Promise((resolve) => {
    const child = spawn("opencode", ["--server", endpoint, ...args], { stdio: "inherit" })

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => child.kill(signal))
    }
    child.on("exit", (code) => resolve(code ?? 0))
    child.on("error", (error) => {
      console.error(`open2code: failed to start opencode: ${error.message}`)
      resolve(1)
    })
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
