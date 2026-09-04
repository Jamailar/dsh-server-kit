import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

async function readable(path) {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

const home = resolve(option('--home', process.env.DSH_HOME ?? '/data/dsh'))
const preset = option('--preset', process.env.DSH_UI_PRESET ?? 'base')
const manifestPath = option('--manifest', join(projectRoot, 'config', 'release-manifest.json'))
const profileDir = join(home, 'profiles', 'web')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const expectedPreset = manifest.presets?.[preset]
const errors = []

if (!expectedPreset) errors.push('unknown_preset')
const files = {
  packageJson: join(profileDir, 'package.json'),
  lockfile: join(profileDir, 'pnpm-lock.yaml'),
  cordisPatch: join(profileDir, 'cordis.patch.yml'),
  workspace: join(profileDir, 'pnpm-workspace.yaml'),
  attestation: join(profileDir, 'server-kit-profile.json'),
}

for (const [name, path] of Object.entries(files)) {
  if (!await readable(path)) errors.push(`missing_${name}`)
}

if (errors.length === 0) {
  const profile = JSON.parse(await readFile(files.packageJson, 'utf8'))
  const attestation = JSON.parse(await readFile(files.attestation, 'utf8'))
  if (attestation.schemaVersion !== 1 || attestation.preset !== preset) errors.push('invalid_attestation')
  if (JSON.stringify(profile.dependencies ?? {}) !== JSON.stringify(expectedPreset.packages)) errors.push('unexpected_dependencies')
  if (JSON.stringify(profile.dsh?.profile?.bundles ?? []) !== JSON.stringify(expectedPreset.bundles)) errors.push('unexpected_bundle_order')

  const patch = await readFile(files.cordisPatch, 'utf8')
  if (!/id:\s*dsh-auth-gate/.test(patch) || !/mode:\s*password/.test(patch) || !/cookieSecure:\s*true/.test(patch)) errors.push('auth_gate_not_fail_closed')

  for (const [key, path] of Object.entries({
    packageJson: files.packageJson,
    lockfile: files.lockfile,
    cordisPatch: files.cordisPatch,
    workspace: files.workspace,
  })) {
    if (attestation.files?.[key] !== await sha256(path)) errors.push(`changed_${key}`)
  }
}

const result = {
  ok: errors.length === 0,
  preset,
  release: manifest.release?.version ?? 'unknown',
  errors,
}
process.stdout.write(`${JSON.stringify(result)}\n`)
process.exit(errors.length === 0 ? 0 : 1)
