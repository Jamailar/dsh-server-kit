import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { probeAuthGate } from './dsh-probe.mjs'

const listenHost = process.env.STATUS_HOST ?? '127.0.0.1'
const listenPort = Number(process.env.STATUS_PORT ?? '9000')
const statePath = process.env.RUNTIME_STATE_PATH ?? '/data/dsh-server/runtime-state.json'
const releaseManifestPath = process.env.RELEASE_MANIFEST_PATH ?? '/app/config/release-manifest.json'
const dshPort = Number(process.env.DSH_INTERNAL_PORT ?? '3080')
const trustedHost = process.env.DSH_TRUSTED_HOST ?? ''

if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('invalid STATUS_PORT')
if (!Number.isInteger(dshPort) || dshPort < 1 || dshPort > 65535) throw new Error('invalid DSH_INTERNAL_PORT')

const release = await readPublicRelease(releaseManifestPath)

function json(res, statusCode, value) {
  const body = JSON.stringify(value)
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readPublicRelease(path) {
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  return {
    release: manifest.release?.version ?? 'unknown',
    dsh: manifest.runtime?.dsh?.version ?? 'unknown',
    authGate: manifest.runtime?.authGate?.version ?? 'unknown',
  }
}

async function isReady() {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    if (state.state !== 'ready') return false
  } catch {
    return false
  }

  if (trustedHost === '') return false
  return probeAuthGate({ port: dshPort, trustedHost })
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://status.internal').pathname
  if (req.method !== 'GET') {
    json(res, 404, { status: 'not_found' })
    return
  }

  if (path === '/healthz') {
    json(res, 200, { status: 'ok' })
    return
  }

  if (path === '/readyz') {
    const ready = await isReady()
    json(res, ready ? 200 : 503, { status: ready ? 'ready' : 'starting' })
    return
  }

  if (path === '/versionz') {
    json(res, 200, release)
    return
  }

  json(res, 404, { status: 'not_found' })
})

server.listen(listenPort, listenHost, () => {
  process.stdout.write(`${JSON.stringify({ event: 'status_server_listening', port: listenPort })}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
