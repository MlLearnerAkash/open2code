// The failover supervisor: one proxy on a stable loopback port that always
// points at a healthy OpenCode server, keeping the other side as a warm standby.
//
// Policy (see ./selector.mjs):
//   - route to the preferred side while it is healthy
//   - fail over to the other side once the active one stays unhealthy
//   - fail back to the preferred side only when `failback` is enabled
//
// The DB of the active side is periodically copied onto the stopped standby so
// a session started on one side exists on the other when traffic switches.

import { createProxyServer } from "./proxy.mjs"
import { createHealthTracker, other, selectActive } from "./selector.mjs"

export function createSupervisor({
  config,
  runtime,
  log = () => {},
  syncIntervalMs = 5_000,
  threshold = 2,
  settleMs = 1_000,
}) {
  const tracker = createHealthTracker({ threshold })
  const urls = { local: undefined, cloud: undefined }
  const passwords = { local: undefined, cloud: undefined }
  const versions = { local: undefined, cloud: undefined }
  let active = config.prefer
  let transitioning = false
  let ticking = false
  let lastSync = 0
  let timer

  const server = createProxyServer({
    log,
    getUpstream: () =>
      tracker.healthy(active) && urls[active] ? { url: urls[active], password: passwords[active] } : null,
    statusProvider: () => status(),
  })

  function status() {
    return {
      active,
      transitioning,
      urls,
      health: { local: tracker.healthy("local"), cloud: tracker.healthy("cloud") },
      versions,
    }
  }

  async function refreshIdentity() {
    const local = await runtime.local()
    urls.local = local.url
    passwords.local = local.password
    urls.cloud = runtime.cloudUrl()
    passwords.cloud = runtime.cloudPassword()
  }

  async function probeSide(side) {
    const result = side === "local" ? await runtime.probeLocal() : await runtime.probeCloud()
    versions[side] = result.version
    tracker.observe(side, result.healthy)
    return result.healthy
  }

  async function bootstrap() {
    await refreshIdentity()
    await runtime.ensureTunnel()
    await runtime.stop(other(active))
    if (!(await probeSide(active))) await runtime.start(active)
    await runtime.sync(active)
  }

  async function transition(next) {
    transitioning = true
    try {
      log(`failover: ${active} -> ${next}`)
      await runtime.stop(next)
      await runtime.sync(active)
      await runtime.stop(active)
      await runtime.start(next)
      active = next
      await sleep(settleMs)
      await probeSide(next)
    } finally {
      transitioning = false
    }
  }

  async function maybeReplicate() {
    if (Date.now() - lastSync < syncIntervalMs) return
    if (!tracker.healthy(active)) return
    // A full DB copy can outlast several tick intervals; mark the sync as
    // started only after it finishes so a slow upload never overlaps the next.
    await runtime.sync(active)
    lastSync = Date.now()
  }

  async function tick() {
    // Serialize ticks: a slow replication must never overlap the next one, and
    // concurrent writers would interleave and corrupt the standby database.
    if (transitioning || ticking) return
    ticking = true
    try {
      await refreshIdentity()
      await runtime.ensureTunnel()
      await Promise.all([probeSide("local"), probeSide("cloud")])
      const decision = selectActive({
        prefer: config.failback ? config.prefer : active,
        current: active,
        localHealthy: tracker.healthy("local"),
        cloudHealthy: tracker.healthy("cloud"),
      })
      if (decision.changed) return await transition(decision.active)
      return await maybeReplicate()
    } catch (error) {
      log(`tick failed: ${error.message}`)
    } finally {
      ticking = false
    }
  }

  return {
    status,
    server,
    async start() {
      try {
        await bootstrap()
      } catch (error) {
        log(`bootstrap failed: ${error.message}; starting in degraded mode`)
      }
      timer = setInterval(() => void tick(), config.intervalMs)
      await new Promise((resolve) => server.listen(config.listen.port, config.listen.host, resolve))
      log(`supervisor listening on http://${config.listen.host}:${config.listen.port}, active=${active}`)
      return server
    },
    async stop() {
      clearInterval(timer)
      runtime.stopTunnel()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
