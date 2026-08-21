/**
 * Nullmesh server.js - HTTP polling for Heltec V3
 * More robust connection with retry logic and better error handling
 */
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { WebSocketServer } from 'ws';
import { fromBinary, toBinary, create } from '@bufbuild/protobuf';
import { Protobuf } from '@meshtastic/core';

const { Mesh, Portnums, Telemetry, Channel: ChannelPb } = Protobuf;
const { FromRadioSchema, ToRadioSchema, MeshPacketSchema, PositionSchema, UserSchema, RoutingSchema, Routing_Error } = Mesh;
const { PortNum } = Portnums;
const { TelemetrySchema } = Telemetry;

const SERVER_PORT = 3000;
const POLL_MS = 400;
const HEARTBEAT_MS = 8000;
const RECONNECT_MS = 5000;
const MAX_POLL_ERRORS = 5;

const httpServer = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(readFileSync('./index.html'));
  } else { res.writeHead(404); res.end(); }
});

const wss = new WebSocketServer({ server: httpServer });

let nodeHost = null;
let pollTimer = null;
let heartbeatTimer = null;
let active = false;
let polling = false;
let pollErrors = 0;
let reconnectTimer = null;

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
function log(msg) { console.log(`[${new Date().toTimeString().slice(0,8)}] ${msg}`); broadcast({ type: 'log', msg }); }
function numToId(num) { return '!' + ((num >>> 0)).toString(16).padStart(8, '0'); }

async function httpGet(url, timeout = 6000) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/x-protobuf', 'Connection': 'keep-alive' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function httpPut(url, body, timeout = 6000) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-protobuf', 'Connection': 'keep-alive' },
    body,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP PUT ${res.status}`);
}

async function sendWantConfig() {
  const configId = Math.floor(Math.random() * 0xFFFFFF);
  const toRadio = create(ToRadioSchema, { payloadVariant: { case: 'wantConfigId', value: configId } });
  await httpPut(`http://${nodeHost}/api/v1/toradio`, toBinary(ToRadioSchema, toRadio));
  log(`wantConfig sent (id=${configId})`);
}

async function sendHeartbeat() {
  if (!active) return;
  try {
    const toRadio = create(ToRadioSchema, { payloadVariant: { case: 'heartbeat', value: {} } });
    await httpPut(`http://${nodeHost}/api/v1/toradio`, toBinary(ToRadioSchema, toRadio), 4000);
  } catch (e) { log(`Heartbeat failed: ${e.message}`); }
}

function handleFromRadio(bytes) {
  if (!bytes || bytes.length === 0) return;
  let pkt;
  try { pkt = fromBinary(FromRadioSchema, bytes); } catch (e) { return; }
  if (!pkt?.payloadVariant?.case) return;

  const { case: kind, value: val } = pkt.payloadVariant;

  if (kind === 'myInfo') {
    broadcast({ type: 'myInfo', myNodeNum: Number(val.myNodeNum) });

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
      snr: n.snr ?? null,
      hopsAway: n.hopsAway ?? null,
      lastHeard: n.lastHeard ? new Date(Number(n.lastHeard) * 1000).toISOString() : null,
    }});

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

    broadcast({ type: 'signal', fromNum: from, fromId: numToId(from), rxRssi, rxSnr,
      hopsAway: hopStart != null && hopLimit != null ? hopStart - hopLimit : null });
    broadcast({ type: 'lastHeard', fromNum: from, ts: new Date().toISOString() });

    const decoded = mp.decoded;
    if (!decoded) return;

    if (decoded.portnum === PortNum.TEXT_MESSAGE_APP) {
      broadcast({ type: 'message',
        id: Number(mp.id), fromNum: from, fromId: numToId(from),
        toNum: to, toId: numToId(to), channel: mp.channel ?? 0,
        isDM: to !== 0xFFFFFFFF,
        text: new TextDecoder().decode(decoded.payload),
        rxRssi, rxSnr, hopLimit, hopStart, rxTime: new Date().toISOString(),
      });
    } else if (decoded.portnum === PortNum.ROUTING_APP) {
      try {
        const routing = fromBinary(RoutingSchema, decoded.payload);
        const requestId = Number(decoded.requestId || 0);
        let ackStatus = 'ack', errorCode = null;
        if (routing.variant?.case === 'errorReason') {
          const errVal = routing.variant.value;
          if (errVal !== Routing_Error.NONE && errVal !== 0) {
            ackStatus = 'nack';
            errorCode = Routing_Error[errVal] || `ERROR_${errVal}`;
          }
        }
        broadcast({ type: 'ack', requestId, fromNum: from, fromId: numToId(from), ackStatus, errorCode });
      } catch {}
    } else if (decoded.portnum === PortNum.POSITION_APP) {
      try {
        const pos = fromBinary(PositionSchema, decoded.payload);
        broadcast({ type: 'position', fromNum: from, fromId: numToId(from),
          lat: pos.latitudeI ? pos.latitudeI / 1e7 : null,
          lon: pos.longitudeI ? pos.longitudeI / 1e7 : null,
          alt: pos.altitude ?? null });
      } catch {}
    } else if (decoded.portnum === PortNum.TELEMETRY_APP) {
      try {
        const tel = fromBinary(TelemetrySchema, decoded.payload);
        const dm = tel.variant?.case === 'deviceMetrics' ? tel.variant.value : null;
        broadcast({ type: 'telemetry', fromNum: from, fromId: numToId(from),
          batteryLevel: dm?.batteryLevel ?? null,
          voltage: dm?.voltage ? (dm.voltage / 1000).toFixed(2) : null,
          chUtil: dm?.channelUtilization ?? null,
          airUtil: dm?.airUtilTx ?? null, rxRssi, rxSnr });
      } catch {}
    } else if (decoded.portnum === PortNum.NODEINFO_APP) {
      try {
        const user = fromBinary(UserSchema, decoded.payload);
        broadcast({ type: 'nodeUser', fromNum: from, fromId: numToId(from),
          longName: user.longName, shortName: user.shortName });
      } catch {}
    }
  } else if (kind === 'configCompleteId') {
    log('Node DB ready');
    broadcast({ type: 'dbReady' });
  }
}

async function poll() {
  if (!active || polling) return;
  polling = true;
  try {
    let i = 0;
    while (active && i < 100) {
      const bytes = await httpGet(`http://${nodeHost}/api/v1/fromradio`);
      if (bytes.length === 0) break;
      handleFromRadio(bytes);
      i++;
    }
    pollErrors = 0; // reset on success
  } catch (e) {
    if (!active) return;
    pollErrors++;
    if (pollErrors >= MAX_POLL_ERRORS) {
      log(`Too many poll errors (${pollErrors}) — attempting reconnect`);
      broadcast({ type: 'reconnecting' });
      stopTimers();
      reconnectTimer = setTimeout(() => attemptReconnect(), RECONNECT_MS);
    }
  } finally { polling = false; }
}

async function attemptReconnect() {
  if (!nodeHost) return;
  log(`Reconnecting to ${nodeHost}...`);
  broadcast({ type: 'reconnecting' });
  try {
    await fetch(`http://${nodeHost}/`, { signal: AbortSignal.timeout(5000) });
    active = true;
    pollErrors = 0;
    await sendWantConfig();
    startTimers();
    broadcast({ type: 'connected', ip: nodeHost });
    log('Reconnected');
  } catch (e) {
    log(`Reconnect failed: ${e.message} — retrying in ${RECONNECT_MS/1000}s`);
    reconnectTimer = setTimeout(() => attemptReconnect(), RECONNECT_MS);
  }
}

function startTimers() {
  stopTimers();
  pollTimer = setInterval(poll, POLL_MS);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
}

function stopTimers() {
  clearInterval(pollTimer); clearInterval(heartbeatTimer); clearTimeout(reconnectTimer);
  pollTimer = null; heartbeatTimer = null; reconnectTimer = null;
  polling = false;
}

async function drainStale(ip) {
  try { let n=0; while(n<50){const b=await httpGet(`http://${ip}/api/v1/fromradio`,3000);if(!b.length)break;n++;} } catch {}
}

async function doConnect(ip) {
  nodeHost = ip; active = false; pollErrors = 0;
  log(`Connecting to ${ip}...`);
  try {
    const res = await fetch(`http://${ip}/`, { signal: AbortSignal.timeout(5000) });
    log(`Reachable (${res.status})`);
  } catch (e) {
    broadcast({ type: 'connectError', error: `Cannot reach ${ip} — ${e.message}` });
    return;
  }
  await drainStale(ip);
  active = true;
  try { await sendWantConfig(); } catch (e) {
    broadcast({ type: 'connectError', error: `Init failed: ${e.message}` });
    active = false; return;
  }
  broadcast({ type: 'connected', ip });
  startTimers();
}

function doDisconnect(silent = false) {
  active = false; nodeHost = null; pollErrors = 0;
  stopTimers();
  if (!silent) broadcast({ type: 'disconnected' });
  log('Disconnected');
}

async function sendText(text, destNum, channelIndex) {
  const meshPacket = create(MeshPacketSchema, {
    to: destNum ?? 0xFFFFFFFF, channel: channelIndex ?? 0,
    decoded: { payload: new TextEncoder().encode(text), portnum: PortNum.TEXT_MESSAGE_APP },
    wantAck: true, hopLimit: 3,
  });
  const toRadio = create(ToRadioSchema, { payloadVariant: { case: 'packet', value: meshPacket } });
  await httpPut(`http://${nodeHost}/api/v1/toradio`, toBinary(ToRadioSchema, toRadio));
  return Number(meshPacket.id);
}

wss.on('connection', ws => {
  log('Browser connected');
  ws.send(JSON.stringify({ type: active ? 'connected' : 'disconnected', ip: nodeHost }));
  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'connect') { doDisconnect(true); await doConnect(msg.ip); }
    else if (msg.type === 'disconnect') { doDisconnect(); }
    else if (msg.type === 'sendMessage') {
      try {
        const pktId = await sendText(msg.text, msg.destinationNum ?? null, msg.channelIndex ?? 0);
        broadcast({ type: 'messageSent', text: msg.text,
          destinationNum: msg.destinationNum, channelIndex: msg.channelIndex,
          packetId: pktId, ts: new Date().toISOString() });
      } catch (e) { ws.send(JSON.stringify({ type: 'sendError', error: e.message })); }
    }
  });
  ws.on('close', () => log('Browser disconnected'));
});

httpServer.listen(SERVER_PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Nullmesh — http://localhost:${SERVER_PORT}    ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  if (process.platform === 'win32') {
    import('child_process').then(({ exec }) => exec(`start http://localhost:${SERVER_PORT}`));
  }
});
