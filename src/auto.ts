/** Automatic toy transport selection and managed Intiface Engine startup. */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ButtplugBackend, type ButtplugConfig } from './buttplug.ts'
import { DgLabBackend, type DgLabConfig } from './dglab/index.ts'
import { installIntifaceEngine } from './intiface-download.ts'
import { createIntifaceUserDeviceConfig } from './intiface-user-config.ts'
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

const DGLAB_MARKERS = [
  'coyote',
  '郊狼',
  'dglab',
  'dg-lab',
] as const

/** Decide the transport from the user-supplied brand and model, without exposing provider selection. */
export function routeToyTarget(target: ToyTarget): ToyProvider {
  const identity = `${target.brand ?? ''} ${target.model}`.trim().toLocaleLowerCase()
  if (DGLAB_MARKERS.some(marker => identity.includes(marker))) return 'dglab'
  if (MONSTERPARTY_MARKERS.some(marker => identity.includes(marker))) return 'monsterparty'
  return 'buttplug'
}

/** Process settings for a plugin-owned Intiface Engine. */
export interface IntifaceProcessConfig {
  executable: string
  websocketUrl: string
  startupTimeoutMs: number
  autoDownload: boolean
  /** Include verified local compatibility mappings when the engine schema is supported. */
  useBuiltinUserDeviceConfig?: boolean
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
}

function intifaceEngineMajor(executable: string, signal: AbortSignal): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    execFile(executable, ['--server-version'], { signal, timeout: 2_000, windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        if (signal.aborted || errorCode(error) === 'ENOENT') reject(error)
        else resolve(undefined)
        return
      }
      const match = /^(\d+)\./.exec(stdout.trim())
      resolve(match === null ? undefined : Number(match[1]))
    })
  })
}

/** Build the Intiface arguments used by the plugin-owned process. */
export function intifaceArguments(port: number, userDeviceConfigPath?: string): string[] {
  return [
    '--websocket-port', String(port),
    '--use-bluetooth-le',
    '--use-serial',
    '--use-hid',
    ...(userDeviceConfigPath === undefined ? [] : ['--user-device-config-file', userDeviceConfigPath]),
  ]
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
  private userConfigDirectory: string | undefined

  constructor(private readonly config: IntifaceProcessConfig) {
    this.executable = config.executable
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null) return
    const port = localWebsocketPort(this.config.websocketUrl)
    let child: ChildProcess
    try {
      const userDeviceConfigPath = await this.prepareUserDeviceConfig(this.executable, signal)
      child = await this.spawn(this.executable, port, userDeviceConfigPath, signal)
    } catch (error) {
      await this.removeUserDeviceConfig()
      if (errorCode(error) !== 'ENOENT' || !this.config.autoDownload) {
        throw new ToyError(`Could not start Intiface Engine (${this.executable}): ${error instanceof Error ? error.message : String(error)}`)
      }
      this.executable = await installIntifaceEngine(signal)
      try {
        const userDeviceConfigPath = await this.prepareUserDeviceConfig(this.executable, signal)
        child = await this.spawn(this.executable, port, userDeviceConfigPath, signal)
      } catch (downloadedError) {
        await this.removeUserDeviceConfig()
        throw new ToyError(`Could not start downloaded Intiface Engine (${this.executable}): ${downloadedError instanceof Error ? downloadedError.message : String(downloadedError)}`)
      }
    }
    this.child = child
    child.on('error', () => {})
    child.unref()
  }

  private async prepareUserDeviceConfig(executable: string, signal: AbortSignal): Promise<string | undefined> {
    if (this.config.useBuiltinUserDeviceConfig !== true) return undefined
    const major = await intifaceEngineMajor(executable, signal)
    if (major !== 4 && major !== 5) return undefined
    const directory = await mkdtemp(join(tmpdir(), 'dsh-toy-intiface-'))
    const path = join(directory, 'user-device-config.json')
    try {
      await writeFile(path, createIntifaceUserDeviceConfig(major), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
    this.userConfigDirectory = directory
    return path
  }

  private spawn(executable: string, port: number, userDeviceConfigPath: string | undefined, signal: AbortSignal): Promise<ChildProcess> {
    const child = spawn(executable, intifaceArguments(port, userDeviceConfigPath), {
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
    try {
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
    } finally {
      await this.removeUserDeviceConfig()
    }
  }

  private async removeUserDeviceConfig(): Promise<void> {
    const directory = this.userConfigDirectory
    this.userConfigDirectory = undefined
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
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

/** Configuration for automatic selection between local hardware, MonsterParty remote links, and DG-LAB Coyote. */
export interface AutoToyBackendConfig {
  buttplug: ButtplugConfig
  intiface: IntifaceProcessConfig
  monsterParty?: MonsterPartyConfig
  dgLab?: DgLabConfig
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
      } else if (route === 'dglab') {
        if (this.config.dgLab === undefined) {
          throw new ToyError('DG-LAB Coyote backend is not available')
        }
        this.active = new DgLabBackend(this.config.dgLab)
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
