/**
 * DG-LAB Coyote V3 connection layer — WebSocket server, binding state machine,
 * heartbeat, and command dispatch.
 *
 * All protocol formatting is delegated to `./protocol.ts`; this module owns the
 * network lifecycle only.
 */

import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { WebSocketServer, WebSocket } from 'ws'
import {
  cloneDevices,
  ToyError,
  type ToyBackend,
  type ToyConnection,
  type ToyDevice,
  type ToyLevelCommand,
} from '../types.ts'
import { closeWebSocket } from '../websocket.ts'
import {
  DEFAULT_STRENGTH_LIMIT,
  frame,
  parseFrame,
  parseStrengthFeedback,
  buildQrPayload,
  generateQrImage,
  mapIntensityToStrength,
  strengthCmd,
  clearCmd,
  pulseCmd,
  MAX_MESSAGE_LENGTH,
  type DgLabConfig,
  type StrengthChannel,
  type StrengthMode,
  type PulseChannel,
} from './protocol.ts'

// ─── Device model ────────────────────────────────────────────────────────────

const DEVICE_ID = 'dglab:coyote'
const FEATURE_A_ID = 'dglab:coyote:a'
const FEATURE_B_ID = 'dglab:coyote:b'

function deviceSnapshot(): ToyDevice[] {
  const device: ToyDevice = {
    id: DEVICE_ID,
    name: 'DG-LAB Coyote',
    features: [
      { id: FEATURE_A_ID, kind: 'vibrate', description: 'Channel A (e-stim)' },
      { id: FEATURE_B_ID, kind: 'vibrate', description: 'Channel B (e-stim)' },
    ],
  }
  return cloneDevices([device])
}

// ─── Backend ─────────────────────────────────────────────────────────────────

/**
 * In-process DG-LAB Coyote backend that runs a WebSocket server, renders a QR
 * code for App binding, and translates scalar intensity commands into V3
 * protocol strength/clear operations.
 */
export class DgLabBackend implements ToyBackend {
  readonly provider = 'dglab' as const

  // Server lifecycle state — only cleared in close().
  private wss: WebSocketServer | undefined
  private controlId = ''
  private actualPort = 0
  private qrPath = ''
  private qrPayload = ''

  // App binding state — cleared in markAppDisconnected(), ready for rebind.
  private appSocket: WebSocket | undefined
  private appId = ''
  private ready = false
  private heartbeat: ReturnType<typeof setInterval> | undefined

  /** Current device-reported strength (0-200) per channel. */
  private strengthA = 0
  private strengthB = 0
  /** Current device-reported strength limits (0-200) per channel. */
  private limitA = DEFAULT_STRENGTH_LIMIT
  private limitB = DEFAULT_STRENGTH_LIMIT

  /** Promise resolved when the App binds; used for event-driven wait. */
  private readyPromise: Promise<void> | undefined
  private resolveReady: (() => void) | undefined

  /** Timestamp of the last message received from the App. */
  private lastAppMessageTime = 0

  /** @param config - Validated binding and strength configuration. */
  constructor(private readonly config: DgLabConfig) {}

  async connect(signal: AbortSignal): Promise<ToyConnection> {
    signal.throwIfAborted()
    if (this.wss !== undefined) {
      return { provider: this.provider, serverName: this.serverName(), devices: this.list() }
    }
    // Start WebSocket server and wait for it to be listening.
    const wss = new WebSocketServer({ port: this.config.listenPort })
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        wss.off('listening', onListening)
        reject(new ToyError(`DG-LAB WebSocket server failed to start: ${err.message}`))
      }
      const onListening = (): void => {
        wss.off('error', onError)
        resolve()
      }
      wss.once('error', onError)
      wss.once('listening', onListening)
    })
    this.wss = wss
    // Read the actual listening port (may be random when 0 is requested).
    const address = wss.address()
    if (typeof address === 'object' && address !== null) {
      this.actualPort = address.port
    }
    // Generate control ID (32-char hex per V3 spec recommendation).
    this.controlId = randomUUID().replaceAll('-', '')
    const wsUrl = `${this.config.wsScheme}://${this.config.publicHost}:${this.actualPort}`
    this.qrPayload = buildQrPayload(wsUrl, this.controlId)
    // Register the connection handler and start heartbeat BEFORE any
    // Async operation (QR generation) so connections arriving during the
    // Await are not missed.
    this.resetReadyPromise()
    wss.on('connection', (ws, req) => { this.handleConnection(ws, req.url ?? '/') })
    this.startHeartbeat()
    // QR image generation is async and non-critical; the payload string is
    // Still usable even if the file write fails.
    try {
      this.qrPath = await generateQrImage(this.qrPayload, this.controlId)
    } catch {
      this.qrPath = ''
    }
    return { provider: this.provider, serverName: this.serverName(), devices: this.list() }
  }

  async scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]> {
    signal.throwIfAborted()
    // Validate that connect() has been called.
    if (this.wss === undefined) {
      throw new ToyError('DG-LAB Coyote is not connected; call toy_connect first')
    }
    if (this.ready) return this.list()
    // Wait for the App to bind, bounded by the caller's duration.
    const timeout = Math.min(durationMs, this.config.readyTimeoutMs)
    await this.waitForReady(timeout, signal)
    return this.list()
  }

  list(): ToyDevice[] {
    return this.ready ? deviceSnapshot() : []
  }

  async setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const socket = this.assertReady()
    if (command.deviceId !== DEVICE_ID) throw new ToyError(`Unknown DG-LAB device: ${command.deviceId}`)
    if (command.kind !== 'vibrate') throw new ToyError(`DG-LAB Coyote does not support ${command.kind}`)
    const featureId = command.featureId
    if (featureId !== undefined && featureId !== FEATURE_A_ID && featureId !== FEATURE_B_ID) {
      throw new ToyError(`Unknown DG-LAB feature: ${featureId}`)
    }
    // Delegate strength mapping to the protocol layer.
    const mapping = mapIntensityToStrength(
      command.intensityPercent,
      this.config.maxStrength,
      this.limitA,
      this.limitB,
    )
    // Use mode 2 (absolute set) for idempotent, stateless control.
    if (featureId === undefined || featureId === FEATURE_A_ID) {
      await this.sendCommand(socket, strengthCmd('1', '2', mapping.a))
    }
    if (featureId === undefined || featureId === FEATURE_B_ID) {
      await this.sendCommand(socket, strengthCmd('2', '2', mapping.b))
    }
  }

  async stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    // Validate deviceId first, before the ready check. This ensures
    // That an unknown deviceId always throws — even when not bound — rather
    // Than being silently swallowed by the early return.
    if (deviceId !== undefined && deviceId !== DEVICE_ID) {
      throw new ToyError(`Unknown DG-LAB device: ${deviceId}`)
    }
    // Silently return when not bound — stop() is called during close()
    // Cleanup and should be safe even if the App never bound.
    if (!this.ready) return
    const socket = this.appSocket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return
    // Zero both channels and clear waveform queues.
    await this.sendCommand(socket, strengthCmd('1', '2', 0))
    await this.sendCommand(socket, strengthCmd('2', '2', 0))
    await this.sendCommand(socket, clearCmd('1'))
    await this.sendCommand(socket, clearCmd('2'))
  }

  async close(): Promise<void> {
    this.stopHeartbeat()
    const socket = this.appSocket
    // Best-effort: zero strength, clear queues, send break frame.
    if (socket !== undefined && socket.readyState === WebSocket.OPEN && this.ready) {
      try {
        await this.stop(undefined)
        // 210 = server-initiated disconnect (209 = client-initiated).
        socket.send(frame('break', this.controlId, this.appId, '210'))
      } catch {
        // Best-effort cleanup; ignore send failures during teardown.
      }
    }
    // Close the App socket using the shared utility (has timeout + terminate).
    if (socket !== undefined) {
      await closeWebSocket(socket, 1_000)
    }
    // Close the WebSocket server: close all clients first, then the server,
    // With a 2-second timeout that force-terminates unresponsive clients.
    const wss = this.wss
    if (wss !== undefined) {
      for (const client of wss.clients) {
        try { client.close() } catch { /* noop */ }
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          // Force-terminate any clients that didn't respond to close.
          for (const client of wss.clients) {
            try { client.terminate() } catch { /* noop */ }
          }
          resolve()
        }, 2_000)
        wss.close(() => { clearTimeout(timer); resolve() })
      })
    }
    // Clean up QR temp file.
    if (this.qrPath.length > 0) {
      try { await unlink(this.qrPath) } catch { /* file may already be removed */ }
    }
    // Full teardown — clear all server and app state.
    this.appSocket = undefined
    this.appId = ''
    this.ready = false
    this.strengthA = 0
    this.strengthB = 0
    this.limitA = DEFAULT_STRENGTH_LIMIT
    this.limitB = DEFAULT_STRENGTH_LIMIT
    this.lastAppMessageTime = 0
    this.wss = undefined
    this.controlId = ''
    this.qrPath = ''
    this.qrPayload = ''
    this.actualPort = 0
    this.resolveReady = undefined
    this.readyPromise = undefined
  }

  // ─── QR accessors (for testing and agent delivery) ─────────────────────────

  /** Return the QR code payload URL string for agent display. */
  getQrPayload(): string {
    return this.qrPayload
  }

  /** Return the generated QR code image file path, if any. */
  getQrPath(): string {
    return this.qrPath
  }

  // ─── State accessors (for testing and diagnostics) ─────────────────────────

  /** Return whether the App is currently bound and the device is ready. */
  isReady(): boolean {
    return this.ready
  }

  /** Return the actual WebSocket server port (useful when listenPort is 0). */
  getActualPort(): number {
    return this.actualPort
  }

  /** Return the current device-reported strength and per-channel limits. */
  getStrength(): { a: number; b: number; limitA: number; limitB: number } {
    return { a: this.strengthA, b: this.strengthB, limitA: this.limitA, limitB: this.limitB }
  }

  // ─── Advanced DG-LAB specific operations ───────────────────────────────────

  /**
   * Send a waveform pulse pattern to a specific channel.
   * Each hex string is an 8-byte (16 hex char) value: 4 frequency bytes + 4 intensity bytes.
   * This is an advanced operation not exposed through the scalar ToyBackend interface.
   */
  async sendPulse(channel: PulseChannel, hexArray: string[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const socket = this.assertReady()
    // Compute the available message budget by subtracting the JSON
    // Frame envelope size from MAX_MESSAGE_LENGTH. This ensures pulseCmd's
    // Truncation accounts for the *entire* frame, not just the message field.
    const envelopeLen = frame('msg', this.controlId, this.appId, '').length
    const budget = MAX_MESSAGE_LENGTH - envelopeLen
    await this.sendCommand(socket, pulseCmd(channel, hexArray, budget))
  }

  /**
   * Clear the waveform queue for a specific channel.
   * Useful to stop pulse patterns without zeroing the strength.
   */
  async clearQueue(channel: StrengthChannel, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const socket = this.assertReady()
    await this.sendCommand(socket, clearCmd(channel))
  }

  /**
   * Adjust strength by a relative delta using increment/decrement mode.
   * Mode 0 = decrement, Mode 1 = increment.
   */
  async adjustStrength(channel: StrengthChannel, mode: StrengthMode, delta: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const socket = this.assertReady()
    const limit = channel === '1' ? this.limitA : this.limitB
    const clamped = Math.max(0, Math.min(limit, Math.round(delta)))
    await this.sendCommand(socket, strengthCmd(channel, mode, clamped))
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private serverName(): string {
    const parts = ['DG-LAB Coyote']
    if (this.qrPath.length > 0) parts.push(`QR image: ${this.qrPath}`)
    // Do NOT include qrPayload here — it contains the controlId
    // (binding secret) which must not appear in logs or serverName output.
    parts.push(this.ready ? 'bound' : 'waiting for App — call toy_scan after scanning')
    return parts.join(' | ')
  }

  private handleConnection(ws: WebSocket, urlPath: string): void {
    // Extract the path component after the leading '/'.
    const path = urlPath.replace(/^\//, '').split('?')[0] ?? ''
    // Generate a unique App ID.
    const appId = randomUUID()
    // Check readyState before sending.
    if (ws.readyState !== WebSocket.OPEN) return
    // Send the App its assigned ID.
    ws.send(frame('bind', appId, '', 'targetId'))
    // Always register an error handler to prevent uncaught exceptions.
    ws.on('error', () => {
      if (this.appSocket === ws) this.markAppDisconnected()
    })
    // Check if this connection carries a valid control ID (auto-bind path).
    if (path === this.controlId && this.controlId.length > 0) {
      // Even in the auto-bind path, wait for the App's DGLAB
      // Confirmation before completing the 3-step handshake. This aligns
      // With the official V3 protocol flow:
      //   1. Server → App:  bind targetId (assigns App ID)
      //   2. App → Server:  bind DGLAB (confirmation + echoes targetId)
      //   3. Server → App:  bind 200 (success)
      const onAutoBindMessage = (raw: { toString(): string }): void => {
        const msg = parseFrame(raw.toString())
        if (msg === undefined) return
        if (msg.type === 'bind' && msg.message === 'DGLAB'
          && msg.clientId === this.controlId && msg.targetId === appId) {
          ws.off('message', onAutoBindMessage)
          ws.off('close', onAutoBindClose)
          this.bindApp(ws, appId)
        }
      }
      // Clean up the pre-bind listener if the App disconnects before
      // Sending the DGLAB confirmation (prevents dangling listener).
      const onAutoBindClose = (): void => {
        ws.off('message', onAutoBindMessage)
      }
      ws.on('message', onAutoBindMessage)
      ws.on('close', onAutoBindClose)
      return
    }
    // Otherwise wait for an explicit bind message (once — not repeated).
    const onPreBindMessage = (raw: { toString(): string }): void => {
      const msg = parseFrame(raw.toString())
      if (msg === undefined) return
      if (msg.type === 'bind' && msg.message === 'DGLAB'
        && msg.clientId === this.controlId && msg.targetId === appId) {
        ws.off('message', onPreBindMessage)
        this.bindApp(ws, appId)
      }
    }
    ws.on('message', onPreBindMessage)
    ws.on('close', () => {
      if (this.appSocket === ws) this.markAppDisconnected()
    })
  }

  private bindApp(ws: WebSocket, appId: string): void {
    // Reject if already bound to a different socket.
    if (this.ready && this.appSocket !== undefined && this.appSocket !== ws) {
      // Register error handler on the rejected socket to prevent
      // Uncaught exceptions from network errors after rejection.
      ws.on('error', () => { /* rejected connection, ignore errors */ })
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame('bind', this.controlId, appId, '400'))
        // Close the rejected socket immediately to prevent it from
        // Dangling as an open connection (resource leak).
        ws.close(1000, 'rejected')
      }
      return
    }
    // Remove any pre-bind listeners to avoid duplicate callbacks.
    ws.removeAllListeners('message')
    ws.removeAllListeners('close')
    ws.removeAllListeners('error')

    this.appSocket = ws
    this.appId = appId
    this.ready = true
    this.lastAppMessageTime = Date.now()
    // Send bind success to the App (check readyState).
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(frame('bind', this.controlId, appId, '200'))
    }
    // Listen for App messages.
    ws.on('message', raw => { this.handleAppMessage(raw.toString()) })
    ws.on('close', () => { this.handleAppDisconnect() })
    ws.on('error', () => { this.handleAppDisconnect() })
    // Restart heartbeat on (re)bind. markAppDisconnected() stops the
    // Heartbeat; without restarting it here, a rebound App would have no
    // Heartbeat and the connection watchdog would never detect dead links.
    this.startHeartbeat()
    // Resolve the event-driven ready promise.
    this.resolveReady?.()
  }

  private handleAppMessage(raw: string): void {
    this.lastAppMessageTime = Date.now()
    const msg = parseFrame(raw)
    if (msg === undefined) return
    if (msg.type === 'heartbeat') return
    if (msg.type === 'error') {
      // Error frames from the App are non-fatal; the backend remains
      // Operational and the next command may succeed. No action needed.
      return
    }
    if (msg.type === 'break') {
      // App initiated disconnect — mark as disconnected.
      this.markAppDisconnected()
      return
    }
    if (msg.type === 'msg') {
      // Parse App strength feedback: strength-{A}+{B}+{Alimit}+{Blimit}
      const feedback = parseStrengthFeedback(msg.message)
      if (feedback !== undefined) {
        this.strengthA = feedback.a
        this.strengthB = feedback.b
        this.limitA = feedback.limitA
        this.limitB = feedback.limitB
        return
      }
      // App feedback button events (feedback-0..9) and other messages are
      // Safely ignored — they have no scalar control equivalent.
    }
  }

  private handleAppDisconnect(): void {
    this.markAppDisconnected()
  }

  // ─── Event-driven ready wait ───────────────────────────────────────────────

  private resetReadyPromise(): void {
    this.readyPromise = new Promise<void>(resolve => {
      this.resolveReady = resolve
    })
  }

  private async waitForReady(timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (this.ready) return
    const promise = this.readyPromise
    if (promise === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // Use a single function reference for addEventListener/removeEventListener.
    let onAbort: (() => void) | undefined
    const timeoutP = new Promise<void>(resolve => {
      timer = setTimeout(() => resolve(), timeoutMs)
    })
    const abortP = signal.aborted
      ? Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      : new Promise<void>((_, reject) => {
        onAbort = (): void => {
          if (timer !== undefined) clearTimeout(timer)
          reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    try {
      await Promise.race([promise, timeoutP, abortP])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      // Remove the abort listener to prevent leaks.
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  private async sendCommand(socket: WebSocket, commandStr: string): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) {
      throw new ToyError('DG-LAB App WebSocket is not open')
    }
    const json = frame('msg', this.controlId, this.appId, commandStr)
    if (json.length > MAX_MESSAGE_LENGTH) {
      throw new ToyError(`DG-LAB command exceeds ${MAX_MESSAGE_LENGTH} characters (${json.length})`)
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(json, (error) => {
        if (error === undefined || error === null) resolve()
        else reject(new ToyError(`DG-LAB send failed: ${error.message}`))
      })
    })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      const ws = this.appSocket
      if (ws !== undefined && ws.readyState === WebSocket.OPEN) {
        // Check heartbeat timeout — if no App message received within
        // 3x the heartbeat interval, assume the connection is dead.
        const idleMs = Date.now() - this.lastAppMessageTime
        const heartbeatTimeoutMs = this.config.heartbeatIntervalMs * 3
        if (this.lastAppMessageTime > 0 && idleMs > heartbeatTimeoutMs) {
          this.markAppDisconnected()
          return
        }
        ws.send(frame('heartbeat', this.controlId, this.appId, 'heartbeat'), (err) => {
          if (err !== undefined && err !== null) this.markAppDisconnected()
        })
      }
    }, this.config.heartbeatIntervalMs)
    // Allow the Node.js process to exit even if the heartbeat is still running.
    this.heartbeat.unref()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private assertReady(): WebSocket {
    if (!this.ready || this.appSocket === undefined || this.appSocket.readyState !== WebSocket.OPEN) {
      throw new ToyError('DG-LAB Coyote is not bound; call toy_connect then toy_scan after scanning the QR code')
    }
    return this.appSocket
  }

  /**
   * Mark the App as disconnected while keeping the WSS server running.
   * The server stays listening so a new App can rebind without calling
   * connect() again. Only close() tears down the WSS server.
   */
  private markAppDisconnected(): void {
    this.stopHeartbeat()
    this.appSocket = undefined
    this.appId = ''
    this.ready = false
    this.strengthA = 0
    this.strengthB = 0
    this.limitA = DEFAULT_STRENGTH_LIMIT
    this.limitB = DEFAULT_STRENGTH_LIMIT
    this.lastAppMessageTime = 0
    // Reset the ready promise so scan() can wait for a new App to bind.
    if (this.wss !== undefined) {
      this.resetReadyPromise()
    }
  }
}
