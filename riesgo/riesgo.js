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
const FIRMA = "ApoyoMet – Asesorías Marítimas y Portuarias";
const LOGO_URL = "apoyomet.png", LOGO_RATIO = 900/366;   // firma en todas las salidas

/* Estado común: cada página lo llena (el editor desde los modelos, el visor desde la emisión). */
let S = {sites:clone(SITES_DEFAULT), thr:clone(THR_DEFAULT), sel:{}, pdf:{title:PDF_TITLE_DEF, author:FIRMA}};
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

/* ===================== Íconos ===================== */
/* Íconos con el mismo estilo de MeteoIA (meteoia.cl: ICO_NUB, ICO.gota, ICO.viento): planos, rellenos, cuadrícula 24×24.
   Despejado, Parcial, Nublado y Cubierto son los de MeteoIA; llovizna, lluvia, tormenta, niebla y nieve siguen el mismo trazo. */
const NUB={
  Despejado:'<circle cx="12" cy="12" r="5" fill="#f2b705"/><g stroke="#f2b705" stroke-width="2" stroke-linecap="round"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g>',
  Parcial:'<circle cx="9" cy="9" r="4.5" fill="#f2b705"/><path d="M8 20h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 8 20Z" fill="#b8c2cc"/>',
  Nublado:'<path d="M6 19h12a4.5 4.5 0 0 0 .6-9 6 6 0 0 0-11.5 1.6A3.8 3.8 0 0 0 6 19Z" fill="#8a96a3"/>',
  Cubierto:'<path d="M4 15h10a3.5 3.5 0 0 0 .4-7 4.7 4.7 0 0 0-9 1.3A2.9 2.9 0 0 0 4 15Z" fill="#a9b3bd"/><path d="M8 21h11a4 4 0 0 0 .5-8 5.3 5.3 0 0 0-10.2 1.4A3.3 3.3 0 0 0 8 21Z" fill="#5b6673"/>'
};
const NUBE_ALTA=(f)=>`<path d="M6 14h12a4.5 4.5 0 0 0 .6-9 6 6 0 0 0-11.5 1.6A3.8 3.8 0 0 0 6 14Z" fill="${f||"#8a96a3"}"/>`;
const GOTA=(x,y)=>`<path d="M${x} ${y}s1.6 1.9 1.6 3a1.6 1.6 0 0 1-3.2 0c0-1.1 1.6-3 1.6-3Z" fill="#5fb0ff"/>`;
function iconKind(code){
  if(code==null)return"na";
  if(code>=95)return"storm"; if((code>=71&&code<=77)||code===85||code===86)return"snow";
  if((code>=61&&code<=67)||(code>=80&&code<=82))return"rain"; if(code>=51&&code<=57)return"drizzle";
  if(code===45||code===48)return"fog"; if(code===3)return"cloud"; if(code===2)return"partly"; if(code===1)return"mostlysun"; return"sun";
}
function iconSVG(kind,windy,claro){
  let b="";
  switch(kind){
    case"sun":b=NUB.Despejado;break;
    case"mostlysun":b=NUB.Despejado;break;
    case"partly":b=NUB.Parcial;break;
    case"cloud":b=NUB.Cubierto;break;
    case"fog":b=NUBE_ALTA("#a9b3bd")+'<g stroke="#8a96a3" stroke-width="1.8" stroke-linecap="round"><path d="M4 17.5h16M6 21h12"/></g>';break;
    case"drizzle":b=NUBE_ALTA()+'<g fill="#5fb0ff"><circle cx="8" cy="18" r="1.1"/><circle cx="12" cy="20.5" r="1.1"/><circle cx="16" cy="18" r="1.1"/></g>';break;
    case"rain":b=NUBE_ALTA("#5b6673")+GOTA(7.5,16.2)+GOTA(12,18.2)+GOTA(16.5,16.2);break;
    case"snow":b=NUBE_ALTA("#a9b3bd")+'<g stroke="#cfe2f5" stroke-width="1.5" stroke-linecap="round"><path d="M8 16.5v4M6.3 17.5l3.4 2M6.3 19.5l3.4-2M16 16.5v4M14.3 17.5l3.4 2M14.3 19.5l3.4-2"/></g>'.replace(/#cfe2f5/g,claro?"#7aa7d6":"#cfe2f5");break;
    case"storm":b=NUBE_ALTA("#5b6673")+'<path d="M12.5 13.5 9 19h3l-1.5 4.5L15.5 17h-3l1.5-3.5Z" fill="#f2b705"/>';break;
    default:b='<circle cx="12" cy="12" r="4" fill="#8a96a3"/>';
  }
  if(windy) b=`<g transform="translate(6 -0.5) scale(.75)">${b}</g><path d="M1 18.5h8.5a1.8 1.8 0 1 0-1.8-1.8M1 21.8h11a1.8 1.8 0 1 1-1.8 1.8" fill="none" stroke="${claro?"#3d7fc4":"#9fd0ff"}" stroke-width="1.5" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${b}</svg>`;
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

/* ===================== Mapa (siempre visible, a la izquierda) ===================== */
let MARKERS={}, lastFit="";
function worstRisk(s){let w=0;DATES.forEach(d=>{const c=CELLS[s.id]&&CELLS[s.id][d];if(c&&c.risk>w)w=c.risk});return w}
function renderMap(){
  if(typeof L==="undefined"||!$("rmap"))return;
  if(!rmap){
    rmap=L.map("rmap",{zoomControl:false,attributionControl:true}).setView([-15,-74],3);
    L.control.zoom({position:"bottomright"}).addTo(rmap);
    // Mismas teselas que la página de trombas (Esri), más límites y nombres de lugares
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{attribution:"Imagen © Esri",maxZoom:17,maxNativeZoom:13}).addTo(rmap);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",{attribution:"Límites © Esri",maxZoom:17,maxNativeZoom:13,opacity:.9}).addTo(rmap);
    rmapLayer=L.layerGroup().addTo(rmap);
    window.addEventListener("resize",()=>rmap.invalidateSize());
  }
  rmapLayer.clearLayers();MARKERS={};
  const A=activeSites();
  A.forEach(s=>{
    const worst=worstRisk(s);
    const rows=DATES.map(d=>{const c=CELLS[s.id]&&CELLS[s.id][d];if(!c)return"";
      return `<tr><td>${dayLabel(d,false)}</td><td><i class="dot" style="background:${RISK_HEX[c.risk]}"></i></td><td>${txtT(c)}</td><td>${txtW(c)}</td><td>${txtP(c)}</td></tr>`}).join("");
    const m=L.circleMarker([s.lat,s.lon],{radius:9,color:"#fff",weight:2,fillColor:RISK_HEX[worst],fillOpacity:.95})
      .bindPopup(`<b>${esc(s.nombre)}</b><br><small>${esc(s.ref)}</small><table style="font-size:12px;margin-top:4px;border-spacing:6px 2px">${rows}</table>`)
      .bindTooltip(s.nombre,{direction:"right",offset:[8,0]})
      .on("click",()=>markCard(s.id,true))
      .addTo(rmapLayer);
    MARKERS[s.id]=m;
  });
  const key=A.map(s=>s.id).join(",");
  if(A.length&&key!==lastFit){rmap.fitBounds(A.map(s=>[s.lat,s.lon]),{padding:[30,30],maxZoom:9});lastFit=key}
  setTimeout(()=>rmap.invalidateSize(),60);
}
function focusCity(id){
  const s=S.sites.find(x=>x.id===id),m=MARKERS[id];if(!s||!m||!rmap)return;
  if(window.innerWidth<1100){const mc=document.querySelector(".mapCard");if(mc)mc.scrollIntoView({behavior:"smooth",block:"start"})}
  rmap.flyTo([s.lat,s.lon],Math.max(rmap.getZoom(),7),{duration:.6});setTimeout(()=>m.openPopup(),650);
  markCard(id,false);
}
function markCard(id,scroll){
  document.querySelectorAll(".ccard.sel").forEach(e=>e.classList.remove("sel"));
  const el=document.querySelector(`.ccard[data-s="${id}"]`);if(!el)return;
  el.classList.add("sel");
  if(scroll&&window.innerWidth>=1100){const t=document.querySelector('#tabs [data-t="ciudades"]');if(t&&!t.classList.contains("on"))t.click();el.scrollIntoView({behavior:"smooth",block:"nearest"})}
}

/* ===================== Lista de ciudades ordenada ===================== */
let ORDEN=lsGet("riesgo_orden")||"pais";
const ORDENES=[["pais","Por país (orden de la planilla)"],["ns","Norte a sur"],["riesgo","Mayor riesgo primero"],["az","Alfabético"]];
function sortedSites(){
  const A=activeSites().slice(),pos=id=>S.sites.findIndex(x=>x.id===id),ord={CL:0,CO:1,PE:2};
  if(ORDEN==="ns")A.sort((a,b)=>b.lat-a.lat);
  else if(ORDEN==="az")A.sort((a,b)=>a.nombre.localeCompare(b.nombre,"es"));
  else if(ORDEN==="riesgo"){const mw=s=>Math.max(-1,...DATES.map(d=>{const c=CELLS[s.id][d];return c&&c.whi!=null?c.whi:-1}));
    A.sort((a,b)=>worstRisk(b)-worstRisk(a)||mw(b)-mw(a)||b.lat-a.lat)}
  else A.sort((a,b)=>ord[a.pais]-ord[b.pais]||pos(a.id)-pos(b.id));
  return A;
}
function renderCities(){
  const host=$("cityList");if(!host)return;
  const sel=$("fOrden");
  if(sel&&!sel.options.length){sel.innerHTML=ORDENES.map(([v,t])=>`<option value="${v}">${t}</option>`).join("");sel.value=ORDEN;
    sel.onchange=()=>{ORDEN=sel.value;lsSet("riesgo_orden",ORDEN);renderCities()}}
  if(!DATES.length){host.innerHTML='<div class="note">Sin datos.</div>';return}
  const A=sortedSites();
  if(!A.length){host.innerHTML='<div class="note">No hay ciudades seleccionadas.</div>';return}
  let h="",grp=null;
  A.forEach(s=>{
    if(ORDEN==="pais"&&grp!==s.pais){grp=s.pais;h+=`<div class="cgrp">${PAIS[s.pais]}</div>`}
    const w=worstRisk(s),why=[];
    DATES.forEach(d=>{const c=CELLS[s.id][d];if(c&&c.risk===w&&w>0&&c.why&&c.why[0]&&why.length<2)why.push(`${dayLabel(d,false)}: ${c.why[0]}`)});
    h+=`<div class="ccard w${w}" data-s="${s.id}">
      <div class="ch"><span class="cn">${esc(s.nombre)}</span><span class="cr">${esc(s.ref)}${ORDEN!=="pais"?" · "+PAIS[s.pais]:""}</span><span class="badge b${w}">${RISK_TXT[w]}</span></div>
      <div class="days" style="grid-template-columns:repeat(${DATES.length},minmax(0,1fr))">`+
      DATES.map(d=>{const c=CELLS[s.id][d];if(!c||c.tmax==null)return`<div class="dc"><div class="dl">${dayLabel(d,false)}</div><div class="na">s/d</div></div>`;
        return `<div class="dc r${c.risk}${EDITABLE?" ed-ok":""}" data-d="${d}" title="${esc(txtT(c)+" · "+txtW(c)+" · "+txtP(c)+(c.why&&c.why.length?" · "+c.why.join(", "):""))}">
          <div class="dl">${dayLabel(d,false)}</div><div class="di">${iconSVG(iconKind(c.code),isWindy(c,s))}</div>
          <div class="dt"><b>${c.tmax}°</b> <span>${c.tmin}°</span></div><div class="dw">${c.whi!=null?c.whi:"–"} <small>km/h</small></div><div class="dp">${c.phi!=null&&c.phi>=0.1?fmtMM(c.phi)+" mm":"&nbsp;"}</div>
          ${EDITABLE&&c.edited?'<i class="edm"></i>':""}</div>`}).join("")+
      `</div>${why.length?`<div class="cw">${esc(why.join(" · "))}</div>`:""}</div>`;
  });
  host.innerHTML=h;
  host.querySelectorAll(".ccard").forEach(el=>{
    el.querySelector(".ch").onclick=()=>focusCity(el.dataset.s);
    el.querySelectorAll(".dc[data-d]").forEach(dc=>dc.onclick=()=>{if(EDITABLE&&onCellClick)onCellClick(el.dataset.s,dc.dataset.d);else focusCity(el.dataset.s)});
  });
}

/* ===================== Firma (logo ApoyoMet) ===================== */
let LOGO_DATA=null;
async function logoData(){
  if(LOGO_DATA)return LOGO_DATA;
  try{const r=await fetch(LOGO_URL);const b=await r.blob();
    LOGO_DATA=await new Promise(res=>{const f=new FileReader();f.onload=()=>res(f.result);f.onerror=()=>res(null);f.readAsDataURL(b)});
  }catch(e){LOGO_DATA=null}
  return LOGO_DATA;
}
function autorTxt(){const a=(S.pdf.author||"").trim();return a&&a!=="CF Felipe Rifo Espósito"?a:FIRMA}
function fileBase(){return `Pronostico_Riesgo_Meteorologico_${DATES[0]}_al_${DATES[DATES.length-1]}`}
function critText(){
  const T=S.thr,parts=[];
  if(T.gust.on)parts.push(`ráfaga >= ${T.gust.A} / ${T.gust.R} km/h`);
  if(T.wind.on)parts.push(`viento medio >= ${T.wind.A} / ${T.wind.R} km/h`);
  if(T.pp.on)parts.push(`precipitación >= ${T.pp.A} / ${T.pp.R} mm/día`);
  if(T.tmax.on)parts.push(`Tmáx >= ${T.tmax.A} / ${T.tmax.R} °C`);
  if(T.tmin.on)parts.push(`Tmín <= ${T.tmin.A} / ${T.tmin.R} °C`);
  if(T.storm.on)parts.push("tormenta eléctrica = moderado");
  const ex=activeSites().filter(s=>s.rA!=null&&s.rA!=="").map(s=>`${s.nombre}: ráfaga ${s.rA}/${s.rR} km/h`);
  return parts.join(" · ")+(ex.length?". Umbrales propios: "+ex.join("; ")+".":".")+
    " Temperatura y viento: mediana de los modelos. Precipitación: rango mínimo-máximo entre modelos. Viento: medio máximo - ráfaga máxima. ISO 0°: altura mínima-máxima del día de la isoterma 0 °C (GFS).";
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
  for(const k of["sun","mostlysun","partly","cloud","fog","drizzle","rain","snow","storm","na"])for(const w of[0,1])icons[k+w]=await svgToPng(iconSVG(k,!!w,true),96);
  const navy=[23,58,94], head=[42,90,140];
  const emi=longDate(EMI.fecha), emiL=emisionLine(EMI.fecha,EMI.hora);
  const title=S.pdf.title||PDF_TITLE_DEF, logo=await logoData();
  const legend=(x,y)=>{doc.setFontSize(8);[0,1,2].forEach(k=>{doc.setFillColor(...RISK_RGB[k]);doc.rect(x+k*124,y-7,9,9,"F");
    doc.setTextColor(50);doc.text("Riesgo M. Op. "+RISK_TXT[k],x+k*124+12,y)})};
  const header=(first)=>{
    doc.setTextColor(...navy);doc.setFont("helvetica","bold");
    if(first){
      if(logo)doc.addImage(logo,"PNG",M,16,48*LOGO_RATIO,48);
      doc.setFontSize(15);doc.text(title,W/2,36,{align:"center"});
      doc.setFontSize(10);doc.text("Fecha de emisión",W/2,54,{align:"center"});
      doc.setFont("helvetica","normal");doc.setTextColor(40);
      doc.text(emi,W/2,67,{align:"center"});doc.text(emiL,W/2,80,{align:"center"});
      doc.setFontSize(8.5);doc.text(`Período: ${longDate(DATES[0])} al ${longDate(DATES[DATES.length-1])}`,M,96);
      legend(W-M-372,96);
    }else{
      if(logo)doc.addImage(logo,"PNG",M,12,24*LOGO_RATIO,24);
      doc.setFontSize(10);doc.text(title,M+24*LOGO_RATIO+10,30);
      doc.setFont("helvetica","normal");doc.setFontSize(8.5);doc.setTextColor(60);
      doc.text(`Emisión: ${emi}, ${EMI.hora} Hrs (Chile)`,W-M,30,{align:"right"});
    }
  };
  const footer=()=>{
    doc.setFontSize(7);doc.setTextColor(90);doc.setFont("helvetica","normal");
    if(logo)doc.addImage(logo,"PNG",M,H-24,14*LOGO_RATIO,14);
    doc.text(`Elaborado por: ${autorTxt()} · Fuente de datos: Open-Meteo.com (CC BY 4.0) · Modelos ECMWF IFS 0,25°, NCEP GFS, DWD ICON`,M+14*LOGO_RATIO+6,H-14);
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
  doc.setFont("helvetica","bold");doc.setFontSize(8);doc.setTextColor(...navy);doc.text("Criterios del semáforo (moderado / alto)",M,y);
  doc.setFont("helvetica","normal");doc.setFontSize(7.5);doc.setTextColor(50);
  doc.text(doc.splitTextToSize(critText(),W-2*M),M,y+11);
  doc.putTotalPages("{total}");
  doc.save(fileBase()+".pdf");
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
  const ws=XLSX.utils.aoa_to_sheet([[S.pdf.title||PDF_TITLE_DEF],[`Emisión: ${longDate(EMI.fecha)}, ${EMI.hora} Hrs (Chile)`],[`Elaborado por: ${autorTxt()}`],[]]);
  XLSX.utils.sheet_add_json(ws,rows,{origin:"A5"});
  ws["!cols"]=[{wch:26},{wch:18},{wch:10},{wch:11},{wch:10}];
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Pronóstico");
  XLSX.writeFile(wb,fileBase()+".xlsx");
}

/* ===================== Word (.docx, editable) ===================== */
function dataUrlBytes(u){return Uint8Array.from(atob(u.split(",")[1]),c=>c.charCodeAt(0))}
const hex=rgb=>rgb.map(v=>v.toString(16).padStart(2,"0")).join("");
async function makeDocx(){
  if(!DATES.length){toast("No hay pronóstico cargado");return}
  if(!activeSites().length){toast("No hay ciudades seleccionadas");return}
  if(!window.docx){toast("No se cargó la librería Word (revise la conexión)");return}
  const D=window.docx, logo=await logoData();
  const {Document,Packer,Paragraph,TextRun,ImageRun,Table,TableRow,TableCell,WidthType,AlignmentType,ShadingType,BorderStyle,
    VerticalAlign,PageOrientation,Header,Footer,PageNumber,TableLayoutType}=D;
  const icons={};
  for(const k of["sun","mostlysun","partly","cloud","fog","drizzle","rain","snow","storm","na"])for(const w of[0,1]){const u=await svgToPng(iconSVG(k,!!w,true),96);icons[k+w]=u?dataUrlBytes(u):null}
  const logoB=logo?dataUrlBytes(logo):null;
  const NAVY="173A5E",HEAD="2A5A8C",CITY="DFE8F3",F="Arial";
  const tint=rgb=>hex(rgb.map(v=>Math.round(v+(255-v)*.85)));
  const T=(t,o)=>new TextRun(Object.assign({text:t,font:F,size:16},o||{}));
  const thin={style:BorderStyle.SINGLE,size:4,color:"C8D2DE"};
  const PAGE_W=15840,MARG=720,USABLE=PAGE_W-2*MARG,CITYW=1800,DAYW=Math.floor((USABLE-CITYW)/DATES.length);
  const title=S.pdf.title||PDF_TITLE_DEF;
  const body=[];
  // Encabezado del informe
  body.push(new Table({width:{size:USABLE,type:WidthType.DXA},columnWidths:[2200,USABLE-4400,2200],layout:TableLayoutType.FIXED,
    borders:{top:{style:BorderStyle.NONE},bottom:{style:BorderStyle.NONE},left:{style:BorderStyle.NONE},right:{style:BorderStyle.NONE},insideHorizontal:{style:BorderStyle.NONE},insideVertical:{style:BorderStyle.NONE}},
    rows:[new TableRow({children:[
      new TableCell({width:{size:2200,type:WidthType.DXA},verticalAlign:VerticalAlign.CENTER,children:[new Paragraph({children:logoB?[new ImageRun({data:logoB,transformation:{width:Math.round(52*LOGO_RATIO),height:52}})]:[]})]}),
      new TableCell({width:{size:USABLE-4400,type:WidthType.DXA},verticalAlign:VerticalAlign.CENTER,children:[
        new Paragraph({alignment:AlignmentType.CENTER,children:[T(title,{bold:true,size:30,color:NAVY})]}),
        new Paragraph({alignment:AlignmentType.CENTER,spacing:{before:80},children:[T("Fecha de emisión",{bold:true,size:20,color:NAVY})]}),
        new Paragraph({alignment:AlignmentType.CENTER,children:[T(longDate(EMI.fecha),{size:20})]}),
        new Paragraph({alignment:AlignmentType.CENTER,children:[T(emisionLine(EMI.fecha,EMI.hora),{size:20})]})]}),
      new TableCell({width:{size:2200,type:WidthType.DXA},children:[new Paragraph("")]})]})]}));
  body.push(new Paragraph({spacing:{before:120,after:80},children:[
    T(`Período: ${longDate(DATES[0])} al ${longDate(DATES[DATES.length-1])}     `,{size:17}),
    ...[0,1,2].flatMap(k=>[T("■ ",{color:hex(RISK_RGB[k]),size:22}),T(`Riesgo M. Op. ${RISK_TXT[k]}    `,{size:17})])]}));
  // Tablas por grupo
  for(const g of groups()){
    if(!g.sites.length)continue;
    body.push(new Paragraph({shading:{type:ShadingType.CLEAR,fill:NAVY,color:"auto"},alignment:AlignmentType.CENTER,spacing:{before:120},keepNext:true,
      children:[T(g.t,{bold:true,color:"FFFFFF",size:20})]}));
    const head=new TableRow({tableHeader:true,cantSplit:true,children:[
      new TableCell({width:{size:CITYW,type:WidthType.DXA},shading:{type:ShadingType.CLEAR,fill:HEAD,color:"auto"},verticalAlign:VerticalAlign.CENTER,
        children:[new Paragraph({alignment:AlignmentType.CENTER,children:[T("CIUDAD",{bold:true,color:"FFFFFF",size:17})]})]}),
      ...DATES.map(d=>new TableCell({width:{size:DAYW,type:WidthType.DXA},shading:{type:ShadingType.CLEAR,fill:HEAD,color:"auto"},verticalAlign:VerticalAlign.CENTER,
        children:[new Paragraph({alignment:AlignmentType.CENTER,children:[T(dayLabel(d,true),{bold:true,color:"FFFFFF",size:17})]})]}))]});
    const rows=g.sites.map(s=>new TableRow({cantSplit:true,children:[
      new TableCell({width:{size:CITYW,type:WidthType.DXA},shading:{type:ShadingType.CLEAR,fill:CITY,color:"auto"},verticalAlign:VerticalAlign.CENTER,
        children:[new Paragraph({alignment:AlignmentType.CENTER,children:[T(s.nombre,{bold:true,size:16,color:"17283C"})]})]}),
      ...DATES.map(d=>{
        const c=CELLS[s.id][d];
        if(!c||c.tmax==null)return new TableCell({width:{size:DAYW,type:WidthType.DXA},children:[new Paragraph({children:[T("Sin datos",{size:14,color:"777777"})]})]});
        const im=icons[iconKind(c.code)+(isWindy(c,s)?1:0)];
        const lines=[T(txtT(c).replace(" a ","-"),{bold:true,size:15}),T(txtW(c),{break:1,size:14}),T(txtP(c),{break:1,size:14})];
        if(s.iso&&c.isoLo!=null)lines.push(T(txtIso(c),{break:1,size:12,color:"464646"}));
        if(c.risk>0&&c.why&&c.why.length)lines.push(T(c.why[0],{break:1,size:12,color:c.risk===2?"961E00":"785500"}));
        return new TableCell({width:{size:DAYW,type:WidthType.DXA},shading:{type:ShadingType.CLEAR,fill:tint(RISK_RGB[c.risk]),color:"auto"},verticalAlign:VerticalAlign.CENTER,
          margins:{left:70,right:50,top:10,bottom:10},
          borders:{left:{style:BorderStyle.SINGLE,size:36,color:hex(RISK_RGB[c.risk])},top:thin,bottom:thin,right:thin},
          children:[new Paragraph({spacing:{before:0,after:0},children:[...(im?[new ImageRun({data:im,transformation:{width:22,height:22}}),T("  ")]:[]),...lines]})]});
      })]}));
    body.push(new Table({width:{size:USABLE,type:WidthType.DXA},columnWidths:[CITYW,...DATES.map(()=>DAYW)],layout:TableLayoutType.FIXED,rows:[head,...rows]}));
  }
  body.push(new Paragraph({spacing:{before:200},children:[T("Criterios del semáforo (moderado / alto)",{bold:true,size:16,color:NAVY})]}));
  body.push(new Paragraph({children:[T(critText(),{size:15,color:"323232"})]}));
  const footer=new Footer({children:[new Paragraph({children:[
    ...(logoB?[new ImageRun({data:logoB,transformation:{width:Math.round(18*LOGO_RATIO),height:18}}),T("  ")]:[]),
    T(`Elaborado por: ${autorTxt()} · Fuente de datos: Open-Meteo.com (CC BY 4.0) · Modelos ECMWF IFS 0,25°, NCEP GFS, DWD ICON     Página `,{size:13,color:"5A5A5A"}),
    new TextRun({children:[PageNumber.CURRENT],font:F,size:13,color:"5A5A5A"}),T(" de ",{size:13,color:"5A5A5A"}),new TextRun({children:[PageNumber.TOTAL_PAGES],font:F,size:13,color:"5A5A5A"})]})]});
  const doc=new Document({creator:autorTxt(),title,description:"Pronóstico de riesgo meteorológico por ciudad",
    styles:{default:{document:{run:{font:F,size:16}}}},
    sections:[{properties:{page:{size:{orientation:PageOrientation.LANDSCAPE,width:12240,height:15840},margin:{top:560,bottom:640,left:MARG,right:MARG,footer:280}}},
      footers:{default:footer},children:body}]});
  const blob=await Packer.toBlob(doc);
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=fileBase()+".docx";document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},2000);
  toast("Word generado");
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

/* ===================== Portal con usuarios (Cloudflare Worker) ===================== */
/* Si la página la sirve el portal, /api/sesion responde; en GitHub Pages no existe y se usa el modo con clave única. */
let PORTAL=null;   // null: modo GitHub; {usuario,nombre,rol,ciudades}: portal con sesión
async function detectarPortal(){
  try{
    const r=await fetch("api/sesion",{cache:"no-store",credentials:"same-origin"});
    if(r.status===401){location.replace("login.html");return "fuera"}
    if(r.ok&&(r.headers.get("Content-Type")||"").includes("json")){PORTAL=await r.json();return "portal"}
  }catch(e){}
  return "estatico";
}
async function api(path,opts){
  const r=await fetch("api/"+path,Object.assign({cache:"no-store",credentials:"same-origin"},opts||{},
    opts&&opts.body?{headers:{"Content-Type":"application/json"},body:JSON.stringify(opts.body)}:{}));
  if(r.status===401){location.replace("login.html");throw new Error("Sesión vencida")}
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.error||("HTTP "+r.status));
  return j;
}
async function salirPortal(){const b=$("uSalir");if(b){b.disabled=true;b.textContent="Cerrando…"}try{await api("logout",{method:"POST"})}catch(e){}location.replace("login.html")}
function cambiarClave(){
  const host=document.getElementById("modalHost")||document.body.appendChild(Object.assign(document.createElement("div"),{id:"modalHost"}));
  host.innerHTML=`<div class="mbg" id="cbg"><div class="modal"><h3>Cambiar mi clave</h3>
    <div class="meta">Usuario ${esc(PORTAL.usuario)}${PORTAL.nombre?" · "+esc(PORTAL.nombre):""}</div>
    <div class="fg"><label>Clave actual<input type="password" id="kA" autocomplete="current-password"></label><span></span>
    <label>Clave nueva (mínimo 6)<input type="password" id="kN" autocomplete="new-password"></label><label>Repetir clave nueva<input type="password" id="kR" autocomplete="new-password"></label></div>
    <div class="err" id="kE" style="color:#ff8a7a;font-size:13px;margin-top:8px"></div>
    <div class="btns"><button id="kC">Cancelar</button><button id="kG" class="pri">Guardar</button></div></div></div>`;
  const close=()=>host.innerHTML="";
  $("kC").onclick=close;$("cbg").onclick=e=>{if(e.target.id==="cbg")close()};
  $("kG").onclick=async()=>{
    if($("kN").value!==$("kR").value){$("kE").textContent="Las claves nuevas no coinciden";return}
    try{await api("clave",{method:"POST",body:{actual:$("kA").value,nueva:$("kN").value}});close();toast("Clave actualizada")}
    catch(e){$("kE").textContent=e.message}
  };
}
function barraUsuario(host,extra){
  host.innerHTML=`<span class="usr">👤 <b>${esc(PORTAL.usuario)}</b>${PORTAL.nombre?" · "+esc(PORTAL.nombre):""}</span>
    ${extra||""}${PORTAL.rol!=="admin"?'<button class="mini" id="uClave">Cambiar clave</button>':""}<button class="mini salir" id="uSalir" title="Cerrar la sesión en este equipo">Cerrar sesión ⎋</button>`;
  if($("uClave"))$("uClave").onclick=cambiarClave;
  $("uSalir").onclick=salirPortal;
}
