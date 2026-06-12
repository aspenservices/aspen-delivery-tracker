global.__dbgErr=0;
/* ============================================================================
 * Aspen Delivery Tracker — DEEP Google-Calendar Sync Simulator (real code)
 * ----------------------------------------------------------------------------
 * Loads the ACTUAL functions from index.html into per-device sandboxes:
 *   processGcalEvent, gcalAutoAudit, autoDedupByGcalId, gcalRepairCrossLinks,
 *   gcalDedup, planDedupByGcalId, the gcal_map 30s trackers + listener,
 *   parseGcalTitle / gcalDeliveryDD / isNonDeliveryTitle / isAllowedColor,
 *   saveA / saveE / chunked full-sync / dbAdded+dbEdits listeners / anti-wipe.
 * Only the OUTSIDE world is simulated: a virtual Google Calendar API
 * (change log + syncToken + pagination + 410 + cancelled events) and a virtual
 * Firebase (per-child writes, transactions, latency, stale/empty snapshots).
 *
 * Usage: node sim-gcal.js <index.html> <nScenarios> <seed0> [--devices=N]
 *
 * Hard-fail invariants at quiescence:
 *   I1 ONE_TICKET_PER_EVENT   every allowed live event has exactly one live ticket
 *   I2 CALENDAR_OWNERSHIP     linked ticket's dd/cal/color match the event
 *   I3 CUSTOMER_DATA_SACRED   sync never altered user-entered sentinel fields
 *   I4 CANCELLED_TO_HOLD      cancel ⇒ hold (data intact); uncancel ⇒ hold lifted
 *   I5 MAP_INTEGRITY          every gcal_map entry points at a live ticket
 *   I6 DELETED_STAYS_DELETED  ticket deleted while its event is cancelled never returns
 *   I7 FILTERS_RESPECTED      noise/disallowed/Sunday events never spawn tickets
 * ==========================================================================*/
'use strict';
const fs = require('fs');

const HTML_PATH = process.argv[2];
const N_SCEN    = parseInt(process.argv[3]||'200',10);
const SEED0     = parseInt(process.argv[4]||'1',10);
const DEV_FORCE = (()=>{let a=process.argv.find(x=>x.startsWith('--devices='));return a?parseInt(a.split('=')[1],10):null})();

const html = fs.readFileSync(HTML_PATH,'utf8');
const baseM = html.match(/const BASE=(\[[\s\S]*?\]);/);
const BASE_FIXTURE = baseM ? baseM[1] : '[]';

// ---- slice the real code blocks --------------------------------------------
function slice(startAnchor, endAnchor, label){
  const s=html.indexOf(startAnchor);
  const e=html.indexOf(endAnchor, s+1);
  if(s<0||e<=s) throw new Error('extraction failed: '+label+' ['+(s<0?'start':'end')+' anchor missing]');
  return html.slice(s,e);
}
// balanced matcher (string/comment/template aware) for an arbitrary pair
function matchPair(openIdx, OPEN, CLOSE){
  let i=openIdx, n=html.length, depth=0, inS=null, tplBrace=[];
  for(;i<n;i++){
    const c=html[i], c2=html[i+1];
    if(inS==='//'){ if(c==='\n')inS=null; continue; }
    if(inS==='/*'){ if(c==='*'&&c2==='/'){inS=null;i++;} continue; }
    if(inS==="'"||inS==='"'){ if(c==='\\'){i++;continue;} if(c===inS)inS=null; continue; }
    if(inS==='`'){ if(c==='\\'){i++;continue;}
      if(c==='$'&&c2==='{'){tplBrace.push(depth);inS=null;i++;continue;}
      if(c==='`')inS=null; continue; }
    if(c==='/'&&c2==='/'){inS='//';i++;continue;}
    if(c==='/'&&c2==='*'){inS='/*';i++;continue;}
    if(c==="'"||c==='"'||c==='`'){inS=c;continue;}
    if(tplBrace.length){ // inside ${ } of a template
      if(c==='{')depth++;
      else if(c==='}'){ if(depth===tplBrace[tplBrace.length-1]){tplBrace.pop();inS='`';} else depth--; }
      continue;
    }
    if(c===OPEN)depth++;
    if(c===CLOSE){depth--; if(depth===0)return i;}
  }
  throw new Error('matchPair: no close found from '+openIdx);
}
function matchBraced(openIdx){ const end=matchPair(openIdx,'{','}'); return html.slice(openIdx,end+1); }
function extractStatement(startAnchor,label){ // full balanced call statement incl ');'
  const s=html.indexOf(startAnchor);
  if(s<0)throw new Error('anchor missing: '+label);
  const lp=html.indexOf('(',s);
  const rp=matchPair(lp,'(',')');
  let end=rp+1; if(html[end]===';')end++;
  return html.slice(s,end);
}
function extractFunction(name,optional){
  const s=html.indexOf('function '+name);
  if(s<0){ if(optional){console.error('[extract] optional fn absent: '+name);return ''} throw new Error('function missing: '+name); }
  const open=html.indexOf('{',s);
  const body=matchBraced(open);
  return html.slice(s, open+body.length);
}
const B1a = slice("let _dirtyEdits=new Set", "// Attach all real-time data listeners", 'B1a sync-core');
const L_EDITS = extractStatement("dbEdits.on('value'", 'dbEdits listener');
const L_ADDED = extractStatement("dbAdded.on('value'", 'dbAdded listener');
const AW_DECL = (html.match(/let _antiWipeVerifyTimer[^\n]*\n/)||[''])[0];
const F_BANNER = extractFunction('showAntiWipeBanner',true);
const F_VERIFY = extractFunction('scheduleAntiWipeVerification',true);
const F_READERR= extractFunction('showReadErrorBanner',true);
const B2 = slice("function parseDate(dd)",          "function fmtDate",               'B2 parseDate');
const B3 = slice("const GCAL_DEFAULT_NAME",         "function gapiLoaded",            'B3 gcal-state+map');
const B4 = slice("function parseGcalTitle",         "// MANUAL CALENDAR RE-LINK",     'B4 parse+process');
const B5 = slice("function gcalRepairCrossLinks",   "function gcalToggleAuto",        'B5 repair+dedup+audit');
const F_DELDEL = extractFunction('deleteDelivery');
let REAL_SRC = [B1a, F_BANNER, AW_DECL, F_VERIFY, F_READERR, L_EDITS, L_ADDED, B2, B3, F_DELDEL, B4, B5].join('\n\n');
{ // sanity: every piece must parse standalone-ish (as part of the concatenation)
  const pieces={B1a,F_BANNER,F_VERIFY,F_READERR,L_EDITS,L_ADDED,B2,B3,F_DELDEL,B4,B5};
  for(const k in pieces){ try{ new Function(pieces[k]); }catch(e){
    console.error('[extract] piece '+k+' does not parse: '+e.message); process.exit(1); } }
}

// decls that live OUTSIDE the sliced blocks in the real file
const NEED_DECL = ['gcalToken','gcalCalendarId','gcalSyncToken','gcalCalendars','gcalTokenClient',
  'gcalGapiReady','gcalGisReady','gcalAutoTimer','gcalRefreshTimer','gcalSkipLog','gcalStats','gcalMap',
  '_gcalWritesInFlight'];
let missingDecls = NEED_DECL.filter(n=>!(new RegExp('\\b(let|const|var)\\b[^\\n;]*\\b'+n+'\\b').test(REAL_SRC)));

const PRELUDE = `
let ADDED=[],EDITS={},USERS={},curRec=null,currentUser={role:'admin',name:'sim'};
${missingDecls.map(n=>'let '+n+'='+(n==='gcalMap'?'{}':n==='gcalStats'?'{created:0,updated:0,skipped:0,sundayBlocked:0,errors:0}':n==='gcalSkipLog'?'[]':n==='gcalCalendars'?'[]':n==='_gcalWritesInFlight'?'0':'null')+';').join('\n')}
const BASE=${BASE_FIXTURE};
const __RealDate=globalThis.Date;
class Date extends __RealDate{
  constructor(...a){ if(a.length===0){super(__hooks.now())} else {super(...a)} }
  static now(){return __hooks.now()}
  static parse(s){return __RealDate.parse(s)}
  static UTC(...a){return __RealDate.UTC(...a)}
}
const setTimeout=(fn,ms)=>__hooks.setT(fn,ms), clearTimeout=id=>__hooks.clrT(id);
const setInterval=(fn,ms)=>__hooks.setT(fn,ms), clearInterval=id=>__hooks.clrT(id);
const console={log(...a){if(__hooks.fwd&&typeof a[0]==='string'&&/AUTO-AUDIT|AUTO-DEDUP|\[DEDUP\]|Merged stub|Idempotency|already claimed|takeover|deleted \(ledger\)|SN match|Stale mapping|CROSS-LINK|deferred/.test(a[0]))__hooks.fwd(a.map(x=>String(x).slice(0,140)).join(' '))},warn(){},error(...a){__hooks.err.n++;let joined=a.map(x=>x&&x.stack?String(x.stack).slice(0,400):String(x).slice(0,200)).join(' ');if(joined.indexOf('AUTO-AUDIT')>=0||joined.indexOf('AUTO-DEDUP')>=0){global.console.error('[SBERR]',joined)}else if(global.__dbgErr<8){global.__dbgErr++;global.console.error('[SANDBOX console.error]',joined)}},info(){}};
const localStorage={_m:{gcalWriteEnabled:'0'},getItem(k){return (k in this._m)?this._m[k]:null},setItem(k,v){this._m[k]=String(v)},removeItem(k){delete this._m[k]}};
function _mkEl(){const el={style:{},classList:{add(){},remove(){},toggle(){},contains(){return false}},dataset:{},remove(){},appendChild(){return el},removeChild(){},insertAdjacentHTML(){},setAttribute(){},getAttribute(){return null},addEventListener(){},querySelector(){return _mkEl()},querySelectorAll(){return []},closest(){return null},focus(){},click(){},set innerHTML(v){},get innerHTML(){return ''},set textContent(v){},get textContent(){return ''},set className(v){},get className(){return ''},onclick:null,onchange:null,checked:false,value:'',disabled:false};return el}
const document={getElementById(){return _mkEl()},createElement(){return _mkEl()},querySelector(){return _mkEl()},querySelectorAll(){return []},body:{appendChild(){},removeChild(){}}};
const Math=Object.assign(Object.create(globalThis.Math),{random:()=>__hooks.rnd()});
const navigator={onLine:true,serviceWorker:{register:()=>Promise.resolve({})},storage:{estimate:async()=>({usage:0,quota:1e9})}};
const window={addEventListener(){},removeEventListener(){},location:{href:'',search:'',reload(){}}};
const location=window.location;
function updateOfflineIndicator(){} function syncPulse(){}

const Blob=function(){}; const URL={createObjectURL:()=>'',revokeObjectURL(){}};
const confirm=()=>true, alert=()=>{}; function closeOv(){}
function showToast(){} function showSaveErrorBanner(){} function showReadErrorBanner2(){}
function getIntakeParams(){return null} function applyIntakeParams(){} function showLogin(){} function bootAfterAuth(){}
function loadSession(){return null} function saveSession(){} function renderLogin(){} function applySession(){return false}
function showAuthScreen(){} function hideAuthScreen(){} function renderUsersPanel(){} function populateTechDropdown(){}
function openBackupCenter(){} function renderAll(){} function renderAfterAuth(){}
function liveRefreshTechDetail(){} function updateGcalUI(){} function refreshGcalColorCheckboxes(){}
function escHtml(x){return String(x)}
function gcalColorName(x){return String(x)}
const dbEdits={update:p=>__hooks.fbWrite('edits',p),set:v=>__hooks.fbSet('edits',v),on:(t,cb)=>__hooks.reg('edits',cb),once:()=>__hooks.fbOnce('edits')};
const dbAdded={update:p=>__hooks.fbWrite('added',p),set:v=>__hooks.fbSet('added',v),on:(t,cb)=>__hooks.reg('added',cb),once:()=>__hooks.fbOnce('added')};
const dbGcal={update:p=>__hooks.fbWrite('gcalCfg',p),on:(t,cb)=>__hooks.reg('gcalCfg',cb)};
const dbGcalMap={on:(t,cb)=>__hooks.reg('map',cb),once:()=>__hooks.fbOnce('map'),
  child:id=>({transaction:fn=>__hooks.mapTxn(id,fn)})};
function _nodeOf(p){p=String(p||'').split('/')[0];return p==='gcal_map'?'map':(p==='deleted_tickets'?'deleted':p)}
const db={ref:path=>({
  update:o=>{ if(path){let m={};for(const k in o)m[path+'/'+k]=o[k];return __hooks.multi(m)} return __hooks.multi(o) },
  set:v=>__hooks.multi({[path]:v}),
  remove:()=>__hooks.multi({[path]:null}),
  on:(t,cb)=>__hooks.reg(_nodeOf(path),cb),
  once:()=>__hooks.fbOnce(_nodeOf(path)),
  child:k=>db.ref((path?path+'/':'')+k)
})};
const gapi={client:{calendar:{events:{list:p=>__hooks.gapiList(p)}}}};
const firebase={database:{ServerValue:{TIMESTAMP:0}}};
`;

const HELPERS = `
gcalToken='tok'; gcalCalendarId='aspen';
function __forceAudit(){ if(typeof _gcalAuditInFlight!=='undefined'){_gcalAuditInFlight=false;_gcalLastAuditAt=0} }
function __getToken(){return gcalSyncToken} function __setToken(v){gcalSyncToken=v}
function __ADDED(){return ADDED} function __EDITS(){return EDITS} function __MAP(){return gcalMap}
function __AD(){return AD()}
function __seedLocal(addedArr,editsObj,mapObj){ADDED=addedArr;EDITS=editsObj;gcalMap=mapObj}
function __delTicket(id){
  // call the REAL deleteDelivery() — auto-adapts to whatever semantics this file ships
  if(!findRecById(id))return false;
  deleteDelivery(id);
  return true}
function __editTicket(id,f,v){
  let ai=ADDED.findIndex(x=>sameId(x.i,id));
  if(ai>=0){ADDED[ai][f]=v;rememberAddedEdit(ADDED[ai]);saveA();return true}
  if(findRecById(id)){if(!EDITS[id])EDITS[id]={};EDITS[id][f]=v;rememberEditsEdit(id,EDITS[id]);saveE();return true}
  return false}
__exports.processGcalEvent=processGcalEvent;
__exports.autoDedupByGcalId=autoDedupByGcalId;
__exports.gcalAutoAudit=(typeof gcalAutoAudit==='function')?gcalAutoAudit:null;
__exports.parseGcalTitle=parseGcalTitle;
__exports.gcalDeliveryDD=gcalDeliveryDD;
__exports.isNonDeliveryTitle=isNonDeliveryTitle;
__exports.isAllowedColor=isAllowedColor;
__exports.__forceAudit=__forceAudit; __exports.__getToken=__getToken; __exports.__setToken=__setToken;
__exports.__ADDED=__ADDED; __exports.__EDITS=__EDITS; __exports.__MAP=__MAP; __exports.__AD=__AD;
__exports.__seedLocal=__seedLocal; __exports.__delTicket=__delTicket; __exports.__editTicket=__editTicket;
function __sif(){return {a:_saveInFlight.added,e:_saveInFlight.edits,g:(typeof _gcalWritesInFlight!=='undefined'?_gcalWritesInFlight:0),aud:(typeof _gcalAuditInFlight!=='undefined'?_gcalAuditInFlight:false)}}
__exports.__sif=__sif;
function __auditProbe(){return {tok:!!gcalToken,cal:!!gcalCalendarId,inFl:_gcalAuditInFlight,sA:_saveInFlight.added,sE:_saveInFlight.edits,g:(typeof _gcalWritesInFlight!=='undefined'?_gcalWritesInFlight:0),since:Date.now()-_gcalLastAuditAt}}
__exports.__auditProbe=__auditProbe;
__exports.__lastAudit=()=>_gcalLastAuditAt;
`;

function buildSandbox(hooks){
  const __hooks=hooks; let __exports={};
  eval(PRELUDE + REAL_SRC + '\n' + HELPERS);
  return __exports;
}

// ---- deterministic RNG ------------------------------------------------------
function rng(seed){let a=seed>>>0;return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};}
const flush=async(n=10)=>{for(let i=0;i<n;i++)await null;};

// ===========================================================================
//  VIRTUAL GOOGLE CALENDAR (change log + syncToken + 410 + pagination)
// ===========================================================================
class VCal{
  constructor(){ this.events={}; this.log=[]; this.seq=0; this.minSeq=0; }
  _touch(id){ this.seq++; this.log.push({seq:this.seq,id}); }
  create(id,ev){ this.events[id]=Object.assign({id,status:'confirmed'},ev); this._touch(id); }
  patch(id,p){ if(!this.events[id])return; Object.assign(this.events[id],p); this._touch(id); }
  cancel(id){ if(!this.events[id])return; this.events[id].status='cancelled'; this._touch(id); }
  uncancel(id){ if(!this.events[id])return; this.events[id].status='confirmed'; this._touch(id); }
  prune(){ this.minSeq=this.seq; this.log=[]; }   // expires every outstanding syncToken (410)
  listChanges(token,pageToken,pageSize){
    const t=parseInt(token,10);
    if(isNaN(t)||t<this.minSeq) return {error410:true};
    const ids=[]; const seen=new Set();
    for(const e of this.log){ if(e.seq>t && !seen.has(e.id)){seen.add(e.id);ids.push(e.id);} }
    const off=pageToken?parseInt(pageToken,10):0;
    const page=ids.slice(off,off+pageSize);
    const items=page.map(id=>JSON.parse(JSON.stringify(this.events[id])));
    const next=(off+pageSize<ids.length)?String(off+pageSize):null;
    return {items, nextPageToken:next, nextSyncToken:next?null:String(this.seq)};
  }
  listFull(timeMinISO,pageToken,pageSize){
    const tm=timeMinISO?timeMinISO.slice(0,10):null;
    const ids=Object.keys(this.events).filter(id=>{
      const ev=this.events[id]; const d=ev.start&&(ev.start.date||String(ev.start.dateTime||'').slice(0,10));
      return !tm||!d||d>=tm;
    }).sort();
    const off=pageToken?parseInt(pageToken,10):0;
    const page=ids.slice(off,off+pageSize);
    return {items:page.map(id=>JSON.parse(JSON.stringify(this.events[id]))),
      nextPageToken:(off+pageSize<ids.length)?String(off+pageSize):null,
      nextSyncToken:(off+pageSize<ids.length)?null:String(this.seq)};
  }
  listWindow(timeMinISO,timeMaxISO){ // audit path: cancelled excluded (matches real API default)
    const a=timeMinISO.slice(0,10), b=timeMaxISO.slice(0,10);
    return Object.values(this.events).filter(ev=>{
      if(ev.status==='cancelled')return false;
      const d=ev.start&&(ev.start.date||String(ev.start.dateTime||'').slice(0,10));
      return d&&d>=a&&d<=b;
    }).map(ev=>JSON.parse(JSON.stringify(ev)));
  }
}

// ===========================================================================
//  SIMULATION ENGINE (virtual clock, async-aware)
// ===========================================================================
class Sim{
  constructor(seed){
    this.rnd=rng(seed); this.t=Date.UTC(2026,5,11,12,0,0); this.q=[]; this._tid=1; this.pending=0;
    this.server={edits:{},added:{},map:{},gcalCfg:{calendarId:'aspen',colors:['11','10','6']},deleted:{}};
    this.cal=new VCal();
    this.devices=[];
    this.stats={syncs:0,audits:0,evProcessed:0,claims:0,claimLosses:0,aborts:0,g410:0,
      fbWrites:0,snapshots:0,staleSnaps:0,emptySnaps:0,mapGlitches:0,calMutations:0,sandboxErrors:0};
  }
  R(n){return Math.floor(this.rnd()*n)}
  push(t,fn){const id=this._tid++;this.q.push({t,seq:id,fn,id});return id}
  cancel(id){const i=this.q.findIndex(e=>e.id===id);if(i>=0)this.q.splice(i,1)}
  makeHooks(dev){
    const sim=this; const errBox={n:0};
    return {
      err:errBox,
      now:()=>sim.t,
      rnd:()=>sim.rnd(),
      fwd:(m)=>{ if(typeof TRSEED!=='undefined'&&TRSEED!=null&&sim.__seed===TRSEED) globalThis.console.error('[FWD t='+sim.t+']',m); },
      setT:(fn,ms)=>sim.push(sim.t+Math.max(0,ms|0),fn),
      clrT:id=>sim.cancel(id),
      reg:(node,cb)=>{dev.listeners[node]=cb;
        // FIDELITY: Firebase fires 'value' immediately with the CURRENT state on attach.
        // Without this initial emission a device could sit for seconds with empty local
        // state (e.g. _addedNodeMigrated stuck false → destructive legacy whole-node set).
        const snap0=JSON.parse(JSON.stringify(sim.server[node]??{}));
        sim.push(sim.t+1+sim.R(4),()=>{ try{cb({val:()=>snap0}) }catch(e){ sim.stats.sandboxErrors++; } });
      },
      fbWrite:(node,payload)=>new Promise(res=>{
        sim.stats.fbWrites++;
        sim.push(sim.t+15+sim.R(110),()=>{
          if(node==='gcalCfg'){ Object.assign(sim.server.gcalCfg,payload); }
          else{ const n=sim.server[node]||(sim.server[node]={}); for(const k in payload){
            const parts=String(k).split('/');
            if(TRTID&&node==='added'&&parts[0]===TRTID)TR(sim,'ADDWRITE',dev.id,k,'=',JSON.stringify(payload[k]).slice(0,90));
            if(parts.length>1){ // nested field write: 'ticketId/field' (Firebase path-key update)
              const child=parts[0], fld=parts[1];
              if(payload[k]===null){ if(n[child]&&typeof n[child]==='object')delete n[child][fld]; }
              else{ if(!n[child]||typeof n[child]!=='object')n[child]={}; n[child][fld]=JSON.parse(JSON.stringify(payload[k])); }
            }
            else if(payload[k]===null)delete n[k]; else n[k]=JSON.parse(JSON.stringify(payload[k])); } }
          res();
          sim.broadcast(node);
        });
      }),
      fbSet:(node,value)=>new Promise(res=>{
        sim.stats.fbWrites++;
        sim.push(sim.t+15+sim.R(110),()=>{
          // Firebase .set REPLACES the node. Arrays become index-keyed objects server-side.
          let v=JSON.parse(JSON.stringify(value));
          if(Array.isArray(v)){ const o={}; v.forEach((r,i)=>{ if(r!=null) o[ (r&&r.i!=null)?String(r.i):String(i) ]=r; }); v=o; }
          if(TRTID&&node==='added')TR(sim,'ADDSET',dev.id,'replaces node; has '+TRTID+'?',!!(v&&v[TRTID]),'hold='+(v&&v[TRTID]&&v[TRTID].hold));
          sim.server[node]=v||{};
          res();
          sim.broadcast(node);
        });
      }),
      multi:(m)=>new Promise(res=>{
        sim.stats.fbWrites++;
        sim.push(sim.t+15+sim.R(110),()=>{
          let touched=new Set();
          for(const k in m){
            const parts=k.split('/');
            const node=parts[0]==='gcal_map'?'map':(parts[0]==='deleted_tickets'?'deleted':parts[0]);
            const child=parts.slice(1).join('/');
            if(!sim.server[node])continue;
            if(child){ if(m[k]===null)delete sim.server[node][child]; else sim.server[node][child]=JSON.parse(JSON.stringify(m[k])); if(typeof TREV!=='undefined'&&node==='map'&&child===TREV)TR(sim,'MAPWRITE',dev.id,k,'=',m[k]); }
            touched.add(node);
          }
          res(); touched.forEach(n=>sim.broadcast(n));
        });
      }),
      fbOnce:(node)=>new Promise(res=>{
        sim.push(sim.t+10+sim.R(40),()=>res({val:()=>JSON.parse(JSON.stringify(sim.server[node==='map'?'map':node]))}));
      }),
      mapTxn:(id,fn)=>new Promise(res=>{
        sim.stats.claims++; if(typeof TREV!=='undefined'&&id===TREV)TR(sim,'CLAIM',dev.id,'cur='+((id in sim.server.map)?sim.server.map[id]:null));
        sim.push(sim.t+10+sim.R(60),()=>{
          const cur=(id in sim.server.map)?sim.server.map[id]:null;
          const out=fn(cur);
          let committed=false;
          if(out!==undefined){ if(out===undefined){/* aborted: no write */}else if(out===null){delete sim.server.map[id];}else{sim.server.map[id]=out;} if(typeof trEv==='function'&&trEv(id))TR(sim,'TXNSET',dev.id,id,'=',JSON.stringify(out===undefined?'(abort)':out),'(cur was '+JSON.stringify(cur)+')'); committed=true; }
          const val=sim.server.map[id];
          if(committed && cur!==null && String(val)!==String(cur)) {/*overwrite path: claim fn never does this*/}
          if(cur!==null) sim.stats.claimLosses++; // a second device raced the same event
          res({committed,snapshot:{val:()=>val}});
          sim.broadcast('map');
        });
      }),
      gapiList:(p)=>new Promise((res,rej)=>{
        sim.push(sim.t+20+sim.R(80),()=>{
          if(p.timeMin&&p.timeMax){ res({result:{items:sim.cal.listWindow(p.timeMin,p.timeMax)}}); return; }
          rej(new Error('unexpected gapi.list params in sandbox'));
        });
      }),
    };
  }
  broadcast(node){
    const clean=JSON.stringify(this.server[node==='gcalCfg'?'gcalCfg':node]);
    this.devices.forEach(d=>{
      if(!d.listeners[node])return;
      let at=this.t+10+this.R(120), payload=clean, roll=this.rnd();
      if(node==='map'&&roll<0.04){ payload='{}'; this.stats.mapGlitches++; }
      else if(node!=='gcalCfg'&&roll<0.04){ payload='{}'; this.stats.emptySnaps++; }
      else if(roll<0.24){ at+=60+this.R(220); this.stats.staleSnaps++; }
      this.push(at,()=>{ this.stats.snapshots++;
        try{ d.listeners[node]({val:()=>JSON.parse(payload)}); }catch(e){ this.stats.sandboxErrors++; if(global.__dbgErr<6){global.__dbgErr++;console.error('[LISTENER-ERR]',node,e&&e.message);} }
      });
    });
  }
  async drain(maxIdleSpins=4000){
    let spins=0;
    while(true){
      if(this.q.length){
        let bi=0;
        for(let i=1;i<this.q.length;i++){const a=this.q[i],b=this.q[bi];
          if(a.t<b.t||(a.t===b.t&&a.seq<b.seq))bi=i;}
        const ev=this.q.splice(bi,1)[0];
        this.t=ev.t;
        try{ ev.fn(); }catch(e){ this.stats.sandboxErrors++; if(global.__dbgErr<6){global.__dbgErr++;console.error('[QUEUE-ERR]',e&&e.message,(e&&e.stack||'').split('\n')[1]||'');} }
        await flush(); spins=0;
      } else if(this.pending>0){
        await flush(); spins++;
        if(spins>maxIdleSpins) break; // deadlock guard
      } else break;
    }
  }
}

// ---- per-device wrapper ------------------------------------------------------
class Dev{
  constructor(id,sim){
    this.id=id; this.sim=sim; this.listeners={};
    this.api=buildSandbox(sim.makeHooks(this));
    this.syncRunning=false; this.errors=0;
  }
  // faithful re-implementation of the real gcalSync() I/O loop (the inner per-event
  // logic + dedup + token-after-processing are the REAL functions)
  async sync(abortAfter){
    if(this.syncRunning)return; this.syncRunning=true; const sim=this.sim;
    sim.pending++; sim.stats.syncs++;
    try{
      let token=this.api.__getToken();
      let items=[], nextSync=null, pageToken=null;
      const PAGE=7;
      const pull=async(mode)=>{
        items=[]; pageToken=null; nextSync=null;
        do{
          await new Promise(r=>sim.push(sim.t+15+sim.R(60),r)); // network latency
          let res=(mode==='inc')?sim.cal.listChanges(token,pageToken,PAGE)
                                :sim.cal.listFull(this._todayISO(),pageToken,PAGE);
          if(res.error410){ sim.stats.g410++; token=null; this.api.__setToken(null);
            await this.listenersSafeCfg({syncToken:null}); return pull('full'); }
          items=items.concat(res.items); pageToken=res.nextPageToken;
          if(res.nextSyncToken)nextSync=res.nextSyncToken;
        }while(pageToken);
      };
      await pull(token!=null?'inc':'full');
      let n=0;
      for(const ev of items){
        if(abortAfter!=null && n>=abortAfter){ sim.stats.aborts++; throw {__abort:true}; }
        if(TREV&&ev.id===TREV)TR(sim,'SYNC',this.id,'status='+ev.status,'color='+ev.colorId,'date='+(ev.start&&ev.start.date),'mapSrv='+sim.server.map[ev.id],'mapLoc='+this.api.__MAP()[ev.id],'localTids='+this.api.__AD().filter(r=>String(r.gcalId)===TREV).map(r=>r.i).join(','));
        await this.api.processGcalEvent(ev);            // REAL CODE
        if(TREV&&ev.id===TREV){let _tid=sim.server.map[ev.id];let _srv=_tid!=null?sim.server.added[String(_tid)]:null;TR(sim,'SYNC-after',this.id,'mapSrv='+_tid,'srvHold='+(_srv&&_srv.hold),'srvDel='+(_srv&&_srv._deleted),'ledger='+(_tid!=null&&!!sim.server.deleted[String(_tid)]),'localTids='+this.api.__AD().filter(r=>String(r.gcalId)===TREV).map(r=>r.i).join(','));}
        sim.stats.evProcessed++; n++;
      }
      await this.api.autoDedupByGcalId();               // REAL CODE
      if(nextSync!=null){ this.api.__setToken(nextSync);
        await this.listenersSafeCfg({syncToken:nextSync,lastSync:sim.t}); } // token AFTER processing
    }catch(e){ if(!e||!e.__abort)this.errors++; }
    finally{ this.syncRunning=false; sim.pending--; }
  }
  listenersSafeCfg(p){ return new Promise(res=>{ const sim=this.sim;
    sim.push(sim.t+15+sim.R(80),()=>{ Object.assign(sim.server.gcalCfg,p); res(); sim.broadcast('gcalCfg'); }); }); }
  async audit(){
    if(!this.api.gcalAutoAudit)return;
    const sim=this.sim; sim.pending++; sim.stats.audits++;
    if(typeof TREV!=='undefined'&&TREV)TR(sim,'AUDIT-start',this.id,JSON.stringify(this.api.__auditProbe&&this.api.__auditProbe()));
    try{ await this.api.gcalAutoAudit(); }catch(e){ this.errors++; }
    finally{ if(typeof TREV!=='undefined'&&TREV)TR(sim,'AUDIT-end',this.id,'mapSrv='+sim.server.map[TREV],'lastAuditAt='+(this.api.__lastAudit&&this.api.__lastAudit())); sim.pending--; }
  }
  _todayISO(){ return '2026-06-11T00:00:00.000Z'; }
}

// ===========================================================================
//  SCENARIO
// ===========================================================================
// per-scenario event counter lives inside runScenario for deterministic ids
const CITIES=['Crestwood','Webster','Chesterfield','Innsbr','Fenton','Ballwin'];
const NAMES=['Vargon','Wolfe','Sellers','Jayne','Reeb','Kaufmann','Heimos','Rose','Tschopp','Hjorth'];
function dStr(off){ const d=new Date(Date.UTC(2026,5,12)); d.setUTCDate(d.getUTCDate()+off); return d.toISOString().slice(0,10); }

const TRACE=(process.env.TRACE||'').split(':');
const TRSEED=TRACE[0]?parseInt(TRACE[0],10):null, TREV=TRACE[1]||null;
const TRTID=process.env.TRTID||null;
function TR(sim,...a){ if(TRSEED!=null&&sim.__seed===TRSEED) console.error('[TR t='+sim.t+']',...a); }
async function runScenario(seed,nDevForce){
  let GEV=0;
  const sim=new Sim(seed); sim.__seed=seed;
  const D=nDevForce!=null?nDevForce:(2+sim.R(5));
  for(let i=0;i<D;i++) sim.devices.push(new Dev('D'+i,sim));

  const track={ events:{}, sentinels:{}, deletedWhileCancelled:new Set(), deletedWhileLive:new Set() };
  const mkTitle=(name,sn,city,slot)=>{
    slot=slot||['AM','PM','ALL DAY+Haul'][sim.R(3)];
    const sep=sim.rnd()<0.2?' - ':'-';
    return slot+sep+name+sep+(sn||'')+(sn?sep:'')+city;
  };
  const newDelivery=()=>{
    const id='ev'+(++GEV);
    const sn=String(29000+sim.R(3000));
    const title=mkTitle(NAMES[sim.R(NAMES.length)]+GEV,sn,CITIES[sim.R(CITIES.length)]);
    const off=1+sim.R(40); let date=dStr(off);
    const colors=['11','10','6','11','10','6','5',undefined]; // mostly allowed, some not
    const colorId=colors[sim.R(colors.length)];
    const ev={summary:title,colorId,start:{date},end:{date}};
    sim.cal.create(id,ev); sim.stats.calMutations++;
    track.events[id]={everAllowed:false,cancelledOnce:false};
    return id;
  };
  const noiseTitles=['HOLIDAY','WEEK A Chem. Maint.','**PM MUST BE CLOSE**','PM-Service','COLOR = SLOT NOT AVAILABLE','AWAITING CONFIRMATION'];

  // seed calendar
  const nSeed=8+sim.R(14);
  for(let i=0;i<nSeed;i++) newDelivery();
  for(let i=0;i<2+sim.R(3);i++){ const id='nz'+(++GEV);
    sim.cal.create(id,{summary:noiseTitles[sim.R(noiseTitles.length)],colorId:'11',start:{date:dStr(2+sim.R(30))},end:{date:dStr(3)}});
    track.events[id]={noise:true,everAllowed:false}; sim.stats.calMutations++; }

  // initial sync on one device so others join mid-history
  sim.push(sim.t+10,()=>{ sim.devices[0].sync(null); });

  // scenario ops over virtual time
  let tcur=sim.t+400;
  const steps=22+sim.R(34);
  for(let s=0;s<steps;s++){
    tcur+=200+sim.R(1200);
    sim.push(tcur,()=>{
      const roll=sim.rnd(); const ids=Object.keys(sim.cal.events).filter(k=>!track.events[k].noise);
      const pick=()=>ids.length?ids[sim.R(ids.length)]:null;
      if(roll<0.16){ newDelivery(); }
      else if(roll<0.30){ const id=pick(); if(id){ const nd=dStr(1+sim.R(45)); sim.cal.patch(id,{start:{date:nd},end:{date:nd}}); sim.stats.calMutations++; if(id===TREV)TR(sim,'CAL moveDate',id,nd); } }
      else if(roll<0.40){ const id=pick(); if(id){ const c=['11','10','6','5',undefined][sim.R(5)]; sim.cal.patch(id,{colorId:c}); sim.stats.calMutations++; if(id===TREV)TR(sim,'CAL color',id,c); } }
      else if(roll<0.48){ const id=pick(); if(id&&sim.cal.events[id].status==='confirmed'){ sim.cal.cancel(id); track.events[id].cancelledOnce=true; sim.stats.calMutations++; if(id===TREV)TR(sim,'CAL cancel',id); } }
      else if(roll<0.54){ const cs=ids.filter(k=>sim.cal.events[k].status==='cancelled'); if(cs.length){ {const uid=cs[sim.R(cs.length)];sim.cal.uncancel(uid); sim.stats.calMutations++; if(uid===TREV)TR(sim,'CAL uncancel',uid);} } }
      else if(roll<0.60){ const id=pick(); if(id){ const ev=sim.cal.events[id]; const p=ev.summary.split(/-+/); {const ns=mkTitle('Renamed'+sim.R(99),(p.find(x=>/^\d{4,6}$/.test(x.trim()))||'').trim(),CITIES[sim.R(CITIES.length)]);sim.cal.patch(id,{summary:ns}); sim.stats.calMutations++; if(id===TREV)TR(sim,'CAL rename',id,JSON.stringify(ns));} } }
      else if(roll<0.66&&sim.rnd()<0.5){ sim.cal.prune(); } // expire all syncTokens → 410 path
      else if(roll<0.80){ // device sync (sometimes a burst → claim contention)
        const burst=1+(sim.rnd()<0.3?sim.R(Math.min(3,D)):0);
        for(let b=0;b<burst;b++){ const d=sim.devices[sim.R(D)];
          const abort=(sim.rnd()<0.12)?sim.R(5):null;
          sim.push(sim.t+b*120,()=>d.sync(abort)); }
      }
      else if(roll<0.88){ // device edits sentinel customer data on a linked ticket
        const d=sim.devices[sim.R(D)]; const live=d.api.__AD().filter(r=>r.gcalId&&!r._deleted);
        if(live.length){ const r=live[sim.R(live.length)]; const v='SENT-'+sim.R(1e6);
          if(d.api.__editTicket(r.i,'ph',v)){ let e=track.sentinels[String(r.i)]=track.sentinels[String(r.i)]||{f:'ph',vals:new Set()}; e.vals.add(String(v)); e.ts=sim.t; if(TRSEED!=null&&sim.__seed===TRSEED)TR(sim,'USER editPh',d.id,'tid='+r.i,v); } }
      }
      else if(roll<0.94){ // device deletes a linked ticket
        const d=sim.devices[sim.R(D)]; const live=d.api.__AD().filter(r=>r.gcalId&&!r._deleted);
        if(live.length){ const r=live[sim.R(live.length)]; const evId=String(r.gcalId);
          const cancelled=sim.cal.events[evId]&&sim.cal.events[evId].status==='cancelled';
          if(d.api.__delTicket(r.i)){ if(String(r.gcalId)===TREV)TR(sim,'USER delTicket',d.id,'tid='+r.i,'evCancelled='+cancelled); delete track.sentinels[String(r.i)];
            (cancelled?track.deletedWhileCancelled:track.deletedWhileLive).add(String(r.i)); } }
      }
      else { const d=sim.devices[sim.R(D)]; d.audit(); }
    });
  }
  await sim.drain();

  // ---- QUIESCENCE: every device does a clean full pass, then audits, then settles
  for(const d of sim.devices){ sim.push(sim.t+200,()=>d.sync(null)); await sim.drain(); }
  for(const d of sim.devices){ d.api.__forceAudit(); sim.push(sim.t+200,()=>d.audit()); await sim.drain(); }
  for(const d of sim.devices){ sim.push(sim.t+200,()=>d.sync(null)); await sim.drain(); }
  for(const d of sim.devices){ d.api.__forceAudit(); sim.push(sim.t+200,()=>d.audit()); await sim.drain(); }
  sim.t+=31000; sim.broadcast('added'); sim.broadcast('edits'); sim.broadcast('map'); sim.broadcast('deleted');
  await sim.drain();

  // ---- ORACLE + INVARIANTS ---------------------------------------------------
  const oracle=sim.devices[0].api;
  const liveTickets=(()=>{ // ground truth from SERVER
    const ed=sim.server.edits, ad=sim.server.added;
    const baseArr=JSON.parse(BASE_FIXTURE);
    const merged=baseArr.map(r=>ed[r.i]?Object.assign({},r,ed[r.i]):r)
      .concat(Object.values(ad)).filter(r=>!r._deleted);
    const m={}; merged.forEach(r=>{ if(r.i!=null)m[String(r.i)]=r; }); return m;
  })();
  const byGcalId={}; Object.values(liveTickets).forEach(r=>{ if(r.gcalId){(byGcalId[String(r.gcalId)]=byGcalId[String(r.gcalId)]||[]).push(r)} });

  const fails=[];
  for(const evId of Object.keys(sim.cal.events)){
    const ev=sim.cal.events[evId]; const tr=track.events[evId]||{};
    const parsed=oracle.parseGcalTitle(ev.summary);
    const dd=oracle.gcalDeliveryDD(ev,parsed);
    const sundayBlocked=(()=>{ if(!dd)return false; const p=dd.split(' ')[0].split('-').map(Number);
      return new Date(Date.UTC(p[0],p[1]-1,p[2])).getUTCDay()===0; })();
    const allowedNow = ev.status==='confirmed' && !oracle.isNonDeliveryTitle(ev.summary)
      && oracle.isAllowedColor(ev.colorId) && !!dd && !sundayBlocked;
    if(allowedNow) tr.everAllowed=true;

    const direct=byGcalId[evId]||[];
    const mapped=sim.server.map[evId]!=null?liveTickets[String(sim.server.map[evId])]:null;
    const linkSet=new Map(); direct.forEach(r=>linkSet.set(String(r.i),r)); if(mapped)linkSet.set(String(mapped.i),mapped);
    const linked=[...linkSet.values()];

    if(linked.length>1) fails.push({type:'I1_DUPLICATE',evId,count:linked.length});
    if(allowedNow && linked.length===0) fails.push({type:'I1_MISSING',evId,title:ev.summary});
    if(allowedNow && linked.length===1){
      const r=linked[0];
      if(!r.hold && !r.co){
        const fl={co:!!r.co,dl:!!r.dl,hold:!!r.hold,sl:!!r.sl,oo:!!r.oo,gid:r.gcalId};
        if(r.dd!==dd) fails.push({type:'I2_DATE',evId,ticket:r.i,have:r.dd,want:dd,fl});
        if((r.cal||'')!==(ev.summary||'').trim()) fails.push({type:'I2_TITLE',evId,ticket:r.i,haveT:r.cal,wantT:(ev.summary||'').trim(),fl});
        if(String(r.gcalColorId||'')!==String(ev.colorId||'')) fails.push({type:'I2_COLOR',evId,ticket:r.i,have:r.gcalColorId,want:ev.colorId,fl});
      }
    }
    if(ev.status==='cancelled' && linked.length===1 && !linked[0].co && !linked[0].hold)
      fails.push({type:'I4_NOT_HELD',evId,ticket:linked[0].i,gid:linked[0].gcalId,mapped:sim.server.map[evId],editT:(track.sentinels[String(linked[0].i)]||{}).ts,fl:{dl:!!linked[0].dl,sl:!!linked[0].sl,oo:!!linked[0].oo}});
    if(ev.status==='confirmed' && tr.cancelledOnce && linked.length===1 && linked[0].hold && allowedNow)
      fails.push({type:'I4_HOLD_NOT_LIFTED',evId,ticket:linked[0].i});
    if(!tr.everAllowed && !tr.noise===false){}
    if(!tr.everAllowed && linked.length>0 && tr.noise) fails.push({type:'I7_NOISE_TICKET',evId});
  }
  // I5 map integrity
  for(const evId in sim.server.map){
    const tid=String(sim.server.map[evId]);
    if(!liveTickets[tid]) fails.push({type:'I5_STALE_MAP',evId,tid,srvDel:!!(sim.server.added[tid]&&sim.server.added[tid]._deleted),srvExists:!!sim.server.added[tid],ledg:!!sim.server.deleted[tid],evStatus:sim.cal.events[evId]&&sim.cal.events[evId].status});
  }
  // I3 sentinels
  for(const tid in track.sentinels){
    const s=track.sentinels[tid]; const r=liveTickets[tid];
    if(r && !s.vals.has(String(r[s.f]||''))) fails.push({type:'I3_CUSTOMER_DATA',tid,field:s.f,have:r[s.f],want:[...s.vals].join('|')});
  }
  // I6 deleted-while-cancelled stays deleted
  for(const tid of track.deletedWhileCancelled){
    if(liveTickets[tid]) fails.push({type:'I6_RESURRECTED',tid});
  }
  return {fails,stats:sim.stats,devices:D};
}

// ===========================================================================
(async ()=>{
  const t0=Date.now();
  const agg={syncs:0,audits:0,evProcessed:0,claims:0,claimLosses:0,aborts:0,g410:0,
    fbWrites:0,snapshots:0,staleSnaps:0,emptySnaps:0,mapGlitches:0,calMutations:0,sandboxErrors:0};
  const failCounts={}; let failedScen=0, devTotal=0; const failSamples=[];
  for(let i=0;i<N_SCEN;i++){
    const r=await runScenario(SEED0+i, DEV_FORCE);
    for(const k in agg)agg[k]+=r.stats[k];
    devTotal+=r.devices;
    if(r.fails.length){ failedScen++;
      r.fails.forEach(f=>failCounts[f.type]=(failCounts[f.type]||0)+1);
      if(failSamples.length<200) failSamples.push({seed:SEED0+i,fails:r.fails.slice(0,4)});
    }
  }
  console.log(JSON.stringify({file:HTML_PATH,scenarios:N_SCEN,seed0:SEED0,devicesForced:DEV_FORCE,devTotal,
    agg,failCounts,failedScenarios:failedScen,failSamples,secs:((Date.now()-t0)/1000).toFixed(1)},null,2));
})();
