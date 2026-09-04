import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function exists(path) {
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

async function verifyProfile({ preset, profileDir, manifest }) {
  const presetPath = join(projectRoot, 'config', 'presets', `${preset}.json`)
  const expected = JSON.parse(await readFile(presetPath, 'utf8'))
  const manifestPreset = manifest.presets?.[preset]
  const packagePath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const lockPath = join(profileDir, 'pnpm-lock.yaml')
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')

  for (const path of [packagePath, patchPath, lockPath, workspacePath]) {
    if (!await exists(path)) throw new Error(`seed profile is missing ${path}`)
  }

  const profile = JSON.parse(await readFile(packagePath, 'utf8'))
  const expectedPackages = expected.packages
  const expectedBundles = expected.bundles
  if (JSON.stringify(manifestPreset?.packages ?? {}) !== JSON.stringify(expectedPackages)
    || JSON.stringify(manifestPreset?.bundles ?? []) !== JSON.stringify(expectedBundles)) {
    throw new Error(`${preset} preset differs from the release manifest`)
  }
  if (JSON.stringify(profile.dependencies ?? {}) !== JSON.stringify(expectedPackages)) {
    throw new Error(`${preset} profile dependency set differs from its preset`)
  }
  if (JSON.stringify(profile.dsh?.profile?.bundles ?? []) !== JSON.stringify(expectedBundles)) {
    throw new Error(`${preset} profile bundle order differs from its preset`)
  }

  const patch = await readFile(patchPath, 'utf8')
  if (!/id:\s*dsh-auth-gate/.test(patch) || !/mode:\s*password/.test(patch) || !/cookieSecure:\s*true/.test(patch)) {
    throw new Error(`${preset} profile does not force secure password authentication`)
  }

  const lock = await readFile(lockPath, 'utf8')
  for (const [name, version] of Object.entries(expectedPackages)) {
    if (!lock.includes(`${name}@${version}`)) throw new Error(`${preset} lockfile does not pin ${name}@${version}`)
  }

  const authVersion = manifest.runtime?.authGate?.version
  if (expectedPackages['dsh-auth-gate'] !== authVersion) throw new Error('preset and release manifest disagree about auth gate version')

  return {
    schemaVersion: 1,
    preset,
    release: manifest.release?.version,
    files: {
      packageJson: await sha256(packagePath),
      lockfile: await sha256(lockPath),
      cordisPatch: await sha256(patchPath),
      workspace: await sha256(workspacePath),
    },
  }
}

const verifyOnly = process.argv.includes('--verify-only')
const selectedPreset = option('--preset')
const profileArgument = option('--profile')
const manifestPath = join(projectRoot, 'config', 'release-manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

if (manifest.schemaVersion !== 1 || !manifest.runtime?.dsh?.version || !manifest.runtime?.authGate?.version) {
  throw new Error('release manifest is incomplete')
}

if (verifyOnly) {
  for (const preset of Object.keys(manifest.presets ?? {})) {
    await verifyProfile({ preset, profileDir: join(projectRoot, 'seed-profiles', preset), manifest })
  }
  process.stdout.write('seed profiles verified\n')
  process.exit(0)
}

if (!selectedPreset || !profileArgument) throw new Error('usage: build-seed-profile.mjs --preset <base|workbench> --profile <directory>')
if (!(selectedPreset in (manifest.presets ?? {}))) throw new Error(`unknown preset: ${selectedPreset}`)

const attestation = await verifyProfile({ preset: selectedPreset, profileDir: resolve(profileArgument), manifest })
await writeFile(join(resolve(profileArgument), 'server-kit-profile.json'), `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`seed profile attested: ${selectedPreset}\n`)
