import { describe, expect, it } from 'vitest'
import { AutoToyBackend, IntifaceProcessManager, routeToyTarget } from '../src/auto.ts'
import { selectIntifaceArtifact } from '../src/intiface-download.ts'

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
