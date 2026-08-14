import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { MonsterPartyBackend } from '../src/monsterparty.ts'

let httpServer: Server | undefined
let wsServer: WebSocketServer | undefined

afterEach(async () => {
  if (wsServer !== undefined) {
    for (const client of wsServer.clients) client.terminate()
    wsServer.close()
    wsServer = undefined
  }
  if (httpServer !== undefined) {
    await new Promise<void>(resolve => { httpServer!.close(() => { resolve() }) })
    httpServer = undefined
  }
})

describe('MonsterParty provider', () => {
  it('resolves a share token, completes the relay handshake, and uses the dual-motor mapping', async () => {
    const controlFrames: Array<Record<string, unknown>> = []
    httpServer = createServer((request, response) => {
      const address = httpServer!.address()
      if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP address')
      const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${address.port}`)
      expect(requestUrl.searchParams.get('s')).toBe('secret-token')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: {
        socket_url: `ws://127.0.0.1:${address.port}`,
        id: 12,
        user_id: 34,
      } }))
    })
    wsServer = new WebSocketServer({ noServer: true })
    httpServer.on('upgrade', (request, socket, head) => {
      wsServer!.handleUpgrade(request, socket, head, websocket => { wsServer!.emit('connection', websocket, request) })
    })
    wsServer.on('connection', socket => {
      socket.on('message', raw => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>
        if (frame.op === 2) {
          socket.send(JSON.stringify({ op: 6, sender: { fd: 99 } }))
          socket.send(JSON.stringify({ op: 15, conn: true, pid: 'AKN_DS_SUCKEGG' }))
        } else if (frame.op === 3) {
          controlFrames.push(frame)
        }
      })
    })
    await new Promise<void>(resolve => { httpServer!.listen(0, '127.0.0.1', resolve) })
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP address')
    const backend = new MonsterPartyBackend({
      sessionToken: 'secret-token',
      apiUrl: `http://127.0.0.1:${address.port}/session`,
      origin: 'https://www.monsterparty.cn',
      userAgent: 'fixture',
      connectionTimeoutMs: 1_000,
      readyTimeoutMs: 1_000,
      heartbeatIntervalMs: 60_000,
    })
    const signal = new AbortController().signal

    const connection = await backend.connect(signal)
    expect(connection.devices[0]?.features.map(feature => feature.kind)).toEqual(['vibrate', 'suction'])
    await backend.setLevel({
      deviceId: 'monsterparty:remote',
      kind: 'vibrate',
      intensityPercent: 60,
    }, signal)
    await backend.setLevel({
      deviceId: 'monsterparty:remote',
      featureId: 'monsterparty:remote:suction',
      kind: 'suction',
      intensityPercent: 25,
    }, signal)
    await backend.close()

    expect(controlFrames[0]?.vib).toEqual([0, 60, 60, 60, 60, 0, 0, 0, 0, 0])
    expect(controlFrames[1]?.vib).toEqual([25, 60, 60, 60, 60, 0, 0, 0, 0, 0])
    expect(controlFrames.at(-1)?.vib).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  })
})
