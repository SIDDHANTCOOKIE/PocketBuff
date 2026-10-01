# Install Pocketbuff

You are a coding agent (Freebuff or similar) running on the human's computer. Follow this file to set up **Pocketbuff**, which lets the human control Freebuff on this computer from their phone. You do all the work. The human only does what a step marks as HUMAN, and you tell them exactly what to do.

Pocketbuff runs on this computer. The human chooses how to reach it: Tailscale for private remote access from anywhere, or local-only access on this computer / the same trusted network, with no Tailscale. No paid API key is needed: it uses the Freebuff login already on this machine.

## Rules

- Run the commands yourself. Don't ask the human to run anything unless a step returns `HUMAN`.
- Ask the access-mode question below before running the installer, and wait for the human's answer. Never install or sign in to Tailscale if they choose local-only. Don't ask other questions the script can answer. The defaults are right: project = current folder, port = 8787 (the script picks the next free one if needed).
- Never print, paste, or repeat the contents of `~/.pocketbuff/config.env` or any token. The only secret you may show the human is the 6-digit pairing code.
- Never use `sudo` yourself, never disable a firewall, and never change Tailscale ACLs or accounts.
- If the same step `FAIL`s twice in a row, stop. Tell the human the step name and its FAIL line, and suggest running `bash ~/.pocketbuff/install.sh doctor`.

## 0. Ask how they want to connect

Ask: "Do you want Tailscale for private access from anywhere, or local-only access on this computer / the same Wi-Fi, without Tailscale?"

Wait for their choice. Do not choose for them, even with `--yes`.

- **Tailscale:** use `--tailscale` (Windows: `-Tailscale`). The companion stays bound to `127.0.0.1`; Tailscale Serve supplies private HTTPS. Only this path runs the `tailscale` and `serve` steps.
- **Local-only:** use `--local` (Windows: `-Local`). Without a host flag it binds to `127.0.0.1`, for this computer only. For a phone on the same network, inspect this computer's active network adapters and add `--host <private-LAN-IPv4>` (Windows: `-BindHost <private-LAN-IPv4>`), using an actual address assigned to this computer. If there are multiple possible networks, ask which one they want. Never use `0.0.0.0`, a public address, or a Tailscale IP. The phone must be on that same network; localhost on the phone is not this computer.

Explain before local network setup: local HTTP is unencrypted, so use only a trusted private network. Do not open router ports, enable port forwarding, or disable a firewall. If a firewall blocks the phone, report it and let the human decide rather than changing it. Chat and pairing work in the browser over local HTTP, but installing the PWA / service worker on a phone requires HTTPS; do not promise installation for a plain HTTP LAN link.

The installer saves the chosen mode and host. `pair`, `doctor`, and updates keep that choice. Re-run with an explicit mode flag only when the human asks to change it. Local-only skips all Tailscale setup, sign-in, Serve setup, and phone-app instructions. When switching an existing Tailscale install to local-only, the installer removes only the old Pocketbuff Serve mapping, if present.

## 1. Check the platform

```sh
uname -s
```

Expected: `Darwin` (macOS) or `Linux`: keep following this file with `install.sh`. On Windows (`$env:OS` is `Windows_NT`, you are in PowerShell): skip to the **Windows** section below and use `install.ps1`. Everything else about the flow is identical: the same STEP lines, the same exit codes, the same re-run-the-same-command rule.

## 2. Run the installer with the chosen mode

`BASE` is the URL you fetched this file from, without `/install.md`. Run this from the project folder the human wants to use from their phone (normally the folder you are already in):

```sh
curl -fsSL BASE/install.sh | bash -s -- --yes --tailscale --project "$PWD"
```

The command above is for **Tailscale only**. For **local-only**, replace `--tailscale` with `--local`; for same-network phone access, also add `--host <private-LAN-IPv4>`. Keep the same mode and host on every retry.

If BASE can't be reached, use the copy on GitHub:

```sh
curl -fsSL https://raw.githubusercontent.com/SIDDHANTCOOKIE/PocketBuff/main/site/install.sh | bash -s -- --yes --tailscale --project "$PWD"
```

The first run takes about a minute. Each step prints one line:

```
STEP <name> OK|FAIL|HUMAN <detail>
```

Exit code `0` means done, `10` means it is waiting on the human, and `1` means a step failed.

What each step does, in order:

| Step | What it does | Expected when it works |
|---|---|---|
| `platform` | Detects OS and service manager | `OK darwin-arm64, service: launchd` (or linux / systemd) |
| `node` | Uses Node 20+ if present, else downloads a private copy into `~/.pocketbuff/node` (no sudo) | `OK v22.x.x at ...` |
| `app` | Downloads Pocketbuff into `~/.pocketbuff/app` and builds it | `OK installed ...` or `OK up to date` |
| `config` | Picks a port and makes a random access token (file mode 600) | `OK port 8787, project ...` |
| `service` | Starts Pocketbuff in the background and keeps it running (launchd / systemd user service) | `OK ... healthz ok` |
| `freebuff-login` | Checks that Freebuff is logged in | `OK logged in` |
| `tailscale` (Tailscale only) | Checks Tailscale is installed and signed in, and starts the sign-in if not | `OK signed in as <machine>.<tailnet>.ts.net` |
| `serve` (Tailscale only) | Publishes Pocketbuff on the tailnet over HTTPS (`tailscale serve`) | `OK https://<machine>.<tailnet>.ts.net/` |
| `network` (local-only) | Reports the local HTTP address; no Tailscale is needed | `OK local only at http://<host>:<port>/` |
| `pair` | Creates a one-time 6-digit code for the phone | `OK code 123456, valid for 10 minutes` |

## Windows: install.ps1 instead of install.sh

**Validation status (be honest with the human if they ask):** install.ps1 was verified by running it under PowerShell 7 on Linux. Proven there: argument handling, STEP output, exit codes, token/config/port logic, the Node download + checksum path, the app build, the background service and health check, pairing-code generation, an idempotent second run, and uninstall. Not yet run on a real Windows machine: installing Node and Tailscale with winget, the scheduled task, Tailscale for Windows itself, and the config-file permission lockdown. Treat the first real Windows run as the test. If the same Windows step FAILs twice, stop, tell the human the FAIL line, and say the Windows installer has not been proven on real hardware yet.

Run this from the project folder the human wants to use from their phone:

```powershell
irm BASE/install.ps1 -OutFile "$env:TEMP\pocketbuff-install.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\pocketbuff-install.ps1" -Yes -Tailscale -Project (Get-Location).Path
```

If BASE can't be reached, use the copy on GitHub:

```powershell
irm https://raw.githubusercontent.com/SIDDHANTCOOKIE/PocketBuff/main/site/install.ps1 -OutFile "$env:TEMP\pocketbuff-install.ps1"
```

The command above is for **Tailscale only**. For **local-only**, replace `-Tailscale` with `-Local`; for same-network phone access, also add `-BindHost <private-LAN-IPv4>`. Keep those flags on retries. PowerShell uses single-dash parameter names.

Windows differences from the step table in section 2:

| Step | Windows behavior |
|---|---|
| `platform` | Expects Windows 10+ on x64 or ARM64; service manager is a scheduled task |
| `node` | Uses Node 20+ if present, else `winget install OpenJS.NodeJS.LTS`, else downloads a private copy into `~\.pocketbuff\node` (no admin) |
| `service` | Registers a scheduled task named "Pocketbuff" (runs at logon as the current user, restarts on failure) instead of launchd/systemd |
| `config` | The token file is locked to the current Windows user - the 0600 equivalent |
| `tailscale` (Tailscale only) | Installs with `winget install tailscale.tailscale` if missing. Windows may show one administrator (UAC) prompt; approving it is the HUMAN part |

Windows-only HUMAN wordings:

- **winget / UAC**: "Windows is asking for administrator approval to install Node.js (or Tailscale). Please click Yes."
- **tailscale, no winget**: "Please install Tailscale from https://tailscale.com/download/windows, open it, and sign in. Tell me when it's done."
- Freebuff login applies to both modes. Tailscale sign-in and HTTPS approval apply only to Tailscale mode and match section 3 word for word.

Doctor, pair and uninstall on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.pocketbuff\install.ps1" doctor
```

(same file with `pair` or `uninstall`)

## 3. Handle HUMAN steps

When a line says `STEP <name> HUMAN <detail>`, the detail says exactly what the human must do. Tell them in one short message, in plain words. For example:

- **tailscale** (most common): "One step needs you: open this link and sign in to Tailscale. Use the same account you'll use on your phone: <link from the detail>. Tell me when it's done."
- **tailscale, not installed on Linux**: give them the one command from the detail. It asks for their password once, which is why you can't run it for them.
- **tailscale, not installed on macOS**: "Please install Tailscale from https://tailscale.com/download/mac, open it, and sign in. Tell me when it's done."
- **serve**: "One click: open <link from the detail> and turn on HTTPS for your Tailscale network."
- **freebuff-login**: "Please run `freebuff` in a terminal and finish the login in your browser." (This is rare, because you are probably running inside a logged-in Freebuff.)

Then wait for the human to say they're done, and run **the same install command again**. The script skips everything that already works and continues from where it stopped. You can also check a step without changing anything:

```sh
bash ~/.pocketbuff/install.sh doctor
```

Expected when everything works: one `OK` line per step, then `HEALTHY`.

## 4. Verify

After the run exits with `0`:

```sh
HOST=$(sed -n 's/^HOST=//p' ~/.pocketbuff/config.env)
curl -s "http://$HOST:$(sed -n 's/^PORT=//p' ~/.pocketbuff/config.env)/healthz"
```

On Windows, read only HOST and PORT from the config, never the token:

```powershell
$hostLine = (Select-String '^HOST=' "$env:USERPROFILE\.pocketbuff\config.env").Line
$portLine = (Select-String '^PORT=' "$env:USERPROFILE\.pocketbuff\config.env").Line
Invoke-RestMethod "http://$($hostLine.Substring(5)):$($portLine.Substring(5))/healthz"
```

Expected: JSON containing `"ok":true`. If not, run `doctor` and follow its `Fix:` hints once. If that doesn't help, stop and report (see Rules).

## 5. Tell the human

The last lines of a successful run look like this:

```
DONE
PHONE_URL https://laptop.tail1234.ts.net/
PAIR_URL https://laptop.tail1234.ts.net/#pair=123456
PAIR_CODE 123456
```

In local mode, `PHONE_URL` and `PAIR_URL` use `http://<selected-host>:<port>/` instead. Use the actual printed URL, never a guessed LAN address.

Send the human one message with these parts (fill in the real values, keep it short):

1. "Pocketbuff is ready."
2. **Tailscale only:** "On your phone: install the Tailscale app and sign in with the same account (skip this if it's already set up)." **Local-only:** "No Tailscale needed. Keep your phone on the same trusted Wi-Fi as this computer." If bound to localhost, say the link works on this computer only, not a phone.
3. "Then open this link on your phone (or this computer if localhost-only): <PAIR_URL>. It pairs automatically. If it asks for a code, it's <PAIR_CODE> (it works once and expires in 10 minutes)."
4. For HTTPS links: "Tip: use Share → Add to Home Screen to get it as an app." For local HTTP LAN links, say to use it in the browser; PWA installation requires HTTPS.
5. "Heads up: free mode gives your account one slot, so use the phone or this terminal, not both at the same time."
6. "Need a new code later? Ask me, or run `bash ~/.pocketbuff/install.sh pair`."

## Maintenance

| Task | Command |
|---|---|
| New pairing code | `bash ~/.pocketbuff/install.sh pair` |
| Health check | `bash ~/.pocketbuff/install.sh doctor` |
| Update to the latest version | run the install command from step 2 again |
| Remove Pocketbuff | `bash ~/.pocketbuff/install.sh uninstall` (leaves Node, Tailscale and Freebuff installed) |
| Logs | `~/.pocketbuff/logs/pocketbuff.log` |

On Windows, run the same commands as `powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.pocketbuff\install.ps1" <command>`.
