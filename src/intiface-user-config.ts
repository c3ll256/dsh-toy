/** Built-in Intiface user mappings for devices verified locally but absent upstream. */

const ROOMFUN_PROTOCOL_ID = 'monsterpub'

/** Build an Intiface user config matching the executable's device-config major version. */
export function createIntifaceUserDeviceConfig(engineMajor: number): string {
  if (engineMajor !== 4 && engineMajor !== 5) {
    throw new Error(`Unsupported Intiface device-config major version: ${engineMajor}`)
  }
  return JSON.stringify({
    version: { major: engineMajor, minor: 0 },
    user_configs: {
      protocols: {
        [ROOMFUN_PROTOCOL_ID]: {
          communication: [{
            btle: {
              names: ['RoomFun'],
              services: {
                '00006000-0000-1000-8000-00805f9b34fb': {
                  tx: '00006001-0000-1000-8000-00805f9b34fb',
                  txmode: '00006002-0000-1000-8000-00805f9b34fb',
                },
                '00006010-0000-1000-8000-00805f9b34fb': {
                  rxblemodel: '00006014-0000-1000-8000-00805f9b34fb',
                },
              },
            },
          }],
          configurations: [{
            identifier: ['RF_CANNON_PT3'],
            name: 'RoomFun Cannon',
            id: '4cb2f81d-fb4f-4f70-a80f-72ef42e69bc1',
            features: [{
              id: 'c9281675-7ab0-4e1c-907a-1c4de52f8bac',
              index: 0,
              output: { vibrate: { value: [0, 100] } },
            }],
          }],
        },
      },
    },
  }, undefined, 2)
}
