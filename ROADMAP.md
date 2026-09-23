# Roadmap

Done (local, verified): M1 companion + chat, M2 tool/diff cards + approval gate, M3 installable PWA, M4 multi-session, e2e fixes (runs survive disconnect, transcript replay, ordered timeline, real diffs).

## M5 - Handoff mode: continue real Freebuff CLI chats (read + continue built 2026-09-23; see README "Terminal chats")

Goal: the phone lists the chats Siddhant started in his terminal, shows their history, continues any of them, and hands them back so `freebuff --continue <chatId>` picks up the phone's turns.

What the CLI stores (codebuff cli/src/project-files.ts, utils/run-state-storage.ts, utils/chat-meta.ts):
- `<configDir>/projects/<basename(projectRoot)>/chats/<chatId>/` where configDir is `FREEBUFF_CONFIG_DIR` or `~/.config/manicode`, and chatId is an ISO timestamp with `:` replaced by `-`.
- `run-state.json` - the SDK `RunState`, saved about every 5s during a run and at the end.
- `chat-messages.json` - the CLI transcript (`ChatMessage[]`, cli/src/types/chat.ts).
- `chat-meta.json` - `{ messageCount, firstPrompt, messagesSize, messagesMtimeMs }`, tied to the exact size/mtime of chat-messages.json.

Plan:
1. `cliChats.ts`: list chats for a session's project dir (read chat-meta.json, fall back to chat-messages.json when meta is stale), newest first.
2. Protocol: `cli-chats-list`, `cli-chat-open { chatId }` -> transcript replayed as timeline items converted from ChatMessage blocks.
3. Continue: load run-state.json as `previousRun` for the session's CodebuffRuntime. This is the same path `--continue` uses.
4. Write-back after each turn: atomic write of run-state.json, then chat-messages.json (append our turns as CLI ChatMessages), then chat-meta.json with the new size/mtime. Keep the CLI's order so a torn write degrades the way the CLI already handles.
5. Safety: refuse to continue a chat whose run-state.json mtime changed in the last ~10s, or while `freebuff-instance-owner.json` names a live pid, so we never race the terminal CLI. Show "open in terminal" status instead.

Hard requirements:
- Free-mode admission handshake. Free chat requests need a live server slot: POST `/api/v1/freebuff/session/admission`, then send `freebuff_instance_id` through `extraCodebuffMetadata` on every run (cli/src/hooks/use-send-message.ts, use-freebuff-session.ts). The SDK does not do this. Without it the current runtime is likely refused by the real backend. One slot per account: admitting the companion supersedes the terminal CLI (`session_superseded`), and the reverse. Handoff, not live share. This handshake is also a prerequisite for the existing M1-M4 runtime against the real backend.
- Basename-keyed folders. Two projects with the same folder name share `projects/<name>/`. Match chats to a session by checking the project root stored in run-state (fileContext/projectRoot) against the session's projectDir, and hide mismatches.
- Private format. chat-messages.json is CLI-internal and can change between versions. Pin the tested CLI version and fail read-only (history visible, continue disabled) on unknown shapes.

Out of scope for M5: live attach to a running CLI. The CLI has no HTTP/IPC server; the only live option is a tmux-wrapped terminal view (Agent Orchestrator style), tracked separately.

## M6 - One-command self-host setup (built: site/install.sh, site/install.ps1, site/install.md, site/index.html)

Goal: `curl -fsSL <url>/install.sh | sh` (macOS/Linux) or `irm <url>/install.ps1 | iex` (Windows) gets anyone to a working phone URL in about 5 minutes.

Steps the script runs (idempotent, safe to re-run, `--uninstall` reverses):
1. Detect OS/arch/init system (launchd, systemd, Windows).
2. Node >= 20: use the existing one, else install via the OS package manager (brew / apt / dnf / winget).
3. Tailscale: skip if present; else macOS `brew install --cask tailscale` (or the standalone pkg), Linux `curl -fsSL https://tailscale.com/install.sh | sh`, Windows `winget install tailscale.tailscale`.
4. `tailscale up` - prints the login URL. This is the accepted manual step.
5. Freebuff CLI: `npm i -g freebuff` if missing. Check for `credentials.json`; if absent, run `freebuff login`. Note: this is a second browser step for first-time Freebuff users; already-logged-in users skip it.
6. Companion: install the published package (needs an npm release) or clone + `npm ci` + build into `~/.freebuff-remote`. Generate a random token into a 0600 config file.
7. Run as a user service bound to 127.0.0.1:8787 (launchd agent / `systemd --user` / scheduled task), restart on failure.
8. `tailscale serve --bg 8787` for tailnet-only HTTPS. First use on a tailnet may need HTTPS certificates enabled; tailscale prints the admin link. Treat that as part of the Tailscale step.
9. Print the phone URL `https://<machine>.<tailnet>.ts.net` plus a QR code and a 6-digit pairing code.

New companion work this needs:
- Pairing endpoint: short-lived (5 min, single-use) code exchanged for the long-lived token, stored on the phone. Rate-limited.
- `freebuff-remote doctor`: checks tailscale status, serve config, service health, Freebuff login, and prints fixes.

Risks: package-manager differences across Linux distros, Windows service permissions, and the free-mode one-slot rule (tell users the phone and terminal take turns).

### M6 distribution: agent-installable install.md (added 2026-09-23, not built)

The user deploys a small Vercel site. People paste `<site>/install.md` into freebuff (or any coding agent), and the agent does the whole setup. M6 now ships three artifacts:

1. **install.sh / install.ps1**: the scripts above, with a `--yes` non-interactive mode and machine-readable status lines (`STEP <name> OK|FAIL <detail>`) so an agent can follow progress.
2. **install.md**: written for an LLM to execute, not for a human to read:
   - Exact commands per OS, each followed by a verification command and its expected output (for example `node -v` shows >= 20, `tailscale status` exits 0, `curl -s 127.0.0.1:8787/healthz` returns `"ok":true`).
   - Fallback paths for each step (package manager missing, no sudo, Windows without winget, Tailscale already logged in on another account).
   - Which steps need the human (Tailscale login, Freebuff login, HTTPS cert approval), with the exact words to tell them and how to detect that they finished.
   - Stop rules: never paste tokens into chat, never disable a firewall, stop and report on repeated failure.
   - The final message to the human: the phone URL, the pairing code, and the one-slot note (the phone and the terminal take turns).
3. **Landing page**: one page with what it is, the one-line install command, the "paste this into freebuff" line with a copy button, and links to install.md and the repo.

Open questions for the user: the domain, whether install.md is served raw (text/markdown) or also rendered, and whether the scripts are fetched from the site or from GitHub releases (pinned version plus checksum).

## M7 - `pocketbuff` companion CLI (requested 2026-09-23, not built)

The project is now named Pocketbuff. Freebuff itself is a closed binary, so there is no way to add slash commands inside it. Instead, a small companion CLI sits next to it:

- `pocketbuff up --local` starts the phone server bound to localhost/LAN only.
- `pocketbuff up --tailscale` starts it and exposes it on the tailnet with `tailscale serve` (HTTPS, tailnet-only).
- `pocketbuff chats` lists the Freebuff CLI chats for the current project and toggles which ones the phone may see. Opt-in is per chat: a marker file (for example `.pocketbuff`) in the chat folder under `~/.config/manicode/projects/<project>/chats/<chat>/`. The phone's "Terminal chats" list shows only marked chats.

Open questions for the user: whether new chats default to hidden (proposed: hidden until marked), and whether `up` should also print a QR code for the phone URL.
