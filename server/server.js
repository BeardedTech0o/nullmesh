/**
 * nullmesh server — HTTP polling for Heltec V3
 * ES module source — bundled to CJS by esbuild before packaging
 */
import { createServer } from 'http';


import { WebSocketServer } from 'ws';
import { fromBinary, toBinary, create } from '@bufbuild/protobuf';
import { Protobuf } from '@meshtastic/core';


const { Mesh, Portnums, Telemetry, Channel: ChannelPb, Admin, Config: ConfigNs } = Protobuf;
const { FromRadioSchema, ToRadioSchema, MeshPacketSchema, PositionSchema, UserSchema, RoutingSchema, Routing_Error } = Mesh;
const { PortNum } = Portnums;
const { TelemetrySchema } = Telemetry;
const { AdminMessageSchema, AdminMessage_ConfigType, AdminMessage_ModuleConfigType } = Admin;
const ModuleNs = Protobuf.ModuleConfig;
const {
  ConfigSchema,
  Config_DeviceConfigSchema,
  Config_DeviceConfig_Role,
  Config_DeviceConfig_RebroadcastMode,
  Config_DeviceConfig_BuzzerMode,
  Config_PositionConfigSchema,
  Config_PositionConfig_GpsMode,
  Config_PowerConfigSchema,
  Config_NetworkConfigSchema,
  Config_NetworkConfig_AddressMode,
  Config_DisplayConfigSchema,
  Config_DisplayConfig_GpsCoordinateFormat,
  Config_DisplayConfig_DisplayUnits,
  Config_DisplayConfig_OledType,
  Config_DisplayConfig_DisplayMode,
  Config_DisplayConfig_CompassOrientation,
  Config_LoRaConfigSchema,
  Config_LoRaConfig_ModemPreset,
  Config_LoRaConfig_RegionCode,
  Config_BluetoothConfigSchema,
  Config_BluetoothConfig_PairingMode,
} = ConfigNs;
const {
  ModuleConfigSchema,
  ModuleConfig_MQTTConfigSchema,
  ModuleConfig_SerialConfigSchema,
  ModuleConfig_SerialConfig_Serial_Baud,
  ModuleConfig_SerialConfig_Serial_Mode,
  ModuleConfig_ExternalNotificationConfigSchema,
  ModuleConfig_StoreForwardConfigSchema,
  ModuleConfig_RangeTestConfigSchema,
  ModuleConfig_TelemetryConfigSchema,
  ModuleConfig_CannedMessageConfigSchema,
  ModuleConfig_CannedMessageConfig_InputEventChar,
  ModuleConfig_AudioConfigSchema,
  ModuleConfig_AudioConfig_Audio_Baud,
  ModuleConfig_RemoteHardwareConfigSchema,
  ModuleConfig_NeighborInfoConfigSchema,
  ModuleConfig_AmbientLightingConfigSchema,
  ModuleConfig_DetectionSensorConfigSchema,
  ModuleConfig_DetectionSensorConfig_TriggerType,
  ModuleConfig_PaxcounterConfigSchema,
} = ModuleNs;

const SERVER_PORT = parseInt(process.env.NULLMESH_PORT || '3000');
const POLL_MS = 400;
const HEARTBEAT_MS = 8000;
const MAX_POLL_ERRORS = 5;
const RECONNECT_MS = 5000;

// Minimal HTTP server — only used for the TCP readiness check
// index.html is loaded directly by Electron as a local file
const httpServer = createServer((req, res) => {
  res.writeHead(200); res.end('nullmesh server running');
});

const wss = new WebSocketServer({ server: httpServer });

let nodeHost = null, nodePort = 80, pollTimer = null, heartbeatTimer = null;
let active = false, polling = false, pollErrors = 0, reconnectTimer = null;
// Admin / device-config state
let myNodeNum = null;              // learned from the myInfo FromRadio frame
let sessionPasskey = null;         // echoed back by the node on admin responses
const lastConfig = {};             // section -> whitelisted JSON view (sent to the UI)
const lastConfigRaw = {};          // section -> decoded protobuf message (kept so writes
                                   //   preserve fields nullmesh does not expose)
const configRefreshTimers = {};

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
function log(msg) { console.log(`[${new Date().toTimeString().slice(0,8)}] ${msg}`); broadcast({ type: 'log', msg }); }
function nodeBaseUrl() { return `http://${nodeHost}${nodePort !== 80 ? ':'+nodePort : ''}`; }
function numToId(num) { return '!' + ((num >>> 0)).toString(16).padStart(8, '0'); }

async function httpGet(url, timeout = 6000) {
  const res = await fetch(url, { headers: { 'Accept': 'application/x-protobuf' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
async function httpPut(url, body, timeout = 6000) {
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/x-protobuf' }, body, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP PUT ${res.status}`);
}

async function sendWantConfig() {
  const configId = Math.floor(Math.random() * 0xFFFFFF);
  const toRadio = create(ToRadioSchema, { payloadVariant: { case: 'wantConfigId', value: configId } });
  await httpPut(`${nodeBaseUrl()}/api/v1/toradio`, toBinary(ToRadioSchema, toRadio));
  log(`wantConfig sent (id=${configId})`);
}
async function sendHeartbeat() {
  if (!active) return;
  try { await httpPut(`${nodeBaseUrl()}/api/v1/toradio`, toBinary(ToRadioSchema, create(ToRadioSchema, { payloadVariant: { case: 'heartbeat', value: {} } })), 4000); } catch {}
}

// ── DEVICE CONFIG (AdminMessage over the same ToRadio HTTP endpoint) ──────
// Enum name lists are derived from the protobuf descriptors so the UI never
// drifts from the @meshtastic/core version we actually ship.
function enumOptions(enumObj) {
  return Object.entries(enumObj)
    .filter(([k]) => /^\d+$/.test(k))
    .map(([k, v]) => ({ value: Number(k), name: String(v) }))
    .sort((a, b) => a.value - b.value);
}
const CONFIG_ENUMS = {
  role: enumOptions(Config_DeviceConfig_Role),
  rebroadcastMode: enumOptions(Config_DeviceConfig_RebroadcastMode),
  buzzerMode: enumOptions(Config_DeviceConfig_BuzzerMode),
  gpsMode: enumOptions(Config_PositionConfig_GpsMode),
  addressMode: enumOptions(Config_NetworkConfig_AddressMode),
  gpsFormat: enumOptions(Config_DisplayConfig_GpsCoordinateFormat),
  displayUnits: enumOptions(Config_DisplayConfig_DisplayUnits),
  oledType: enumOptions(Config_DisplayConfig_OledType),
  displayMode: enumOptions(Config_DisplayConfig_DisplayMode),
  compassOrientation: enumOptions(Config_DisplayConfig_CompassOrientation),
  modemPreset: enumOptions(Config_LoRaConfig_ModemPreset),
  region: enumOptions(Config_LoRaConfig_RegionCode),
  pairingMode: enumOptions(Config_BluetoothConfig_PairingMode),
  serialBaud: enumOptions(ModuleConfig_SerialConfig_Serial_Baud),
  serialMode: enumOptions(ModuleConfig_SerialConfig_Serial_Mode),
  inputEvent: enumOptions(ModuleConfig_CannedMessageConfig_InputEventChar),
  audioBitrate: enumOptions(ModuleConfig_AudioConfig_Audio_Baud),
  triggerType: enumOptions(ModuleConfig_DetectionSensorConfig_TriggerType),
};

// ── Section registry ──────────────────────────────────────────────────────
// Every config section nullmesh can read/write. `fields` is the whitelist:
// anything the renderer sends that is not listed here is dropped, and every
// listed value is range-checked before it goes anywhere near the radio.
// Kinds: bool | string | uint (unsigned int) | sint (signed int) | float
const U32 = 0xffffffff;
const SECTIONS = {
  // ---- Config (AdminMessage get_config_request / set_config) -------------
  device: {
    kind: 'config', variant: 'device', schema: Config_DeviceConfigSchema,
    type: AdminMessage_ConfigType.DEVICE_CONFIG,
    fields: {
      role: { t:'uint', max:63 }, rebroadcastMode: { t:'uint', max:63 }, buzzerMode: { t:'uint', max:63 },
      buttonGpio: { t:'uint', max:63 }, buzzerGpio: { t:'uint', max:63 },
      nodeInfoBroadcastSecs: { t:'uint', max:604800 },
      serialEnabled: { t:'bool' }, doubleTapAsButtonPress: { t:'bool' }, isManaged: { t:'bool' },
      disableTripleClick: { t:'bool' }, ledHeartbeatDisabled: { t:'bool' },
      tzdef: { t:'string', max:64 },
    },
  },
  position: {
    kind: 'config', variant: 'position', schema: Config_PositionConfigSchema,
    type: AdminMessage_ConfigType.POSITION_CONFIG,
    fields: {
      gpsMode: { t:'uint', max:15 },
      gpsUpdateInterval: { t:'uint', max:604800 },
      positionBroadcastSecs: { t:'uint', max:604800 },
      positionBroadcastSmartEnabled: { t:'bool' },
      broadcastSmartMinimumDistance: { t:'uint', max:100000 },
      broadcastSmartMinimumIntervalSecs: { t:'uint', max:604800 },
      fixedPosition: { t:'bool' },
      positionFlags: { t:'uint', max:U32 },
      rxGpio: { t:'uint', max:63 }, txGpio: { t:'uint', max:63 }, gpsEnGpio: { t:'uint', max:63 },
    },
  },
  power: {
    kind: 'config', variant: 'power', schema: Config_PowerConfigSchema,
    type: AdminMessage_ConfigType.POWER_CONFIG,
    fields: {
      isPowerSaving: { t:'bool' },
      onBatteryShutdownAfterSecs: { t:'uint', max:31536000 },
      waitBluetoothSecs: { t:'uint', max:86400 },
      sdsSecs: { t:'uint', max:U32 },
      lsSecs: { t:'uint', max:U32 },
      minWakeSecs: { t:'uint', max:86400 },
      adcMultiplierOverride: { t:'float', min:0, max:10 },
      deviceBatteryInaAddress: { t:'uint', max:127 },
    },
  },
  network: {
    kind: 'config', variant: 'network', schema: Config_NetworkConfigSchema,
    type: AdminMessage_ConfigType.NETWORK_CONFIG,
    fields: {
      wifiEnabled: { t:'bool' },
      wifiSsid: { t:'string', max:32 },
      wifiPsk: { t:'string', max:64 },
      ethEnabled: { t:'bool' },
      addressMode: { t:'uint', max:15 },
      ipv6Enabled: { t:'bool' },
      ntpServer: { t:'string', max:32 },
      rsyslogServer: { t:'string', max:32 },
      enabledProtocols: { t:'uint', max:U32 },
    },
  },
  display: {
    kind: 'config', variant: 'display', schema: Config_DisplayConfigSchema,
    type: AdminMessage_ConfigType.DISPLAY_CONFIG,
    fields: {
      screenOnSecs: { t:'uint', max:604800 },
      autoScreenCarouselSecs: { t:'uint', max:604800 },
      wakeOnTapOrMotion: { t:'bool' },
      flipScreen: { t:'bool' },
      compassNorthTop: { t:'bool' },
      headingBold: { t:'bool' },
      use12hClock: { t:'bool' },
      units: { t:'uint', max:15 },
      gpsFormat: { t:'uint', max:15 },
      oled: { t:'uint', max:15 },
      displaymode: { t:'uint', max:15 },
      compassOrientation: { t:'uint', max:15 },
    },
  },
  lora: {
    kind: 'config', variant: 'lora', schema: Config_LoRaConfigSchema,
    type: AdminMessage_ConfigType.LORA_CONFIG,
    fields: {
      region: { t:'uint', max:63 },
      usePreset: { t:'bool' },
      modemPreset: { t:'uint', max:63 },
      hopLimit: { t:'uint', max:7 },
      txEnabled: { t:'bool' },
      txPower: { t:'sint', min:0, max:30 },
      channelNum: { t:'uint', max:255 },
      overrideDutyCycle: { t:'bool' },
      sx126xRxBoostedGain: { t:'bool' },
      paFanDisabled: { t:'bool' },
      ignoreMqtt: { t:'bool' },
      configOkToMqtt: { t:'bool' },
      bandwidth: { t:'uint', max:1000 },
      spreadFactor: { t:'uint', max:12 },
      codingRate: { t:'uint', max:8 },
      frequencyOffset: { t:'float', min:-100, max:100 },
      overrideFrequency: { t:'float', min:0, max:3000 },
    },
  },
  bluetooth: {
    kind: 'config', variant: 'bluetooth', schema: Config_BluetoothConfigSchema,
    type: AdminMessage_ConfigType.BLUETOOTH_CONFIG,
    fields: {
      enabled: { t:'bool' },
      mode: { t:'uint', max:15 },
      fixedPin: { t:'uint', max:999999 },
    },
  },
  // ---- ModuleConfig (get_module_config_request / set_module_config) ------
  mqtt: {
    kind: 'module', variant: 'mqtt', schema: ModuleConfig_MQTTConfigSchema,
    type: AdminMessage_ModuleConfigType.MQTT_CONFIG,
    fields: {
      enabled: { t:'bool' },
      address: { t:'string', max:63 },
      username: { t:'string', max:63 },
      password: { t:'string', max:63 },
      root: { t:'string', max:32 },
      encryptionEnabled: { t:'bool' }, jsonEnabled: { t:'bool' }, tlsEnabled: { t:'bool' },
      proxyToClientEnabled: { t:'bool' }, mapReportingEnabled: { t:'bool' },
    },
  },
  serial: {
    kind: 'module', variant: 'serial', schema: ModuleConfig_SerialConfigSchema,
    type: AdminMessage_ModuleConfigType.SERIAL_CONFIG,
    fields: {
      enabled: { t:'bool' }, echo: { t:'bool' },
      rxd: { t:'uint', max:63 }, txd: { t:'uint', max:63 },
      baud: { t:'uint', max:63 }, mode: { t:'uint', max:63 },
      timeout: { t:'uint', max:86400 },
      overrideConsoleSerialPort: { t:'bool' },
    },
  },
  externalNotification: {
    kind: 'module', variant: 'externalNotification', schema: ModuleConfig_ExternalNotificationConfigSchema,
    type: AdminMessage_ModuleConfigType.EXTNOTIF_CONFIG,
    fields: {
      enabled: { t:'bool' },
      outputMs: { t:'uint', max:600000 }, nagTimeout: { t:'uint', max:86400 },
      output: { t:'uint', max:63 }, outputVibra: { t:'uint', max:63 }, outputBuzzer: { t:'uint', max:63 },
      active: { t:'bool' }, usePwm: { t:'bool' }, useI2sAsBuzzer: { t:'bool' },
      alertMessage: { t:'bool' }, alertMessageVibra: { t:'bool' }, alertMessageBuzzer: { t:'bool' },
      alertBell: { t:'bool' }, alertBellVibra: { t:'bool' }, alertBellBuzzer: { t:'bool' },
    },
  },
  storeForward: {
    kind: 'module', variant: 'storeForward', schema: ModuleConfig_StoreForwardConfigSchema,
    type: AdminMessage_ModuleConfigType.STOREFORWARD_CONFIG,
    fields: {
      enabled: { t:'bool' }, heartbeat: { t:'bool' }, isServer: { t:'bool' },
      records: { t:'uint', max:100000 },
      historyReturnMax: { t:'uint', max:100000 },
      historyReturnWindow: { t:'uint', max:604800 },
    },
  },
  rangeTest: {
    kind: 'module', variant: 'rangeTest', schema: ModuleConfig_RangeTestConfigSchema,
    type: AdminMessage_ModuleConfigType.RANGETEST_CONFIG,
    fields: { enabled: { t:'bool' }, sender: { t:'uint', max:86400 }, save: { t:'bool' } },
  },
  telemetry: {
    kind: 'module', variant: 'telemetry', schema: ModuleConfig_TelemetryConfigSchema,
    type: AdminMessage_ModuleConfigType.TELEMETRY_CONFIG,
    fields: {
      deviceUpdateInterval: { t:'uint', max:604800 },
      environmentUpdateInterval: { t:'uint', max:604800 },
      environmentMeasurementEnabled: { t:'bool' }, environmentScreenEnabled: { t:'bool' },
      environmentDisplayFahrenheit: { t:'bool' },
      airQualityEnabled: { t:'bool' }, airQualityInterval: { t:'uint', max:604800 },
      powerMeasurementEnabled: { t:'bool' }, powerUpdateInterval: { t:'uint', max:604800 },
      powerScreenEnabled: { t:'bool' },
      healthMeasurementEnabled: { t:'bool' }, healthUpdateInterval: { t:'uint', max:604800 },
      healthScreenEnabled: { t:'bool' },
    },
  },
  cannedMessage: {
    kind: 'module', variant: 'cannedMessage', schema: ModuleConfig_CannedMessageConfigSchema,
    type: AdminMessage_ModuleConfigType.CANNEDMSG_CONFIG,
    fields: {
      enabled: { t:'bool' }, sendBell: { t:'bool' },
      rotary1Enabled: { t:'bool' }, updown1Enabled: { t:'bool' },
      inputbrokerPinA: { t:'uint', max:63 }, inputbrokerPinB: { t:'uint', max:63 },
      inputbrokerPinPress: { t:'uint', max:63 },
      inputbrokerEventCw: { t:'uint', max:63 }, inputbrokerEventCcw: { t:'uint', max:63 },
      inputbrokerEventPress: { t:'uint', max:63 },
      allowInputSource: { t:'string', max:16 },
    },
  },
  audio: {
    kind: 'module', variant: 'audio', schema: ModuleConfig_AudioConfigSchema,
    type: AdminMessage_ModuleConfigType.AUDIO_CONFIG,
    fields: {
      codec2Enabled: { t:'bool' }, bitrate: { t:'uint', max:63 },
      pttPin: { t:'uint', max:63 }, i2sWs: { t:'uint', max:63 },
      i2sSd: { t:'uint', max:63 }, i2sDin: { t:'uint', max:63 }, i2sSck: { t:'uint', max:63 },
    },
  },
  remoteHardware: {
    kind: 'module', variant: 'remoteHardware', schema: ModuleConfig_RemoteHardwareConfigSchema,
    type: AdminMessage_ModuleConfigType.REMOTEHARDWARE_CONFIG,
    fields: { enabled: { t:'bool' }, allowUndefinedPinAccess: { t:'bool' } },
  },
  neighborInfo: {
    kind: 'module', variant: 'neighborInfo', schema: ModuleConfig_NeighborInfoConfigSchema,
    type: AdminMessage_ModuleConfigType.NEIGHBORINFO_CONFIG,
    fields: { enabled: { t:'bool' }, updateInterval: { t:'uint', max:604800 }, transmitOverLora: { t:'bool' } },
  },
  ambientLighting: {
    kind: 'module', variant: 'ambientLighting', schema: ModuleConfig_AmbientLightingConfigSchema,
    type: AdminMessage_ModuleConfigType.AMBIENTLIGHTING_CONFIG,
    fields: {
      ledState: { t:'bool' }, current: { t:'uint', max:255 },
      red: { t:'uint', max:255 }, green: { t:'uint', max:255 }, blue: { t:'uint', max:255 },
    },
  },
  detectionSensor: {
    kind: 'module', variant: 'detectionSensor', schema: ModuleConfig_DetectionSensorConfigSchema,
    type: AdminMessage_ModuleConfigType.DETECTIONSENSOR_CONFIG,
    fields: {
      enabled: { t:'bool' }, name: { t:'string', max:20 },
      minimumBroadcastSecs: { t:'uint', max:604800 },
      stateBroadcastSecs: { t:'uint', max:604800 },
      monitorPin: { t:'uint', max:63 },
      detectionTriggerType: { t:'uint', max:63 },
      usePullup: { t:'bool' }, sendBell: { t:'bool' },
    },
  },
  paxcounter: {
    kind: 'module', variant: 'paxcounter', schema: ModuleConfig_PaxcounterConfigSchema,
    type: AdminMessage_ModuleConfigType.PAXCOUNTER_CONFIG,
    fields: {
      enabled: { t:'bool' },
      paxcounterUpdateInterval: { t:'uint', max:604800 },
      wifiThreshold: { t:'sint', min:-128, max:0 },
      bleThreshold: { t:'sint', min:-128, max:0 },
    },
  },
};

// Reverse lookups from the protobuf oneof case name back to our section key
const CONFIG_CASE_TO_SECTION = {}, MODULE_CASE_TO_SECTION = {};
for (const [name, s] of Object.entries(SECTIONS)) {
  (s.kind === 'config' ? CONFIG_CASE_TO_SECTION : MODULE_CASE_TO_SECTION)[s.variant] = name;
}

function sectionToJson(name, msg) {
  const out = {};
  for (const [key, spec] of Object.entries(SECTIONS[name].fields)) {
    const v = msg?.[key];
    if (spec.t === 'bool') out[key] = !!v;
    else if (spec.t === 'string') out[key] = String(v ?? '');
    else if (spec.t === 'float') out[key] = Number(v ?? 0);
    else out[key] = Number(v ?? 0);
  }
  return out;
}

function publishConfigSection(name, msg, source) {
  if (!SECTIONS[name]) return;
  lastConfigRaw[name] = msg;
  lastConfig[name] = sectionToJson(name, msg);
  broadcast({ type: 'configSection', section: name, source, config: lastConfig[name], enums: CONFIG_ENUMS });
}

function coerceField(key, spec, raw) {
  if (spec.t === 'bool') return !!raw;
  if (spec.t === 'string') {
    const s = String(raw ?? '');
    if (s.length > (spec.max ?? 64)) throw new Error(`${key} is too long (max ${spec.max ?? 64} characters)`);
    return s;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid value for ${key}`);
  if (spec.t === 'float') {
    const lo = spec.min ?? -1e9, hi = spec.max ?? 1e9;
    if (n < lo || n > hi) throw new Error(`${key} must be between ${lo} and ${hi}`);
    return n;
  }
  const lo = spec.min ?? 0, hi = spec.max ?? U32;
  if (n < lo || n > hi) throw new Error(`${key} must be between ${lo} and ${hi}`);
  return Math.floor(n);
}

async function sendAdmin(variantCase, variantValue, wantResponse = false) {
  if (!active) throw new Error('Not connected to a node');
  if (myNodeNum == null) throw new Error('Node identity not known yet — wait for the mesh to finish loading');
  const admin = create(AdminMessageSchema, {
    ...(sessionPasskey?.length ? { sessionPasskey } : {}),
    payloadVariant: { case: variantCase, value: variantValue },
  });
  const packetId = Math.floor(Math.random() * 0x7ffffffe) + 1;
  const mp = create(MeshPacketSchema, {
    id: packetId,
    to: myNodeNum,
    channel: 0,
    // `decoded` is a member of MeshPacket's payload_variant oneof. protobuf-es
    // v2 only accepts the {case, value} form — a bare `decoded: {...}` key is
    // silently discarded, producing a packet with no portnum and no payload.
    payloadVariant: {
      case: 'decoded',
      value: {
        portnum: PortNum.ADMIN_APP,
        payload: toBinary(AdminMessageSchema, admin),
        wantResponse,
      },
    },
    wantAck: false,
    hopLimit: 0,
  });
  await httpPut(`${nodeBaseUrl()}/api/v1/toradio`,
    toBinary(ToRadioSchema, create(ToRadioSchema, { payloadVariant: { case: 'packet', value: mp } })));
  return packetId;
}

async function requestConfigSection(name) {
  const sec = SECTIONS[name];
  if (!sec) throw new Error(`Unknown config section: ${name}`);
  await sendAdmin(sec.kind === 'config' ? 'getConfigRequest' : 'getModuleConfigRequest', sec.type, true);
  log(`${name} config requested`);
}

async function setConfigSection(name, patch) {
  const sec = SECTIONS[name];
  if (!sec) throw new Error(`Unknown config section: ${name}`);
  if (!patch || typeof patch !== 'object') throw new Error('No config supplied');
  // set_config / set_module_config replace the whole submessage, so start from
  // the last message the node actually sent us (which keeps fields nullmesh
  // does not expose, e.g. LoRa ignoreIncoming or remote hardware pin lists)
  // and lay the validated patch on top.
  const merged = { ...(lastConfigRaw[name] || {}) };
  delete merged.$typeName;
  delete merged.$unknown;
  for (const [key, spec] of Object.entries(sec.fields)) {
    if (!(key in patch)) continue;
    merged[key] = coerceField(key, spec, patch[key]);
  }
  const value = create(sec.schema, merged);
  if (sec.kind === 'config') {
    const wrapper = create(ConfigSchema, { payloadVariant: { case: sec.variant, value } });
    await sendAdmin('beginEditSettings', true);
    await sendAdmin('setConfig', wrapper);
    await sendAdmin('commitEditSettings', true);
  } else {
    const wrapper = create(ModuleConfigSchema, { payloadVariant: { case: sec.variant, value } });
    await sendAdmin('beginEditSettings', true);
    await sendAdmin('setModuleConfig', wrapper);
    await sendAdmin('commitEditSettings', true);
  }
  lastConfigRaw[name] = value;
  lastConfig[name] = sectionToJson(name, value);
  log(`${name} config written`);
  // Read it back so the UI reflects what the node actually stored.
  clearTimeout(configRefreshTimers[name]);
  configRefreshTimers[name] = setTimeout(() => { requestConfigSection(name).catch(() => {}); }, 3000);
}

function handleFromRadio(bytes) {
  if (!bytes?.length) return;
  let pkt; try { pkt = fromBinary(FromRadioSchema, bytes); } catch { return; }
  if (!pkt?.payloadVariant?.case) return;
  const { case: kind, value: val } = pkt.payloadVariant;

  if (kind === 'myInfo') {
    myNodeNum = Number(val.myNodeNum);
    broadcast({ type: 'myInfo', myNodeNum });
  } else if (kind === 'nodeInfo') {
    const n = val;
    broadcast({ type: 'node', node: {
      num: Number(n.num), id: numToId(Number(n.num)),
      name: n.user?.longName || n.user?.shortName || numToId(Number(n.num)),
      shortName: n.user?.shortName || '???',
      hwModel: n.user?.hwModel ?? 0,
      lat: n.position?.latitudeI ? n.position.latitudeI / 1e7 : null,
      lon: n.position?.longitudeI ? n.position.longitudeI / 1e7 : null,
      alt: n.position?.altitude ?? null,
      battery: n.deviceMetrics?.batteryLevel ?? null,
      voltage: n.deviceMetrics?.voltage ? (n.deviceMetrics.voltage / 1000).toFixed(2) : null,
      chUtil: n.deviceMetrics?.channelUtilization ?? null,
      airUtil: n.deviceMetrics?.airUtilTx ?? null,
      snr: n.snr ?? null, hopsAway: n.hopsAway ?? null,
      lastHeard: n.lastHeard ? new Date(Number(n.lastHeard) * 1000).toISOString() : null,
    }});
  } else if (kind === 'config') {
    // The node streams its whole Config after wantConfig — pick up every
    // sub-config it sends so the UI is populated without another round-trip.
    const sec = CONFIG_CASE_TO_SECTION[val?.payloadVariant?.case];
    if (sec) publishConfigSection(sec, val.payloadVariant.value, 'stream');
  } else if (kind === 'moduleConfig') {
    const sec = MODULE_CASE_TO_SECTION[val?.payloadVariant?.case];
    if (sec) publishConfigSection(sec, val.payloadVariant.value, 'stream');
  } else if (kind === 'channel') {
    const ch = val;
    if (ch.role === 0) return;
    broadcast({ type: 'channel', channel: {
      index: ch.index,
      name: ch.settings?.name || (ch.index === 0 ? 'Primary' : `Channel ${ch.index}`),
      role: ch.role === 1 ? 'PRIMARY' : 'SECONDARY',
    }});
  } else if (kind === 'packet') {
    const mp = val;
    const from = Number(mp.from), to = Number(mp.to);
    const rxRssi = mp.rxRssi ?? null, rxSnr = mp.rxSnr ?? null;
    const hopLimit = mp.hopLimit ?? null, hopStart = mp.hopStart ?? null;
    broadcast({ type: 'signal', fromNum: from, fromId: numToId(from), rxRssi, rxSnr, hopsAway: hopStart != null && hopLimit != null ? hopStart - hopLimit : null });
    broadcast({ type: 'lastHeard', fromNum: from, ts: new Date().toISOString() });
    // Same oneof rule on the way in: a decoded MeshPacket exposes its Data as
    // payloadVariant.value, never as a `.decoded` property. Reading `mp.decoded`
    // always yielded undefined and bailed here, silently dropping every single
    // MeshPacket — text messages, routing acks, position, telemetry and admin
    // responses alike. (Node list/channels/config kept working because those
    // arrive as top-level FromRadio variants, which are dispatched correctly.)
    const decoded = mp.payloadVariant?.case === 'decoded' ? mp.payloadVariant.value : null;
    if (!decoded) return;
    if (decoded.portnum === PortNum.TEXT_MESSAGE_APP) {
      broadcast({ type: 'message', id: Number(mp.id), fromNum: from, fromId: numToId(from), toNum: to, toId: numToId(to), channel: mp.channel ?? 0, isDM: to !== 0xFFFFFFFF, text: new TextDecoder().decode(decoded.payload), rxRssi, rxSnr, hopLimit, hopStart, rxTime: new Date().toISOString() });
    } else if (decoded.portnum === PortNum.ROUTING_APP) {
      try {
        const routing = fromBinary(RoutingSchema, decoded.payload);
        const requestId = Number(decoded.requestId || 0);
        let ackStatus = 'ack', errorCode = null;
        if (routing.variant?.case === 'errorReason') {
          const errVal = routing.variant.value;
          if (errVal !== Routing_Error.NONE && errVal !== 0) { ackStatus = 'nack'; errorCode = Routing_Error[errVal] || `ERROR_${errVal}`; }
        }
        log(`RX routing ack requestId=${requestId} from=${numToId(from)} status=${ackStatus}${errorCode ? ' error=' + errorCode : ''}`);
        broadcast({ type: 'ack', requestId, fromNum: from, fromId: numToId(from), ackStatus, errorCode });
      } catch (e) { log(`RX routing packet failed to decode: ${e?.message || e}`); }
    } else if (decoded.portnum === PortNum.POSITION_APP) {
      try { const pos = fromBinary(PositionSchema, decoded.payload); broadcast({ type: 'position', fromNum: from, fromId: numToId(from), lat: pos.latitudeI ? pos.latitudeI / 1e7 : null, lon: pos.longitudeI ? pos.longitudeI / 1e7 : null, alt: pos.altitude ?? null }); } catch {}
    } else if (decoded.portnum === PortNum.TELEMETRY_APP) {
      try { const tel = fromBinary(TelemetrySchema, decoded.payload); const dm = tel.variant?.case === 'deviceMetrics' ? tel.variant.value : null; broadcast({ type: 'telemetry', fromNum: from, fromId: numToId(from), batteryLevel: dm?.batteryLevel ?? null, voltage: dm?.voltage ? (dm.voltage/1000).toFixed(2) : null, chUtil: dm?.channelUtilization ?? null, airUtil: dm?.airUtilTx ?? null, rxRssi, rxSnr }); } catch {}
    } else if (decoded.portnum === PortNum.ADMIN_APP) {
      try {
        const am = fromBinary(AdminMessageSchema, decoded.payload);
        if (am.sessionPasskey?.length) sessionPasskey = am.sessionPasskey;
        if (am.payloadVariant?.case === 'getConfigResponse') {
          const cfg = am.payloadVariant.value;
          const sec = CONFIG_CASE_TO_SECTION[cfg?.payloadVariant?.case];
          if (sec) publishConfigSection(sec, cfg.payloadVariant.value, 'admin');
        } else if (am.payloadVariant?.case === 'getModuleConfigResponse') {
          const cfg = am.payloadVariant.value;
          const sec = MODULE_CASE_TO_SECTION[cfg?.payloadVariant?.case];
          if (sec) publishConfigSection(sec, cfg.payloadVariant.value, 'admin');
        }
      } catch {}
    } else if (decoded.portnum === PortNum.NODEINFO_APP) {
      try { const user = fromBinary(UserSchema, decoded.payload); broadcast({ type: 'nodeUser', fromNum: from, fromId: numToId(from), longName: user.longName, shortName: user.shortName }); } catch {}
    }
  } else if (kind === 'configCompleteId') {
    log('Mesh ready'); broadcast({ type: 'dbReady' });
  }
}

async function poll() {
  if (!active || polling) return;
  polling = true;
  try {
    let i = 0;
    while (active && i < 100) { const b = await httpGet(`${nodeBaseUrl()}/api/v1/fromradio`); if (!b.length) break; handleFromRadio(b); i++; }
    pollErrors = 0;
  } catch (e) {
    if (!active) return;
    if (++pollErrors >= MAX_POLL_ERRORS) { log('Reconnecting...'); broadcast({ type: 'reconnecting' }); stopTimers(); reconnectTimer = setTimeout(attemptReconnect, RECONNECT_MS); }
  } finally { polling = false; }
}

async function attemptReconnect() {
  if (!nodeHost) return;
  try { await fetch(`${nodeBaseUrl()}/`, { signal: AbortSignal.timeout(5000) }); active = true; pollErrors = 0; await sendWantConfig(); startTimers(); broadcast({ type: 'connected', ip: nodeHost }); log('Reconnected'); }
  catch { reconnectTimer = setTimeout(attemptReconnect, RECONNECT_MS); }
}

function startTimers() { stopTimers(); pollTimer = setInterval(poll, POLL_MS); heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS); }
function stopTimers() { clearInterval(pollTimer); clearInterval(heartbeatTimer); clearTimeout(reconnectTimer); pollTimer=null; heartbeatTimer=null; reconnectTimer=null; polling=false; }

async function sendText(text, destNum, channelIndex) {
  // Sanitise input
  if (typeof text !== 'string' || text.length === 0 || text.length > 237) {
    throw new Error('Message must be 1-237 characters (Meshtastic limit)');
  }
  // The packet id must be assigned here, client-side — leaving it unset defaults
  // to 0, so the node silently assigns its own real id on receipt. That real id
  // is what comes back as `requestId` on the Routing ack, which then never
  // matches the (always-0) id we told the UI to track, so ack status can never
  // update no matter how many acks actually arrive.
  const packetId = Math.floor(Math.random() * 0x7ffffffe) + 1;
  // `decoded` is a member of MeshPacket's payload_variant oneof — it must use
  // the {case, value} form. A bare `decoded: {...}` key is silently discarded by
  // protobuf-es v2, which sent the message out with no portnum and no text.
  const mp = create(MeshPacketSchema, {
    id: packetId,
    to: destNum ?? 0xFFFFFFFF,
    channel: channelIndex ?? 0,
    payloadVariant: {
      case: 'decoded',
      value: { payload: new TextEncoder().encode(text), portnum: PortNum.TEXT_MESSAGE_APP },
    },
    wantAck: true,
    hopLimit: 3,
  });
  log(`TX text packetId=${packetId} to=${destNum ?? 'broadcast'} channel=${channelIndex ?? 0} wantAck=true`);
  await httpPut(`${nodeBaseUrl()}/api/v1/toradio`, toBinary(ToRadioSchema, create(ToRadioSchema, { payloadVariant: { case: 'packet', value: mp } })));
  return packetId;
}

async function doConnect(ip, port) {
  port = port || 80;
  // Validate IP/hostname — only allow valid IPs and local hostnames
  // Prevent SSRF to internal services other than Meshtastic nodes
  const ipOk = /^[a-zA-Z0-9._-]+$/.test(ip) && ip.length < 64;
  const portOk = Number.isInteger(port) && port > 0 && port < 65536;
  if (!ipOk || !portOk) {
    broadcast({ type: 'connectError', error: 'Invalid IP address or port' });
    return;
  }
  nodeHost = ip; nodePort = port; active = false; pollErrors = 0;
  const baseUrl = `http://${ip}${port !== 80 ? ':'+port : ''}`;
  log(`Connecting to ${baseUrl}...`);
  try { await fetch(`http://${ip}${port !== 80 ? ":"+port : ""}/`, { signal: AbortSignal.timeout(5000) }); }
  catch (e) { broadcast({ type: 'connectError', error: `Cannot reach ${ip} — ${e.message}` }); return; }
  await (async()=>{ try { let n=0; while(n<50){const b=await httpGet(`http://${ip}${port !== 80 ? ":"+port : ""}/api/v1/fromradio`,3000);if(!b.length)break;n++;} } catch{} })();
  active = true;
  try { await sendWantConfig(); } catch (e) { broadcast({ type: 'connectError', error: `Init failed: ${e.message}` }); active=false; return; }
  broadcast({ type: 'connected', ip });
  startTimers();
}

function doDisconnect(silent=false) {
  active=false; pollErrors=0; nodeHost=null;
  myNodeNum=null; sessionPasskey=null;
  for (const k of Object.keys(lastConfig)) delete lastConfig[k];
  for (const k of Object.keys(lastConfigRaw)) delete lastConfigRaw[k];
  for (const k of Object.keys(configRefreshTimers)) { clearTimeout(configRefreshTimers[k]); delete configRefreshTimers[k]; }
  stopTimers();
  if(!silent) broadcast({ type: 'disconnected' });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: active ? 'connected' : 'disconnected', ip: nodeHost }));
  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'connect') { doDisconnect(true); await doConnect(msg.ip, msg.port || 80); }
    else if (msg.type === 'disconnect') { doDisconnect(); }
    else if (msg.type === 'getConfig') {
      const name = msg.section;
      if (!SECTIONS[name]) { ws.send(JSON.stringify({ type: 'configResult', ok: false, action: 'read', section: name, error: 'Unknown config section' })); return; }
      if (lastConfig[name]) ws.send(JSON.stringify({ type: 'configSection', section: name, source: 'cache', config: lastConfig[name], enums: CONFIG_ENUMS }));
      try { await requestConfigSection(name); }
      catch (e) { ws.send(JSON.stringify({ type: 'configResult', ok: false, action: 'read', section: name, error: e.message })); }
    }
    else if (msg.type === 'setConfig') {
      try { await setConfigSection(msg.section, msg.config); broadcast({ type: 'configResult', ok: true, action: 'write', section: msg.section }); }
      catch (e) { ws.send(JSON.stringify({ type: 'configResult', ok: false, action: 'write', section: msg.section, error: e.message })); }
    }
    else if (msg.type === 'sendMessage') {
      try { const id = await sendText(msg.text, msg.destinationNum??null, msg.channelIndex??0); broadcast({ type: 'messageSent', text: msg.text, destinationNum: msg.destinationNum, channelIndex: msg.channelIndex, packetId: id, ts: new Date().toISOString() }); }
      catch (e) { ws.send(JSON.stringify({ type: 'sendError', error: e.message })); }
    }
  });
});

httpServer.listen(SERVER_PORT, '127.0.0.1', () => {
  log(`Server listening on port ${SERVER_PORT}`);
});
