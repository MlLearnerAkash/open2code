import assert from "node:assert/strict"
import test from "node:test"
import { loadConfig, validate } from "../src/config.mjs"

const home = "/home/tester"

function reader(files) {
  return (file) => files[file] ?? null
}

test("applies defaults when no config file exists", () => {
  const config = loadConfig({ env: {}, home, readFile: reader({}) })
  assert.equal(config.listen.port, 4000)
  assert.equal(config.prefer, "local")
  assert.equal(config.failback, true)
  assert.equal(config.local.mode, "service")
  assert.equal(config.cloud.tunnelPort, 4097)
  assert.equal(config.cloud.db, "~/.local/share/opencode/opencode.db")
  assert.deepEqual(validate(config), ["cloud.ssh is required (ssh host alias or user@host)"])
})

test("reads nested config and folds environment overrides on top", () => {
  const config = loadConfig({
    home,
    env: { OPEN2CODE_LISTEN_PORT: "4100", OPEN2CODE_PREFER: "cloud" },
    readFile: reader({
      [`${home}/.config/open2code/failover.json`]: {
        listen: { port: 9999 },
        cloud: { ssh: "me@cloud.example.com", tunnelPort: 5000 },
      },
    }),
  })
  assert.equal(config.listen.port, 4100)
  assert.equal(config.prefer, "cloud")
  assert.equal(config.cloud.ssh, "me@cloud.example.com")
  assert.equal(config.cloud.tunnelPort, 5000)
  assert.deepEqual(validate(config), [])
})

test("honors a persisted generated cloud password from the state file", () => {
  const config = loadConfig({
    env: {},
    home,
    readFile: reader({
      [`${home}/.config/open2code/failover.json`]: { cloud: { ssh: "cloud" } },
      [`${home}/.local/state/open2code/failover.json`]: { cloudPassword: "persisted" },
    }),
  })
  assert.equal(config.cloud.password, "persisted")
})
