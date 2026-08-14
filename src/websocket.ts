/** Shared bounded WebSocket primitives for both providers. */

import WebSocket, { type ClientOptions, type RawData } from 'ws'
import { ToyError } from './types.ts'

/** Convert a received WebSocket frame into UTF-8 text. */
export function frameText(data: RawData): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return data.toString('utf8')
}

/** Open a WebSocket with cooperative cancellation and a hard timeout. */
export function openWebSocket(
  url: string,
  options: ClientOptions,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WebSocket> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options)
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      socket.off('open', onOpen)
      socket.off('error', onError)
      if (error === undefined) resolve(socket)
      else {
        socket.terminate()
        reject(error)
      }
    }
    const onOpen = (): void => { finish() }
    const onError = (error: Error): void => { finish(error) }
    const onAbort = (): void => { finish(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')) }
    const timeout = setTimeout(() => { finish(new ToyError(`WebSocket connection timed out after ${timeoutMs}ms`)) }, timeoutMs)
    socket.once('open', onOpen)
    socket.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Send a JSON value and wait until ws has handed it to the socket. */
export function sendJson(socket: WebSocket, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new ToyError('WebSocket is not open'))
      return
    }
    socket.send(JSON.stringify(value), (error) => {
      if (error === undefined || error === null) resolve()
      else reject(error)
    })
  })
}

/** Close one socket and wait for the close event, terminating after a bound. */
export function closeWebSocket(socket: WebSocket, timeoutMs = 1_000): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.off('close', finish)
      resolve()
    }
    const timeout = setTimeout(() => {
      socket.terminate()
      finish()
    }, timeoutMs)
    socket.once('close', finish)
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
    else socket.close(1000, 'dsh-toy shutdown')
  })
}

/** Abortable delay used for discovery windows. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
