#!/usr/bin/env node
// Runs the failover supervisor in the foreground. Normally started detached by
// bin/open2code.mjs; run it directly to watch the log.

import { loadConfig, validate } from "../src/config.mjs"
import { createRuntime } from "../src/runtime.mjs"
import { createSupervisor } from "../src/supervisor.mjs"

const config = loadConfig()
const problems = validate(config)
if (problems.length > 0) {
  console.error("open2code: invalid configuration:")
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

const log = (message) => console.error(`[open2code ${new Date().toISOString()}] ${message}`)
const runtime = createRuntime({ config, log })
const supervisor = createSupervisor({ config, runtime, log, syncIntervalMs: config.syncIntervalMs })

await supervisor.start()

let closing = false
async function shutdown(signal) {
  if (closing) return
  closing = true
  log(`received ${signal}, shutting down`)
  await supervisor.stop()
  process.exit(0)
}

process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
