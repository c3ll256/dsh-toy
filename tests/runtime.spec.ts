import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToyRuntime } from '../src/runtime.ts'
import type {
  ToyBackend,
  ToyConnection,
  ToyDevice,
  ToyLevelCommand,
} from '../src/types.ts'

class FakeBackend implements ToyBackend {
  readonly provider = 'buttplug' as const
  readonly commands: ToyLevelCommand[] = []
  readonly stops: Array<string | undefined> = []
  closed = false

  connect(_signal: AbortSignal): Promise<ToyConnection> {
    return Promise.resolve({ provider: this.provider, serverName: 'fake', devices: this.list() })
  }

  scan(_durationMs: number, _signal: AbortSignal): Promise<ToyDevice[]> {
    return Promise.resolve(this.list())
  }

  list(): ToyDevice[] {
    return [{
      id: 'buttplug:0',
      name: 'Fake',
      features: [{ id: 'buttplug:0:0:vibrate', kind: 'vibrate', description: 'motor' }],
    }]
  }

  setLevel(command: ToyLevelCommand, _signal: AbortSignal): Promise<void> {
    this.commands.push(command)
    return Promise.resolve()
  }

  stop(deviceId: string | undefined): Promise<void> {
    this.stops.push(deviceId)
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ToyRuntime', () => {
  it('replaces an older automatic stop without stopping the newer command', async () => {
    vi.useFakeTimers()
    const backend = new FakeBackend()
    const runtime = new ToyRuntime(backend, {
      defaultDurationSeconds: 1,
      maxDurationSeconds: 10,
      maxIntensityPercent: 80,
      allowHold: false,
    }, error => { throw error })
    const signal = new AbortController().signal

    await runtime.control({
      deviceId: 'buttplug:0',
      kind: 'vibrate',
      intensityPercent: 70,
      durationSeconds: 1,
    }, signal)
    await vi.advanceTimersByTimeAsync(500)
    await runtime.control({
      deviceId: 'buttplug:0',
      kind: 'vibrate',
      intensityPercent: 50,
      durationSeconds: 2,
    }, signal)
    await vi.advanceTimersByTimeAsync(600)
    expect(backend.stops).toEqual([])
    await vi.advanceTimersByTimeAsync(1_400)
    expect(backend.stops).toEqual(['buttplug:0'])

    await runtime.close()
  })

  it('rejects policy violations before calling the provider', async () => {
    const backend = new FakeBackend()
    const runtime = new ToyRuntime(backend, {
      defaultDurationSeconds: 1,
      maxDurationSeconds: 5,
      maxIntensityPercent: 60,
      allowHold: false,
    }, () => {})
    const signal = new AbortController().signal

    expect(() => runtime.control({
      deviceId: 'buttplug:0',
      kind: 'vibrate',
      intensityPercent: 61,
    }, signal)).toThrow('0 to 60')
    expect(() => runtime.control({
      deviceId: 'buttplug:0',
      kind: 'vibrate',
      intensityPercent: 40,
      durationSeconds: 0,
    }, signal)).toThrow('duration_seconds=0 is disabled')
    expect(backend.commands).toEqual([])

    await runtime.close()
  })

  it('awaits provider close and rejects later operations', async () => {
    const backend = new FakeBackend()
    const runtime = new ToyRuntime(backend, {
      defaultDurationSeconds: 1,
      maxDurationSeconds: 5,
      maxIntensityPercent: 100,
      allowHold: false,
    }, () => {})
    await runtime.close()
    expect(backend.closed).toBe(true)
    await expect(runtime.list(new AbortController().signal)).rejects.toThrow('shutting down')
  })
})
