import { describe, expect, it } from 'vitest'
import { MACOS_RAW_BLE_SCANNER_SOURCE, parseRawBleScan } from '../src/macos-ble.ts'

describe('macOS raw BLE discovery', () => {
  it('uses read-only CoreBluetooth discovery', () => {
    expect(MACOS_RAW_BLE_SCANNER_SOURCE).toContain('CBCentralManager')
    expect(MACOS_RAW_BLE_SCANNER_SOURCE).toContain('scanForPeripherals')
    expect(MACOS_RAW_BLE_SCANNER_SOURCE).not.toContain('writeValue')
    expect(MACOS_RAW_BLE_SCANNER_SOURCE).not.toContain('connect(')
  })

  it('validates, normalizes, and sorts advertisements', () => {
    expect(parseRawBleScan(JSON.stringify([
      { id: 'weak', name: '', rssi: -70, connectable: true, manufacturerData: 'AABB' },
      { id: 'ignored', rssi: -10, connectable: false },
      { id: 'strong', name: 'RoomFun', rssi: -25, connectable: true, services: ['6000'] },
    ]))).toEqual([
      { id: 'strong', name: 'RoomFun', rssi: -25, connectable: true, services: ['6000'] },
      { id: 'weak', rssi: -70, connectable: true, manufacturerData: 'aabb' },
    ])
    expect(() => parseRawBleScan('{}')).toThrow('invalid device list')
  })
})
