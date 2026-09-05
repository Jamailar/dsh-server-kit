import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DSH_VERSION = '0.1.2-rc.1'
const PATCH_MARKER = 'dsh-server-kit-remote-settings-v1'
const upstreamStatement = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";'
const replacement = `// ${PATCH_MARKER}: this single-admin distribution authenticates the configured public origin before it reaches DSH.\n\t\t\tconst persistence = "host";`

const runtimeFlag = process.argv.indexOf('--runtime')
const runtimeDir = runtimeFlag === -1 ? '' : process.argv[runtimeFlag + 1]
if (runtimeDir === '' || runtimeDir.startsWith('--')) throw new Error('usage: enable-remote-settings.mjs --runtime <directory>')

const packageDir = join(resolve(runtimeDir), 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings')
const packageJsonPath = join(packageDir, 'package.json')
const clientPath = join(packageDir, 'lib', 'client.js')
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))

if (packageJson.name !== '@deepseek-ai/dsh-client-ui-settings' || packageJson.version !== DSH_VERSION) {
  throw new Error(`expected @deepseek-ai/dsh-client-ui-settings@${DSH_VERSION} before enabling remote settings`)
}

let source = await readFile(clientPath, 'utf8')
if (source.includes(PATCH_MARKER)) {
  if (!source.includes('const persistence = "host";')) throw new Error('remote settings patch marker is malformed')
  process.stdout.write('DSH remote settings patch already applied\n')
  process.exit(0)
}

const occurrences = source.split(upstreamStatement).length - 1
if (occurrences !== 1) throw new Error(`expected one loopback settings persistence boundary, found ${occurrences}`)

source = source.replace(upstreamStatement, replacement)
await writeFile(clientPath, source)
process.stdout.write('DSH remote settings patch applied\n')
