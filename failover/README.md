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

The standby can be any SSH-reachable machine. The cloud installer automates a
Linux box with systemd; see [Connecting a new system](#connecting-a-new-system)
for other platforms and for switching hosts later.

On that machine, the installer does the whole server side in one command: it
installs `opencode` from GitHub, points the server at `127.0.0.1:4096` with a
generated password, runs it as a systemd user service, and makes sure the SSH
server accepts the laptop's key.

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

## Connecting a new system

The standby is any machine you can reach over SSH: a cloud VM, a homelab server,
or another laptop. Nothing is tied to a specific provider — the supervisor only
needs an SSH alias, the server's loopback address, and its password.

### Linux with systemd (one command)

Run the installer on the new machine. It installs OpenCode v2, starts the server
on `127.0.0.1:4096` with a generated password, installs the systemd user unit,
and authorizes the laptop's SSH key.

```sh
ssh new-host
curl -fsSL https://raw.githubusercontent.com/MlLearnerAkash/open2code/server-failover/failover/cloud/install | bash -s -- \
  --ssh-user "$(id -un)" \
  --ssh-alias open2code-cloud
```

- `--ssh-user`, `--ssh-host`, `--ssh-port`, `--ssh-alias` describe how the
  laptop reaches this machine; the defaults are the current user, the detected
  public IP, port 22, and `open2code-cloud`.
- `--pubkey "$(cat ~/.ssh/id_ed25519.pub)"` authorizes an existing laptop key
  instead of generating a new keypair on the server.
- `--server-port`, `--password` override the server port and password.
- `--no-systemd` and `--no-ssh` skip those steps when the machine is managed
  elsewhere.

The installer prints the private-key copy step (when it generated a keypair),
the `~/.ssh/config` block, and the `failover.json` for the laptop. Copy the key
if there is one, add the block, then set `cloud.ssh` to the alias and
`cloud.password` to the printed password:

```jsonc
{
  "prefer": "local",
  "local": { "mode": "service" },
  "cloud": {
    "ssh": "open2code-cloud",
    "password": "the-password-printed-by-the-installer",
    "remotePort": 4096,
    "tunnelPort": 4097,
    "start": "systemctl --user start opencode",
    "stop": "systemctl --user stop opencode"
  }
}
```

Verify before launching: `ssh -o BatchMode=yes open2code-cloud true` must exit
silently, and `ssh -o BatchMode=yes open2code-cloud 'curl -s -o /dev/null -w %{http_code} -u opencode:PASSWORD http://127.0.0.1:4096/api/info'`
should print `200`.

### Other systems (no systemd)

The installer only targets Linux with systemd. For macOS, BSD, a container, or a
machine where you do not want a service, set the system up by hand:

1. Install OpenCode v2 (`curl -fsSL https://opencode.ai/v2/install | bash`).
2. Start the server on loopback with a chosen password, either continuously by
   hand or under the machine's own supervisor:
   ```sh
   export OPENCODE_SERVER_PASSWORD=choose-a-secret
   opencode serve --hostname 127.0.0.1 --port 4096
   ```
3. Make sure the laptop can run commands non-interactively:
   `ssh -o BatchMode=yes <alias> 'command -v gzip && { command -v sqlite3 || command -v python3; }'`
   must print paths, since snapshots need `gzip` plus `sqlite3` or Python 3.
4. Add the alias to `~/.ssh/config`, then set `cloud.ssh`, `cloud.password`,
   `remoteHost`, and `remotePort` in `failover.json`. If the machine runs the
   server under its own supervisor (launchd, a container restart policy), set
   `cloud.start` and `cloud.stop` to the commands that control it. Leave them
   unset to let the failover supervisor start and stop its own `opencode serve`
   over SSH.

### Switching to a different system

When moving the standby to another machine:

1. Run the installer (or manual setup) on the new machine and update
   `cloud.ssh` and `cloud.password` in `~/.config/open2code/failover.json`.
   Keep `cloud.remotePort` in step if the server does not use `4096`.
2. Stop the running supervisor so it re-reads the config:
   ```sh
   pkill -f failover/bin/supervisor.mjs
   ```
3. Relaunch `./failover/bin/open2code.mjs` and check
   `curl -s http://127.0.0.1:4000/__open2code/status | jq` shows the new host
   healthy.

Two details can bite when switching:

- **Password state wins over a stale config.** A generated password is persisted
  as `cloudPassword` in `~/.local/state/open2code/failover.json` and is reused
  when `cloud.password` is absent. After switching hosts, either set
  `cloud.password` explicitly or remove the `cloudPassword` entry so the next
  start generates a new one.
- **`cloud.tunnelPort` is local.** It must be free, and it must differ if you run
  more than one failover supervisor on the laptop.

To try a host for a single launch without editing the config, use
`./failover/bin/open2code.mjs --ssh <alias>` (or set `OPEN2CODE_CLOUD_SSH`);
stop the supervisor first if one is already running, since the override applies
when the supervisor starts.

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
| `cloud.password` | generated | Cloud server password; persisted in the state file when generated. Set it explicitly when connecting a new system so the stored one is not reused. |
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
