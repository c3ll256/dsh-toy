/** MonsterParty/Ankni remote-link provider based on the Chemtrails protocol notes. */

import WebSocket from 'ws'
import { closeWebSocket, frameText, openWebSocket, sendJson } from './websocket.ts'
import {
  cloneDevices,
  ToyError,
  type ToyBackend,
  type ToyConnection,
  type ToyDevice,
  type ToyLevelCommand,
} from './types.ts'

/** Configuration owned by the MonsterParty provider. */
export interface MonsterPartyConfig {
  /** Single-use token extracted from a remote share link. */
  sessionToken: string
  /** API endpoint resolving token to WebSocket session details. */
  apiUrl: string
  /** Origin expected by the MonsterParty WebSocket relay. */
  origin: string
  /** User-Agent sent during WebSocket negotiation. */
  userAgent: string
  /** HTTP and WebSocket setup bound. */
  connectionTimeoutMs: number
  /** Device-ready handshake bound. */
  readyTimeoutMs: number
  /** Application heartbeat interval. */
  heartbeatIntervalMs: number
}

type JsonObject = Record<string, unknown>

interface SessionInfo {
  socketUrl: string
  sessionId: string | number
  userId: string | number
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSessionInfo(value: unknown): SessionInfo {
  if (!isObject(value) || !isObject(value.data)) throw new ToyError('MonsterParty session response has no data object')
  const socketUrl = value.data.socket_url
  const sessionId = value.data.id
  const userId = value.data.user_id
  if (typeof socketUrl !== 'string' || socketUrl.length === 0) throw new ToyError('MonsterParty session response has no socket_url')
  if ((typeof sessionId !== 'string' && typeof sessionId !== 'number')
    || (typeof userId !== 'string' && typeof userId !== 'number')) {
    throw new ToyError('MonsterParty session response has invalid id or user_id')
  }
  return { socketUrl, sessionId, userId }
}

function parseFrame(raw: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** In-process MonsterParty client with application heartbeats and dual-motor mapping. */
export class MonsterPartyBackend implements ToyBackend {
  readonly provider = 'monsterparty' as const
  private socket: WebSocket | undefined
  private senderFd: string | number | undefined
  private pid = ''
  private keyType: 'suck' | 'vib' = 'vib'
  private dualMotor = false
  private ready = false
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private vibration = 0
  private suction = 0

  /** @param config - Validated remote-link and heartbeat configuration. */
  constructor(private readonly config: MonsterPartyConfig) {}

  async connect(signal: AbortSignal): Promise<ToyConnection> {
    if (this.socket?.readyState === WebSocket.OPEN && this.ready) {
      return { provider: this.provider, serverName: 'MonsterParty', devices: this.list() }
    }
    const session = await this.resolveSession(signal)
    const socket = await openWebSocket(session.socketUrl, {
      headers: {
        Origin: this.config.origin,
        'User-Agent': this.config.userAgent,
      },
      perMessageDeflate: false,
    }, this.config.connectionTimeoutMs, signal)
    this.socket = socket
    socket.on('close', () => { this.markDisconnected() })
    socket.on('error', () => { this.markDisconnected() })
    socket.on('message', data => {
      const message = parseFrame(frameText(data))
      if (message?.op === 15 && message.conn === false) this.ready = false
    })
    try {
      await sendJson(socket, {
        op: 2,
        id: 8_899_001,
        gender: 'male',
        remoteID: session.sessionId,
        senderID: session.userId,
        avatar: '',
        nickname: 'dsh-toy',
        lat: 0,
        lng: 0,
        area: '',
      })
      await this.waitUntilReady(socket, signal)
      this.startHeartbeat(socket)
      return { provider: this.provider, serverName: 'MonsterParty', devices: this.list() }
    } catch (error) {
      await closeWebSocket(socket)
      this.markDisconnected()
      throw error
    }
  }

  async scan(_durationMs: number, signal: AbortSignal): Promise<ToyDevice[]> {
    signal.throwIfAborted()
    this.assertReady()
    return this.list()
  }

  list(): ToyDevice[] {
    if (!this.ready) return []
    const device: ToyDevice = {
      id: 'monsterparty:remote',
      name: this.pid || 'MonsterParty remote toy',
      features: [
        {
          id: 'monsterparty:remote:vibration',
          kind: 'vibrate',
          description: this.dualMotor ? 'Vibration motor' : 'All motors',
        },
        ...(this.dualMotor ? [{
          id: 'monsterparty:remote:suction',
          kind: 'suction' as const,
          description: 'Suction pump',
        }] : []),
      ],
    }
    return cloneDevices([device])
  }

  async setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const socket = this.assertReady()
    if (command.deviceId !== 'monsterparty:remote') throw new ToyError(`Unknown MonsterParty device: ${command.deviceId}`)
    const featureId = command.featureId
    if (featureId !== undefined
      && featureId !== 'monsterparty:remote:vibration'
      && featureId !== 'monsterparty:remote:suction') {
      throw new ToyError(`Unknown MonsterParty feature: ${featureId}`)
    }
    if ((featureId === 'monsterparty:remote:suction') !== (command.kind === 'suction') && featureId !== undefined) {
      throw new ToyError(`MonsterParty feature ${featureId} does not match kind ${command.kind}`)
    }
    let vibration = this.vibration
    let suction = this.suction
    if (command.kind === 'suction') {
      if (!this.dualMotor) throw new ToyError('Connected MonsterParty device has no separate suction feature')
      suction = command.intensityPercent
    } else if (command.kind === 'vibrate') {
      vibration = command.intensityPercent
    } else {
      throw new ToyError(`MonsterParty does not support ${command.kind}`)
    }
    await this.sendLevels(socket, vibration, suction)
    this.vibration = vibration
    this.suction = suction
  }

  async stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const socket = this.assertReady()
    if (deviceId !== undefined && deviceId !== 'monsterparty:remote') {
      throw new ToyError(`Unknown MonsterParty device: ${deviceId}`)
    }
    await this.sendLevels(socket, 0, 0)
    this.vibration = 0
    this.suction = 0
  }

  async close(): Promise<void> {
    const socket = this.socket
    if (socket === undefined) return
    this.stopHeartbeat()
    let stopFailure: unknown
    if (socket.readyState === WebSocket.OPEN && this.ready) {
      try {
        await this.stop(undefined)
      } catch (error) {
        stopFailure = error
      }
    }
    await closeWebSocket(socket)
    this.markDisconnected()
    if (stopFailure !== undefined) throw stopFailure
  }

  private async resolveSession(signal: AbortSignal): Promise<SessionInfo> {
    const url = new URL(this.config.apiUrl)
    url.searchParams.set('s', this.config.sessionToken)
    const timeout = AbortSignal.timeout(this.config.connectionTimeoutMs)
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, timeout]),
      headers: { 'User-Agent': this.config.userAgent },
    })
    if (!response.ok) throw new ToyError(`MonsterParty session request failed with HTTP ${response.status}`)
    const value: unknown = await response.json()
    if (isObject(value) && typeof value.errNo === 'number' && value.errNo !== 0) {
      throw new ToyError(`MonsterParty rejected the share token (errNo ${value.errNo})`)
    }
    return parseSessionInfo(value)
  }

  private waitUntilReady(socket: WebSocket, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      let settled = false
      let senderFd: string | number | undefined
      let pid = ''
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        socket.off('message', onMessage)
        socket.off('close', onClose)
        if (error !== undefined) {
          reject(error)
          return
        }
        this.senderFd = senderFd
        this.pid = pid
        this.keyType = pid.toUpperCase().includes('SUCK') ? 'suck' : 'vib'
        this.dualMotor = pid.toUpperCase().includes('DS')
        this.ready = true
        resolve()
      }
      const maybeReady = (): void => {
        if (senderFd !== undefined && pid.length > 0) finish()
      }
      const onMessage = (data: WebSocket.RawData): void => {
        const message = parseFrame(frameText(data))
        if (message === undefined) return
        if (typeof message.errNo === 'number' && message.errNo !== 0) {
          finish(new ToyError(`MonsterParty handshake failed (errNo ${message.errNo})`))
          return
        }
        if (message.op === 6 && isObject(message.sender)
          && (typeof message.sender.fd === 'number' || typeof message.sender.fd === 'string')) {
          senderFd = message.sender.fd
        }
        if (message.op === 15 && message.conn === true) pid = typeof message.pid === 'string' ? message.pid : 'MonsterParty toy'
        maybeReady()
      }
      const onClose = (): void => { finish(new ToyError('MonsterParty WebSocket closed before the device became ready')) }
      const onAbort = (): void => {
        finish(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      }
      const timeout = setTimeout(() => {
        finish(new ToyError(`MonsterParty device was not ready after ${this.config.readyTimeoutMs}ms; check power and use a fresh share link`))
      }, this.config.readyTimeoutMs)
      socket.on('message', onMessage)
      socket.once('close', onClose)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private async sendLevels(socket: WebSocket, vibration: number, suction: number): Promise<void> {
    const fd = this.senderFd
    if (fd === undefined) throw new ToyError('MonsterParty sender fd is unavailable')
    const vib = this.dualMotor
      ? [suction, vibration, vibration, vibration, vibration, 0, 0, 0, 0, 0]
      : Array<number>(10).fill(vibration)
    await sendJson(socket, { op: 3, vib, fd, keyType: this.keyType })
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      void sendJson(socket, { op: 8 }).catch(() => {
        socket.terminate()
        this.markDisconnected()
      })
    }, this.config.heartbeatIntervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private markDisconnected(): void {
    this.stopHeartbeat()
    this.socket = undefined
    this.senderFd = undefined
    this.ready = false
    this.vibration = 0
    this.suction = 0
  }

  private assertReady(): WebSocket {
    const socket = this.socket
    if (!this.ready || socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new ToyError('MonsterParty device is not connected; call toy_connect with a fresh configured token')
    }
    return socket
  }
}
