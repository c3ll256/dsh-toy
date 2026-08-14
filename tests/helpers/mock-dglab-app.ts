/**
 * Reusable mock DG-LAB App client for integration tests.
 *
 * Encapsulates the WebSocket connection, bind handshake, heartbeat response,
 * and command collection so individual tests stay concise.
 */

import WebSocket from 'ws'
import { frame, parseFrame, type WsFrame } from '../../src/dglab/protocol.ts'

/** Extract the WebSocket URL and control ID from a QR payload string. */
export function parseQrPayload(qrPayload: string): { wsUrl: string; controlId: string } {
  // Format: https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#ws://host:port/{controlId}
  const segments = qrPayload.split('#')
  const wsSegment = segments[2] ?? ''
  const lastSlash = wsSegment.lastIndexOf('/')
  if (lastSlash === -1) throw new Error(`Invalid QR payload: ${qrPayload}`)
  return {
    wsUrl: wsSegment.slice(0, lastSlash),
    controlId: wsSegment.slice(lastSlash + 1),
  }
}

/**
 * Mock DG-LAB App that connects to a DgLabBackend's WebSocket server,
 * completes the bind handshake, and collects all received commands.
 */
export class MockDgLabApp {
  private ws: WebSocket | undefined
  private appId = ''
  private controlId = ''
  private readonly receivedFrames: WsFrame[] = []
  private readonly commandMessages: string[] = []
  private bindResolved = false
  private bindPromise: Promise<void> | undefined
  private resolveBind: (() => void) | undefined
  private rejectBind: ((error: Error) => void) | undefined

  /** All parsed frames received from the backend. */
  get frames(): readonly WsFrame[] {
    return this.receivedFrames
  }

  /** All `msg`-type command strings received from the backend. */
  get commands(): readonly string[] {
    return this.commandMessages
  }

  /** The App ID assigned by the backend during bind. */
  get id(): string {
    return this.appId
  }

  /** Whether the bind handshake completed successfully. */
  get isBound(): boolean {
    return this.bindResolved
  }

  /**
   * Connect to the backend's WebSocket server and complete the bind handshake.
   * @param qrPayload - The QR payload from `DgLabBackend.getQrPayload()`.
   * @param timeoutMs - Maximum time to wait for bind completion.
   */
  async connect(qrPayload: string, timeoutMs = 3_000): Promise<void> {
    const { wsUrl, controlId } = parseQrPayload(qrPayload)
    this.controlId = controlId

    // Set up the bind promise BEFORE creating the WebSocket so that
    // Message handlers are ready when frames arrive.
    this.bindPromise = new Promise<void>((resolve, reject) => {
      this.resolveBind = resolve
      this.rejectBind = reject
    })

    this.ws = new WebSocket(`${wsUrl}/${controlId}`)

    // Register the message handler immediately — do NOT wait for 'open'
    // Because the backend may send bind frames before we'd otherwise
    // Attach the listener, and ws does not buffer messages without a listener.
    const timer = setTimeout(() => {
      this.rejectBind?.(new Error(`MockDgLabApp bind timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    this.ws.on('message', (raw) => {
      const msg = parseFrame(raw.toString())
      if (msg === undefined) return
      this.receivedFrames.push(msg)

      // Respond to heartbeat frames to keep the connection alive.
      // Without this, tests using short heartbeat intervals would falsely
      // Trigger the backend's idle-disconnect watchdog.
      if (msg.type === 'heartbeat') {
        if (this.ws !== undefined && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(frame('heartbeat', this.controlId, this.appId, 'heartbeat'))
        }
        return
      }

      // First bind frame assigns our App ID.
      if (msg.type === 'bind' && msg.message === 'targetId') {
        this.appId = msg.clientId
        // Send DGLAB confirmation to complete the 3-step handshake
        // (Server→App: targetId, App→Server: DGLAB, Server→App: 200).
        if (this.ws !== undefined && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(frame('bind', this.controlId, this.appId, 'DGLAB'))
        }
        return
      }

      // Second bind frame confirms success.
      if (msg.type === 'bind' && msg.message === '200') {
        this.bindResolved = true
        clearTimeout(timer)
        this.resolveBind?.()
        return
      }

      // Handle 400 (rejection) — resolve without setting bindResolved.
      if (msg.type === 'bind' && msg.message === '400') {
        clearTimeout(timer)
        this.resolveBind?.()
        return
      }

      // Collect command messages (only after bind is complete).
      if (msg.type === 'msg') {
        this.commandMessages.push(msg.message)
      }
    })

    // Swallow errors during tests to prevent uncaught exceptions.
    this.ws.on('error', () => { /* noop */ })

    // Wait for the bind to complete.
    await this.bindPromise
  }

  /** Send a strength feedback message to the backend. */
  sendStrengthFeedback(a: number, b: number, limitA: number, limitB: number): void {
    if (this.ws === undefined || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(frame('msg', this.controlId, this.appId, `strength-${a}+${b}+${limitA}+${limitB}`))
  }

  /** Send a heartbeat frame to the backend. */
  sendHeartbeat(): void {
    if (this.ws === undefined || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(frame('heartbeat', this.controlId, this.appId, 'heartbeat'))
  }

  /** Send an error frame to the backend. */
  sendError(code: string): void {
    if (this.ws === undefined || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(frame('error', this.controlId, this.appId, code))
  }

  /** Send a break frame to the backend (simulates App-initiated disconnect). */
  sendBreak(): void {
    if (this.ws === undefined || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(frame('break', this.controlId, this.appId, '209'))
  }

  /** Send a raw malformed string (for testing error handling). */
  sendRaw(raw: string): void {
    if (this.ws === undefined || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(raw)
  }

  /** Wait until at least `count` commands have been received. */
  async waitForCommands(count: number, timeoutMs = 500): Promise<void> {
    const start = Date.now()
    while (this.commandMessages.length < count) {
      if (Date.now() - start > timeoutMs) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  /** Disconnect the mock App. */
  async disconnect(): Promise<void> {
    if (this.ws === undefined) return
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'mock-app disconnect')
    } else {
      try { this.ws.terminate() } catch { /* noop */ }
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { try { this.ws?.terminate() } catch { /* noop */ }; resolve() }, 500)
      this.ws?.once('close', () => { clearTimeout(timer); resolve() })
    })
    this.ws = undefined
    this.bindResolved = false
  }
}

/** Wait for a mock App to complete binding (legacy compat helper). */
export async function waitForBind(app: MockDgLabApp, timeoutMs = 3_000): Promise<void> {
  if (app.isBound) return
  const start = Date.now()
  while (!app.isBound) {
    if (Date.now() - start > timeoutMs) throw new Error('waitForBind timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
