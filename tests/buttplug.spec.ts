import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { ButtplugBackend, parseButtplugDeviceList } from '../src/buttplug.ts'

const servers: WebSocketServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
})

describe('Buttplug provider', () => {
  it('parses v3 and v4 device capabilities into one public vocabulary', () => {
    expect(parseButtplugDeviceList({ Devices: [{
      DeviceName: 'V3 toy',
      DeviceIndex: 2,
      DeviceMessages: {
        ScalarCmd: [{ StepCount: 20, FeatureDescriptor: 'motor', ActuatorType: 'Vibrate' }],
      },
    }] }, 3)).toEqual([{
      id: 'buttplug:2',
      name: 'V3 toy',
      features: [{ id: 'buttplug:2:0:vibrate', kind: 'vibrate', description: 'motor' }],
    }])

    expect(parseButtplugDeviceList({ Devices: {
      4: {
        DeviceName: 'V4 toy',
        DeviceIndex: 4,
        DeviceDisplayName: 'Mine',
        DeviceFeatures: {
          7: {
            FeatureIndex: 7,
            FeatureDescription: 'pump',
            Output: { Constrict: { Value: [0, 20] } },
          },
        },
      },
    } }, 4)).toEqual([{
      id: 'buttplug:4',
      name: 'V4 toy',
      displayName: 'Mine',
      features: [{ id: 'buttplug:4:7:constrict', kind: 'constrict', description: 'pump' }],
    }])
  })

  it('negotiates v4 and maps percentages to advertised integer ranges', async () => {
    const received: Array<Record<string, unknown>> = []
    const server = new WebSocketServer({ port: 0 })
    servers.push(server)
    await new Promise<void>(resolve => { server.once('listening', resolve) })
    server.on('connection', socket => {
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString()) as Array<Record<string, Record<string, unknown>>>
        const [type, body] = Object.entries(message[0]!)[0]!
        received.push({ type, ...body })
        const id = body.Id as number
        if (type === 'RequestServerInfo') {
          socket.send(JSON.stringify([{ ServerInfo: {
            Id: id,
            ServerName: 'Fixture Intiface',
            MaxPingTime: 0,
            ProtocolVersionMajor: 4,
            ProtocolVersionMinor: 0,
          } }]))
        } else if (type === 'RequestDeviceList') {
          socket.send(JSON.stringify([{ DeviceList: { Id: id, Devices: {
            0: {
              DeviceName: 'Fixture Toy',
              DeviceIndex: 0,
              DeviceMessageTimingGap: 0,
              DeviceFeatures: {
                0: {
                  FeatureIndex: 0,
                  FeatureDescription: 'motor',
                  Output: { Vibrate: { Value: [0, 20] } },
                },
              },
            },
          } } }]))
        } else {
          socket.send(JSON.stringify([{ Ok: { Id: id } }]))
        }
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP address')
    const backend = new ButtplugBackend({
      url: `ws://127.0.0.1:${address.port}`,
      protocolVersion: 4,
      connectionTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      clientName: 'fixture',
    })
    const signal = new AbortController().signal

    const connection = await backend.connect(signal)
    expect(connection.serverName).toBe('Fixture Intiface')
    await backend.setLevel({
      deviceId: 'buttplug:0',
      kind: 'vibrate',
      intensityPercent: 50,
    }, signal)
    await backend.stop('buttplug:0', signal)
    await backend.close()

    expect(received).toContainEqual(expect.objectContaining({
      type: 'OutputCmd',
      DeviceIndex: 0,
      FeatureIndex: 0,
      Command: { Vibrate: { Value: 10 } },
    }))
    expect(received).toContainEqual(expect.objectContaining({ type: 'StopCmd', DeviceIndex: 0 }))
  })
})
