import { describe, expect, it } from 'vitest'
import { AutoToyBackend, intifaceArguments, IntifaceProcessManager, routeToyTarget } from '../src/auto.ts'
import { selectIntifaceArtifact } from '../src/intiface-download.ts'
import { createIntifaceUserDeviceConfig } from '../src/intiface-user-config.ts'

const autoConfig = {
  buttplug: {
    url: 'ws://127.0.0.1:12345',
    protocolVersion: 4 as const,
    connectionTimeoutMs: 100,
    requestTimeoutMs: 100,
    clientName: 'fixture',
  },
  intiface: {
    executable: 'intiface-engine',
    websocketUrl: 'ws://127.0.0.1:12345',
    startupTimeoutMs: 100,
    autoDownload: false,
  },
}

describe('automatic toy routing', () => {
  it('recognizes Chemtrails models and sends other models to local hardware discovery', () => {
    expect(routeToyTarget({ brand: '安可尼', model: 'AKN_DS_SUCKEGG' })).toBe('monsterparty')
    expect(routeToyTarget({ brand: 'Lovense', model: 'Lush 3' })).toBe('buttplug')
    expect(routeToyTarget({ brand: 'unknown', model: 'unknown' })).toBe('buttplug')
  })

  it('selects only pinned official builds for supported platforms', () => {
    expect(selectIntifaceArtifact('darwin', 'arm64')).toMatchObject({
      name: 'intiface-engine-v4.0.2-macos-arm64.zip',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(() => selectIntifaceArtifact('darwin', 'x64')).toThrow('unavailable for darwin-x64')
  })

  it('builds a verified RoomFun mapping for supported Intiface schemas', () => {
    const config = JSON.parse(createIntifaceUserDeviceConfig(4)) as {
      version: { major: number }
      user_configs: { protocols: { monsterpub: {
        communication: Array<{ btle: { names: string[] } }>
        configurations: Array<{ identifier: string[], features: unknown[] }>
      } } }
    }
    const monsterpub = config.user_configs.protocols.monsterpub
    expect(config.version.major).toBe(4)
    expect(monsterpub.communication[0]?.btle.names).toContain('RoomFun')
    expect(monsterpub.configurations[0]).toMatchObject({ identifier: ['RF_CANNON_PT3'] })
    expect(monsterpub.configurations[0]?.features).toHaveLength(1)
    expect(intifaceArguments(12345, '/tmp/user.json')).toContain('/tmp/user.json')
    expect(() => createIntifaceUserDeviceConfig(3)).toThrow('Unsupported Intiface')
  })

  it('requires the agent to provide a model and reports missing remote-link configuration', async () => {
    const backend = new AutoToyBackend(autoConfig)
    const signal = new AbortController().signal
    await expect(backend.connect(signal)).rejects.toThrow('Ask the user for the exact toy brand and model')
    await expect(backend.connect(signal, { model: 'AKN_DS_SUCKEGG' })).rejects.toThrow('configure a fresh MONSTERPARTY_TOKEN')
  })

  it('refuses to auto-start Intiface for a non-local endpoint', async () => {
    const process = new IntifaceProcessManager({
      executable: 'intiface-engine',
      websocketUrl: 'wss://example.com:12345',
      startupTimeoutMs: 100,
      autoDownload: false,
    })
    await expect(process.start(new AbortController().signal)).rejects.toThrow('requires a local')
  })

  it('reports an actionable error when Intiface Engine is not installed', async () => {
    const process = new IntifaceProcessManager({
      executable: 'dsh-toy-definitely-missing-intiface-engine',
      websocketUrl: 'ws://127.0.0.1:12345',
      startupTimeoutMs: 100,
      autoDownload: false,
    })
    await expect(process.start(new AbortController().signal)).rejects.toThrow('Could not start Intiface Engine')
  })
})
