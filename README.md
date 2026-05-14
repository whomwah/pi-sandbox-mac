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

Arrays in `network` and `filesystem` are **concatenated** across configs. Scalars like `enabled` are overridden. For example, adding `"allowedDomains": ["internal.registry.local"]` in global config appends to the defaults — it doesn't replace them.

## Extra Host Paths

Grant additional write access via `allowWrite`:

```jsonc
// .pi/sandbox.json
{ "filesystem": { "allowWrite": ["~/Downloads", "/Volumes/external-drive"] } }
```

Write access gives the agent full control over files in that path — only grant what's needed.

## SSH / Git with 1Password

Git works automatically if 1Password SSH agent is running. No manual config needed.

The extension reads `$SSH_AUTH_SOCK` (falling back to `~/.1password/agent.sock`), resolves the symlink, and adds both paths to the sandbox allow list. A spawn hook injects `SSH_AUTH_SOCK`, `HOME`, and a `GIT_SSH_COMMAND` with the correct SOCKS proxy and host-key options into every bash command.

## Commands & Flags

- **`/sandbox`** — Show active sandbox config (domains, paths, SSH socket)
- **`--no-sandbox`** — Disable sandboxing entirely: `pi -e /path/to/pi-sandbox/index.ts --no-sandbox`

## Troubleshooting

### "Sandbox initialization failed: sandbox-exec not found"

`sandbox-exec` is macOS-only. The extension requires macOS.

### "Permission denied" when reading/writing files

Add the path to `allowWrite` in `.pi/sandbox.json`, remove it from `denyRead`, or use `--no-sandbox`.

### SSH / Git fails with authentication errors

1. Confirm 1Password SSH agent is enabled and `echo $SSH_AUTH_SOCK` points to the socket
2. Run `/sandbox` in pi to verify the socket path is detected
3. If using a non-standard socket, set `sshAuthSock` in your config

### Large file writes fail (>512KB)

`writeFile` uses `echo ... | base64 -d` which hits the shell's `ARG_MAX` limit. A known limitation of the shell-based approach.

### Extension conflict with pi's built-in sandbox

Don't load both `pi-sandbox` and pi's built-in sandbox simultaneously — they wrap the same tools.
