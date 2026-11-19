/* Pronóstico de riesgo meteorológico — módulo común del editor y del visor.
   Las emisiones se guardan cifradas (AES-GCM 256, clave derivada con PBKDF2-SHA256) en el repositorio;
   sin la clave de visualización el contenido no se puede leer. */
"use strict";

/* ===================== Configuración ===================== */
const ALMACEN_DEF = {repo:"feliperifo-a11y/trombas_marinas", rama:"main", carpeta:"riesgo/data"};
const TZ = {CL:"America/Santiago", CO:"America/Bogota", PE:"America/Lima"};
const PAIS = {CL:"Chile", CO:"Colombia", PE:"Perú"};
/* Puntos redondeados a 0,01° (~1 km): los modelos tienen celdas de 9 a 25 km. */
const SITES_DEFAULT = [
 {id:"arica",        nombre:"ARICA",             ref:"Arica y Parinacota", pais:"CL", lat:-18.47, lon:-70.31, iso:true},
 {id:"iquique",      nombre:"IQUIQUE",           ref:"Tarapacá",           pais:"CL", lat:-20.23, lon:-70.14, iso:true},
 {id:"calama",       nombre:"CALAMA",            ref:"Antofagasta",        pais:"CL", lat:-22.45, lon:-68.92, iso:true, rA:70, rR:90},
 {id:"antofagasta",  nombre:"ANTOFAGASTA",       ref:"Antofagasta",        pais:"CL", lat:-23.65, lon:-70.40, iso:true},
 {id:"copiapo",      nombre:"COPIAPÓ",           ref:"Atacama",            pais:"CL", lat:-27.37, lon:-70.34, iso:true},
 {id:"laserena",     nombre:"LA SERENA",         ref:"Coquimbo",           pais:"CL", lat:-29.91, lon:-71.26, iso:true},
 {id:"santiago",     nombre:"SANTIAGO",          ref:"Metropolitana",      pais:"CL", lat:-33.52, lon:-70.60, iso:true},
 {id:"talcahuano",   nombre:"TALCAHUANO",        ref:"Biobío",             pais:"CL", lat:-36.79, lon:-73.07, iso:true},
 {id:"losangeles",   nombre:"LOS ÁNGELES",       ref:"Biobío",             pais:"CL", lat:-37.47, lon:-72.35, iso:true},
 {id:"barranquilla", nombre:"BARRANQUILLA",      ref:"Atlántico",          pais:"CO", lat:11.02,  lon:-74.83, iso:false},
 {id:"cartagena",    nombre:"CARTAGENA",         ref:"Bolívar",            pais:"CO", lat:10.42,  lon:-75.54, iso:false},
 {id:"manizales",    nombre:"MANIZALES",         ref:"Caldas",             pais:"CO", lat:5.07,   lon:-75.49, iso:false},
 {id:"bogota",       nombre:"BOGOTÁ",            ref:"Bogotá D.C.",        pais:"CO", lat:4.62,   lon:-74.09, iso:false},
 {id:"cali",         nombre:"CALI",              ref:"Valle del Cauca",    pais:"CO", lat:3.41,   lon:-76.55, iso:false},
 {id:"trujillo",     nombre:"TRUJILLO",          ref:"La Libertad",        pais:"PE", lat:-8.10,  lon:-79.05, iso:false},
 {id:"lima_comas",   nombre:"LIMA (COMAS)",      ref:"Lima",               pais:"PE", lat:-11.94, lon:-77.07, iso:false},
 {id:"callao_bv",    nombre:"CALLAO (BELLAVISTA)",ref:"Callao",            pais:"PE", lat:-12.06, lon:-77.10, iso:false},
 {id:"lima_surq",    nombre:"LIMA (SURQUILLO)",  ref:"Lima",               pais:"PE", lat:-12.11, lon:-77.01, iso:false},
 {id:"lima_sjm",     nombre:"LIMA (S. J. DE MIRAFLORES)", ref:"Lima",      pais:"PE", lat:-12.15, lon:-76.98, iso:false},
 {id:"lima_smig",    nombre:"LIMA (SAN MIGUEL)", ref:"Lima",               pais:"PE", lat:-12.08, lon:-77.09, iso:false},
 {id:"callao_cc",    nombre:"CALLAO (CANTA CALLAO)", ref:"Callao",         pais:"PE", lat:-12.00, lon:-77.11, iso:false},
 {id:"arequipa",     nombre:"AREQUIPA",          ref:"Arequipa",           pais:"PE", lat:-16.39, lon:-71.55, iso:false},
 {id:"piura",        nombre:"PIURA",             ref:"Piura",              pais:"PE", lat:-5.18,  lon:-80.62, iso:false},
 {id:"huancayo",     nombre:"HUANCAYO",          ref:"Junín",              pais:"PE", lat:-12.06, lon:-75.21, iso:false},
 {id:"chiclayo",     nombre:"CHICLAYO",          ref:"Lambayeque",         pais:"PE", lat:-6.78,  lon:-79.84, iso:false},
 {id:"huanuco",      nombre:"HUÁNUCO",           ref:"Huánuco",            pais:"PE", lat:-9.94,  lon:-76.25, iso:false},
 {id:"cajamarca",    nombre:"CAJAMARCA",         ref:"Cajamarca",          pais:"PE", lat:-7.15,  lon:-78.51, iso:false}
];
const THR_DEFAULT = {
  gust:{A:50,R:70,on:true}, wind:{A:40,R:60,on:true}, pp:{A:10,R:25,on:true},
  tmax:{A:32,R:36,on:true}, tmin:{A:2,R:0,on:true}, storm:{on:true}
};
const THR_LABEL = {
  gust:["Ráfaga máxima","km/h","≥"], wind:["Viento medio máximo","km/h","≥"],
  pp:["Precipitación diaria (mediana)","mm","≥"], tmax:["Temperatura máxima","°C","≥"],
  tmin:["Temperatura mínima (helada)","°C","≤"]
};
const RISK_TXT = ["Bajo","Moderado","Alto"];
const RISK_RGB = [[30,158,87],[232,180,0],[211,58,44]];
const RISK_HEX = ["#1e9e57","#e8b400","#d33a2c"];
const PDF_TITLE_DEF = "PRONÓSTICO DE RIESGO METEOROLÓGICO";

/* Estado común: cada página lo llena (el editor desde los modelos, el visor desde la emisión). */
let S = {sites:clone(SITES_DEFAULT), thr:clone(THR_DEFAULT), sel:{}, pdf:{title:PDF_TITLE_DEF, author:"CF Felipe Rifo Espósito"}};
let DATES = [], CELLS = {}, EMI = {fecha:"", hora:"20:00"};
let EDITABLE = false, onCellClick = null;
let rmap = null, rmapLayer = null;

/* ===================== Utilidades ===================== */
function clone(o){return JSON.parse(JSON.stringify(o))}
const $ = id => document.getElementById(id);
function toast(m){const d=document.createElement("div");d.className="toast";d.textContent=m;document.body.appendChild(d);setTimeout(()=>d.remove(),2800)}
function esc(s){return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function lsGet(k){try{return JSON.parse(localStorage.getItem(k)||"null")}catch(e){return null}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}

/* ===================== Fechas ===================== */
function ymd(d){return d.toISOString().slice(0,10)}
function addDays(s,n){const d=new Date(s+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return ymd(d)}
function todayCL(){return new Intl.DateTimeFormat("en-CA",{timeZone:TZ.CL}).format(new Date())}
function isWE(d){const w=new Date(d+"T12:00:00Z").getUTCDay();return w===0||w===6}
function dayLabel(s,long){
  const d=new Date(s+"T12:00:00Z");
  const w=new Intl.DateTimeFormat("es-CL",{weekday:long?"long":"short",timeZone:"UTC"}).format(d);
  return w.charAt(0).toUpperCase()+w.slice(1).replace(".","")+" "+d.getUTCDate();
}
function longDate(s){
  if(!s)return"";
  const d=new Date(s+"T12:00:00Z");
  const t=new Intl.DateTimeFormat("es-CL",{weekday:"long",day:"numeric",month:"long",year:"numeric",timeZone:"UTC"}).format(d);
  return t.charAt(0).toUpperCase()+t.slice(1);
}
function tzOffsetMin(zone,date){
  const p=new Intl.DateTimeFormat("en-US",{timeZone:zone,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).formatToParts(date);
  const g=t=>+p.find(x=>x.type===t).value;
  return Math.round((Date.UTC(g("year"),g("month")-1,g("day"),g("hour"),g("minute"))-date.getTime())/60000);
}
function emisionLine(fecha,hora){
  if(!fecha)return"";
  const guess=new Date(fecha+"T"+(hora||"20:00")+":00Z");
  const inst=new Date(guess.getTime()-tzOffsetMin(TZ.CL,guess)*60000);
  const f=z=>new Intl.DateTimeFormat("es-CL",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:z}).format(inst);
  return `${f(TZ.CL)} Hrs (Chile) – ${f(TZ.PE)} Hrs (Perú) – ${f(TZ.CO)} Hrs (Colombia)`;
}

/* ===================== Formato ===================== */
function fmtMM(v){if(v==null)return"–";if(v<1)return v===0?"0":String(v.toFixed(1)).replace(".",",");return String(Math.round(v))}
function txtT(c){return c.tmin==null?"–":`${c.tmin} a ${c.tmax} °C`}
function txtW(c){return c.wlo==null?"–":(c.wlo===c.whi?`${c.wlo} km/h`:`${c.wlo}-${c.whi} km/h`)}
function txtP(c){if(c.phi==null)return"–";if(c.phi<0.1)return"0 mm";return (c.plo<0.1?"0":fmtMM(c.plo))+"-"+fmtMM(c.phi)+" mm"}
function txtIso(c){if(c.isoLo==null)return"";return c.isoLo===c.isoHi?`ISO 0°: ${c.isoLo} m`:`ISO 0°: ${c.isoLo}-${c.isoHi} m`}

/* ===================== Riesgo ===================== */
function gustThr(s){return[s.rA!=null&&s.rA!==""?+s.rA:S.thr.gust.A, s.rR!=null&&s.rR!==""?+s.rR:S.thr.gust.R]}
function riskOf(c,s){
  const T=S.thr, why=[]; let lv=0;
  const up=(l,txt)=>{if(l>0)why.push({l,txt});if(l>lv)lv=l};
  const [gA,gR]=gustThr(s);
  if(T.gust.on&&c.whi!=null) up(c.whi>=gR?2:c.whi>=gA?1:0,`Ráfagas ${c.whi} km/h`);
  if(T.wind.on&&c.wlo!=null) up(c.wlo>=T.wind.R?2:c.wlo>=T.wind.A?1:0,`Viento ${c.wlo} km/h`);
  if(T.pp.on&&c.pmed!=null) up(c.pmed>=T.pp.R?2:c.pmed>=T.pp.A?1:0,`Lluvia ${fmtMM(c.pmed)} mm`);
  if(T.tmax.on&&c.tmax!=null) up(c.tmax>=T.tmax.R?2:c.tmax>=T.tmax.A?1:0,`Calor ${c.tmax} °C`);
  if(T.tmin.on&&c.tmin!=null) up(c.tmin<=T.tmin.R?2:c.tmin<=T.tmin.A?1:0,`Frío ${c.tmin} °C`);
  if(T.storm.on&&c.code>=95) up(1,"Tormenta eléctrica");
  why.sort((a,b)=>b.l-a.l);
  return {lv,why:why.map(w=>w.txt)};
}
function isWindy(c,s){return c.whi!=null&&c.whi>=gustThr(s)[0]}

/* ===================== Íconos (SVG propio) ===================== */
function iconKind(code){
  if(code==null)return"na";
  if(code>=95)return"storm"; if((code>=71&&code<=77)||code===85||code===86)return"snow";
  if((code>=61&&code<=67)||(code>=80&&code<=82))return"rain"; if(code>=51&&code<=57)return"drizzle";
  if(code===45||code===48)return"fog"; if(code===3)return"cloud"; if(code===2)return"partly"; if(code===1)return"mostlysun"; return"sun";
}
const SUN=(cx,cy,r)=>{let s=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#f6b51e" stroke="#e08e0b" stroke-width="1.5"/>`;
  for(let k=0;k<8;k++){const a=k*Math.PI/4,x1=cx+Math.cos(a)*(r+3),y1=cy+Math.sin(a)*(r+3),x2=cx+Math.cos(a)*(r+7),y2=cy+Math.sin(a)*(r+7);
  s+=`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#e08e0b" stroke-width="2" stroke-linecap="round"/>`}return s};
const CLOUD=(dx,dy,fill)=>`<path transform="translate(${dx},${dy})" d="M14 38h26a9 9 0 0 0 0-18 12 12 0 0 0-23-3A9 9 0 0 0 14 38z" fill="${fill||'#eef2f7'}" stroke="#6f8196" stroke-width="2" stroke-linejoin="round"/>`;
function iconSVG(kind,windy){
  let b="";
  switch(kind){
    case"sun":b=SUN(32,30,11);break;
    case"mostlysun":b=SUN(30,28,11)+CLOUD(14,14,'#fff');break;
    case"partly":b=SUN(24,22,9)+CLOUD(6,10);break;
    case"cloud":b=CLOUD(4,4,'#dde4ec')+CLOUD(0,10);break;
    case"fog":b=CLOUD(0,2)+[44,50,56].map((y,k)=>`<line x1="${12+k*3}" y1="${y}" x2="${52-k*3}" y2="${y}" stroke="#8a99aa" stroke-width="2.5" stroke-linecap="round"/>`).join("");break;
    case"drizzle":b=CLOUD(0,0)+[18,30,42].map(x=>`<circle cx="${x}" cy="48" r="2.2" fill="#2b7bd0"/>`).join("");break;
    case"rain":b=CLOUD(0,0)+[18,30,42].map(x=>`<line x1="${x}" y1="44" x2="${x-4}" y2="56" stroke="#2b7bd0" stroke-width="2.6" stroke-linecap="round"/>`).join("");break;
    case"snow":b=CLOUD(0,0)+[18,30,42].map(x=>`<text x="${x-4}" y="56" font-size="13" fill="#5aa0e0" font-family="Arial">*</text>`).join("");break;
    case"storm":b=CLOUD(0,0,'#cfd8e3')+`<path d="M30 40l-7 11h6l-4 10 11-14h-6l4-7z" fill="#f6b51e" stroke="#c98a00" stroke-width="1"/>`;break;
    default:b=`<text x="32" y="38" text-anchor="middle" font-size="16" fill="#8a99aa" font-family="Arial">s/d</text>`;
  }
  if(windy) b+=`<g stroke="#4f5f72" stroke-width="2.2" fill="none" stroke-linecap="round"><path d="M4 8h18a4 4 0 1 0-4-4"/><path d="M4 14h12"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${b}</svg>`;
}

/* ===================== Selección de ciudades ===================== */
function activeSites(){return S.sites.filter(s=>S.sel[s.id]!==false&&CELLS[s.id])}
function groups(){
  const A=activeSites(), cl=A.filter(s=>s.pais==="CL"), ot=A.filter(s=>s.pais!=="CL");
  const t=["CO","PE"].filter(c=>ot.some(s=>s.pais===c)).map(c=>PAIS[c].toUpperCase()).join(" – ");
  return[{t:"CHILE",sites:cl},{t:t,sites:ot}];
}
function renderSiteChips(host,onChange){
  let h="";
  const avail=S.sites.filter(s=>CELLS[s.id]||!Object.keys(CELLS).length);
  ["CL","CO","PE"].forEach(c=>{
    const ss=avail.filter(s=>s.pais===c); if(!ss.length)return;
    const on=ss.filter(s=>S.sel[s.id]!==false).length;
    h+=`<div class="ctry"><div class="hd"><input type="checkbox" data-c="${c}" ${on===ss.length?"checked":""}>${PAIS[c]} <span style="font-weight:400;color:var(--muted)">(${on}/${ss.length})</span></div><div class="chips">`+
      ss.map(s=>`<span class="chip${S.sel[s.id]!==false?" on":""}" data-s="${s.id}" title="${esc(s.ref)}">${esc(s.nombre)}</span>`).join("")+`</div></div>`;
  });
  host.innerHTML=h;
  host.querySelectorAll("input[data-c]").forEach(el=>{
    const ss=avail.filter(s=>s.pais===el.dataset.c),on=ss.filter(s=>S.sel[s.id]!==false).length;
    el.indeterminate=on>0&&on<ss.length;
    el.onchange=()=>{ss.forEach(s=>S.sel[s.id]=el.checked);onChange()};
  });
  host.querySelectorAll(".chip").forEach(el=>el.onclick=()=>{const id=el.dataset.s;S.sel[id]=S.sel[id]===false;onChange()});
}

/* ===================== Planilla ===================== */
function renderKpis(){
  const n=[0,0,0],sites=[0,0,0],AS=activeSites();
  AS.forEach(s=>{let worst=0;DATES.forEach(d=>{const c=CELLS[s.id]&&CELLS[s.id][d];if(c){n[c.risk]++;worst=Math.max(worst,c.risk)}});sites[worst]++});
  $("kpis").innerHTML=`
   <div class="kpi r"><div class="n">${sites[2]}</div><div class="l">Ciudades con riesgo ALTO en el período</div></div>
   <div class="kpi y"><div class="n">${sites[1]}</div><div class="l">Ciudades con riesgo MODERADO (máximo)</div></div>
   <div class="kpi g"><div class="n">${sites[0]}</div><div class="l">Ciudades solo con riesgo BAJO</div></div>
   <div class="kpi"><div class="n">${AS.length} × ${DATES.length}</div><div class="l">Celdas (${n[2]} altas · ${n[1]} moderadas)</div></div>`;
  const list=[];
  AS.forEach(s=>DATES.forEach(d=>{const c=CELLS[s.id][d];if(c&&c.risk>0)list.push({s,d,c})}));
  list.sort((a,b)=>b.c.risk-a.c.risk||a.d.localeCompare(b.d));
  const al=$("alerts");
  if(!list.length){al.classList.add("hidden");return}
  al.classList.remove("hidden");
  al.innerHTML="<h3>Celdas sobre umbral (alto primero)</h3><ul>"+list.slice(0,14).map(x=>
    `<li><b style="color:${x.c.risk===2?'#ff8a7a':'#f2c230'}">${RISK_TXT[x.c.risk]}</b> · ${esc(x.s.nombre)} · ${dayLabel(x.d,true)} — ${esc((x.c.why||[]).join(", "))}</li>`).join("")+
    (list.length>14?`<li>… y ${list.length-14} más</li>`:"")+"</ul>";
}
function renderPlan(){
  const host=$("planTables");
  if(!DATES.length){host.innerHTML='<div class="box">Sin datos.</div>';return}
  if(!activeSites().length){host.innerHTML='<div class="box">No hay ciudades seleccionadas.</div>';return}
  let h="";
  groups().forEach(g=>{
    if(!g.sites.length)return;
    h+=`<div class="sect">${g.t}</div><div class="tw"><table class="plan"><thead><tr><th>CIUDAD</th>${DATES.map(d=>`<th>${dayLabel(d,true)}</th>`).join("")}</tr></thead><tbody>`;
    g.sites.forEach(s=>{
      h+=`<tr><td class="site">${esc(s.nombre)}<span class="ref">${esc(s.ref)}</span></td>`;
      DATES.forEach(d=>{
        const c=CELLS[s.id][d];
        if(!c||(c.tmax==null&&!c.edited)){h+=`<td><div class="na">Sin datos</div></td>`;return}
        h+=`<td><div class="cell r${c.risk}${EDITABLE?" ed-ok":""}" data-s="${s.id}" data-d="${d}">
          <div class="ic">${iconSVG(iconKind(c.code),isWindy(c,s))}</div>
          <div class="v"><div class="t">${txtT(c)}</div><div>${txtW(c)}</div><div>${txtP(c)}${c.pprob!=null&&c.phi>=0.1?` · ${c.pprob}%`:""}</div>
          ${s.iso&&c.isoLo!=null?`<div class="iso">${txtIso(c)}</div>`:""}
          ${c.why&&c.why.length?`<div class="why">${esc(c.why.join(" · "))}</div>`:""}</div>
          ${EDITABLE&&c.edited?'<span class="ed">editado</span>':""}</div></td>`;
      });
      h+="</tr>";
    });
    h+="</tbody></table></div>";
  });
  host.innerHTML=h;
  if(EDITABLE&&onCellClick) host.querySelectorAll(".cell").forEach(el=>el.onclick=()=>onCellClick(el.dataset.s,el.dataset.d));
}

/* ===================== Mapa ===================== */
function renderMap(){
  if(typeof L==="undefined"||$("t-mapa").classList.contains("hidden"))return;
  if(!rmap){
    rmap=L.map("rmap",{zoomControl:true});
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{maxZoom:12,subdomains:"abcd",attribution:"© OpenStreetMap · © CARTO"}).addTo(rmap);
    rmapLayer=L.layerGroup().addTo(rmap);
  }
  rmapLayer.clearLayers();
  const A=activeSites();
  A.forEach(s=>{
    let worst=0;const rows=DATES.map(d=>{const c=CELLS[s.id]&&CELLS[s.id][d];if(!c)return"";worst=Math.max(worst,c.risk);
      return `<tr><td>${dayLabel(d,false)}</td><td><i class="dot" style="background:${RISK_HEX[c.risk]}"></i></td><td>${txtT(c)}</td><td>${txtW(c)}</td><td>${txtP(c)}</td></tr>`}).join("");
    L.circleMarker([s.lat,s.lon],{radius:9,color:"#fff",weight:2,fillColor:RISK_HEX[worst],fillOpacity:.95})
      .bindPopup(`<b>${esc(s.nombre)}</b><br><small>${esc(s.ref)}</small><table style="font-size:12px;margin-top:4px">${rows}</table>`)
      .addTo(rmapLayer);
  });
  if(A.length) rmap.fitBounds(A.map(s=>[s.lat,s.lon]),{padding:[24,24],maxZoom:9});
  setTimeout(()=>rmap.invalidateSize(),60);
}

/* ===================== PDF ===================== */
async function svgToPng(svg,px){
  return new Promise(res=>{const img=new Image();img.onload=()=>{const c=document.createElement("canvas");c.width=c.height=px;
    c.getContext("2d").drawImage(img,0,0,px,px);res(c.toDataURL("image/png"))};img.onerror=()=>res(null);
    img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg)});
}
async function makePdf(){
  if(!DATES.length){toast("No hay pronóstico cargado");return}
  if(!activeSites().length){toast("No hay ciudades seleccionadas");return}
  if(!window.jspdf){toast("No se cargó la librería PDF (revise la conexión)");return}
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({orientation:"landscape",unit:"pt",format:"letter"});
  const W=doc.internal.pageSize.getWidth(), H=doc.internal.pageSize.getHeight(), M=24;
  const icons={};
  for(const k of["sun","mostlysun","partly","cloud","fog","drizzle","rain","snow","storm","na"])for(const w of[0,1])icons[k+w]=await svgToPng(iconSVG(k,!!w),96);
  const navy=[23,58,94], head=[42,90,140];
  const emi=longDate(EMI.fecha), emiL=emisionLine(EMI.fecha,EMI.hora);
  const title=S.pdf.title||PDF_TITLE_DEF;
  const legend=(x,y)=>{doc.setFontSize(8);[0,1,2].forEach(k=>{doc.setFillColor(...RISK_RGB[k]);doc.rect(x+k*124,y-7,9,9,"F");
    doc.setTextColor(50);doc.text("Riesgo M. Op. "+RISK_TXT[k],x+k*124+12,y)})};
  const header=(first)=>{
    doc.setTextColor(...navy);doc.setFont("helvetica","bold");
    if(first){
      doc.setFontSize(15);doc.text(title,W/2,36,{align:"center"});
      doc.setFontSize(10);doc.text("Fecha de emisión",W/2,54,{align:"center"});
      doc.setFont("helvetica","normal");doc.setTextColor(40);
      doc.text(emi,W/2,67,{align:"center"});doc.text(emiL,W/2,80,{align:"center"});
      doc.setFontSize(8.5);doc.text(`Período: ${longDate(DATES[0])} al ${longDate(DATES[DATES.length-1])}`,M,96);
      legend(W-M-372,96);
    }else{
      doc.setFontSize(10);doc.text(title,M,30);
      doc.setFont("helvetica","normal");doc.setFontSize(8.5);doc.setTextColor(60);
      doc.text(`Emisión: ${emi}, ${EMI.hora} Hrs (Chile)`,W-M,30,{align:"right"});
    }
  };
  const footer=()=>{
    doc.setFontSize(7);doc.setTextColor(90);doc.setFont("helvetica","normal");
    doc.text(`Fuente de datos: Open-Meteo.com (CC BY 4.0) · Modelos ECMWF IFS 0,25°, NCEP GFS, DWD ICON · Elaborado por: ${S.pdf.author}`,M,H-14);
    doc.text(`Página ${doc.internal.getNumberOfPages()} de {total}`,W-M,H-14,{align:"right"});
  };
  const colW=(W-2*M-92)/DATES.length;
  let y=104, first=true;
  for(const g of groups()){
    if(!g.sites.length)continue;
    if(!first&&y>H-140){doc.addPage();y=44}
    doc.setFillColor(...navy);doc.rect(M,y,W-2*M,18,"F");doc.setTextColor(255);doc.setFont("helvetica","bold");doc.setFontSize(10);
    doc.text(g.t,W/2,y+12.5,{align:"center"});
    const hasIso=g.sites.some(s=>s.iso);
    doc.autoTable({
      startY:y+18, margin:{left:M,right:M,top:44,bottom:28},
      head:[["CIUDAD",...DATES.map(d=>dayLabel(d,true))]], body:g.sites.map(s=>[s.nombre,...DATES.map(()=>"")]),
      theme:"grid", rowPageBreak:"avoid",
      styles:{fontSize:8,cellPadding:2,lineColor:[200,208,218],lineWidth:.5,valign:"middle"},
      headStyles:{fillColor:head,textColor:255,halign:"center",fontStyle:"bold"},
      columnStyles:Object.assign({0:{cellWidth:92,fontStyle:"bold",fillColor:[223,232,243],textColor:[23,40,60],halign:"center",fontSize:8}},
        Object.fromEntries(DATES.map((_,k)=>[k+1,{cellWidth:colW}]))),
      didParseCell:d=>{if(d.section==="body")d.cell.styles.minCellHeight=hasIso?48:44},
      didDrawCell:d=>{
        if(d.section!=="body"||d.column.index===0)return;
        const s=g.sites[d.row.index], c=CELLS[s.id][DATES[d.column.index-1]], x=d.cell.x, yy=d.cell.y, w=d.cell.width, h=d.cell.height;
        if(!c||c.tmax==null){doc.setFontSize(7);doc.setTextColor(120);doc.text("Sin datos",x+w/2,yy+h/2,{align:"center"});return}
        const rgb=RISK_RGB[c.risk];
        doc.setFillColor(...rgb.map(v=>Math.round(v+(255-v)*.85)));doc.rect(x+.5,yy+.5,w-1,h-1,"F");
        doc.setFillColor(...rgb);doc.rect(x+.5,yy+.5,5,h-1,"F");
        const im=icons[iconKind(c.code)+(isWindy(c,s)?1:0)];
        const isz=Math.min(w<110?18:24,h-12);
        doc.setFillColor(255,255,255);doc.roundedRect(x+8,yy+(h-isz)/2-1,isz+2,isz+2,3,3,"F");
        if(im)doc.addImage(im,"PNG",x+9,yy+(h-isz)/2,isz,isz);
        const tx=x+isz+13, avail=x+w-tx-2; let ty=yy+9;
        const put=(t,size,bold,col)=>{doc.setFont("helvetica",bold?"bold":"normal");let z=size;doc.setFontSize(z);
          while(z>4.5&&doc.getTextWidth(t)>avail){z-=.25;doc.setFontSize(z)}doc.setTextColor(...col);doc.text(t,tx,ty)};
        put(txtT(c).replace(" a ","-"),7.8,true,[25,25,25]);
        ty+=8.5;put(txtW(c),7.2,false,[25,25,25]);
        ty+=8.5;put(txtP(c),7.2,false,[25,25,25]);
        if(s.iso&&c.isoLo!=null){ty+=8.5;put(w<110?txtIso(c).replace("ISO 0°: ","0°C: "):txtIso(c),6.6,false,[70,70,70])}
        if(c.risk>0&&c.why&&c.why.length){ty+=8.5;put(c.why[0],6.2,false,c.risk===2?[150,30,0]:[120,85,0])}
      },
      didDrawPage:()=>{header(first);first=false;footer()}
    });
    y=doc.lastAutoTable.finalY+14;
  }
  if(y>H-90){doc.addPage();header(false);footer();y=48}
  const T=S.thr, parts=[];
  if(T.gust.on)parts.push(`ráfaga >= ${T.gust.A} / ${T.gust.R} km/h`);
  if(T.wind.on)parts.push(`viento medio >= ${T.wind.A} / ${T.wind.R} km/h`);
  if(T.pp.on)parts.push(`precipitación >= ${T.pp.A} / ${T.pp.R} mm/día`);
  if(T.tmax.on)parts.push(`Tmáx >= ${T.tmax.A} / ${T.tmax.R} °C`);
  if(T.tmin.on)parts.push(`Tmín <= ${T.tmin.A} / ${T.tmin.R} °C`);
  if(T.storm.on)parts.push("tormenta eléctrica = moderado");
  const ex=activeSites().filter(s=>s.rA!=null&&s.rA!=="").map(s=>`${s.nombre}: ráfaga ${s.rA}/${s.rR} km/h`);
  doc.setFont("helvetica","bold");doc.setFontSize(8);doc.setTextColor(...navy);doc.text("Criterios del semáforo (moderado / alto)",M,y);
  doc.setFont("helvetica","normal");doc.setFontSize(7.5);doc.setTextColor(50);
  doc.text(doc.splitTextToSize(parts.join(" · ")+(ex.length?". Umbrales propios: "+ex.join("; ")+".":".")+
    " Temperatura y viento: mediana de los modelos. Precipitación: rango mínimo-máximo entre modelos. Viento: medio máximo - ráfaga máxima. ISO 0°: altura mínima-máxima del día de la isoterma 0 °C (GFS).",W-2*M),M,y+11);
  doc.putTotalPages("{total}");
  doc.save(`Pronostico_Riesgo_Meteorologico_${DATES[0]}_al_${DATES[DATES.length-1]}.pdf`);
  toast("PDF generado");
}

/* ===================== Excel ===================== */
function makeXls(){
  if(!DATES.length){toast("No hay pronóstico cargado");return}
  if(!window.XLSX){toast("No se cargó la librería Excel");return}
  const rows=[];
  activeSites().forEach(s=>DATES.forEach(d=>{const c=CELLS[s.id][d];if(!c)return;rows.push({
    "Ciudad":s.nombre,"Región":s.ref,"País":PAIS[s.pais],"Fecha":d,"Día":dayLabel(d,true),
    "Tmín °C":c.tmin,"Tmáx °C":c.tmax,"Viento medio máx km/h":c.wlo,"Ráfaga máx km/h":c.whi,
    "Precip mín mm":c.plo,"Precip máx mm":c.phi,"Precip mediana mm":c.pmed,"Prob. precip %":c.pprob,
    "ISO 0° mín m":s.iso?c.isoLo:null,"ISO 0° máx m":s.iso?c.isoHi:null,"Código WMO":c.code,
    "Riesgo":RISK_TXT[c.risk],"Motivo":(c.why||[]).join("; ")})}));
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),"Pronóstico");
  XLSX.writeFile(wb,`Pronostico_Riesgo_Meteorologico_${DATES[0]}_al_${DATES[DATES.length-1]}.xlsx`);
}

/* ===================== Cifrado ===================== */
const b64e=buf=>{let s="";new Uint8Array(buf).forEach(b=>s+=String.fromCharCode(b));return btoa(s)};
const b64d=str=>Uint8Array.from(atob(str),c=>c.charCodeAt(0));
async function deriveKey(pass,salt){
  const base=await crypto.subtle.importKey("raw",new TextEncoder().encode(pass),"PBKDF2",false,["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2",salt,iterations:250000,hash:"SHA-256"},base,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
async function encryptJSON(obj,pass){
  const salt=crypto.getRandomValues(new Uint8Array(16)), iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await deriveKey(pass,salt);
  const ct=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(JSON.stringify(obj)));
  return {v:1,alg:"AES-GCM-256/PBKDF2-SHA256-250k",salt:b64e(salt),iv:b64e(iv),ct:b64e(ct)};
}
async function decryptJSON(env,pass){
  const key=await deriveKey(pass,b64d(env.salt));
  const pt=await crypto.subtle.decrypt({name:"AES-GCM",iv:b64d(env.iv)},key,b64d(env.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ===================== Almacén (GitHub) ===================== */
async function ghRead(cfg,path,token){
  // 1) API de contenidos (siempre al día); 2) raw.githubusercontent como respaldo
  const h={Accept:"application/vnd.github.raw+json"}; if(token)h.Authorization="Bearer "+token;
  try{
    const r=await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${cfg.carpeta}/${path}?ref=${encodeURIComponent(cfg.rama)}&t=${Date.now()}`,{headers:h,cache:"no-store"});
    if(r.status===404)return null;
    if(r.ok)return await r.json();
  }catch(e){}
  const r=await fetch(`https://raw.githubusercontent.com/${cfg.repo}/${cfg.rama}/${cfg.carpeta}/${path}?t=${Date.now()}`,{cache:"no-store"});
  if(r.status===404)return null;
  if(!r.ok)throw new Error("No se pudo leer "+path+" (HTTP "+r.status+")");
  return await r.json();
}
async function ghWrite(cfg,path,obj,token,msg){
  const url=`https://api.github.com/repos/${cfg.repo}/contents/${cfg.carpeta}/${path}`;
  const h={Authorization:"Bearer "+token,Accept:"application/vnd.github+json"};
  let sha;
  const g=await fetch(url+"?ref="+encodeURIComponent(cfg.rama)+"&t="+Date.now(),{headers:h,cache:"no-store"});
  if(g.ok)sha=(await g.json()).sha; else if(g.status!==404)throw new Error(`GitHub respondió ${g.status} al leer ${path}`);
  const body={message:msg,branch:cfg.rama,content:btoa(unescape(encodeURIComponent(JSON.stringify(obj))))}; if(sha)body.sha=sha;
  const p=await fetch(url,{method:"PUT",headers:Object.assign({"Content-Type":"application/json"},h),body:JSON.stringify(body)});
  if(!p.ok){let m="";try{m=(await p.json()).message}catch(e){}throw new Error(`GitHub respondió ${p.status} al guardar ${path}${m?": "+m:""}`)}
}
