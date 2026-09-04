import { probeAuthGate } from '../src/dsh-probe.mjs'

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const port = Number(option('--port', process.env.DSH_INTERNAL_PORT ?? '3080'))
const trustedHost = option('--trusted-host', process.env.DSH_TRUSTED_HOST ?? '')
const waitMs = Number(option('--wait-ms', '0'))
const deadline = Date.now() + waitMs

if (!Number.isInteger(port) || port < 1 || port > 65535 || trustedHost === '') process.exit(2)

do {
  if (await probeAuthGate({ port, trustedHost })) process.exit(0)
  if (Date.now() >= deadline) break
  await new Promise((resolve) => setTimeout(resolve, 500))
} while (true)

process.stderr.write('dsh-server-kit: auth gate did not reach its expected fail-closed state\n')
process.exit(1)
