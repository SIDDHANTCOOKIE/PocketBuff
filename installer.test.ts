import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const installer = fs.readFileSync('site/install.sh', 'utf8')
const shell = installer.split('# ---------- commands ----------')[0]
function run(flags: string[], code: string, config = '') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketbuff-installer-'))
  if (config) fs.writeFileSync(path.join(home, 'config.env'), config)
  try {
    return spawnSync('bash', ['-c', `${shell}\n${code}`, 'installer-test', ...flags], {
      encoding: 'utf8', env: { ...process.env, POCKETBUFF_HOME: home },
    })
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}
const stubPair = 'pair_code() { echo 123456; }; ts_state() { echo "Running laptop.tail1234.ts.net"; }; summary; finish'
describe('installer access modes', () => {
  it('local pairing works without touching Tailscale', () => {
    const r = run(['--local'], 'ts_state() { echo "unexpected Tailscale call" >&2; exit 99; }; pair_code() { echo 123456; }; summary; finish', 'PORT=8787\n')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PAIR_URL http://127.0.0.1:8787/#pair=123456')
    expect(r.stdout).toContain('this computer only')
    expect(r.stderr).not.toContain('unexpected')
    expect(r.stdout).not.toContain('phone needs the Tailscale')
  })
  it('LAN mode uses the selected private address and preserves it for pair/doctor', () => {
    const r = run([], stubPair, 'PORT=8787\nHOST=192.168.1.25\nPOCKETBUFF_MODE=local\n')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PAIR_URL http://192.168.1.25:8787/#pair=123456')
    expect(r.stdout).toContain('unencrypted')
    expect(r.stdout).toContain('PWA installation requires HTTPS')
  })
  it('Tailscale mode keeps localhost and HTTPS', () => {
    const r = run(['--tailscale'], `echo "BIND $(service_host)"; ${stubPair}`, 'PORT=8787\nHOST=192.168.1.25\nPOCKETBUFF_MODE=local\n')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('BIND 127.0.0.1')
    expect(r.stdout).toContain('PAIR_URL https://laptop.tail1234.ts.net/#pair=123456')
    expect(r.stdout).toContain('phone needs the Tailscale')
  })
  it.each(['0.0.0.0', '8.8.8.8', '100.64.1.2', '192.168.1.999', '192.168.1.1;id'])('rejects unsafe host %s', host => {
    expect(run(['--local', '--host', host], 'echo should-not-run').status).toBe(1)
  })
  it.each(['local', 'tailscale'])('dispatches the %s install path only', mode => {
    const r = run([`--${mode}`], `
      step_node() { :; }; step_app() { :; }; step_config() { :; };
      step_service() { :; }; step_freebuff() { :; }; find_ts() { return 1; };
      step_tailscale() { echo CALLED_TAILSCALE; }; step_serve() { echo CALLED_SERVE; };
      pair_code() { echo 123456; }; ts_state() { echo "Running laptop.tail1234.ts.net"; };
      ${installer.split('# ---------- commands ----------')[1]}
    `, 'PORT=8787\n')
    expect(r.status).toBe(0)
    expect(r.stdout.includes('CALLED_TAILSCALE')).toBe(mode === 'tailscale')
    expect(r.stdout.includes('CALLED_SERVE')).toBe(mode === 'tailscale')
    expect(r.stdout).toContain(mode === 'local' ? 'PAIR_URL http://' : 'PAIR_URL https://')
  })
  it('rejects conflicting modes', () => {
    expect(run(['--local', '--tailscale'], 'echo should-not-run').status).toBe(1)
  })
  it('stores mode, selected host and token without printing the token', () => {
    const r = run(['--local', '--host', '192.168.1.25'], `node_bin=$(command -v node); port=8787; step_config; sed -n '/^HOST=/p;/^POCKETBUFF_MODE=/p' "$CONFIG"; finish`)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('HOST=192.168.1.25')
    expect(r.stdout).toContain('POCKETBUFF_MODE=local')
    expect(r.stdout).not.toContain('FREEBUFF_REMOTE_TOKEN=')
  })
})
describe('setup prompt paths', () => {
  const prompt = fs.readFileSync('site/install.md', 'utf8')
  it('asks the user and waits before the install commands', () => {
    expect(prompt.indexOf('Wait for their choice')).toBeLessThan(prompt.indexOf('curl -fsSL BASE/install.sh'))
    expect(prompt).toContain('Do not choose for them, even with `--yes`')
  })
  it('documents both operating-system paths and their limits', () => {
    for (const flag of ['--local', '--tailscale', '--host', '-Local', '-Tailscale', '-BindHost']) expect(prompt).toContain(flag)
    expect(prompt).toContain('Local-only skips all Tailscale setup')
    expect(prompt).toContain('localhost on the phone is not this computer')
    expect(prompt).toContain('Keep the same mode and host on every retry')
    expect(prompt).toContain('PWA installation requires HTTPS')
  })
})
describe('pocketbuff command and Freebuff skill', () => {
  const ps1 = fs.readFileSync('site/install.ps1', 'utf8')
  function runIn(home: string, code: string, extra: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', ['-c', `${shell}\n${code}`, 'installer-test', '--local'], {
      encoding: 'utf8', env: { ...process.env, POCKETBUFF_HOME: path.join(home, 'ph'), POCKETBUFF_AGENTS_DIR: path.join(home, 'agents'), POCKETBUFF_BIN_DIR: path.join(home, 'bin'), ...extra },
    })
  }
  it('writes the skill and a working shim that defaults to `up`', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketbuff-cmd-'))
    try {
      const r = runIn(home, 'step_command; finish')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('/skill:pocketbuff')
      const skill = fs.readFileSync(path.join(home, 'agents/skills/pocketbuff/SKILL.md'), 'utf8')
      expect(skill).toMatch(/^---\nname: pocketbuff\ndescription: .+\n---/)
      expect(skill).toContain('pocketbuff up')
      expect(skill).toContain('Never print or paste `~/.pocketbuff/config.env`')
      // The shim hands its arguments (or `up`) to the installed script.
      fs.writeFileSync(path.join(home, 'ph/install.sh'), '#!/usr/bin/env bash\necho "ARGS:$*"\n')
      expect(spawnSync(path.join(home, 'bin/pocketbuff'), [], { encoding: 'utf8' }).stdout.trim()).toBe('ARGS:up')
      expect(spawnSync(path.join(home, 'bin/pocketbuff'), ['pair'], { encoding: 'utf8' }).stdout.trim()).toBe('ARGS:pair')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })
  it('`up` starts a stopped service then prints the pairing link', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketbuff-up-'))
    try {
      fs.mkdirSync(path.join(home, 'ph'), { recursive: true })
      fs.writeFileSync(path.join(home, 'ph/config.env'), 'PORT=8787\n')
      const dispatch = installer.split('# ---------- commands ----------')[1]
      const r = spawnSync('bash', ['-c', `${shell}\nfind_node() { return 0; }; healthy() { return 1; }; step_service() { echo SERVICE_STARTED; }; step_freebuff() { :; }; pair_code() { echo 123456; }\n${dispatch}`, 'installer-test', 'up', '--local'], {
        encoding: 'utf8', env: { ...process.env, POCKETBUFF_HOME: path.join(home, 'ph') },
      })
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('SERVICE_STARTED')
      expect(r.stdout).toContain('PAIR_URL http://127.0.0.1:8787/#pair=123456')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })
  it('the skill text is identical in the shell and PowerShell installers', () => {
    const sh = /<<'SKILL'\n([\s\S]*?)\nSKILL\n/.exec(installer)?.[1]
    const ps = /\$SkillText = @'\n([\s\S]*?)\n'@/.exec(ps1)?.[1]
    expect(sh).toBeTruthy()
    expect(ps).toBe(sh)
  })
  it('the Windows command is a .cmd shim added to the user PATH, defaulting to `up`', () => {
    expect(ps1).toContain("'pocketbuff.cmd'")
    expect(ps1).toContain('"@echo off')
    expect(ps1).toContain('PB_ARGS=up')
    expect(ps1).toContain("SetEnvironmentVariable('Path'")
    expect(ps1).toContain("'up'        { Invoke-Up }")
  })
})
describe('install guide mentions the command', () => {
  const prompt = fs.readFileSync('site/install.md', 'utf8')
  it('documents pocketbuff up and the skill', () => {
    expect(prompt).toContain('pocketbuff up')
    expect(prompt).toContain('/skill:pocketbuff')
  })
})

describe('install.ps1 on Windows PowerShell 5.1', () => {
  // 5.1 drops double quotes inside arguments passed to native programs, so `node -p 'x.split(".")'` becomes a syntax error
  // and the version check reads every Node as 0. Keep the probe free of double quotes.
  it('passes node -p expressions without double quotes', () => {
    const ps1 = fs.readFileSync('site/install.ps1', 'utf8')
    const probes = [...ps1.matchAll(/&\s*\$\w+\s+-p\s+'([^']*)'/g)].map((m) => m[1])
    expect(probes.length).toBeGreaterThan(0)
    for (const probe of probes) expect(probe).not.toContain('"')
  })
})

describe('install.ps1 file permissions', () => {
  it('locks config files with icacls, not Set-Acl (which needs SeSecurityPrivilege)', () => {
    const ps1 = fs.readFileSync('site/install.ps1', 'utf8')
    expect(ps1).toContain('icacls.exe')
    expect(ps1).not.toMatch(/^\s*Set-Acl\b/m)
  })
})
