import React,{useEffect,useMemo,useRef,useState}from"react";
import{createRoot}from"react-dom/client";
import*as pdfjsLib from"pdfjs-dist";
import"./style.css";

pdfjsLib.GlobalWorkerOptions.workerSrc=new URL("pdfjs-dist/build/pdf.worker.mjs",import.meta.url).toString();

const DB="pdf-search-db",VER=1,STORE="indexes";

function norm(s){return String(s||"").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g,"").replace(/\s+/g," ").trim().toLowerCase()}
function compact(s){return norm(s).replace(/\s+/g,"")}
function hash(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return(h>>>0).toString(16)}
async function fileId(f){const a=new Uint8Array(await f.slice(0,1048576).arrayBuffer());let s="";for(let i=0;i<a.length;i+=16)s+=String.fromCharCode(a[i]);return`${f.name}|${f.size}|${f.lastModified}|${hash(s)}`}
function db(){return new Promise((res,rej)=>{const r=indexedDB.open(DB,VER);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE)};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function get(k){const d=await db();return new Promise((res,rej)=>{const t=d.transaction(STORE,"readonly"),r=t.objectStore(STORE).get(k);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function put(k,v){const d=await db();return new Promise((res,rej)=>{const t=d.transaction(STORE,"readwrite");t.objectStore(STORE).put(v,k);t.oncomplete=res;t.onerror=()=>rej(t.error)})}
async function del(k){const d=await db();return new Promise((res,rej)=>{const t=d.transaction(STORE,"readwrite");t.objectStore(STORE).delete(k);t.oncomplete=res;t.onerror=()=>rej(t.error)})}

function lev(a,b,max=6){a=compact(a);b=compact(b);if(!a||!b)return 0;if(a===b)return 100;if(Math.abs(a.length-b.length)>max||a.length>80||b.length>100)return 0;let p=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let c=[i],m=i;for(let j=1;j<=b.length;j++){c[j]=Math.min(c[j-1]+1,p[j]+1,p[j-1]+(a[i-1]===b[j-1]?0:1));m=Math.min(m,c[j])}if(m>max)return 0;p=c}return Math.max(0,Math.round((1-p[b.length]/Math.max(a.length,b.length))*100))}
function snippet(text,q){const i=norm(text).indexOf(norm(q));return i<0?text.slice(0,280):text.slice(Math.max(0,i-110),Math.min(text.length,i+norm(q).length+180))}
function fuzzy(text,q){const w=text.split(/\s+/).filter(Boolean),n=norm(q).split(/\s+/).filter(Boolean).length;let best=null;for(let i=0;i<Math.min(w.length,1200);i++){const c=w.slice(i,i+n+1).join(" "),s=lev(q,c);if(!best||s>best.score)best={score:s,text:c}}return best}

function App(){
 const[file,setFile]=useState(null),[id,setId]=useState(""),[idx,setIdx]=useState(null),[q,setQ]=useState("");
 const[threshold,setThreshold]=useState(82),[busy,setBusy]=useState(false),[building,setBuilding]=useState(false);
 const[status,setStatus]=useState("Select your PDF to begin."),[read,setRead]=useState(0),[pages,setPages]=useState(0),[results,setResults]=useState([]);
 const[url,setUrl]=useState("");const pdfRef=useRef(null);
 useEffect(()=>()=>{if(url)URL.revokeObjectURL(url)},[url]);
 const pct=useMemo(()=>pages?Math.round(read/pages*100):0,[read,pages]);

 async function build(f,k){
  setBuilding(true);setBusy(true);setResults([]);
  try{
   const buf=await f.arrayBuffer(),pdf=await pdfjsLib.getDocument({data:buf}).promise;
   pdfRef.current=pdf;setPages(pdf.numPages);
   const cached=await get(k);
   if(cached?.version===1&&cached.numPages===pdf.numPages&&Array.isArray(cached.pages)){
    setIdx(cached);setRead(pdf.numPages);setStatus(`Index loaded. ${pdf.numPages.toLocaleString()} pages ready.`);return
   }
   const arr=new Array(pdf.numPages);
   for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p),c=await page.getTextContent(),text=c.items.map(x=>x.str||"").join(" ");
    arr[p-1]={page:p,text,normalized:norm(text)};page.cleanup();
    if(p%10===0||p===pdf.numPages){setRead(p);setStatus(`Building index: ${p.toLocaleString()} / ${pdf.numPages.toLocaleString()} pages`);await new Promise(r=>setTimeout(r,0))}
   }
   const x={version:1,name:f.name,size:f.size,numPages:pdf.numPages,pages:arr};
   setStatus("Saving index for future searches...");await put(k,x);setIdx(x);setStatus(`Index complete. ${pdf.numPages.toLocaleString()} pages ready.`)
  }catch(e){console.error(e);setStatus("Could not read this PDF. If it is scanned/image-only, OCR is required.")}finally{setBuilding(false);setBusy(false)}
 }

 async function select(e){const f=e.target.files?.[0];if(!f)return;if(f.type!=="application/pdf")return alert("Please select a PDF.");if(url)URL.revokeObjectURL(url);setFile(f);setUrl(URL.createObjectURL(f));setIdx(null);setResults([]);setRead(0);setPages(0);setStatus("Checking saved index...");const k=await fileId(f);setId(k);await build(f,k)}

 function search(){
  if(!idx)return alert("Please select a PDF first.");if(!q.trim())return alert("Enter a name to search.");
  setBusy(true);setResults([]);setStatus("Searching exact matches...");
  setTimeout(()=>{const exact=idx.pages.filter(x=>x.normalized.includes(norm(q))).map(x=>({page:x.page,score:100,snippet:snippet(x.text,q),exact:true}));
   if(exact.length){setResults(exact);setStatus(`Found ${exact.length.toLocaleString()} exact match(es).`);setBusy(false);return}
   setStatus("No exact match. Trying fuzzy search...");
   setTimeout(()=>{const out=[];for(const x of idx.pages){const m=fuzzy(x.text,q);if(m&&m.score>=Number(threshold))out.push({page:x.page,score:m.score,snippet:m.text,exact:false})}out.sort((a,b)=>b.score-a.score||a.page-b.page);setResults(out);setStatus(out.length?`Found ${out.length.toLocaleString()} possible match(es).`:"No matching name found.");setBusy(false)},0)
  },0)
 }
 function openPage(p){if(url)window.open(`${url}#page=${p}`,"_blank","noopener,noreferrer")}
 async function clear(){if(id)await del(id);setIdx(null);setResults([]);setRead(0);setStatus("Saved index cleared. Select the PDF again to rebuild it.")}
 function exportCSV(){const csv=["Page,Match,Snippet",...results.map(r=>`${r.page},${r.score}%,"${String(r.snippet).replace(/"/g,'""').replace(/\r?\n/g," ")}"`)].join("\n");const u=URL.createObjectURL(new Blob([csv],{type:"text/csv"})),a=document.createElement("a");a.href=u;a.download="pdf-search-results.csv";a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}

 return <div className="app"><header><div className="brand">PDF<span>Search</span></div><h1>Search Names in 12,000+ Page PDFs</h1><p>Build the index once. Search names repeatedly without reading the PDF again.</p></header>
 <main><section className="card">
 <label className="upload"><input type="file" accept="application/pdf" onChange={select} disabled={building}/><div className="uploadbox"><div>📄</div><strong>{file?file.name:"Choose your PDF"}</strong><small>{file?`${(file.size/1048576).toFixed(1)} MB`:"Click here to select a PDF"}</small></div></label>
 {pages>0&&<div className="progressWrap"><div className="progressTop"><span>{building?"Building index":"Index ready"}</span><b>{pct}%</b></div><div className="progress"><div style={{width:`${pct}%`}}/></div><small>{read.toLocaleString()} / {pages.toLocaleString()} pages processed</small></div>}
 <label className="fieldLabel">Name to search</label><div className="searchRow"><input className="text" value={q} disabled={!idx||busy} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!busy&&search()} placeholder="Example: Tushar Raut"/><button className="searchButton" disabled={!idx||busy||building} onClick={search}>{busy?"SEARCHING...":"SEARCH"}</button></div>
 <div className="fuzzy"><div><span>Fuzzy matching threshold</span><b>{threshold}%</b></div><input type="range" min="60" max="95" value={threshold} onChange={e=>setThreshold(e.target.value)}/><small>Exact matching is always attempted first. Fuzzy matching is used only when there are no exact matches.</small></div>
 <div className="status">{status}</div>{idx&&<button className="clearIndex" onClick={clear}>CLEAR SAVED INDEX</button>}</section>
 <section className="card"><div className="resultHead"><div><h2>Results</h2><span>{results.length.toLocaleString()} page(s)</span></div>{results.length>0&&<button className="export" onClick={exportCSV}>EXPORT CSV</button>}</div>
 {!results.length?<div className="empty">🔎<strong>No results yet</strong><p>Select your PDF, wait for indexing, then search any name.</p></div>:results.map((r,i)=><div className="result" key={r.page+"-"+i}><div><div className="resultTitle"><strong>Page {r.page}</strong><span className="score">{r.score}% {r.exact?"EXACT":"FUZZY"}</span></div><p>{r.snippet}</p></div><button className="openButton" onClick={()=>openPage(r.page)}>OPEN PAGE</button></div>)}</section>
 <div className="info"><div><strong>⚡ One-time index</strong><span>Processed once and saved in this browser.</span></div><div><strong>🔤 Case insensitive</strong><span>TUSHAR RAUT, Tushar Raut and tushar raut match.</span></div><div><strong>📄 Page opening</strong><span>Open the PDF directly on the matching page.</span></div><div><strong>⚠️ Scanned PDFs</strong><span>Image-only PDFs require OCR.</span></div></div>
 </main></div>
}
createRoot(document.getElementById("root")).render(<App/>);