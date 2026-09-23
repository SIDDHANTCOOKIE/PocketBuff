# Install Pocketbuff

You are a coding agent (Freebuff or similar) running on the human's computer. Follow this file to set up **Pocketbuff**, which lets the human control Freebuff on this computer from their phone. You do all the work. The human only does what a step marks as HUMAN, and you tell them exactly what to do.

Pocketbuff runs locally and is reached only over the human's own Tailscale network. Nothing is exposed to the public internet, and no paid API key is needed: it uses the Freebuff login already on this machine.

## Rules

- Run the commands yourself. Don't ask the human to run anything unless a step returns `HUMAN`.
- Don't ask questions the script can answer. The defaults are right: project = current folder, port = 8787 (the script picks the next free one if needed).
- Never print, paste, or repeat the contents of `~/.pocketbuff/config.env` or any token. The only secret you may show the human is the 6-digit pairing code.
- Never use `sudo` yourself, never disable a firewall, and never change Tailscale ACLs or accounts.
- If the same step `FAIL`s twice in a row, stop. Tell the human the step name and its FAIL line, and suggest running `bash ~/.pocketbuff/install.sh doctor`.

## 1. Check the platform

```sh
uname -s
```

Expected: `Darwin` (macOS) or `Linux`. Anything else (for example Windows): stop and tell the human: "Pocketbuff's installer supports macOS and Linux for now. Windows support is coming."

## 2. Run the installer

`BASE` is the URL you fetched this file from, without `/install.md`. Run this from the project folder the human wants to use from their phone (normally the folder you are already in):

```sh
curl -fsSL BASE/install.sh | bash -s -- --yes --project "$PWD"
```

If BASE can't be reached, use the copy on GitHub:

```sh
curl -fsSL https://raw.githubusercontent.com/SIDDHANTCOOKIE/freebuff-remote-control/main/site/install.sh | bash -s -- --yes --project "$PWD"
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
| `tailscale` | Checks Tailscale is installed and signed in, and starts the sign-in if not | `OK signed in as <machine>.<tailnet>.ts.net` |
| `serve` | Publishes Pocketbuff on the tailnet over HTTPS (`tailscale serve`) | `OK https://<machine>.<tailnet>.ts.net/` |
| `pair` | Creates a one-time 6-digit code for the phone | `OK code 123456, valid for 10 minutes` |

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
curl -s "http://127.0.0.1:$(sed -n 's/^PORT=//p' ~/.pocketbuff/config.env)/healthz"
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

Send the human one message with these parts (fill in the real values, keep it short):

1. "Pocketbuff is ready."
2. "On your phone: install the Tailscale app and sign in with the same account (skip this if it's already set up)."
3. "Then open this link on your phone: <PAIR_URL>. It pairs automatically. If it asks for a code, it's <PAIR_CODE> (it works once and expires in 10 minutes)."
4. "Tip: use Share → Add to Home Screen to get it as an app."
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
