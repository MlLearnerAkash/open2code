// A streaming HTTP/WebSocket reverse proxy with a single active upstream.
//
// `getUpstream()` is consulted per request, so a failover between requests is
// transparent. Server-Sent Events and WebSocket upgrades are piped without
// buffering, which is what the OpenCode event stream and PTY channels need.
//
// The proxy resolves the upstream credential itself and overwrites any
// Authorization header from the client, so the local and cloud servers can use
// different passwords without the TUI knowing.

import http from "node:http"
import net from "node:net"
import { basicAuth } from "./auth.mjs"

export const STATUS_PATH = "/__open2code/status"

export function createProxyServer({ getUpstream, statusProvider, log = () => {} }) {
  const server = http.createServer(handleRequest)
  server.on("upgrade", handleUpgrade)
  server.on("clientError", (_error, socket) => socket.destroy())
  return server

  function handleRequest(req, res) {
    if (req.url === STATUS_PATH) return writeStatus(res)

    const upstream = getUpstream()
    if (!upstream) return plain(res, 503, "open2code: no healthy OpenCode server")

    const target = new URL(upstream.url)
    const headers = { ...req.headers, host: target.host }
    const authorization = basicAuth(upstream.password)
    if (authorization) headers.authorization = authorization

    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 80,
        path: req.url,
        method: req.method,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      },
    )

    request.on("error", (error) => {
      log(`upstream error for ${req.method} ${req.url}: ${error.message}`)
      if (res.headersSent) return res.destroy()
      plain(res, 502, `open2code: upstream error: ${error.message}`)
    })

    req.pipe(request)
  }

  // WebSocket and other upgrades are forwarded as a raw byte stream in both
  // directions, so binary frames and the handshake both survive untouched.
  function handleUpgrade(req, clientSocket, head) {
    const upstream = getUpstream()
    if (!upstream) return clientSocket.destroy()

    const target = new URL(upstream.url)
    const serverSocket = net.connect(Number(target.port || 80), target.hostname)

    serverSocket.on("connect", () => {
      const headers = { ...req.headers, host: target.host }
      const authorization = basicAuth(upstream.password)
      if (authorization) headers.authorization = authorization
      serverSocket.write(`${req.method} ${req.url} HTTP/1.1\r\n${serializeHeaders(headers)}\r\n`)
      if (head?.length) serverSocket.write(head)
      serverSocket.pipe(clientSocket)
      clientSocket.pipe(serverSocket)
    })

    serverSocket.on("error", (error) => {
      log(`upgrade upstream error for ${req.url}: ${error.message}`)
      clientSocket.destroy()
    })
    clientSocket.on("error", () => serverSocket.destroy())
  }

  function writeStatus(res) {
    const status = statusProvider?.() ?? {}
    plain(res, 200, JSON.stringify(status), { "content-type": "application/json" })
  }
}

function serializeHeaders(headers) {
  return Object.entries(headers)
    .flatMap(([name, value]) => (Array.isArray(value) ? value.map((entry) => [name, entry]) : [[name, value]]))
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n")
}

function plain(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers })
  res.end(body)
}
