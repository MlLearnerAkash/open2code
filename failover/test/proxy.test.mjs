import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { basicAuth } from "../src/auth.mjs"
import { createProxyServer } from "../src/proxy.mjs"

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
}

function makeUpstream(name, handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    if (handler) return handler(req, res)
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(name)
  })
  return { server, requests }
}

test("routes to the selected upstream, injects the upstream credential, and fails over", async (t) => {
  const a = makeUpstream("A")
  const b = makeUpstream("B")
  const portA = await listen(a.server)
  const portB = await listen(b.server)

  let current = { url: `http://127.0.0.1:${portA}`, password: "pw-a" }
  const proxy = createProxyServer({
    getUpstream: () => current,
    statusProvider: () => ({ active: current === undefined ? "none" : "local" }),
  })
  const port = await listen(proxy)
  t.after(() => {
    proxy.close()
    a.server.close()
    b.server.close()
  })

  const first = await fetch(`http://127.0.0.1:${port}/api/info`)
  assert.equal(await first.text(), "A")
  assert.equal(a.requests[0].headers.authorization, basicAuth("pw-a"))
  assert.equal(a.requests[0].headers.host, `127.0.0.1:${portA}`)

  current = { url: `http://127.0.0.1:${portB}`, password: "pw-b" }
  const second = await fetch(`http://127.0.0.1:${port}`)
  assert.equal(await second.text(), "B")
  assert.equal(b.requests[0].headers.authorization, basicAuth("pw-b"))
})

test("streams server-sent events through without buffering", async (t) => {
  const upstream = makeUpstream("SSE", (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write("event: ready\ndata: {}\n\n")
    setTimeout(() => {
      res.write("event: tick\ndata: 1\n\n")
      res.end()
    }, 20)
  })
  const port = await listen(upstream.server)
  const proxy = createProxyServer({ getUpstream: () => ({ url: `http://127.0.0.1:${port}` }) })
  const proxyPort = await listen(proxy)
  t.after(() => {
    proxy.close()
    upstream.server.close()
  })

  const response = await fetch(`http://127.0.0.1:${proxyPort}/api/event`)
  assert.equal(response.headers.get("content-type"), "text/event-stream")

  let received = ""
  for await (const chunk of response.body) received += Buffer.from(chunk).toString()
  assert.match(received, /event: ready/)
  assert.match(received, /event: tick/)
})

test("answers its own status endpoint and returns 503 without a healthy upstream", async (t) => {
  let upstream = undefined
  const proxy = createProxyServer({
    getUpstream: () => upstream,
    statusProvider: () => ({ active: upstream ? "local" : "none" }),
  })
  const port = await listen(proxy)
  t.after(() => proxy.close())

  const status = await fetch(`http://127.0.0.1:${port}/__open2code/status`)
  assert.equal(status.status, 200)
  assert.deepEqual(await status.json(), { active: "none" })

  const missing = await fetch(`http://127.0.0.1:${port}/api/info`)
  assert.equal(missing.status, 503)

  const healthy = makeUpstream("ok")
  const upstreamPort = await listen(healthy.server)
  upstream = { url: `http://127.0.0.1:${upstreamPort}` }
  t.after(() => healthy.server.close())
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/api/info`)).text(), "ok")
})
