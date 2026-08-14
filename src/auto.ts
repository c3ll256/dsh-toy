/** Automatic toy transport selection and managed Intiface Engine startup. */

import { spawn, type ChildProcess } from 'node:child_process'
import { ButtplugBackend, type ButtplugConfig } from './buttplug.ts'
import { installIntifaceEngine } from './intiface-download.ts'
import { MonsterPartyBackend, type MonsterPartyConfig } from './monsterparty.ts'
import { ToyError, type ToyBackend, type ToyConnection, type ToyDevice, type ToyLevelCommand, type ToyProvider, type ToyTarget } from './types.ts'
import { delay } from './websocket.ts'

const MONSTERPARTY_MARKERS = [
  'monsterparty',
  'monster party',
  'ankni',
  '安可尼',
  'mizzzee',
  '谜姬',
  'zuiqingfeng',
  '醉清风',
  'akn_ds_',
] as const

/** Decide the transport from the user-supplied brand and model, without exposing provider selection. */
export function routeToyTarget(target: ToyTarget): ToyProvider {
  const identity = `${target.brand ?? ''} ${target.model}`.trim().toLocaleLowerCase()
  return MONSTERPARTY_MARKERS.some(marker => identity.includes(marker)) ? 'monsterparty' : 'buttplug'
}

/** Process settings for a plugin-owned Intiface Engine. */
export interface IntifaceProcessConfig {
  executable: string
  websocketUrl: string
  startupTimeoutMs: number
  autoDownload: boolean
}

function localWebsocketPort(value: string): number {
  const url = new URL(value)
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new ToyError('Automatic Intiface startup requires a local ws://127.0.0.1 address')
  }
  const port = url.port.length > 0 ? Number(url.port) : 80
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new ToyError('Intiface WebSocket URL has an invalid port')
  return port
}

/** Own at most one Intiface Engine process and stop only the process it created. */
export class IntifaceProcessManager {
  private child: ChildProcess | undefined
  private executable: string

  constructor(private readonly config: IntifaceProcessConfig) {
    this.executable = config.executable
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null) return
    const port = localWebsocketPort(this.config.websocketUrl)
    let child: ChildProcess
    try {
      child = await this.spawn(this.executable, port, signal)
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
      if (code !== 'ENOENT' || !this.config.autoDownload) {
        throw new ToyError(`Could not start Intiface Engine (${this.executable}): ${error instanceof Error ? error.message : String(error)}`)
      }
      this.executable = await installIntifaceEngine(signal)
      try {
        child = await this.spawn(this.executable, port, signal)
      } catch (downloadedError) {
        throw new ToyError(`Could not start downloaded Intiface Engine (${this.executable}): ${downloadedError instanceof Error ? downloadedError.message : String(downloadedError)}`)
      }
    }
    this.child = child
    child.on('error', () => {})
    child.unref()
  }

  private spawn(executable: string, port: number, signal: AbortSignal): Promise<ChildProcess> {
    const child = spawn(executable, [
      '--websocket-port', String(port),
      '--use-bluetooth-le',
      '--use-serial',
      '--use-hid',
    ], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return new Promise<ChildProcess>((resolve, reject) => {
      const finish = (error?: Error): void => {
        signal.removeEventListener('abort', onAbort)
        child.off('spawn', onSpawn)
        child.off('error', onError)
        if (error === undefined) resolve(child)
        else reject(error)
      }
      const onSpawn = (): void => { finish() }
      const onError = (error: Error): void => { finish(error) }
      const onAbort = (): void => {
        child.kill()
        finish(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  assertRunning(): void {
    const child = this.child
    if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
      this.child = undefined
      throw new ToyError(`Intiface Engine exited before opening ${this.config.websocketUrl}`)
    }
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        child.off('exit', finish)
        resolve()
      }
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        finish()
      }, 2_000)
      child.once('exit', finish)
    })
  }
}

function isConnectionRefused(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown }
  return candidate.code === 'ECONNREFUSED'
    || (typeof candidate.message === 'string' && candidate.message.includes('ECONNREFUSED'))
    || (candidate.cause !== undefined && isConnectionRefused(candidate.cause))
}

/** Buttplug backend that starts Intiface Engine only when the configured local endpoint refuses a connection. */
export class ManagedButtplugBackend implements ToyBackend {
  readonly provider = 'buttplug' as const
  private readonly backend: ButtplugBackend
  private readonly process: IntifaceProcessManager

  constructor(config: ButtplugConfig, private readonly processConfig: IntifaceProcessConfig) {
    this.backend = new ButtplugBackend(config)
    this.process = new IntifaceProcessManager(processConfig)
  }

  async connect(signal: AbortSignal): Promise<ToyConnection> {
    try {
      return await this.backend.connect(signal)
    } catch (error) {
      if (!isConnectionRefused(error)) throw error
    }
    await this.process.start(signal)
    try {
      const deadline = Date.now() + this.processConfig.startupTimeoutMs
      let lastError: unknown
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        this.process.assertRunning()
        try {
          return await this.backend.connect(signal)
        } catch (error) {
          if (!isConnectionRefused(error)) throw error
          lastError = error
          await delay(100, signal)
        }
      }
      throw new ToyError(`Intiface Engine did not open ${this.processConfig.websocketUrl} within ${this.processConfig.startupTimeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
    } catch (error) {
      await this.process.close()
      throw error
    }
  }

  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]> { return this.backend.scan(durationMs, signal) }
  list(): ToyDevice[] { return this.backend.list() }
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void> { return this.backend.setLevel(command, signal) }
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void> { return this.backend.stop(deviceId, signal) }

  async close(): Promise<void> {
    let backendFailure: unknown
    try {
      await this.backend.close()
    } catch (error) {
      backendFailure = error
    } finally {
      await this.process.close()
    }
    if (backendFailure !== undefined) throw backendFailure
  }
}

/** Configuration for automatic selection between local hardware and MonsterParty remote links. */
export interface AutoToyBackendConfig {
  buttplug: ButtplugConfig
  intiface: IntifaceProcessConfig
  monsterParty?: MonsterPartyConfig
}

/** Select a backend from the exact model supplied at connection time. */
export class AutoToyBackend implements ToyBackend {
  private active: ToyBackend | undefined
  private targetKey = ''

  constructor(private readonly config: AutoToyBackendConfig) {}

  get provider(): ToyProvider { return this.active?.provider ?? 'buttplug' }

  async connect(signal: AbortSignal, target?: ToyTarget): Promise<ToyConnection> {
    if (target === undefined || target.model.trim().length === 0) {
      throw new ToyError('Ask the user for the exact toy brand and model before calling toy_connect')
    }
    const route = routeToyTarget(target)
    const targetKey = `${route}:${target.brand ?? ''}:${target.model}`.toLocaleLowerCase()
    if (this.active === undefined || targetKey !== this.targetKey) {
      const previous = this.active
      this.active = undefined
      this.targetKey = ''
      await previous?.close()
      if (route === 'monsterparty') {
        if (this.config.monsterParty === undefined) {
          throw new ToyError('This model uses a MonsterParty share link; configure a fresh MONSTERPARTY_TOKEN, then reconnect')
        }
        this.active = new MonsterPartyBackend(this.config.monsterParty)
      } else {
        this.active = new ManagedButtplugBackend(this.config.buttplug, this.config.intiface)
      }
      this.targetKey = targetKey
    }
    return this.active.connect(signal, target)
  }

  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]> { return this.requireActive().scan(durationMs, signal) }
  list(): ToyDevice[] { return this.active?.list() ?? [] }
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void> { return this.requireActive().setLevel(command, signal) }
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void> { return this.requireActive().stop(deviceId, signal) }

  async close(): Promise<void> {
    const active = this.active
    this.active = undefined
    this.targetKey = ''
    await active?.close()
  }

  private requireActive(): ToyBackend {
    if (this.active === undefined) throw new ToyError('No toy is connected; ask for its exact model and call toy_connect first')
    return this.active
  }
}
