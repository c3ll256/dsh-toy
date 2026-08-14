/** Buttplug/Intiface WebSocket provider supporting protocol versions 3 and 4. */

import WebSocket from 'ws'
import { closeWebSocket, delay, frameText, openWebSocket, sendJson } from './websocket.ts'
import {
  cloneDevices,
  ToyError,
  type ToyBackend,
  type ToyConnection,
  type ToyDevice,
  type ToyFeature,
  type ToyFeatureKind,
  type ToyLevelCommand,
} from './types.ts'

/** Configuration owned by the Buttplug provider. */
export interface ButtplugConfig {
  /** Intiface WebSocket endpoint. */
  url: string
  /** Buttplug protocol major version. */
  protocolVersion: 3 | 4
  /** WebSocket setup bound. */
  connectionTimeoutMs: number
  /** One request/response bound. */
  requestTimeoutMs: number
  /** Client name presented to Intiface. */
  clientName: string
}

type JsonObject = Record<string, unknown>

interface PendingRequest {
  timer: ReturnType<typeof setTimeout>
  signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  resolve(value: ProtocolReply): void
  reject(error: Error): void
}

interface ProtocolReply {
  type: string
  body: JsonObject
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: JsonObject, key: string, fallback = ''): string {
  return typeof value[key] === 'string' ? value[key] : fallback
}

function numberField(value: JsonObject, key: string): number | undefined {
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

function normalizeKind(value: string): ToyFeatureKind | undefined {
  switch (value.toLowerCase()) {
    case 'vibrate': return 'vibrate'
    case 'oscillate': return 'oscillate'
    case 'constrict': return 'constrict'
    case 'inflate': return 'inflate'
    default: return undefined
  }
}

function protocolKind(kind: ToyFeatureKind): string {
  switch (kind) {
    case 'vibrate': return 'Vibrate'
    case 'oscillate': return 'Oscillate'
    case 'constrict': return 'Constrict'
    case 'inflate': return 'Inflate'
    case 'suction': throw new ToyError('Buttplug does not expose the MonsterParty-only suction action')
  }
}

interface ParsedFeature extends ToyFeature {
  index: number
  range: readonly [number, number]
}

interface ParsedDevice extends ToyDevice {
  index: number
  features: ParsedFeature[]
}

function v3Features(device: JsonObject, deviceIndex: number): ParsedFeature[] {
  const messages = device.DeviceMessages
  if (!isObject(messages) || !Array.isArray(messages.ScalarCmd)) return []
  const features: ParsedFeature[] = []
  for (const [index, raw] of messages.ScalarCmd.entries()) {
    if (!isObject(raw)) continue
    const rawKind = stringField(raw, 'ActuatorType')
    const kind = normalizeKind(rawKind)
    if (kind === undefined) continue
    features.push({
      id: `buttplug:${deviceIndex}:${index}:${kind}`,
      index,
      kind,
      description: stringField(raw, 'FeatureDescriptor', `${rawKind} ${index}`),
      range: [0, 1],
    })
  }
  return features
}

function v4Features(device: JsonObject, deviceIndex: number): ParsedFeature[] {
  if (!isObject(device.DeviceFeatures)) return []
  const features: ParsedFeature[] = []
  for (const [mapIndex, raw] of Object.entries(device.DeviceFeatures)) {
    if (!isObject(raw) || !isObject(raw.Output)) continue
    const index = numberField(raw, 'FeatureIndex') ?? Number(mapIndex)
    if (!Number.isInteger(index) || index < 0) continue
    for (const [outputType, rawOutput] of Object.entries(raw.Output)) {
      const kind = normalizeKind(outputType)
      if (kind === undefined || !isObject(rawOutput) || !Array.isArray(rawOutput.Value)) continue
      const min = rawOutput.Value[0]
      const max = rawOutput.Value[1]
      if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || max <= 0) continue
      features.push({
        id: `buttplug:${deviceIndex}:${index}:${kind}`,
        index,
        kind,
        description: stringField(raw, 'FeatureDescription', `${outputType} ${index}`),
        range: [min, max],
      })
    }
  }
  return features
}

function parseDevice(raw: unknown, protocolVersion: 3 | 4, fallbackIndex?: number): ParsedDevice | undefined {
  if (!isObject(raw)) return undefined
  const index = numberField(raw, 'DeviceIndex') ?? fallbackIndex
  if (index === undefined || !Number.isInteger(index) || index < 0) return undefined
  return {
    id: `buttplug:${index}`,
    index,
    name: stringField(raw, 'DeviceName', `Buttplug device ${index}`),
    ...(typeof raw.DeviceDisplayName === 'string' ? { displayName: raw.DeviceDisplayName } : {}),
    features: protocolVersion === 4 ? v4Features(raw, index) : v3Features(raw, index),
  }
}

function parseDeviceList(body: unknown, protocolVersion: 3 | 4): ParsedDevice[] {
  if (!isObject(body)) throw new ToyError('Buttplug DeviceList body is not an object')
  const devices: ParsedDevice[] = []
  if (protocolVersion === 3) {
    if (!Array.isArray(body.Devices)) throw new ToyError('Buttplug v3 DeviceList.Devices is not an array')
    for (const raw of body.Devices) {
      const parsed = parseDevice(raw, protocolVersion)
      if (parsed !== undefined) devices.push(parsed)
    }
  } else {
    if (!isObject(body.Devices)) throw new ToyError('Buttplug v4 DeviceList.Devices is not a map')
    for (const [key, raw] of Object.entries(body.Devices)) {
      const parsed = parseDevice(raw, protocolVersion, Number(key))
      if (parsed !== undefined) devices.push(parsed)
    }
  }
  return devices
}

/** Parse a DeviceList body from Buttplug v3 or v4 into the public snapshot. */
export function parseButtplugDeviceList(body: unknown, protocolVersion: 3 | 4): ToyDevice[] {
  return cloneDevices(parseDeviceList(body, protocolVersion))
}

function protocolMessages(raw: string): ProtocolReply[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ToyError('Buttplug server sent invalid JSON')
  }
  if (!Array.isArray(parsed)) throw new ToyError('Buttplug frame is not a JSON array')
  const replies: ProtocolReply[] = []
  for (const item of parsed) {
    if (!isObject(item)) continue
    const entry = Object.entries(item)[0]
    if (entry === undefined || !isObject(entry[1])) continue
    replies.push({ type: entry[0], body: entry[1] })
  }
  return replies
}

function parseDeviceId(deviceId: string): number {
  const match = /^buttplug:(\d+)$/.exec(deviceId)
  if (match === null) throw new ToyError(`Invalid Buttplug device id: ${deviceId}`)
  return Number(match[1])
}

/** Stateful Buttplug JSON client over an Intiface WebSocket server. */
export class ButtplugBackend implements ToyBackend {
  readonly provider = 'buttplug' as const
  private socket: WebSocket | undefined
  private serverName = ''
  private nextId = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly devices = new Map<number, ParsedDevice>()
  private pingTimer: ReturnType<typeof setInterval> | undefined

  /** @param config - Validated transport and protocol configuration. */
  constructor(private readonly config: ButtplugConfig) {}

  async connect(signal: AbortSignal): Promise<ToyConnection> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return { provider: this.provider, serverName: this.serverName, devices: this.list() }
    }
    const socket = await openWebSocket(this.config.url, { perMessageDeflate: false }, this.config.connectionTimeoutMs, signal)
    this.socket = socket
    socket.on('message', data => { this.receive(frameText(data)) })
    socket.on('close', () => { this.loseConnection(new ToyError('Buttplug WebSocket closed')) })
    socket.on('error', error => {
      this.loseConnection(error)
      socket.terminate()
    })
    try {
      const handshake = this.config.protocolVersion === 4
        ? { ClientName: this.config.clientName, ProtocolVersionMajor: 4, ProtocolVersionMinor: 0 }
        : { ClientName: this.config.clientName, MessageVersion: 3 }
      const reply = await this.request('RequestServerInfo', handshake, signal)
      if (reply.type !== 'ServerInfo') throw new ToyError(`Expected ServerInfo, received ${reply.type}`)
      this.serverName = stringField(reply.body, 'ServerName', 'Intiface')
      const maxPingTime = numberField(reply.body, 'MaxPingTime') ?? 0
      this.startPings(maxPingTime)
      await this.refreshDevices(signal)
      return { provider: this.provider, serverName: this.serverName, devices: this.list() }
    } catch (error) {
      await closeWebSocket(socket)
      throw error
    }
  }

  async scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]> {
    this.assertConnected()
    await this.request('StartScanning', {}, signal)
    try {
      await delay(durationMs, signal)
    } finally {
      if (this.socket?.readyState === WebSocket.OPEN) await this.request('StopScanning', {}, undefined)
    }
    await this.refreshDevices(signal)
    return this.list()
  }

  list(): ToyDevice[] {
    return cloneDevices(this.devices.values())
  }

  async setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void> {
    this.assertConnected()
    const deviceIndex = parseDeviceId(command.deviceId)
    const device = this.devices.get(deviceIndex)
    if (device === undefined) throw new ToyError(`Buttplug device is not available: ${command.deviceId}`)
    const features = device.features.filter(feature => feature.kind === command.kind
      && (command.featureId === undefined || feature.id === command.featureId))
    if (features.length === 0) {
      throw new ToyError(`Device ${command.deviceId} has no matching ${command.kind} feature`)
    }
    if (this.config.protocolVersion === 3) {
      await this.request('ScalarCmd', {
        DeviceIndex: deviceIndex,
        Scalars: features.map(feature => ({
          Index: feature.index,
          Scalar: command.intensityPercent / 100,
          ActuatorType: protocolKind(feature.kind),
        })),
      }, signal)
      return
    }
    for (const feature of features) {
      signal.throwIfAborted()
      const value = command.intensityPercent === 0
        ? 0
        : Math.max(feature.range[0], Math.round(feature.range[1] * command.intensityPercent / 100))
      await this.request('OutputCmd', {
        DeviceIndex: deviceIndex,
        FeatureIndex: feature.index,
        Command: { [protocolKind(feature.kind)]: { Value: value } },
      }, signal)
    }
  }

  async stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void> {
    this.assertConnected()
    if (this.config.protocolVersion === 4) {
      await this.request('StopCmd', {
        ...(deviceId === undefined ? {} : { DeviceIndex: parseDeviceId(deviceId) }),
        Inputs: false,
        Outputs: true,
      }, signal)
      return
    }
    if (deviceId === undefined) await this.request('StopAllDevices', {}, signal)
    else await this.request('StopDeviceCmd', { DeviceIndex: parseDeviceId(deviceId) }, signal)
  }

  async close(): Promise<void> {
    const socket = this.socket
    if (socket === undefined) return
    this.stopPings()
    let stopFailure: unknown
    if (socket.readyState === WebSocket.OPEN) {
      try {
        await this.stop(undefined)
      } catch (error) {
        stopFailure = error
      }
    }
    await closeWebSocket(socket)
    this.loseConnection(new ToyError('Buttplug client closed'))
    if (stopFailure !== undefined) throw stopFailure
  }

  private async refreshDevices(signal: AbortSignal): Promise<void> {
    const reply = await this.request('RequestDeviceList', {}, signal)
    if (reply.type !== 'DeviceList') throw new ToyError(`Expected DeviceList, received ${reply.type}`)
  }

  private request(type: string, fields: JsonObject, signal: AbortSignal | undefined): Promise<ProtocolReply> {
    const socket = this.assertConnected()
    signal?.throwIfAborted()
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const finish = (error: Error | undefined, reply?: ProtocolReply): void => {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        if (pending.signal !== undefined && pending.onAbort !== undefined) {
          pending.signal.removeEventListener('abort', pending.onAbort)
        }
        if (error !== undefined) reject(error)
        else if (reply !== undefined) resolve(reply)
      }
      const onAbort = signal === undefined ? undefined : (): void => {
        finish(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      }
      const timer = setTimeout(() => {
        finish(new ToyError(`Buttplug ${type} timed out after ${this.config.requestTimeoutMs}ms`))
      }, this.config.requestTimeoutMs)
      this.pending.set(id, { timer, signal, onAbort, resolve, reject })
      signal?.addEventListener('abort', onAbort!, { once: true })
      void sendJson(socket, [{ [type]: { Id: id, ...fields } }]).catch((error: unknown) => {
        finish(error instanceof Error ? error : new ToyError(String(error)))
      })
    })
  }

  private receive(raw: string): void {
    let replies: ProtocolReply[]
    try {
      replies = protocolMessages(raw)
    } catch {
      const socket = this.socket
      this.loseConnection(new ToyError('Buttplug server sent a malformed frame'))
      socket?.close(1002, 'invalid protocol frame')
      return
    }
    for (const reply of replies) {
      try {
        this.applyEvent(reply)
      } catch (error) {
        const socket = this.socket
        this.loseConnection(error instanceof Error ? error : new ToyError(String(error)))
        socket?.close(1002, 'invalid protocol message')
        return
      }
      const id = numberField(reply.body, 'Id')
      if (id === undefined || id === 0) continue
      const pending = this.pending.get(id)
      if (pending === undefined) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (pending.signal !== undefined && pending.onAbort !== undefined) {
        pending.signal.removeEventListener('abort', pending.onAbort)
      }
      if (reply.type === 'Error') pending.reject(new ToyError(stringField(reply.body, 'ErrorMessage', 'Buttplug request failed')))
      else pending.resolve(reply)
    }
  }

  private applyEvent(reply: ProtocolReply): void {
    if (reply.type === 'DeviceList') {
      const parsed = parseDeviceList(reply.body, this.config.protocolVersion)
      this.devices.clear()
      for (const device of parsed) this.devices.set(device.index, device)
      return
    }
    if (this.config.protocolVersion !== 3) return
    if (reply.type === 'DeviceAdded') {
      const device = parseDevice(reply.body, 3)
      if (device !== undefined) this.devices.set(device.index, device)
    } else if (reply.type === 'DeviceRemoved') {
      const index = numberField(reply.body, 'DeviceIndex')
      if (index !== undefined) this.devices.delete(index)
    }
  }

  private startPings(maxPingTime: number): void {
    this.stopPings()
    if (!Number.isFinite(maxPingTime) || maxPingTime <= 0) return
    const interval = Math.max(100, Math.floor(maxPingTime / 2))
    this.pingTimer = setInterval(() => {
      void this.request('Ping', {}, undefined).catch((error: unknown) => {
        const socket = this.socket
        this.loseConnection(error instanceof Error ? error : new ToyError(String(error)))
        socket?.terminate()
      })
    }, interval)
  }

  private stopPings(): void {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer)
    this.pingTimer = undefined
  }

  private loseConnection(error: Error): void {
    this.stopPings()
    this.socket = undefined
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (pending.signal !== undefined && pending.onAbort !== undefined) {
        pending.signal.removeEventListener('abort', pending.onAbort)
      }
      pending.reject(error)
    }
  }

  private assertConnected(): WebSocket {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new ToyError('Not connected to Intiface; call toy_connect first')
    }
    return socket
  }
}
