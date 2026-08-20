const ONLINE_MS = 30 * 60 * 1000;

const S = {
  ws:null, connected:false, myNodeNum:null,
  nodes:{}, channels:{}, conversations:{}, activeDM:null, activeChannel:null, unread:{},
  msgIndex:{},
  filter:'all', startTime:null, selectedNode:null,
  uptimeTimer:null, wsTimer:null,
  // UI shell state
  page:'messages', peerFilter:'all', everConnected:false,
  // Config page state — one entry per config section (see CFG_SECTIONS)
  configs:{}, configEnums:null, configTab:'device', configModuleTab:'mqtt', configDirty:{},
  logs:[],
};

// ── WEBSOCKET ──────────────────────────────────────────────────────
function getWSPort() {
  // When running as Electron app, port is passed via additionalArguments
  // With sandbox:true, window.process may not be available
  // Check multiple sources
  try {
    // Electron exposes additionalArguments via process.argv in renderer
    const argv = (typeof process !== 'undefined' && process.argv) ? process.argv :
                 (window.process?.argv) ? window.process.argv : [];
    for (const a of argv) {
      if (typeof a === 'string') {
        const m = a.match(/--ws-port=(\d+)/);
        if (m) return parseInt(m[1]);
      }
    }
  } catch {}
  // Electron main also passes the port as a query string on the file:// URL
  try {
    const q = new URLSearchParams(location.search).get('wsPort');
    if (q && /^\d+$/.test(q)) return parseInt(q);
  } catch {}
  // Fallback for HTTP mode (dev)
  if (location.port) return parseInt(location.port);
  return 3000;
}

function connectWS() {
  if (S.ws) try { S.ws.close(); } catch {}
  const wsPort = getWSPort();
  S.ws = new WebSocket('ws://127.0.0.1:' + wsPort);
  S.ws.onopen = () => {
    clearInterval(S.wsTimer);
    S.wsTimer = setInterval(() => { try { S.ws.send(JSON.stringify({type:'ping'})); } catch {} }, 20000);
    sysMsg('Connected to Nullmesh server');
  };
  S.ws.onclose = () => { clearInterval(S.wsTimer); sysMsg('Reconnecting...'); setTimeout(connectWS, 2000); };
  S.ws.onerror = () => {};
  S.ws.onmessage = e => {
    try {
      // Only accept messages from our local server (already enforced by OS since
      // the WS only binds to 127.0.0.1, but validate the data shape too)
      const msg = JSON.parse(e.data);
      if (typeof msg !== 'object' || typeof msg.type !== 'string') return;
      handle(msg);
    } catch(ex) { console.error('[ws] Message parse error:', ex); }
  };
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.ws?.readyState !== WebSocket.OPEN) setTimeout(connectWS, 500);
});

function wsSend(o) { if(S.ws?.readyState===1) S.ws.send(JSON.stringify(o)); }

function isOnline(n) {
  if (n.num===S.myNodeNum) return true;
  if (!n.lastHeard) return false;
  return (Date.now()-new Date(n.lastHeard).getTime()) < ONLINE_MS;
}

// ── MESSAGE HANDLER ────────────────────────────────────────────────
function handle(msg) {
  switch(msg.type) {
    case 'pong': break;

    case 'connected':
      S.connected=true; S.startTime=Date.now();
      S.everConnected=true;
      try { localStorage.setItem('mn_ever_connected','1'); localStorage.setItem('mn_last_ip', msg.ip||''); } catch {}
      setConnUI(true, msg.ip);
      ['sendBtn','sendBtn2'].forEach(id=>{ const b=document.getElementById(id); if(b) b.disabled=false; });
      ['compInp','compInp2'].forEach(id=>{ const i=document.getElementById(id); if(i) i.disabled=false; });
      startUptime();
      hideFirstRun();
      updateIdentity();
      toast('Connected to '+msg.ip, 'ok');
      // Pull the radio's device config so the Config page is live straight away
      setTimeout(() => wsSend({type:'getDeviceConfig'}), 2500);
      break;

    case 'reconnecting':
      setConnUI('reconnecting', 'Reconnecting...');
      break;

    case 'disconnected': case 'connectError':
      S.connected=false;
      setConnUI(false, msg.type==='connectError' ? msg.error : 'Disconnected');
      ['sendBtn','sendBtn2'].forEach(id=>{ const b=document.getElementById(id); if(b) b.disabled=true; });
      ['compInp','compInp2'].forEach(id=>{ const i=document.getElementById(id); if(i) i.disabled=true; });
      clearInterval(S.uptimeTimer);
      { const ut=document.getElementById('uptimeText'); if(ut) ut.textContent=''; }
      if(msg.type==='connectError') toast(msg.error,'err');
      S.configs={}; S.configDirty={};
      updateIdentity();
      if(S.page==='config') renderConfigPage();
      break;

    case 'myInfo':
      S.myNodeNum=msg.myNodeNum;
      sysMsg('Your node: '+numToId(msg.myNodeNum));
      updateIdentity();
      break;

    case 'channel':
      S.channels[msg.channel.index]=msg.channel;
      ensureChTab(msg.channel); renderChatList();
      renderChannelsList();
      bumpChannelBadge();
      break;

    case 'node':
      S.nodes[msg.node.num]={...(S.nodes[msg.node.num]||{}), ...msg.node};
      renderChatList(); renderStats(); renderMap(); renderPeers(); updateIdentity();
      if(S.selectedNode===msg.node.num) renderNodeDetail(msg.node.num);
      break;

    case 'lastHeard':
      if(S.nodes[msg.fromNum]){
        S.nodes[msg.fromNum].lastHeard=msg.ts;
        renderChatList(); renderStats(); renderPeers();
      }
      break;

    case 'signal':
      if(S.nodes[msg.fromNum]){
        if(msg.rxRssi!=null) S.nodes[msg.fromNum].rssi=msg.rxRssi;
        if(msg.rxSnr!=null)  S.nodes[msg.fromNum].snr=msg.rxSnr;
        if(msg.hopsAway!=null) S.nodes[msg.fromNum].hopsAway=msg.hopsAway;
        renderStats(); renderPeers();
        if(S.selectedNode===msg.fromNum) renderNodeDetail(msg.fromNum);
      }
      break;

    case 'position':
      if(S.nodes[msg.fromNum]){
        S.nodes[msg.fromNum].lat=msg.lat;
        S.nodes[msg.fromNum].lon=msg.lon;
        S.nodes[msg.fromNum].alt=msg.alt;
        renderMap(); renderChatList(); renderPeers();
        if(S.selectedNode===msg.fromNum) renderNodeDetail(msg.fromNum);
      }
      break;

    case 'telemetry':
      if(S.nodes[msg.fromNum]){
        if(msg.batteryLevel!=null) S.nodes[msg.fromNum].battery=msg.batteryLevel;
        if(msg.voltage!=null)      S.nodes[msg.fromNum].voltage=msg.voltage;
        if(msg.chUtil!=null)       S.nodes[msg.fromNum].chUtil=msg.chUtil;
        if(msg.airUtil!=null)      S.nodes[msg.fromNum].airUtil=msg.airUtil;
        if(msg.rxRssi!=null)       S.nodes[msg.fromNum].rssi=msg.rxRssi;
        if(msg.rxSnr!=null)        S.nodes[msg.fromNum].snr=msg.rxSnr;
        renderStats(); renderPeers();
        if(S.selectedNode===msg.fromNum) renderNodeDetail(msg.fromNum);
      }
      break;

    case 'nodeUser':
      if(S.nodes[msg.fromNum]){
        if(msg.longName)  S.nodes[msg.fromNum].name=msg.longName;
        if(msg.shortName) S.nodes[msg.fromNum].shortName=msg.shortName;
        renderChatList(); renderPeers(); updateIdentity();
      }
      break;

    case 'message': {
      const isDM=msg.isDM && msg.toNum===S.myNodeNum;
      const tabId=isDM ? 'dm:'+msg.fromNum : 'ch:'+msg.channel;
      if(isDM) ensureDMTab(msg.fromNum);
      pushConv(tabId, {
        id:msg.id, fromNum:msg.fromNum, fromId:msg.fromId,
        fromName:S.nodes[msg.fromNum]?.name||msg.fromId,
        text:msg.text, ts:new Date(), mine:false,
        rxRssi:msg.rxRssi, rxSnr:msg.rxSnr,
        hops:(msg.hopStart!=null&&msg.hopLimit!=null)?msg.hopStart-msg.hopLimit:null
      });
      const activeId=isDM?S.activeDM:S.activeChannel;
      if(document.hidden||activeId!==tabId){
        try{ new Notification(S.nodes[msg.fromNum]?.name||'Mesh',{body:msg.text}); }catch{}
      }
      break;
    }

    case 'messageSent': {
      const tabId=msg.destinationNum?'dm:'+msg.destinationNum:'ch:'+(msg.channelIndex||0);
      const idx=pushConv(tabId, {
        fromNum:S.myNodeNum, fromName:'You',
        text:msg.text, ts:new Date(), mine:true,
        packetId:msg.packetId, status:'sent',
        destinationNum:msg.destinationNum||null
      });
      S.msgIndex[msg.packetId]={tabId, idx};
      break;
    }

    case 'ack': {
      const ref=S.msgIndex[msg.requestId];
      if(ref){
        const conv=S.conversations[ref.tabId];
        if(conv&&conv[ref.idx]){
          const m=conv[ref.idx];
          const via=S.nodes[msg.fromNum]?.name||msg.fromId;
          if(msg.ackStatus==='ack'){
            // A DM is only "finally" acknowledged once the intended recipient itself
            // responds — any other node's ack along the way is just relay confirmation.
            const isFinal = m.destinationNum==null || msg.fromNum===m.destinationNum;
            if(m.status!=='ack-final'){
              m.status = isFinal ? 'ack-final' : 'ack';
              m.ackFrom = via;
              m.ackTs = new Date();
              if(isFinal) toast('Acknowledged by '+via,'ok');
            }
          } else {
            const errLabels={
              'NO_ROUTE':'No route to node',
              'TIMEOUT':'Timed out',
              'NO_INTERFACE':'No radio interface',
              'MAX_RETRANSMIT':'Max Retransmission Reached',
              'BAD_REQUEST':'Bad request',
              'NOT_AUTHORIZED':'Not authorised',
              'PKT_TOO_LARGE':'Packet too large',
            };
            m.status = msg.errorCode==='MAX_RETRANSMIT' ? 'maxretransmit' : 'nack';
            m.statusError=msg.errorCode;
            m.statusLabel=errLabels[msg.errorCode]||msg.errorCode||'Unknown error';
            m.ackTs = new Date();
            toast(m.statusLabel,'err');
          }
          if(ref.tabId.startsWith('ch:')){ if(S.activeChannel===ref.tabId) renderChannelThread(); }
          else { if(S.activeDM===ref.tabId) renderDMThread(); }
        }
      }
      break;
    }

    case 'dbReady':
      sysMsg('Mesh ready');
      if(!Object.keys(S.channels).length){
        S.channels[0]={index:0,name:'Primary',role:'PRIMARY'};
        ensureChTab(S.channels[0]); renderChatList();
      }
      break;

    case 'sendError': toast(msg.error,'err'); break;

    case 'configSection':
      S.configs[msg.section]=msg.config;
      if(msg.enums) S.configEnums=msg.enums;
      delete S.configDirty[msg.section];
      if(S.page==='config') renderConfigPage();
      break;

    case 'configResult':
      if(msg.ok){
        const label=(CFG_SECTIONS[msg.section]&&CFG_SECTIONS[msg.section].label)||'Config';
        toast(msg.action==='write'?label+' config saved to node':'Config request sent','ok');
      } else {
        toast((msg.action==='write'?'Could not save config: ':'Could not read config: ')+(msg.error||'unknown error'),'err');
      }
      break;

    case 'log': console.log('[server]',msg.msg); pushLog(msg.msg); break;
  }
}

// ── FILTER ────────────────────────────────────────────────────────
function setFilter(f){
  S.filter=f;
  document.getElementById('ftAll').classList.toggle('active',f==='all');
  document.getElementById('ftOnline').classList.toggle('active',f==='online');
  renderChatList();
}

// ── CONVERSATIONS ─────────────────────────────────────────────────
// Messages (DMs) and Channels are two independent panels — each remembers
// its own open conversation (S.activeDM / S.activeChannel) so switching
// between them, or to another page entirely, never loses your place.
function ensureChTab(ch){
  const id='ch:'+ch.index;
  if(!S.conversations[id]){S.conversations[id]=[];S.unread[id]=0;}
  if(!S.activeChannel) setActiveTab(id);
}
function ensureDMTab(num){
  const id='dm:'+num;
  if(!S.conversations[id]){S.conversations[id]=[];S.unread[id]=0;}
  return id;
}
function pushConv(tabId,m){
  if(!S.conversations[tabId]){S.conversations[tabId]=[];S.unread[tabId]=0;}
  const idx=S.conversations[tabId].length;
  S.conversations[tabId].push(m);
  if(S.conversations[tabId].length>500) S.conversations[tabId].shift();

  const isCh=tabId.startsWith('ch:');
  const activeId=isCh?S.activeChannel:S.activeDM;
  if(activeId!==tabId){
    S.unread[tabId]=(S.unread[tabId]||0)+1;
    if(!m.sys) isCh ? bumpChannelBadge() : bumpMessageBadge();
  }
  if(isCh){ renderChannelsList(); if(activeId===tabId) renderChannelThread(); }
  else    { renderChatList();     if(activeId===tabId) renderDMThread(); }
  return idx;
}
function setActiveTab(id){
  S.unread[id]=0;
  if(id.startsWith('ch:')){ S.activeChannel=id; renderChannelsList(); renderChannelThread(); }
  else { S.activeDM=id; renderChatList(); renderDMThread(); }
}
function openDMWith(num){
  ensureDMTab(num); renderChatList(); setActiveTab('dm:'+num);
  navigate('messages');
  const inp=document.getElementById('compInp'); if(inp) inp.focus();
}
function sysMsg(text){
  const keys=Object.keys(S.conversations);
  const id=keys.length?keys[0]:'ch:0';
  if(!S.conversations[id]) S.conversations[id]=[];
  S.conversations[id].push({sys:true,text,ts:new Date()});
  if(id.startsWith('ch:')){ if(S.activeChannel===id) renderChannelThread(); }
  else { if(S.activeDM===id) renderDMThread(); }
}

// ── CONVERSATION LIST (direct messages only) ────────────────────────
function renderChatList(){
  const el=document.getElementById('chatList');
  if(!el) return;
  let html='';

  // Direct messages only — channels live on their own Channels page now.
  // Only conversations that actually exist (the full node roster lives on Peers).
  let dms=Object.keys(S.conversations)
    .filter(k=>k.startsWith('dm:'))
    .map(k=>({ id:k, num:parseInt(k.slice(3)), node:S.nodes[parseInt(k.slice(3))]||null }));
  if(S.filter==='online') dms=dms.filter(d=>d.node&&isOnline(d.node));
  dms.sort((a,b)=>{
    const la=(S.conversations[a.id]||[]).slice(-1)[0];
    const lb=(S.conversations[b.id]||[]).slice(-1)[0];
    return (lb?new Date(lb.ts).getTime():0)-(la?new Date(la.ts).getTime():0);
  });

  if(dms.length){
    dms.forEach(d=>{
      const n=d.node||{num:d.num,name:numToId(d.num),shortName:'???'};
      const isMe=n.num===S.myNodeNum;
      const online=d.node?isOnline(d.node):false;
      const msgs=(S.conversations[d.id]||[]).filter(m=>!m.sys);
      const last=msgs[msgs.length-1];
      const unread=S.unread[d.id]||0;
      const active=S.activeDM===d.id;
      const sc=sigColor(n.rssi);
      const preview=last?(last.mine?'You: '+esc(last.text):esc(last.text))
        :(n.lastHeard?'Last heard '+timeAgo(n.lastHeard):'No messages yet');
      const tstr=last?timeStr(last.ts):(n.lastHeard?timeStr(new Date(n.lastHeard)):'');
      html+=`<div class="chat-row${active?' active':''}" onclick="setActiveTab('${d.id}')">
        <div class="avatar node-av${isMe?' me-av':''}${online&&!isMe?' online-ring':''}${online?'':' offline-av'}">${esc(n.shortName||'???')}</div>
        <div class="row-info">
          <div class="row-name">${esc(n.name||numToId(n.num))}${isMe?'<span class="you-badge">you</span>':''}</div>
          <div class="row-preview">
            <div class="sig-dot" style="background:${sc};${online?'box-shadow:0 0 4px '+sc:'opacity:.4'}"></div>
            ${last&&last.mine?tickPreview(last.status):''}${preview}
          </div>
        </div>
        <div class="row-meta">
          <span class="row-time">${tstr}</span>
          ${unread?`<span class="unread-badge">${unread}</span>`:''}
        </div>
      </div>`;
    });
  }

  if(!html){
    html=`<div class="list-empty">
      <span class="icon xl">forum</span>
      <div class="list-empty-title">No direct messages yet</div>
      <div class="list-empty-sub">${S.connected?'Open Peers to start a direct message.':'Connect to your node, then open Peers to start a direct message.'}</div>
    </div>`;
  }

  el.innerHTML=html;
}

// ── PEERS PAGE ────────────────────────────────────────────────────
function setPeerFilter(f){
  S.peerFilter=f;
  const a=document.getElementById('pfAll'), o=document.getElementById('pfOnline');
  if(a) a.classList.toggle('active',f==='all');
  if(o) o.classList.toggle('active',f==='online');
  renderPeers();
}

function batteryLabel(n){
  if(n.battery==null) return '—';
  if(n.battery>100) return 'Plugged in';
  return n.battery+'%'+(n.voltage!=null?' · '+n.voltage+'V':'');
}

function renderPeers(){
  const el=document.getElementById('peersList');
  const count=document.getElementById('navPeerCount');
  const all=Object.values(S.nodes);
  if(count) count.textContent=all.length;
  if(!el) return;

  const list=(S.peerFilter==='online'?all.filter(isOnline):all).sort((a,b)=>{
    if(a.num===S.myNodeNum) return -1;
    if(b.num===S.myNodeNum) return 1;
    const ta=a.lastHeard?new Date(a.lastHeard).getTime():0;
    const tb=b.lastHeard?new Date(b.lastHeard).getTime():0;
    return tb-ta;
  });

  if(!list.length){
    el.innerHTML=`<div class="page-empty">
      <span class="icon xl">group</span>
      <div class="page-empty-title">${S.connected?(S.peerFilter==='online'?'No peers heard recently':'Waiting for the node database'):'No peers yet'}</div>
      <div class="page-empty-sub">${S.connected
        ?(S.peerFilter==='online'?'Nodes are marked online for 30 minutes after their last packet. Switch to All to see every node your radio knows about.':'Your radio is still sending its node list — this usually takes a few seconds.')
        :'Connect to your node and the peers it has heard will show up here.'}</div>
    </div>`;
    return;
  }

  el.innerHTML=`<div class="peer-grid">`+list.map(n=>{
    const isMe=n.num===S.myNodeNum;
    const online=isOnline(n);
    const sc=sigColor(n.rssi);
    const sel=S.selectedNode===n.num;
    const facts=[
      {l:'Signal', v:n.rssi!=null?n.rssi+' dBm':'—'},
      {l:'SNR',    v:n.snr!=null?n.snr.toFixed(1)+' dB':'—'},
      {l:'Battery',v:batteryLabel(n)},
      {l:'Hops',   v:n.hopsAway!=null?String(n.hopsAway):(isMe?'0':'—')},
      {l:'Last heard', v:n.lastHeard?timeAgo(n.lastHeard):(isMe?'now':'never')},
      {l:'Position', v:n.lat!=null?n.lat.toFixed(4)+', '+n.lon.toFixed(4):'no GPS'},
    ];
    return `<div class="peer-card${sel?' selected':''}" onclick="selectNodeRow(${n.num})">
      <div class="peer-head">
        <div class="avatar node-av${isMe?' me-av':''}${online&&!isMe?' online-ring':''}${online?'':' offline-av'}">${esc(n.shortName||'???')}</div>
        <div class="peer-title">
          <div class="peer-name">${esc(n.name||numToId(n.num))}${isMe?'<span class="you-badge">you</span>':''}</div>
          <div class="peer-id">${esc(n.id||numToId(n.num))}${n.role?' · '+esc(n.role):''}</div>
        </div>
        <div class="peer-state">
          <div class="sig-dot" style="background:${sc};${online?'box-shadow:0 0 4px '+sc:'opacity:.4'}"></div>
          <span>${online?'Online':'Offline'}</span>
        </div>
      </div>
      <div class="peer-facts">
        ${facts.map(f=>`<div class="peer-fact"><span class="pf-l">${f.l}</span><span class="pf-v">${esc(f.v)}</span></div>`).join('')}
      </div>
      <div class="peer-actions">
        <button class="nd-btn primary" onclick="event.stopPropagation();openDMWith(${n.num})"><span class="icon sm">chat</span>Message</button>
        ${n.lat!=null?`<button class="nd-btn" onclick="event.stopPropagation();showOnMap(${n.num})"><span class="icon sm">my_location</span>Locate</button>`:''}
        <button class="nd-btn" onclick="event.stopPropagation();showJson(${n.num})"><span class="icon sm">data_object</span>Raw</button>
      </div>
    </div>`;
  }).join('')+`</div>`;
}

function tickPreview(status){
  if(!status||status==='pending'||status==='sent')
    return '<span class="icon sm" style="color:var(--label-3);font-size:12px">schedule</span> ';
  if(status==='ack')       return '<span class="icon sm" style="color:var(--amber);font-size:12px">done_all</span> ';
  if(status==='ack-final') return '<span class="icon sm" style="color:var(--label-3);font-size:12px">done_all</span> ';
  return '<span class="icon sm" style="color:var(--red);font-size:12px">error_outline</span> '; // nack / maxretransmit
}

// ── CHAT HEADER ───────────────────────────────────────────────────
// Messages (DMs) and Channels each have their own header/feed/composer DOM,
// so each gets its own render pair — but both build bubbles the same way.
function renderDMHeader(){
  const nameEl=document.getElementById('chName');
  const subEl=document.getElementById('chSub');
  const aviEl=document.getElementById('chAvi');
  const destLabel=document.getElementById('composeDestLabel');
  const id=S.activeDM;

  if(!id){
    nameEl.textContent='Select a conversation';
    subEl.textContent='Pick a peer on the left';
    destLabel.textContent='No conversation selected';
    aviEl.innerHTML='<span class="icon" style="color:var(--label-3)">forum</span>';
    return;
  }
  const num=parseInt(id.slice(3));
  const n=S.nodes[num];
  nameEl.textContent=n?n.name:numToId(num);
  aviEl.innerHTML='<span class="icon" style="color:var(--label-3)">person</span>';
  destLabel.textContent=(n?n.name:numToId(num))+' — direct message';
  const online=n&&isOnline(n);
  subEl.textContent=n?(online?'Online now':'Last seen '+(n.lastHeard?timeAgo(n.lastHeard):'unknown')):numToId(num);
}
function renderChannelHeader(){
  const nameEl=document.getElementById('chName2');
  const subEl=document.getElementById('chSub2');
  const aviEl=document.getElementById('chAvi2');
  const destLabel=document.getElementById('composeDestLabel2');
  const id=S.activeChannel;

  if(!id){
    nameEl.textContent='Select a channel';
    subEl.textContent='Pick a channel on the left';
    destLabel.textContent='No channel selected';
    aviEl.innerHTML='<span class="icon" style="color:var(--label-3)">hub</span>';
    return;
  }
  const idx=parseInt(id.slice(3));
  const ch=S.channels[idx];
  nameEl.textContent=ch?ch.name:'Channel '+idx;
  aviEl.innerHTML='<span class="icon" style="color:var(--accent)">campaign</span>';
  destLabel.textContent=(ch?ch.name:'Channel '+idx)+' — all nodes';
  const nodeCount=Object.keys(S.nodes).length;
  subEl.textContent=(ch?.role==='PRIMARY'?'Primary channel':'Secondary channel')+' · broadcast to '+nodeCount+' known node'+(nodeCount!==1?'s':'');
}

// ── MESSAGES ──────────────────────────────────────────────────────
function renderDMThread(){
  renderDMHeader();
  const id=S.activeDM;
  let title='Nullmesh', sub='Connect to get started';
  if(id){ const num=parseInt(id.slice(3)); title=S.nodes[num]?.name||numToId(num); sub='No messages — say something!'; }
  renderThreadInto('msgFeed', id, title, sub);
}
function renderChannelThread(){
  renderChannelHeader();
  const id=S.activeChannel;
  let title='Nullmesh', sub='Select a channel on the left to see its broadcasts';
  if(id){ const idx=parseInt(id.slice(3)); title=S.channels[idx]?.name||'Channel'; sub='No messages yet'; }
  renderThreadInto('msgFeed2', id, title, sub);
}
function renderThreadInto(feedId, tabId, emptyTitle, emptySub){
  const feed=document.getElementById(feedId);
  const msgs=tabId?(S.conversations[tabId]||[]):[];

  if(!msgs.length){
    feed.innerHTML=`<div class="msg-empty"><span class="icon xl">forum</span><div class="msg-empty-title">${esc(emptyTitle)}</div><div class="msg-empty-sub">${esc(emptySub)}</div></div>`;
    return;
  }

  let html='', lastDate='';
  msgs.forEach(m=>{
    const d=m.ts.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});
    if(d!==lastDate){ html+=`<div class="date-div">${d}</div>`; lastDate=d; }
    const t=m.ts.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});

    if(m.sys){ html+=`<div class="msg sys-msg"><div class="bubble"><div class="bubble-text">${esc(m.text)}</div></div></div>`; return; }

    const cls=m.mine?'out':'in';
    const st=m.status||'sent';

    // Tick icon
    let tickHtml='';
    if(m.mine){
      if(st==='pending') tickHtml=`<span class="ticks pending"><span class="icon sm">schedule</span></span>`;
      else if(st==='sent') tickHtml=`<span class="ticks sent"><span class="icon sm">schedule</span></span>`;
      else if(st==='ack')  tickHtml=`<span class="ticks ack"><span class="icon sm">done_all</span></span>`;
      else if(st==='ack-final') tickHtml=`<span class="ticks ack-final"><span class="icon sm">done_all</span></span>`;
      else tickHtml=`<span class="ticks nack"><span class="icon sm">error_outline</span></span>`;
    }

    // Status line below bubble — mirrors the official Meshtastic app's wording
    let statusLine='';
    if(m.mine){
      const labels={
        pending:      `<span class="icon sm">schedule</span> Sending…`,
        sent:         `<span class="icon sm">schedule</span> Waiting to be acknowledged…`,
        ack:          `<span class="icon sm">done_all</span> Acknowledged`,
        'ack-final':  `<span class="icon sm">done_all</span> Acknowledged`,
        maxretransmit:`<span class="icon sm">error_outline</span> Max Retransmission Reached`,
        nack:         `<span class="icon sm">error_outline</span> `+(m.statusLabel||m.statusError||'Failed'),
      };
      statusLine=`<div class="msg-status-line ${st}" onclick="showMessageDetails('${tabId}',${msgs.indexOf(m)})" title="Message details">${labels[st]||''}</div>`;
    }

    // Incoming signal info
    let sigLine='';
    if(!m.mine && (m.rxRssi!=null||m.hops!=null)){
      const parts=[];
      if(m.hops!=null) parts.push(m.hops+' hop'+(m.hops!==1?'s':''));
      if(m.rxRssi!=null) parts.push(m.rxRssi+' dBm');
      if(m.rxSnr!=null) parts.push(m.rxSnr.toFixed(1)+' dB SNR');
      sigLine=`<div class="bubble-sig">${parts.join(' · ')}</div>`;
    }

    html+=`<div class="msg ${cls}">
      <div class="bubble">
        ${!m.mine?`<span class="bubble-sender">${esc(m.fromName||m.fromId||'?')}</span>`:''}
        <div class="bubble-text">${esc(m.text)}</div>
        <div class="bubble-footer">
          <span class="bubble-time">${t}</span>
          ${tickHtml}
        </div>
      </div>
      ${statusLine}
      ${sigLine}
    </div>`;
  });

  feed.innerHTML=html;
  feed.scrollTop=feed.scrollHeight;
}

// ── MESSAGE DETAILS (desktop equivalent of the mobile app's long-press) ──
function showMessageDetails(tabId, idx){
  const m=(S.conversations[tabId]||[])[idx];
  if(!m||!m.mine) return;

  const rows=[['Sent', m.ts.toLocaleString()]];
  if(m.status==='ack'||m.status==='ack-final'){
    rows.push(['Acknowledged', 'Yes']);
    rows.push(['Acknowledged by', esc(m.ackFrom||'Unknown node')]);
    if(m.ackTs) rows.push(['Acknowledged at', m.ackTs.toLocaleString()]);
    rows.push(['Type', m.status==='ack-final' ? 'Confirmed by recipient' : 'Relayed by the mesh']);
  } else if(m.status==='maxretransmit'){
    rows.push(['Acknowledged', 'No']);
    rows.push(['Result', 'Max Retransmission Reached']);
  } else if(m.status==='nack'){
    rows.push(['Acknowledged', 'No']);
    rows.push(['Error', esc(m.statusLabel||m.statusError||'Unknown error')]);
  } else {
    rows.push(['Acknowledged', 'Waiting…']);
  }

  document.getElementById('mdBody').innerHTML = rows.map(([l,v]) =>
    `<div class="cfg-row"><div class="cfg-row-text"><div class="cfg-label">${esc(l)}</div></div><div class="cfg-control">${v}</div></div>`
  ).join('');
  document.getElementById('mdOv').classList.add('show');
}

function sendMsg(kind){
  const isCh=kind==='ch';
  const activeId=isCh?S.activeChannel:S.activeDM;
  const inp=document.getElementById(isCh?'compInp2':'compInp');
  const text=inp.value.trim();
  if(!text||!S.connected||!activeId) return;
  let destinationNum=null, channelIndex=0;
  if(isCh) channelIndex=parseInt(activeId.slice(3));
  else destinationNum=parseInt(activeId.slice(3));
  wsSend({type:'sendMessage',text,destinationNum,channelIndex});
  inp.value=''; inp.focus();
}

// ── STATS ─────────────────────────────────────────────────────────
function renderStats(){
  const nodes=Object.values(S.nodes);
  const online=nodes.filter(isOnline).length;
  const ws=nodes.filter(n=>n.rssi!=null);
  const snr=ws.length?(ws.reduce((s,n)=>s+(n.snr||0),0)/ws.length).toFixed(1):'--';
  const rssi=ws.length?Math.round(ws.reduce((s,n)=>s+n.rssi,0)/ws.length):'--';
  sv('scNodes',nodes.length); sv('scOnline',online); sv('scSnr',snr); sv('scRssi',rssi);
}
function sv(id,v){const e=document.getElementById(id);if(e)e.textContent=v;}

// ── NODE DETAIL ───────────────────────────────────────────────────
function selectNodeRow(num){
  if(S.selectedNode===num && document.getElementById('nodeDetail').classList.contains('show')){
    closeNodeDetail(); return;
  }
  S.selectedNode=num; renderChatList(); renderPeers(); renderMap(); renderNodeDetail(num);
}
function renderNodeDetail(num){
  const n=S.nodes[num]; if(!n) return;
  const isMe=n.num===S.myNodeNum;
  document.getElementById('nodeDetail').classList.add('show');
  document.getElementById('ndName').innerHTML=esc(n.name)+(isMe?' <span style="font-size:11px;color:var(--green);font-weight:500">(you)</span>':'');
  const stats=[
    {l:'RSSI',   v:n.rssi!=null?n.rssi+' dBm':'—'},
    {l:'SNR',    v:n.snr!=null?n.snr.toFixed(1)+' dB':'—'},
    {l:'Hops',   v:n.hopsAway!=null?String(n.hopsAway):(isMe?'0':'—')},
    {l:'Battery',v:n.battery!=null?n.battery+'%':'—'},
    {l:'Voltage',v:n.voltage!=null?n.voltage+'V':'—'},
    {l:'Ch Util',v:n.chUtil!=null?n.chUtil.toFixed(1)+'%':'—'},
  ];
  document.getElementById('ndGrid').innerHTML=stats.map(s=>`<div class="nd-stat"><span class="nd-sl">${s.l}</span><span class="nd-sv">${s.v}</span></div>`).join('');
  const posEl=document.getElementById('ndPos');
  posEl.innerHTML=n.lat!=null
    ?`<span class="icon sm" style="color:var(--label-3);vertical-align:middle">location_on</span> ${n.lat.toFixed(5)}, ${n.lon.toFixed(5)}${n.alt?' · '+n.alt+'m':''}`
    :`<span class="icon sm" style="color:var(--amber);vertical-align:middle">location_off</span> No GPS position`;
  document.getElementById('ndLast').textContent=n.lastHeard?'Last heard: '+timeAgo(n.lastHeard):(isMe?'Your node':'Never heard');
  document.getElementById('ndActions').innerHTML=
    `<button class="nd-btn primary" onclick="openDMWith(${n.num})"><span class="icon sm">chat</span>Message</button>`
    +(n.lat!=null?`<button class="nd-btn" onclick="showOnMap(${n.num})"><span class="icon sm">my_location</span>Locate</button>`:'')
    +`<button class="nd-btn" onclick="showJson(${n.num})"><span class="icon sm">data_object</span>Raw</button>`;
}
function closeNodeDetail(){
  S.selectedNode=null;
  document.getElementById('nodeDetail').classList.remove('show');
  renderChatList(); renderPeers(); renderMap();
}

// ── MAP ───────────────────────────────────────────────────────────
const map=L.map('map',{zoomControl:true,attributionControl:true}).setView([51.5,-1.5],6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap',maxZoom:18}).addTo(map);

// Invalidate map size once fonts+layout load
window.addEventListener('load', () => setTimeout(() => map.invalidateSize(), 300));

const markers={};

function sigColor(rssi){
  if(rssi==null) return 'var(--label-4)';
  if(rssi>=-100) return 'var(--sig-ex)';
  if(rssi>=-110) return 'var(--sig-gd)';
  if(rssi>=-120) return 'var(--sig-ok)';
  return 'var(--sig-bad)';
}
function sigColorHex(rssi){
  if(rssi==null) return '#54545870';
  if(rssi>=-100) return '#30d158';
  if(rssi>=-110) return '#a4d65e';
  if(rssi>=-120) return '#ff9f0a';
  return '#ff453a';
}

function renderMap(){
  let onMap=0;
  Object.values(S.nodes).forEach(n=>{
    if(n.lat==null||n.lon==null) return;
    onMap++;
    const isMe=n.num===S.myNodeNum;
    const sel=S.selectedNode===n.num;
    const online=isOnline(n);
    const sz=sel?22:(isMe?18:14);
    // All online nodes: green filled. My node: blue filled. Offline: faded red.
    const fill=online?(isMe?'#0a84ff':'#30d158'):'#ff453a';
    const pinClass=`mesh-pin ${online?(isMe?'me-pin':'online'):'offline'}`;
    const icon=L.divIcon({
      className:'',
      html:`<div class="${pinClass}" style="width:${sz}px;height:${sz}px;background:${fill};border:2px solid ${online?(isMe?'#5ac8fa':'#34e86a'):'#ff453a'};"></div>`,
      iconSize:[sz,sz],iconAnchor:[sz/2,sz/2],tooltipAnchor:[sz/2+4,0]
    });
    if(markers[n.num]){
      markers[n.num].setLatLng([n.lat,n.lon]);
      markers[n.num].setIcon(icon);
    } else {
      const m=L.marker([n.lat,n.lon],{icon,zIndexOffset:isMe?1000:0}).addTo(map);
      // Permanent label showing node name
      const labelText=isMe?n.name+' (you)':n.name+(online?'':' · offline');
      m.bindTooltip(labelText,{
        permanent:true,
        className:'node-map-label',
        direction:'right',
        offset:[sz/2+4,0]
      });
      m.on('click',()=>selectNodeRow(n.num));
      markers[n.num]=m;
    }
    // Update label
    try{
      const t=markers[n.num].getTooltip();
      if(t) t.setContent(isMe?n.name+' (you)':n.name+(online?'':' · offline'));
    }catch{}
  });
  Object.keys(markers).forEach(num=>{if(!S.nodes[num]){map.removeLayer(markers[num]);delete markers[num];}});
  sv('mNodes',Object.keys(S.nodes).length); sv('mOnMap',onMap);
}

function flyTo(num){
  const n=S.nodes[num];
  if(!n||n.lat==null){toast('No GPS position for this node','wrn');return;}
  map.flyTo([n.lat,n.lon],Math.max(map.getZoom(),14),{duration:.8});
}

function showOnMap(num){
  navigate('map');
  setTimeout(()=>flyTo(num),160);
}

// ── CONNECT / DISCONNECT ──────────────────────────────────────────
function toggleConn(){
  if(S.connected){
    wsSend({type:'disconnect'});
    S.connected=false; S.myNodeNum=null;
    S.nodes={}; S.channels={}; S.conversations={}; S.unread={};
    S.activeDM=null; S.activeChannel=null; S.msgIndex={};
    Object.values(markers).forEach(m=>map.removeLayer(m));
    for(const k in markers) delete markers[k];
    setConnUI(false,'Disconnected');
    ['sendBtn','sendBtn2'].forEach(id=>{ document.getElementById(id).disabled=true; });
    ['compInp','compInp2'].forEach(id=>{ document.getElementById(id).disabled=true; });
    clearInterval(S.uptimeTimer);
    document.getElementById('uptimeText').textContent='';
    S.configs={}; S.configDirty={};
    renderChatList(); renderStats(); renderMap(); renderDMThread(); renderChannelThread(); renderPeers();
    renderChannelsList(); closeNodeDetail();
    updateIdentity();
    if(S.page==='config') renderConfigPage();
  } else {
    const ip=document.getElementById('nodeIp').value.trim();
    if(!ip){toast('Enter your node\'s IP address','wrn');return;}
    setConnUI('connecting','Connecting…');
    wsSend({type:'connect',ip,port:selectedPort});
  }
}

function setConnUI(state,text){
  const btn=document.getElementById('connBtn');
  const dot=document.getElementById('cDot');
  const ctxt=document.getElementById('cText');
  if(!btn||!dot||!ctxt) return;
  if(state===true){
    btn.textContent='Disconnect'; btn.classList.add('live');
    dot.className='status-dot live'; ctxt.textContent='Connected to '+text;
  } else if(state==='connecting'||state==='reconnecting'){
    btn.textContent='Cancel'; btn.classList.remove('live');
    dot.className='status-dot '+state; ctxt.textContent=text;
  } else {
    btn.textContent='Connect'; btn.classList.remove('live');
    dot.className='status-dot'; ctxt.textContent=text||'Not connected';
  }
}

function startUptime(){
  clearInterval(S.uptimeTimer);
  S.uptimeTimer=setInterval(()=>{
    if(!S.startTime) return;
    const s=Math.floor((Date.now()-S.startTime)/1000);
    const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
    const el=document.getElementById('uptimeText');
    if(el) el.textContent=h?`${h}h ${m}m`:`${m}m ${sec}s`;
  },1000);
}

// ── UTILITIES ─────────────────────────────────────────────────────
function showJson(num){
  const n=S.nodes[num]; if(!n) return;
  document.getElementById('jsonPre').innerHTML=JSON.stringify(n,null,2)
    .replace(/("(?:[^"\\]|\\.)*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,m=>{
      if(/^".*:$/.test(m)) return `<span class="k">${m}</span>`;
      if(/^"/.test(m))     return `<span class="s">${m}</span>`;
      if(/true|false/.test(m)) return `<span class="b">${m}</span>`;
      return `<span class="n">${m}</span>`;
    });
  document.getElementById('jsonOv').classList.add('show');
}

function numToId(num){ if(num==null) return '!unknown'; return '!'+(num>>>0).toString(16).padStart(8,'0'); }
function esc(t){
  // Escape all HTML special chars to prevent XSS from node names/messages
  return String(t||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#x27;');
}
function timeAgo(iso){
  const s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if(s<60) return s+'s ago';
  if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
function timeStr(d){
  if(!d) return '';
  const now=new Date(), td=new Date(d);
  if(td.toDateString()===now.toDateString()) return td.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(now-td<7*86400000) return td.toLocaleDateString([],{weekday:'short'});
  return td.toLocaleDateString([],{day:'numeric',month:'short'});
}
function toast(msg,type='inf'){
  const el=document.createElement('div'); el.className='toast '+type;
  const icons={ok:'check_circle',err:'error',wrn:'warning',inf:'info'};
  const colors={ok:'var(--green)',err:'var(--red)',wrn:'var(--amber)',inf:'var(--blue)'};
  el.innerHTML=`<span class="icon sm" style="color:${colors[type]||colors.inf}">${icons[type]||'info'}</span>${esc(msg)}`;
  document.getElementById('toasts').appendChild(el);
  setTimeout(()=>{el.style.transition='opacity .3s';el.style.opacity='0';},3500);
  setTimeout(()=>el.remove(),3900);
}

// Notification permission
if('Notification' in window && Notification.permission==='default') Notification.requestPermission();

document.addEventListener('keydown',e=>{
  if(e.key==='Escape') document.querySelectorAll('.ov.show').forEach(o=>o.classList.remove('show'));
});



// ══════════════════════════════════════════════════════════════════
// NAVIGATION SHELL
// ══════════════════════════════════════════════════════════════════
const PAGES = {
  messages: { section:'pageMessages', nav:'tabBtnMessages' },
  map:      { section:'pageMap',      nav:'navBtnMap' },
  config:   { section:'pageConfig',   nav:'navBtnConfig' },
  channels: { section:'pageChannels', nav:'tabBtnChannels' },
  peers:    { section:'pagePeers',    nav:'navBtnPeers' },
};

function navigate(page) {
  if (!PAGES[page]) return;
  S.page = page;
  Object.entries(PAGES).forEach(([key, def]) => {
    const sec = document.getElementById(def.section);
    const btn = document.getElementById(def.nav);
    if (sec) sec.classList.toggle('active', key === page);
    if (btn) btn.classList.toggle('active', key === page);
  });
  try { localStorage.setItem('mn_page', page); } catch {}

  if (page === 'messages') clearBadge('tabBadgeMessages');
  if (page === 'channels') { clearBadge('tabBadgeChannels'); renderChannelsList(); }
  if (page === 'peers')    renderPeers();
  if (page === 'config')   renderConfigPage();
  if (page === 'map' && typeof map !== 'undefined') setTimeout(() => map.invalidateSize(), 80);
}

// Kept for backwards compatibility with the old two-tab right panel
function switchRightTab(tab) { navigate(tab === 'channels' ? 'channels' : 'messages'); }

function clearBadge(id) {
  const b = document.getElementById(id);
  if (!b) return;
  b.textContent = '0';
  b.style.display = 'none';
}
function bumpBadge(id) {
  const b = document.getElementById(id);
  if (!b) return;
  b.textContent = (parseInt(b.textContent) || 0) + 1;
  b.style.display = 'inline-block';
}
function bumpChannelBadge() { if (S.page !== 'channels') bumpBadge('tabBadgeChannels'); }
function bumpMessageBadge() { if (S.page !== 'messages') bumpBadge('tabBadgeMessages'); }

// ── Identity block ────────────────────────────────────────────────
function updateIdentity() {
  const nameEl = document.getElementById('navNodeName');
  const subEl  = document.getElementById('navNodeSub');
  if (!nameEl || !subEl) return;
  const me = S.myNodeNum != null ? S.nodes[S.myNodeNum] : null;
  if (S.connected && me) {
    nameEl.textContent = me.shortName && me.shortName !== '???' ? me.shortName : (me.name || 'Nullmesh');
    subEl.textContent  = 'Meshtastic ' + (me.name || numToId(me.num));
  } else if (S.connected && S.myNodeNum != null) {
    nameEl.textContent = numToId(S.myNodeNum);
    subEl.textContent  = 'Meshtastic node';
  } else {
    nameEl.textContent = 'Nullmesh';
    subEl.textContent  = 'No node connected';
  }
}

// ── Connect panel (quick reconnect) ───────────────────────────────
function toggleConnPanel(force) {
  const p = document.getElementById('connPanel');
  const chev = document.getElementById('connChev');
  if (!p) return;
  const open = force === undefined ? !p.classList.contains('open') : !!force;
  p.classList.toggle('open', open);
  if (chev) chev.textContent = open ? 'expand_less' : 'expand_more';
  if (open) { const ip = document.getElementById('nodeIp'); if (ip) ip.focus(); }
}

// ── First-run guided connect ─────────────────────────────────────
function showFirstRun() {
  const el = document.getElementById('firstRun');
  if (el) el.classList.add('show');
}
function hideFirstRun() {
  const el = document.getElementById('firstRun');
  if (el) el.classList.remove('show');
}
function dismissFirstRun() {
  hideFirstRun();
  toggleConnPanel(true);
}
function firstRunConnect() {
  const fr = document.getElementById('frIp');
  const ip = (fr?.value || '').trim();
  if (!ip) { toast('Enter your node\'s IP address', 'wrn'); return; }
  const nodeIp = document.getElementById('nodeIp');
  if (nodeIp) nodeIp.value = ip;
  const btn = document.getElementById('frBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Connecting…'; }
  toggleConn();
  setTimeout(() => {
    if (btn) { btn.disabled = false; btn.textContent = 'Connect to node'; }
    if (!S.connected) return;
    hideFirstRun();
  }, 6000);
}

// ── Server console ───────────────────────────────────────────────
function pushLog(line) {
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  S.logs.push(stamp + '  ' + line);
  if (S.logs.length > 500) S.logs.shift();
  const pre = document.getElementById('consolePre');
  if (pre && document.getElementById('consoleOv')?.classList.contains('show')) {
    pre.textContent = S.logs.join('\n');
    pre.parentElement.scrollTop = pre.parentElement.scrollHeight;
  }
}
function toggleConsole() {
  const ov = document.getElementById('consoleOv');
  if (!ov) return;
  const open = !ov.classList.contains('show');
  ov.classList.toggle('show', open);
  if (open) {
    const pre = document.getElementById('consolePre');
    if (pre) {
      pre.textContent = S.logs.length ? S.logs.join('\n') : 'No server output yet.';
      pre.parentElement.scrollTop = pre.parentElement.scrollHeight;
    }
  }
}

function showLanguages() {
  toast('Language: English — additional translations are not bundled yet', 'inf');
}

// ══════════════════════════════════════════════════════════════════
// CONFIG PAGE
// ══════════════════════════════════════════════════════════════════
// Every config section Nullmesh can read and write. `kind` says which
// AdminMessage family it belongs to; the server registry in server/server.js
// mirrors this list and is what actually validates writes.
// Field types: bool | enum | number | float | text | password
const CFG_SECTIONS = {
  device: {
    label:'Device', kind:'config',
    cards:[
      { title:'Role & rebroadcasting',
        desc:'How this radio behaves on the mesh. Leave these alone unless you know you need to change them.',
        fields:[
          {key:'role', label:'Role', type:'enum', enum:'role',
           help:'CLIENT is right for almost everyone. Router roles keep the radio awake to relay traffic.'},
          {key:'rebroadcastMode', label:'Rebroadcast mode', type:'enum', enum:'rebroadcastMode',
           help:'Which packets this node repeats for other nodes.'},
          {key:'nodeInfoBroadcastSecs', label:'Node info interval', type:'number', unit:'seconds', min:0, max:604800,
           help:'How often this node announces its name and hardware to the mesh.'},
        ]},
      { title:'Diagnostics',
        desc:'Serial output and managed mode. Serial output is what a USB console reads.',
        fields:[
          {key:'serialEnabled', label:'Serial output enabled', type:'bool',
           help:'Turn off to silence the USB serial console (saves a little power).'},
          {key:'isManaged', label:'Managed mode', type:'bool',
           help:'When on, the radio refuses config changes from apps — only an admin key may edit it.'},
        ]},
      { title:'Buttons, buzzer & LED',
        desc:'GPIO pin assignments and input behaviour for this board. 0 means "use the firmware default".',
        fields:[
          {key:'buttonGpio', label:'Button pin', type:'number', min:0, max:63,
           help:'GPIO the user button is wired to. 0 = board default.'},
          {key:'buzzerGpio', label:'Buzzer pin', type:'number', min:0, max:63,
           help:'GPIO the buzzer is wired to. 0 = board default.'},
          {key:'buzzerMode', label:'Buzzer mode', type:'enum', enum:'buzzerMode',
           help:'What the buzzer is allowed to sound for.'},
          {key:'doubleTapAsButtonPress', label:'Double tap as button press', type:'bool',
           help:'Use the accelerometer double-tap as a button press (boards with an IMU only).'},
          {key:'disableTripleClick', label:'Disable triple click', type:'bool',
           help:'Stops a triple click from toggling the GPS.'},
          {key:'ledHeartbeatDisabled', label:'Disable LED heartbeat', type:'bool',
           help:'Stops the status LED blinking continuously.'},
        ]},
      { title:'Time zone',
        desc:'POSIX TZ string used for on-screen clocks, e.g. GMT0BST,M3.5.0/1,M10.5.0 for the UK.',
        fields:[
          {key:'tzdef', label:'Timezone (TZ string)', type:'text', maxlength:64,
           help:'Leave blank to use UTC.'},
        ]},
    ],
  },

  position: {
    label:'Position', kind:'config',
    cards:[
      { title:'GPS',
        desc:'Whether this radio has a GPS and how hard it works to keep a fix.',
        fields:[
          {key:'gpsMode', label:'GPS mode', type:'enum', enum:'gpsMode',
           help:'ENABLED uses the GPS, DISABLED turns it off, NOT_PRESENT means the board has no GPS at all.'},
          {key:'gpsUpdateInterval', label:'GPS update interval', type:'number', unit:'seconds', min:0, max:604800,
           help:'How often the GPS wakes up to get a new fix. 0 = firmware default (about 2 minutes).'},
          {key:'fixedPosition', label:'Fixed position', type:'bool',
           help:'Treat the last known position as permanent — for a radio that never moves.'},
        ]},
      { title:'Broadcast',
        desc:'How often your position goes out over the mesh. Smart broadcast only transmits when you have actually moved.',
        fields:[
          {key:'positionBroadcastSecs', label:'Broadcast interval', type:'number', unit:'seconds', min:0, max:604800,
           help:'How often to send your position to the mesh. 0 = firmware default (15 minutes).'},
          {key:'positionBroadcastSmartEnabled', label:'Smart broadcast', type:'bool',
           help:'Only broadcast when you have moved far enough, instead of on a fixed timer.'},
          {key:'broadcastSmartMinimumDistance', label:'Smart minimum distance', type:'number', unit:'metres', min:0, max:100000,
           help:'How far you must move before a smart broadcast is sent. 0 = firmware default (100 m).'},
          {key:'broadcastSmartMinimumIntervalSecs', label:'Smart minimum interval', type:'number', unit:'seconds', min:0, max:604800,
           help:'Never send smart broadcasts closer together than this. 0 = firmware default (30 s).'},
          {key:'positionFlags', label:'Position flags', type:'number', min:0, max:4294967295,
           help:'Bitmask of extras to include with each position (altitude, satellite count, DOP…). Advanced.'},
        ]},
      { title:'GPS pins',
        desc:'GPIO wiring for the GPS module. 0 means "use the board default" — only change these on custom hardware.',
        fields:[
          {key:'rxGpio', label:'GPS RX pin', type:'number', min:0, max:63, help:'GPIO the GPS transmit line is wired to.'},
          {key:'txGpio', label:'GPS TX pin', type:'number', min:0, max:63, help:'GPIO the GPS receive line is wired to.'},
          {key:'gpsEnGpio', label:'GPS enable pin', type:'number', min:0, max:63, help:'GPIO that powers the GPS on and off.'},
        ]},
    ],
  },

  power: {
    label:'Power', kind:'config',
    cards:[
      { title:'Sleep & power saving',
        desc:'Battery-powered radios can sleep between transmissions. On a mains-powered node you normally leave all of this off.',
        fields:[
          {key:'isPowerSaving', label:'Power saving mode', type:'bool',
           help:'Let the radio sleep aggressively between packets. Slows response but saves a lot of battery.'},
          {key:'lsSecs', label:'Light sleep interval', type:'number', unit:'seconds', min:0, max:4294967295,
           help:'How long to stay in light sleep before waking to check the mesh. 0 = firmware default (5 minutes).'},
          {key:'sdsSecs', label:'Deep sleep interval', type:'number', unit:'seconds', min:0, max:4294967295,
           help:'How long to stay in deep sleep. Very large values effectively disable deep sleep.'},
          {key:'minWakeSecs', label:'Minimum wake time', type:'number', unit:'seconds', min:0, max:86400,
           help:'How long to stay awake after waking. 0 = firmware default (10 s).'},
          {key:'waitBluetoothSecs', label:'Bluetooth wait time', type:'number', unit:'seconds', min:0, max:86400,
           help:'How long to wait for a phone to connect over Bluetooth before sleeping. 0 = firmware default.'},
          {key:'onBatteryShutdownAfterSecs', label:'Shutdown after (on battery)', type:'number', unit:'seconds', min:0, max:31536000,
           help:'Power the radio off completely this long after losing external power. 0 = never shut down.'},
        ]},
      { title:'Battery measurement',
        desc:'Only touch these if your board reports the wrong battery voltage.',
        fields:[
          {key:'adcMultiplierOverride', label:'ADC multiplier override', type:'float', min:0, max:10, step:0.01,
           help:'Correction factor for the battery voltage reading. 0 = use the board default.'},
          {key:'deviceBatteryInaAddress', label:'INA sensor I²C address', type:'number', min:0, max:127,
           help:'I²C address of an external INA battery monitor. 0 = none fitted.'},
        ]},
    ],
  },

  network: {
    label:'Network', kind:'config',
    cards:[
      { title:'Wi-Fi',
        desc:'The radio joins your Wi-Fi as a client. This is how Nullmesh talks to it — changing it will drop the connection until the node rejoins.',
        fields:[
          {key:'wifiEnabled', label:'Wi-Fi enabled', type:'bool',
           help:'Turn the Wi-Fi radio on. Wi-Fi and Bluetooth cannot both be used on ESP32 boards.'},
          {key:'wifiSsid', label:'Network name (SSID)', type:'text', maxlength:32, help:'The Wi-Fi network to join.'},
          {key:'wifiPsk', label:'Password', type:'password', maxlength:64,
           help:'Wi-Fi password. The radio never sends this back, so it may look blank after a re-read.'},
        ]},
      { title:'Ethernet & addressing',
        desc:'For boards with a wired Ethernet port, plus how an IP address is obtained.',
        fields:[
          {key:'ethEnabled', label:'Ethernet enabled', type:'bool', help:'Use the wired network port, if this board has one.'},
          {key:'addressMode', label:'Address mode', type:'enum', enum:'addressMode',
           help:'DHCP asks your router for an address. STATIC uses a fixed address set elsewhere.'},
          {key:'ipv6Enabled', label:'IPv6 enabled', type:'bool', help:'Also request an IPv6 address.'},
        ]},
      { title:'NTP & logging',
        desc:'Where the radio gets the time from, and where it can send its logs.',
        fields:[
          {key:'ntpServer', label:'NTP server', type:'text', maxlength:32,
           help:'Time server to sync the clock against. Blank = firmware default (meshtastic.pool.ntp.org).'},
          {key:'rsyslogServer', label:'Syslog server', type:'text', maxlength:32,
           help:'Optional remote syslog host for debug logs. Leave blank if you do not run one.'},
          {key:'enabledProtocols', label:'Enabled protocols', type:'number', min:0, max:4294967295,
           help:'Bitmask of extra IP protocols (e.g. UDP mesh over the local network). 1 enables UDP broadcast.'},
        ]},
    ],
  },

  display: {
    label:'Display', kind:'config',
    cards:[
      { title:'Screen',
        desc:'Behaviour of the little OLED screen on the front of the radio.',
        fields:[
          {key:'screenOnSecs', label:'Screen timeout', type:'number', unit:'seconds', min:0, max:604800,
           help:'How long the screen stays lit after a button press. 0 = firmware default (60 s).'},
          {key:'autoScreenCarouselSecs', label:'Auto page interval', type:'number', unit:'seconds', min:0, max:604800,
           help:'Cycle through the screen pages this often. 0 = do not cycle.'},
          {key:'wakeOnTapOrMotion', label:'Wake on tap or motion', type:'bool',
           help:'Light the screen when the radio is picked up (boards with an accelerometer only).'},
          {key:'flipScreen', label:'Flip screen', type:'bool', help:'Rotate the display 180° for upside-down mounting.'},
          {key:'oled', label:'OLED type', type:'enum', enum:'oledType',
           help:'Which display controller is fitted. AUTO detects it and is almost always right.'},
          {key:'displaymode', label:'Display mode', type:'enum', enum:'displayMode',
           help:'Colour scheme / layout used on screen.'},
        ]},
      { title:'Units & format',
        desc:'How numbers, headings and coordinates are shown on screen.',
        fields:[
          {key:'units', label:'Units', type:'enum', enum:'displayUnits', help:'Metric or imperial for distances and speeds.'},
          {key:'use12hClock', label:'12-hour clock', type:'bool', help:'Show times as am/pm instead of 24-hour.'},
          {key:'gpsFormat', label:'Coordinate format', type:'enum', enum:'gpsFormat',
           help:'How GPS coordinates are written on screen — decimal degrees, DMS, UTM, MGRS, Open Location Code or OS grid.'},
          {key:'headingBold', label:'Bold headings', type:'bool', help:'Draw screen headings in a heavier font.'},
          {key:'compassNorthTop', label:'Compass north at top', type:'bool',
           help:'Keep north fixed at the top of the compass instead of rotating with your heading.'},
          {key:'compassOrientation', label:'Compass orientation', type:'enum', enum:'compassOrientation',
           help:'Rotate the compass to match how the board is physically mounted.'},
        ]},
    ],
  },

  lora: {
    label:'LoRa', kind:'config',
    cards:[
      { title:'Region & modem',
        desc:'The most important settings on the radio. Every node you want to talk to must match on region and modem preset.',
        fields:[
          {key:'region', label:'Region', type:'enum', enum:'region',
           help:'Legal frequency band for where you are. UNSET means the radio will not transmit at all.'},
          {key:'usePreset', label:'Use modem preset', type:'bool',
           help:'On (recommended) uses a named preset. Off lets you set bandwidth, spread factor and coding rate by hand.'},
          {key:'modemPreset', label:'Modem preset', type:'enum', enum:'modemPreset',
           help:'Speed/range trade-off. LONG_FAST is the default and what most meshes use.'},
          {key:'hopLimit', label:'Hop limit', type:'number', min:0, max:7,
           help:'How many times a packet may be relayed. 3 is the default; higher values congest the mesh.'},
        ]},
      { title:'Radio',
        desc:'Transmit power and frequency. Overrides here can put you outside your legal band — leave them at 0 unless you know the rules.',
        fields:[
          {key:'txEnabled', label:'Transmit enabled', type:'bool',
           help:'Turn off to make the node listen-only. It will still receive but never transmit.'},
          {key:'txPower', label:'TX power', type:'number', unit:'dBm', min:0, max:30,
           help:'Transmit power. 0 = the maximum legal power for your region.'},
          {key:'channelNum', label:'Frequency slot', type:'number', min:0, max:255,
           help:'Which slot within the region band to use. 0 = derived from the primary channel name.'},
          {key:'overrideFrequency', label:'Override frequency', type:'float', unit:'MHz', min:0, max:3000, step:0.001,
           help:'Force an exact frequency instead of a slot. 0 = off.'},
          {key:'frequencyOffset', label:'Frequency offset', type:'float', unit:'Hz', min:-100, max:100, step:0.1,
           help:'Trim for a crystal that is slightly off. Almost always 0.'},
          {key:'overrideDutyCycle', label:'Override duty cycle', type:'bool',
           help:'Ignore the regional duty-cycle limit. Illegal in most of Europe — leave off.'},
          {key:'sx126xRxBoostedGain', label:'Boosted RX gain', type:'bool',
           help:'Slightly more receive sensitivity at slightly more idle current (SX126x boards).'},
          {key:'paFanDisabled', label:'Disable PA fan', type:'bool', help:'Turn off the amplifier cooling fan, on boards that have one.'},
        ]},
      { title:'Manual modem settings',
        desc:'Only used when "Use modem preset" is off. Getting these wrong stops you talking to anyone.',
        fields:[
          {key:'bandwidth', label:'Bandwidth', type:'number', unit:'kHz', min:0, max:1000, help:'Channel bandwidth in kHz, e.g. 250.'},
          {key:'spreadFactor', label:'Spread factor', type:'number', min:0, max:12, help:'Higher is slower but reaches further. 7–12.'},
          {key:'codingRate', label:'Coding rate', type:'number', min:0, max:8, help:'Forward error correction denominator, 5–8.'},
        ]},
      { title:'MQTT relaying',
        desc:'How this node treats traffic that arrives from or is destined for an MQTT bridge.',
        fields:[
          {key:'ignoreMqtt', label:'Ignore MQTT traffic', type:'bool', help:'Do not rebroadcast packets that came in over MQTT.'},
          {key:'configOkToMqtt', label:'OK to send to MQTT', type:'bool', help:'Allow this node’s packets to be uplinked to MQTT by others.'},
        ]},
    ],
  },

  bluetooth: {
    label:'Bluetooth', kind:'config',
    cards:[
      { title:'Pairing',
        desc:'How a phone pairs with this radio. On ESP32 boards Bluetooth and Wi-Fi cannot both be on — turning this on may drop Nullmesh’s connection.',
        fields:[
          {key:'enabled', label:'Bluetooth enabled', type:'bool', help:'Turn the Bluetooth radio on.'},
          {key:'mode', label:'Pairing mode', type:'enum', enum:'pairingMode',
           help:'RANDOM_PIN shows a new PIN on screen each time. FIXED_PIN always uses the PIN below. NO_PIN pairs with anyone.'},
          {key:'fixedPin', label:'Fixed PIN', type:'number', min:0, max:999999, help:'Six-digit PIN used when pairing mode is FIXED_PIN.'},
        ]},
    ],
  },

  // ── Module config sections (shown under the Module tab) ────────────
  mqtt: {
    label:'MQTT', kind:'module',
    cards:[
      { title:'Broker',
        desc:'Bridge this node’s mesh traffic to an MQTT broker over the internet.',
        fields:[
          {key:'enabled', label:'MQTT enabled', type:'bool', help:'Turn the MQTT bridge on.'},
          {key:'address', label:'Broker address', type:'text', maxlength:63, help:'Host name or IP. Blank = the public Meshtastic broker.'},
          {key:'username', label:'Username', type:'text', maxlength:63, help:'Broker username, if it needs one.'},
          {key:'password', label:'Password', type:'password', maxlength:63, help:'Broker password, if it needs one.'},
          {key:'root', label:'Root topic', type:'text', maxlength:32, help:'Topic prefix to publish under. Blank = msh.'},
          {key:'tlsEnabled', label:'Use TLS', type:'bool', help:'Connect to the broker over TLS. Needs a broker that supports it.'},
        ]},
      { title:'What gets published',
        desc:'Encryption and formatting of the messages sent to the broker.',
        fields:[
          {key:'encryptionEnabled', label:'Encrypted uplink', type:'bool', help:'Publish packets still encrypted with your channel key.'},
          {key:'jsonEnabled', label:'Also publish JSON', type:'bool', help:'Publish a decoded JSON copy alongside the protobuf. Plaintext — be careful.'},
          {key:'proxyToClientEnabled', label:'Proxy via phone/app', type:'bool',
           help:'Send MQTT through the connected client’s internet instead of the node’s own Wi-Fi.'},
          {key:'mapReportingEnabled', label:'Report to public map', type:'bool',
           help:'Publish this node’s position to the public Meshtastic map.'},
        ]},
    ],
  },

  serial: {
    label:'Serial', kind:'module',
    cards:[
      { title:'Serial bridge',
        desc:'Send and receive mesh text over a hardware UART — for wiring the radio to another device.',
        fields:[
          {key:'enabled', label:'Serial module enabled', type:'bool', help:'Turn the serial module on.'},
          {key:'mode', label:'Mode', type:'enum', enum:'serialMode',
           help:'How bytes on the UART map to mesh packets. SIMPLE is a raw pipe, TEXTMSG sends them as messages.'},
          {key:'baud', label:'Baud rate', type:'enum', enum:'serialBaud', help:'Serial speed. DEFAULT is 38400.'},
          {key:'echo', label:'Echo', type:'bool', help:'Echo what this node transmits back out of the serial port.'},
          {key:'timeout', label:'Timeout', type:'number', unit:'seconds', min:0, max:86400,
           help:'How long to wait for more input before sending what it has. 0 = firmware default.'},
        ]},
      { title:'Pins',
        desc:'Which GPIOs the UART uses. 0 means the board default.',
        fields:[
          {key:'rxd', label:'RX pin', type:'number', min:0, max:63, help:'GPIO for incoming serial data.'},
          {key:'txd', label:'TX pin', type:'number', min:0, max:63, help:'GPIO for outgoing serial data.'},
          {key:'overrideConsoleSerialPort', label:'Take over console port', type:'bool',
           help:'Use the USB console UART for this module. You will lose the debug console.'},
        ]},
    ],
  },

  externalNotification: {
    label:'Ext. notification', kind:'module',
    cards:[
      { title:'External notification',
        desc:'Drive an LED, buzzer or vibration motor when a message arrives.',
        fields:[
          {key:'enabled', label:'Module enabled', type:'bool', help:'Turn external notifications on.'},
          {key:'outputMs', label:'Output duration', type:'number', unit:'ms', min:0, max:600000,
           help:'How long the output stays active per alert. 0 = firmware default (1000 ms).'},
          {key:'nagTimeout', label:'Nag timeout', type:'number', unit:'seconds', min:0, max:86400,
           help:'Keep re-alerting for this long until you press the button. 0 = alert once.'},
          {key:'active', label:'Active high', type:'bool', help:'On means the output pin is driven high when alerting.'},
          {key:'usePwm', label:'Use PWM', type:'bool', help:'Drive the output with PWM so a piezo plays a tone.'},
          {key:'useI2sAsBuzzer', label:'Use I²S as buzzer', type:'bool', help:'Play alerts through an I²S amplifier instead of a GPIO.'},
        ]},
      { title:'Output pins',
        desc:'GPIOs for each kind of output. 0 means unused.',
        fields:[
          {key:'output', label:'LED pin', type:'number', min:0, max:63, help:'GPIO for the general/LED output.'},
          {key:'outputVibra', label:'Vibration pin', type:'number', min:0, max:63, help:'GPIO for a vibration motor.'},
          {key:'outputBuzzer', label:'Buzzer pin', type:'number', min:0, max:63, help:'GPIO for a buzzer.'},
        ]},
      { title:'What triggers an alert',
        desc:'A "bell" is a message containing the bell character, used to deliberately ring a node.',
        fields:[
          {key:'alertMessage', label:'Any message → LED', type:'bool', help:'Flash the LED output for every incoming message.'},
          {key:'alertMessageVibra', label:'Any message → vibrate', type:'bool', help:'Vibrate for every incoming message.'},
          {key:'alertMessageBuzzer', label:'Any message → buzzer', type:'bool', help:'Sound the buzzer for every incoming message.'},
          {key:'alertBell', label:'Bell → LED', type:'bool', help:'Flash the LED only for bell messages.'},
          {key:'alertBellVibra', label:'Bell → vibrate', type:'bool', help:'Vibrate only for bell messages.'},
          {key:'alertBellBuzzer', label:'Bell → buzzer', type:'bool', help:'Sound the buzzer only for bell messages.'},
        ]},
    ],
  },

  storeForward: {
    label:'Store & forward', kind:'module',
    cards:[
      { title:'Store & forward',
        desc:'Keeps a history of messages so nodes that were asleep or out of range can catch up. Needs a board with PSRAM to be the server.',
        fields:[
          {key:'enabled', label:'Module enabled', type:'bool', help:'Turn store & forward on.'},
          {key:'isServer', label:'Act as server', type:'bool', help:'This node stores the history for others. Requires PSRAM.'},
          {key:'heartbeat', label:'Send heartbeat', type:'bool', help:'Periodically advertise that this server exists.'},
          {key:'records', label:'Records to keep', type:'number', min:0, max:100000, help:'How many messages to store. 0 = as many as memory allows.'},
          {key:'historyReturnMax', label:'Max records returned', type:'number', min:0, max:100000, help:'Most messages to send in one catch-up reply. 0 = firmware default.'},
          {key:'historyReturnWindow', label:'History window', type:'number', unit:'seconds', min:0, max:604800, help:'How far back a catch-up reply may reach. 0 = firmware default.'},
        ]},
    ],
  },

  rangeTest: {
    label:'Range test', kind:'module',
    cards:[
      { title:'Range test',
        desc:'Transmits a numbered test message on a timer so you can drive around and see how far the mesh reaches. Leave this off in normal use — it is noisy.',
        fields:[
          {key:'enabled', label:'Module enabled', type:'bool', help:'Turn range testing on.'},
          {key:'sender', label:'Send interval', type:'number', unit:'seconds', min:0, max:86400,
           help:'How often to send a test packet. 0 = receive only, do not send.'},
          {key:'save', label:'Save results to storage', type:'bool', help:'Write received test packets to a CSV on the node’s filesystem.'},
        ]},
    ],
  },

  telemetry: {
    label:'Telemetry', kind:'module',
    cards:[
      { title:'Device telemetry',
        desc:'Battery, voltage and channel-utilisation readings this node broadcasts about itself.',
        fields:[
          {key:'deviceUpdateInterval', label:'Device metrics interval', type:'number', unit:'seconds', min:0, max:604800,
           help:'How often to broadcast battery and utilisation. 0 = firmware default (30 minutes).'},
        ]},
      { title:'Environment sensors',
        desc:'For nodes with a temperature/humidity/pressure sensor attached.',
        fields:[
          {key:'environmentMeasurementEnabled', label:'Environment sensing', type:'bool', help:'Read the attached environment sensor.'},
          {key:'environmentUpdateInterval', label:'Environment interval', type:'number', unit:'seconds', min:0, max:604800, help:'How often to broadcast sensor readings. 0 = firmware default.'},
          {key:'environmentScreenEnabled', label:'Show on screen', type:'bool', help:'Add an environment page to the OLED carousel.'},
          {key:'environmentDisplayFahrenheit', label:'Display in Fahrenheit', type:'bool', help:'Show temperatures in °F instead of °C.'},
        ]},
      { title:'Air quality, power & health',
        desc:'Optional extra sensor packages. Each one only does anything if the matching hardware is fitted.',
        fields:[
          {key:'airQualityEnabled', label:'Air quality sensing', type:'bool', help:'Read an attached particulate sensor.'},
          {key:'airQualityInterval', label:'Air quality interval', type:'number', unit:'seconds', min:0, max:604800, help:'How often to broadcast air quality. 0 = firmware default.'},
          {key:'powerMeasurementEnabled', label:'Power sensing', type:'bool', help:'Read an attached INA current/voltage sensor.'},
          {key:'powerUpdateInterval', label:'Power interval', type:'number', unit:'seconds', min:0, max:604800, help:'How often to broadcast power readings. 0 = firmware default.'},
          {key:'powerScreenEnabled', label:'Show power on screen', type:'bool', help:'Add a power page to the OLED carousel.'},
          {key:'healthMeasurementEnabled', label:'Health sensing', type:'bool', help:'Read an attached heart-rate / SpO₂ sensor.'},
          {key:'healthUpdateInterval', label:'Health interval', type:'number', unit:'seconds', min:0, max:604800, help:'How often to broadcast health readings. 0 = firmware default.'},
          {key:'healthScreenEnabled', label:'Show health on screen', type:'bool', help:'Add a health page to the OLED carousel.'},
        ]},
    ],
  },

  cannedMessage: {
    label:'Canned messages', kind:'module',
    cards:[
      { title:'Canned messages',
        desc:'Lets you pick a pre-written message on the device itself using a rotary encoder or up/down buttons. The message list is edited on the node.',
        fields:[
          {key:'enabled', label:'Module enabled', type:'bool', help:'Turn canned messages on.'},
          {key:'sendBell', label:'Send bell character', type:'bool', help:'Append a bell to each canned message so the receiving node alerts.'},
          {key:'rotary1Enabled', label:'Rotary encoder input', type:'bool', help:'Use a rotary encoder to scroll the list.'},
          {key:'updown1Enabled', label:'Up/down button input', type:'bool', help:'Use up/down buttons to scroll the list.'},
          {key:'allowInputSource', label:'Allowed input source', type:'text', maxlength:16,
           help:'Which input device may drive this, e.g. rotEnc1, upDownEnc1, or _any.'},
        ]},
      { title:'Input wiring',
        desc:'GPIOs and events for the encoder or buttons. 0 means unused.',
        fields:[
          {key:'inputbrokerPinA', label:'Input pin A', type:'number', min:0, max:63, help:'First encoder pin.'},
          {key:'inputbrokerPinB', label:'Input pin B', type:'number', min:0, max:63, help:'Second encoder pin.'},
          {key:'inputbrokerPinPress', label:'Press pin', type:'number', min:0, max:63, help:'Encoder push-button pin.'},
          {key:'inputbrokerEventCw', label:'Clockwise event', type:'enum', enum:'inputEvent', help:'What turning clockwise counts as.'},
          {key:'inputbrokerEventCcw', label:'Anticlockwise event', type:'enum', enum:'inputEvent', help:'What turning anticlockwise counts as.'},
          {key:'inputbrokerEventPress', label:'Press event', type:'enum', enum:'inputEvent', help:'What pressing counts as.'},
        ]},
    ],
  },

  audio: {
    label:'Audio', kind:'module',
    cards:[
      { title:'Codec2 voice',
        desc:'Sends short compressed voice clips over LoRa. Needs an I²S microphone and amplifier wired up — most boards, including the Heltec V3, have none.',
        fields:[
          {key:'codec2Enabled', label:'Module enabled', type:'bool', help:'Turn Codec2 voice on.'},
          {key:'bitrate', label:'Bitrate', type:'enum', enum:'audioBitrate',
           help:'Codec2 rate. Lower bitrates sound worse but get through on slower modem presets.'},
          {key:'pttPin', label:'Push-to-talk pin', type:'number', min:0, max:63, help:'GPIO for the push-to-talk button. 0 = unused.'},
        ]},
      { title:'I²S pins',
        desc:'Wiring for the audio codec. 0 means unused.',
        fields:[
          {key:'i2sWs', label:'I²S word select (WS)', type:'number', min:0, max:63, help:'Word-select / LRCLK pin.'},
          {key:'i2sSd', label:'I²S data out (SD)', type:'number', min:0, max:63, help:'Data line to the amplifier.'},
          {key:'i2sDin', label:'I²S data in (DIN)', type:'number', min:0, max:63, help:'Data line from the microphone.'},
          {key:'i2sSck', label:'I²S clock (SCK)', type:'number', min:0, max:63, help:'Bit clock pin.'},
        ]},
    ],
  },

  remoteHardware: {
    label:'Remote hardware', kind:'module',
    cards:[
      { title:'Remote hardware',
        desc:'Lets other nodes read and drive this node’s GPIO pins over the mesh. Anyone on your channel can use it, so leave it off unless you need it.',
        fields:[
          {key:'enabled', label:'Module enabled', type:'bool', help:'Allow remote GPIO access.'},
          {key:'allowUndefinedPinAccess', label:'Allow any pin', type:'bool',
           help:'Off restricts access to the pins listed on the node. On exposes every GPIO — risky.'},
        ],
        note:'The named pin list is not editable from Nullmesh — use the official Meshtastic client for that. Whatever the node already has is left untouched when you save here.'},
    ],
  },

  neighborInfo: {
    label:'Neighbor info', kind:'module',
    cards:[
      { title:'Neighbor info',
        desc:'Broadcasts the list of nodes this radio hears directly, which is what builds a mesh topology map. It is chatty — most meshes ask you to leave it off.',
        fields:[
          {key:'enabled', label:'Module enabled', type:'bool', help:'Turn neighbour reporting on.'},
          {key:'updateInterval', label:'Update interval', type:'number', unit:'seconds', min:0, max:604800,
           help:'How often to broadcast the neighbour list. 0 = firmware default (6 hours). Minimum is 4 hours in most builds.'},
          {key:'transmitOverLora', label:'Transmit over LoRa', type:'bool',
           help:'Off keeps neighbour info local to the connected app instead of putting it on the air.'},
        ]},
    ],
  },

  ambientLighting: {
    label:'Ambient lighting', kind:'module',
    cards:[
      { title:'Ambient lighting',
        desc:'Controls an RGB LED fitted to the board. Values are 0–255.',
        fields:[
          {key:'ledState', label:'LED on', type:'bool', help:'Turn the ambient LED on.'},
          {key:'current', label:'Current', type:'number', min:0, max:255, help:'Overall brightness / drive current.'},
          {key:'red', label:'Red', type:'number', min:0, max:255, help:'Red channel level.'},
          {key:'green', label:'Green', type:'number', min:0, max:255, help:'Green channel level.'},
          {key:'blue', label:'Blue', type:'number', min:0, max:255, help:'Blue channel level.'},
        ]},
    ],
  },

  detectionSensor: {
    label:'Detection sensor', kind:'module',
    cards:[
      { title:'Detection sensor',
        desc:'Watches a GPIO and announces to the mesh when it changes — a door switch, PIR sensor, water alarm and so on.',
        fields:[
          {key:'enabled', label:'Module enabled', type:'bool', help:'Turn the detection sensor on.'},
          {key:'name', label:'Sensor name', type:'text', maxlength:20, help:'Friendly name used in the broadcast message, e.g. "Front gate".'},
          {key:'monitorPin', label:'Monitor pin', type:'number', min:0, max:63, help:'GPIO the sensor is wired to.'},
          {key:'detectionTriggerType', label:'Trigger type', type:'enum', enum:'triggerType', help:'Which pin state or edge counts as a detection.'},
          {key:'usePullup', label:'Use internal pull-up', type:'bool', help:'Enable the internal pull-up resistor on the monitored pin.'},
          {key:'sendBell', label:'Send bell character', type:'bool', help:'Append a bell so receiving nodes alert audibly.'},
        ]},
      { title:'Rate limiting',
        desc:'Stops a twitchy sensor from flooding the mesh.',
        fields:[
          {key:'minimumBroadcastSecs', label:'Minimum interval', type:'number', unit:'seconds', min:0, max:604800,
           help:'Never send detections closer together than this. 0 = firmware default (45 s).'},
          {key:'stateBroadcastSecs', label:'State broadcast interval', type:'number', unit:'seconds', min:0, max:604800,
           help:'Also send the current state on this timer even with no change. 0 = off.'},
        ]},
    ],
  },

  paxcounter: {
    label:'Paxcounter', kind:'module',
    cards:[
      { title:'Paxcounter',
        desc:'Counts nearby phones by listening for Wi-Fi and Bluetooth probes, and broadcasts the tally. Check your local privacy rules before using it.',
        fields:[
          {key:'enabled', label:'Module enabled', type:'bool', help:'Turn the passenger counter on.'},
          {key:'paxcounterUpdateInterval', label:'Update interval', type:'number', unit:'seconds', min:0, max:604800,
           help:'How often to broadcast the count. 0 = firmware default.'},
          {key:'wifiThreshold', label:'Wi-Fi RSSI threshold', type:'number', unit:'dBm', min:-128, max:0,
           help:'Ignore Wi-Fi devices weaker than this. 0 = firmware default (-80).'},
          {key:'bleThreshold', label:'Bluetooth RSSI threshold', type:'number', unit:'dBm', min:-128, max:0,
           help:'Ignore Bluetooth devices weaker than this. 0 = firmware default (-80).'},
        ]},
    ],
  },
};

// Order of the sub-tabs shown under the Module tab
const MODULE_TABS = ['mqtt','serial','externalNotification','storeForward','rangeTest','telemetry',
  'cannedMessage','neighborInfo','detectionSensor','ambientLighting','paxcounter','remoteHardware','audio'];

function setConfigTab(tab) {
  S.configTab = tab;
  document.querySelectorAll('.cfg-tab').forEach(b => b.classList.toggle('active', b.dataset.cfg === tab));
  renderConfigPage();
}
function setModuleTab(tab) {
  S.configModuleTab = tab;
  renderConfigPage();
}

// Which section the page is actually showing right now
function activeConfigSection() {
  return S.configTab === 'module' ? S.configModuleTab : S.configTab;
}

function refreshConfigSection(section) {
  if (!S.connected) { toast('Connect to a node first', 'wrn'); return; }
  wsSend({ type:'getConfig', section });
  toast('Reading config from node…', 'inf');
}
function saveConfigSection(section) {
  if (!S.connected) { toast('Connect to a node first', 'wrn'); return; }
  if (!S.configs[section]) { toast('No config loaded yet', 'wrn'); return; }
  wsSend({ type:'setConfig', section, config: S.configs[section] });
  toast('Writing config to node…', 'inf');
}

function enumOptionsFor(name) {
  return (S.configEnums && S.configEnums[name]) || [];
}
function prettyEnum(name) {
  return String(name).toLowerCase().split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function renderConfigPage() {
  const el = document.getElementById('cfgBody');
  if (!el) return;
  const section = activeConfigSection();
  const def = CFG_SECTIONS[section];
  const isModule = S.configTab === 'module';
  const subTabs = isModule ? `<div class="cfg-subtabs">
      ${MODULE_TABS.map(t => `<button class="cfg-subtab${t === section ? ' active' : ''}"
        onclick="setModuleTab('${t}')">${esc(CFG_SECTIONS[t].label)}</button>`).join('')}
    </div>` : '';

  if (!def) { el.innerHTML = `<div class="cfg-wrap">${subTabs}</div>`; return; }

  if (!S.connected) {
    el.innerHTML = `<div class="cfg-wrap">${subTabs}<div class="page-empty">
      <span class="icon xl">settings_ethernet</span>
      <div class="page-empty-title">Not connected</div>
      <div class="page-empty-sub">Connect to your node and Nullmesh will read its ${esc(def.label.toLowerCase())} config.</div>
    </div></div>`;
    return;
  }
  const cfg = S.configs[section];
  if (!cfg) {
    el.innerHTML = `<div class="cfg-wrap">${subTabs}<div class="page-empty">
      <span class="icon xl">downloading</span>
      <div class="page-empty-title">Reading ${esc(def.label.toLowerCase())} config…</div>
      <div class="page-empty-sub">Nullmesh asked the radio for these settings. This takes a few seconds
        over Wi-Fi. <button class="link-btn" onclick="refreshConfigSection('${section}')">Ask again</button></div>
    </div></div>`;
    return;
  }

  const dirty = !!S.configDirty[section];
  el.innerHTML = `<div class="cfg-wrap">
    ${subTabs}
    ${def.cards.map(card => `
      <div class="card">
        <div class="card-hd">
          <div>
            <h2 class="card-title">${esc(card.title)}</h2>
            <p class="card-desc">${esc(card.desc)}</p>
          </div>
        </div>
        <div class="card-body">
          ${card.fields.map(f => renderConfigField(section, f, cfg)).join('')}
          ${card.note ? `<p class="cfg-note">${esc(card.note)}</p>` : ''}
        </div>
      </div>`).join('')}
    <div class="cfg-actions">
      <span class="cfg-status${dirty ? ' dirty' : ''}" id="cfgStatus">${dirty ? 'Unsaved changes' : 'In sync with the node'}</span>
      <button class="btn-ghost" onclick="refreshConfigSection('${section}')"><span class="icon sm">refresh</span> Re-read</button>
      <button class="btn-primary" onclick="saveConfigSection('${section}')"><span class="icon sm">save</span> Save to node</button>
    </div>
    <p class="cfg-note">Saving writes the whole ${esc(def.label)} block to the radio and commits it. The radio may
      briefly restart its settings, then Nullmesh re-reads the values so you can confirm they stuck.</p>
  </div>`;
}

function renderConfigField(section, f, cfg) {
  const val = cfg[f.key];
  let input = '';
  if (f.type === 'bool') {
    input = `<button class="toggle${val ? ' on' : ''}" role="switch" aria-checked="${!!val}"
      onclick="onCfgToggle('${section}', '${f.key}', this)"><span class="knob"></span></button>`;
  } else if (f.type === 'enum') {
    const opts = enumOptionsFor(f.enum);
    input = `<select class="cfg-select" onchange="onCfgChange('${section}', '${f.key}', this.value, 'int')">
      ${opts.length
        ? opts.map(o => `<option value="${o.value}"${Number(val) === o.value ? ' selected' : ''}>${esc(prettyEnum(o.name))}</option>`).join('')
        : `<option value="${esc(String(val))}">${esc(String(val))}</option>`}
    </select>`;
  } else if (f.type === 'number' || f.type === 'float') {
    const isFloat = f.type === 'float';
    input = `<input class="cfg-input num" type="number" value="${esc(String(val ?? 0))}"
      min="${f.min ?? 0}" max="${f.max ?? 4294967295}"${isFloat ? ` step="${f.step ?? 0.01}"` : ''}
      onchange="onCfgChange('${section}', '${f.key}', this.value, '${isFloat ? 'float' : 'int'}')">${f.unit ? `<span class="cfg-unit">${esc(f.unit)}</span>` : ''}`;
  } else {
    input = `<input class="cfg-input" type="${f.type === 'password' ? 'password' : 'text'}" value="${esc(String(val ?? ''))}"
      maxlength="${f.maxlength || 64}" onchange="onCfgChange('${section}', '${f.key}', this.value, 'text')">`;
  }
  return `<div class="cfg-row">
    <div class="cfg-row-text">
      <div class="cfg-label">${esc(f.label)}</div>
      ${f.help ? `<div class="cfg-help">${esc(f.help)}</div>` : ''}
    </div>
    <div class="cfg-control">${input}</div>
  </div>`;
}

function markConfigDirty(section) {
  S.configDirty[section] = true;
  const st = document.getElementById('cfgStatus');
  if (st) { st.textContent = 'Unsaved changes'; st.classList.add('dirty'); }
}
function onCfgChange(section, key, value, kind) {
  const cfg = S.configs[section];
  if (!cfg) return;
  if (kind === 'int') cfg[key] = parseInt(value, 10) || 0;
  else if (kind === 'float') cfg[key] = parseFloat(value) || 0;
  else cfg[key] = String(value);
  markConfigDirty(section);
}
function onCfgToggle(section, key, btn) {
  const cfg = S.configs[section];
  if (!cfg) return;
  const next = !cfg[key];
  cfg[key] = next;
  btn.classList.toggle('on', next);
  btn.setAttribute('aria-checked', String(next));
  markConfigDirty(section);
}

function renderChannelsList() {
  const el = document.getElementById('channelsList');
  if (!el) return;
  const chans = Object.values(S.channels).sort((a,b) => a.index - b.index);
  
  if (!chans.length) {
    el.innerHTML = `<div class="page-empty">
      <span class="icon xl">hub</span>
      <div class="page-empty-title">No channels yet</div>
      <div class="page-empty-sub">${S.connected
        ? 'Your node is still sending its channel list.'
        : 'Connect to your node to load the channels it is configured with.'}</div>
    </div>`;
    return;
  }

  el.innerHTML = chans.map(ch => {
    const tabId = 'ch:' + ch.index;
    const msgs = (S.conversations[tabId] || []).filter(m => !m.sys);
    const last = msgs[msgs.length - 1];
    const unread = S.unread[tabId] || 0;
    const active = S.activeChannel === tabId;
    const nodeCount = Object.values(S.nodes).length;
    const onlineCount = Object.values(S.nodes).filter(isOnline).length;
    const lastPreview = last
      ? `${last.mine ? 'You' : esc(last.fromName || '?')}: ${esc(last.text)}`
      : 'No messages yet';
    const lastTime = last ? timeStr(last.ts) : '';
    const isPrimary = ch.role === 'PRIMARY';
    return `<div class="channel-row ${active ? 'active' : ''}" onclick="openChannel('${tabId}')">
      <div class="ch-row-icon">
        <span class="icon">${isPrimary ? 'campaign' : 'hub'}</span>
      </div>
      <div class="ch-row-info">
        <div class="ch-row-name">${esc(ch.name)} ${isPrimary ? '<span style="font-size:10px;color:var(--blue);font-weight:400">PRIMARY</span>' : ''}</div>
        <div class="ch-row-sub">${nodeCount} node${nodeCount !== 1 ? 's' : ''} · ${onlineCount} online · ${lastPreview}</div>
      </div>
      <div class="ch-row-meta">
        <span style="font-size:11px;color:var(--label-3)">${lastTime}</span>
        ${unread ? `<span class="ch-row-badge">${unread}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function openChannel(tabId) {
  setActiveTab(tabId);
  const inp = document.getElementById('compInp2');
  if (inp) inp.focus();
}

// Port selection
let selectedPort = 80;
function setPort(p) {
  selectedPort = p;
  document.querySelectorAll('input[name=meshPort], input[name=frPort]').forEach(r => {
    r.checked = Number(r.value) === p;
  });
}

// Init — wait for DOM to be fully parsed before touching any elements
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init(); // already parsed
}

function init() {
  // Remember the last node IP the user connected to
  try {
    const lastIp = localStorage.getItem('mn_last_ip');
    if (lastIp) {
      const a = document.getElementById('nodeIp'); if (a) a.value = lastIp;
      const b = document.getElementById('frIp');   if (b) b.value = lastIp;
    }
    S.everConnected = localStorage.getItem('mn_ever_connected') === '1';
  } catch {}

  // Restore last page
  let page = 'messages';
  try { const p = localStorage.getItem('mn_page'); if (p && PAGES[p]) page = p; } catch {}
  navigate(page);

  renderChatList();
  renderDMThread();
  renderPeers();
  renderChannelsList();
  renderChannelThread();
  updateIdentity();

  // Guided first-run connect card, or the compact reconnect control for returning users
  if (!S.everConnected) showFirstRun();
  else toggleConnPanel(true);

  setTimeout(connectWS, 50);
  setTimeout(() => { if (typeof map !== 'undefined') map.invalidateSize(); }, 400);
}
