# Pocketbuff (freebuff-remote-control)

M1 spike for controlling a local Freebuff coding-agent runtime from a phone or web browser. It embeds Codebuff's Apache-2.0 SDK, reuses the login created by the Freebuff CLI, and exposes its event/chunk stream over a small WebSocket protocol. It does **not** PTY-wrap the TUI and it does not require a separate paid SDK key.

## Install (one link)

Paste this into Freebuff on the computer you want to control, and it does the setup:

```
Read https://<your-site>/install.md and follow it
```

Or run the installer yourself: `curl -fsSL https://<your-site>/install.sh | bash -s -- --yes`. The `site/` folder is the whole website (static, deploy it to Vercel as is). Afterwards: `bash ~/.pocketbuff/install.sh doctor | pair | uninstall`.

### Deploy the site (Vercel CLI + GitHub Actions)

`site/` is deployed by `.github/workflows/deploy-site.yml` on every push to `main` that touches `site/**`. You can also run it by hand from the Actions tab (Vercel Production Deployment > Run workflow).

Why this route: Vercel's free Hobby plan doesn't let several people deploy to one project (collaborators are a paid Team feature). A token plus GitHub Actions lets any push to `main` deploy without anyone joining a Vercel team.

> Do **not** import or connect this repo in the Vercel dashboard. The Vercel Git integration must stay off; GitHub Actions does the deploys.

One-time setup (about 2 minutes):

1. **Token:** create one at https://vercel.com/account/tokens and copy it.
2. **Login:** `npm i -g vercel` then `vercel login`.
3. **Link:** from the repo root, `cd site && vercel project add pocketbuff && vercel link --yes --project pocketbuff && cd ..` (skip `project add` if the project already exists). This creates `site/.vercel/project.json` (git-ignored) with `orgId` and `projectId`.
4. **Secrets:**
   ```sh
   gh secret set VERCEL_TOKEN --repo SIDDHANTCOOKIE/freebuff-remote-control        # paste the token when asked
   gh secret set VERCEL_ORG_ID --repo SIDDHANTCOOKIE/freebuff-remote-control --body "$(jq -r .orgId site/.vercel/project.json)"
   gh secret set VERCEL_PROJECT_ID --repo SIDDHANTCOOKIE/freebuff-remote-control --body "$(jq -r .projectId site/.vercel/project.json)"
   ```
5. **Deploy:** push to `main` (or run the workflow once by hand). The run summary shows the production URL.

Manual alternative, without Actions: `bash scripts/deploy-site.sh`. It links on the first run and then runs `vercel deploy --prod`. It uses `VERCEL_TOKEN` when set (fully unattended), otherwise your `vercel login` session.

## What M1 includes

- Bun/TypeScript-friendly companion server (also runs on Node 22)
- `@codebuff/sdk` runtime in `costMode: "free"`
- Freebuff CLI credential reuse from `~/.config/manicode/credentials.json`
- one conversation with `previousRun` state carried between turns
- streamed SDK chunks and structured events over WebSocket
- shared-token gate suitable for a private Tailscale network
- minimal mobile chat UI
- mock runtime and end-to-end WebSocket tests

The transport deliberately keeps SDK events as structured objects rather than flattening them into terminal text. M2 can render tool calls/diffs and insert approval requests; a session manager can be added above the `ChatRuntime` boundary for M4 without changing the wire transport or browser connection model.

## Requirements

- Node 22+ or Bun 1.3+
- Freebuff installed and logged in on this machine
- a project directory for the agent to work in

## Setup

```bash
git clone https://github.com/SIDDHANTCOOKIE/freebuff-remote-control.git
cd freebuff-remote-control
npm install
npm run build

# Generate once and save it in your password manager.
export FREEBUFF_REMOTE_TOKEN="$(openssl rand -hex 24)"
export FREEBUFF_PROJECT_DIR=/absolute/path/to/the/project
npm start
```

Open `http://127.0.0.1:8787/#token=$FREEBUFF_REMOTE_TOKEN` locally. The browser stores the token in local storage after the first successful URL. The WebSocket refuses missing or incorrect tokens when `FREEBUFF_REMOTE_TOKEN` is set.

For a mock smoke test that does not contact Codebuff:

```bash
FREEBUFF_REMOTE_MOCK=1 npm start
curl http://127.0.0.1:8787/healthz
```

## Tailscale (M1 manual setup)

Keep the server bound to localhost and proxy it through Tailscale Serve:

```bash
tailscale serve --bg http://127.0.0.1:8787
```

Then open the HTTPS URL printed by Tailscale on the phone and append `#token=...` once. Do not expose port 8787 directly to the public internet. M3 will add installable-PWA assets and guided Tailscale setup.

## Commands

```bash
npm run dev    # restart server on source changes
npm run build  # Vite production build + TypeScript check
npm test       # auth and real WebSocket loop tests
npm run check  # build and tests
```

## Architecture

```text
mobile browser
  React chat UI
      │ WebSocket (/ws, shared token)
      ▼
companion server
  connection + run coordinator
      │ ChatRuntime interface
      ▼
CodebuffRuntime
  @codebuff/sdk CodebuffClient
  agent: base, costMode: free
  previousRun conversation state
      │
      ▼
Codebuff/Freebuff backend + local SDK tools
```

`protocol.ts` is the version-zero event boundary. M2 should add typed tool-call, diff, approval-request, and approval-response messages while retaining raw SDK events for forward compatibility. M4 should add explicit `sessionId` fields and a `SessionManager` with one runtime/state/abort controller per project session.

## Known M1 limits

- one active run and one in-memory conversation per server process
- no cancel/steer control yet
- raw tool events are transported but not rendered as cards
- no approve/deny gate yet
- no persisted session list
- PWA manifest/offline shell and Tailscale onboarding are deferred to M3

## M2 direction

1. Map SDK tool-call/tool-result events into stable cards.
2. Add a policy layer that pauses sensitive tools and emits an approval request.
3. Add approve/deny and cancel messages to the WebSocket protocol.
4. Persist run state after every completed turn and on safe checkpoints.
5. Add integration tests for approved, denied, cancelled, and disconnected runs.

## Security notes

- The companion reads the existing local Freebuff bearer token. It never sends that token to the browser.
- Bind to `127.0.0.1` by default. Use Tailscale Serve for phone access.
- Always set a long random `FREEBUFF_REMOTE_TOKEN` before remote use.
- The shared token is an M1 bridge, not the final identity/session design.

## M3/M4 status

- installable PWA manifest, icon, service worker, offline shell fallback
- touch-first mobile layout, Enter-to-send, auto-scroll, horizontal session switcher
- Tailscale path remains localhost-only: `tailscale serve --bg http://127.0.0.1:8787`; validate with `tailscale serve status` and open its HTTPS URL on the phone
- persisted multi-session registry with one independent runtime/checkpoint/approval/cancel context per project
- session create/select/delete protocol; the server allows runs in different sessions at the same time, but Freebuff free mode gives one active slot per account, so with the real runtime a second concurrent run may wait or be refused by the backend

The automated environment used for this spike does not have a Tailscale daemon, so the Serve command itself is documented and structurally compatible but must be run and verified on the user's dev machine.

## Freebuff free mode

The companion runs on your existing Freebuff login (`~/.config/manicode/credentials.json`) with no paid key. Free mode has three requirements, and the companion handles all of them:

- **Agent and model.** Free mode only admits the CLI's own root agent for the admitted model (the current CLI uses `base3-free-*` roots, for example `base3-free-glm-5-3-flash`). `freebuff-agents.json` holds those definitions, keyed by model and copied verbatim from the codebuff repo (Apache-2.0). Regenerate it with `node scripts/extract-freebuff-agent.mjs /path/to/codebuff`.
- **Session slot.** Before the first run, the companion claims a slot (`POST /api/v1/freebuff/session/admission`). It saves the slot in `~/.config/freebuff-remote/slot.json` and releases it when the server stops.
- **Instance id on every call.** `@codebuff/sdk` 0.10.7 can't send `freebuff_instance_id`, so `npm install` runs `scripts/patch-sdk.mjs` to add it. The server refuses to start with an unpatched SDK.

Settings:

- `FREEBUFF_MODEL` (default `z-ai/glm-5.3-flash`, which costs 0 Freebucks). Supported values: `z-ai/glm-5.3-flash`, `mimo/mimo-v2.5`, `upstage/solar-pro4`, `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro`, `openai/gpt-5.6-luna`.
- `FREEBUFF_ALLOW_FREEBUCKS=1` lets the companion claim a model that costs Freebucks. By default it only claims zero-cost models and tells you which ones are available.

Freebuff gives one slot per account. While the companion holds it, your desktop `freebuff` CLI can't run at the same time, and vice versa. Stop the companion (Ctrl-C) before going back to the terminal; it gives the slot back on exit, even with a phone still connected.

## Terminal chats (M5): continue a CLI chat on your phone

Tap **Terminal chats** to list the Freebuff CLI chats for the session's project (from `~/.config/manicode/projects/<project folder name>/chats/`, or `FREEBUFF_CONFIG_DIR`). Opening one shows its transcript. Messages you send then continue that chat: the companion loads the CLI's saved `run-state.json` as the previous run, and after each turn it writes `run-state.json`, `chat-messages.json` and `chat-meta.json` back in the CLI's format. **Detach** goes back to the phone's own session.

Back at the desk, run `freebuff --continue <chat id>` (the id is shown in the banner on the phone). The CLI shows the phone's turns and the model remembers them.

Two things are adjusted when loading a CLI run state, because `@codebuff/sdk` 0.10.7 is older than the CLI:

- The CLI saves every bundled agent template in the run state, and the backend rejects them when they're sent back. The companion sends only the root agent; the CLI adds its own again on its next run.
- Newer CLIs store `gitChanges` as a repository summary that the SDK's prompt builder can't read, so it is dropped.

Stop the CLI before continuing a chat on the phone, and stop the companion before `freebuff --continue`: only one of them can hold the Freebuff slot. If the CLI shows "Take over", choosing it restarts the CLI without your `--continue` argument, so run the command again.
