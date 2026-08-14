/** Read-only raw BLE discovery through macOS CoreBluetooth. */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToyError } from './types.ts'

/** One connectable raw BLE advertisement, not a controllable toy device. */
export interface RawBleAdvertisement {
  id: string
  name?: string
  rssi: number
  connectable: boolean
  manufacturerData?: string
  services?: string[]
}

export const MACOS_RAW_BLE_SCANNER_SOURCE = String.raw`
import CoreBluetooth
import Foundation

final class RawBLEScanner: NSObject, CBCentralManagerDelegate {
    private var central: CBCentralManager!
    private var devices: [UUID: [String: Any]] = [:]
    private var started = false
    private var finished = false
    private let duration: TimeInterval

    init(durationMilliseconds: Int) {
        duration = Double(durationMilliseconds) / 1000.0
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + duration + 5.0) { [weak self] in
            self?.finish()
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard !started else { return }
        if central.state == .poweredOn {
            started = true
            central.scanForPeripherals(
                withServices: nil,
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
            )
            DispatchQueue.main.asyncAfter(deadline: .now() + duration) { [weak self] in
                self?.finish()
            }
        } else if central.state != .unknown && central.state != .resetting {
            let message = "CoreBluetooth unavailable (state \(central.state.rawValue))\n"
            FileHandle.standardError.write(message.data(using: .utf8)!)
            exit(2)
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard (advertisementData[CBAdvertisementDataIsConnectable] as? NSNumber)?.boolValue == true else {
            return
        }
        var item = devices[peripheral.identifier] ?? [
            "id": peripheral.identifier.uuidString,
            "connectable": true,
        ]
        let previousRSSI = item["rssi"] as? Int ?? -999
        item["rssi"] = max(previousRSSI, RSSI.intValue)
        if let name = peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String {
            item["name"] = name
        }
        if let uuids = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] {
            item["services"] = uuids.map(\.uuidString)
        }
        if let data = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data {
            item["manufacturerData"] = data.prefix(24).map { String(format: "%02x", $0) }.joined()
        }
        devices[peripheral.identifier] = item
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        central.stopScan()
        let ordered = devices.values.sorted {
            ($0["rssi"] as? Int ?? -999) > ($1["rssi"] as? Int ?? -999)
        }
        let output = Array(ordered.prefix(50))
        let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        exit(0)
    }
}

let requested = CommandLine.arguments.dropFirst().first.flatMap(Int.init) ?? 10_000
let duration = min(max(requested, 1_000), 60_000)
let scanner = RawBLEScanner(durationMilliseconds: duration)
RunLoop.main.run()
`

function runFile(executable: string, args: string[], signal: AbortSignal, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      signal,
      timeout,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout)
        return
      }
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : error)
        return
      }
      const detail = stderr.trim()
      reject(new ToyError(detail.length === 0 ? error.message : `${error.message}: ${detail}`))
    })
  })
}

/** Validate and detach the helper's JSON output. */
export function parseRawBleScan(raw: string): RawBleAdvertisement[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new ToyError('macOS raw BLE scanner returned invalid JSON')
  }
  if (!Array.isArray(value)) throw new ToyError('macOS raw BLE scanner returned an invalid device list')
  const devices: RawBleAdvertisement[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const candidate = item as Record<string, unknown>
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) continue
    if (typeof candidate.rssi !== 'number' || !Number.isFinite(candidate.rssi)) continue
    if (candidate.connectable !== true) continue
    const name = typeof candidate.name === 'string' && candidate.name.length > 0 ? candidate.name : undefined
    const manufacturerData = typeof candidate.manufacturerData === 'string' && /^[a-f0-9]*$/i.test(candidate.manufacturerData)
      ? candidate.manufacturerData.toLocaleLowerCase()
      : undefined
    const services = Array.isArray(candidate.services)
      ? candidate.services.filter((service): service is string => typeof service === 'string')
      : undefined
    devices.push({
      id: candidate.id,
      ...(name === undefined ? {} : { name }),
      rssi: candidate.rssi,
      connectable: true,
      ...(manufacturerData === undefined ? {} : { manufacturerData }),
      ...(services === undefined ? {} : { services }),
    })
  }
  return devices.sort((left, right) => right.rssi - left.rssi)
}

/** Compile a temporary CoreBluetooth helper, scan without Intiface, then remove it. */
export async function scanMacOSRawBle(durationMs: number, signal: AbortSignal): Promise<RawBleAdvertisement[]> {
  if (process.platform !== 'darwin') {
    throw new ToyError('Raw CoreBluetooth discovery is available only on macOS; use toy_connect with model "unknown" for the platform fallback')
  }
  if (!Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 60_000) {
    throw new ToyError('Raw BLE scan duration must be an integer from 1000 to 60000 milliseconds')
  }
  signal.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-toy-corebluetooth-'))
  const source = join(directory, 'scanner.swift')
  const binary = join(directory, 'scanner')
  const moduleCache = join(directory, 'module-cache')
  try {
    await writeFile(source, MACOS_RAW_BLE_SCANNER_SOURCE, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try {
      await runFile('/usr/bin/xcrun', [
        'swiftc',
        '-module-cache-path', moduleCache,
        source,
        '-o', binary,
      ], signal, 30_000)
    } catch (error) {
      if (signal.aborted) throw error
      throw new ToyError(`Could not build the macOS CoreBluetooth scanner; install Xcode Command Line Tools: ${error instanceof Error ? error.message : String(error)}`)
    }
    const output = await runFile(binary, [String(durationMs)], signal, durationMs + 10_000)
    return parseRawBleScan(output)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
