import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/types.d.ts
/** Provider kinds supported by dsh-toy. */
type ToyProvider = 'buttplug' | 'monsterparty' | 'dglab';
/** Hardware identity supplied by the user so the plugin can select the transport. */
interface ToyTarget {
  /** Optional brand, useful when a model name is ambiguous. */
  brand?: string;
  /** Exact product model printed in the app, packaging, or device label. */
  model: string;
}
/** Safety-reviewed scalar actuator kinds exposed to the model. */
type ToyFeatureKind = 'vibrate' | 'oscillate' | 'constrict' | 'inflate' | 'suction';
/** One controllable scalar feature reported by a backend. */
interface ToyFeature {
  /** Backend-stable identity while the device remains connected. */
  id: string;
  /** Generic action supported by this feature. */
  kind: ToyFeatureKind;
  /** Human-readable hardware description. */
  description: string;
}
/** One currently available device. */
interface ToyDevice {
  /** Opaque identity accepted by control and stop operations. */
  id: string;
  /** Protocol-provided device name. */
  name: string;
  /** Optional user-assigned display name. */
  displayName?: string;
  /** Controllable scalar features. */
  features: ToyFeature[];
}
/** Successful provider connection information. */
interface ToyConnection {
  /** Active provider. */
  provider: ToyProvider;
  /** Remote server or device name. */
  serverName: string;
  /** Devices already known at connection time. */
  devices: ToyDevice[];
}
/** One safety-bounded scalar command. */
interface ToyLevelCommand {
  /** Target device identity. */
  deviceId: string;
  /** Optional exact feature; omission targets every compatible feature. */
  featureId?: string;
  /** Requested scalar action. */
  kind: ToyFeatureKind;
  /** Integer percentage in the inclusive range 0-100. */
  intensityPercent: number;
}
/** Provider interface consumed by the safety runtime. */
interface ToyBackend {
  /** Provider discriminator. */
  readonly provider: ToyProvider;
  /** Establish a connection and return the initial device snapshot. */
  connect(signal: AbortSignal, target?: ToyTarget): Promise<ToyConnection>;
  /** Discover devices for the configured bounded interval. */
  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>;
  /** Return a fresh device snapshot without network discovery. */
  list(): ToyDevice[];
  /** Apply one normalized scalar command. */
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void>;
  /** Stop one device or every device when the id is omitted. */
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void>;
  /** Stop owned output, close transport resources, and reach quiescence. */
  close(): Promise<void>;
}
/** Error for invalid state, unsupported hardware, or protocol failures. */
declare class ToyError extends Error {
  /** @param message - Actionable operator or model-facing failure text. */
  constructor(message: string);
}
//#endregion
//#region src/buttplug.d.ts
/** Configuration owned by the Buttplug provider. */
interface ButtplugConfig {
  /** Intiface WebSocket endpoint. */
  url: string;
  /** Buttplug protocol major version. */
  protocolVersion: 3 | 4;
  /** WebSocket setup bound. */
  connectionTimeoutMs: number;
  /** One request/response bound. */
  requestTimeoutMs: number;
  /** Client name presented to Intiface. */
  clientName: string;
}
/** Parse a DeviceList body from Buttplug v3 or v4 into the public snapshot. */
declare function parseButtplugDeviceList(body: unknown, protocolVersion: 3 | 4): ToyDevice[];
/** Stateful Buttplug JSON client over an Intiface WebSocket server. */
declare class ButtplugBackend implements ToyBackend {
  private readonly config;
  readonly provider: "buttplug";
  private socket;
  private serverName;
  private nextId;
  private readonly pending;
  private readonly devices;
  private pingTimer;
  /** @param config - Validated transport and protocol configuration. */
  constructor(config: ButtplugConfig);
  connect(signal: AbortSignal): Promise<ToyConnection>;
  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>;
  list(): ToyDevice[];
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void>;
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  private refreshDevices;
  private request;
  private receive;
  private applyEvent;
  private startPings;
  private stopPings;
  private loseConnection;
  private assertConnected;
}
//#endregion
//#region src/dglab/protocol.d.ts
/**
 * DG-LAB Coyote V3 protocol layer — pure functions and constants.
 *
 * This module contains no networking code; it can be unit-tested in isolation.
 * All protocol details (command formats, frame structure, QR payload, strength
 * mapping) live here so the connection layer stays clean.
 */
/** Maximum characters of a single WebSocket JSON frame (official V3 spec). */
declare const MAX_MESSAGE_LENGTH = 1950;
/** Maximum waveform entries per pulse command (conservative below the official 100). */
declare const MAX_PULSE_PER_SEND = 70;
/** Device-reported default strength limit. */
declare const DEFAULT_STRENGTH_LIMIT = 200;
/** Channel identifier for strength and clear commands (1 = A, 2 = B). */
type StrengthChannel = '1' | '2';
/** Strength change mode (0 = decrement, 1 = increment, 2 = set absolute). */
type StrengthMode = '0' | '1' | '2';
/** Channel identifier for pulse commands (A or B). */
type PulseChannel = 'A' | 'B';
/**
 * Build a strength command string.
 * Format: `strength-{channel}+{mode}+{value}` (value 0-200).
 */
declare function strengthCmd(channel: StrengthChannel, mode: StrengthMode, value: number): string;
/**
 * Build a clear-queue command string.
 * Format: `clear-{channel}` (channel 1 = A, 2 = B).
 */
declare function clearCmd(channel: StrengthChannel): string;
/**
 * Build a pulse (waveform) command string, capping the array length and total
 * JSON frame size to stay within the 1950-character protocol limit.
 *
 * Format: `pulse-{channel}:{hexArrayJson}`.
 * Each hex string must be exactly 16 hex chars (8 bytes: 4 frequency + 4 intensity).
 *
 * @param messageBudget - Maximum length of the command string (message field).
 *   Callers should pass `MAX_MESSAGE_LENGTH - frameEnvelopeLength` so the
 *   *entire* JSON frame — not just the message field — fits within the limit.
 *   Defaults to `MAX_MESSAGE_LENGTH` for backward compatibility.
 * @throws {ToyError} if any hex string is not 16 characters long.
 */
declare function pulseCmd(channel: PulseChannel, hexArray: string[], messageBudget?: number): string;
/** Result of mapping intensity percentage to per-channel device strength. */
interface StrengthMapping {
  /** Target strength for channel A (0-limitA). */
  a: number;
  /** Target strength for channel B (0-limitB). */
  b: number;
}
/**
 * Map an intensity percentage (0-100) to device strength values (0-200),
 * clamped to both the configured maximum and the device-reported per-channel limits.
 *
 * @param intensityPercent - Caller-supplied percentage (0-100, clamped internally).
 * @param maxStrength - Configured maximum strength (typically 200).
 * @param limitA - Device-reported maximum for channel A.
 * @param limitB - Device-reported maximum for channel B.
 * @returns Clamped strength values for both channels.
 */
declare function mapIntensityToStrength(intensityPercent: number, maxStrength: number, limitA: number, limitB: number): StrengthMapping;
/** Configuration owned by the DG-LAB Coyote provider. */
interface DgLabConfig {
  /** TCP port for the WebSocket server (0 = random ephemeral). */
  listenPort: number;
  /** Hostname or IP embedded in the QR code (must be reachable from the phone). */
  publicHost: string;
  /** WebSocket protocol scheme for the QR code URL. */
  wsScheme: 'ws' | 'wss';
  /** Heartbeat broadcast interval in milliseconds. */
  heartbeatIntervalMs: number;
  /** Maximum strength value (0-200) mapped from 100% intensity. */
  maxStrength: number;
  /** Timeout for waiting the App to bind during scan, in milliseconds. */
  readyTimeoutMs: number;
}
/**
 * Build the QR code payload string expected by the DG-LAB app.
 * Format: `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#{wsUrl}/{controlId}`
 */
declare function buildQrPayload(wsUrl: string, controlId: string): string;
//#endregion
//#region src/dglab/backend.d.ts
/**
 * In-process DG-LAB Coyote backend that runs a WebSocket server, renders a QR
 * code for App binding, and translates scalar intensity commands into V3
 * protocol strength/clear operations.
 */
declare class DgLabBackend implements ToyBackend {
  private readonly config;
  readonly provider: "dglab";
  private wss;
  private controlId;
  private actualPort;
  private qrPath;
  private qrPayload;
  private appSocket;
  private appId;
  private ready;
  private heartbeat;
  /** Current device-reported strength (0-200) per channel. */
  private strengthA;
  private strengthB;
  /** Current device-reported strength limits (0-200) per channel. */
  private limitA;
  private limitB;
  /** Promise resolved when the App binds; used for event-driven wait. */
  private readyPromise;
  private resolveReady;
  /** Timestamp of the last message received from the App. */
  private lastAppMessageTime;
  /** @param config - Validated binding and strength configuration. */
  constructor(config: DgLabConfig);
  connect(signal: AbortSignal): Promise<ToyConnection>;
  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>;
  list(): ToyDevice[];
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void>;
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  /** Return the QR code payload URL string for agent display. */
  getQrPayload(): string;
  /** Return the generated QR code image file path, if any. */
  getQrPath(): string;
  /** Return whether the App is currently bound and the device is ready. */
  isReady(): boolean;
  /** Return the actual WebSocket server port (useful when listenPort is 0). */
  getActualPort(): number;
  /** Return the current device-reported strength and per-channel limits. */
  getStrength(): {
    a: number;
    b: number;
    limitA: number;
    limitB: number;
  };
  /**
   * Send a waveform pulse pattern to a specific channel.
   * Each hex string is an 8-byte (16 hex char) value: 4 frequency bytes + 4 intensity bytes.
   * This is an advanced operation not exposed through the scalar ToyBackend interface.
   */
  sendPulse(channel: PulseChannel, hexArray: string[], signal: AbortSignal): Promise<void>;
  /**
   * Clear the waveform queue for a specific channel.
   * Useful to stop pulse patterns without zeroing the strength.
   */
  clearQueue(channel: StrengthChannel, signal: AbortSignal): Promise<void>;
  /**
   * Adjust strength by a relative delta using increment/decrement mode.
   * Mode 0 = decrement, Mode 1 = increment.
   */
  adjustStrength(channel: StrengthChannel, mode: StrengthMode, delta: number, signal: AbortSignal): Promise<void>;
  private serverName;
  private handleConnection;
  private bindApp;
  private handleAppMessage;
  private handleAppDisconnect;
  private resetReadyPromise;
  private waitForReady;
  private sendCommand;
  private startHeartbeat;
  private stopHeartbeat;
  private assertReady;
  /**
   * Mark the App as disconnected while keeping the WSS server running.
   * The server stays listening so a new App can rebind without calling
   * connect() again. Only close() tears down the WSS server.
   */
  private markAppDisconnected;
}
//#endregion
//#region src/monsterparty.d.ts
/** Configuration owned by the MonsterParty provider. */
interface MonsterPartyConfig {
  /** Single-use token extracted from a remote share link. */
  sessionToken: string;
  /** API endpoint resolving token to WebSocket session details. */
  apiUrl: string;
  /** Origin expected by the MonsterParty WebSocket relay. */
  origin: string;
  /** User-Agent sent during WebSocket negotiation. */
  userAgent: string;
  /** HTTP and WebSocket setup bound. */
  connectionTimeoutMs: number;
  /** Device-ready handshake bound. */
  readyTimeoutMs: number;
  /** Application heartbeat interval. */
  heartbeatIntervalMs: number;
}
/** In-process MonsterParty client with application heartbeats and dual-motor mapping. */
declare class MonsterPartyBackend implements ToyBackend {
  private readonly config;
  readonly provider: "monsterparty";
  private socket;
  private senderFd;
  private pid;
  private keyType;
  private dualMotor;
  private ready;
  private heartbeat;
  private vibration;
  private suction;
  /** @param config - Validated remote-link and heartbeat configuration. */
  constructor(config: MonsterPartyConfig);
  connect(signal: AbortSignal): Promise<ToyConnection>;
  scan(_durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>;
  list(): ToyDevice[];
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void>;
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  private resolveSession;
  private waitUntilReady;
  private sendLevels;
  private startHeartbeat;
  private stopHeartbeat;
  private markDisconnected;
  private assertReady;
}
//#endregion
//#region src/auto.d.ts
/** Decide the transport from the user-supplied brand and model, without exposing provider selection. */
declare function routeToyTarget(target: ToyTarget): ToyProvider;
/** Process settings for a plugin-owned Intiface Engine. */
interface IntifaceProcessConfig {
  executable: string;
  websocketUrl: string;
  startupTimeoutMs: number;
  autoDownload: boolean;
  /** Include verified local compatibility mappings when the engine schema is supported. */
  useBuiltinUserDeviceConfig?: boolean;
}
/** Build the Intiface arguments used by the plugin-owned process. */
declare function intifaceArguments(port: number, userDeviceConfigPath?: string): string[];
/** Own at most one Intiface Engine process and stop only the process it created. */
declare class IntifaceProcessManager {
  private readonly config;
  private child;
  private executable;
  private userConfigDirectory;
  constructor(config: IntifaceProcessConfig);
  start(signal: AbortSignal): Promise<void>;
  private prepareUserDeviceConfig;
  private spawn;
  assertRunning(): void;
  close(): Promise<void>;
  private removeUserDeviceConfig;
}
/** Buttplug backend that starts Intiface Engine only when the configured local endpoint refuses a connection. */
declare class ManagedButtplugBackend implements ToyBackend {
  private readonly processConfig;
  readonly provider: "buttplug";
  private readonly backend;
  private readonly process;
  constructor(config: ButtplugConfig, processConfig: IntifaceProcessConfig);
  connect(signal: AbortSignal): Promise<ToyConnection>;
  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>;
  list(): ToyDevice[];
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void>;
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
/** Configuration for automatic selection between local hardware, MonsterParty remote links, and DG-LAB Coyote. */
interface AutoToyBackendConfig {
  buttplug: ButtplugConfig;
  intiface: IntifaceProcessConfig;
  monsterParty?: MonsterPartyConfig;
  dgLab?: DgLabConfig;
}
/** Select a backend from the exact model supplied at connection time. */
declare class AutoToyBackend implements ToyBackend {
  private readonly config;
  private active;
  private targetKey;
  constructor(config: AutoToyBackendConfig);
  get provider(): ToyProvider;
  connect(signal: AbortSignal, target?: ToyTarget): Promise<ToyConnection>;
  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>;
  list(): ToyDevice[];
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void>;
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  private requireActive;
}
//#endregion
//#region src/intiface-user-config.d.ts
/** Built-in Intiface user mappings for devices verified locally but absent upstream. */
/** Build an Intiface user config matching the executable's device-config major version. */
declare function createIntifaceUserDeviceConfig(engineMajor: number): string;
//#endregion
//#region src/macos-ble.d.ts
/** Read-only raw BLE discovery through macOS CoreBluetooth. */
/** One connectable raw BLE advertisement, not a controllable toy device. */
interface RawBleAdvertisement {
  id: string;
  name?: string;
  rssi: number;
  connectable: boolean;
  manufacturerData?: string;
  services?: string[];
}
declare const MACOS_RAW_BLE_SCANNER_SOURCE: string;
/** Validate and detach the helper's JSON output. */
declare function parseRawBleScan(raw: string): RawBleAdvertisement[];
/** Compile a temporary CoreBluetooth helper, scan without Intiface, then remove it. */
declare function scanMacOSRawBle(durationMs: number, signal: AbortSignal): Promise<RawBleAdvertisement[]>;
//#endregion
//#region src/intiface-download.d.ts
/** Verified download and extraction of the official Intiface Engine CLI. */
/** One pinned upstream artifact and its GitHub-provided SHA-256 digest. */
interface IntifaceArtifact {
  name: string;
  sha256: string;
}
/** Return the pinned artifact for a supported Node platform/architecture pair. */
declare function selectIntifaceArtifact(platform?: NodeJS.Platform, arch?: NodeJS.Architecture): IntifaceArtifact;
/** Extract only the expected executable from a small, non-ZIP64 upstream archive. */
declare function extractIntifaceExecutable(zip: Buffer, windows?: boolean): Buffer;
/** Download, verify, cache, and return an executable path for Intiface Engine. */
declare function installIntifaceEngine(signal: AbortSignal): Promise<string>;
//#endregion
//#region src/runtime.d.ts
/** Deployment safety policy applied to every model-issued command. */
interface ToySafetyConfig {
  /** Duration used when a control call omits one. */
  defaultDurationSeconds: number;
  /** Hard upper duration bound. */
  maxDurationSeconds: number;
  /** Hard upper percentage bound. */
  maxIntensityPercent: number;
  /** Permit duration 0 to hold until a later stop. */
  allowHold: boolean;
}
/** Input accepted by the runtime control operation. */
interface RuntimeControlRequest {
  /** Target device identity. */
  deviceId: string;
  /** Optional exact feature identity. */
  featureId?: string;
  /** Scalar action. */
  kind: ToyFeatureKind;
  /** Requested percentage. */
  intensityPercent: number;
  /** Explicit duration, or the deployment default when omitted. */
  durationSeconds?: number;
}
/** Successful bounded control result. */
interface RuntimeControlResult {
  /** Target device identity. */
  deviceId: string;
  /** Scalar action applied. */
  kind: ToyFeatureKind;
  /** Applied percentage. */
  intensityPercent: number;
  /** Scheduled automatic stop, or null for a deployment-authorized hold. */
  autoStopSeconds: number | null;
}
/** Serializes transport operations and prevents stale auto-stop timers from stopping newer commands. */
declare class ToyRuntime {
  private readonly backend;
  private readonly safety;
  private readonly reportFailure;
  private tail;
  private readonly stopTimers;
  private disposing;
  /**
   * @param backend - Concrete transport provider.
   * @param safety - Validated duration and intensity policy.
   * @param reportFailure - Sink for asynchronous auto-stop failures.
   */
  constructor(backend: ToyBackend, safety: ToySafetyConfig, reportFailure: (error: unknown) => void);
  /** Establish the provider connection. */
  connect(target: ToyTarget, signal: AbortSignal): Promise<ToyConnection>;
  /** Run provider discovery for a bounded interval. */
  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>;
  /** Read the latest in-memory device snapshot. */
  list(signal: AbortSignal): Promise<ToyDevice[]>;
  /** Apply policy, send a scalar command, and schedule its exact-generation auto-stop. */
  control(request: RuntimeControlRequest, signal: AbortSignal): Promise<RuntimeControlResult>;
  /** Stop one device or all devices and cancel only the corresponding timers. */
  stop(deviceId: string | undefined, signal: AbortSignal): Promise<void>;
  /** Disconnect without disposing the runtime, allowing a later reconnect. */
  disconnect(signal: AbortSignal): Promise<void>;
  /** Reject new operations, stop timers, and await provider shutdown. */
  close(): Promise<void>;
  private validateControl;
  private scheduleStop;
  private clearTimer;
  private clearTimers;
  private exclusive;
}
//#endregion
//#region src/index.d.ts
/** Cordis plugin name. */
declare const name = "dsh-toy";
/** Harness services required by the model-facing consumer. */
declare const inject: string[];
/** Complete deployment configuration; defaults are filled by Schemastery. */
interface Config {
  /** Local Intiface WebSocket endpoint. */
  buttplugUrl?: string;
  /** Negotiated Buttplug protocol major version. */
  buttplugProtocolVersion?: 3 | 4;
  /** MonsterParty token from the share-link path; never exposed as a tool argument. */
  monsterPartySessionToken?: string;
  /** MonsterParty token-resolution endpoint. */
  monsterPartyApiUrl?: string;
  /** MonsterParty relay Origin header. */
  monsterPartyOrigin?: string;
  /** Client identity presented to both connection backends. */
  clientName?: string;
  /** HTTP/WebSocket setup timeout. */
  connectionTimeoutMs?: number;
  /** Buttplug request timeout. */
  requestTimeoutMs?: number;
  /** Intiface Engine executable discovered through PATH unless overridden. */
  intifaceExecutable?: string;
  /** Time allowed for an automatically started Intiface Engine to listen. */
  intifaceStartupTimeoutMs?: number;
  /** Download a pinned, verified official Intiface Engine when no executable is installed. */
  intifaceAutoDownload?: boolean;
  /** MonsterParty device-ready timeout. */
  readyTimeoutMs?: number;
  /** MonsterParty application heartbeat interval. */
  heartbeatIntervalMs?: number;
  /** Buttplug discovery window. */
  scanDurationMs?: number;
  /** Read-only macOS CoreBluetooth discovery window for unknown hardware. */
  rawBleScanDurationMs?: number;
  /** Duration used when toy_control omits one. */
  defaultDurationSeconds?: number;
  /** Hard command-duration cap. */
  maxDurationSeconds?: number;
  /** Hard command-intensity cap. */
  maxIntensityPercent?: number;
  /** Permit indefinite hold commands. */
  allowHold?: boolean;
  /** DG-LAB Coyote WebSocket server listen port (0 = random). */
  dgLabListenPort?: number;
  /** DG-LAB Coyote public host or IP for QR code (must be reachable from the phone). */
  dgLabPublicHost?: string;
  /** DG-LAB Coyote WebSocket scheme for the QR code URL. */
  dgLabWsScheme?: 'ws' | 'wss';
  /** DG-LAB Coyote heartbeat broadcast interval. */
  dgLabHeartbeatIntervalMs?: number;
  /** DG-LAB Coyote maximum strength value (0-200). */
  dgLabMaxStrength?: number;
  /** DG-LAB Coyote App binding wait timeout. */
  dgLabReadyTimeoutMs?: number;
}
declare const Config: z<Config>;
type ResolvedConfig = Required<Omit<Config, 'monsterPartySessionToken'>> & Pick<Config, 'monsterPartySessionToken'>;
/** Resolve configuration and fail plugin load on unsafe or incomplete values. */
declare function resolveConfig(config: Config): ResolvedConfig;
/** Register the connection, discovery, control, stop, and disconnect tools. */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { AutoToyBackend, type AutoToyBackendConfig, ButtplugBackend, type ButtplugConfig, Config, DEFAULT_STRENGTH_LIMIT, DgLabBackend, type DgLabConfig, type IntifaceArtifact, type IntifaceProcessConfig, IntifaceProcessManager, MACOS_RAW_BLE_SCANNER_SOURCE, MAX_MESSAGE_LENGTH, MAX_PULSE_PER_SEND, ManagedButtplugBackend, MonsterPartyBackend, type MonsterPartyConfig, type PulseChannel, type RawBleAdvertisement, type RuntimeControlRequest, type RuntimeControlResult, type StrengthChannel, type StrengthMode, type ToyBackend, type ToyConnection, type ToyDevice, ToyError, type ToyFeature, type ToyFeatureKind, type ToyLevelCommand, type ToyProvider, ToyRuntime, type ToySafetyConfig, type ToyTarget, apply, buildQrPayload, clearCmd, createIntifaceUserDeviceConfig, extractIntifaceExecutable, inject, installIntifaceEngine, intifaceArguments, mapIntensityToStrength, name, parseButtplugDeviceList, parseRawBleScan, pulseCmd, resolveConfig, routeToyTarget, scanMacOSRawBle, selectIntifaceArtifact, strengthCmd };