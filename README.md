# Freebuff Remote Control

M1 spike for controlling a local Freebuff coding-agent runtime from a phone or web browser. It embeds Codebuff's Apache-2.0 SDK, reuses the login created by the Freebuff CLI, and exposes its event/chunk stream over a small WebSocket protocol. It does **not** PTY-wrap the TUI and it does not require a separate paid SDK key.

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

- **Agent and model.** Free mode only admits the CLI's own root agent (`base2-free`) on an allowlisted model. `freebuff-agent.json` is that definition copied verbatim from the codebuff repo (Apache-2.0). Regenerate it with `node scripts/extract-freebuff-agent.mjs /path/to/codebuff`.
- **Session slot.** Before the first run, the companion claims a slot (`POST /api/v1/freebuff/session/admission`). It saves the slot in `~/.config/freebuff-remote/slot.json` and releases it when the server stops.
- **Instance id on every call.** `@codebuff/sdk` 0.10.7 can't send `freebuff_instance_id`, so `npm install` runs `scripts/patch-sdk.mjs` to add it. The server refuses to start with an unpatched SDK.

Settings:

- `FREEBUFF_MODEL` (default `mimo/mimo-v2.5`). Supported values: `mimo/mimo-v2.5`, `z-ai/glm-5.3-flash`, `upstage/solar-pro4`, `crof/kimi-k3-eco`, `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro`, `openai/gpt-5.6-luna`.
- `FREEBUFF_ALLOW_FREEBUCKS=1` lets the companion claim a model that costs Freebucks. By default it only claims zero-cost models and tells you which ones are available.

Freebuff gives one slot per account. While the companion holds it, your desktop `freebuff` CLI can't run at the same time, and vice versa.
