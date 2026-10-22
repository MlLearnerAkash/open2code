// Pure routing decision for the failover supervisor.
//
// `active` is the side currently receiving traffic ("local" or "cloud").
// Health booleans are already debounced by the caller, so this function only
// encodes the policy: stay put while healthy, switch when the active side goes
// down, and optionally fail back to the preferred side once it recovers.

export const LOCAL = "local"
export const CLOUD = "cloud"

export function other(side) {
  return side === LOCAL ? CLOUD : LOCAL
}

export function selectActive({ prefer, current, localHealthy, cloudHealthy }) {
  const healthy = { local: localHealthy, cloud: cloudHealthy }
  const fallback = other(current)

  if (healthy[current]) {
    // Stay on the active side unless failback is configured and the preferred
    // side has recovered. `prefer` doubles as the failback target.
    if (current !== prefer && healthy[prefer]) return { active: prefer, changed: prefer !== current, degraded: false }
    return { active: current, changed: false, degraded: false }
  }

  if (healthy[fallback]) return { active: fallback, changed: fallback !== current, degraded: false }

  // Neither side is healthy. Keep pointing at the last active side so callers
  // surface a clear transport error instead of oscillating.
  return { active: current, changed: false, degraded: true }
}

// Counts consecutive probe outcomes so a single missed health check (a GC pause,
// a slow disk) does not trigger a failover. `up` needs one success; `down`
// needs `threshold` consecutive failures.
export function createHealthTracker({ threshold = 2 } = {}) {
  const failures = { local: 0, cloud: 0 }
  const healthy = { local: true, cloud: true }

  return {
    healthy: (side) => healthy[side],
    observe(side, ok) {
      if (ok) {
        failures[side] = 0
        healthy[side] = true
        return healthy[side]
      }
      failures[side] += 1
      if (failures[side] >= threshold) healthy[side] = false
      return healthy[side]
    },
    failures: (side) => failures[side],
  }
}
