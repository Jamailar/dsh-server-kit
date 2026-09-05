import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('preset switching replaces managed dependencies and preserves user data', async () => {
  const scratch = await mkdtemp(join(os.tmpdir(), 'dsh-preset-switch-'))
  try {
    const dshHome = join(scratch, 'dsh')
    const profile = join(dshHome, 'profiles/web')
    const seeds = join(scratch, 'seeds')
    for (const preset of ['base', 'trading']) {
      const seed = join(seeds, preset)
      for (const pkg of ['dsh-auth-gate', '@deepseek-ai/cordis', '@deepseek-ai/dsh-invariants', '@deepseek-ai/dsh-storage', `${preset}-only`]) {
        await mkdir(join(seed, 'node_modules', pkg), { recursive: true })
      }
      for (const file of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'server-kit-profile.json']) await writeFile(join(seed, file), preset)
    }
    await mkdir(join(dshHome, 'profiles'), { recursive: true })
    await cp(join(seeds, 'base'), profile, { recursive: true })
    await writeFile(join(dshHome, 'account-marker'), 'preserve administrator')
    await writeFile(join(profile, 'user-marker'), 'preserve user files')
    const entrypoint = await readFile(resolve('docker/entrypoint.sh'), 'utf8')
    const repair = entrypoint.slice(entrypoint.indexOf('repair_seed_profile_if_needed() {'), entrypoint.indexOf('\nbrand_auth_gate_login()'))
    for (const preset of ['trading', 'base']) {
      const result = spawnSync('sh', ['-c', `set -eu\nfail() { echo "$1" >&2; exit 1; }\n${repair}\nrepair_seed_profile_if_needed`], {
        env: { ...process.env, DSH_HOME: dshHome, SEED_ROOT: seeds, DSH_UI_PRESET: preset },
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), preset)
      const oldPreset = preset === 'base' ? 'trading' : 'base'
      await assert.rejects(access(join(profile, `node_modules/${oldPreset}-only`)), { code: 'ENOENT' })
      await access(join(profile, `node_modules/${preset}-only`))
      assert.equal(await readFile(join(dshHome, 'account-marker'), 'utf8'), 'preserve administrator')
      assert.equal(await readFile(join(profile, 'user-marker'), 'utf8'), 'preserve user files')
    }
  } finally { await rm(scratch, { recursive: true, force: true }) }
})
