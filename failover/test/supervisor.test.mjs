import assert from "node:assert/strict"
import test from "node:test"
import { createSupervisor } from "../src/supervisor.mjs"

const config = {
  listen: { host: "127.0.0.1", port: 0 },
  prefer: "local",
  failback: true,
  intervalMs: 20,
  local: { mode: "service" },
  cloud: { ssh: "cloud" },
}

function makeRuntime(state) {
  const events = []
  return {
    events,
    local: async () => ({ url: "http://local.test", password: "lp", db: "/tmp/local.db" }),
    cloudUrl: () => "http://127.0.0.1:4097/",
    cloudPassword: () => "cp",
    ensureTunnel: async () => true,
    probeLocal: async () => ({ healthy: state.local }),
    probeCloud: async () => ({ healthy: state.cloud }),
    start: async (side) => events.push(`start:${side}`),
    stop: async (side) => events.push(`stop:${side}`),
    sync: async (from) => events.push(`sync:${from}`),
    stopTunnel: () => events.push("tunnel:stop"),
  }
}

async function until(predicate, label) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test("fails over to cloud when local dies and fails back when it recovers", async (t) => {
  const state = { local: true, cloud: false }
  const runtime = makeRuntime(state)
  const supervisor = createSupervisor({ config, runtime, syncIntervalMs: 1e9, settleMs: 0 })
  await supervisor.start()
  t.after(() => supervisor.stop())

  assert.equal(supervisor.status().active, "local")
  assert.ok(runtime.events.includes("stop:cloud"))
  assert.ok(runtime.events.includes("sync:local"))

  state.local = false
  state.cloud = true
  await until(() => supervisor.status().active === "cloud", "failover to cloud")
  assert.ok(runtime.events.includes("start:cloud"))
  assert.ok(runtime.events.includes("stop:local"))
  assert.ok(runtime.events.includes("sync:local"))

  state.local = true
  state.cloud = true
  await until(() => supervisor.status().active === "local", "failback to local")
  assert.ok(runtime.events.includes("sync:cloud"))
  assert.ok(runtime.events.includes("start:local"))
})
