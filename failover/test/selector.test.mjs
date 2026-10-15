import assert from "node:assert/strict"
import test from "node:test"
import { createHealthTracker, other, selectActive } from "../src/selector.mjs"

test("stays on the active side while it is healthy", () => {
  assert.deepEqual(selectActive({ prefer: "local", current: "local", localHealthy: true, cloudHealthy: true }), {
    active: "local",
    changed: false,
    degraded: false,
  })
})

test("fails over to the other side when the active side stays unhealthy", () => {
  assert.deepEqual(selectActive({ prefer: "local", current: "local", localHealthy: false, cloudHealthy: true }), {
    active: "cloud",
    changed: true,
    degraded: false,
  })
})

test("fails back to the preferred side once it recovers", () => {
  assert.deepEqual(selectActive({ prefer: "local", current: "cloud", localHealthy: true, cloudHealthy: true }), {
    active: "local",
    changed: true,
    degraded: false,
  })
})

test("holds the active side when neither side is healthy", () => {
  assert.deepEqual(selectActive({ prefer: "local", current: "cloud", localHealthy: false, cloudHealthy: false }), {
    active: "cloud",
    changed: false,
    degraded: true,
  })
})

test("other() flips the side", () => {
  assert.equal(other("local"), "cloud")
  assert.equal(other("cloud"), "local")
})

test("health tracker debounces a single miss and needs one success to recover", () => {
  const tracker = createHealthTracker({ threshold: 2 })
  assert.equal(tracker.observe("local", false), true)
  assert.equal(tracker.observe("local", false), false)
  assert.equal(tracker.observe("local", true), true)
  assert.equal(tracker.failures("local"), 0)
})
