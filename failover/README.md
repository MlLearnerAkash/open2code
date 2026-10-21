# open2code failover

Run OpenCode locally and keep a cloud server over SSH as an automatically
activated standby. One command launches the TUI against a stable local port;
the supervisor behind it health-checks both servers and switches to the cloud
when the local one goes down, then back when it recovers.

```
   open2code (wrapper)
        │  exec: opencode --server http://127.0.0.1:4000
        ▼
   supervisor  ── 127.0.0.1:4000  (stable proxy port)
        │
        ├── active:  local OpenCode server   (default prefer = local)
        └── standby: cloud OpenCode server   ── ssh -L 4097 ──► cloud:4096
```

## How it works

- **One active server, one warm standby.** The supervisor routes every request
  (HTTP, Server-Sent Events, and WebSocket upgrades) to whichever side is
  healthy. It injects the correct credential per upstream, so the two servers
  can use different passwords.
- **Automatic failover.** A side that fails two consecutive `/api/info` probes
  is marked down; traffic switches to the other side. When the preferred side
  recovers it fails back.
- **Continuous session sync.** The active server's SQLite database is
  periodically snapshotted (`sqlite3 .backup`, safe while the server writes) and
  gzip-compressed onto the stopped standby through a temp file and an atomic
  rename, so a session that starts on one side exists on the other when traffic
  switches. Syncs are serialized: a copy that takes longer than
  `syncIntervalMs` finishes before the next one starts.

### Why a warm standby and not two live writers

SQLite has a single-writer model, and OpenCode stores sessions, credentials, and
history in one database. Two servers writing the same session concurrently would
corrupt it, and in-flight model turns and tool executions are process-local.
So the honest guarantee is: **the connection fails over automatically and the
session is present on the other side**, but a turn that was mid-flight on the
server that died cannot resume there. It continues on the new side from the
last synced state. "Concurrent writes to the same session on both machines" is
not a safe thing to build on SQLite.

## Requirements

- Node.js 20+ on the local machine (the supervisor is dependency-free ESM).
- `sqlite3` CLI (or Python 3) on both machines for snapshots.
- `opencode` on both machines.
- SSH access from local to cloud that works non-interactively (key-based;
  the tunnel uses `BatchMode=yes`).

## Setup

### 1. Cloud server

The cloud installer does the whole server side in one command: it installs
`opencode` from GitHub, points the server at `127.0.0.1:4096` with a generated
password, runs it as a systemd user service, and makes sure the SSH server
accepts the laptop's key.

```sh
curl -fsSL https://raw.githubusercontent.com/MlLearnerAkash/open2code/server-failover/failover/cloud/install | bash -s -- --ssh-user opervu
```

It prints the server password, the `~/.ssh/config` block, and the
`failover.json` to copy to your laptop. Pass
`--pubkey "$(cat ~/.ssh/id_ed25519.pub)"` to authorize a key the laptop already
has instead of generating one on the server.

<details>
<summary>Manual setup</summary>

Install `opencode` on the cloud and make sure `ssh cloud true` works without a
password. The supervisor can start the cloud server itself, or use a service
manager — see [Running the cloud server as a service](#running-the-cloud-server-as-a-service).

Point `cloud.ssh` at an SSH host alias. For example, in `~/.ssh/config`:

```
Host portulica
  HostName 24.176.198.155
  User opervu
  ForwardX11 yes
  ForwardX11Trusted yes
```

Then `cloud.ssh` is `portulica`. Verify non-interactive access (no password
prompt) with `ssh -o BatchMode=yes portulica true`.

The cloud needs `opencode` v2 to match the client. The default installer ships
v1, so use the v2 installer:

```sh
curl -fsSL https://opencode.ai/v2/install | bash
```

</details>

### 2. Local config

```sh
mkdir -p ~/.config/open2code
cp failover/config.example.json ~/.config/open2code/failover.json
# edit cloud.ssh and, if needed, local settings
```

Minimal config:

```jsonc
{
  "prefer": "local",
  "local": { "mode": "service" },
  "cloud": {
    "ssh": "cloud",
    "remotePort": 4096,
    "tunnelPort": 4097
  }
}
```

### 3. Run

```sh
./failover/bin/open2code.mjs            # or install it on your PATH as `open2code`
./failover/bin/open2code.mjs --ssh my-other-host   # override cloud.ssh for this launch
```

`--ssh <host>` (or `--ssh=<host>`) routes this launch through a different SSH
host than `cloud.ssh`. It only takes effect when the wrapper has to start the
supervisor; to switch hosts on an already-running supervisor, stop it first
(`pkill -f failover/bin/supervisor.mjs`) and relaunch.

The wrapper also brands the terminal title as `open2code` (the TUI sets a
hardcoded `OpenCode` title, so the wrapper disables it via
`OPENCODE_CONFIG_CONTENT` and sets its own).

The wrapper starts the supervisor detached (logs in
`~/.local/state/open2code/supervisor.log`), waits for it to become ready, then
launches `opencode --server http://127.0.0.1:4000`. Any extra arguments are
passed through to `opencode`.

Check status at any time:

```sh
curl -s http://127.0.0.1:4000/__open2code/status | jq
```

## Show the cloud host in the TUI

`failover/plugin/open2code-ssh` is a TUI plugin that prints `ssh <host>` in the
prompt footer, bottom-right. It reads `OPEN2CODE_SSH`, which `open2code` sets to
the effective `cloud.ssh`, so it stays hidden for a normal `opencode` launch.

Install it by linking the plugin into your OpenCode config:

```sh
mkdir -p ~/.config/opencode/plugins
ln -sfn "$(pwd)/failover/plugin/open2code-ssh" ~/.config/opencode/plugins/open2code-ssh
```

Launch through `open2code` to see it.

## Configuration reference

| Field | Default | Meaning |
| --- | --- | --- |
| `listen.host` / `listen.port` | `127.0.0.1` / `4000` | Stable port the TUI connects to. |
| `prefer` | `local` | Side to route to while healthy; also the failback target. |
| `failback` | `true` | Return to `prefer` when it recovers. `false` sticks to the new side. |
| `intervalMs` | `2000` | Health-check interval. |
| `syncIntervalMs` | `15000` | Minimum gap between database syncs. A sync that takes longer than this runs to completion before the next begins. |
| `local.mode` | `service` | `service` uses the managed background service; `serve` runs a dedicated `opencode serve`. |
| `local.url` / `local.password` / `local.db` | auto | Usually discovered via the `opencode` CLI. Set to override. |
| `local.port` | `4096` | Port for `local.mode = "serve"`. |
| `cloud.ssh` | — | SSH host alias or `user@host`. Required. |
| `cloud.sshPort` / `cloud.sshArgs` | — | Passed to `ssh`. |
| `cloud.remoteHost` / `cloud.remotePort` | `127.0.0.1` / `4096` | Cloud server address reachable from the cloud host. |
| `cloud.tunnelPort` | `4097` | Local port for the SSH forward. |
| `cloud.password` | generated | Cloud server password; persisted in the state file when generated. |
| `cloud.db` | `~/.local/share/opencode/opencode.db` | Cloud database path. |
| `cloud.start` / `cloud.stop` | built-in `serve` | Commands run on the cloud (e.g. `systemctl --user start opencode`). |

Environment overrides exist for the common fields, e.g. `OPEN2CODE_CLOUD_SSH`,
`OPEN2CODE_PREFER`, `OPEN2CODE_LISTEN_PORT`, `OPEN2CODE_FAILOVER_CONFIG`.

## Running the cloud server as a service

Use `cloud/opencode.service` (systemd user unit) instead of the built-in
launcher, and point the config at it:

```jsonc
{
  "cloud": {
    "ssh": "cloud",
    "password": "the-same-password-as-the-unit",
    "start": "systemctl --user start opencode",
    "stop": "systemctl --user stop opencode"
  }
}
```

The cloud installer writes this unit for you, with the generated password
already in it, and enables it with `systemctl --user enable --now opencode`.

## Running the supervisor at login (macOS)

`launchd/com.open2code.failover.plist` starts the supervisor as a LaunchAgent so
the proxy port is always available. Edit the paths, then:

```sh
cp failover/launchd/com.open2code.failover.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.open2code.failover.plist
```

## Operations

- **Status**: `GET http://127.0.0.1:4000/__open2code/status` returns
  `{ active, transitioning, health, versions, urls }`.
- **Logs**: `~/.local/state/open2code/supervisor.log`.
- **Only use the wrapper.** While the supervisor runs, launch the TUI through
  `open2code`, and do not start a second server by hand — a second writer to the
  active database defeats the standby sync.
- **Force a side**: set `prefer` and restart the supervisor (the state file and
  config are re-read on start).

## Tests

```sh
cd failover && node --test
```
