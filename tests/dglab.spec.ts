import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DgLabBackend,
  strengthCmd,
  clearCmd,
  pulseCmd,
  mapIntensityToStrength,
  buildQrPayload,
  parseFrame,
  parseStrengthFeedback,
  MAX_MESSAGE_LENGTH,
  MAX_PULSE_PER_SEND,
  DEFAULT_STRENGTH_LIMIT,
  type DgLabConfig,
} from '../src/dglab/index.ts'
import { MockDgLabApp, parseQrPayload } from './helpers/mock-dglab-app.ts'

// ─── Test fixture management ─────────────────────────────────────────────────

const backends: DgLabBackend[] = []
const apps: MockDgLabApp[] = []

function makeConfig(overrides: Partial<DgLabConfig> = {}): DgLabConfig {
  return {
    listenPort: 0,
    publicHost: '127.0.0.1',
    wsScheme: 'ws',
    heartbeatIntervalMs: 60_000,
    maxStrength: 200,
    readyTimeoutMs: 60_000,
    ...overrides,
  }
}

/** Create a backend, connect it, and bind a mock App — the standard test setup. */
async function setupBound(overrides: Partial<DgLabConfig> = {}): Promise<{ backend: DgLabBackend; app: MockDgLabApp; signal: AbortSignal }> {
  const backend = new DgLabBackend(makeConfig(overrides))
  backends.push(backend)
  const signal = new AbortController().signal
  await backend.connect(signal)

  const app = new MockDgLabApp()
  apps.push(app)
  await app.connect(backend.getQrPayload(), 3_000)
  await backend.scan(1_000, signal)

  return { backend, app, signal }
}

afterEach(async () => {
  // Proper resource cleanup — close all apps and backends.
  for (const app of apps.splice(0)) {
    try { await app.disconnect() } catch { /* noop */ }
  }
  for (const backend of backends.splice(0)) {
    try { await backend.close() } catch { /* noop */ }
  }
})

// ─── Command generation unit tests ──────────────────────────────────────────

describe('DG-LAB command generation', () => {
  it('builds strength commands with the correct format', () => {
    expect(strengthCmd('1', '2', 100)).toBe('strength-1+2+100')
    expect(strengthCmd('2', '2', 0)).toBe('strength-2+2+0')
    expect(strengthCmd('1', '1', 5)).toBe('strength-1+1+5')
    expect(strengthCmd('2', '0', 20)).toBe('strength-2+0+20')
  })

  it('clamps strength values to 0-200', () => {
    expect(strengthCmd('1', '2', 300)).toBe('strength-1+2+200')
    expect(strengthCmd('2', '2', -10)).toBe('strength-2+2+0')
    expect(strengthCmd('1', '2', 50.7)).toBe('strength-1+2+51')
  })

  it('builds clear commands with numeric channels (1=A, 2=B)', () => {
    expect(clearCmd('1')).toBe('clear-1')
    expect(clearCmd('2')).toBe('clear-2')
  })

  it('builds pulse commands with letter channels (A/B)', () => {
    expect(pulseCmd('A', ['0a0a0a0a14141414'])).toBe('pulse-A:["0a0a0a0a14141414"]')
    expect(pulseCmd('B', ['0f0f0f0f5a5a5a5a', '0a0a0a0a64646464'])).toBe(
      'pulse-B:["0f0f0f0f5a5a5a5a","0a0a0a0a64646464"]',
    )
  })

  it('caps pulse array at MAX_PULSE_PER_SEND entries', () => {
    const many = Array.from({ length: MAX_PULSE_PER_SEND + 5 }, () => '0a0a0a0a14141414')
    const cmd = pulseCmd('A', many)
    const jsonStr = cmd.slice('pulse-A:'.length)
    const arr = JSON.parse(jsonStr) as string[]
    expect(arr).toHaveLength(MAX_PULSE_PER_SEND)
  })

  it('handles an empty pulse array', () => {
    expect(pulseCmd('A', [])).toBe('pulse-A:[]')
  })

  it('truncates pulse arrays that exceed the 1950-character message limit', () => {
    const huge = Array.from({ length: 120 }, () => '0a0a0a0a14141414')
    const cmd = pulseCmd('A', huge)
    expect(cmd.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH)
    const jsonStr = cmd.slice('pulse-A:'.length)
    const arr = JSON.parse(jsonStr) as string[]
    expect(arr.length).toBeLessThanOrEqual(MAX_PULSE_PER_SEND)
    expect(arr.length).toBeGreaterThan(0)
  })

  it('truncates pulse arrays to fit within a smaller frame budget (m1)', () => {
    const huge = Array.from({ length: MAX_PULSE_PER_SEND }, () => '0a0a0a0a14141414')
    const smallBudget = 100
    const cmd = pulseCmd('A', huge, smallBudget)
    expect(cmd.length).toBeLessThanOrEqual(smallBudget)
    const jsonStr = cmd.slice('pulse-A:'.length)
    const arr = JSON.parse(jsonStr) as string[]
    expect(arr.length).toBeGreaterThan(0)
    expect(arr.length).toBeLessThan(MAX_PULSE_PER_SEND)
  })

  it('throws on hex strings that are not 16 chars', () => {
    expect(() => pulseCmd('A', ['short'])).toThrow(/16 chars/)
    expect(() => pulseCmd('A', ['0a0a0a0a14141414', 'too-long-hex-string'])).toThrow(/16 chars/)
    expect(() => pulseCmd('A', ['0a0a0a0a141414'])).toThrow(/16 chars/)
  })
})

// ─── Strength mapping unit tests ─────────────────────────────────────────────

describe('mapIntensityToStrength', () => {
  it('maps 0% to 0', () => {
    const result = mapIntensityToStrength(0, 200, 200, 200)
    expect(result).toEqual({ a: 0, b: 0 })
  })

  it('maps 100% to maxStrength', () => {
    const result = mapIntensityToStrength(100, 200, 200, 200)
    expect(result).toEqual({ a: 200, b: 200 })
  })

  it('maps 50% to half of maxStrength', () => {
    const result = mapIntensityToStrength(50, 200, 200, 200)
    expect(result).toEqual({ a: 100, b: 100 })
  })

  it('clamps negative intensity to 0', () => {
    const result = mapIntensityToStrength(-10, 200, 200, 200)
    expect(result).toEqual({ a: 0, b: 0 })
  })

  it('clamps intensity over 100% to maxStrength', () => {
    const result = mapIntensityToStrength(150, 200, 200, 200)
    expect(result).toEqual({ a: 200, b: 200 })
  })

  it('clamps to device-reported limits', () => {
    const result = mapIntensityToStrength(100, 200, 50, 80)
    expect(result).toEqual({ a: 50, b: 80 })
  })

  it('works with non-default maxStrength', () => {
    const result = mapIntensityToStrength(50, 100, 100, 100)
    expect(result).toEqual({ a: 50, b: 50 })
  })
})

// ─── QR payload and frame parsing unit tests ─────────────────────────────────

describe('QR payload and frame parsing', () => {
  it('builds QR payload with the correct three-segment format', () => {
    const payload = buildQrPayload('ws://192.168.1.100:56789', 'abc123')
    expect(payload).toBe('https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#ws://192.168.1.100:56789/abc123')
    expect(payload.split('#')).toHaveLength(3)
  })

  it('strips trailing slash from wsUrl in QR payload', () => {
    const payload = buildQrPayload('ws://host:8080/', 'ctrl-1')
    expect(payload).toBe('https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#ws://host:8080/ctrl-1')
  })

  it('parseQrPayload extracts wsUrl and controlId', () => {
    const payload = buildQrPayload('ws://127.0.0.1:12345', 'my-control-id')
    const { wsUrl, controlId } = parseQrPayload(payload)
    expect(wsUrl).toBe('ws://127.0.0.1:12345')
    expect(controlId).toBe('my-control-id')
  })

  it('parseFrame handles valid frames', () => {
    const result = parseFrame('{"type":"msg","clientId":"c1","targetId":"a1","message":"strength-1+2+50"}')
    expect(result).toEqual({ type: 'msg', clientId: 'c1', targetId: 'a1', message: 'strength-1+2+50' })
  })

  it('parseFrame returns undefined for invalid JSON', () => {
    expect(parseFrame('not json')).toBeUndefined()
  })

  it('parseFrame returns undefined for JSON arrays', () => {
    expect(parseFrame('[1,2,3]')).toBeUndefined()
  })

  it('parseFrame returns undefined for objects missing required fields', () => {
    expect(parseFrame('{"type":"msg"}')).toBeUndefined()
    expect(parseFrame('{"type":"msg","clientId":"c","targetId":"t"}')).toBeUndefined()
  })

  it('parseStrengthFeedback parses valid feedback', () => {
    expect(parseStrengthFeedback('strength-50+60+100+120')).toEqual({ a: 50, b: 60, limitA: 100, limitB: 120 })
  })

  it('parseStrengthFeedback returns undefined for invalid format', () => {
    expect(parseStrengthFeedback('not-strength')).toBeUndefined()
    expect(parseStrengthFeedback('strength-50+60')).toBeUndefined()
    expect(parseStrengthFeedback('strength-abc+def+ghi+jkl')).toBeUndefined()
  })

  it('clamps strength feedback values to 0-200 (m8)', () => {
    expect(parseStrengthFeedback('strength-999+888+777+666')).toEqual({ a: 200, b: 200, limitA: 200, limitB: 200 })
    expect(parseStrengthFeedback('strength-0+0+0+0')).toEqual({ a: 0, b: 0, limitA: 0, limitB: 0 })
    expect(parseStrengthFeedback('strength-201+1+200+201')).toEqual({ a: 200, b: 1, limitA: 200, limitB: 200 })
  })
})

// ─── Integration tests: full binding flow ────────────────────────────────────

describe('DG-LAB mock App binding', () => {
  it('completes the full flow: connect → bind → setLevel → stop → close', async () => {
    const { backend, app, signal } = await setupBound()

    // Verify binding succeeded
    expect(backend.isReady()).toBe(true)
    expect(app.isBound).toBe(true)

    // SetLevel — test intensity control
    await backend.setLevel({
      deviceId: 'dglab:coyote',
      featureId: 'dglab:coyote:a',
      kind: 'vibrate',
      intensityPercent: 50,
    }, signal)

    await app.waitForCommands(1)
    expect(app.commands).toContain('strength-1+2+100')

    // Stop — zero channels and clear queues
    await backend.stop(undefined, signal)

    await app.waitForCommands(5)
    expect(app.commands).toContain('strength-1+2+0')
    expect(app.commands).toContain('strength-2+2+0')
    expect(app.commands).toContain('clear-1')
    expect(app.commands).toContain('clear-2')
  })

  it('generates a QR code image file on connect', async () => {
    const { backend } = await setupBound()

    // Verify getQrPath returns a real file
    const qrPath = backend.getQrPath()
    expect(qrPath.length).toBeGreaterThan(0)
    expect(existsSync(qrPath)).toBe(true)
  })

  it('exposes QR payload string', async () => {
    const { backend } = await setupBound()

    const payload = backend.getQrPayload()
    expect(payload).toContain('DGLAB-SOCKET')
    expect(payload).toContain('ws://127.0.0.1:')
  })

  it('returns correct port after connect', async () => {
    const { backend } = await setupBound()

    expect(backend.getActualPort()).toBeGreaterThan(0)
  })

  it('scan returns device list when already bound', async () => {
    const { backend, signal } = await setupBound()

    const devices = await backend.scan(1_000, signal)
    expect(devices).toHaveLength(1)
    expect(devices[0]!.id).toBe('dglab:coyote')
    expect(devices[0]!.features).toHaveLength(2)
  })

  it('list returns empty before binding', async () => {
    const backend = new DgLabBackend(makeConfig())
    backends.push(backend)
    const signal = new AbortController().signal
    await backend.connect(signal)

    expect(backend.list()).toEqual([])
  })
})

// ─── Strength control tests ──────────────────────────────────────────────────

describe('DG-LAB strength control', () => {
  it('respects maxStrength configuration', async () => {
    const { backend, app, signal } = await setupBound({ maxStrength: 100 })

    await backend.setLevel({
      deviceId: 'dglab:coyote',
      featureId: 'dglab:coyote:a',
      kind: 'vibrate',
      intensityPercent: 100,
    }, signal)

    await app.waitForCommands(1)
    // 100 * 100 / 100 = 100 (not 200)
    expect(app.commands).toContain('strength-1+2+100')
  })

  it('clamps strength to device-reported limits', async () => {
    const { backend, app, signal } = await setupBound()

    // App reports limits: A max=50, B max=80
    app.sendStrengthFeedback(0, 0, 50, 80)
    await new Promise(resolve => setTimeout(resolve, 100))

    const strength = backend.getStrength()
    expect(strength.limitA).toBe(50)
    expect(strength.limitB).toBe(80)

    // 100% → target 200, clamped to limitA=50
    await backend.setLevel({
      deviceId: 'dglab:coyote',
      featureId: 'dglab:coyote:a',
      kind: 'vibrate',
      intensityPercent: 100,
    }, signal)

    await app.waitForCommands(1)
    expect(app.commands).toContain('strength-1+2+50')
  })

  it('handles intensityPercent of 0', async () => {
    const { backend, app, signal } = await setupBound()

    await backend.setLevel({
      deviceId: 'dglab:coyote',
      kind: 'vibrate',
      intensityPercent: 0,
    }, signal)

    await app.waitForCommands(2)
    expect(app.commands).toContain('strength-1+2+0')
    expect(app.commands).toContain('strength-2+2+0')
  })

  it('clamps intensityPercent over 100', async () => {
    const { backend, app, signal } = await setupBound()

    await backend.setLevel({
      deviceId: 'dglab:coyote',
      featureId: 'dglab:coyote:a',
      kind: 'vibrate',
      intensityPercent: 150,
    }, signal)

    await app.waitForCommands(1)
    expect(app.commands).toContain('strength-1+2+200')
  })

  it('clamps negative intensityPercent', async () => {
    const { backend, app, signal } = await setupBound()

    await backend.setLevel({
      deviceId: 'dglab:coyote',
      featureId: 'dglab:coyote:a',
      kind: 'vibrate',
      intensityPercent: -10,
    }, signal)

    await app.waitForCommands(1)
    expect(app.commands).toContain('strength-1+2+0')
  })

  it('controls both channels when featureId is omitted', async () => {
    const { backend, app, signal } = await setupBound()

    await backend.setLevel({
      deviceId: 'dglab:coyote',
      kind: 'vibrate',
      intensityPercent: 50,
    }, signal)

    await app.waitForCommands(2)
    expect(app.commands).toContain('strength-1+2+100')
    expect(app.commands).toContain('strength-2+2+100')
  })

  it('controls channel B independently', async () => {
    const { backend, app, signal } = await setupBound()

    await backend.setLevel({
      deviceId: 'dglab:coyote',
      featureId: 'dglab:coyote:b',
      kind: 'vibrate',
      intensityPercent: 25,
    }, signal)

    await app.waitForCommands(1)
    expect(app.commands).toContain('strength-2+2+50')
    expect(app.commands).not.toContain('strength-1+2+50')
  })
})

// ─── Advanced operations tests ───────────────────────────────────────────────

describe('DG-LAB advanced operations', () => {
  it('sends pulse waveform patterns via sendPulse', async () => {
    const { backend, app, signal } = await setupBound()

    await backend.sendPulse('A', ['0a0a0a0a14141414', '0f0f0f0f1e1e1e1e'], signal)

    await app.waitForCommands(1)
    expect(app.commands).toContain('pulse-A:["0a0a0a0a14141414","0f0f0f0f1e1e1e1e"]')
  })

  it('clears waveform queues via clearQueue', async () => {
    const { backend, app, signal } = await setupBound()

    await backend.clearQueue('1', signal)
    await backend.clearQueue('2', signal)

    await app.waitForCommands(2)
    expect(app.commands).toContain('clear-1')
    expect(app.commands).toContain('clear-2')
  })

  it('adjusts strength via adjustStrength with increment mode', async () => {
    const { backend, app, signal } = await setupBound()

    await backend.adjustStrength('1', '1', 10, signal)
    await backend.adjustStrength('2', '0', 5, signal)

    await app.waitForCommands(2)
    expect(app.commands).toContain('strength-1+1+10')
    expect(app.commands).toContain('strength-2+0+5')
  })

  it('clamps adjustStrength to device limits', async () => {
    const { backend, app, signal } = await setupBound()

    // App reports limitA=50
    app.sendStrengthFeedback(0, 0, 50, 200)
    await new Promise(resolve => setTimeout(resolve, 100))

    // Request delta=100 but clamped to limitA=50
    await backend.adjustStrength('1', '1', 100, signal)

    await app.waitForCommands(1)
    expect(app.commands).toContain('strength-1+1+50')
  })
})

// ─── State accessors tests ───────────────────────────────────────────────────

describe('DG-LAB state accessors', () => {
  it('exposes correct state before and after binding', async () => {
    const backend = new DgLabBackend(makeConfig())
    backends.push(backend)
    const signal = new AbortController().signal

    expect(backend.isReady()).toBe(false)
    expect(backend.getActualPort()).toBe(0)

    await backend.connect(signal)
    expect(backend.isReady()).toBe(false)
    expect(backend.getActualPort()).toBeGreaterThan(0)

    const initial = backend.getStrength()
    expect(initial).toEqual({ a: 0, b: 0, limitA: DEFAULT_STRENGTH_LIMIT, limitB: DEFAULT_STRENGTH_LIMIT })
  })

  it('parses strength feedback from App', async () => {
    const { backend, app } = await setupBound()

    app.sendStrengthFeedback(50, 60, 100, 120)
    await new Promise(resolve => setTimeout(resolve, 100))

    const strength = backend.getStrength()
    expect(strength).toEqual({ a: 50, b: 60, limitA: 100, limitB: 120 })
  })

  it('resets state after close', async () => {
    const { backend } = await setupBound()

    expect(backend.isReady()).toBe(true)
    await backend.close()
    expect(backend.isReady()).toBe(false)
    expect(backend.getActualPort()).toBe(0)
  })
})

// ─── Error path tests ────────────────────────────────────────────────────────

describe('DG-LAB error paths', () => {
  it('throws on unknown deviceId in setLevel', async () => {
    const { backend, signal } = await setupBound()

    await expect(backend.setLevel({
      deviceId: 'unknown-device',
      kind: 'vibrate',
      intensityPercent: 50,
    }, signal)).rejects.toThrow(/Unknown DG-LAB device/)
  })

  it('throws on unknown featureId in setLevel', async () => {
    const { backend, signal } = await setupBound()

    await expect(backend.setLevel({
      deviceId: 'dglab:coyote',
      featureId: 'dglab:coyote:c',
      kind: 'vibrate',
      intensityPercent: 50,
    }, signal)).rejects.toThrow(/Unknown DG-LAB feature/)
  })

  it('throws on unsupported kind in setLevel', async () => {
    const { backend, signal } = await setupBound()

    await expect(backend.setLevel({
      deviceId: 'dglab:coyote',
      kind: 'oscillate',
      intensityPercent: 50,
    }, signal)).rejects.toThrow(/does not support/)
  })

  it('throws on unknown deviceId in stop', async () => {
    const { backend, signal } = await setupBound()

    await expect(backend.stop('unknown', signal)).rejects.toThrow(/Unknown DG-LAB device/)
  })

  it('stop is safe when not bound', async () => {
    const backend = new DgLabBackend(makeConfig())
    backends.push(backend)
    const signal = new AbortController().signal
    await backend.connect(signal)

    // Should not throw
    await backend.stop(undefined, signal)
  })

  it('stop throws on unknown deviceId even when not bound (m2)', async () => {
    const backend = new DgLabBackend(makeConfig())
    backends.push(backend)
    const signal = new AbortController().signal
    await backend.connect(signal)

    await expect(backend.stop('unknown', signal)).rejects.toThrow(/Unknown DG-LAB device/)
  })

  it('throws on setLevel when not bound', async () => {
    const backend = new DgLabBackend(makeConfig())
    backends.push(backend)
    const signal = new AbortController().signal
    await backend.connect(signal)

    await expect(backend.setLevel({
      deviceId: 'dglab:coyote',
      kind: 'vibrate',
      intensityPercent: 50,
    }, signal)).rejects.toThrow(/not bound/)
  })

  it('throws on sendPulse when not bound', async () => {
    const backend = new DgLabBackend(makeConfig())
    backends.push(backend)
    const signal = new AbortController().signal
    await backend.connect(signal)

    await expect(backend.sendPulse('A', ['0a0a0a0a14141414'], signal)).rejects.toThrow(/not bound/)
  })

  it('throws on clearQueue when not bound', async () => {
    const backend = new DgLabBackend(makeConfig())
    backends.push(backend)
    const signal = new AbortController().signal
    await backend.connect(signal)

    await expect(backend.clearQueue('1', signal)).rejects.toThrow(/not bound/)
  })

  it('throws on adjustStrength when not bound', async () => {
    const backend = new DgLabBackend(makeConfig())
    backends.push(backend)
    const signal = new AbortController().signal
    await backend.connect(signal)

    await expect(backend.adjustStrength('1', '1', 10, signal)).rejects.toThrow(/not bound/)
  })
})

// ─── Exception frame handling tests ──────────────────────────────────────────

describe('DG-LAB exception frame handling', () => {
  it('handles error frames without crashing', async () => {
    const { backend, app, signal } = await setupBound()

    app.sendError('400')
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(backend.isReady()).toBe(true)

    // Still operational
    await backend.setLevel({
      deviceId: 'dglab:coyote',
      featureId: 'dglab:coyote:a',
      kind: 'vibrate',
      intensityPercent: 10,
    }, signal)
  })

  it('handles break frames by disconnecting', async () => {
    const { backend, app } = await setupBound()

    app.sendBreak()
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(backend.isReady()).toBe(false)
    expect(backend.list()).toEqual([])
  })

  it('handles malformed JSON without crashing', async () => {
    const { backend, app, signal } = await setupBound()

    app.sendRaw('not valid json')
    app.sendRaw('[1,2,3]')
    app.sendRaw('{"type":"msg"}')
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(backend.isReady()).toBe(true)

    // Still operational
    await backend.setLevel({
      deviceId: 'dglab:coyote',
      featureId: 'dglab:coyote:a',
      kind: 'vibrate',
      intensityPercent: 10,
    }, signal)
  })

  it('handles feedback button events without crashing', async () => {
    const { backend, app, signal } = await setupBound()

    app.sendRaw('{"type":"msg","clientId":"c","targetId":"a","message":"feedback-5"}')
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(backend.isReady()).toBe(true)

    // Still operational
    await backend.setLevel({
      deviceId: 'dglab:coyote',
      kind: 'vibrate',
      intensityPercent: 10,
    }, signal)
  })
})

// ─── Idempotency and lifecycle tests ─────────────────────────────────────────

describe('DG-LAB idempotency and lifecycle', () => {
  it('connect is idempotent', async () => {
    const backend = new DgLabBackend(makeConfig())
    backends.push(backend)
    const signal = new AbortController().signal

    const conn1 = await backend.connect(signal)
    const port1 = backend.getActualPort()

    const conn2 = await backend.connect(signal)
    const port2 = backend.getActualPort()

    expect(port1).toBe(port2)
    expect(conn2.provider).toBe('dglab')
  })

  it('close is idempotent', async () => {
    const { backend } = await setupBound()

    await backend.close()
    // Second close should not throw
    await backend.close()
    expect(backend.isReady()).toBe(false)
  })

  it('can reconnect after close', async () => {
    const { backend } = await setupBound()
    const signal = new AbortController().signal

    await backend.close()
    expect(backend.isReady()).toBe(false)

    // Should be able to connect again
    await backend.connect(signal)
    expect(backend.getActualPort()).toBeGreaterThan(0)
  })

  it('scan returns empty when binding times out', async () => {
    const backend = new DgLabBackend(makeConfig({ readyTimeoutMs: 200 }))
    backends.push(backend)
    const signal = new AbortController().signal

    await backend.connect(signal)
    const devices = await backend.scan(100, signal)
    expect(devices).toEqual([])
  })
})

// ─── AbortSignal tests ───────────────────────────────────────────────────────

describe('DG-LAB AbortSignal handling', () => {
  it('connect throws on pre-aborted signal', async () => {
    const backend = new DgLabBackend(makeConfig())
    backends.push(backend)
    const controller = new AbortController()
    controller.abort()

    await expect(backend.connect(controller.signal)).rejects.toThrow()
  })

  it('scan throws on pre-aborted signal', async () => {
    const backend = new DgLabBackend(makeConfig())
    backends.push(backend)
    const signal = new AbortController().signal
    await backend.connect(signal)

    const controller = new AbortController()
    controller.abort()
    await expect(backend.scan(1_000, controller.signal)).rejects.toThrow()
  })

  it('setLevel throws on pre-aborted signal', async () => {
    const { backend } = await setupBound()

    const controller = new AbortController()
    controller.abort()
    await expect(backend.setLevel({
      deviceId: 'dglab:coyote',
      kind: 'vibrate',
      intensityPercent: 50,
    }, controller.signal)).rejects.toThrow()
  })

  it('stop throws on pre-aborted signal', async () => {
    const { backend } = await setupBound()

    const controller = new AbortController()
    controller.abort()
    await expect(backend.stop(undefined, controller.signal)).rejects.toThrow()
  })
})

// ─── Second App rejection test ───────────────────────────────────────────────

describe('DG-LAB second App rejection', () => {
  it('rejects a second App with 400', async () => {
    const { backend, app } = await setupBound()
    expect(backend.isReady()).toBe(true)

    // Second App connects
    const app2 = new MockDgLabApp()
    apps.push(app2)
    await app2.connect(backend.getQrPayload(), 1_000).catch(() => { /* expected to fail or get 400 */ })

    // Backend should still be bound to the first App
    expect(backend.isReady()).toBe(true)

    // Second app should have received a 400
    const bindFrames = app2.frames.filter(f => f.type === 'bind')
    expect(bindFrames.some(f => f.message === '400')).toBe(true)
  })
})

// ─── Heartbeat and rebind tests ──────────────────────────────────────────────

describe('DG-LAB heartbeat and rebind', () => {
  it('restarts heartbeat after App rebind (M1)', async () => {
    const { backend, app } = await setupBound({ heartbeatIntervalMs: 50 })

    // Disconnect the first App — triggers markAppDisconnected() which stops heartbeat.
    await app.disconnect()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(backend.isReady()).toBe(false)

    // Rebind with a new App.
    const app2 = new MockDgLabApp()
    apps.push(app2)
    await app2.connect(backend.getQrPayload(), 3_000)
    const signal = new AbortController().signal
    await backend.scan(1_000, signal)
    expect(backend.isReady()).toBe(true)

    // Wait for at least 2 heartbeat intervals for the backend to send heartbeats.
    await new Promise(resolve => setTimeout(resolve, 200))

    // Verify the new App received heartbeat frames — proves heartbeat restarted.
    const heartbeats = app2.frames.filter(f => f.type === 'heartbeat')
    expect(heartbeats.length).toBeGreaterThan(0)
  })

  it('completes full disconnect → rebind flow', async () => {
    const { backend, app, signal } = await setupBound()

    // Verify initially bound.
    expect(backend.isReady()).toBe(true)
    expect(backend.list()).toHaveLength(1)

    // Disconnect the App.
    await app.disconnect()
    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify backend detected the disconnect.
    expect(backend.isReady()).toBe(false)
    expect(backend.list()).toEqual([])

    // Rebind with a new App.
    const app2 = new MockDgLabApp()
    apps.push(app2)
    await app2.connect(backend.getQrPayload(), 3_000)
    await backend.scan(1_000, signal)

    // Verify backend is rebound.
    expect(backend.isReady()).toBe(true)
    expect(backend.list()).toHaveLength(1)

    // Verify commands work with the new App.
    await backend.setLevel({
      deviceId: 'dglab:coyote',
      featureId: 'dglab:coyote:a',
      kind: 'vibrate',
      intensityPercent: 50,
    }, signal)

    await app2.waitForCommands(1)
    expect(app2.commands).toContain('strength-1+2+100')
  })

  it('sends break code 210 (server disconnect) on close (m3)', async () => {
    const { backend, app } = await setupBound()

    // Close the backend — it should send a 210 break frame before closing.
    await backend.close()
    await new Promise(resolve => setTimeout(resolve, 100))

    const breakFrames = app.frames.filter(f => f.type === 'break')
    expect(breakFrames.some(f => f.message === '210')).toBe(true)
  })

  it('serverName does not expose QR payload or controlId (m5)', async () => {
    const backend = new DgLabBackend(makeConfig())
    backends.push(backend)
    const signal = new AbortController().signal
    const conn = await backend.connect(signal)

    // ServerName must not contain the QR payload (which includes the controlId secret).
    expect(conn.serverName).not.toContain('DGLAB-SOCKET')
    expect(conn.serverName).not.toContain('dungeon-lab.com')
    // The QR payload string itself should not appear in serverName.
    const payload = backend.getQrPayload()
    expect(conn.serverName).not.toContain(payload)
  })
})
