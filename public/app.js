const socket = io();
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const viewLanding = $('#view-landing');
const viewLobby = $('#view-lobby');
const viewRoom = $('#view-room');
const videoGrid = $('#videoGrid');
const chatList = $('#chatList');
const peopleList = $('#peopleList');

let state = {
  roomId: null,
  userName: localStorage.getItem('meetly_name') || '',
  topic: '',
  isMicOn: true,
  isCamOn: true,
  isScreenSharing: false,
  handRaised: false,
  sideOpen: true,
  layout: 'grid',
  localStream: null,
  screenStream: null,
  peers: new Map(), // socketId -> { pc, stream, el }
  participants: [],
  timerInterval: null,
  startTs: null
};

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

// ---------- helpers ----------
function show(view){
  viewLanding.classList.add('hidden');
  viewLobby.classList.add('hidden');
  viewRoom.classList.add('hidden');
  view.classList.remove('hidden');
}
function toast(msg, ms=2200){
  const t=document.createElement('div'); t.className='toast'; t.textContent=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(), ms);
}
function genAvatar(name){ return (name||'G').slice(0,2).toUpperCase(); }
function fmtTime(s){ const m=Math.floor(s/60).toString().padStart(2,'0'); const sec=(s%60).toString().padStart(2,'0'); return `${m}:${sec}`; }
function persistRecent(roomId, topic){
  try{
    const rec = JSON.parse(localStorage.getItem('meetly_recent')||'[]');
    const filtered = rec.filter(r=>r.roomId!==roomId);
    filtered.unshift({roomId, topic: topic||'Meeting', at: Date.now()});
    localStorage.setItem('meetly_recent', JSON.stringify(filtered.slice(0,6)));
    renderRecent();
  }catch{}
}
function renderRecent(){
  const rec = JSON.parse(localStorage.getItem('meetly_recent')||'[]');
  const el=$('#recentList'); if(!el) return;
  el.innerHTML = rec.length ? '' : '<span style="font-size:13px;color:var(--muted)">No recent meetings</span>';
  rec.forEach(r=>{
    const d=document.createElement('div'); d.className='chip';
    d.innerHTML=`<span>${r.topic} • ${r.roomId}</span>`;
    const b=document.createElement('button'); b.textContent='Join'; b.onclick=()=> goLobby(r.roomId, r.topic);
    d.appendChild(b); el.appendChild(d);
  });
}
function getRoomFromPath(){
  const m = location.pathname.match(/\/room\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}
function inviteLink(roomId){ return `${location.origin}/room/${roomId}`; }
function copy(text){ navigator.clipboard.writeText(text).then(()=>toast('Copied!')).catch(()=>toast(text)); }

// ---------- media ----------
async function getLocalMedia(){
  try{
    if(state.localStream) state.localStream.getTracks().forEach(t=>t.stop());
  }catch{}
  try{
    const stream = await navigator.mediaDevices.getUserMedia({
      video: state.isCamOn ? { width: { ideal: 1280 }, height:{ideal:720} } : false,
      audio: state.isMicOn ? { echoCancellation:true, noiseSuppression:true, autoGainControl:true } : false
    });
    // If cam off, we requested audio only; ensure tracks reflect toggles
    if(!state.isCamOn) stream.getVideoTracks().forEach(t=>t.enabled=false);
    if(!state.isMicOn) stream.getAudioTracks().forEach(t=>t.enabled=false);
    state.localStream = stream;
    attachPreview(stream);
    attachLocalTile(stream);
    return stream;
  }catch(e){
    console.warn(e);
    toast('Camera/mic permission needed — you can still join with devices off');
    // Create empty stream with no tracks so peer connections still work (data only fallback)
    state.localStream = new MediaStream();
    attachPreview(null);
    attachLocalTile(state.localStream);
    return state.localStream;
  }
}
function attachPreview(stream){
  const v=$('#previewVideo'); const fb=$('#previewFallback');
  if(stream && stream.getVideoTracks().length && state.isCamOn){
    v.srcObject = stream; fb.style.display='none'; v.style.display='block';
  } else {
    v.srcObject = null; fb.style.display='grid'; v.style.display='none';
  }
  updateLobbyButtons();
}
function updateLobbyButtons(){
  $('#lobbyMic').classList.toggle('off', !state.isMicOn);
  $('#lobbyCam').classList.toggle('off', !state.isCamOn);
  $('#lobbyMic').textContent = state.isMicOn ? '🎙️' : '🔇';
  $('#lobbyCam').textContent = state.isCamOn ? '📷' : '🚫';
  $('#chkMic').checked = state.isMicOn; $('#chkCam').checked = state.isCamOn;
}
function attachLocalTile(stream){
  ensureTile('local', state.userName || 'You', true, stream, true);
}

// ---------- tiles ----------
function ensureTile(socketId, name, isLocal, stream, mirrored=false){
  let tile = document.getElementById(`tile-${socketId}`);
  if(!tile){
    tile = document.createElement('div'); tile.className='tile'; if(mirrored) tile.classList.add('mirrored');
    tile.id=`tile-${socketId}`;
    tile.innerHTML=`
      <video autoplay playsinline ${isLocal?'muted':''}></video>
      <div class="avatar" style="display:none"></div>
      <div class="label"><span class="name"></span><span class="badge" style="display:none">mic off</span><span class="badge cam-badge" style="display:none">cam off</span></div>
      <div class="hand" style="display:none">✋</div>
    `;
    videoGrid.appendChild(tile);
  }
  const v=tile.querySelector('video'); const av=tile.querySelector('.avatar');
  const nameEl=tile.querySelector('.name');
  nameEl.textContent = name + (isLocal?' (You)':'');
  if(stream){
    v.srcObject = stream; v.style.display='block'; av.style.display='none';
  } else {
    v.srcObject=null; v.style.display='none'; av.style.display='grid'; av.textContent=genAvatar(name);
  }
  return tile;
}
function removeTile(socketId){
  const el=document.getElementById(`tile-${socketId}`); if(el) el.remove();
}
function setPeerMedia(socketId, stream){
  const peer = state.peers.get(socketId);
  const info = state.participants.find(p=>p.socketId===socketId);
  const name = info?.name || 'Guest';
  ensureTile(socketId, name, false, stream, false);
  if(peer) peer.stream = stream;
}

// ---------- WebRTC ----------
async function createPeer(socketId, isInitiator){
  if(state.peers.has(socketId)) return state.peers.get(socketId);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = { pc, socketId, stream: null };
  state.peers.set(socketId, peer);

  // add local tracks
  if(state.localStream){
    state.localStream.getTracks().forEach(t=> pc.addTrack(t, state.localStream));
  }
  // screen share tracks handled separately

  pc.onicecandidate = e => {
    if(e.candidate) socket.emit('signal', { to: socketId, data: { candidate: e.candidate }});
  };
  pc.ontrack = e => {
    // aggregate streams
    const remoteStream = e.streams[0] || new MediaStream([e.track]);
    // Merge tracks into single stream per peer
    if(!peer.stream) peer.stream = new MediaStream();
    // Replace/add track of same kind
    const existing = peer.stream.getTracks().find(t=>t.kind===e.track.kind);
    if(existing) peer.stream.removeTrack(existing);
    peer.stream.addTrack(e.track);
    setPeerMedia(socketId, peer.stream);
  };
  pc.onconnectionstatechange = () => {
    if(pc.connectionState==='failed' || pc.connectionState==='disconnected'){
      // attempt restart
    }
  };

  if(isInitiator){
    const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
    await pc.setLocalDescription(offer);
    socket.emit('signal', { to: socketId, data: { sdp: pc.localDescription }});
  }
  return peer;
}

async function handleSignal(from, data){
  let peer = state.peers.get(from);
  if(!peer) peer = await createPeer(from, false);
  const pc = peer.pc;
  if(data.sdp){
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if(data.sdp.type==='offer'){
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { sdp: pc.localDescription }});
    }
  } else if(data.candidate){
    try{ await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }catch(e){ console.warn(e); }
  }
}

// ---------- lobby / room flow ----------
async function goLobby(roomId, topic){
  state.roomId = roomId;
  state.topic = topic || 'Meeting';
  history.pushState(null,'', `/room/${roomId}`);
  $('#lobbyRoom').value = roomId;
  $('#lobbyTitle').textContent = topic ? topic : 'Ready to join?';
  $('#lobbyMeta').textContent = `Room ${roomId} • ${topic||'Instant meeting'}`;
  $('#lobbyName').value = state.userName;
  show(viewLobby);
  await getLocalMedia();
}
async function enterRoom(){
  const name = $('#lobbyName').value.trim() || `Guest-${Math.floor(Math.random()*9000)}`;
  state.userName = name; localStorage.setItem('meetly_name', name);
  const roomId = ($('#lobbyRoom').value.trim() || state.roomId);
  if(!roomId) return toast('Enter a room code');
  state.roomId = roomId;
  // ensure media respects lobby toggles
  state.isMicOn = $('#chkMic').checked;
  state.isCamOn = $('#chkCam').checked;
  if(state.localStream){
    state.localStream.getAudioTracks().forEach(t=>t.enabled=state.isMicOn);
    state.localStream.getVideoTracks().forEach(t=>t.enabled=state.isCamOn);
  } else {
    await getLocalMedia();
  }

  show(viewRoom);
  $('#roomTopic').textContent = state.topic || 'Meeting';
  $('#roomCodePill').textContent = roomId;
  $('#infoRoom').textContent = roomId;
  $('#infoTopic').textContent = state.topic || 'Instant Meeting';
  $('#infoLink').textContent = inviteLink(roomId);
  $('#roomCount').textContent = 'Joining…';
  videoGrid.innerHTML='';
  // re-attach local tile
  attachLocalTile(state.localStream);
  updateControls();
  persistRecent(roomId, state.topic);
  startTimer();

  socket.emit('join-room', { roomId, userName: name, avatar: genAvatar(name) });
}

function startTimer(){
  state.startTs = Date.now();
  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(()=>{
    const sec = Math.floor((Date.now()-state.startTs)/1000);
    $('#roomTimer').textContent = fmtTime(sec);
  },1000);
}
function updateControls(){
  $('#cMic').classList.toggle('danger-active', !state.isMicOn);
  $('#cMic').classList.toggle('active', state.isMicOn);
  $('#cCam').classList.toggle('danger-active', !state.isCamOn);
  $('#cCam').classList.toggle('active', state.isCamOn);
  $('#cHand').classList.toggle('active', state.handRaised);
  $('#cScreen').classList.toggle('active', state.isScreenSharing);
  // badges on local tile
  const tile=document.getElementById('tile-local');
  if(tile){
    tile.querySelector('.badge').style.display = state.isMicOn ? 'none' : 'inline-block';
    tile.querySelector('.badge').textContent='mic off';
    tile.querySelector('.cam-badge').style.display = state.isCamOn ? 'none' : 'inline-block';
    tile.querySelector('.cam-badge').textContent='cam off';
    if(!state.isCamOn || !state.localStream || state.localStream.getVideoTracks().length===0){
      tile.querySelector('video').style.display='none';
      tile.querySelector('.avatar').style.display='grid';
      tile.querySelector('.avatar').textContent=genAvatar(state.userName);
    } else {
      tile.querySelector('video').style.display='block';
      tile.querySelector('.avatar').style.display='none';
    }
  }
}
function leaveRoom(){
  clearInterval(state.timerInterval);
  // stop screen share
  if(state.screenStream) stopScreenShare();
  // close peers
  state.peers.forEach(({pc})=> pc.close());
  state.peers.clear();
  videoGrid.innerHTML='';
  if(state.localStream) state.localStream.getTracks().forEach(t=>t.stop());
  socket.emit('leave-room');
  location.href='/';
}

// ---------- side tabs / chat ----------
function setTab(name){
  $$('.tab').forEach(t=> t.classList.toggle('active', t.dataset.tab===name));
  $('#tab-chat').classList.toggle('hidden', name!=='chat');
  $('#tab-people').classList.toggle('hidden', name!=='people');
  $('#tab-info').classList.toggle('hidden', name!=='info');
  $('#chatInputRow').style.display = name==='chat' ? 'flex' : 'none';
  $('#reactionsBar').style.display = name==='chat' ? 'flex' : 'none';
}
function addChatMessage(m){
  const isMe = m.senderId===socket.id;
  if(m.system){
    const s=document.createElement('div'); s.className='system'; s.textContent=m.text; chatList.appendChild(s);
  } else {
    const d=document.createElement('div'); d.className='msg '+(isMe?'me':'other');
    d.innerHTML=`<div>${escapeHtml(m.text)}</div><div class="meta">${escapeHtml(m.senderName)} • ${new Date(m.ts).toLocaleTimeString()}</div>`;
    chatList.appendChild(d);
  }
  chatList.scrollTop = chatList.scrollHeight;
}
function escapeHtml(s){ return s.replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function renderPeople(){
  peopleList.innerHTML='';
  const all = state.participants;
  // include local
  const local = { socketId:'local', name: state.userName+' (You)', mic: state.isMicOn, cam: state.isCamOn, handRaised: state.handRaised };
  [local, ...all].forEach(p=>{
    const d=document.createElement('div'); d.className='participant';
    d.innerHTML=`
      <div class="p-avatar">${genAvatar(p.name)}</div>
      <div class="p-meta"><b>${escapeHtml(p.name)} ${p.socketId===state.hostId?'👑':''}</b><span>${p.handRaised?'✋ Hand raised • ':''}${p.mic?'🎙️':'🔇'} ${p.cam?'📷':'🚫'}</span></div>
      <div class="p-icons">${p.handRaised?'✋':''}</div>
    `;
    peopleList.appendChild(d);
  });
  $('#roomCount').textContent = `${all.length+1} participant${all.length?'s':''}`;
  $('#infoHost').textContent = (all.find(p=>p.socketId===state.hostId)?.name) || state.userName;
}

// ---------- screen share ----------
async function toggleScreenShare(){
  if(state.isScreenSharing) return stopScreenShare();
  try{
    const stream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:true });
    state.screenStream = stream;
    state.isScreenSharing = true;
    updateControls();
    // replace video track for all peers
    const videoTrack = stream.getVideoTracks()[0];
    state.peers.forEach(({pc})=>{
      const sender = pc.getSenders().find(s=> s.track && s.track.kind==='video');
      if(sender) sender.replaceTrack(videoTrack);
    });
    // show locally as tile? Replace local video element
    const tile=document.getElementById('tile-local');
    if(tile) tile.querySelector('video').srcObject = stream;
    videoTrack.onended = ()=> stopScreenShare();
    socket.emit('screen-share-started');
    toast('Screen sharing started');
  }catch(e){ toast('Screen share cancelled'); }
}
function stopScreenShare(){
  if(!state.isScreenSharing) return;
  if(state.screenStream) state.screenStream.getTracks().forEach(t=>t.stop());
  state.screenStream=null; state.isScreenSharing=false;
  updateControls();
  // restore camera track
  const camTrack = state.localStream ? state.localStream.getVideoTracks()[0] : null;
  const localTileVideo = document.querySelector('#tile-local video');
  if(localTileVideo && state.localStream) localTileVideo.srcObject = state.localStream;
  state.peers.forEach(({pc})=>{
    const sender = pc.getSenders().find(s=> s.track && s.track.kind==='video');
    if(sender && camTrack) sender.replaceTrack(camTrack);
    else if(sender) sender.replaceTrack(null);
  });
  socket.emit('screen-share-stopped');
  toast('Screen share stopped');
}

// ---------- socket events ----------
socket.on('room-joined', async ({ roomId, topic, participants, messages, hostId })=>{
  state.topic = topic; $('#roomTopic').textContent=topic;
  state.participants = participants; state.hostId=hostId;
  renderPeople();
  messages.forEach(addChatMessage);
  // create peer connections to existing participants (we are initiator)
  for(const p of participants){
    ensureTile(p.socketId, p.name, false, null, false);
    await createPeer(p.socketId, true);
  }
});
socket.on('user-joined', async ({ socketId, userName })=>{
  addChatMessage({ system:true, text:`${userName} joined` });
  ensureTile(socketId, userName, false, null, false);
  await createPeer(socketId, false);
});
socket.on('user-left', ({ socketId, userName })=>{
  addChatMessage({ system:true, text:`${userName} left` });
  const peer=state.peers.get(socketId);
  if(peer) peer.pc.close();
  state.peers.delete(socketId);
  state.participants = state.participants.filter(p=>p.socketId!==socketId);
  removeTile(socketId); renderPeople();
});
socket.on('signal', async ({ from, data })=> handleSignal(from, data));
socket.on('participants-updated', (list)=>{
  state.participants = list.filter(p=>p.socketId!==socket.id);
  // update tiles badges
  list.forEach(p=>{
    const tile=document.getElementById(`tile-${p.socketId}`) || (p.socketId===socket.id ? document.getElementById('tile-local') : null);
    if(tile){
      const micBadge=tile.querySelector('.badge');
      const camBadge=tile.querySelector('.cam-badge');
      if(micBadge) { micBadge.style.display = p.mic ? 'none':'inline-block'; micBadge.textContent='mic off'; }
      if(camBadge) { camBadge.style.display = p.cam ? 'none':'inline-block'; camBadge.textContent='cam off'; }
      const h=tile.querySelector('.hand'); if(h) h.style.display = p.handRaised ? 'block':'none';
      // avatar vs video
      if(!p.cam){
        const v=tile.querySelector('video'); const av=tile.querySelector('.avatar');
        if(v) v.style.display='none'; if(av){ av.style.display='grid'; av.textContent=genAvatar(p.name); }
      } else {
        // if we have stream, show video; else avatar
        const peer=state.peers.get(p.socketId);
        const hasStream = peer && peer.stream && peer.stream.getVideoTracks().some(t=>t.enabled);
        // keep as is
      }
    }
  });
  renderPeople();
});
socket.on('peer-mic-toggle', ({ socketId })=>{});
socket.on('peer-cam-toggle', ({ socketId })=>{});
socket.on('hand-updated', ({ socketId, raised })=>{
  const tile=document.getElementById(`tile-${socketId}`); if(tile) tile.querySelector('.hand').style.display = raised?'block':'none';
});
socket.on('reaction', ({ socketId, emoji })=>{
  const tile=document.getElementById(`tile-${socketId}`) || document.getElementById('tile-local');
  if(tile){
    const f=document.createElement('div'); f.className='reaction-fly'; f.textContent=emoji;
    tile.appendChild(f); setTimeout(()=>f.remove(),2200);
  }
});
socket.on('chat-message', (msg)=> addChatMessage(msg));
socket.on('system-message', ({ text })=> addChatMessage({ system:true, text }));
socket.on('host-changed', ({ hostId })=>{ state.hostId=hostId; renderPeople(); });
socket.on('peer-screen-share', ({ socketId, sharing })=>{
  toast(`${state.participants.find(p=>p.socketId===socketId)?.name||'Peer'} ${sharing?'started':'stopped'} screen share`);
});

// ---------- UI wiring ----------
renderRecent();
$('#btnCreate').onclick = async ()=>{
  const name=$('#landingName').value.trim();
  if(name) { state.userName=name; localStorage.setItem('meetly_name', name); }
  const topic=$('#landingTopic').value.trim() || 'Instant Meeting';
  const res=await fetch('/api/rooms',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ topic, hostName: name })});
  const data=await res.json();
  goLobby(data.roomId, topic);
};
$('#btnJoin').onclick = ()=>{
  const raw=$('#joinInput').value.trim(); if(!raw) return toast('Enter a code or link');
  const m=raw.match(/\/room\/([a-z0-9]+)/i) || raw.match(/^([a-z0-9]{6,})$/i);
  const code=m?m[1]:raw;
  const name=$('#landingName').value.trim(); if(name){ state.userName=name; localStorage.setItem('meetly_name',name); }
  goLobby(code, $('#landingTopic').value.trim());
};
$('#joinInput').addEventListener('keydown', e=>{ if(e.key==='Enter') $('#btnJoin').click(); });
$('#btnClearRecent').onclick=()=>{ localStorage.removeItem('meetly_recent'); renderRecent(); };

$('#lobbyMic').onclick=()=>{ state.isMicOn=!state.isMicOn; if(state.localStream) state.localStream.getAudioTracks().forEach(t=>t.enabled=state.isMicOn); updateLobbyButtons(); attachPreview(state.localStream); };
$('#lobbyCam').onclick=()=>{ state.isCamOn=!state.isCamOn; if(state.localStream) state.localStream.getVideoTracks().forEach(t=>t.enabled=state.isCamOn); updateLobbyButtons(); attachPreview(state.localStream); };
$('#chkMic').onchange=e=>{ state.isMicOn=e.target.checked; if(state.localStream) state.localStream.getAudioTracks().forEach(t=>t.enabled=state.isMicOn); updateLobbyButtons(); attachPreview(state.localStream); };
$('#chkCam').onchange=e=>{ state.isCamOn=e.target.checked; if(state.localStream) state.localStream.getVideoTracks().forEach(t=>t.enabled=state.isCamOn); updateLobbyButtons(); attachPreview(state.localStream); };
$('#btnEnter').onclick=enterRoom;
$('#btnBack').onclick=()=>{ history.pushState(null,'','/'); show(viewLanding); if(state.localStream) state.localStream.getTracks().forEach(t=>t.stop()); };
$('#btnCopyLobby').onclick=()=> copy(inviteLink($('#lobbyRoom').value.trim()));
$('#btnShareLink').onclick=()=>{
  const roomId=state.roomId || getRoomFromPath();
  if(roomId) copy(inviteLink(roomId)); else toast('Create or join a meeting first');
};

// room controls
$('#cMic').onclick=()=>{
  state.isMicOn=!state.isMicOn;
  if(state.localStream) state.localStream.getAudioTracks().forEach(t=>t.enabled=state.isMicOn);
  socket.emit('mic-toggle',{ micOn: state.isMicOn });
  updateControls(); toast(state.isMicOn?'Mic on':'Mic off');
};
$('#cCam').onclick=()=>{
  state.isCamOn=!state.isCamOn;
  if(state.localStream) state.localStream.getVideoTracks().forEach(t=>t.enabled=state.isCamOn);
  socket.emit('cam-toggle',{ camOn: state.isCamOn });
  updateControls(); toast(state.isCamOn?'Camera on':'Camera off');
};
$('#cScreen').onclick=toggleScreenShare;
$('#cHand').onclick=()=>{
  state.handRaised=!state.handRaised;
  socket.emit('hand-toggle',{ raised: state.handRaised });
  updateControls(); toast(state.handRaised?'✋ Hand raised':'Hand lowered');
};
$('#cLeave').onclick=leaveRoom;
$('#cChat').onclick=()=>{ setTab('chat'); if(window.innerWidth<900) $('#sidePanel').style.display='flex'; };
$('#cPeople').onclick=()=>{ setTab('people'); if(window.innerWidth<900) $('#sidePanel').style.display='flex'; };
$('#btnLayout').onclick=()=>{
  state.layout = state.layout==='grid' ? 'spotlight' : 'grid';
  videoGrid.className = `video-grid layout-${state.layout}`;
  toast(`Layout: ${state.layout}`);
};
$('#btnToggleSide').onclick=()=>{
  const side=$('#sidePanel');
  side.style.display = side.style.display==='none' ? 'flex' : 'none';
};
$('#btnInvite').onclick=()=> copy(inviteLink(state.roomId));
$('#btnCopyInfo').onclick=()=> copy(inviteLink(state.roomId));

$$('.tab').forEach(t=> t.onclick=()=> setTab(t.dataset.tab));
$$('.react').forEach(b=> b.onclick=()=>{
  const emoji=b.dataset.emoji;
  socket.emit('reaction',{ emoji });
  // local fly
  const tile=document.getElementById('tile-local');
  if(tile){ const f=document.createElement('div'); f.className='reaction-fly'; f.textContent=emoji; tile.appendChild(f); setTimeout(()=>f.remove(),2200); }
});

$('#btnSend').onclick=sendChat;
$('#chatInput').addEventListener('keydown', e=>{ if(e.key==='Enter') sendChat(); });
function sendChat(){
  const text=$('#chatInput').value.trim(); if(!text) return;
  socket.emit('chat-message',{ text });
  $('#chatInput').value='';
}

// deep link
const directRoom=getRoomFromPath();
if(directRoom){
  // if landing, go to lobby directly
  state.topic='Meeting';
  goLobby(directRoom);
}

// handle back/forward
window.addEventListener('popstate', ()=>{
  const r=getRoomFromPath();
  if(!r) show(viewLanding);
});

// init lobby name
if(state.userName) $('#landingName').value=state.userName;
if(state.userName) $('#lobbyName').value=state.userName;
