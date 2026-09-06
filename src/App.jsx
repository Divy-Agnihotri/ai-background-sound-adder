import React,{useState,useRef,useEffect,useMemo,useCallback}from"react";
import{AgentPanel,useAgent}from"./agent";

const GLOBAL_RESET = `
html, body, #root, #app {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
}
`;
const FPS=30,MS=20,GS=10,EB=2,BP=40,ZN=.5,ZX=2.5,SP=9,HW=148,LH=64,CH=42,AE=56,AS=16;
const AUDIO_EXT=/\.(mp3|wav|ogg|m4a|aac|flac|webm|opus)$/i;
const DRIFT_TOL=0.15;
const FADE_DEFAULT=1.5; // seconds used when fade_in/fade_out is `true` rather than a number
const FFMPEG_CORE_BASE="/ffmpeg-vendor/core/dist/esm";
const WS_ID="audio-editor";
const WS_URL="ws://localhost:8765"; // <-- replace with your real endpoint
const WS_RECONNECT_DELAY=2000;

const TI={};

const PL=[["#7c93ff","#4d5fcf"],["#46d9c0","#219883"],["#ff9f6b","#d4703c"],["#c792ff","#8f4fd1"],["#ffd166","#c99a2e"],["#5ec8ff","#2f8fd1"]];

const hs=s=>{let h=0;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0;return Math.abs(h)||1};
const cl=(v,lo,hi)=>Math.max(lo,Math.min(v,hi));
const p2=n=>String(Math.floor(n)).padStart(2,"0");
const tc=f=>{const t=Math.floor(f/FPS);return`${p2(t/3600)}:${p2((t%3600)/60)}:${p2(t%60)}:${p2(f%FPS)}`};
const norm=s=>(s||"").split(/[\\/]/).pop().trim().toLowerCase();
const extOf=name=>{const m=/\.[^.]+$/.exec(name||"");return m?m[0]:".mp3"};

// `true` -> default duration, a positive number -> that many seconds, anything else -> no fade
const parseFade=v=>{
  if(v===true)return FADE_DEFAULT;
  if(typeof v==="number"&&Number.isFinite(v)&&v>0)return v;
  return 0;
};



function tfp(entries,audioMap){
  const tracks={};let skipped=0,missing=0;
  entries.forEach((e,i)=>{
    const start=Number(e.start_time),end=Number(e.end_time),filename=e.filename;
    if(!filename||!Number.isFinite(start)||!Number.isFinite(end)||end<=start){skipped++;return}
    const id=e.sound_id||`${filename}-${i}`,[c,d]=PL[i%PL.length];
    const file=audioMap.get(norm(filename));
    if(!file)missing++;
    const durSec=end-start;
    let fadeIn=parseFade(e.fade_in),fadeOut=parseFade(e.fade_out);
    if(fadeIn+fadeOut>durSec*.9&&fadeIn+fadeOut>0){
      const scale=(durSec*.9)/(fadeIn+fadeOut);
      fadeIn*=scale;fadeOut*=scale;
    }
    const loop=!!e.loop;
    const needsProc=(fadeIn>0||fadeOut>0||loop)&&!!file;
    tracks[id]={id,label:(e.type||"audio").toUpperCase(),name:filename,color:c,colorDark:d,
      start:Math.round(start*FPS),duration:Math.max(1,Math.round((end-start)*FPS)),seed:hs(filename||id),
      muted:!!e.muted,url:file?URL.createObjectURL(file):null,hasAudio:!!file,file:file||null,
      fadeIn,fadeOut,loop,fadeState:needsProc?"pending":"none"}; // rename fadeState->procState if you want to be tidy
  });
  return{tracks,skipped,missing};
}
function tracksToEntries(tracks){
  return Object.values(tracks).map(t=>({
    sound_id:t.id,filename:t.name,type:(t.label||"").toLowerCase(),
    start_time:+(t.start/FPS).toFixed(3),end_time:+((t.start+t.duration)/FPS).toFixed(3),muted:t.muted,
    fade_in:+(t.fadeIn||0).toFixed(2),fade_out:+(t.fadeOut||0).toFixed(2),loop:!!t.loop,
  }));
}
function sb(seed,count){
  let s=seed;const r=()=>{s=(s*9301+49297)%233280;return s/233280};
  return Array.from({length:count},()=>18+r()*78);
}

// ---- ffmpeg.wasm: lazy singleton loader + fade renderer ----
let ffmpegSingleton=null,ffmpegLoadPromise=null;
async function getFFmpeg(){
  if(ffmpegSingleton)return ffmpegSingleton;
  if(!ffmpegLoadPromise){
    ffmpegLoadPromise=(async()=>{
      const{FFmpeg}=await import("@ffmpeg/ffmpeg");
      const{toBlobURL}=await import("@ffmpeg/util");
      const ffmpeg=new FFmpeg();
      ffmpeg.on("log",({message})=>console.log("[ffmpeg]",message));
      await ffmpeg.load({
        coreURL:await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`,"text/javascript"),
        wasmURL:await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`,"application/wasm"),
        classWorkerURL:"/ffmpeg-vendor/ffmpeg/dist/esm/worker.js",
      });
      ffmpegSingleton=ffmpeg;
      return ffmpeg;
    })().catch(err=>{ffmpegLoadPromise=null;throw err});
  }
  return ffmpegLoadPromise;
}

async function renderProcessedAudio(ffmpeg,file,{loop,fadeInSec,fadeOutSec,clipDurSec}){
  const{fetchFile}=await import("@ffmpeg/util");
  const uid=Math.random().toString(36).slice(2);
  const inName=`in_${uid}${extOf(file.name)}`,outName=`out_${uid}.wav`;
  await ffmpeg.writeFile(inName,await fetchFile(file));

  const args=[];
  if(loop)args.push("-stream_loop","-1"); // repeat input indefinitely, we trim it below
  args.push("-i",inName);

  const filters=[];
  if(fadeInSec>0)filters.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(2)}`);
  if(fadeOutSec>0){
    const st=Math.max(0,clipDurSec-fadeOutSec);
    filters.push(`afade=t=out:st=${st.toFixed(2)}:d=${fadeOutSec.toFixed(2)}`);
  }
  if(filters.length)args.push("-af",filters.join(","));

  // -stream_loop is infinite, so we MUST cap duration or ffmpeg runs forever
  args.push("-t",clipDurSec.toFixed(2));
  args.push(outName);

  await ffmpeg.exec(args);
  const data=await ffmpeg.readFile(outName);
  try{await ffmpeg.deleteFile(inName)}catch{}
  try{await ffmpeg.deleteFile(outName)}catch{}
  return URL.createObjectURL(new Blob([data.buffer],{type:"audio/wav"}));
}

const CSS=`
.tled-btn{background:#1f222b;color:#dfe2ea;border:1px solid #2c2f3b;border-radius:7px;font:600 12.5px "Manrope",sans-serif;padding:7px 13px;cursor:pointer;transition:background 120ms ease,border-color 120ms ease,transform 80ms ease}
.tled-btn:hover{background:#262a35;border-color:#3a3f4e}
.tled-btn:active{transform:translateY(1px)}
.tled-btn:disabled{opacity:.45;cursor:not-allowed}
.tled-btn-play{width:34px;height:34px;border-radius:50%;background:#ffb454;border:none;color:#201404;font-size:13px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform 100ms ease,box-shadow 150ms ease;box-shadow:0 0 0 0 rgba(255,180,84,.5)}
.tled-btn-play:hover{transform:scale(1.06);box-shadow:0 0 14px rgba(255,180,84,.45)}
.tled-btn-play:active{transform:scale(.96)}
.tled-btn-play:disabled{opacity:.4;cursor:not-allowed;box-shadow:none}
.tled-icon-btn{width:22px;height:22px;border-radius:5px;border:1px solid #2c2f3b;background:#1a1d24;color:#6b7182;font:700 9.5px "IBM Plex Mono",monospace;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 120ms ease}
.tled-icon-btn.active{background:rgba(255,180,84,.14);border-color:#ffb454;color:#ffb454}
.tled-icon-btn:hover{border-color:#4a4f60}
.tled-clip{transition:box-shadow 140ms ease,filter 140ms ease}
.tled-clip:hover{box-shadow:0 6px 20px rgba(0,0,0,.5)}
.tled-clip.dragging{box-shadow:0 10px 28px rgba(0,0,0,.55)}
.tled-clip.muted{filter:grayscale(.7) brightness(.6)}
.tled-scroll::-webkit-scrollbar{height:10px;width:10px}
.tled-scroll::-webkit-scrollbar-track{background:#14151a}
.tled-scroll::-webkit-scrollbar-thumb{background:#2c2f3b;border-radius:6px}
.tled-scroll::-webkit-scrollbar-thumb:hover{background:#3a3f4e}
@keyframes tled-pulse{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes tled-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes tled-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@keyframes tled-panel-in{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:translateX(0)}}
.tled-toast{animation:tled-toast-in 180ms ease}
.tled-panel{animation:tled-panel-in 180ms ease}
.tled-range{-webkit-appearance:none;appearance:none;width:84px;height:3px;border-radius:2px;background:#2c2f3b;outline:none}
.tled-range::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:#ffb454;cursor:pointer;border:2px solid #171a21}
.tled-range::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#ffb454;cursor:pointer;border:2px solid #171a21}
.tled-spinner{animation:tled-spin 900ms linear infinite}
.tled-agent-textarea::placeholder{color:#4a4f60}
`;

function Rl({pps,widthPx,totalSeconds,onScrub}){
  const sev=pps<20?5:1,q=totalSeconds*4,ticks=[];
  for(let i=0;i<=q;i++){
    const sec=i*.25,major=i%4===0;
    if(!major){const x=sec*pps;ticks.push(<line key={`m${i}`} x1={x} x2={x} y1={30} y2={24} stroke="#3a3f4e" strokeWidth={1}/>);continue}
    const si=Math.round(sec),x=si*pps,showLabel=si%sev===0;
    ticks.push(<g key={`M${i}`}>
      <line x1={x} x2={x} y1={30} y2={14} stroke="#6b7182" strokeWidth={1.3}/>
      {showLabel&&<text x={x+4} y={13} fill="#868da3" fontSize="10" fontFamily="IBM Plex Mono, monospace">{Math.floor(si/60)}:{p2(si%60)}</text>}
    </g>);
  }
  return(
    <div onPointerDown={onScrub} style={{width:widthPx,height:32,cursor:"text",flexShrink:0,position:"relative"}}>
      <svg width={widthPx} height={32} style={{display:"block"}}>
        <rect x={0} y={0} width={widthPx} height={32} fill="#14151a"/>
        <line x1={0} x2={widthPx} y1={30} y2={30} stroke="#2c2f3b" strokeWidth={1}/>
        {ticks}
      </svg>
    </div>
  );
}

function FadeBadge({state}){
  if(state==="none"||!state)return null;
  const map={
    pending:{icon:"F",bg:"rgba(255,255,255,0.16)",color:"#fff",title:"Fade queued",spin:false},
    processing:{icon:"⟳",bg:"rgba(255,180,84,0.25)",color:"#ffb454",title:"Rendering fade with ffmpeg.wasm…",spin:true},
    done:{icon:"✓",bg:"rgba(70,217,192,0.25)",color:"#46d9c0",title:"Fade rendered",spin:false},
    error:{icon:"!",bg:"rgba(255,107,107,0.28)",color:"#ff6b6b",title:"Fade render failed — playing unfaded audio",spin:false},
  }[state];
  if(!map)return null;
  return(
    <div title={map.title} style={{position:"absolute",top:4,right:4,width:15,height:15,borderRadius:4,
      background:map.bg,color:map.color,fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",
      fontFamily:"IBM Plex Mono, monospace",pointerEvents:"none"}}>
      <span className={map.spin?"tled-spinner":""} style={{display:"inline-block"}}>{map.icon}</span>
    </div>
  );
}

function Cp({track:t,pps,selected,dragging,onPointerDown}){
  const w=(t.duration/FPS)*pps,x=(t.start/FPS)*pps,barCount=Math.max(0,Math.floor(w/5));
  const bars=useMemo(()=>sb(t.seed,barCount),[t.seed,barCount]);
  const durSec=(t.duration/FPS).toFixed(1);
  const fadeInPx=cl((t.fadeIn||0)*pps,0,w/2);
  const fadeOutPx=cl((t.fadeOut||0)*pps,0,w/2);
  return(
    <div className={`tled-clip${dragging?" dragging":""}${t.muted?" muted":""}`} onPointerDown={e=>onPointerDown(e,t.id)}
      style={{position:"absolute",left:x,top:(LH-CH)/2,width:w,height:CH,borderRadius:8,cursor:dragging?"grabbing":"grab",
        background:`linear-gradient(180deg, ${t.color} 0%, ${t.colorDark} 100%)`,
        border:selected?"1.6px solid #ffb454":`1.2px solid ${t.colorDark}`,
        boxShadow:selected?"0 0 0 3px rgba(255,180,84,0.18), 0 4px 14px rgba(0,0,0,0.4)":"0 3px 12px rgba(0,0,0,0.35)",
        userSelect:"none",overflow:"hidden"}}>
      <div style={{position:"absolute",top:1,left:1,right:1,height:"38%",borderRadius:"6px 6px 0 0",background:"rgba(255,255,255,0.16)",pointerEvents:"none"}}/>
      <div style={{position:"absolute",left:8,right:8,bottom:5,height:16,display:"flex",alignItems:"flex-end",gap:2,pointerEvents:"none"}}>
        {bars.map((h,i)=><div key={i} style={{width:2,height:`${h}%`,background:"rgba(255,255,255,0.32)",borderRadius:1}}/>)}
      </div>
      {fadeInPx>0&&(
        <svg width={fadeInPx} height={CH} style={{position:"absolute",left:0,top:0,pointerEvents:"none"}}>
          <polygon points={`0,0 ${fadeInPx},0 0,${CH}`} fill="rgba(10,11,15,0.45)"/>
          <line x1={0} y1={CH} x2={fadeInPx} y2={0} stroke="rgba(255,255,255,0.6)" strokeWidth={1.2}/>
        </svg>
      )}
      {fadeOutPx>0&&(
        <svg width={fadeOutPx} height={CH} style={{position:"absolute",right:0,top:0,pointerEvents:"none"}}>
          <polygon points={`${fadeOutPx},0 0,0 ${fadeOutPx},${CH}`} fill="rgba(10,11,15,0.45)"/>
          <line x1={0} y1={0} x2={fadeOutPx} y2={CH} stroke="rgba(255,255,255,0.6)" strokeWidth={1.2}/>
        </svg>
      )}
      <FadeBadge state={t.fadeState}/>
      <div style={{position:"relative",padding:"6px 9px 0",display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:6}}>
        <span style={{color:"rgba(255,255,255,0.95)",fontSize:12,fontWeight:700,fontFamily:"Manrope, sans-serif",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
          {!t.hasAudio&&<span title="Audio file not found in loaded folder" style={{color:"#ff6b6b",marginRight:4}}>⚠</span>}
          {t.name}
        </span>
        {w>70&&<span style={{color:"rgba(255,255,255,0.75)",fontSize:9.5,fontFamily:"IBM Plex Mono, monospace",flexShrink:0}}>{durSec}s</span>}
      </div>
    </div>
  );
}



export default function TimelineEditor(){
  const[tracks,setTracks]=useState(TI);
  const[zoom,setZoom]=useState(1.5);
  const[playhead,setPlayhead]=useState(0);
  const[playing,setPlaying]=useState(false);
  const[selected,setSelected]=useState("alpha");
  const[draggingId,setDraggingId]=useState(null);
  const[snapGuide,setSnapGuide]=useState(null);
  const[toast,setToast]=useState(null);
  const[totalSeconds,setTotalSeconds]=useState(MS);
  const[projectName,setProjectName]=useState(null);
  const[ffmpegBusy,setFfmpegBusy]=useState(false);

  // ---- AI agent panel state ----

  
  const[sourceJson,setSourceJson]=useState(null); // <-- the source of truth, agent + editor both read/write this
  const audioMapRef=useRef(new Map());            // norm(filename) -> File, persists across imports
  const applyingRef=useRef(false);                // guards tracks->json->tracks feedback loop
   
  const pps=BP*zoom,totalFrames=totalSeconds*FPS,timelineWidth=totalSeconds*pps;

  const tracksRef=useRef(tracks);tracksRef.current=tracks;
  const ppsRef=useRef(pps);ppsRef.current=pps;
  const playheadRef=useRef(playhead);playheadRef.current=playhead;
  const totalSecondsRef=useRef(totalSeconds);totalSecondsRef.current=totalSeconds;
  const totalFramesRef=useRef(totalFrames);totalFramesRef.current=totalFrames;

  const laneWrapRef=useRef(null),scrollRef=useRef(null),toastTimer=useRef(null);

  // real audio: trackId -> HTMLAudioElement, plus a set of object URLs to revoke on teardown
  const audioElsRef=useRef({});
  const objectUrlsRef=useRef(new Set());
  const loadGenRef=useRef(0); // bumped on every reset/reload so stale fade renders can be discarded
  const wsRef=useRef(null);
  const wsReconnectTimer=useRef(null);
  const[wsStatus,setWsStatus]=useState("disconnected"); // "disconnected" | "connecting" | "connected"


  const flash=(msg,dur)=>{setToast(msg);clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(null),dur)};

  const ensureRoomFor=useCallback(frame=>{
    const needed=frame+EB*FPS;
    if(needed<=totalFramesRef.current)return;
    const ns=Math.ceil(needed/FPS/GS)*GS;
    if(ns>totalSecondsRef.current){
      totalSecondsRef.current=ns;totalFramesRef.current=ns*FPS;setTotalSeconds(ns);
      flash(`Timeline extended to ${ns}s`,1400);
    }
  },[]);

  const autoScrollToward=useCallback(clientX=>{
    const el=scrollRef.current;if(!el)return;
    const r=el.getBoundingClientRect();
    if(clientX>r.right-AE)el.scrollLeft+=AS;
    else if(clientX<r.left+AE)el.scrollLeft-=AS;
  },[]);

  const pauseAllAudio=useCallback(()=>{
    Object.values(audioElsRef.current).forEach(a=>{if(!a.paused)a.pause()});
  },[]);

  const teardownAudio=useCallback(()=>{
    Object.values(audioElsRef.current).forEach(a=>{a.pause();a.src=""});
    audioElsRef.current={};
    objectUrlsRef.current.forEach(u=>URL.revokeObjectURL(u));
    objectUrlsRef.current=new Set();
  },[]);

  useEffect(()=>()=>teardownAudio(),[teardownAudio]);
  

const wsSend=useCallback(payload=>{
  const ws=wsRef.current;
  if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({id:WS_ID,...payload}));
},[]);

  // keep each track's Audio element in sync with the given frame; starts/stops/seeks as needed
  const syncAudioToFrame=useCallback(frame=>{
    Object.values(tracksRef.current).forEach(t=>{
      const audio=audioElsRef.current[t.id];
      if(!audio)return;
      const inRange=frame>=t.start&&frame<t.start+t.duration;
      audio.muted=!!t.muted;
      if(inRange&&!t.muted){
        const target=(frame-t.start)/FPS;
        if(audio.paused){
          audio.currentTime=target;
          audio.play().catch(()=>{});
        }else if(Math.abs(audio.currentTime-target)>DRIFT_TOL){
          audio.currentTime=target;
        }
      }else if(!audio.paused){
        audio.pause();
      }
    });
  },[]);

  useEffect(()=>{
    if(!playing){pauseAllAudio();return}
    let raf,lastTs=null;
    const tick=ts=>{
      if(lastTs==null)lastTs=ts;
      const dt=(ts-lastTs)/1000;lastTs=ts;
      setPlayhead(f=>{
        const next=f+dt*FPS;
        if(next>=totalFramesRef.current){setPlaying(false);return totalFramesRef.current}
        syncAudioToFrame(next);
        return next;
      });
      raf=requestAnimationFrame(tick);
    };
    syncAudioToFrame(playheadRef.current);
    raf=requestAnimationFrame(tick);
    return()=>cancelAnimationFrame(raf);
  },[playing,syncAudioToFrame,pauseAllAudio]);

  // if mute is toggled mid-playback, react immediately
  useEffect(()=>{
    if(playing)syncAudioToFrame(playheadRef.current);
  },[tracks,playing,syncAudioToFrame]);
  useEffect(()=>{
  wsSend({type:"tracks",tracks});
},[tracks,wsSend]);
useEffect(()=>{
    if(applyingRef.current){applyingRef.current=false;return}
    if(Object.keys(tracks).length===0)return;
    setSourceJson(tracksToEntries(tracks));
  },[tracks]);
  // render fade-in/out for every track that needs it, via ffmpeg.wasm, one at a time.
  // swaps the track's Audio element source in place once each render finishes.
  const runFades=useCallback(async(ids,snapshot,gen)=>{
    if(ids.length===0)return;
    setFfmpegBusy(true);
    flash("Loading ffmpeg.wasm…",60000);
    try{
      const ffmpeg=await getFFmpeg();
      if(loadGenRef.current!==gen)return; // a new project was loaded while we were loading ffmpeg
      for(let i=0;i<ids.length;i++){
        if(loadGenRef.current!==gen)return;
        const id=ids[i],t=snapshot[id];
        if(!t?.file)continue;
        setTracks(prev=>prev[id]?{...prev,[id]:{...prev[id],fadeState:"processing"}}:prev);
        flash(`Rendering fade ${i+1}/${ids.length} — ${t.name}`,60000);
        try{
          const clipDurSec=t.duration/FPS;
          const url=await renderProcessedAudio(ffmpeg,t.file,{loop:t.loop,fadeInSec:t.fadeIn,fadeOutSec:t.fadeOut,clipDurSec});
          if(loadGenRef.current!==gen){URL.revokeObjectURL(url);return}
          const oldAudio=audioElsRef.current[id];
          const oldUrl=oldAudio?.src;
          const audio=new Audio(url);
          audio.preload="auto";
          audio.muted=!!tracksRef.current[id]?.muted;
          audioElsRef.current[id]=audio;
          objectUrlsRef.current.add(url);
          if(oldAudio){oldAudio.pause();oldAudio.src=""}
          if(oldUrl&&objectUrlsRef.current.has(oldUrl)){URL.revokeObjectURL(oldUrl);objectUrlsRef.current.delete(oldUrl)}
          setTracks(prev=>prev[id]?{...prev,[id]:{...prev[id],url,fadeState:"done"}}:prev);
          if(playing)syncAudioToFrame(playheadRef.current);
        }catch(err){
          console.error("fade render failed for",t.name,err);
          if(loadGenRef.current===gen)setTracks(prev=>prev[id]?{...prev,[id]:{...prev[id],fadeState:"error"}}:prev);
        }
      }
      if(loadGenRef.current===gen)flash("Fades rendered ✓",1800);
    }catch(err){
      console.error("ffmpeg.wasm failed to load",err);
      if(loadGenRef.current===gen){
        setTracks(prev=>{
          const next={...prev};
          ids.forEach(id=>{if(next[id])next[id]={...next[id],fadeState:"error"}});
          return next;
        });
        flash("Couldn't load ffmpeg.wasm (network/CDN blocked?) — playing unfaded audio",4200);
      }
    }finally{
      if(loadGenRef.current===gen)setFfmpegBusy(false);
    }
  },[playing,syncAudioToFrame]);

  const exportMix=useCallback(async()=>{
  const active=Object.values(tracksRef.current).filter(t=>t.file&&!t.muted);
  if(active.length===0){flash("No audible tracks to export",2200);return}
  setFfmpegBusy(true);
  flash("Loading ffmpeg.wasm…",60000);
  try{
    const ffmpeg=await getFFmpeg();
    const{fetchFile}=await import("@ffmpeg/util");
    const inputs=[],filters=[];
    for(let i=0;i<active.length;i++){
    const t=active[i],inName=`exp_${i}${extOf(t.file.name)}`;
    await ffmpeg.writeFile(inName,await fetchFile(t.file));
    if(t.loop)inputs.push("-stream_loop","-1");
    inputs.push("-i",inName);
    const durSec=t.duration/FPS,delayMs=Math.round((t.start/FPS)*1000);
    const af=[`atrim=0:${durSec.toFixed(2)}`,"asetpts=PTS-STARTPTS"]; // this atrim already caps the infinite loop
      if(t.fadeIn>0)af.push(`afade=t=in:st=0:d=${t.fadeIn.toFixed(2)}`);
      if(t.fadeOut>0)af.push(`afade=t=out:st=${Math.max(0,durSec-t.fadeOut).toFixed(2)}:d=${t.fadeOut.toFixed(2)}`);
      af.push(`adelay=${delayMs}|${delayMs}`);
      filters.push(`[${i}:a]${af.join(",")}[a${i}]`);
    }
    const mixInputs=active.map((_,i)=>`[a${i}]`).join("");
    filters.push(`${mixInputs}amix=inputs=${active.length}:duration=longest:normalize=0[out]`);
    const outName="export_mix.wav";
    await ffmpeg.exec([...inputs,"-filter_complex",filters.join(";"),"-map","[out]",outName]);
    const data=await ffmpeg.readFile(outName);
    for(let i=0;i<active.length;i++){try{await ffmpeg.deleteFile(`exp_${i}${extOf(active[i].file.name)}`)}catch{}}
    try{await ffmpeg.deleteFile(outName)}catch{}
    const url=URL.createObjectURL(new Blob([data.buffer],{type:"audio/wav"}));
    const a=document.createElement("a");
    a.href=url;a.download=(projectName?projectName.replace(/\.json$/i,""):"timeline_export")+".wav";
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),4000);
    flash("Exported mixed audio ✓",2400);
  }catch(err){
    console.error("export failed",err);
    flash("Export failed — see console",3000);
  }finally{
    setFfmpegBusy(false);
  }
},[projectName]);

const applyFade=useCallback(async(kind)=>{ // kind: "in" | "out"
  const id=selected;
  if(!id)return;
  const t=tracksRef.current[id];
  if(!t)return;
  if(!t.file){flash("No audio file loaded for this track",2200);return}

  const clipDurSec=t.duration/FPS;
  let fadeIn=t.fadeIn||0,fadeOut=t.fadeOut||0;
  // toggle: click again on the same button to remove that fade
  if(kind==="in")fadeIn=fadeIn>0?0:FADE_DEFAULT;
  else fadeOut=fadeOut>0?0:FADE_DEFAULT;

  // same 90%-of-duration clamp tfp() uses on import
  if(fadeIn+fadeOut>clipDurSec*.9&&fadeIn+fadeOut>0){
    const scale=(clipDurSec*.9)/(fadeIn+fadeOut);
    fadeIn*=scale;fadeOut*=scale;
  }

  const needsFade=fadeIn>0||fadeOut>0;
  // this line alone makes the triangle overlay appear/disappear immediately
  setTracks(prev=>prev[id]?{...prev,[id]:{...prev[id],fadeIn,fadeOut,fadeState:needsFade?"pending":"none"}}:prev);

  if(!needsFade){
    // both fades removed - restore the original unfaded audio
    const oldAudio=audioElsRef.current[id];
    const origUrl=URL.createObjectURL(t.file);
    const audio=new Audio(origUrl);
    audio.preload="auto";
    audio.muted=!!t.muted;
    audioElsRef.current[id]=audio;
    objectUrlsRef.current.add(origUrl);
    if(oldAudio){
      oldAudio.pause();
      if(oldAudio.src&&objectUrlsRef.current.has(oldAudio.src)){URL.revokeObjectURL(oldAudio.src);objectUrlsRef.current.delete(oldAudio.src)}
      oldAudio.src="";
    }
    if(playing)syncAudioToFrame(playheadRef.current);
    return;
  }

  const gen=loadGenRef.current;
  setFfmpegBusy(true);
  flash("Loading ffmpeg.wasm…",60000);
  try{
    const ffmpeg=await getFFmpeg();
    if(loadGenRef.current!==gen)return;
    setTracks(prev=>prev[id]?{...prev,[id]:{...prev[id],fadeState:"processing"}}:prev);
    flash(`Rendering fade — ${t.name}`,60000);
    const url=await renderProcessedAudio(ffmpeg,t.file,{loop:t.loop,fadeInSec:t.fadeIn,fadeOutSec:t.fadeOut,clipDurSec});
    if(loadGenRef.current!==gen){URL.revokeObjectURL(url);return}
    const oldAudio=audioElsRef.current[id];
    const oldUrl=oldAudio?.src;
    const audio=new Audio(url);
    audio.preload="auto";
    audio.muted=!!tracksRef.current[id]?.muted;
    audioElsRef.current[id]=audio;
    objectUrlsRef.current.add(url);
    if(oldAudio){oldAudio.pause();oldAudio.src=""}
    if(oldUrl&&objectUrlsRef.current.has(oldUrl)){URL.revokeObjectURL(oldUrl);objectUrlsRef.current.delete(oldUrl)}
    setTracks(prev=>prev[id]?{...prev,[id]:{...prev[id],url,fadeState:"done"}}:prev);
    if(playing)syncAudioToFrame(playheadRef.current);
    flash("Fade rendered ✓",1800);
  }catch(err){
    console.error("fade render failed",err);
    if(loadGenRef.current===gen){
      setTracks(prev=>prev[id]?{...prev,[id]:{...prev[id],fadeState:"error"}}:prev);
      flash("Couldn't render fade (network/CDN blocked?)",3200);
    }
  }finally{
    if(loadGenRef.current===gen)setFfmpegBusy(false);
  }
},[selected,playing,syncAudioToFrame]);

  const handleClipPointerDown=useCallback((e,trackId)=>{
    if(e.button!==0)return;
    e.preventDefault();e.stopPropagation();
    setSelected(trackId);setDraggingId(trackId);

    const startClientX=e.clientX,startFrame=tracksRef.current[trackId].start,duration=tracksRef.current[trackId].duration;
    const audio=audioElsRef.current[trackId];
    if(audio&&!audio.paused)audio.pause();

    const onMove=ev=>{
      autoScrollToward(ev.clientX);
      const dxFrames=((ev.clientX-startClientX)/ppsRef.current)*FPS,rawNext=startFrame+dxFrames;
      if(rawNext>0)ensureRoomFor(rawNext+duration);
      let next=cl(rawNext,0,totalFramesRef.current-duration);
      const tol=(SP/ppsRef.current)*FPS;
      const candidates=[0,totalFramesRef.current-duration,playheadRef.current,playheadRef.current-duration];
      Object.values(tracksRef.current).forEach(o=>{
        if(o.id===trackId)return;
        candidates.push(o.start,o.start-duration,o.start+o.duration,o.start+o.duration-duration);
      });
      let snapped=null;
      for(const c of candidates){
        const cc=cl(c,0,totalFramesRef.current-duration);
        if(Math.abs(cc-next)<=tol){snapped=cc;break}
      }
      if(snapped!=null){next=snapped;setSnapGuide(snapped)}else setSnapGuide(null);
      setTracks(prev=>({...prev,[trackId]:{...prev[trackId],start:Math.round(next)}}));
    };
    const onUp=()=>{
      setDraggingId(null);setSnapGuide(null);
      if(playing)syncAudioToFrame(playheadRef.current);
      window.removeEventListener("pointermove",onMove);
      window.removeEventListener("pointerup",onUp);
      window.removeEventListener("pointercancel",onUp);
    };
    window.addEventListener("pointermove",onMove);
    window.addEventListener("pointerup",onUp);
    window.addEventListener("pointercancel",onUp);
  },[playing,syncAudioToFrame]);

  const handleScrub=useCallback(e=>{
    if(e.button!==0)return;
    setPlaying(false);
    const update=clientX=>{
      const rect=laneWrapRef.current.getBoundingClientRect();
      const raw=((clientX-rect.left)/ppsRef.current)*FPS;
      if(raw>0)ensureRoomFor(raw);
      const next=cl(raw,0,totalFramesRef.current);
      setPlayhead(next);
    };
    update(e.clientX);
    const onMove=ev=>{autoScrollToward(ev.clientX);update(ev.clientX)};
    const onUp=()=>{
      window.removeEventListener("pointermove",onMove);
      window.removeEventListener("pointerup",onUp);
      window.removeEventListener("pointercancel",onUp);
    };
    window.addEventListener("pointermove",onMove);
    window.addEventListener("pointerup",onUp);
    window.addEventListener("pointercancel",onUp);
  },[]);

  const handleKeyDown=useCallback(e=>{
    if(!["ArrowLeft","ArrowRight"].includes(e.key))return;
    if(!selected)return;
    e.preventDefault();
    const step=e.shiftKey?10:1,dir=e.key==="ArrowLeft"?-1:1;
    setTracks(prev=>{
      const t=prev[selected];if(!t)return prev;
      const next=cl(t.start+dir*step,0,totalFramesRef.current-t.duration);
      return{...prev,[selected]:{...t,start:Math.round(next)}};
    });
  },[selected]);

  const resetAll=()=>{
    loadGenRef.current+=1;
    teardownAudio();
    setTracks({});setPlayhead(0);setPlaying(false);setSelected(null);setTotalSeconds(MS);setProjectName(null);setFfmpegBusy(false);
  };

  const toggleMute=id=>setTracks(prev=>({...prev,[id]:{...prev[id],muted:!prev[id].muted}}));

    const saveJson=()=>{
    const data=sourceJson||tracksToEntries(tracks);
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download=projectName||"project.json";document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
    flash(`Saved ${projectName||"project.json"}`,2000);
  };

  const folderInputRef=useRef(null);
  const openFolderPicker=()=>folderInputRef.current?.click();

  const handleFolderChange=async e=>{
    const fileList=Array.from(e.target.files||[]);
    e.target.value="";
    if(fileList.length===0)return;

    const jsonFiles=fileList.filter(f=>/\.json$/i.test(f.name));
    if(jsonFiles.length===0){flash("No .json file found in that folder",2600);return}
    const jsonFile=jsonFiles.find(f=>/project|timeline|manifest/i.test(f.name))||jsonFiles[0];

    let parsed;
    try{parsed=JSON.parse(await jsonFile.text())}
    catch{flash(`Couldn't parse ${jsonFile.name} — is it valid JSON?`,2600);return}

    const entries=Array.isArray(parsed)?parsed:parsed?.clips||parsed?.entries;
    if(!Array.isArray(entries)){flash("Expected a JSON array of sound entries",2600);return}

    const audioMap=new Map();
    fileList.forEach(f=>{if(AUDIO_EXT.test(f.name))audioMap.set(norm(f.name),f)});
    audioMapRef.current=audioMap;

    const result=applyEntries(entries,{sourceName:jsonFile.name});
    if(!result)return;
    const{skipped,missing,fadeCount,count}=result;

    const notes=[];
    if(skipped)notes.push(`${skipped} entr${skipped===1?"y":"ies"} skipped`);
    if(missing)notes.push(`${missing} audio file${missing===1?"":"s"} not found`);
    if(fadeCount)notes.push(`${fadeCount} fade${fadeCount===1?"":"s"} rendering…`);
    const note=notes.length?` (${notes.join(", ")})`:"";
    flash(`Loaded ${count} clip${count===1?"":"s"} from ${jsonFile.webkitRelativePath?.split("/")[0]||"folder"}${note}`,2800);
  };
const singleAudioInputRef=useRef(null);
  const openSingleAudioPicker=()=>singleAudioInputRef.current?.click();

  const handleSingleAudioChange=e=>{
    const file=e.target.files&&e.target.files[0];
    e.target.value="";
    if(!file)return;
    if(!AUDIO_EXT.test(file.name)){flash("Not a recognized audio file",2200);return}

    audioMapRef.current.set(norm(file.name),file);

    const startFrame=Math.round(playheadRef.current);
    const id=`manual-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const idx=Object.keys(tracksRef.current).length;
    const[c,d]=PL[idx%PL.length];
    const url=URL.createObjectURL(file);
    objectUrlsRef.current.add(url);

    const audio=new Audio(url);
    audio.preload="auto";

    audio.onloadedmetadata=()=>{
      const durSec=Number.isFinite(audio.duration)&&audio.duration>0?audio.duration:5;
      const duration=Math.max(1,Math.round(durSec*FPS));
      ensureRoomFor(startFrame+duration);
      audioElsRef.current[id]=audio;
      const newTrack={id,label:"AUDIO",name:file.name,color:c,colorDark:d,
        start:startFrame,duration,seed:hs(file.name||id),
        muted:false,url,hasAudio:true,file,
        fadeIn:0,fadeOut:0,loop:false,fadeState:"none"};
      setTracks(prev=>({...prev,[id]:newTrack}));
      setSelected(id);
      flash(`Added ${file.name}`,1800);
    };
    audio.onerror=()=>{
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(url);
      flash(`Couldn't read ${file.name}`,2400);
    };
  };

  const applyEntries=useCallback((entries,{sourceName}={})=>{
    const{tracks:newTracks,skipped,missing}=tfp(entries,audioMapRef.current),ids=Object.keys(newTracks);
    if(ids.length===0){flash("No usable entries in JSON",2400);return null}

    const gen=loadGenRef.current+1;loadGenRef.current=gen;
    teardownAudio();
    const newAudioEls={},newUrls=new Set();
    ids.forEach(id=>{
      const t=newTracks[id];
      if(t.url){
        const audio=new Audio(t.url);
        audio.preload="auto";
        newAudioEls[id]=audio;
        newUrls.add(t.url);
      }
    });
    audioElsRef.current=newAudioEls;
    objectUrlsRef.current=newUrls;

    const maxEndFrame=Math.max(...ids.map(id=>newTracks[id].start+newTracks[id].duration));
    const fitSeconds=Math.max(MS,Math.ceil((maxEndFrame/FPS+EB)/GS)*GS);

    applyingRef.current=true;
    setTracks(newTracks);
    setPlayhead(0);setPlaying(false);setSelected(ids[0]);setTotalSeconds(fitSeconds);
    if(sourceName)setProjectName(sourceName);
    totalSecondsRef.current=fitSeconds;totalFramesRef.current=fitSeconds*FPS;
    setSourceJson(entries);

    const fadeIds=ids.filter(id=>newTracks[id].fadeState==="pending");
    if(fadeIds.length)runFades(fadeIds,newTracks,gen);

    return{skipped,missing,fadeCount:fadeIds.length,count:ids.length};
  },[teardownAudio,runFades]);
    const agent = useAgent({ audioMapRef, applyEntries, flash, sourceJson});



  const anyMissing=useMemo(()=>Object.values(tracks).some(t=>!t.hasAudio),[tracks]);
  const playheadX=(playhead/FPS)*pps,snapGuideX=snapGuide!=null?(snapGuide/FPS)*pps:null;
  const trackList=Object.values(tracks);

  return(
    <div tabIndex={0} onKeyDown={handleKeyDown}
      style={{width:"100%",maxWidth:4000,height:"100%",minHeight:"100vh",background:"#121319",
        fontFamily:"Manrope, sans-serif",outline:"none",overflow:"hidden"}}>
      <style>{GLOBAL_RESET}</style>    
      <style>{CSS}</style>

      <div style={{display:"flex",alignItems:"center",gap:16,padding:"14px 18px",background:"#181a21",borderBottom:"1px solid #23262f",flexWrap:"wrap",rowGap:10}}>
        <button className="tled-btn-play" onClick={()=>setPlaying(p=>!p)} disabled={trackList.length===0||ffmpegBusy} title={playing?"Pause":"Play"}>{playing?"❚❚":"▶"}</button>
        <div>
          <div style={{fontSize:15,fontWeight:800,color:"#f2f3f7",letterSpacing:-.2,display:"flex",alignItems:"center",gap:8}}>
            Timeline Editor
            {ffmpegBusy&&<span style={{fontSize:10,fontWeight:700,color:"#ffb454",background:"rgba(255,180,84,0.12)",border:"1px solid rgba(255,180,84,0.35)",borderRadius:5,padding:"2px 6px",display:"flex",alignItems:"center",gap:4}}>
              <span className="tled-spinner" style={{display:"inline-block"}}>⟳</span> ffmpeg
            </span>}
          </div>
          <div style={{fontSize:11,color:"#6b7182",marginTop:1}}>Drag, scrub, snap — frame accurate</div>
        </div>
        <div style={{marginLeft:"auto",fontFamily:"IBM Plex Mono, monospace",fontSize:24,fontWeight:700,color:"#ffb454",
          letterSpacing:2,textShadow:"0 0 18px rgba(255,180,84,0.35)",background:"#1a1d24",border:"1px solid #2c2f3b",
          borderRadius:8,padding:"4px 14px",animation:playing?"tled-pulse 1.4s ease-in-out infinite":"none"}}>{tc(playhead)}</div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <button className="tled-btn" onClick={()=>setZoom(z=>cl(+(z-.25).toFixed(2),ZN,ZX))}>–</button>
          <input className="tled-range" type="range" min={ZN} max={ZX} step={.1} value={zoom} onChange={e=>setZoom(parseFloat(e.target.value))}/>
          <button className="tled-btn" onClick={()=>setZoom(z=>cl(+(z+.25).toFixed(2),ZN,ZX))}>+</button>
          <span style={{fontSize:11,color:"#868da3",fontFamily:"IBM Plex Mono, monospace",width:38}}>{Math.round(zoom*100)}%</span>
        </div>
        <button className="tled-btn" onClick={resetAll}>New</button>
        <input ref={folderInputRef} type="file" webkitdirectory="" directory="" multiple onChange={handleFolderChange} style={{display:"none"}}/>
        <input ref={singleAudioInputRef} type="file" accept="audio/*" onChange={handleSingleAudioChange} style={{display:"none"}}/>
        <button className="tled-btn" onClick={openFolderPicker} disabled={ffmpegBusy}>Load Folder</button>
        <button className="tled-btn" onClick={openSingleAudioPicker} disabled={ffmpegBusy} title="Add a single audio file at the playhead">+</button>
        <button className="tled-btn" style={{background:"#ffb454",color:"#201404",border:"1px solid #ffb454"}} onClick={saveJson} disabled={trackList.length===0}>Save JSON</button>
        <button className="tled-btn" onClick={exportMix} disabled={trackList.length===0||ffmpegBusy}>Export Mix</button>
        <button className="tled-btn" style={agent.agentOpen? {background:"#7c93ff",color:"#12141c",border:"1px solid #7c93ff"}:undefined} onClick={()=>agent.setAgentOpen(o=>!o)}>
          AI Agent
        </button>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 18px",background:"#181a21",borderBottom:"1px solid #23262f"}}>
        <button className="tled-btn" onClick={()=>applyFade("in")} disabled={!selected||ffmpegBusy}>Fade In</button>
        <button className="tled-btn" onClick={()=>applyFade("out")} disabled={!selected||ffmpegBusy}>Fade Out</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:`${HW}px 1fr`}}>
        <div style={{borderRight:"1px solid #23262f",paddingTop:16,paddingLeft:18,paddingRight:10,paddingBottom:6,minWidth:0,overflow:"hidden"}}>
          <div style={{height:32}}/>
          {trackList.map(t=>(
            <div key={t.id} style={{height:LH,marginBottom:10,display:"flex",alignItems:"center",gap:8}}>
              <span style={{width:9,height:9,borderRadius:"50%",background:t.color,flexShrink:0}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:10.5,fontWeight:700,color:"#868da3",letterSpacing:.6,display:"flex",gap:6}}>
                  <span>{t.label}</span>
                  {(t.fadeIn>0||t.fadeOut>0)&&
                    <span style={{color:"#ffb454"}} title={`Fade in ${t.fadeIn.toFixed(1)}s · Fade out ${t.fadeOut.toFixed(1)}s`}>
                      {t.fadeIn>0?"↗":""}{t.fadeOut>0?"↘":""}
                    </span>}
                </div>
                <div style={{fontSize:12,fontWeight:600,color:"#dfe2ea",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.name}</div>
              </div>
              <button className={`tled-icon-btn${t.muted?" active":""}`} title={t.muted?"Unmute track":"Mute track"} onClick={()=>toggleMute(t.id)}>M</button>
            </div>
          ))}
        </div>

        <div ref={scrollRef} className="tled-scroll" style={{overflowX:"auto",paddingTop:16,paddingRight:18,paddingBottom:6,minWidth:0}}>
          <div ref={laneWrapRef} style={{position:"relative",width:timelineWidth}}>
            <Rl pps={pps} widthPx={timelineWidth} totalSeconds={totalSeconds} onScrub={handleScrub}/>
            <div style={{position:"absolute",left:playheadX-4,top:0,width:8,height:8,background:"#ffb454",clipPath:"polygon(0 0, 100% 0, 50% 100%)",pointerEvents:"none"}}/>

            {trackList.length===0?(
              <div style={{width:Math.max(timelineWidth,360),height:LH*2+10,border:"1px dashed #2c2f3b",borderRadius:10,
                display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10}}>
                <span style={{color:"#5a6178",fontSize:12.5}}>No project loaded</span>
                <span style={{color:"#3f4557",fontSize:11}}>Pick a folder containing a project JSON and its audio files</span>
                <button className="tled-btn" onClick={openFolderPicker}>Load Folder</button>
              </div>
            ):trackList.map(t=>(
              <div key={t.id} style={{position:"relative",width:timelineWidth,height:LH,marginBottom:10,background:"#171920",border:"1px solid #23262f",borderRadius:8}}>
                <svg width={timelineWidth} height={LH} style={{position:"absolute",inset:0}}>
                  {Array.from({length:totalSeconds+1},(_,i)=>i).map(s=><line key={s} x1={s*pps} x2={s*pps} y1={0} y2={LH} stroke="rgba(255,255,255,0.045)"/>)}
                </svg>
                {snapGuideX!=null&&<div style={{position:"absolute",left:snapGuideX,top:0,bottom:0,width:0,borderLeft:"1.5px dashed #ffb454",opacity:.85,pointerEvents:"none"}}/>}
                <Cp track={t} pps={pps} selected={selected===t.id} dragging={draggingId===t.id} onPointerDown={handleClipPointerDown}/>
                <div style={{position:"absolute",left:playheadX,top:0,bottom:0,width:0,borderLeft:"1.5px solid rgba(255,180,84,0.55)",pointerEvents:"none"}}/>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 18px",background:"#14151a",
        borderTop:"1px solid #23262f",fontSize:11,color:"#6b7182",fontFamily:"IBM Plex Mono, monospace"}}>
        <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
          {trackList.length===0?"No project loaded — click Load Folder to import one":
            trackList.map(t=>`${t.name} ${tc(t.start)} \u2192 ${tc(t.start+t.duration)}`).join("   \u00b7   ")}
        </span>
        <span style={{color:anyMissing?"#ff6b6b":"#4a4f60",flexShrink:0,marginLeft:12}}>
          {anyMissing?"⚠ some audio files missing from folder":"← → nudge 1fr · shift+← → nudge 10fr · ↗↘ fade in/out"}
        </span>
      </div>

      <input ref={agent.soundsInputRef} type="file" webkitdirectory="" directory="" multiple
      onChange={agent.handleSoundsFolderChange} style={{display:"none"}}/>
<AgentPanel
        open={agent.agentOpen}
        onClose={()=>agent.setAgentOpen(false)}
        ollamaUrl={agent.ollamaUrl}
        setOllamaUrl={agent.setOllamaUrl}
        ollamaStatus={agent.ollamaStatus}
        onConnect={agent.connectOllama}
        ollamaModels={agent.ollamaModels}
        selectedModel={agent.selectedModel}
        setSelectedModel={agent.setSelectedModel}
        soundFiles={agent.soundFiles}
        onImportSounds={agent.openSoundsPicker}
        agentMessages={agent.agentMessages}
        agentInput={agent.agentInput}
        setAgentInput={agent.setAgentInput}
        onSend={agent.sendAgentMessage}
        agentBusy={agent.agentBusy}
        pendingCount={agent.pendingAgentTracks?agent.pendingAgentTracks.length:0}
        onApply={agent.applyPendingAgentTracks}
        onDiscardPending={()=>agent.setPendingAgentTracks(null)}
        hasExistingJson={agent.hasExistingJson}
      />

      {toast&&(
        <div className="tled-toast" style={{position:"fixed",bottom:22,right:agent.agentOpen?382:22,background:"#1f222b",border:"1px solid #2c2f3b",
          color:"#dfe2ea",fontSize:12.5,fontWeight:600,padding:"10px 16px",borderRadius:8,boxShadow:"0 10px 30px rgba(0,0,0,0.5)",
          fontFamily:"Manrope, sans-serif",transition:"right 180ms ease"}}>{toast}</div>
      )}
    </div>
  );
}