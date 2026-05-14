# pi-sandbox

macOS-native OS-level sandbox extension for [pi](https://github.com/earendil-works/pi-coding-agent).

Blocks dangerous filesystem and network operations at the kernel level using `sandbox-exec` (no Docker, no containers). Agent tools (`read`, `write`, `edit`, `bash`) are automatically wrapped with sandbox policies.

## Quick Start

```bash
cd /path/to/your/project
pi -e /path/to/pi-sandbox/index.ts
```

On session start, the sandbox initializes with sensible defaults:
- **Read** is allowed everywhere by default (except sensitive paths like `~/.ssh`, `~/.aws`, `~/.gnupg`)
- **Write** is restricted to the current directory and `/tmp`
- **Network** is restricted to package registries (npm, PyPI) and GitHub

Run `/sandbox` inside pi to see the active configuration.

## Configuration

Two optional config files are merged together (deep merge — arrays are **concatenated**, not replaced):

| File | Purpose |
|------|---------|
| `~/.pi/agent/extensions/pi-sandbox.json` | Global config (applies to all projects) |
| `<project>/.pi/sandbox.json` | Project-local overrides |

### Full config shape

```jsonc
{
  // Enable/disable sandbox. Default: true.
  "enabled": true,

  // Fallback SSH socket path if $SSH_AUTH_SOCK is unset. Default: "~/.1password/agent.sock"
  "sshAuthSock": "~/.1password/agent.sock",

  "network": {
    // Domains the agent can reach (wildcards supported). Defaults include
    // npmjs.org, github.com, pypi.org and their subdomains.
    "allowedDomains": ["npmjs.org", "*.npmjs.org", "github.com", "*.github.com"],

    // Domains explicitly blocked.
    "deniedDomains": []
  },

  "filesystem": {
    // Paths the agent cannot read (glob patterns supported).
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud"],

    // Paths the agent can write to. Default: [".", "/tmp"].
    "allowWrite": [".", "/tmp"],

    // Paths the agent cannot write to (glob patterns). Default: [".env", ".env.*", "*.pem", "*.key"]
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

### Merge behavior

When both global and project configs exist, arrays in `network` and `filesystem` are concatenated. Scalars like `enabled` are overridden.

**Global config** adds an extra allowed domain:
```json
{ "network": { "allowedDomains": ["internal.registry.local"] } }
```

**Project config** adds an extra write path:
```json
{ "filesystem": { "allowWrite": ["~/Downloads"] } }
```

Result: `allowedDomains` includes npmjs.org, github.com, **and** internal.registry.local. `allowWrite` includes `.`, `/tmp`, **and** `~/Downloads`.

## Extra Host Paths

Grant additional read/write access by adding paths to `allowWrite`. Common use cases:

```jsonc
// .pi/sandbox.json
{
  "filesystem": {
    "allowWrite": [
      ".",           // current directory (included by default)
      "/tmp",        // temp directory (included by default)
      "~/Downloads", // access to user Downloads
      "~/Desktop",   // access to user Desktop
      "/Volumes/external-drive" // external drive
    ]
  }
}
```

> **Note:** Write access gives the agent full control over files in that directory. Only grant what's needed.

## SSH / Git with 1Password

pi-sandbox auto-detects your SSH agent socket so Git operations work through the sandbox.

1. The `$SSH_AUTH_SOCK` environment variable is read first. If not set, falls back to `~/.1password/agent.sock`.
2. Because 1Password's socket is usually a symlink (pointing into `~/Library/Group Containers/`), both the symlink path and the real path are added to the sandbox's `allowWrite` list before initialization.
3. `SSH_AUTH_SOCK` and `HOME` are injected into every sandboxed `bash` command via a spawn hook.

No manual configuration needed — if 1Password SSH agent is running, Git works.

## Commands

### `/sandbox`

Shows the current sandbox configuration loaded at session start:
- Network: allowed and denied domains
- Filesystem: deny read, allow write, deny write paths
- SSH agent socket path

If the sandbox is disabled, shows a notification instead.

## Flags

### `--no-sandbox`

Disables sandboxing entirely. All tools operate normally without any filesystem or network restrictions.

```bash
pi -e /path/to/pi-sandbox/index.ts --no-sandbox
```

## Troubleshooting

### "Sandbox initialization failed: sandbox-exec not found"

`sandbox-exec` is part of macOS. If missing, your system may need to be updated. The extension requires macOS.

### "Permission denied" when reading/writing files

The sandbox is blocking access. Either:
- Add the path to `allowWrite` in `.pi/sandbox.json`
- Remove the path from `denyRead` if read is being blocked
- Use `--no-sandbox` to disable the sandbox entirely

### "Working directory does not exist" on bash commands

The current working directory (`cwd`) must exist before running sandboxed commands. Ensure you're in a real directory.

### SSH / Git fails with authentication errors

1. Confirm 1Password SSH agent is enabled
2. Check `echo $SSH_AUTH_SOCK` in your terminal — should point to the socket
3. Run `/sandbox` in pi to verify the socket path is detected
4. If using a non-standard SSH socket, set `sshAuthSock` in your config

### Large file writes fail (>512KB)

The `writeFile` operation uses `echo ... | base64 -d` which hits the shell's `ARG_MAX` limit. Files larger than ~512KB may fail. This is a known limitation inherited from the shell-based approach.

### Extension conflict with pi's built-in sandbox

Do not load both `pi-sandbox` and pi's built-in sandbox example simultaneously. They both wrap the same tools and may interfere.
