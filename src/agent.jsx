import React,{useState,useRef,useCallback}from"react";
import {
  getAgentIntent,
  INTENTS,
  CREATE_FROM_TRANSCRIPT_SYSTEM_MESSAGE,
  EDIT_SOURCE_JSON_SYSTEM_MESSAGE,
} from "./agentLogic";

const OLLAMA_BASE_DEFAULT="http://localhost:11434";

// resolves the real duration (seconds) of an audio File via a throwaway <audio> element
function getAudioDuration(file){
  return new Promise(resolve=>{
    const url=URL.createObjectURL(file);
    const a=new Audio();
    a.preload="metadata";
    const done=v=>{URL.revokeObjectURL(url);resolve(v)};
    a.onloadedmetadata=()=>done(Number.isFinite(a.duration)?a.duration:null);
    a.onerror=()=>done(null);
    a.src=url;
  });
}

// ---- AI Agent side panel ----
// Note: there is no chat history here by design. Every send is a single
// fresh request to Ollama — nothing about it is kept in React state or
// rendered back to the user beyond the pending-tracks preview.
function AgentPanel({
  open,onClose,ollamaUrl,setOllamaUrl,ollamaStatus,onConnect,
  ollamaModels,selectedModel,setSelectedModel,
  soundFiles,onImportSounds,hasExistingJson,
  agentInput,setAgentInput,onSend,agentBusy,
  pendingCount,pendingAgentTracksDebug,onApply,onDiscardPending,
}){
  if(!open)return null;
  const soundList=Object.values(soundFiles);
  const statusMap={
    connected:{dot:"#46d9c0",label:`Connected${selectedModel?` · ${selectedModel}`:""}`},
    checking:{dot:"#ffb454",label:"Connecting…"},
    error:{dot:"#ff6b6b",label:"Connection failed"},
    disconnected:{dot:"#4a4f60",label:"Not connected"},
  };
  const st=statusMap[ollamaStatus]||statusMap.disconnected;

  return(
    <div className="tled-panel" style={{position:"fixed",top:0,right:0,bottom:0,width:360,maxWidth:"92vw",
      background:"#15161c",borderLeft:"1px solid #23262f",display:"flex",flexDirection:"column",zIndex:30,
      boxShadow:"-14px 0 34px rgba(0,0,0,0.5)"}}>

      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 16px",borderBottom:"1px solid #23262f",flexShrink:0}}>
        <div>
          <div style={{fontSize:13.5,fontWeight:800,color:"#f2f3f7",fontFamily:"Manrope, sans-serif"}}>AI Agent</div>
          <div style={{fontSize:10.5,color:"#868da3",display:"flex",alignItems:"center",gap:5,marginTop:2}}>
            <span style={{width:6,height:6,borderRadius:"50%",background:st.dot,flexShrink:0}}/>
            {st.label}
          </div>
        </div>
        <button className="tled-icon-btn" onClick={onClose} title="Close panel" style={{width:24,height:24,fontSize:13}}>×</button>
      </div>

      <div style={{padding:"12px 16px",borderBottom:"1px solid #23262f",display:"flex",flexDirection:"column",gap:8,flexShrink:0}}>
        <div style={{display:"flex",gap:6}}>
          <input value={ollamaUrl} onChange={e=>setOllamaUrl(e.target.value)} placeholder="http://localhost:11434"
            style={{flex:1,minWidth:0,background:"#1a1d24",border:"1px solid #2c2f3b",borderRadius:6,padding:"7px 9px",
              fontSize:11,color:"#dfe2ea",fontFamily:"IBM Plex Mono, monospace",outline:"none"}}/>
          <button className="tled-btn" style={{padding:"6px 12px",fontSize:11.5}} onClick={onConnect} disabled={ollamaStatus==="checking"}>
            {ollamaStatus==="checking"?"…":"Connect"}
          </button>
        </div>
        {ollamaModels.length>0&&(
          <select value={selectedModel} onChange={e=>setSelectedModel(e.target.value)}
            style={{background:"#1a1d24",border:"1px solid #2c2f3b",borderRadius:6,padding:"7px 9px",
              fontSize:11.5,color:"#dfe2ea",fontFamily:"Manrope, sans-serif",outline:"none"}}>
            {ollamaModels.map(m=><option key={m} value={m}>{m}</option>)}
          </select>
        )}
      </div>
      <div style={{padding:"10px 16px",borderBottom:"1px solid #23262f",display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
        <span style={{width:6,height:6,borderRadius:"50%",flexShrink:0,
          background:hasExistingJson?"#46d9c0":"#4a4f60"}}/>
        <span style={{fontSize:10.5,color:"#868da3",fontFamily:"Manrope, sans-serif"}}>
          {hasExistingJson?"Timeline exists — edits will modify it":"No timeline yet — next message will create one"}
        </span>
      </div>
      <div style={{padding:"12px 16px",borderBottom:"1px solid #23262f",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
          <span style={{fontSize:10.5,fontWeight:700,color:"#868da3",letterSpacing:.5}}>SOUNDS POOL{soundList.length>0?` · ${soundList.length}`:""}</span>
          <button className="tled-btn" style={{padding:"4px 10px",fontSize:10.5}} onClick={onImportSounds}>Import Folder</button>
        </div>
        {soundList.length===0?(
          <div style={{fontSize:11,color:"#4a4f60",lineHeight:1.5}}>No sounds loaded. Import a folder of audio files for the agent to build a timeline from.</div>
        ):(
          <div className="tled-scroll" style={{maxHeight:118,overflowY:"auto",display:"flex",flexDirection:"column",gap:4,paddingRight:4}}>
            {soundList.map(s=>(
              <div key={s.name} style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:10.5,color:"#a6acbd",fontFamily:"IBM Plex Mono, monospace"}}>
                <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</span>
                <span style={{color:"#5a6178",flexShrink:0}}>{s.duration!=null?`${s.duration.toFixed(1)}s`:"—"}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* No chat log here on purpose — nothing is kept, so there's nothing to render.
          Just a bit of static help text and a busy indicator while a request is in flight. */}
      <div className="tled-scroll" style={{flex:1,overflowY:"auto",padding:"12px 16px",display:"flex",flexDirection:"column",gap:10,minHeight:0}}>
        <div style={{fontSize:11.5,color:"#4a4f60",lineHeight:1.55}}>
          Import a sounds folder, then ask the agent to build a timeline — e.g. "Here's the transcript, create a 30 second ambient scene using the loaded sounds." Once a timeline exists, describe an edit instead and it'll modify it in place.
        </div>
        {agentBusy&&(
          <div style={{fontSize:11,color:"#868da3",display:"flex",alignItems:"center",gap:6}}>
            <span className="tled-spinner" style={{display:"inline-block"}}>⟳</span> thinking…
          </div>
        )}
      </div>

      {pendingCount>0&&(
        <>
          {/* DEBUG: raw pending JSON, so you can see exactly what's about to be applied */}
          <pre className="tled-scroll" style={{margin:0,padding:"8px 16px",maxHeight:140,overflow:"auto",
            fontSize:10,lineHeight:1.4,color:"#a6acbd",fontFamily:"IBM Plex Mono, monospace",
            background:"#101218",borderTop:"1px solid #23262f",whiteSpace:"pre-wrap",wordBreak:"break-word"}}>
            {JSON.stringify(pendingAgentTracksDebug,null,2)}
          </pre>
          <div style={{padding:"10px 16px",borderTop:"1px solid #23262f",display:"flex",gap:8,flexShrink:0}}>
            <button className="tled-btn" style={{flex:1,background:"#ffb454",color:"#201404",border:"1px solid #ffb454",fontSize:12}} onClick={onApply}>
              Apply {pendingCount} clip{pendingCount===1?"":"s"} to Timeline
            </button>
            <button className="tled-btn" style={{fontSize:12}} onClick={onDiscardPending}>Discard</button>
          </div>
        </>
      )}

      <div style={{display:"flex",gap:8,padding:"12px 16px",borderTop:"1px solid #23262f",flexShrink:0}}>
        <textarea className="tled-agent-textarea" value={agentInput} onChange={e=>setAgentInput(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();onSend()}}}
          placeholder="Describe the timeline you want…" rows={2}
          style={{flex:1,resize:"none",background:"#1a1d24",border:"1px solid #2c2f3b",borderRadius:7,
            padding:"8px 10px",fontSize:12,color:"#dfe2ea",fontFamily:"Manrope, sans-serif",outline:"none"}}/>
        <button className="tled-btn" style={{alignSelf:"flex-end",fontSize:12}} onClick={onSend} disabled={agentBusy||!agentInput.trim()}>Send</button>
      </div>
    </div>
  );
}

// ---- Agent hook: owns all agent state + handlers, exposes them to App.jsx ----
export function useAgent({audioMapRef,applyEntries,flash,sourceJson
}){
  const[agentOpen,setAgentOpen]=useState(false);
  const[soundFiles,setSoundFiles]=useState({});
  const[agentInput,setAgentInput]=useState("");
  const[agentBusy,setAgentBusy]=useState(false);
  const[ollamaUrl,setOllamaUrl]=useState(OLLAMA_BASE_DEFAULT);
  const[ollamaStatus,setOllamaStatus]=useState("disconnected");
  const[ollamaModels,setOllamaModels]=useState([]);
  const[selectedModel,setSelectedModel]=useState("");
  const[pendingAgentTracks,setPendingAgentTracks]=useState(null);
  const soundsInputRef=useRef(null);

  const openSoundsPicker=()=>soundsInputRef.current?.click();

  const handleSoundsFolderChange=async e=>{
    const fileList=Array.from(e.target.files||[]);
    e.target.value="";
    const audioFiles=fileList.filter(f=>/\.(mp3|wav|ogg|m4a|aac|flac|webm|opus)$/i.test(f.name));
    if(audioFiles.length===0){flash("No audio files found in that folder",2400);return}

    flash(`Reading ${audioFiles.length} audio file${audioFiles.length===1?"":"s"}…`,60000);
    const withDurations=await Promise.all(audioFiles.map(async f=>{
      const duration=await getAudioDuration(f);
      return[f.name.split(/[\\/]/).pop().trim().toLowerCase(),{file:f,name:f.name,duration}];
    }));
    const map={};withDurations.forEach(([k,v])=>{map[k]=v});
    setSoundFiles(map);
    withDurations.forEach(([k,{file}])=>audioMapRef.current.set(k,file));
    setPendingAgentTracks(null);
    flash(`Loaded ${audioFiles.length} sound${audioFiles.length===1?"":"s"} for the AI agent`,2600);
    setAgentOpen(true);
  };

  // Just the bits Ollama needs to reason about the library — name + duration.
  const buildSoundCatalog=useCallback(()=>Object.values(soundFiles).map(sound=>({
    name:sound.name,
    duration:sound.duration,
  })),[soundFiles]);

  const connectOllama=useCallback(async()=>{
    setOllamaStatus("checking");
    try{
      const res=await fetch(`${ollamaUrl.replace(/\/$/,"")}/api/tags`);
      if(!res.ok)throw new Error(`HTTP ${res.status}`);
      const data=await res.json();
      const names=(data?.models||[]).map(m=>m.name).filter(Boolean);
      setOllamaModels(names);
      setSelectedModel(prev=>prev&&names.includes(prev)?prev:(names[0]||""));
      setOllamaStatus("connected");
      flash(names.length?`Connected — ${names.length} model${names.length===1?"":"s"} available`:"Connected — no models installed",2400);
    }catch(err){
      console.error("ollama connect failed",err);
      setOllamaStatus("error");
      flash("Couldn't reach Ollama — check the URL and that OLLAMA_ORIGINS allows this app",3600);
    }
  },[ollamaUrl,flash]);

  // No history is kept or sent — every request is built fresh:
  //   [system prompt]  ->  [one user message containing the sound catalog,
  //                         (for edits) the existing timeline JSON, and the
  //                         user's actual request — all invisible to the UI
  //                         except the request text itself]
  // Both create and edit requests get the sound catalog; edits additionally
  // get the current timeline JSON so the model has something to modify.
  const sendAgentMessage=useCallback(async()=>{
    const text=agentInput.trim();
    if(!text||agentBusy)return;

    if(ollamaStatus!=="connected"){
      flash("Not connected to Ollama yet. Enter its URL above and click Connect, then try again.",3200);
      return;
    }
    if(!selectedModel){
      flash("No Ollama model is selected. Install a model and select it above.",3200);
      return;
    }

    const intent=getAgentIntent(text,Boolean(sourceJson?.length));
    const isCreate=intent===INTENTS.CREATE_FROM_TRANSCRIPT;
    const systemMessage=isCreate?CREATE_FROM_TRANSCRIPT_SYSTEM_MESSAGE:EDIT_SOURCE_JSON_SYSTEM_MESSAGE;

    const messages=[{role:"system",content:systemMessage}];
    const catalogJson=JSON.stringify(buildSoundCatalog());

    if(isCreate){
      messages.push({
        role:"user",
        content:`SOUND LIBRARY (JSON):\n${catalogJson}\n\nTRANSCRIPT / REQUEST:\n${text}`,
      });
    }else{
      const existingJson=JSON.stringify(sourceJson);
      messages.push({
        role:"user",
        content:`SOUND LIBRARY (JSON):\n${catalogJson}\n\nEXISTING TIMELINE JSON:\n${existingJson}\n\nEDIT REQUEST:\n${text}`,
      });
    }

    setAgentInput("");
    setAgentBusy(true);

    // DEBUG: this is the exact payload Ollama will receive
    console.log("[agent] request payload:",JSON.stringify({model:selectedModel,messages,stream:false},null,2));
    console.log("[agent] messages array (raw objects):",messages);

    try{
      const baseUrl=ollamaUrl.replace(/\/+$/,"");
      const response=await fetch(`${baseUrl}/api/chat`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:selectedModel,messages,stream:false}),
      });

      if(!response.ok){
        const errorText=await response.text().catch(()=>"");
        throw new Error(`Ollama returned HTTP ${response.status}${errorText?`: ${errorText}`:""}`);
      }

      const data=await response.json();
      const assistantText=data?.message?.content?.trim();
      if(!assistantText)throw new Error("Ollama returned an empty response.");

      let parsedTracks;
      try{
        parsedTracks=JSON.parse(assistantText);
      }catch(err){
        throw new Error("Ollama returned invalid JSON.");
      }

      // DEBUG: inspect the raw text and parsed shape in the browser console
      console.log("[agent] raw assistant text:",assistantText);
      console.log("[agent] parsed tracks:",parsedTracks);

      setPendingAgentTracks(parsedTracks);
      const count=Array.isArray(parsedTracks)?parsedTracks.length:null;
      flash(count!=null?`Agent generated ${count} clip${count===1?"":"s"} — review and apply`:"Agent responded — review and apply",2800);
    }catch(err){
      console.error("ollama chat failed",err);
      flash(`Couldn't communicate with Ollama: ${err?.message||"Unknown error"}`,3600);
    }finally{
      setAgentBusy(false);
    }
  },[agentInput,agentBusy,ollamaUrl,ollamaStatus,selectedModel,buildSoundCatalog,sourceJson,flash]);

  const applyPendingAgentTracks=useCallback(()=>{
    if(!pendingAgentTracks)return;
    const result=applyEntries(pendingAgentTracks,{sourceName:"agent-timeline.json"});
    if(!result)return;
    setPendingAgentTracks(null);
    flash(`Applied ${result.count} clip${result.count===1?"":"s"} from the AI agent`,2600);
  },[pendingAgentTracks,applyEntries,flash]);

  return{
    agentOpen,setAgentOpen,soundFiles,agentInput,setAgentInput,
    agentBusy,ollamaUrl,setOllamaUrl,ollamaStatus,ollamaModels,selectedModel,setSelectedModel,
    pendingAgentTracks,setPendingAgentTracks,soundsInputRef,hasExistingJson:Boolean(sourceJson?.length),
    openSoundsPicker,handleSoundsFolderChange,connectOllama,sendAgentMessage,applyPendingAgentTracks,
  };
}

export{AgentPanel};