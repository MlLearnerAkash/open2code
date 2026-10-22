// Health probes against an OpenCode server's /api/info endpoint.
//
// The same endpoint the CLI's own `checkServerHealth` uses
// (packages/app/src/runtime/server/health.ts), so success here means the TUI
// will consider the server usable.

import { basicAuth } from "./auth.mjs"

const defaultTimeoutMs = 3_000

export async function probe(url, { password, timeoutMs = defaultTimeoutMs, fetchImpl = fetch } = {}) {
  const headers = {}
  const authorization = basicAuth(password)
  if (authorization) headers.authorization = authorization

  const signal = AbortSignal.timeout(timeoutMs)
  const version = await fetchImpl(`${trimSlash(url)}/api/info`, { headers, signal })
    .then((response) => (response.ok ? response.json() : null))
    .then((body) => body?.version)
    .catch(() => undefined)

  return { healthy: typeof version === "string", version }
}

function trimSlash(url) {
  return String(url).replace(/\/+$/, "")
}
