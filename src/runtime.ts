/** Serialized safety layer over one concrete toy backend. */

import {
  ToyError,
  type ToyBackend,
  type ToyConnection,
  type ToyDevice,
  type ToyFeatureKind,
} from './types.ts'

/** Deployment safety policy applied to every model-issued command. */
export interface ToySafetyConfig {
  /** Duration used when a control call omits one. */
  defaultDurationSeconds: number
  /** Hard upper duration bound. */
  maxDurationSeconds: number
  /** Hard upper percentage bound. */
  maxIntensityPercent: number
  /** Permit duration 0 to hold until a later stop. */
  allowHold: boolean
}

/** Input accepted by the runtime control operation. */
export interface RuntimeControlRequest {
  /** Target device identity. */
  deviceId: string
  /** Optional exact feature identity. */
  featureId?: string
  /** Scalar action. */
  kind: ToyFeatureKind
  /** Requested percentage. */
  intensityPercent: number
  /** Explicit duration, or the deployment default when omitted. */
  durationSeconds?: number
}

/** Successful bounded control result. */
export interface RuntimeControlResult {
  /** Target device identity. */
  deviceId: string
  /** Scalar action applied. */
  kind: ToyFeatureKind
  /** Applied percentage. */
  intensityPercent: number
  /** Scheduled automatic stop, or null for a deployment-authorized hold. */
  autoStopSeconds: number | null
}

interface StopTimer {
  token: symbol
  timer: ReturnType<typeof setTimeout>
}

/** Serializes transport operations and prevents stale auto-stop timers from stopping newer commands. */
export class ToyRuntime {
  private tail: Promise<void> = Promise.resolve()
  private readonly stopTimers = new Map<string, StopTimer>()
  private disposing = false

  /**
   * @param backend - Concrete transport provider.
   * @param safety - Validated duration and intensity policy.
   * @param reportFailure - Sink for asynchronous auto-stop failures.
   */
  constructor(
    private readonly backend: ToyBackend,
    private readonly safety: ToySafetyConfig,
    private readonly reportFailure: (error: unknown) => void,
  ) {}

  /** Establish the provider connection. */
  connect(signal: AbortSignal): Promise<ToyConnection> {
    return this.exclusive(() => this.backend.connect(signal), signal)
  }

  /** Run provider discovery for a bounded interval. */
  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]> {
    return this.exclusive(() => this.backend.scan(durationMs, signal), signal)
  }

  /** Read the latest in-memory device snapshot. */
  list(signal: AbortSignal): Promise<ToyDevice[]> {
    return this.exclusive(() => Promise.resolve(this.backend.list()), signal)
  }

  /** Apply policy, send a scalar command, and schedule its exact-generation auto-stop. */
  control(request: RuntimeControlRequest, signal: AbortSignal): Promise<RuntimeControlResult> {
    const durationSeconds = request.intensityPercent === 0
      ? 0
      : request.durationSeconds ?? this.safety.defaultDurationSeconds
    this.validateControl(request, durationSeconds)
    return this.exclusive(async () => {
      await this.backend.setLevel({
        deviceId: request.deviceId,
        ...(request.featureId === undefined ? {} : { featureId: request.featureId }),
        kind: request.kind,
        intensityPercent: request.intensityPercent,
      }, signal)
      this.clearTimer(request.deviceId)
      if (request.intensityPercent > 0 && durationSeconds > 0) this.scheduleStop(request.deviceId, durationSeconds)
      return {
        deviceId: request.deviceId,
        kind: request.kind,
        intensityPercent: request.intensityPercent,
        autoStopSeconds: durationSeconds > 0 ? durationSeconds : null,
      }
    }, signal)
  }

  /** Stop one device or all devices and cancel only the corresponding timers. */
  stop(deviceId: string | undefined, signal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      await this.backend.stop(deviceId, signal)
      if (deviceId === undefined) this.clearTimers()
      else this.clearTimer(deviceId)
    }, signal)
  }

  /** Disconnect without disposing the runtime, allowing a later reconnect. */
  disconnect(signal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      signal.throwIfAborted()
      this.clearTimers()
      await this.backend.close()
    }, signal)
  }

  /** Reject new operations, stop timers, and await provider shutdown. */
  async close(): Promise<void> {
    if (this.disposing) {
      await this.tail
      return
    }
    this.disposing = true
    await this.exclusive(async () => {
      this.clearTimers()
      await this.backend.close()
    }, undefined, true)
  }

  private validateControl(request: RuntimeControlRequest, durationSeconds: number): void {
    if (!Number.isInteger(request.intensityPercent) || request.intensityPercent < 0
      || request.intensityPercent > this.safety.maxIntensityPercent) {
      throw new ToyError(`intensity_percent must be an integer from 0 to ${this.safety.maxIntensityPercent}`)
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > this.safety.maxDurationSeconds) {
      throw new ToyError(`duration_seconds must be from 0 to ${this.safety.maxDurationSeconds}`)
    }
    if (request.intensityPercent > 0 && durationSeconds === 0 && !this.safety.allowHold) {
      throw new ToyError('duration_seconds=0 is disabled; use a positive duration or enable allowHold')
    }
  }

  private scheduleStop(deviceId: string, seconds: number): void {
    const token = Symbol(deviceId)
    const timer = setTimeout(() => {
      void this.exclusive(async () => {
        const current = this.stopTimers.get(deviceId)
        if (current?.token !== token) return
        this.stopTimers.delete(deviceId)
        await this.backend.stop(deviceId)
      }, undefined).catch((error: unknown) => {
        try {
          this.reportFailure(error)
        } catch {
          // The transport is already stopped or failed; a diagnostic sink failure has no remaining recovery path.
        }
      })
    }, seconds * 1_000)
    this.stopTimers.set(deviceId, { token, timer })
  }

  private clearTimer(deviceId: string): void {
    const current = this.stopTimers.get(deviceId)
    if (current === undefined) return
    clearTimeout(current.timer)
    this.stopTimers.delete(deviceId)
  }

  private clearTimers(): void {
    for (const timer of this.stopTimers.values()) clearTimeout(timer.timer)
    this.stopTimers.clear()
  }

  private exclusive<T>(
    operation: () => Promise<T>,
    signal: AbortSignal | undefined,
    allowDisposing = false,
  ): Promise<T> {
    if (this.disposing && !allowDisposing) return Promise.reject(new ToyError('dsh-toy is shutting down'))
    let release!: () => void
    const predecessor = this.tail
    this.tail = new Promise(resolve => { release = resolve })
    return (async () => {
      await predecessor
      try {
        if (this.disposing && !allowDisposing) throw new ToyError('dsh-toy is shutting down')
        signal?.throwIfAborted()
        return await operation()
      } finally {
        release()
      }
    })()
  }
}
