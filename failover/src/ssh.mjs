// SSH helpers: a managed local port-forward to the cloud server, and one-shot
// remote command/stream helpers used for DB replication and server control.

import { spawn } from "node:child_process"
import net from "node:net"

const baseArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]

export function sshTargets(config) {
  const args = [...baseArgs]
  if (config.sshPort) args.push("-p", String(config.sshPort))
  args.push(...config.sshArgs)
  return args
}

// Long-lived `ssh -N -L` tunnel. `ensure()` is idempotent: it reuses anything
// already listening on the local port, so an external autossh tunnel also works.
export function createTunnel(config, { log = () => {}, connect = tcpProbe } = {}) {
  let child
  let stopped = false

  const localPort = config.tunnelPort
  const spec = `${localPort}:${config.remoteHost}:${config.remotePort}`

  async function up() {
    return connect("127.0.0.1", localPort)
  }

  async function ensure() {
    if (stopped) return false
    if (await up()) return true
    if (child && child.exitCode === null) return false

    const args = [
      ...sshTargets(config),
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-L",
      spec,
      config.ssh,
    ]
    log(`opening tunnel ${spec} via ${config.ssh}`)
    child = spawn("ssh", args, { stdio: ["ignore", "ignore", "inherit"] })
    child.on("exit", (code) => {
      child = undefined
      if (!stopped) log(`tunnel exited (${code}); will retry`)
    })

    // Give the forward a moment to come up; the health loop retries otherwise.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(150)
      if (await up()) return true
    }
    return false
  }

  function stop() {
    stopped = true
    child?.kill("SIGTERM")
    child = undefined
  }

  return { ensure, stop, url: `http://127.0.0.1:${localPort}` }
}

export function remoteRun(config, command, { input, log = () => {} } = {}) {
  const args = [...sshTargets(config), config.ssh, command]
  log(`ssh ${config.ssh}: ${command}`)
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] })
    const out = []
    const err = []
    child.stdout.on("data", (chunk) => out.push(chunk))
    child.stderr.on("data", (chunk) => err.push(chunk))
    child.on("error", reject)
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }),
    )
    if (input) {
      child.stdin.end(input)
    }
  })
}

function tcpProbe(host, port, timeout = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (result) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeout)
    socket.on("connect", () => done(true))
    socket.on("timeout", () => done(false))
    socket.on("error", () => done(false))
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
