#!/usr/bin/env bash
# Pocketbuff installer: runs Freebuff from your phone over your own Tailscale network.
#
#   curl -fsSL https://<site>/install.sh | bash -s -- --yes
#
# Commands:  install (default) | doctor | pair | uninstall
# Flags:     --yes            never ask; install what is missing
#            --project DIR    folder the phone starts in (default: current folder)
#            --port N         local port (default 8787, next free one if taken)
# Output:    one line per step, "STEP <name> OK|FAIL|HUMAN <detail>", then a summary block.
# Exit:      0 done, 1 failed, 10 waiting on the human (do the HUMAN step, then run the same command again).
# Safe to re-run: every step checks first and only changes what is missing.
set -uo pipefail

REPO="${POCKETBUFF_REPO:-SIDDHANTCOOKIE/freebuff-remote-control}"
REF="${POCKETBUFF_REF:-main}"
SOURCE="${POCKETBUFF_SOURCE:-}"               # local checkout, for development
HOME_DIR="${POCKETBUFF_HOME:-$HOME/.pocketbuff}"
STATE_DIR="$HOME/.config/freebuff-remote"
FREEBUFF_DIR="${FREEBUFF_CONFIG_DIR:-$HOME/.config/manicode}"
NODE_MAJOR=22
LABEL="dev.pocketbuff.agent"
APP="$HOME_DIR/app"; CONFIG="$HOME_DIR/config.env"; LOGS="$HOME_DIR/logs"

cmd=install; yes=0; project=""; port=""
while [ $# -gt 0 ]; do
  case "$1" in
    install|doctor|pair|uninstall) cmd="$1" ;;
    --uninstall) cmd=uninstall ;;
    --yes|-y) yes=1 ;;
    --project) project="${2:-}"; shift ;;
    --port) port="${2:-}"; shift ;;
    -h|--help) sed -n '2,13p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1 (try --help)" >&2; exit 1 ;;
  esac
  shift
done

human=0; failed=0
ok()    { echo "STEP $1 OK ${2:-}"; }
fail()  { echo "STEP $1 FAIL ${2:-}"; failed=1; }
ask()   { echo "STEP $1 HUMAN ${2:-}"; human=1; }
have()  { command -v "$1" >/dev/null 2>&1; }
finish() { if [ "$failed" = 1 ]; then exit 1; elif [ "$human" = 1 ]; then echo "WAITING Do the HUMAN step above, then run the same command again."; exit 10; fi; }
confirm() { [ "$yes" = 1 ] && return 0; [ -t 0 ] || [ -e /dev/tty ] || return 1; printf '%s [y/N] ' "$1" > /dev/tty; read -r a < /dev/tty; [ "$a" = y ] || [ "$a" = Y ]; }
can_sudo() { [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; }
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }
sha256() { if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# timeout(1) is not on stock macOS: run in the background and kill it after N seconds.
with_timeout() { local n="$1"; shift; "$@" & local pid=$!; ( sleep "$n"; kill "$pid" 2>/dev/null ) & local guard=$!; wait "$pid" 2>/dev/null; local rc=$?; kill "$guard" 2>/dev/null; return $rc; }
conf_get() { [ -f "$CONFIG" ] && sed -n "s/^$1=//p" "$CONFIG" | tail -1; }

# ---------- platform ----------
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "STEP platform FAIL $os is not supported by install.sh (Windows: use WSL for now)"; exit 1 ;; esac
case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "STEP platform FAIL CPU $arch is not supported"; exit 1 ;; esac

# ---------- node ----------
node_bin=""
find_node() {
  for n in "$HOME_DIR/node/bin/node" "$(command -v node 2>/dev/null)"; do
    [ -n "$n" ] && [ -x "$n" ] || continue
    major="$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -ge 20 ] 2>/dev/null; then node_bin="$n"; return 0; fi
  done
  return 1
}
step_node() {
  if find_node; then ok node "$("$node_bin" -v) at $node_bin"; return; fi
  # A private copy under ~/.pocketbuff: no sudo, no package manager, nothing else on the machine changes.
  local base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x" tmp; tmp="$(mktemp -d)"
  local file; file="$(curl -fsSL "$base/SHASUMS256.txt" 2>/dev/null | awk '{print $2}' | grep -E "^node-v[0-9.]+-$os-$arch\.tar\.gz$" | head -1)"
  if [ -z "$file" ]; then fail node "could not reach nodejs.org to download Node $NODE_MAJOR"; return; fi
  if ! curl -fsSL "$base/$file" -o "$tmp/$file"; then fail node "download of $file failed"; return; fi
  if [ "$(sha256 "$tmp/$file")" != "$(curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | cut -d' ' -f1)" ]; then fail node "checksum mismatch for $file"; return; fi
  rm -rf "$HOME_DIR/node" && mkdir -p "$HOME_DIR/node" && tar -xzf "$tmp/$file" -C "$HOME_DIR/node" --strip-components=1
  rm -rf "$tmp"
  if find_node; then ok node "installed $("$node_bin" -v) at $node_bin"; else fail node "Node unpacked but does not run"; fi
}

# ---------- app ----------
step_app() {
  [ -n "$node_bin" ] || { fail app "needs Node"; return; }
  export PATH="$(dirname "$node_bin"):$PATH"
  local want="" have_ref=""
  if [ -z "$SOURCE" ]; then
    want="$(curl -fsSL -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$REPO/commits/$REF" 2>/dev/null || true)"
    have_ref="$(cat "$APP/.pocketbuff-ref" 2>/dev/null || true)"
    if [ -n "$want" ] && [ "$want" = "$have_ref" ] && [ -f "$APP/dist/client/index.html" ]; then ok app "up to date (${want:0:7})"; return; fi
  fi
  local next="$HOME_DIR/app.next"; rm -rf "$next"; mkdir -p "$next"
  if [ -n "$SOURCE" ]; then
    (cd "$SOURCE" && tar --exclude=node_modules --exclude=dist --exclude=.git -cf - .) | tar -xf - -C "$next" || { fail app "could not copy $SOURCE"; return; }
  else
    curl -fsSL "https://codeload.github.com/$REPO/tar.gz/${want:-$REF}" | tar -xzf - -C "$next" --strip-components=1 || { fail app "download from github.com/$REPO failed"; return; }
  fi
  if ! (cd "$next" && npm ci --no-audit --no-fund --loglevel=error > "$HOME_DIR/npm.log" 2>&1 && npx vite build >> "$HOME_DIR/npm.log" 2>&1); then fail app "npm install/build failed, see $HOME_DIR/npm.log"; return; fi
  [ -n "$want" ] && echo "$want" > "$next/.pocketbuff-ref"
  rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"; mv "$next" "$APP"; rm -rf "$APP.old"
  cp "$APP/site/install.sh" "$HOME_DIR/install.sh" 2>/dev/null && chmod +x "$HOME_DIR/install.sh"
  ok app "installed ${want:+${want:0:7} }at $APP"
}

# ---------- config ----------
port_free() { "$node_bin" -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(+process.argv[1],"127.0.0.1",()=>s.close(()=>process.exit(0)))' "$1"; }
is_ours() { curl -fsS -m 2 "http://127.0.0.1:$1/healthz" 2>/dev/null | grep -q '"runtime"'; }
step_config() {
  mkdir -p "$HOME_DIR" "$LOGS"; chmod 700 "$HOME_DIR"
  local token dir p
  token="$(conf_get FREEBUFF_REMOTE_TOKEN)"; [ -n "$token" ] || token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  dir="${project:-$(conf_get FREEBUFF_PROJECT_DIR)}"; dir="${dir:-$PWD}"
  [ -d "$dir" ] || { fail config "project folder $dir does not exist"; return; }
  dir="$(cd "$dir" && pwd)"
  p="${port:-$(conf_get PORT)}"; p="${p:-8787}"
  if [ -z "$port" ]; then
    local tries=0
    until is_ours "$p" || port_free "$p"; do p=$((p + 1)); tries=$((tries + 1)); [ $tries -lt 20 ] || { fail config "no free port from 8787 up"; return; }; done
  fi
  umask 077
  printf 'FREEBUFF_REMOTE_TOKEN=%s\nHOST=127.0.0.1\nPORT=%s\nFREEBUFF_PROJECT_DIR=%s\n' "$token" "$p" "$dir" > "$CONFIG"
  chmod 600 "$CONFIG"
  cat > "$HOME_DIR/run.sh" <<RUN
#!/usr/bin/env bash
set -a; . "$CONFIG"; set +a
cd "$APP" && exec "$node_bin" node_modules/tsx/dist/cli.mjs server.ts
RUN
  chmod 700 "$HOME_DIR/run.sh"
  ok config "port $p, project $dir, token saved in $CONFIG (never share it)"
}

# ---------- service ----------
service_kind() {
  if [ "$os" = darwin ]; then echo launchd
  elif have systemctl && systemctl --user show-environment >/dev/null 2>&1; then echo systemd
  else echo background; fi
}
healthy() { curl -fsS -m 2 "http://127.0.0.1:$(conf_get PORT)/healthz" 2>/dev/null | grep -q '"ok":true'; }
stop_service() {
  case "$(service_kind)" in
    launchd) launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" ;;
    systemd) systemctl --user disable --now pocketbuff.service 2>/dev/null; rm -f "$HOME/.config/systemd/user/pocketbuff.service"; systemctl --user daemon-reload 2>/dev/null ;;
  esac
  if [ -f "$HOME_DIR/pid" ]; then kill "$(cat "$HOME_DIR/pid")" 2>/dev/null; rm -f "$HOME_DIR/pid"; fi
  true
}
step_service() {
  local kind; kind="$(service_kind)"
  case "$kind" in
    launchd)
      mkdir -p "$HOME/Library/LaunchAgents"
      cat > "$HOME/Library/LaunchAgents/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$HOME_DIR/run.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/pocketbuff.log</string>
  <key>StandardErrorPath</key><string>$LOGS/pocketbuff.log</string>
</dict></plist>
PLIST
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
      launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LABEL.plist" ;;
    systemd)
      mkdir -p "$HOME/.config/systemd/user"
      cat > "$HOME/.config/systemd/user/pocketbuff.service" <<UNIT
[Unit]
Description=Pocketbuff (Freebuff remote control)
After=network-online.target

[Service]
ExecStart=$HOME_DIR/run.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
      systemctl --user daemon-reload && systemctl --user enable pocketbuff.service >/dev/null 2>&1 && systemctl --user restart pocketbuff.service
      loginctl enable-linger "$(id -un)" 2>/dev/null || true ;;
    background)
      if [ -f "$HOME_DIR/pid" ]; then kill "$(cat "$HOME_DIR/pid")" 2>/dev/null; sleep 1; fi
      nohup "$HOME_DIR/run.sh" >> "$LOGS/pocketbuff.log" 2>&1 &
      echo $! > "$HOME_DIR/pid" ;;
  esac
  for _ in $(seq 1 30); do healthy && break; sleep 1; done
  if healthy; then
    local note=""; [ "$kind" = background ] && note=" (no service manager found: runs until reboot; re-run install after a restart)"
    ok service "$kind, http://127.0.0.1:$(conf_get PORT)/healthz ok$note"
  else fail service "$kind did not come up, last log lines: $(tail -3 "$LOGS/pocketbuff.log" 2>/dev/null | tr '\n' ' ')"; fi
}

# ---------- freebuff login ----------
step_freebuff() {
  if grep -q '"authToken"' "$FREEBUFF_DIR/credentials.json" 2>/dev/null; then ok freebuff-login "logged in ($FREEBUFF_DIR/credentials.json)"
  else ask freebuff-login "Freebuff is not logged in on this computer. Ask the human to run: freebuff  (in any terminal) and finish the login in the browser."; fi
}

# ---------- tailscale ----------
ts=""
find_ts() {
  for t in "$(command -v tailscale 2>/dev/null)" /Applications/Tailscale.app/Contents/MacOS/Tailscale; do [ -n "$t" ] && [ -x "$t" ] && { ts="$t"; return 0; }; done
  return 1
}
ts_state() { "$ts" status --json 2>/dev/null | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log([j.BackendState||"",(j.Self&&j.Self.DNSName||"").replace(/\.$/,""),j.AuthURL||""].join(" "))}catch{console.log("NoState")}})'; }
step_tailscale() {
  if ! find_ts; then
    if [ "$os" = darwin ]; then
      if have brew && confirm "Install Tailscale with Homebrew?"; then brew install --cask tailscale >/dev/null 2>&1; fi
      if find_ts; then ask tailscale "Tailscale is installed. Ask the human to open Tailscale from Applications, allow it, and sign in (same account as on their phone)."
      else ask tailscale "Ask the human to install Tailscale from https://tailscale.com/download/mac , open it, and sign in (same account as on their phone)."; fi
      return
    fi
    if can_sudo && confirm "Install Tailscale (needs root)?"; then curl -fsSL https://tailscale.com/install.sh | as_root sh >/dev/null 2>&1; fi
    if ! find_ts; then ask tailscale "Ask the human to paste this into a terminal (it asks for their password once): curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --operator=\$USER"; return; fi
  fi
  local state dns url; read -r state dns url <<< "$(ts_state)"
  if [ "$state" = Running ]; then ok tailscale "signed in as $dns"; return; fi
  # Start the login without blocking and hand the human the one link it produces.
  if [ "$os" = linux ] && [ "$(id -u)" != 0 ]; then
    if can_sudo; then (as_root "$ts" up --operator="$(id -un)" --timeout=60s >/dev/null 2>&1 &)
    else ask tailscale "Ask the human to paste this into a terminal and sign in at the link it prints: sudo tailscale up --operator=\$USER"; return; fi
  else ("$ts" up --timeout=60s >/dev/null 2>&1 &); fi
  for _ in $(seq 1 15); do read -r state dns url <<< "$(ts_state)"; [ -n "$url" ] || [ "$state" = Running ] && break; sleep 1; done
  if [ "$state" = Running ]; then ok tailscale "signed in as $dns"
  elif [ -n "$url" ]; then ask tailscale "Ask the human to open $url and sign in to Tailscale (same account as on their phone)."
  else fail tailscale "tailscale did not start (state: ${state:-unknown}). Try: $ts up"; fi
}

step_serve() {
  local state dns url out p; read -r state dns url <<< "$(ts_state)"; p="$(conf_get PORT)"
  [ "$state" = Running ] || return
  if "$ts" serve status 2>/dev/null | grep -q "127.0.0.1:$p"; then ok serve "https://$dns/"; return; fi
  # Output goes to a file, not $(...): a killed serve can leave children holding the pipe open.
  with_timeout 10 "$ts" serve --bg --https=443 "http://127.0.0.1:$p" > "$HOME_DIR/serve.out" 2>&1; out="$(cat "$HOME_DIR/serve.out")"; rm -f "$HOME_DIR/serve.out"
  if "$ts" serve status 2>/dev/null | grep -q "127.0.0.1:$p"; then ok serve "https://$dns/"; return; fi
  url="$(printf '%s' "$out" | grep -oE 'https://login\.tailscale\.com/[^ ]+' | head -1)"
  if [ -n "$url" ]; then ask serve "Ask the human to open $url and turn on HTTPS for their tailnet (one click)."
  elif printf '%s' "$out" | grep -qi 'access denied\|permission\|operator'; then ask serve "Ask the human to paste this into a terminal: sudo tailscale set --operator=\$USER"
  else fail serve "tailscale serve failed: $(printf '%s' "$out" | head -2 | tr '\n' ' ')"; fi
}

# ---------- pair ----------
pair_code() { (set -a; . "$CONFIG"; set +a; cd "$APP" && "$node_bin" node_modules/tsx/dist/cli.mjs pair.ts) | sed -n 's/^CODE //p'; }
summary() {
  local state dns url code; read -r state dns url <<< "$(ts_state)"; code="$(pair_code)"
  [ -n "$code" ] || { fail pair "could not create a pairing code"; return; }
  ok pair "code $code, valid for 10 minutes, single use"
  echo "DONE"
  echo "PHONE_URL https://$dns/"
  echo "PAIR_URL https://$dns/#pair=$code"
  echo "PAIR_CODE $code"
  echo "NOTE The phone needs the Tailscale app, signed in to the same account."
  echo "NOTE Free mode has one slot: the phone and the terminal take turns."
  echo "NOTE New code any time: bash $HOME_DIR/install.sh pair"
}

# ---------- commands ----------
case "$cmd" in
  install)
    ok platform "$os-$arch, service: $(service_kind)"
    step_node; [ "$failed" = 1 ] && finish
    step_app; [ "$failed" = 1 ] && finish
    step_config; [ "$failed" = 1 ] && finish
    step_service; [ "$failed" = 1 ] && finish
    step_freebuff
    step_tailscale
    [ "$human" = 0 ] && [ "$failed" = 0 ] && step_serve
    [ "$human" = 0 ] && [ "$failed" = 0 ] && summary
    finish ;;
  pair)
    find_node && find_ts && [ -f "$CONFIG" ] || { echo "STEP pair FAIL Pocketbuff is not installed yet; run install first"; exit 1; }
    summary; finish ;;
  doctor)
    ok platform "$os-$arch, service: $(service_kind)"
    if find_node; then ok node "$("$node_bin" -v)"; else fail node "Node >= 20 not found. Fix: run install"; fi
    if [ -f "$APP/dist/client/index.html" ]; then ok app "$APP${SOURCE:+ (local)} $(cut -c1-7 "$APP/.pocketbuff-ref" 2>/dev/null)"; else fail app "not installed. Fix: run install"; fi
    if [ -f "$CONFIG" ]; then ok config "port $(conf_get PORT), project $(conf_get FREEBUFF_PROJECT_DIR)"; else fail config "missing. Fix: run install"; fi
    if [ -f "$CONFIG" ] && healthy; then ok service "$(service_kind) running"; else fail service "not answering on 127.0.0.1:$(conf_get PORT). Fix: run install; log: $LOGS/pocketbuff.log"; fi
    step_freebuff
    if find_ts; then
      read -r state dns url <<< "$(ts_state)"
      if [ "$state" = Running ]; then ok tailscale "signed in as $dns"
        if "$ts" serve status 2>/dev/null | grep -q "127.0.0.1:$(conf_get PORT)"; then ok serve "https://$dns/"; else fail serve "not serving the app. Fix: run install"; fi
      else fail tailscale "state ${state:-unknown}. Fix: run install"; fi
    else fail tailscale "not installed. Fix: run install"; fi
    [ "$failed" = 0 ] && [ "$human" = 0 ] && echo "HEALTHY"
    finish ;;
  uninstall)
    stop_service; ok service "stopped and removed"
    if find_ts && [ -f "$CONFIG" ] && "$ts" serve status 2>/dev/null | grep -q "127.0.0.1:$(conf_get PORT)"; then "$ts" serve --https=443 off >/dev/null 2>&1; ok serve "tailscale serve for Pocketbuff turned off"; else ok serve "nothing to turn off"; fi
    rm -rf "$HOME_DIR" "$STATE_DIR"; ok files "removed $HOME_DIR and $STATE_DIR"
    echo "DONE Pocketbuff removed. Node, Tailscale and Freebuff were left installed."
    exit 0 ;;
esac
