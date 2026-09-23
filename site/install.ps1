# Pocketbuff installer for Windows: runs Freebuff from your phone over your own Tailscale network.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 --yes
#   (fetch first: irm https://<site>/install.ps1 -OutFile install.ps1)
#
# Commands:  install (default) | doctor | pair | uninstall
# Flags:     --yes            never ask; install what is missing
#            --project DIR    folder the phone starts in (default: current folder)
#            --port N         local port (default 8787, next free one if taken)
# Output:    one line per step, "STEP <name> OK|FAIL|HUMAN <detail>", then a summary block.
# Exit:      0 done, 1 failed, 10 waiting on the human (do the HUMAN step, then run the same command again).
# Safe to re-run: every step checks first and only changes what is missing.
#
# Validation status (2026-09-24): parsed and executed with PowerShell 7.6 on Linux. Proven there:
# argument handling, STEP output, exit codes, token/config/port logic, the Node download +
# checksum path, the app build, the background service fallback and the health check,
# pairing-code generation, an idempotent second run, and uninstall. Not yet run on a real
# Windows machine: winget installs, the scheduled task, Tailscale for Windows, and the
# config-file ACL. Those are written to spec; the first real Windows run is their test.
# Compatible with Windows PowerShell 5.1 and PowerShell 7+.
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string]$Command = 'install',
  [Alias('y')] [switch]$Yes,
  [switch]$Uninstall,
  [string]$Project,
  [int]$Port = 0,
  [Alias('h')] [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Yes = [bool]$Yes
if ($Uninstall) { $Command = 'uninstall' }

$Repo     = if ($env:POCKETBUFF_REPO)   { $env:POCKETBUFF_REPO }   else { 'SIDDHANTCOOKIE/freebuff-remote-control' }
$Ref      = if ($env:POCKETBUFF_REF)    { $env:POCKETBUFF_REF }    else { 'main' }
$Source   = $env:POCKETBUFF_SOURCE               # local checkout, for development
$HomeDir  = if ($env:POCKETBUFF_HOME)   { $env:POCKETBUFF_HOME }   else { Join-Path $HOME '.pocketbuff' }
$StateDir = Join-Path $HOME '.config/freebuff-remote'
$FreebuffDir = if ($env:FREEBUFF_CONFIG_DIR) { $env:FREEBUFF_CONFIG_DIR } else { Join-Path $HOME '.config/manicode' }
$NodeMajor = 22
$TaskName  = 'Pocketbuff'
$App    = Join-Path $HomeDir 'app'
$Config = Join-Path $HomeDir 'config.env'
$Logs   = Join-Path $HomeDir 'logs'

# Windows under any PowerShell edition; overridable for development/testing only.
$script:Platform = if ($env:POCKETBUFF_PLATFORM) { $env:POCKETBUFF_PLATFORM } `
  elseif ($PSVersionTable.PSEdition -eq 'Desktop') { 'windows' } `
  elseif ($IsWindows) { 'windows' } `
  elseif ($IsMacOS) { 'darwin' } else { 'linux' }

$script:human = 0; $script:failed = 0
function Step-OK   ([string]$n, [string]$d = '') { Write-Output "STEP $n OK $d" }
function Step-Fail ([string]$n, [string]$d = '') { Write-Output "STEP $n FAIL $d"; $script:failed = 1 }
function Step-Ask  ([string]$n, [string]$d = '') { Write-Output "STEP $n HUMAN $d"; $script:human = 1 }
function Finish {
  if ($script:failed -eq 1) { exit 1 }
  elseif ($script:human -eq 1) { Write-Output 'WAITING Do the HUMAN step above, then run the same command again.'; exit 10 }
}
function Confirm-Step ([string]$prompt) {
  if ($script:Yes) { return $true }
  if (-not [Environment]::UserInteractive) { return $false }
  try { $a = Read-Host "$prompt [y/N]"; return ($a -eq 'y' -or $a -eq 'Y') } catch { return $false }
}
function Test-Have ([string]$c) { return [bool](Get-Command $c -ErrorAction SilentlyContinue) }
# Start-Process -WindowStyle only exists on Windows; elsewhere the process is already hidden from the user.
function Start-Hidden ([string]$file, [string[]]$argList, [hashtable]$extra = @{}) {
  $sp = @{ FilePath = $file; PassThru = $true } + $extra
  if ($argList) { $sp.ArgumentList = $argList }
  if ($script:Platform -eq 'windows') { $sp.WindowStyle = 'Hidden' }
  return Start-Process @sp
}
function Get-Sha256 ([string]$f) { return (Get-FileHash -Algorithm SHA256 -Path $f).Hash.ToLower() }
function Conf-Get ([string]$key) {
  if (-not (Test-Path $Config)) { return $null }
  $m = Get-Content $Config | Where-Object { $_ -match "^$key=" } | Select-Object -Last 1
  if ($m) { return ($m -replace "^$key=", '') } else { return $null }
}
# Run an external command with a timeout, output to a file (never $(...): a killed child can hold the pipe open).
function Invoke-WithTimeout ([int]$seconds, [string]$file, [string[]]$argList, [string]$outFile) {
  $p = Start-Process -FilePath $file -ArgumentList $argList -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError "$outFile.err"
  if (-not $p.WaitForExit($seconds * 1000)) { try { $p.Kill() } catch {} }
  $err = Get-Content "$outFile.err" -Raw -ErrorAction SilentlyContinue
  Remove-Item "$outFile.err" -ErrorAction SilentlyContinue
  if ($err) { Add-Content $outFile $err }
}

# ---------- platform ----------
function Get-Arch {
  $a = if ($script:Platform -eq 'windows') { $env:PROCESSOR_ARCHITECTURE } else { [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
  switch -Regex ($a) { '^(AMD64|X64|x86_64)$' { 'x64'; return } '^(ARM64|arm64|aarch64)$' { 'arm64'; return } default { $null; return } }
}

# ---------- node ----------
$script:NodeBin = $null
function Find-Node {
  $candidates = @((Join-Path $HomeDir 'node/node.exe'), (Join-Path $HomeDir 'node/bin/node'))
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  foreach ($n in $candidates) {
    if (-not $n -or -not (Test-Path $n)) { continue }
    $major = 0
    try { $major = [int](& $n -p 'process.versions.node.split(".")[0]' 2>$null) } catch { continue }
    if ($major -ge 20) { $script:NodeBin = $n; return $true }
  }
  return $false
}
function Update-PathFromRegistry {
  if ($script:Platform -ne 'windows') { return }
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine'); $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$m;$u"
}
function Step-Node {
  if (Find-Node) { Step-OK node "$(& $script:NodeBin -v) at $($script:NodeBin)"; return }
  $arch = Get-Arch
  if ($script:Platform -eq 'windows' -and (Test-Have winget) -and (Confirm-Step 'Install Node.js LTS with winget?')) {
    Invoke-WithTimeout 600 winget @('install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements') (Join-Path $HomeDir 'winget-node.out')
    Update-PathFromRegistry
    if (Find-Node) { Step-OK node "installed $(& $script:NodeBin -v) with winget"; return }
  }
  # A private copy under ~/.pocketbuff: no admin, nothing else on the machine changes.
  if (-not $arch) { Step-Fail node "CPU architecture is not supported"; return }
  $base = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("pocketbuff-node-" + [Guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content
    $file = ($sums -split "`n" | Where-Object { $_ -match "node-v[0-9.]+-win-$arch\.zip$" } | Select-Object -First 1) -replace '.*\s', ''
    if (-not $file) { Step-Fail node "could not find a Windows Node $NodeMajor download on nodejs.org"; return }
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile (Join-Path $tmp $file)
    $want = (($sums -split "`n" | Where-Object { $_ -match " $file$" } | Select-Object -First 1) -split '\s+')[0].ToLower()
    if ((Get-Sha256 (Join-Path $tmp $file)) -ne $want) { Step-Fail node "checksum mismatch for $file"; return }
    $extract = Join-Path $tmp 'x'; Expand-Archive -Path (Join-Path $tmp $file) -DestinationPath $extract
    $inner = Get-ChildItem $extract | Select-Object -First 1
    if (-not $inner) { Step-Fail node "download of Node $NodeMajor failed: empty archive"; return }
    New-Item -ItemType Directory -Path $HomeDir -Force | Out-Null
    Remove-Item -Recurse -Force (Join-Path $HomeDir 'node') -ErrorAction SilentlyContinue
    Move-Item $inner.FullName (Join-Path $HomeDir 'node')
  } catch { Step-Fail node "download of Node $NodeMajor failed: $($_.Exception.Message)"; return }
  finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
  if (Find-Node) { Step-OK node "installed $(& $script:NodeBin -v) at $($script:NodeBin)" } else { Step-Fail node 'Node unpacked but does not run' }
}

# ---------- app ----------
function Step-App {
  if (-not $script:NodeBin) { Step-Fail app 'needs Node'; return }
  $env:Path = "$(Split-Path $script:NodeBin)$([IO.Path]::PathSeparator)$env:Path"
  $want = $null; $haveRef = $null
  if (-not $Source) {
    try {
      $raw = (Invoke-WebRequest -UseBasicParsing -Headers @{ Accept = 'application/vnd.github.sha' } -Uri "https://api.github.com/repos/$Repo/commits/$Ref").Content
      if ($raw -is [byte[]]) { $raw = [System.Text.Encoding]::UTF8.GetString($raw) }
      $want = $raw.Trim()
    } catch { $want = $null }
    $haveRef = Get-Content (Join-Path $App '.pocketbuff-ref') -ErrorAction SilentlyContinue
    if ($want -and ($want -eq $haveRef) -and (Test-Path (Join-Path $App 'dist/client/index.html'))) { Step-OK app "up to date ($($want.Substring(0,7)))"; return }
  }
  $next = Join-Path $HomeDir 'app.next'; Remove-Item -Recurse -Force $next -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $next -Force | Out-Null
  if ($Source) {
    Get-ChildItem $Source -Exclude 'node_modules', 'dist', '.git' | Copy-Item -Destination $next -Recurse
  } else {
    if (-not (Test-Have tar)) { Step-Fail app 'tar not found (needs Windows 10 1803 or newer)'; return }
    $tarball = Join-Path ([IO.Path]::GetTempPath()) ("pocketbuff-" + [Guid]::NewGuid().ToString('n') + '.tgz')
    $refOrWant = if ($want) { $want } else { $Ref }
    try { Invoke-WebRequest -UseBasicParsing -Uri "https://codeload.github.com/$Repo/tar.gz/$refOrWant" -OutFile $tarball } catch { Step-Fail app "download from github.com/$Repo failed"; return }
    tar -xzf $tarball -C $next --strip-components=1
    Remove-Item $tarball -ErrorAction SilentlyContinue
    if (-not (Test-Path (Join-Path $next 'package.json'))) { Step-Fail app "download from github.com/$Repo failed"; return }
  }
  $npmLog = Join-Path $HomeDir 'npm.log'
  Push-Location $next
  try {
    $npm = if ($script:Platform -eq 'windows') { 'npm.cmd' } else { 'npm' }
    & $npm ci --no-audit --no-fund --loglevel=error *> $npmLog
    if ($LASTEXITCODE -ne 0) { Step-Fail app "npm install/build failed, see $npmLog"; return }
    & $npm exec vite build *>> $npmLog
    if ($LASTEXITCODE -ne 0) { Step-Fail app "npm install/build failed, see $npmLog"; return }
  } finally { Pop-Location }
  if ($want) { Set-Content (Join-Path $next '.pocketbuff-ref') $want }
  Remove-Item -Recurse -Force "$App.old" -ErrorAction SilentlyContinue
  if (Test-Path $App) { Move-Item $App "$App.old" }
  Move-Item $next $App
  Remove-Item -Recurse -Force "$App.old" -ErrorAction SilentlyContinue
  $ps1 = Join-Path $App 'site/install.ps1'
  if (Test-Path $ps1) { Copy-Item $ps1 (Join-Path $HomeDir 'install.ps1') -Force }
  Step-OK app "installed $(if ($want) { $want.Substring(0,7) + ' ' })at $App"
}

# ---------- config ----------
function Test-PortFree ([int]$p) {
  try {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse('127.0.0.1'), $p)
    $l.Start(); $l.Stop(); return $true
  } catch { return $false }
}
function Test-IsOurs ([int]$p) {
  try { return ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$p/healthz").Content -match '"runtime"') } catch { return $false }
}
function Set-ConfigAcl ([string]$path) {
  if ($script:Platform -ne 'windows') { return }   # POSIX: the script runs as the user in their own profile dir
  $acl = Get-Acl $path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($r in @($acl.Access)) { $acl.RemoveAccessRule($r) | Out-Null }
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl $path $acl
}
function Step-Config {
  New-Item -ItemType Directory -Path $HomeDir, $Logs -Force | Out-Null
  $token = Conf-Get 'FREEBUFF_REMOTE_TOKEN'
  if (-not $token) {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $b = New-Object byte[] 32; $rng.GetBytes($b); $rng.Dispose()
    $token = ($b | ForEach-Object { $_.ToString('x2') }) -join ''
  }
  $dir = if ($Project) { $Project } elseif (Conf-Get 'FREEBUFF_PROJECT_DIR') { Conf-Get 'FREEBUFF_PROJECT_DIR' } else { (Get-Location).Path }
  if (-not (Test-Path $dir)) { Step-Fail config "project folder $dir does not exist"; return }
  $dir = (Resolve-Path $dir).Path
  $p = if ($Port -gt 0) { $Port } elseif (Conf-Get 'PORT') { [int](Conf-Get 'PORT') } else { 8787 }
  if ($Port -eq 0) {
    $tries = 0
    while (-not (Test-IsOurs $p) -and -not (Test-PortFree $p)) { $p += 1; $tries += 1; if ($tries -ge 20) { Step-Fail config 'no free port from 8787 up'; return } }
  }
  Set-Content $Config "FREEBUFF_REMOTE_TOKEN=$token`nHOST=127.0.0.1`nPORT=$p`nFREEBUFF_PROJECT_DIR=$dir`n" -NoNewline -Encoding ascii
  Set-ConfigAcl $Config
  $runPs1 = Join-Path $HomeDir 'run.ps1'
  Set-Content $runPs1 @"
Get-Content '$Config' | ForEach-Object { if (`$_ -match '^([^=]+)=(.*)$') { Set-Item -Path "Env:`$(`$Matches[1])" -Value `$Matches[2] } }
Set-Location '$App'
& '$($script:NodeBin)' node_modules/tsx/dist/cli.mjs server.ts
"@ -Encoding ascii
  Set-ConfigAcl $runPs1
  Step-OK config "port $p, project $dir, token saved in $Config (never share it)"
}

# ---------- service ----------
function Get-ServiceKind { if ($script:Platform -eq 'windows') { 'scheduled-task' } else { 'background' } }
function Test-Healthy {
  $p = Conf-Get 'PORT'; if (-not $p) { return $false }
  try { return ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$p/healthz").Content -match '"ok":true') } catch { return $false }
}
function Stop-ProcessTree ([int]$rootId) {
  $byParent = @{}
  foreach ($pr in (Get-Process -ErrorAction SilentlyContinue)) {
    try { $parentId = $pr.Parent.Id } catch { continue }
    if ($parentId) { $byParent[$parentId] = @($byParent[$parentId]) + $pr.Id }
  }
  $queue = New-Object 'System.Collections.Generic.Queue[int]'
  $queue.Enqueue($rootId); $victims = @()
  while ($queue.Count -gt 0) { $cur = $queue.Dequeue(); foreach ($k in $byParent[$cur]) { $victims += $k; $queue.Enqueue($k) } }
  [array]::Reverse($victims)
  foreach ($v in $victims) { try { Stop-Process -Id $v -Force -ErrorAction SilentlyContinue } catch {} }
  try { Stop-Process -Id $rootId -Force -ErrorAction SilentlyContinue } catch {}
}
function Stop-PocketbuffService {
  if ((Get-ServiceKind) -eq 'scheduled-task') {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  $pidFile = Join-Path $HomeDir 'pid'
  if (Test-Path $pidFile) {
    # run.ps1 -> tsx launcher -> the node server: stop the whole tree, leaves first.
    Stop-ProcessTree ([int](Get-Content $pidFile))
    Remove-Item $pidFile -ErrorAction SilentlyContinue
  }
}
function Step-Service {
  $kind = Get-ServiceKind
  if ($kind -eq 'scheduled-task') {
    $runPs1 = Join-Path $HomeDir 'run.ps1'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runPs1`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
  } else {
    Stop-PocketbuffService
    $log = Join-Path $Logs 'pocketbuff.log'
    $exe = if ($script:Platform -eq 'windows') { 'powershell.exe' } else { 'pwsh' }
    $p = Start-Hidden $exe @('-NoProfile', '-File', "`"$(Join-Path $HomeDir 'run.ps1')`"") @{ RedirectStandardOutput = $log; RedirectStandardError = "$log.err" }
    Set-Content (Join-Path $HomeDir 'pid') $p.Id
  }
  $up = $false
  for ($i = 0; $i -lt 30; $i++) { if (Test-Healthy) { $up = $true; break }; Start-Sleep 1 }
  if ($up) {
    $note = if ($kind -eq 'background') { ' (no service manager in this environment: runs until reboot; re-run install after a restart)' } else { '' }
    Step-OK service "$kind, http://127.0.0.1:$(Conf-Get 'PORT')/healthz ok$note"
  } else {
    $tail = (Get-Content (Join-Path $Logs 'pocketbuff.log') -Tail 3 -ErrorAction SilentlyContinue) -join ' '
    Step-Fail service "$kind did not come up, last log lines: $tail"
  }
}

# ---------- freebuff login ----------
function Step-Freebuff {
  $creds = Join-Path $FreebuffDir 'credentials.json'
  if ((Test-Path $creds) -and (Select-String -Path $creds -Pattern '"authToken"' -Quiet)) { Step-OK freebuff-login "logged in ($creds)" }
  else { Step-Ask freebuff-login 'Freebuff is not logged in on this computer. Ask the human to run: freebuff  (in any terminal) and finish the login in the browser.' }
}

# ---------- tailscale ----------
$script:Ts = $null
function Find-Ts {
  $candidates = @()
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Tailscale\tailscale.exe') }
  foreach ($t in $candidates) { if ($t -and (Test-Path $t)) { $script:Ts = $t; return $true } }
  return $false
}
function Get-TsState {
  try {
    $j = (& $script:Ts status --json 2>$null | ConvertFrom-Json)
    $dns = if ($j.Self -and $j.Self.DNSName) { $j.Self.DNSName.TrimEnd('.') } else { '' }
    return @($j.BackendState, $dns, $j.AuthURL)
  } catch { return @('NoState', '', '') }
}
function Step-Tailscale {
  if (-not (Find-Ts)) {
    if ($script:Platform -eq 'windows' -and (Test-Have winget) -and (Confirm-Step 'Install Tailscale with winget? (Windows may ask for administrator approval once)')) {
      Invoke-WithTimeout 600 winget @('install', '--id', 'tailscale.tailscale', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements') (Join-Path $HomeDir 'winget-ts.out')
      Update-PathFromRegistry
    }
    if (Find-Ts) { Step-Ask tailscale 'Tailscale is installed. Ask the human to sign in: open Tailscale from the system tray, or run "tailscale up" and open the link it prints (same account as on their phone).' ; return }
    Step-Ask tailscale 'Ask the human to install Tailscale from https://tailscale.com/download/windows , then sign in (same account as on their phone).'
    return
  }
  $state, $dns, $url = Get-TsState
  if ($state -eq 'Running') { Step-OK tailscale "signed in as $dns"; return }
  # Start the login without blocking and hand the human the one link it produces.
  Start-Hidden $script:Ts @('up', '--timeout=60s') | Out-Null
  for ($i = 0; $i -lt 15; $i++) { $state, $dns, $url = Get-TsState; if ($url -or $state -eq 'Running') { break }; Start-Sleep 1 }
  if ($state -eq 'Running') { Step-OK tailscale "signed in as $dns" }
  elseif ($url) { Step-Ask tailscale "Ask the human to open $url and sign in to Tailscale (same account as on their phone)." }
  else { Step-Fail tailscale "tailscale did not start (state: $state). Try: $($script:Ts) up" }
}
function Step-Serve {
  $state, $dns, $url = Get-TsState
  $p = Conf-Get 'PORT'
  if ($state -ne 'Running') { return }
  $status = (& $script:Ts serve status 2>$null | Out-String)
  if ($status -match "127\.0\.0\.1:$p") { Step-OK serve "https://$dns/"; return }
  $out = Join-Path $HomeDir 'serve.out'
  Invoke-WithTimeout 10 $script:Ts @('serve', '--bg', '--https=443', "http://127.0.0.1:$p") $out
  $outText = Get-Content $out -Raw -ErrorAction SilentlyContinue; Remove-Item $out -ErrorAction SilentlyContinue
  if (-not $outText) { $outText = '' }
  $status = (& $script:Ts serve status 2>$null | Out-String)
  if ($status -match "127\.0\.0\.1:$p") { Step-OK serve "https://$dns/"; return }
  $m = [regex]::Match($outText, 'https://login\.tailscale\.com/[^ ]+')
  if ($m.Success) { Step-Ask serve "Ask the human to open $($m.Value) and turn on HTTPS for their tailnet (one click)." }
  elseif ($outText -match 'access denied|permission') { Step-Ask serve 'Ask the human to run the same command again from an Administrator PowerShell window.' }
  else { Step-Fail serve "tailscale serve failed: $(($outText -split "`n" | Select-Object -First 2) -join ' ')" }
}

# ---------- pair ----------
function Get-PairCode {
  $envFile = @{}
  Get-Content $Config | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $envFile[$Matches[1]] = $Matches[2] } }
  foreach ($k in $envFile.Keys) { Set-Item -Path "Env:$k" -Value $envFile[$k] }
  Push-Location $App
  try { $out = & $script:NodeBin node_modules/tsx/dist/cli.mjs pair.ts } finally { Pop-Location }
  $m = $out | Where-Object { $_ -match '^CODE ' } | Select-Object -First 1
  if ($m) { return ($m -replace '^CODE ', '') } else { return $null }
}
function Write-Summary {
  $state, $dns, $url = Get-TsState
  $code = Get-PairCode
  if (-not $code) { Step-Fail pair 'could not create a pairing code'; return }
  Step-OK pair "code $code, valid for 10 minutes, single use"
  Write-Output 'DONE'
  Write-Output "PHONE_URL https://$dns/"
  Write-Output "PAIR_URL https://$dns/#pair=$code"
  Write-Output "PAIR_CODE $code"
  Write-Output 'NOTE The phone needs the Tailscale app, signed in to the same account.'
  Write-Output 'NOTE Free mode has one slot: the phone and the terminal take turns.'
  Write-Output "NOTE New code any time: powershell -File $(Join-Path $HomeDir 'install.ps1') pair"
}

# ---------- commands ----------
function Invoke-Install {
  $arch = Get-Arch
  if ($script:Platform -ne 'windows' -and -not $env:POCKETBUFF_PLATFORM) {
    Step-Fail platform "$($script:Platform) is not supported by install.ps1 (macOS/Linux: use install.sh from the same site)"
    exit 1
  }
  if (-not $arch) { Step-Fail platform "CPU $($env:PROCESSOR_ARCHITECTURE) is not supported"; exit 1 }
  Step-OK platform "$($script:Platform)-$arch, service: $(Get-ServiceKind)$(if ($env:POCKETBUFF_PLATFORM) { ' (development override)' })"
  New-Item -ItemType Directory -Path $HomeDir, $Logs -Force | Out-Null
  Step-Node;     if ($script:failed -eq 1) { Finish }
  Step-App;      if ($script:failed -eq 1) { Finish }
  Step-Config;   if ($script:failed -eq 1) { Finish }
  Step-Service;  if ($script:failed -eq 1) { Finish }
  Step-Freebuff
  Step-Tailscale
  if ($script:human -eq 0 -and $script:failed -eq 0) { Step-Serve }
  if ($script:human -eq 0 -and $script:failed -eq 0) { Write-Summary }
  Finish
}
function Invoke-Doctor {
  $arch = Get-Arch
  Step-OK platform "$($script:Platform)-$arch, service: $(Get-ServiceKind)"
  if (Find-Node) { Step-OK node "$(& $script:NodeBin -v)" } else { Step-Fail node 'Node >= 20 not found. Fix: run install' }
  if (Test-Path (Join-Path $App 'dist/client/index.html')) {
    $r = Get-Content (Join-Path $App '.pocketbuff-ref') -ErrorAction SilentlyContinue
    Step-OK app "$App$(if ($Source) { ' (local)' }) $(if ($r) { $r.Substring(0,7) })"
  } else { Step-Fail app 'not installed. Fix: run install' }
  if (Test-Path $Config) { Step-OK config "port $(Conf-Get 'PORT'), project $(Conf-Get 'FREEBUFF_PROJECT_DIR')" } else { Step-Fail config 'missing. Fix: run install' }
  if ((Test-Path $Config) -and (Test-Healthy)) { Step-OK service "$(Get-ServiceKind) running" } else { Step-Fail service "not answering on 127.0.0.1:$(Conf-Get 'PORT'). Fix: run install; log: $(Join-Path $Logs 'pocketbuff.log')" }
  Step-Freebuff
  if (Find-Ts) {
    $state, $dns, $url = Get-TsState
    if ($state -eq 'Running') {
      Step-OK tailscale "signed in as $dns"
      $p = Conf-Get 'PORT'
      $status = (& $script:Ts serve status 2>$null | Out-String)
      if ($status -match "127\.0\.0\.1:$p") { Step-OK serve "https://$dns/" } else { Step-Fail serve 'not serving the app. Fix: run install' }
    } else { Step-Fail tailscale "state $state. Fix: run install" }
  } else { Step-Fail tailscale 'not installed. Fix: run install' }
  if ($script:failed -eq 0 -and $script:human -eq 0) { Write-Output 'HEALTHY' }
  Finish
}
function Invoke-Pair {
  if ((Find-Node) -and (Find-Ts) -and (Test-Path $Config)) { Write-Summary; Finish }
  else { Write-Output 'STEP pair FAIL Pocketbuff is not installed yet; run install first'; exit 1 }
}
function Invoke-Uninstall {
  Stop-PocketbuffService; Step-OK service 'stopped and removed'
  $p = Conf-Get 'PORT'
  if ((Find-Ts) -and $p -and ((& $script:Ts serve status 2>$null | Out-String) -match "127\.0\.0\.1:$p")) {
    & $script:Ts serve --https=443 off *> $null
    Step-OK serve 'tailscale serve for Pocketbuff turned off'
  } else { Step-OK serve 'nothing to turn off' }
  Remove-Item -Recurse -Force $HomeDir, $StateDir -ErrorAction SilentlyContinue
  Step-OK files "removed $HomeDir and $StateDir"
  Write-Output 'DONE Pocketbuff removed. Node, Tailscale and Freebuff were left installed.'
  exit 0
}

# Set $global:PocketBuffNoDispatch = $true before dot-sourcing to load functions without running a command.
if (-not (Get-Variable -Name PocketBuffNoDispatch -Scope global -ErrorAction SilentlyContinue)) {
  if ($Help) { Get-Content $PSCommandPath | Select-Object -First 12 | ForEach-Object { $_ -replace '^# ?', '' }; exit 0 }
  switch ($Command) {
    'install'   { Invoke-Install }
    'doctor'    { Invoke-Doctor }
    'pair'      { Invoke-Pair }
    'uninstall' { Invoke-Uninstall }
    default     { [Console]::Error.WriteLine("Unknown argument: $Command (try --help)"); exit 1 }
  }
}
