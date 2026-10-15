// OpenCode's explicit-server authentication is HTTP Basic with the username
// "opencode" and the server password as the secret (see packages/cli/src/env.ts
// and packages/cli/src/services/server-connection.ts).

export function basicAuth(password) {
  if (!password) return undefined
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`
}
