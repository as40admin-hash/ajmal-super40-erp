/*
 * Cloudflare Pages compatibility bridge.
 * Keeps the existing ERP UI/business workflow code unchanged by providing
 * the same google.script.run chaining shape over the /api Pages Function.
 */
(function installAppsScriptBridge(){
  const API_PATH = '/api';

  async function callApi(action, args) {
    const response = await fetch(API_PATH, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
      },
      body: JSON.stringify({action, args})
    });

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      throw new Error(`ERP API returned invalid JSON (HTTP ${response.status}).`);
    }

    if (!response.ok || !payload || payload.ok === false) {
      throw new Error(payload?.error || `ERP API request failed (HTTP ${response.status}).`);
    }

    // Every successful server mutation may return the authoritative post-write
    // ERP snapshot. Apply it immediately so Cloudflare-hosted state follows
    // the same authoritative write/read cycle as the working Apps Script UI.
    if (payload && payload.data && typeof window.__applyERPApiSnapshot === 'function') {
      window.__applyERPApiSnapshot(payload.data);
    }

    return payload;
  }

  function makeRunner(config){
    const cfg = config || {};
    return new Proxy({}, {
      get(_target, property){
        if(property === 'withSuccessHandler'){
          return handler => makeRunner({...cfg, success: typeof handler === 'function' ? handler : null});
        }
        if(property === 'withFailureHandler'){
          return handler => makeRunner({...cfg, failure: typeof handler === 'function' ? handler : null});
        }
        if(property === 'withUserObject'){
          return userObject => makeRunner({...cfg, userObject});
        }
        if(property === 'then') return undefined;

        return (...args) => {
          callApi(String(property), args)
            .then(result => {
              if(cfg.success) cfg.success(result, cfg.userObject);
            })
            .catch(error => {
              const errObj = error instanceof Error ? error : new Error(String(error));
              if(cfg.failure) cfg.failure(errObj, cfg.userObject);
              else console.error('ERP API request failed:', errObj);
            });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner();
})();

const state = {
  page: 'dashboard',
  data: { branches: [], batches: [], campuses: [], calendar: [], attendance: [], students: [], allocations: [], movements: [], residentialAllocations: [], settings: [], dashboardSnapshot: null },
  theme: localStorage.getItem('erp-theme') || 'light',
  date: new Date().toISOString().slice(0,10),
  batchFilter: '',
  categoryFilter: '',
  campusFilter: '',
  branchFilter: '',
  classFilter: '',
  session: { token: localStorage.getItem('erp-session-token') || '', user: JSON.parse(localStorage.getItem('erp-session-user') || 'null') },
  importUnlocked: false,
  resultUploadProof: '',
  resultUploadCategory: '',
  facultyMasterImportCategory: '',
  resultOptions: {categories:[],classes:[],exams:[],batches:[]},
  adminUsers: [],
  attendanceMode: 'student',
  facultyAttendance: [],
  facultyOptions: { subjects: [], faculties: [], assignments: [] },
  facultyCategoryFilter: '',
  facultyClassFilter: '',
  facultyCampusFilter: '',
  facultyBatchFilter: '',
  facultySubjectFilter: '',
  _dataLoadSeq: 0,
  _lastServerSyncAt: 0,
  _serverSyncInFlight: false,
  _serverSyncTimer: null,
  _preserveInputsUntil: 0,
  _attendanceLiveTimer: null,
  _attendanceLiveInFlight: false,
  _dashboardSnapshotSeq: 0,
  openAttendanceBatchId: '',
  attendanceDirty: false,
  facultyAttendanceDirty: false,
  _facultySaveInFlight: false
};

function applyAuthoritativeSnapshot_(data) {
  if (!data || typeof data !== 'object') return false;

  // Invalidate any older bootstrap request that may still be in flight.
  invalidateERPDataLoads();

  // A mutation makes the previous dashboard snapshot stale. Keep the
  // authoritative spreadsheet/bootstrap state, but force the dashboard
  // snapshot to be fetched again.
  state.data = Object.assign({}, data, {dashboardSnapshot: null});
  state._lastServerSyncAt = Date.now();
  state._serverSyncInFlight = false;
  state.facultyOptions = {
    subjects: state.data.subjects || [],
    faculties: state.data.faculties || [],
    assignments: state.data.facultyAssignments || []
  };
  state.facultyAttendance = state.data.facultyAttendance || [];

  // Invalidate an older dashboard request as well, so its response cannot
  // overwrite the fresh post-write dashboard state.
  state._dashboardSnapshotSeq = Number(state._dashboardSnapshotSeq || 0) + 1;
  state._dashboardSnapshotInFlight = false;
  return true;
}

window.__applyERPApiSnapshot = function applyERPApiSnapshot_(data) {
  applyAuthoritativeSnapshot_(data);
};

const NAV = [
  ['dashboard','⌂','Dashboard'],
  ['attendance','✓','Daily Attendance'],
  ['students','◉','Student Master'],
  ['uinimport','⇧','Import UIN Master'],
  ['movements','↔','Movement Control'],
  ['calendar','▣','Academic Calendar'],
  ['batches','▦','Batch / Campus Matrix'],
  ['reports','▤','Reports'],
  ['results','📊','Students Result Report'],
  ['faculty','👥','Faculty / Teacher Master & Assignments'],
  ['settings','⚙','Settings'],
];
const NAV_GROUPS = [
  {title:'Workspace',items:['dashboard']},
  {title:'Student Operations',items:['attendance','students','uinimport','movements','calendar','batches']},
  {title:'Insights & Reports',items:['reports','results']},
  {title:'Academic Administration',items:['faculty']},
  {title:'Administration',items:['settings']}
];

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!isGAS() || !state.session.token) return;
  if (state.page === 'dashboard') refreshDashboardSnapshot(true);
  if (state.page === 'attendance') syncERPData({silent:true, force:true, preserveInputs:true});
});

document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.dataset.theme = state.theme === 'dark' ? 'dark' : 'light';
  const themeToggle=document.getElementById('themeToggle'); if(themeToggle) themeToggle.onclick = toggleTheme;
  const today=document.getElementById('todayDate'); if(today) today.textContent = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
  if(state.session.token){
    if(typeof google !== 'undefined' && google.script && google.script.run){
      google.script.run.withSuccessHandler(res=>{ if(res&&res.ok){setAuthenticated(res.user);loadData();} else {clearSession();showLogin();} }).withFailureHandler(()=>{clearSession();showLogin();}).validateSession(state.session.token);
    } else { setAuthenticated(state.session.user || {User_ID:'',User_Name:'',Role:''}); applyLocalUserScope_(); hideLogin(); renderNav(); render(); }
  } else showLogin();
  startERPAutoSync();
  startAttendanceLiveRefresh();
});

function isGAS(){return typeof google !== 'undefined' && google.script && google.script.run}
function attendanceAssignedBatchIds_(){
  const u=state.session.user||{};
  return Array.isArray(u.Attendance_Batch_IDs)?u.Attendance_Batch_IDs.map(String):[];
}
function applyLocalUserScope_(){
  if(!attendanceOperatorUser()) return;
  const ids=new Set(attendanceAssignedBatchIds_());
  const batches=(state.data.batches||[]).filter(b=>ids.has(String(b.Batch_ID||'')));
  const codes=new Set(batches.map(b=>String(b.Batch_Code||'').trim().toUpperCase()).filter(Boolean));
  const allowedUins=new Set((state.data.students||[]).filter(s=>ids.has(String(s.Batch_ID||''))||codes.has(String(s.Batch_Code||'').trim().toUpperCase())).map(s=>String(s.UIN||'').trim().toUpperCase()).filter(Boolean));
  state.data.batches=batches;
  state.data.students=(state.data.students||[]).filter(s=>allowedUins.has(String(s.UIN||'').trim().toUpperCase()));
  state.data.allocations=(state.data.allocations||[]).filter(a=>ids.has(String(a.Batch_ID||'')));
  state.data.attendance=(state.data.attendance||[]).filter(a=>ids.has(String(a.Batch_ID||'')));
  state.data.facultyAssignments=(state.data.facultyAssignments||[]).filter(a=>ids.has(String(a.Batch_ID||'')));
  state.data.facultyAttendance=(state.data.facultyAttendance||[]).filter(a=>ids.has(String(a.Batch_ID||'')));
  state.data.movements=(state.data.movements||[]).filter(m=>ids.has(String(m.From_Batch_ID||''))||ids.has(String(m.To_Batch_ID||'')));
  state.data.residentialAllocations=(state.data.residentialAllocations||[]).filter(a=>allowedUins.has(String(a.UIN||'').trim().toUpperCase()));
}
function showLogin(){document.getElementById('loginGate')?.classList.remove('hidden');document.getElementById('app')?.classList.add('auth-hidden');document.getElementById('loginUser')?.focus();}
function hideLogin(){document.getElementById('loginGate')?.classList.add('hidden');document.getElementById('app')?.classList.remove('auth-hidden');}
function setAuthenticated(user){state.session.user=user; localStorage.setItem('erp-session-user',JSON.stringify(user)); hideLogin(); updateAccountUI(); if(!roleAllowedPage(state.page)){state.page=String(user?.Role||'')==='Result Operator'?'reports':'dashboard';} renderNav(); render();}
function clearSession(){state.session={token:'',user:null};localStorage.removeItem('erp-session-token');localStorage.removeItem('erp-session-user');state.importUnlocked=false;}
function submitLogin(){
  const userId=document.getElementById('loginUser')?.value.trim(); const password=document.getElementById('loginPass')?.value || ''; const branchId=document.getElementById('loginBranch')?.value || 'BR001'; const msg=document.getElementById('loginMessage');
  if(!userId||!password){if(msg)msg.textContent='User ID and password are required.';return;}
  if(isGAS()){
    if(msg)msg.textContent='Signing in…';
    google.script.run.withSuccessHandler(res=>{ if(res&&res.ok){state.session.token=res.token;localStorage.setItem('erp-session-token',res.token);setAuthenticated(res.user);loadData();} else if(msg)msg.textContent='Login failed.'; }).withFailureHandler(err=>{if(msg)msg.textContent=err.message||'Login failed.';}).loginUser(userId,password,branchId);
  } else {
    const users=JSON.parse(localStorage.getItem('erp-local-users')||'[]');
    const u=users.find(x=>String(x.User_ID).toLowerCase()===userId.toLowerCase()&&x.Password===password&&String(x.Active_Flag===undefined?'TRUE':x.Active_Flag).toUpperCase()!=='FALSE');
    if(!u){if(msg)msg.textContent='Local/offline mode has no configured users. Open the ERP through its Apps Script web-app deployment.';return;} state.session.token='LOCAL-'+Date.now();setAuthenticated({User_ID:u.User_ID,User_Name:u.User_Name,Role:u.Role,Branch_ID:u.Branch_ID||'',Branch_Name:u.Branch_Name||'',Campus_ID:u.Campus_ID||'',Campus_Name:u.Campus_Name||'',Attendance_Batch_IDs:u.Attendance_Batch_IDs||[]});applyLocalUserScope_();render();
  }
}
function logoutUser(){
  const tok=state.session.token; if(isGAS()&&tok){google.script.run.withSuccessHandler(()=>{}).logoutUser(tok);} clearSession(); showLogin();
}
function updateAccountUI(){const av=document.getElementById('userAvatar');if(av){const n=(state.session.user?.User_Name||state.session.user?.User_ID||'A').trim();av.textContent=n.charAt(0).toUpperCase();av.title=`${n} • ${state.session.user?.Role||''} • ${state.session.user?.Branch_Name||'All Branches'}`;} const chip=document.querySelector('.role-chip');if(chip)chip.textContent=(state.session.user?.Role||'USER').toUpperCase(); const bl=document.getElementById('currentBranchLabel'); if(bl)bl.textContent=state.session.user?.Branch_Name||'All Branches';}
function togglePassword(id,btn){const el=document.getElementById(id);if(!el)return;const show=el.type==='password';el.type=show?'text':'password';if(btn)btn.textContent=show?'◉':'○';}
function openAuthModal(reason){state.authReason=reason;const m=document.getElementById('authModal');if(!m)return;m.classList.remove('hidden');m.setAttribute('aria-hidden','false');const title=document.getElementById('authModalTitle'),help=document.getElementById('authModalHelp'),label=document.querySelector('#authModal label'),user=document.getElementById('authModalUser');if(reason==='resultUpload'){if(title)title.textContent='Result Upload Authorization';if(help)help.textContent='Enter the password of the currently signed-in Admin or Result Operator.';if(label)label.textContent='Authorized User ID';if(user){user.value=state.session.user?.User_ID||'';user.readOnly=true;}}else{if(title)title.textContent='Administrator Authentication';if(help)help.textContent='Administrator credentials are required for this protected action.';if(label)label.textContent='Admin User ID';if(user){user.value='';user.readOnly=false;}}document.getElementById('authModalPass').value='';document.getElementById('authModalPass').focus();}
function closeAuthModal(){const m=document.getElementById('authModal');if(m){m.classList.add('hidden');m.setAttribute('aria-hidden','true')}}
function submitAuthModal(){const u=document.getElementById('authModalUser').value.trim(),p=document.getElementById('authModalPass').value; const reason=state.authReason||'import'; if(isGAS()){ if(reason==='resultUpload'){ google.script.run.withSuccessHandler(res=>{if(res&&res.ok){state.resultUploadProof=res.proof;closeAuthModal();if(state.page!=='results')state.page='results';renderNav();render();showToast('Result upload unlocked for 15 minutes.');} }).withFailureHandler(err=>showToast(err.message||'Authorization failed')).authorizeResultUpload(state.session.token,p); } else { google.script.run.withSuccessHandler(res=>{if(res&&res.ok){state.importUnlocked=true;closeAuthModal();go('uinimport');} }).withFailureHandler(err=>showToast(err.message||'Authorization failed')).loginUser(u,p); } } else {const users=JSON.parse(localStorage.getItem('erp-demo-users')||'[]');const x=users.find(a=>a.User_ID===u&&a.Password===p&&(reason==='resultUpload'?(a.Role==='Admin'||a.Role==='Result Operator'):a.Role==='Admin'));if(x){if(reason==='resultUpload'){state.resultUploadProof='LOCAL-RESULT-UNLOCK';closeAuthModal();state.page='results';renderNav();render();}else{state.importUnlocked=true;closeAuthModal();go('uinimport');}}else showToast('Authorization failed');}}
function requireImportAccess(){if(String(state.session.user?.Role||'')==='Admin'||state.importUnlocked){state.importUnlocked=true;return true;} openAuthModal('import'); return false;}
function requireResultUploadAccess(){const role=String(state.session.user?.Role||''); if(role==='Admin'||role==='Result Operator'){ if(state.resultUploadProof){return true;} state.authReason='resultUpload'; openAuthModal('resultUpload'); return false;} showToast('Result upload is available only to Admin or Result Operator.'); return false;}
function renderNav(){
  const nav=document.getElementById('nav'); if(!nav)return;
  const byId=Object.fromEntries(NAV.map(x=>[x[0],x]));
  nav.innerHTML=NAV_GROUPS.map(group=>{const items=group.items.filter(roleAllowedPage);if(!items.length)return '';return `<div class="nav-group"><div class="nav-group-title">${escapeHtml(group.title)}</div>${items.map(id=>{const [key,icon,label]=byId[id]; return `<button class="nav-item ${state.page===id?'active':''}" onclick="go('${id}')"><span class="nav-icon">${icon}</span><span class="nav-label">${label}</span>${id==='uinimport'?'<span class="nav-lock">🔒</span>':''}</button>`}).join('')}</div>`}).join('');
}
function go(page){
  if(!roleAllowedPage(page)){showToast('This module is not available for your assigned role.');return;}
  if(page==='uinimport' && !requireImportAccess()) return;
  if(page==='attendance'){state.openAttendanceBatchId='';state.attendanceDirty=false;}
  if(page==='settings'){state._settingsUsersRequested=false;}
  if(page==='faculty'){state._facultySettingsLoaded=false;state._facultySettingsLoading=false;}
  if(page==='dashboard'){
    // Never reuse older student or faculty attendance snapshots when opening Dashboard.
    state.data.dashboardSnapshot=null;
    state.dashboardFacultyAttendance=null;
    state._dashboardLastRefreshAt=0;
  }
  state.page=page;
  renderNav();
  render();
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop')?.classList.remove('show');
  if(page==='attendance' && isGAS() && state.session.token){
    setTimeout(()=>syncERPData({targetPage:'attendance',force:true,preserveInputs:false,silent:true}),0);
  }
}
function toggleSidebar(){const side=document.getElementById('sidebar');const back=document.getElementById('sidebarBackdrop');side?.classList.toggle('open');back?.classList.toggle('show',!!side?.classList.contains('open'));}
function toggleTheme(){state.theme=state.theme==='dark'?'light':'dark';localStorage.setItem('erp-theme',state.theme);document.documentElement.dataset.theme=state.theme}
function refreshDashboardFacultyAttendance_(renderAfter=true){
  if(!isGAS() || !state.session.token || state._dashboardFacultyInFlight) return;
  state._dashboardFacultyInFlight=true;

  const token=state.session.token;
  const dateKey=state.date;
  const requestedBranch=isSuperAdmin()
    ? 'ALL'
    : String(state.session.user?.Branch_ID||'BR001');

  google.script.run
    .withSuccessHandler(o=>{
      state._dashboardFacultyInFlight=false;
      if(dateKey!==state.date) return;

      const records=Array.isArray(o?.attendance)?o.attendance:[];
      // Keep the same authoritative faculty dataset used by Daily Attendance.
      state.dashboardFacultyAttendance=records;
      state.facultyAttendance=records;

      if(renderAfter && state.page==='dashboard') render();
    })
    .withFailureHandler(()=>{
      state._dashboardFacultyInFlight=false;
    })
    .getFacultyAttendanceOptions(token,{branchId:requestedBranch,date:dateKey});
}

function refreshDashboardSnapshot(renderAfter=true){
  if(!isGAS() || !state.session.token || state._dashboardSnapshotInFlight) return;
  const requestSeq=Number(state._dashboardSnapshotSeq||0)+1;
  state._dashboardSnapshotSeq=requestSeq;
  state._dashboardSnapshotInFlight=true;
  const token=state.session.token;
  const dateKey=state.date;
  google.script.run.withSuccessHandler(snap=>{
    if(requestSeq!==Number(state._dashboardSnapshotSeq||0)) return;
    state.data.dashboardSnapshot=snap||null;
    state._dashboardLastRefreshAt=Date.now();
    state._dashboardSnapshotInFlight=false;
    if(renderAfter && state.page==='dashboard') render();
  }).withFailureHandler(()=>{
    if(requestSeq!==Number(state._dashboardSnapshotSeq||0)) return;
    state._dashboardSnapshotInFlight=false;
    if(renderAfter && state.page==='dashboard') render();
  }).getDashboardSnapshot(token,dateKey);
}
function startDashboardLiveRefresh(){
  if(state._dashboardSyncTimer) return;
  // Cross-user attendance changes are reflected without waiting for the
  // previous 2-minute refresh window. Post-save updates are still immediate.
  state._dashboardSyncTimer=setInterval(()=>{
    if(state.page==='dashboard' && isGAS() && state.session.token && !activeEditorNeedsProtection_()){
      refreshDashboardSnapshot(true);
      refreshDashboardFacultyAttendance_(true);
    }
  },5000);
}
function invalidateERPDataLoads(){
  state._dataLoadSeq = Number(state._dataLoadSeq || 0) + 1;
  return state._dataLoadSeq;
}

function activeEditorNeedsProtection_(){
  const el=document.activeElement;
  if(!el) return false;
  const tag=String(el.tagName||'').toLowerCase();
  if(!['input','select','textarea'].includes(tag)) return false;
  if(Date.now() < Number(state._preserveInputsUntil||0)) return true;
  return false;
}

function syncERPData(opts={}){
  const targetPage=opts.targetPage||'';
  const afterSync=typeof opts.afterSync==='function'?opts.afterSync:null;
  const silent=!!opts.silent;
  const preserveInputs=opts.preserveInputs!==false;

  if(!isGAS() || !state.session.token){
    if(targetPage) state.page=targetPage;
    renderNav();
    render();
    if(afterSync) afterSync(state.data);
    return Promise.resolve(state.data);
  }

  if(preserveInputs && activeEditorNeedsProtection_() && !opts.force){
    return Promise.resolve(state.data);
  }

  const requestSeq=invalidateERPDataLoads();
  const token=state.session.token;
  state._serverSyncInFlight=true;
  if(!silent) showToast('Synchronizing ERP data…');

  return new Promise(resolve=>{
    google.script.run
      .withSuccessHandler(data=>{
        if(requestSeq!==state._dataLoadSeq){
          resolve(state.data);
          return;
        }

        state.data=data||state.data;
        state._lastServerSyncAt=Date.now();
        state._serverSyncInFlight=false;

        state.facultyOptions={
          subjects: state.data.subjects||[],
          faculties: state.data.faculties||[],
          assignments: state.data.facultyAssignments||[]
        };
        state.facultyAttendance=state.data.facultyAttendance||[];

        if(targetPage) state.page=targetPage;
        updateAccountUI();
        renderNav();
        render();

        // Settings has two secondary panels whose data is loaded by separate
        // server calls. Refresh them whenever the authoritative state changes
        // so direct Spreadsheet edits are reflected there as well.
        if(state.page==='settings'){
          if(isActualSuperAdmin()) setTimeout(()=>loadUsers(),0);
        }
        if(state.page==='faculty' && canManageFacultyMaster()) setTimeout(()=>loadFacultyAdminData(true),80);

        if(afterSync) afterSync(state.data);
        resolve(state.data);
      })
      .withFailureHandler(err=>{
        if(requestSeq!==state._dataLoadSeq){
          resolve(state.data);
          return;
        }
        state._serverSyncInFlight=false;
        const msg=String(err.message||err||'');
        if(msg.toLowerCase().includes('authentication')){
          clearSession();
          showLogin();
        }else if(!silent){
          showToast('ERP synchronization failed: '+msg);
        }
        resolve(state.data);
      })
      .getBootstrapData(token);
  });
}

function applyAuthoritativeImportSnapshot_(res, targetPage, afterSync){
  if(!res || !res.data || typeof res.data!=='object') return false;
  invalidateERPDataLoads();
  state.data=res.data;
  state._lastServerSyncAt=Date.now();
  state._serverSyncInFlight=false;
  state.facultyOptions={
    subjects:state.data.subjects||[],
    faculties:state.data.faculties||[],
    assignments:state.data.facultyAssignments||[]
  };
  state.facultyAttendance=state.data.facultyAttendance||[];
  if(targetPage) state.page=targetPage;
  updateAccountUI();
  renderNav();
  render();
  if(state.page==='settings'){
    if(isActualSuperAdmin()) setTimeout(()=>loadUsers(),0);
  }
  if(state.page==='faculty' && canManageFacultyMaster()) setTimeout(()=>loadFacultyAdminData(true),80);
  if(typeof afterSync==='function') afterSync(state.data);
  return true;
}

function applyAuthoritativeMutationResponse_(res,targetPage=state.page,renderAfter=true){
  if(!res || !res.data || typeof res.data!=='object') return false;
  applyAuthoritativeSnapshot_(res.data);
  if(targetPage) state.page=targetPage;
  if(renderAfter){
    updateAccountUI();
    renderNav();
    render();
  }
  return true;
}

function syncAfterImport_(res, targetPage, afterSync, options={}){
  if(applyAuthoritativeImportSnapshot_(res,targetPage,afterSync)) return;
  refreshERPDataAndRender(targetPage,afterSync,Object.assign({force:true,preserveInputs:false},options));
}


function loadData(opts={}){
  return syncERPData({
    targetPage:opts.targetPage||'',
    afterSync:opts.afterSync,
    silent:!!opts.silent,
    preserveInputs:opts.preserveInputs!==false,
    force:!!opts.force
  });
}

function refreshERPDataAndRender(targetPage, afterSync, options={}) {
  return syncERPData({
    targetPage,
    afterSync,
    silent:!!options.silent,
    preserveInputs:options.preserveInputs!==false,
    force:!!options.force
  });
}

function startERPAutoSync(){
  if(state._serverSyncTimer) return;
  // Keep background synchronization at a minimum 20-minute interval so
  // Settings and other data-entry panels remain stable while being edited.
  state._serverSyncTimer=window.setInterval(()=>{
    if(!isGAS() || !state.session.token || document.hidden) return;
    if(state._serverSyncInFlight || activeEditorNeedsProtection_()) return;
    syncERPData({silent:true,preserveInputs:true});
  }, 20 * 60 * 1000);
}
function startAttendanceLiveRefresh(){
  if(state._attendanceLiveTimer) return;
  // Attendance pages use a short polling window so changes made by another
  // authorised user appear without a manual page refresh. Active edits are
  // protected so a remote update never destroys unsaved selections.
  state._attendanceLiveTimer=setInterval(()=>{
    if(state.page!=='attendance' || !isGAS() || !state.session.token) return;
    if(state._attendanceLiveInFlight || state._serverSyncInFlight || activeEditorNeedsProtection_()) return;

    if(state.attendanceMode==='faculty'){
      if(state.facultyAttendanceDirty) return;
      state._attendanceLiveInFlight=true;
      const token=state.session.token;
      google.script.run
        .withSuccessHandler(o=>{
          state._attendanceLiveInFlight=false;
          if(state.page!=='attendance' || state.attendanceMode!=='faculty') return;
          state.facultyOptions=o||state.facultyOptions;
          state.facultyAttendance=o?.attendance||[];
          renderFacultyAttendanceOnly();
        })
        .withFailureHandler(()=>{state._attendanceLiveInFlight=false;})
        .getFacultyAttendanceOptions(token,{branchId:facultyBranch(),date:state.date});
      return;
    }

    const openBatchId=String(state.openAttendanceBatchId||'').trim();
    if(openBatchId){
      if(state.attendanceDirty) return;
      const b=(state.data.batches||[]).find(x=>String(x.Batch_ID)===openBatchId);
      if(!b) return;
      state._attendanceLiveInFlight=true;
      const token=state.session.token;
      const dateKey=state.date;
      google.script.run
        .withSuccessHandler(res=>{
          state._attendanceLiveInFlight=false;
          if(state.page!=='attendance' || state.attendanceMode!=='student') return;
          if(String(state.openAttendanceBatchId||'')!==openBatchId || state.date!==dateKey) return;
          if(res?.attendanceRequired) renderAttendanceRoster(b,res.rows||[],'Live roster refreshed from the authoritative attendance record.');
        })
        .withFailureHandler(()=>{state._attendanceLiveInFlight=false;})
        .getAttendanceRoster(token,openBatchId,dateKey);
      return;
    }

    syncERPData({silent:true,preserveInputs:true,force:true});
  },5000);
}

function render(){
  const meta = NAV.find(x=>x[0]===state.page);
  document.getElementById('pageTitle').textContent = meta ? meta[2] : 'Dashboard';
  document.getElementById('pageSubtitle').textContent = state.page==='dashboard'?'Operations control centre' : (state.page==='faculty'?'Academic Administration':'Student Operations ERP');
  const c=document.getElementById('content');
  if(state.page==='dashboard'){
    c.innerHTML=dashboardHTML();
    const snapDate=String(state.data.dashboardSnapshot?.date||'');
    if(!state.data.dashboardSnapshot || snapDate!==String(state.date||'')) setTimeout(()=>refreshDashboardSnapshot(true),0);
    if(!Array.isArray(state.dashboardFacultyAttendance)) setTimeout(()=>refreshDashboardFacultyAttendance_(true),0);
    startDashboardLiveRefresh();
  }
  else if(state.page==='attendance') c.innerHTML=state.attendanceMode==='faculty'?facultyAttendanceHTML():attendanceHTML();
  else if(state.page==='students' || state.page==='uinimport') c.innerHTML=studentsHTML();
  else if(state.page==='movements') c.innerHTML=movementsHTML();
  else if(state.page==='calendar') c.innerHTML=calendarHTML();
  else if(state.page==='batches') c.innerHTML=batchesHTML();
  else if(state.page==='reports') c.innerHTML=reportsHTML();
  else if(state.page==='results') { c.innerHTML=resultsHTML(); setTimeout(loadResultOptions,0); }
  else if(state.page==='faculty') { c.innerHTML=`<div id="facultyAdminSection">${facultyAdminHtml()}</div>`; if(canManageFacultyMaster() && !state._facultySettingsLoaded && !state._facultySettingsLoading){ state._facultySettingsLoading=true; setTimeout(()=>loadFacultyAdminData(),120); } }
  else {
    if(state.page==='settings' && document.getElementById('settingsPageRoot')){
      // Keep the mounted Settings DOM stable during background refreshes; update sub-panels in place.
    } else { c.innerHTML=settingsHTML(); }
    if(state.page==='settings'){ if(canManageProtectedSettings() && !state._settingsUsersRequested){ state._settingsUsersRequested=true; setTimeout(loadUsers,0); } }
  }
}

function stats(){
  const batches=(state.data.batches||[]).filter(studentAttendanceBatch_);
  const total=(state.data.students||[]).length || batches.reduce((s,b)=>s+Number(b.Expected_Strength||b.batch_total||0),0);
  const categories=['XI NEET','XII NEET','Challengers NEET','XI JEE','XII JEE','Challengers JEE','School'];
  return {total,batchCount:batches.length,categories};
}
function categoryTotals(){
  // Dashboard category overview must exactly match the Batch / Campus Matrix.
  // Therefore category totals are derived only from Expected_Strength/batch_total in the authorised batch matrix.
  const out={};
  const batches=state.data.batches||[];
  const scope=isSuperAdmin()?'ALL':String(state.session.user?.Branch_ID||'BR001');
  batches.forEach(b=>{
    if(scope!=='ALL' && String(b.Branch_ID||'BR001')!==scope) return;
    const k=String(b.Category_Name||b.category||'').trim();
    if(!k) return;
    out[k]=(out[k]||0)+Number(b.Expected_Strength||b.batch_total||0);
  });
  return out;
}
function branchCategoryTotals(){
  const out={};
  const batches=state.data.batches||[];
  const categoryOrder=['XI NEET','XII NEET','Challengers NEET','XI JEE','XII JEE','Challengers JEE','School'];
  const branchScope=isSuperAdmin()?'ALL':String(state.session.user?.Branch_ID||'BR001');
  batches.forEach(b=>{
    const bid=String(b.Branch_ID||'BR001');
    if(branchScope!=='ALL' && bid!==branchScope) return;
    const category=String(b.Category_Name||b.category||'').trim();
    if(!category) return;
    if(!out[bid]) out[bid]={};
    out[bid][category]=(out[bid][category]||0)+Number(b.Expected_Strength||b.batch_total||0);
  });
  return {out,categoryOrder};
}
function attendanceEligibleUinsForBatch_(batchId, batchCode=''){
  const ids=new Set();
  const bid=String(batchId||'').trim();
  const bcode=String(batchCode||'').trim().toUpperCase();

  // Current active allocations are preferred.
  (state.data.allocations||[]).forEach(a=>{
    if(String(a.Allocation_Status||'Active').trim().toLowerCase()!=='active') return;
    const ab=String(a.Batch_ID||'').trim();
    const ac=String(a.Batch_Code||'').trim().toUpperCase();
    if((bid && ab===bid) || (!bid && bcode && ac===bcode)){
      const u=String(a.UIN||'').trim().toUpperCase();
      if(u) ids.add(u);
    }
  });

  // Student Master remains the fallback/source of truth for first-time setup.
  (state.data.students||[]).forEach(st=>{
    const overall=String(st.Overall_Status||'Active').trim().toLowerCase();
    if(['left','inactive','withdrawn','cancelled'].includes(overall)) return;
    const sb=String(st.Batch_ID||'').trim();
    const sc=String(st.Batch_Code||st.Batch||st.Batch_Name||'').trim().toUpperCase();
    if((bid && sb===bid) || (bcode && sc===bcode)){
      const u=String(st.UIN||'').trim().toUpperCase();
      if(u) ids.add(u);
    }
  });

  return ids;
}

function attendanceCounts(){
  // IMPORTANT:
  // Daily Attendance is a filter-scoped view. dashboardSnapshot is an
  // organisation-wide snapshot and must NOT be used for these cards.
  const batches=scopedBatchesForAttendance();
  const date=normalizeDateKey_(state.date);
  const counts={Present:0,Absent:0,Leave:0,Sick:0,Not_Marked:0};
  let eligible=0;

  const attendanceRows=(state.data.attendance||[])
    .filter(a=>normalizeDateKey_(a.Attendance_Date||'')===date);

  batches.forEach(b=>{
    const batchId=String(b.Batch_ID||'').trim();
    const batchCode=String(b.Batch_Code||'').trim().toUpperCase();
    const eligibleUins=attendanceEligibleUinsForBatch_(batchId,batchCode);
    const batchEligible=eligibleUins.size || Number(b.Expected_Strength||b.batch_total||0);
    eligible+=batchEligible;

    const latestByUin={};

    attendanceRows.forEach(r=>{
      const u=String(r.UIN||'').trim().toUpperCase();
      if(!u) return;

      const rowBatchId=String(r.Batch_ID||'').trim();
      const rowBatchCode=String(r.Batch_Code||'').trim().toUpperCase();
      const sameBatch=
        rowBatchId===batchId ||
        (!rowBatchId && batchCode && rowBatchCode===batchCode);

      if(!sameBatch) return;
      if(eligibleUins.size && !eligibleUins.has(u)) return;

      const stamp=Date.parse(String(r.Updated_At||r.Marked_At||'')) || 0;
      const previous=latestByUin[u];
      if(!previous || stamp>=previous.__stamp){
        latestByUin[u]={
          status:String(r.Attendance_Status||'').trim(),
          __stamp:stamp
        };
      }
    });

    Object.values(latestByUin).forEach(r=>{
      if(r.status==='Present') counts.Present++;
      else if(r.status==='Absent') counts.Absent++;
      else if(r.status==='Leave') counts.Leave++;
      else if(r.status==='Sick') counts.Sick++;
    });
  });

  const marked=counts.Present+counts.Absent+counts.Leave+counts.Sick;
  counts.Not_Marked=Math.max(0,eligible-marked);
  return {eligible,...counts};
}

function dashboardFacultyAttendanceHTML(){
  const dateKey=normalizeDateKey_(state.date);
  const source=Array.isArray(state.dashboardFacultyAttendance)
    ? state.dashboardFacultyAttendance
    : (Array.isArray(state.facultyAttendance)?state.facultyAttendance:[]);

  const rows=source.filter(r=>{
    if(normalizeDateKey_(r.Attendance_Date||'')!==dateKey) return false;
    return !!String(r.Attendance_Status||'').trim();
  });

  const byStatus={};
  rows.forEach(r=>{
    const status=String(r.Attendance_Status||'').trim();
    byStatus[status]=(byStatus[status]||0)+1;
  });

  const live=rows
    .slice()
    .sort((a,b)=>{
      const da=new Date(a.Updated_At||a.Marked_At||0).getTime();
      const db=new Date(b.Updated_At||b.Marked_At||0).getTime();
      return db-da;
    })
    .slice(0,12);

  const statuses=[
    'Early Arrival',
    'On Time Arrival',
    'Late Arrival by 5–10 Minutes',
    'Late by More Than 15 Minutes',
    'More Than 30 Minutes Late',
    'Absent',
    'Others'
  ];

  const cards=statuses
    .map(st=>metricCard(st,String(byStatus[st]||0),'Faculty / Teacher','blue'))
    .join('');

  return `<div class="dashboard-section-head"><div><span class="section-kicker kicker-purple">FACULTY / TEACHER</span><h2>Live Faculty / Teacher Attendance</h2><p>Saved attendance from today, using the same authorised Faculty / Teacher Attendance records shown in Daily Attendance.</p></div><button class="text-link" onclick="go('attendance');setTimeout(()=>switchAttendanceMode('faculty'),0)">Open faculty attendance →</button></div><div class="grid grid-4" style="margin-bottom:14px"><div class="card kpi"><div class="metric-label">Total Saved</div><div class="metric">${rows.length.toLocaleString()}</div><span class="badge badge-blue">Today's records</span></div>${cards}</div><div class="card"><div class="section-title" style="margin-top:0"><div><h3 style="margin:0">Latest faculty attendance records</h3><div class="muted">Most recent saved entries from the same source used by Daily Attendance.</div></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Batch</th><th>Campus</th><th>Faculty</th><th>Subject</th><th>Status</th><th>Saved At</th></tr></thead><tbody>${live.length?live.map(r=>`<tr><td><b>${escapeHtml(r.Batch_Name||r.Batch_Code||r.Batch_ID||'')}</b></td><td>${escapeHtml(r.Campus_Name||'')}</td><td>${escapeHtml(r.Faculty_Name||r.Faculty_ID||'')}</td><td>${escapeHtml(r.Subject_Name||'')}</td><td><span class="badge ${String(r.Attendance_Status||'').toLowerCase()==='absent'?'badge-red':(String(r.Attendance_Status||'').toLowerCase()==='others'?'badge-yellow':'badge-green')}">${escapeHtml(r.Attendance_Status||'')}</span></td><td class="muted">${r.Updated_At||r.Marked_At?escapeHtml(formatDateTime_(r.Updated_At||r.Marked_At)):'—'}</td></tr>`).join(''):`<tr><td colspan="6" class="muted center">No faculty / teacher attendance has been saved for today in your authorised scope.</td></tr>`}</tbody></table></div></div>`;
}


function dashboardHTML(){
  const s=stats(), cats=categoryTotals(), a=attendanceCounts();
  const branchRows=(state.data.branches||[]).filter(br=>String(br.Active_Flag??'TRUE').toUpperCase()!=='FALSE');
  const scopedStudents=state.data.students||[];
  const quickResultRoles=['Admin','Result Operator'];
  const todayLabel=formatDate(state.date);
  const categoryOrder=['XI NEET','XII NEET','Challengers NEET','XI JEE','XII JEE','Challengers JEE','School'];
  const bc=branchCategoryTotals();
  const scopedBranches=branchRows.filter(br=>isSuperAdmin() || String(br.Branch_ID)===String(state.session.user?.Branch_ID||'BR001'));
  const activity=[
    {icon:'✓',title:'Attendance',text:`${Math.max(0,a.Present)} students marked Present today`,tone:'blue'},
    {icon:'↔',title:'Movement Control',text:'Review pending campus / batch movements',tone:'amber'},
    {icon:'📊',title:'Results',text:'Open result search and analysis centre',tone:'green'},
    {icon:'▣',title:'Calendar',text:'Check today’s working-day status and upcoming events',tone:'purple'}
  ];
  const combinedCells=categoryOrder.map(k=>`<div class="acad-combined-cell"><span>${escapeHtml(k)}</span><strong>${Number(cats[k]||0).toLocaleString()}</strong></div>`).join('');
  const branchTables=scopedBranches.map((br,idx)=>{
    const vals=bc.out[String(br.Branch_ID)]||{};
    const total=categoryOrder.reduce((n,k)=>n+Number(vals[k]||0),0);
    const tone=['branch-ocean','branch-gold','branch-emerald','branch-violet'][idx%4];
    return `<div class="branch-academic-card ${tone}"><div class="branch-academic-head"><div><span class="section-kicker kicker-green">BRANCH</span><h3>${escapeHtml(br.Branch_Name)}</h3></div><strong>${total.toLocaleString()}</strong></div><div class="branch-academic-grid">${categoryOrder.map(k=>`<div><span>${escapeHtml(k)}</span><b>${Number(vals[k]||0).toLocaleString()}</b></div>`).join('')}</div></div>`;
  }).join('');
  return `
  <section class="dashboard-shell">
    <div class="dashboard-command-row">
      <div class="dashboard-intro">
        <div class="eyebrow">AJMAL SUPER 40 • ${escapeHtml(state.session.user?.Branch_Name||'All Branches')}</div>
        <h1>Operations Control Centre</h1>
        <p>Search students, monitor attendance, manage movement and open results from one place.</p>
      </div>
      <div class="dashboard-date-card"><span class="muted">Operational Date</span><strong>${escapeHtml(todayLabel)}</strong><span class="badge badge-blue">${isSuperAdmin()?'All branches':'Branch scoped'}</span></div>
    </div>
    <div class="global-search-card">
      <div class="search-label"><span class="search-orb">⌕</span><div><b>Global Student Search</b><div class="muted">UIN, Student Name, Father's Name, Batch or Campus</div></div></div>
      <div class="global-search-wrap"><input id="globalStudentSearch" class="global-search-input" placeholder="Start typing UIN / student / father / batch / campus…" autocomplete="off" oninput="runGlobalStudentSearch(this.value)" onkeydown="if(event.key==='Enter')runGlobalStudentSearch(this.value)"><button class="btn btn-primary" onclick="runGlobalStudentSearch(document.getElementById('globalStudentSearch')?.value||'')">Search</button></div>
      <div id="globalSearchResults" class="global-search-results hidden"></div>
    </div>
    <div class="quick-actions-grid">
      <button class="quick-action quick-blue" onclick="go('attendance')"><span>✓</span><div><b>Daily Attendance</b><small>Mark today's roster</small></div><i>→</i></button>
      <button class="quick-action quick-gold" onclick="go('students')"><span>◉</span><div><b>Student Master</b><small>Search & review UINs</small></div><i>→</i></button>
      <button class="quick-action quick-purple" onclick="go('movements')"><span>↔</span><div><b>Movement Control</b><small>Transfers & approvals</small></div><i>→</i></button>
      <button class="quick-action quick-green" onclick="go('results')"><span>📊</span><div><b>Result Centre</b><small>Search & analyse results</small></div><i>→</i></button>
      ${quickResultRoles.includes(String(state.session.user?.Role||''))?`<button class="quick-action quick-red" onclick="requireResultUploadAccess()"><span>⇧</span><div><b>Upload Result</b><small>Admin / Result Operator</small></div><i>→</i></button>`:''}
      ${String(state.session.user?.Role||'')==='Admin'?`<button class="quick-action quick-slate" onclick="go('settings')"><span>⚙</span><div><b>Admin Settings</b><small>Users, access & defaults</small></div><i>→</i></button>`:''}
    </div>
    <div class="dashboard-section-head"><div><span class="section-kicker kicker-blue">TODAY</span><h2>Live Attendance</h2><p>One attendance status per eligible student per working day.</p></div><button class="text-link" onclick="go('attendance')">Open attendance →</button></div>
    <div class="grid grid-6 attendance-kpi-grid">
      ${metricCard('Eligible Today',a.eligible,'Dynamic roster','blue')}
      ${metricCard('Present',a.Present,'Marked present','green')}
      ${metricCard('Absent',a.Absent,'Needs follow-up','red')}
      ${metricCard('Leave',a.Leave,'Approved / authorised','yellow')}
      ${metricCard('Sick',a.Sick,'Medical absence','purple')}
      ${metricCard('Not Marked',a.Not_Marked,'Still pending','gray')}
    </div>
    ${dashboardFacultyAttendanceHTML()}
    <div class="dashboard-section-head"><div><span class="section-kicker kicker-gold">ACADEMICS</span><h2>Academic Category Overview</h2><p>Combined batch-matrix strength across authorised branches, followed by branch-wise segregation.</p></div><button class="text-link" onclick="go('batches')">Open batch matrix →</button></div>
    <div class="academic-combined-panel"><div class="academic-combined-title"><div><h3>Combined Academic Strength</h3><span>${isSuperAdmin()?'All authorised branches combined':'Your authorised branch'}</span></div><strong>${categoryOrder.reduce((n,k)=>n+Number(cats[k]||0),0).toLocaleString()}</strong></div><div class="academic-combined-grid">${combinedCells}</div></div>
    <div class="academic-branch-heading"><div><h3>Branch-wise Academic Category Breakdown</h3><span>XI NEET, XII NEET, Challengers NEET, XI JEE, XII JEE, Challengers JEE and School (VI–X)</span></div></div>
    <div class="branch-academic-list">${branchTables || '<div class="muted">No branch academic data available.</div>'}</div>
    <div class="dashboard-section-head"><div><span class="section-kicker kicker-green">NETWORK</span><h2>Branch Overview</h2><p>${isSuperAdmin()?'All authorised branches are visible to Super Admin.':'Only your authorised branch is shown.'}</p></div><button class="text-link" onclick="go('reports')">Open reports →</button></div>
    <div class="branch-card-grid">${branchRows.filter(br=>isSuperAdmin() || String(br.Branch_ID)===String(state.session.user?.Branch_ID||'BR001')).map((br,idx)=>{const id=String(br.Branch_ID);const st=scopedStudents.filter(st=>String(st.Branch_ID||'BR001')===id).length;const ba=(state.data.batches||[]).filter(b=>String(b.Branch_ID||'BR001')===id).length;const tone=['branch-ocean','branch-gold','branch-emerald','branch-violet'][idx%4]; return `<button class="branch-card ${tone}" onclick="go('batches');state.branchFilter='${escapeHtml(id)}';render()"><div class="branch-icon">${['H','B','D','K'][idx%4]}</div><div class="branch-name">${escapeHtml(br.Branch_Name)}</div><div class="branch-stats"><span><b>${st.toLocaleString()}</b><small>students</small></span><span><b>${ba}</b><small>batches</small></span></div><div class="branch-arrow">→</div></button>`}).join('')}</div>
    <div class="dashboard-bottom-grid">
      <div class="dashboard-panel panel-amber"><div class="panel-head"><div><span class="section-kicker kicker-gold">EXCEPTIONS</span><h3>Priority Exceptions</h3></div><button class="text-link" onclick="go('reports')">Open reports →</button></div>${exceptionList()}</div>
      <div class="dashboard-panel panel-violet"><div class="panel-head"><div><span class="section-kicker kicker-purple">RECENT ACTIVITY</span><h3>Operational shortcuts</h3></div></div><div class="activity-list">${activity.map(a=>`<button class="activity-row" onclick="go('${a.title==='Attendance'?'attendance':a.title==='Movement Control'?'movements':a.title==='Results'?'results':'calendar'}')"><span class="activity-icon ${a.tone}">${a.icon}</span><span><b>${escapeHtml(a.title)}</b><small>${escapeHtml(a.text)}</small></span><i>→</i></button>`).join('')}</div></div>
    </div>
    <div class="result-centre-banner"><div><span class="section-kicker kicker-green">RESULT CENTRE</span><h2>Students Result Report</h2><p>Search by UIN, class or multiple batches and generate analysis/PDF reports.</p></div><div class="result-centre-actions"><button class="btn btn-secondary" onclick="go('results')">Open Result Centre</button>${quickResultRoles.includes(String(state.session.user?.Role||''))?`<button class="btn btn-primary" onclick="requireResultUploadAccess()">🔒 Result Upload</button>`:''}</div></div>
  </section>`;
}
function runGlobalStudentSearch(query){
  const q=String(query||'').trim().toLowerCase(); const box=document.getElementById('globalSearchResults'); if(!box)return;
  if(q.length<2){box.classList.add('hidden');box.innerHTML='';return;}
  const students=(state.data.students||[]); const batches=(state.data.batches||[]);
  const matches=students.filter(s=>[s.UIN,s.Student_Name,s.Father_Name,s.Batch_Code,s.Campus_Name,s.Class_Name,s.Category_Name].some(v=>String(v||'').toLowerCase().includes(q))).slice(0,8);
  const batchMatches=batches.filter(b=>[b.Batch_Code,b.Campus_Name,b.Category_Name,b.Class_Name].some(v=>String(v||'').toLowerCase().includes(q))).slice(0,5);
  let html='';
  if(matches.length) html+=`<div class="search-group"><div class="search-group-title">Students</div>${matches.map(s=>`<button class="search-result-row" onclick="openGlobalStudent('${escapeHtml(String(s.UIN||''))}')"><span class="search-avatar">${escapeHtml(String(s.Student_Name||'S').charAt(0))}</span><span><b>${escapeHtml(s.UIN||'')}</b> • ${escapeHtml(s.Student_Name||'')}</span><small>${escapeHtml(s.Father_Name||'')} • ${escapeHtml(s.Batch_Code||'')} • ${escapeHtml(s.Campus_Name||'')}</small></button>`).join('')}</div>`;
  if(batchMatches.length) html+=`<div class="search-group"><div class="search-group-title">Batches / Campuses</div>${batchMatches.map(b=>`<button class="search-result-row" onclick="state.batchFilter='${escapeHtml(b.Batch_Code||'')}';go('attendance')"><span class="search-avatar batch-avatar">▦</span><span><b>${escapeHtml(b.Batch_Code||'')}</b> • ${escapeHtml(b.Category_Name||'')}</span><small>${escapeHtml(b.Campus_Name||'')} • ${escapeHtml(b.Branch_Name||'')}</small></button>`).join('')}</div>`;
  if(!html) html='<div class="search-empty">No matching student, batch or campus found within your authorised scope.</div>';
  box.innerHTML=html; box.classList.remove('hidden');
}
function openGlobalStudent(uin){
  const row=(state.data.students||[]).find(s=>String(s.UIN)===String(uin));
  if(!row){showToast('Student not found in your authorised scope.');return;}
  state.studentLookupUIN=String(uin); state.page='students'; renderNav(); render(); setTimeout(()=>{const x=document.getElementById('studentSearch'); if(x){x.value=uin; if(typeof filterStudents==='function')filterStudents();}},0);
}

function metricCard(title,value,sub,kind){let cls=kind==='green'?'badge-green':kind==='red'?'badge-red':kind==='yellow'?'badge-yellow':'badge-blue';return `<div class="card kpi"><div class="metric-label">${title}</div><div class="metric">${Number(value||0).toLocaleString()}</div><span class="badge ${cls}">${sub}</span></div>`}
function campusAttendanceTable(){
  let rows=[];
  if(state.data.dashboardSnapshot && Array.isArray(state.data.dashboardSnapshot.campusRows)){
    rows=state.data.dashboardSnapshot.campusRows.slice();
  }else{
    const branchMap={}; (state.data.branches||[]).forEach(b=>branchMap[String(b.Branch_ID||'')]=b.Branch_Name||'');
    const batches=state.data.batches||[], batchById={}; batches.forEach(b=>batchById[String(b.Batch_ID||'')]=b);
    const students=state.data.students||[], allocations=state.data.allocations||[]; const allocByUin={};
    allocations.forEach(a=>{if(String(a.Allocation_Status||'Active')!=='Active')return; allocByUin[String(a.UIN||'').trim().toUpperCase()]=a;});
    const attByUin={}; (state.data.attendance||[]).filter(a=>String(a.Attendance_Date||'').slice(0,10)===state.date).forEach(a=>{attByUin[String(a.UIN||'').trim().toUpperCase()]=a.Attendance_Status;});
    const m={}; students.forEach(st=>{const u=String(st.UIN||'').trim().toUpperCase(); const a=allocByUin[u]; const b=a?batchById[String(a.Batch_ID||'')]:null; if(!b)return; const br=String(st.Branch_ID||b.Branch_ID||a.Branch_ID||'BR001'); if(!isSuperAdmin() && String(state.session.user?.Branch_ID||'')!==br)return; const campus=String(a.Campus_Name||b.Campus_Name||st.Campus_Name||'Unassigned'); const key=br+'|'+campus; if(!m[key])m[key]={Branch_ID:br,Branch_Name:branchMap[br]||b.Branch_Name||st.Branch_Name||'Branch',Campus_Name:campus,eligible:0,present:0,absent:0,sick:0,leave:0,notMarked:0}; m[key].eligible++; const stt=attByUin[u]||'Not Marked'; if(stt==='Present')m[key].present++; else if(stt==='Absent')m[key].absent++; else if(stt==='Sick')m[key].sick++; else if(stt==='Leave')m[key].leave++; else m[key].notMarked++;}); rows=Object.values(m);
  }
  if(!rows.length) return '<div class="empty-state">No campus attendance data available for today.</div>';
  rows.sort((a,b)=>String(a.Branch_Name||'').localeCompare(String(b.Branch_Name||''))||String(a.Campus_Name||'').localeCompare(String(b.Campus_Name||'')));
  return `<div class="table-wrap dashboard-attendance-wrap"><table class="data-table campus-attendance-table"><thead><tr><th>Branch</th><th>Campus</th><th>Eligible</th><th>P</th><th>A</th><th>S</th><th>L</th><th>Not Marked</th></tr></thead><tbody>${rows.map(r=>`<tr><td><b>${escapeHtml(r.Branch_Name||'')}</b></td><td>${escapeHtml(r.Campus_Name||'')}</td><td><b>${Number(r.eligible||0).toLocaleString()}</b></td><td><span class="badge badge-green">${Number(r.present||0)}</span></td><td><span class="badge badge-red">${Number(r.absent||0)}</span></td><td><span class="badge badge-purple">${Number(r.sick||0)}</span></td><td><span class="badge badge-yellow">${Number(r.leave||0)}</span></td><td><span class="badge badge-gray">${Number(r.notMarked||0)}</span></td></tr>`).join('')}</tbody></table></div>`;
}

function exceptionList(){
  const pendingMovements=(state.data.movements||[]).filter(m=>String(m.Status||'Pending').toLowerCase()==='pending').length;
  const calendarExceptions=(state.data.calendar||[]).filter(e=>String(e.Attendance_Required).toUpperCase()!=='TRUE').length;
  return `<div class="list">
    <div class="list-item"><span><b>Not Marked</b><br><span class="muted">Batches with incomplete attendance</span></span><span class="badge badge-red">${attendanceCounts().Not_Marked}</span></div>
    <div class="list-item"><span><b>Movement Approvals</b><br><span class="muted">Campus/batch changes awaiting action</span></span><span class="badge badge-yellow">${pendingMovements}</span></div>
    <div class="list-item"><span><b>Calendar Exceptions</b><br><span class="muted">Special working days / events</span></span><span class="badge badge-blue">${calendarExceptions}</span></div>
  </div>`;
}

function allCampusNames(){
  const names=new Set();
  (state.data.campuses||[]).forEach(c=>{const n=c.Campus_Name||c.Location_Name||c.Campus||c.Location; if(n) names.add(String(n).trim());});
  (state.data.batches||[]).forEach(b=>{if(b.Campus_Name) names.add(String(b.Campus_Name).trim());});
  (state.data.students||[]).forEach(st=>{const n=st.Campus_Name||st.Campus||st.Location_Name||st.Location; if(n) names.add(String(n).trim());});
  (state.data.allocations||[]).forEach(a=>{const n=a.Campus_Name||a.Campus||a.Location_Name||a.Location; if(n) names.add(String(n).trim());});
  return [...names].filter(Boolean).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
}
function resultBranchScopedRole_(){
  const r=String(state.session.user?.Role||'');
  return r==='Result Operator' || r==='Academic Admin';
}
function assignedBranchIds_(){
  const raw=state.session.user?.Assigned_Branch_IDs||[];
  if(Array.isArray(raw)) return [...new Set(raw.map(x=>String(x||'').trim()).filter(Boolean))];
  return String(raw||'').split(/[,\n;]+/).map(x=>String(x||'').trim()).filter(Boolean);
}
function resultBranchOptionsHtml(selected=''){
  const scoped=resultBranchScopedRole_();
  const rows=Array.isArray(state.data.branches)?state.data.branches:[];
  const ids=scoped?new Set(assignedBranchIds_()):null;
  const allowed=rows.filter(b=>!ids || ids.has(String(b.Branch_ID||'').trim()));
  if(!scoped && (isSuperAdmin() || String(state.session.user?.Branch_ID||'')==='ALL')){
    return '<option value="ALL">All branches</option>'+allowed.map(b=>`<option value="${escapeAttr(b.Branch_ID)}">${escapeHtml(b.Branch_Name||b.Branch_ID||'')}</option>`).join('');
  }
  const sel=String(selected||'');
  return allowed.map(b=>`<option value="${escapeAttr(b.Branch_ID)}" ${sel===String(b.Branch_ID)?'selected':''}>${escapeHtml(b.Branch_Name||b.Branch_ID||'')}</option>`).join('');
}

function branchOptionsHtml(selected=''){
  const rows=Array.isArray(state.data.branches)?state.data.branches:[];
  return rows.map(b=>`<option value="${escapeAttr(b.Branch_ID)}" ${String(selected)===String(b.Branch_ID)?'selected':''}>${escapeHtml(b.Branch_Name||b.Branch_ID||'')}</option>`).join('');
}
function adminUserCampusOptions(selected='', branchId='ALL', includeBlank=true){
  const rows=Array.isArray(state.data.campuses)?state.data.campuses:[];
  const branch=String(branchId||'ALL');
  const scoped=rows.filter(c=>branch==='ALL'||String(c.Branch_ID||'BR001')===branch);
  const vals=[...new Map(scoped.map(c=>[String(c.Campus_ID||c.Campus_Name||''),c])).values()]
    .filter(c=>String(c.Campus_ID||'').trim() || String(c.Campus_Name||c.Location_Name||'').trim());
  const blank=includeBlank
    ? '<option value="">'+(branch==='ALL'?'All / No Specific Campus':'Select campus')+'</option>'
    : '';
  return blank + vals
    .sort((a,b)=>String(a.Campus_Name||a.Location_Name||a.Campus_ID||'').localeCompare(String(b.Campus_Name||b.Location_Name||b.Campus_ID||''),undefined,{numeric:true,sensitivity:'base'}))
    .map(c=>`<option value="${escapeAttr(c.Campus_ID||'')}" ${String(selected)===String(c.Campus_ID||'')?'selected':''}>${escapeHtml(c.Campus_Name||c.Location_Name||c.Campus_ID||'')}</option>`)
    .join('');
}
function onAdminUserRoleOrBranchChanged(){
  const role=String(document.getElementById('adminRole')?.value||'');
  const branch=document.getElementById('adminBranch');
  const campus=document.getElementById('adminCampus');
  if(!branch||!campus)return;
  const multi=role==='Result Operator'||role==='Academic Admin';

  if(role==='Super Admin'){
    branch.multiple=false;
    branch.size=1;
    branch.disabled=true;
    branch.innerHTML='<option value="ALL">All Branches</option>';
    branch.value='ALL';
    campus.innerHTML='<option value="">Not required for Super Admin</option>';
    campus.value='';
    campus.disabled=true;
  }else if(multi){
    const selected=[...branch.options].filter(o=>o.selected).map(o=>String(o.value||'').trim()).filter(Boolean);
    const existing=selected.length?selected:(String(branch.value||'').trim()&&String(branch.value)!=='ALL'?[String(branch.value).trim()]:[]);
    branch.multiple=true;
    branch.size=Math.min(4,Math.max(2,(state.data.branches||[]).length));
    branch.disabled=false;
    branch.innerHTML=(state.data.branches||[]).map(b=>`<option value="${escapeAttr(b.Branch_ID)}" ${existing.includes(String(b.Branch_ID))?'selected':''}>${escapeHtml(b.Branch_Name||b.Branch_ID||'')}</option>`).join('');
    if(!existing.length) [...branch.options].forEach(o=>o.selected=true);
    campus.innerHTML='<option value="">Not required — branch scoped role</option>';
    campus.value='';
    campus.disabled=true;
    const hint=document.getElementById('adminCampusHint');
    if(hint) hint.textContent='Branch scoped role: select one or more authorized branches. Campus selection is not required.';
  }else{
    branch.multiple=false;
    branch.size=1;
    branch.disabled=false;
    if(role==='Campus Admin' && String(branch.value||'ALL')==='ALL'){
      const first=Array.isArray(state.data.branches)?state.data.branches[0]:null;
      if(first) branch.value=String(first.Branch_ID||'BR001');
    }
    const branchId=String(branch.value||'ALL');
    const current=String(campus.value||'');
    campus.disabled=false;
    campus.innerHTML=adminUserCampusOptions(current,branchId,true);
    if(![...campus.options].some(o=>String(o.value)===current)) campus.value='';
    const campusRequired=(role==='Campus Admin'||((role==='Admin'||role==='Attendance Operator')&&branchId!=='ALL'));
    const hint=document.getElementById('adminCampusHint');
    if(hint) hint.textContent=campusRequired?'Campus is required for this role/scope.':(branchId==='ALL'?'Optional when All Branches is selected.':'');
  }
  toggleAttendanceBatchAssignment();
}
function handleAdminBranchChanged(){ onAdminUserRoleOrBranchChanged(); }
function isSuperAdmin(){return String(state.session.user?.Role||'')==='Super Admin'||(String(state.session.user?.Role||'')==='Admin'&&String(state.session.user?.Branch_ID||'')==='ALL');}
function isActualSuperAdmin(){return String(state.session.user?.Role||'')==='Super Admin';}
function canManageProtectedSettings(){const r=String(state.session.user?.Role||'');return r==='Super Admin'||r==='Admin';}
function canManageFacultyMaster(){const r=String(state.session.user?.Role||'');return r==='Super Admin'||r==='Academic Admin'||r==='Admin';}
function effectiveUiBranch(){return isSuperAdmin()?String(state.branchFilter||'ALL'):String(state.session.user?.Branch_ID||'BR001');}
function isFacultyAttendanceGroupBatch_(b){const r=b||{};const type=String(r.Record_Type||'').trim().toUpperCase();const group=String(r.Attendance_Group_Name||'').trim().toLowerCase();const category=String(r.Category_Name||'').trim().toLowerCase();return type==='FACULTY_GROUP'||type==='FACULTY ATTENDANCE GROUP'||group==='trainee'||category==='trainee';}
function facultyGroupName_(b){return String(b?.Attendance_Group_Name||b?.Category_Name||'Trainee').trim();}
function studentAttendanceBatch_(b){return !isFacultyAttendanceGroupBatch_(b);}
function classFromBatch_(b){if(isFacultyAttendanceGroupBatch_(b))return '';return String(b.Class_Name||b.Class||deriveClassFromCategory_(b.Category_Name||b.Category||'')).trim();}
function deriveClassFromCategory_(cat){const c=String(cat||'').toLowerCase(); if(c.includes('challenger')) return 'Challengers'; if(c.includes('xii')) return 'XII'; if(c.includes('xi')) return 'XI'; return ''; }
function scopedBatchesForAttendance(){
  const branch=effectiveUiBranch();
  const cat=state.categoryFilter&&state.categoryFilter!=='All'?state.categoryFilter:'';
  const cls=state.classFilter&&state.classFilter!=='All'?state.classFilter:'';
  const campus=state.campusFilter||'';
  const batch=state.batchFilter||'';
  return (state.data.batches||[]).filter(b=>
    studentAttendanceBatch_(b) &&
    (branch==='ALL'||String(b.Branch_ID||'BR001')===branch) &&
    (!cat||String(b.Category_Name||b.Category||'')===cat) &&
    (!cls||classFromBatch_(b)===cls) &&
    (!campus||String(b.Campus_Name||b.Campus||'')===campus) &&
    (!batch||String(b.Batch_Code||'')===batch)
  );
}
function attendanceClasses(){const branch=effectiveUiBranch();const campus=state.campusFilter||'';const cat=state.categoryFilter&&state.categoryFilter!=='All'?state.categoryFilter:'';return [...new Set((state.data.batches||[]).filter(b=>studentAttendanceBatch_(b)&&(branch==='ALL'||String(b.Branch_ID||'BR001')===branch)&&(!campus||String(b.Campus_Name||b.Campus||'')===campus)&&(!cat||String(b.Category_Name||b.Category||'')===cat)).map(classFromBatch_).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));}
function attendanceCampuses(){
  const branch=effectiveUiBranch(); const cat=state.categoryFilter&&state.categoryFilter!=='All'?state.categoryFilter:'';
  return [...new Set((state.data.batches||[]).filter(b=>studentAttendanceBatch_(b)&&(branch==='ALL'||String(b.Branch_ID||'BR001')===branch)&&(!cat||String(b.Category_Name||b.Category||'')===cat)).map(b=>String(b.Campus_Name||b.Campus||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
}
function attendanceBatchChoices(){
  return [...new Set(scopedBatchesForAttendance().map(b=>String(b.Batch_Code||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
}
function syncAttendanceFilters(){
  const classes=attendanceClasses(); if(state.classFilter&&state.classFilter!=='All'&&!classes.includes(state.classFilter))state.classFilter='All';
  const campuses=attendanceCampuses(); if(state.campusFilter&&!campuses.includes(state.campusFilter))state.campusFilter='';
  const batches=attendanceBatchChoices(); if(state.batchFilter&&!batches.includes(state.batchFilter))state.batchFilter='';
}

function switchAttendanceMode(mode){
  state.attendanceMode=mode==='faculty'?'faculty':'student';
  state.openAttendanceBatchId='';
  state.attendanceDirty=false;
  state.facultyAttendanceDirty=false;
  render();
  if(state.attendanceMode==='faculty')setTimeout(loadFacultyAttendanceOptions,0);
}
function facultyAllowed(){return ['Super Admin','Admin','Academic Admin','Campus Admin','Attendance Operator'].includes(String(state.session.user?.Role||''));}
function campusRestrictedUser(){const r=String(state.session.user?.Role||''); return r==='Campus Admin' || (!isSuperAdmin() && !!String(state.session.user?.Campus_ID||state.session.user?.Campus_Name||'').trim() && r!=='Attendance Operator');}
function attendanceOperatorUser(){return String(state.session.user?.Role||'')==='Attendance Operator';}
function assignedCampusName_(){return String(state.session.user?.Campus_Name||'').trim();}
function roleAllowedPage(page){const r=String(state.session.user?.Role||''); if(isSuperAdmin()||r==='Admin') return true; const map={dashboard:r!=='Result Operator',attendance:['Admin','Academic Admin','Campus Admin','Attendance Operator'].includes(r),students:['Campus Admin','Attendance Operator','Academic Admin','Viewer'].includes(r),uinimport:false,movements:['Campus Admin','Attendance Operator'].includes(r),calendar:['Campus Admin'].includes(r),batches:['Academic Admin'].includes(r),reports:['Campus Admin','Attendance Operator','Result Operator','Academic Admin','Viewer'].includes(r),results:['Result Operator','Academic Admin'].includes(r),faculty:['Academic Admin'].includes(r),settings:true}; if(page==='faculty' && (r==='Super Admin'||r==='Admin'||r==='Academic Admin')) return true; return map[page]||false;}
function facultyBranch(){return isSuperAdmin()?String(state.branchFilter||'ALL'):String(state.session.user?.Branch_ID||'BR001');}
function facultyBatches(){
  const branch=facultyBranch();
  const assignedCampus=campusRestrictedUser()?assignedCampusName_():'';
  return (state.data.batches||[]).filter(b=>(branch==='ALL'||String(b.Branch_ID||'BR001')===branch) && (!assignedCampus || String(b.Campus_Name||b.Campus||'').trim()===assignedCampus)).sort((a,b)=>String(a.Batch_Code||a.Batch_Name||'').localeCompare(String(b.Batch_Code||b.Batch_Name||''),undefined,{numeric:true}));
}
function facultyCategories(){
  return [...new Set(facultyBatches().map(b=>String(b.Category_Name||b.Category||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
}
function facultyClasses(){const cat=state.facultyCategoryFilter||'';return [...new Set(facultyBatches().filter(b=>(!cat||String(b.Category_Name||b.Category||'').trim()===cat)).map(b=>isFacultyAttendanceGroupBatch_(b)?facultyGroupName_(b):classFromBatch_(b)).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));}
function facultyCampuses(){
  const cat=state.facultyCategoryFilter||'';
  const cls=state.facultyClassFilter||'';
  return [...new Set(facultyBatches().filter(b=>
    (!cat||String(b.Category_Name||b.Category||'').trim()===cat) &&
    (!cls||(isFacultyAttendanceGroupBatch_(b)?facultyGroupName_(b):classFromBatch_(b))===cls)
  ).map(b=>String(b.Campus_Name||b.Campus||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
}

function facultyMatrixBatchName_(b){
  if(isFacultyAttendanceGroupBatch_(b)) return facultyGroupName_(b);
  return String(b.Batch_Code??b.Batch_Name??b['Batch Name']??b.Batch??b['Batch/Batches']??b.Batch_Batches??'').trim();
}
function facultyFilteredBatches(){
  const cat=state.facultyCategoryFilter||''; const cls=state.facultyClassFilter||''; const campus=state.facultyCampusFilter||'';
  const assignments=state.facultyOptions.assignments||[];
  const batches=facultyBatches();
  const batchById=new Map(batches.map(b=>[String(b.Batch_ID||'').trim(),b]));
  const batchByCode=new Map(batches.map(b=>[String(b.Batch_Code||b.Batch_Name||'').trim().toLowerCase(),b]));
  const matched=new Map();
  assignments.filter(a=>String(a.Active_Flag||'TRUE').toUpperCase()!=='FALSE').forEach(a=>{
    let b=batchById.get(String(a.Batch_ID||'').trim());
    if(!b) b=batchByCode.get(String(a.Batch_Code||'').trim().toLowerCase());
    if(!b) return;
    const bcat=String(b.Category_Name||b.Category||a.Category_Name||a.Category||'').trim();
    const bcls=isFacultyAttendanceGroupBatch_(b)?facultyGroupName_(b):(classFromBatch_(b)||String(a.Class_Name||'').trim());
    const bcamp=String(b.Campus_Name||b.Campus||a.Campus_Name||'').trim();
    if(cat && bcat!==cat) return;
    if(cls && bcls!==cls) return;
    if(campus && bcamp!==campus) return;
    const key=String(b.Batch_ID||b.Batch_Code||'').trim();
    if(!key || matched.has(key)) return;
    matched.set(key,{...b,__displayBatchName:facultyMatrixBatchName_(b)});
  });
  return [...matched.values()].filter(b=>b.__displayBatchName).sort((a,b)=>String(a.__displayBatchName).localeCompare(String(b.__displayBatchName),undefined,{numeric:true,sensitivity:'base'}));
}
function facultyBatchValue_(b){return String(b.Batch_ID??facultyMatrixBatchName_(b));}
function facultyResetDownstream(level){
  if(level<1) state.facultyCategoryFilter='';
  if(level<2) state.facultyClassFilter='';
  if(level<3) state.facultyCampusFilter='';
  if(level<4) state.facultyBatchFilter='';
}
function normalizeDateKey_(v){const d=v instanceof Date?v:new Date(v);if(!isNaN(d.getTime()))return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;return String(v||'').slice(0,10);}
function facultyAssignmentsForBatch_(batchId){
  const assignments=state.facultyOptions.assignments||[];
  return assignments.filter(a=>String(a.Active_Flag||'TRUE').toUpperCase()!=='FALSE' && String(a.Batch_ID||'')===String(batchId));
}

function splitFacultyMultiValue_(value){
  return String(value??'').split(/[,;|]+/).map(x=>x.trim()).filter(Boolean).filter(x=>!['—','–','-','NA','N/A'].includes(x.toUpperCase()));
}
function facultyMultiValueHas_(value,target,mode){
  const t=String(target??'').trim(); if(!t) return false;
  const norm=v=>mode==='location'
    ? String(v??'').trim().toLowerCase().replace(/[–—]/g,'-').replace(/\s+/g,' ')
    : String(v??'').trim().toUpperCase().replace(/\s+/g,'');
  const nt=norm(t);
  return splitFacultyMultiValue_(value).some(v=>norm(v)===nt);
}
function facultyClassSubjectAssignments_(){
  const order=['Physics','Chemistry','Botany','Zoology','Mathematics','English','MIL','Others'];
  const cat=String(state.facultyCategoryFilter||'').trim();
  const cls=String(state.facultyClassFilter||'').trim();
  const campus=String(state.facultyCampusFilter||'').trim();
  if(!cat||!cls||!campus) return [];

  const faculties=(state.facultyOptions.faculties||[])
    .filter(f=>String(f.Active_Flag||'TRUE').toUpperCase()!=='FALSE');
  const assignments=state.facultyOptions.assignments||[];
  const rows=[];
  const seen=new Set();
  const assignmentIndex=new Map();
  assignments.filter(a=>String(a.Active_Flag||'TRUE').toUpperCase()!=='FALSE').forEach(a=>{
    const key=[String(a.Faculty_ID||'').trim().toUpperCase(),String(a.Subject_Name||a.Subject||'').trim().toLowerCase()].join('|');
    if(!assignmentIndex.has(key)) assignmentIndex.set(key,a);
  });

  faculties.forEach(f=>{
    // IMPORTANT: Campus, Class and Category in Faculty Master are independent
    // comma-separated membership lists. They are NOT positional columns.
    if(!facultyMultiValueHas_(f.Category_Name||f.Category,cat,'token')) return;
    if(!facultyMultiValueHas_(f.Class_Name||f.Class,cls,'token')) return;
    if(!facultyMultiValueHas_(f.Campus_Name||f.Campus,campus,'location')) return;

    const facultyId=String(f.Faculty_ID||'').trim();
    if(!facultyId) return;
    const subjects=splitFacultyMultiValue_(f.Subject||f.Subjects||'');
    const metaName=String(f.Faculty_Name||f.Teacher_Name||'').trim();
    const initials=String(f.Initials||f.Abbreviation||'').trim();

    subjects.forEach(subject=>{
      const key=[facultyId.toUpperCase(),subject.toLowerCase(),campus.toLowerCase(),cls.toLowerCase(),cat.toLowerCase()].join('|');
      if(seen.has(key)) return;
      seen.add(key);
      const a=assignmentIndex.get([facultyId.toUpperCase(),subject.toLowerCase()].join('|'))||{};
      rows.push({
        key,facultyId,facultyName:metaName||String(a.Faculty_Name||a.Teacher_Name||'').trim(),subject,
        initials:initials||String(a.Initials||a.Abbreviation||'').trim(),
        batchId:String(a.Batch_ID||'').trim(),assignmentId:String(a.Assignment_ID||''),scopeType:'CLASS',
        className:cls,campusName:campus,categoryName:cat,source:'FACULTY_MASTER'
      });
    });
  });

  return rows.sort((a,b)=>{
    const ia=order.findIndex(x=>x.toLowerCase()===a.subject.toLowerCase());
    const ib=order.findIndex(x=>x.toLowerCase()===b.subject.toLowerCase());
    if(ia!==ib)return (ia<0?999:ia)-(ib<0?999:ib);
    return a.facultyName.localeCompare(b.facultyName,undefined,{numeric:true,sensitivity:'base'}) ||
      a.subject.localeCompare(b.subject,undefined,{numeric:true,sensitivity:'base'});
  });
}

function facultyFilteredBatches_(){
  return facultyFilteredBatches();
}

function facultySubjectAssignments_(batchId){
  const order=['Physics','Chemistry','Botany','Zoology','Mathematics','English','MIL','Others'];
  const facultyMap=new Map((state.facultyOptions.faculties||[]).map(f=>[
    String(f.Faculty_ID||'').trim(),
    {
      name:String(f.Faculty_Name||f.Teacher_Name||'').trim(),
      initials:String(f.Initials||f.Abbreviation||'').trim()
    }
  ]));
  const rows=[];
  facultyAssignmentsForBatch_(batchId).forEach(a=>{
    const subject=String(a.Subject_Name||a.Subject||'').trim();
    if(!subject)return;
    const facultyId=String(a.Faculty_ID||'').trim();
    const meta=facultyMap.get(facultyId)||{};
    const facultyName=meta.name||String(a.Faculty_Name||a.Teacher_Name||'').trim();
    const initials=meta.initials||String(a.Initials||a.Abbreviation||'').trim();
    const assignmentId=String(a.Assignment_ID||'').trim();
    const key=[
      facultyId.toUpperCase(),
      subject.toLowerCase(),
      String(a.Batch_ID||batchId).trim().toUpperCase()
    ].join('|');
    rows.push({
      key,facultyId,facultyName,subject,initials,
      batchId:String(a.Batch_ID||batchId),
      assignmentId
    });
  });
  const seen=new Set();
  return rows.filter(r=>{if(seen.has(r.key))return false;seen.add(r.key);return true;}).sort((a,b)=>{
    const ia=order.findIndex(x=>x.toLowerCase()===a.subject.toLowerCase());
    const ib=order.findIndex(x=>x.toLowerCase()===b.subject.toLowerCase());
    if(ia!==ib)return (ia<0?999:ia)-(ib<0?999:ib);
    return a.subject.localeCompare(b.subject,undefined,{numeric:true,sensitivity:'base'}) || a.initials.localeCompare(b.initials,undefined,{sensitivity:'base'});
  });
}
function facultySubjectChoices(batchId){
  return [...new Set(facultySubjectAssignments_(batchId).map(x=>x.subject))];
}
function facultyFixedSubject_(subject){return ['Physics','Chemistry'].some(x=>x.toLowerCase()===String(subject||'').trim().toLowerCase());}

function facultyInitialsForAssignment_(assignment){return String(assignment?.initials||'').trim()||'—';}
function findFacultyAttendance_(batchId,assignment){
  const dateKey=normalizeDateKey_(state.date);
  const rows=(state.facultyAttendance||[]).filter(a=>normalizeDateKey_(a.Attendance_Date||'')===dateKey);
  const classScope=String(assignment?.scopeType||'').toUpperCase()==='CLASS';
  return rows.find(a=>{
    const fid=String(a.Faculty_ID||'').trim();
    const subj=String(a.Subject_Name||a.Subject||'').trim().toLowerCase();
    if(fid!==String(assignment?.facultyId||'').trim()) return false;
    if(subj!==String(assignment?.subject||'').trim().toLowerCase()) return false;

    if(classScope){
      return String(a.Attendance_Scope||'').toUpperCase()==='CLASS' &&
        String(a.Class_Name||'').trim().toLowerCase()===String(assignment.className||'').trim().toLowerCase() &&
        String(a.Campus_Name||'').trim().toLowerCase()===String(assignment.campusName||'').trim().toLowerCase();
    }

    return String(a.Batch_ID||'')===String(batchId||'');
  })||{};
}


function loadFacultyAttendanceOptions(){
  if(!facultyAllowed())return;
  if(isGAS()){
    google.script.run.withSuccessHandler(o=>{state.facultyOptions=o||state.facultyOptions;state.facultyAttendance=o?.attendance||state.facultyAttendance||[];renderFacultyAttendanceOnly();}).withFailureHandler(err=>showToast(err.message||'Could not load faculty attendance options')).getFacultyAttendanceOptions(state.session.token,{branchId:facultyBranch(),date:state.date});
  } else {
    renderFacultyAttendanceOnly();
  }
}
function renderFacultyAttendanceOnly(){
  if(state.page==='attendance'&&state.attendanceMode==='faculty'){document.getElementById('content').innerHTML=facultyAttendanceHTML();}
}
function facultyAttendanceHTML(){
  if(!facultyAllowed()) return '<div class="card"><b>Attendance operator authorization required.</b></div>';

  const superAdmin=isSuperAdmin();
  if(!superAdmin) state.branchFilter=String(state.session.user?.Branch_ID||'BR001');
  if(campusRestrictedUser()) state.facultyCampusFilter=assignedCampusName_();

  const categories=facultyCategories();
  const category=state.facultyCategoryFilter||'';
  if(category && !categories.includes(category)) facultyResetDownstream(0);

  const classes=category?facultyClasses():[];
  const cls=state.facultyClassFilter||'';
  if(cls && !classes.includes(cls)) facultyResetDownstream(1);

  const campuses=(category&&cls)?facultyCampuses():[];
  const campus=state.facultyCampusFilter||'';
  if(campus && !campuses.includes(campus)) facultyResetDownstream(2);

  const batches=(category&&cls&&campus)?facultyFilteredBatches():[];
  const currentBatch=state.facultyBatchFilter||'';
  if(currentBatch && !batches.some(b=>facultyBatchValue_(b)===String(currentBatch))) facultyResetDownstream(3);

  // When Batch is left blank after Campus + Class are selected, class-scope
  // attendance becomes the default marking view.
  const classScope=!!(category&&cls&&campus&&!currentBatch);
  const assignmentRows=classScope
    ? facultyClassSubjectAssignments_()
    : (currentBatch?facultySubjectAssignments_(currentBatch):[]);

  const statuses=['Early Arrival','On Time Arrival','Late Arrival by 5–10 Minutes','Late by More Than 15 Minutes','More Than 30 Minutes Late','Absent','Others'];
  const savedCount=assignmentRows.filter(a=>findFacultyAttendance_(classScope?'':currentBatch,a).Attendance_Status).length;

  const currentScopeLabel=classScope
    ? `${escapeHtml(category)} • ${escapeHtml(cls)} • ${escapeHtml(campus)} • All assigned batches`
    : `${escapeHtml(category)} • ${escapeHtml(cls)} • ${escapeHtml(campus)} • ${escapeHtml(batches.find(x=>facultyBatchValue_(x)===currentBatch)?.__displayBatchName||'Selected batch')}`;

  return `<div class="card faculty-attendance-entry">
    <div class="section-title" style="margin-top:0">
      <div>
        <h2 style="margin:0">Faculty / Teacher Attendance</h2>
        <div class="muted">Select the assigned Campus and Class to mark all faculty assigned within that campus/class. Batch remains optional for a more specific batch-level view.</div>
      </div>
      <span class="badge badge-blue">${superAdmin?'All Branches':(String(state.session.user?.Role||'')==='Academic Admin'?'Branch Restricted':'Campus Restricted')}</span>
    </div>

    <div class="toolbar attendance-filters" style="margin:12px 0">
      <input class="input" type="date" value="${escapeAttr(state.date)}" onchange="state.date=this.value;state.facultyAttendanceDirty=false;loadFacultyAttendanceOptions()">
      ${superAdmin?`<select class="select" onchange="state.branchFilter=this.value;facultyResetDownstream(0);loadFacultyAttendanceOptions()"><option value="ALL">Select branch</option>${branchOptionsHtml(facultyBranch())}</select>`:`<div class="select-like locked-filter">${escapeHtml(state.session.user?.Branch_Name||'Assigned Branch')}</div>`}
      <select class="select" onchange="state.facultyCategoryFilter=this.value;facultyResetDownstream(1);renderFacultyAttendanceOnly()">
        <option value="">Select category</option>${categories.map(c=>`<option value="${escapeAttr(c)}" ${category===c?'selected':''}>${escapeHtml(c)}</option>`).join('')}
      </select>
      <select class="select" ${!category?'disabled':''} onchange="state.facultyClassFilter=this.value;facultyResetDownstream(2);renderFacultyAttendanceOnly()">
        <option value="">${category?'Select class':'Select category first'}</option>${category?classes.map(c=>`<option value="${escapeAttr(c)}" ${cls===c?'selected':''}>${escapeHtml(c)}</option>`).join(''):''}
      </select>
      <select class="select" ${(!category||!cls)?'disabled':''} onchange="state.facultyCampusFilter=this.value;facultyResetDownstream(3);renderFacultyAttendanceOnly()">
        <option value="">${category&&cls?'Select campus':'Select class first'}</option>${category&&cls?campuses.map(c=>`<option value="${escapeAttr(c)}" ${campus===c?'selected':''}>${escapeHtml(c)}</option>`).join(''):''}
      </select>
      <select class="select" ${(!category||!cls||!campus)?'disabled':''} onchange="state.facultyBatchFilter=this.value;renderFacultyAttendanceOnly()">
        <option value="">${category&&cls&&campus?'All assigned faculty in selected class':'Select campus first'}</option>
        ${category&&cls&&campus?batches.map(b=>{const value=facultyBatchValue_(b);return `<option value="${escapeAttr(value)}" ${String(currentBatch)===value?'selected':''}>${escapeHtml(b.__displayBatchName)}</option>`}).join(''):''}
      </select>
      <button class="btn btn-secondary" onclick="switchAttendanceMode('student')">Back to Student Attendance</button>
    </div>

    ${assignmentRows.length?`
      <div class="muted small" style="margin-bottom:10px">${currentScopeLabel}</div>
      <div class="grid grid-3" style="margin-bottom:14px">
        ${metricCard('Assigned Entries',assignmentRows.length,'Faculty + Subject mappings','blue')}
        ${metricCard('Saved',savedCount,'Saved attendance entries','green')}
        ${metricCard('Pending',Math.max(0,assignmentRows.length-savedCount),'Not yet saved','yellow')}
      </div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Faculty / Teacher</th><th>Subject</th><th>Initials / Abbreviation</th><th>Arrival / Attendance Status</th><th>Remarks</th><th>Saved At</th></tr></thead>
        <tbody>
          ${assignmentRows.map(a=>{
            const rec=findFacultyAttendance_(classScope?'':currentBatch,a);
            return `<tr>
              <td><b>${escapeHtml(a.facultyName||'—')}</b><div class="muted small">${escapeHtml(a.facultyId||'')}</div></td>
              <td><span class="badge badge-blue">${escapeHtml(a.subject)}</span></td>
              <td><span class="badge badge-purple">${escapeHtml(facultyInitialsForAssignment_(a))}</span></td>
              <td><select class="select faculty-att-status" data-assignment="${escapeAttr(a.key)}" data-batch-id="${escapeAttr(a.batchId||'')}" data-scope-type="${escapeAttr(classScope?'CLASS':'BATCH')}" data-subject="${escapeAttr(a.subject)}" data-faculty-id="${escapeAttr(a.facultyId)}">
                <option value="">Select status</option>
                ${statuses.concat(facultyFixedSubject_(a.subject)?[]:['Not Applicable']).map(st=>`<option value="${escapeAttr(st)}" ${String(rec.Attendance_Status||'')===st?'selected':''}>${escapeHtml(st)}</option>`).join('')}
              </select></td>
              <td><input class="input faculty-att-remark" data-assignment="${escapeAttr(a.key)}" value="${escapeAttr(rec.Remarks||'')}" placeholder="Required only for Others" ${String(rec.Attendance_Status||'')==='Others'?'':'disabled'}></td>
              <td class="muted">${rec.Marked_At?escapeHtml(formatDateTime_(rec.Marked_At)):'—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
      <div class="toolbar" style="margin-top:12px;justify-content:flex-end">
        <span class="muted" id="facultyAttendanceSaveStamp">Last save: ${escapeHtml(state.facultyLastSavedAt||'Not saved')} • Auto-save every 30 sec</span>
        <button class="btn btn-primary" onclick="saveFacultyAttendance()">Save Attendance</button>
      </div>
    `:`<div class="alert">${category&&cls&&campus?'No Faculty Master assignments were found for this campus/class.':'Select Branch, Category, Class and Campus. Batch selection is optional.'}</div>`}
  </div>${facultyLiveAttendanceHTML()}`;
}

function facultyLiveAttendanceRows(){
  const dateKey=normalizeDateKey_(state.date);
  const batches=state.data.batches||[];
  const batchIndex=new Map();
  batches.forEach(b=>{
    const keys=[b.Batch_ID,b.Batch_Code,b.Batch_Name,b['Batch Name'],b.Batch,b['Batch/Batches'],b.Batch_Batches]
      .filter(v=>String(v??'').trim()).map(v=>String(v).trim());
    keys.forEach(k=>{if(!batchIndex.has(k))batchIndex.set(k,b);});
  });

  const assignedCampus=assignedCampusName_().toLowerCase();
  const branch=String(facultyBranch()||'').trim();

  const records=(state.facultyAttendance||[]).filter(a=>{
    if(normalizeDateKey_(a.Attendance_Date||'')!==dateKey) return false;
    if(!String(a.Attendance_Status||'').trim()) return false;
    if(!campusRestrictedUser() && !attendanceOperatorUser()) return true;

    const b=batchIndex.get(String(a.Batch_ID||'').trim()) || batchIndex.get(String(a.Batch_Code||'').trim()) || {};
    const rowBranch=String(a.Branch_ID||b.Branch_ID||'').trim();
    const rowCampus=String(a.Campus_Name||a.Campus||b.Campus_Name||b.Campus||'').trim().toLowerCase();

    if(branch && branch!=='ALL' && rowBranch!==branch) return false;
    if(assignedCampus && rowCampus!==assignedCampus) return false;
    return true;
  });

  const fmap=new Map((state.facultyOptions.faculties||[]).map(f=>[
    String(f.Faculty_ID||'').trim(),
    {
      name:String(f.Faculty_Name||f.Teacher_Name||'').trim(),
      initials:String(f.Initials||f.Abbreviation||'').trim()
    }
  ]));

  return records.map(a=>{
    const b=batchIndex.get(String(a.Batch_ID||'').trim()) || batchIndex.get(String(a.Batch_Code||'').trim()) || {};
    const subject=String(a.Subject_Name||a.Subject||'').trim()||'—';
    const meta=fmap.get(String(a.Faculty_ID||'').trim())||{};
    const initials=meta.initials||String(a.Initials||a.Abbreviation||'').trim()||'—';
    const classScope=String(a.Attendance_Scope||'').trim().toUpperCase()==='CLASS';
    const rowCampus=String(a.Campus_Name||b.Campus_Name||'').trim()||'—';
    const rowClass=String(a.Class_Name||b.Class_Name||deriveClassFromCategory_(a.Category_Name||b.Category_Name)||'').trim()||'—';

    return {
      category:String(a.Category_Name||b.Category_Name||b.Category||'').trim()||'—',
      cls:rowClass,
      campus:rowCampus,
      batchName:classScope?'All assigned batches':(facultyMatrixBatchName_(b)||String(a.Batch_Name||a.Batch_Code||a.Batch_ID||'').trim()||'—'),
      batchId:String(a.Batch_ID||b.Batch_ID||''),
      branchId:String(a.Branch_ID||b.Branch_ID||''),
      branchName:String(a.Branch_Name||b.Branch_Name||'').trim(),
      facultyName:meta.name||String(a.Faculty_Name||'').trim()||'—',
      subject,
      initials,
      status:String(a.Attendance_Status||'').trim(),
      remarks:String(a.Remarks||'').trim(),
      markedAt:a.Marked_At||a.Updated_At||'',
      facultyId:String(a.Faculty_ID||'').trim(),
      scopeType:classScope?'CLASS':'BATCH'
    };
  }).sort((a,b)=>
    String(a.campus).localeCompare(String(b.campus),undefined,{numeric:true,sensitivity:'base'}) ||
    String(a.cls).localeCompare(String(b.cls),undefined,{numeric:true,sensitivity:'base'}) ||
    String(a.batchName).localeCompare(String(b.batchName),undefined,{numeric:true,sensitivity:'base'}) ||
    a.subject.localeCompare(b.subject,undefined,{sensitivity:'base'}) ||
    a.initials.localeCompare(b.initials,undefined,{sensitivity:'base'})
  );
}

function openFacultyLiveAttendance(index){
  const rows=facultyLiveAttendanceRows();
  const row=rows[index];
  if(!row)return;

  state.branchFilter=row.branchId||facultyBranch();
  state.facultyCategoryFilter=row.category==='—'?'':row.category;
  state.facultyClassFilter=row.cls==='—'?'':row.cls;
  state.facultyCampusFilter=row.campus==='—'?'':row.campus;

  if(row.scopeType==='CLASS'){
    state.facultyBatchFilter='';
  }else{
    const batches=facultyFilteredBatches();
    const match=batches.find(b=>facultyMatrixBatchName_(b)===row.batchName) ||
      batches.find(b=>String(b.Batch_ID||'')===row.batchId) ||
      batches[0];
    state.facultyBatchFilter=match?facultyBatchValue_(match):row.batchId;
  }

  renderFacultyAttendanceOnly();
  setTimeout(()=>document.querySelector('.faculty-attendance-entry')?.scrollIntoView({behavior:'smooth',block:'start'}),50);
}

function facultyLiveAttendanceHTML(){
  const rows=facultyLiveAttendanceRows();
  const dateLabel=formatDate(state.date);
  return `<div class="card faculty-live-attendance" style="margin-top:14px"><div class="section-title" style="margin-top:0"><div><h3 style="margin:0">Live Faculty / Teacher Attendance</h3><div class="muted">Each saved record is separately mapped to Subject + Initials / Abbreviation + Batch for ${escapeHtml(dateLabel)}.</div></div><button class="btn btn-secondary btn-sm" onclick="loadFacultyAttendanceOptions()">↻ Refresh</button></div><div class="table-wrap" style="margin-top:12px"><table class="data-table"><thead><tr><th>Category</th><th>Class</th><th>Campus</th><th>Batch</th><th>Faculty / Teacher</th><th>Subject</th><th>Initials / Abbreviation</th><th>Arrival / Attendance Status</th><th>Remarks</th><th>Saved At</th><th>Open</th></tr></thead><tbody>${rows.length?rows.map((r,i)=>`<tr><td><b>${escapeHtml(r.category)}</b></td><td>${escapeHtml(r.cls)}</td><td>${escapeHtml(r.campus)}${r.branchName&&isSuperAdmin()?`<div class="muted small">${escapeHtml(r.branchName)}</div>`:''}</td><td><b>${escapeHtml(r.batchName)}</b></td><td><b>${escapeHtml(r.facultyName||'—')}</b><div class="muted small">${escapeHtml(r.facultyId||'')}</div></td><td><span class="badge badge-blue">${escapeHtml(r.subject)}</span></td><td><span class="badge badge-purple">${escapeHtml(r.initials)}</span></td><td><span class="badge ${r.status==='Absent'?'badge-red':(r.status==='Others'?'badge-yellow':'badge-green')}">${escapeHtml(r.status)}</span></td><td>${escapeHtml(r.remarks||'—')}</td><td class="muted">${r.markedAt?escapeHtml(formatDateTime_(r.markedAt)):'—'}</td><td><button class="btn btn-secondary btn-sm" onclick="openFacultyLiveAttendance(${i})">Open</button></td></tr>`).join(''):`<tr><td colspan="11" class="muted center">No saved faculty attendance records for this date.</td></tr>`}</tbody></table></div></div>`;
}

function formatDateTime_(v){
  const d=v instanceof Date?v:new Date(v); return isNaN(d.getTime())?String(v):d.toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'});
}
function toggleFacultyRemark(input){const row=input.closest('tr');const status=row?.querySelector('.faculty-att-status');input.disabled=status?.value!=='Others';if(status?.value!=='Others')input.value='';}
document.addEventListener('change',e=>{
  if(e.target?.classList?.contains('att-select')) state.attendanceDirty=true;
  if(e.target?.classList?.contains('faculty-att-status')){
    state.facultyAttendanceDirty=true;
    const row=e.target.closest('tr');
    const remark=row?.querySelector('.faculty-att-remark');
    if(remark){remark.disabled=e.target.value!=='Others';if(e.target.value!=='Others')remark.value='';}
  }
  if(e.target?.classList?.contains('faculty-att-remark')) state.facultyAttendanceDirty=true;
});
function saveFacultyAttendance(silent=false){
  const classScope=!state.facultyBatchFilter &&
    !!state.facultyCategoryFilter &&
    !!state.facultyClassFilter &&
    !!state.facultyCampusFilter;

  const batchId=state.facultyBatchFilter||'';
  if(!classScope&&!batchId){
    if(!silent)showToast('Select a class/campus for class-level marking or select a batch for batch-level marking.');
    return;
  }

  if(state._facultySaveInFlight) return;

  const rows=[...document.querySelectorAll('.faculty-att-status')].map(sel=>{
    const assignmentKey=sel.dataset.assignment||'';
    const remark=document.querySelector(`.faculty-att-remark[data-assignment="${CSS.escape(assignmentKey)}"]`);
    return {
      status:sel.value,
      remarks:remark?.value||'',
      batchId:sel.dataset.batchId||batchId,
      subjectName:sel.dataset.subject||'',
      facultyId:sel.dataset.facultyId||'',
      assignmentKey,
      attendanceDate:state.date
    };
  }).filter(r=>String(r.status||'').trim() && String(r.status||'').trim()!=='Not Applicable');

  const others=rows.filter(r=>r.status==='Others');
  if(others.some(r=>!String(r.remarks||'').trim())){
    if(!silent)showToast('Remarks are mandatory when attendance status is Others.');
    return;
  }
  if(!rows.length){
    if(!silent)showToast('Select at least one subject arrival status to save.');
    return;
  }

  const payload={
    date:state.date,
    batchId:classScope?'':batchId,
    subjectRows:rows,
    branchId:facultyBranch(),
    scopeType:classScope?'CLASS':'BATCH',
    categoryName:state.facultyCategoryFilter||'',
    className:state.facultyClassFilter||'',
    campusName:state.facultyCampusFilter||''
  };

  if(isGAS()){
    state._facultySaveInFlight=true;
    if(!silent)showToast('Saving faculty attendance…');
    google.script.run.withSuccessHandler(res=>{
      state._facultySaveInFlight=false;
      state.facultyAttendanceDirty=false;
      state.data.dashboardSnapshot=null;
      state.dashboardFacultyAttendance=null;
      state._dashboardLastRefreshAt=0;
      state.facultyLastSavedAt=res.savedAt||new Date().toISOString();

      const stamp=document.getElementById('facultyAttendanceSaveStamp');
      if(stamp)stamp.textContent='Last save: '+formatDateTime_(state.facultyLastSavedAt);

      const applied=applyAuthoritativeMutationResponse_(res,'attendance',!silent);
      if(!applied&&!silent)loadData({force:true,silent:true,preserveInputs:false});

      if(!silent){
        showToast(`${res.saved||0} faculty attendance records saved`);
        refreshDashboardSnapshot(true);
        refreshDashboardFacultyAttendance_(true);
        loadFacultyAttendanceOptions();
      }else if(state.page==='dashboard'){
        refreshDashboardSnapshot(true);
        refreshDashboardFacultyAttendance_(true);
      }
    }).withFailureHandler(err=>{
      state._facultySaveInFlight=false;
      if(!silent)showToast(err.message||'Could not save faculty attendance');
    }).saveFacultyAttendance(state.session.token,payload);
  }else{
    const keep=[...(state.facultyAttendance||[])];
    const savedAt=new Date().toISOString();

    rows.forEach(r=>{
      const scope=classScope?'CLASS':'BATCH';
      const key=classScope
        ? `${r.attendanceDate}|${r.branchId}|CLASS|${state.facultyCampusFilter}|${state.facultyClassFilter}|${r.facultyId}|${r.subjectName}`
        : `${r.attendanceDate}|${r.branchId}|${r.batchId}|${r.facultyId}|${r.subjectName}`;
      const i=keep.findIndex(a=>String(a.Attendance_ID||'')===key);
      const rec={
        Attendance_ID:key,
        Attendance_Date:r.attendanceDate,
        Branch_ID:r.branchId,
        Batch_ID:classScope?'':r.batchId,
        Faculty_ID:r.facultyId,
        Subject_Name:r.subjectName,
        Attendance_Status:r.status,
        Remarks:r.remarks,
        Attendance_Scope:scope,
        Class_Name:state.facultyClassFilter||'',
        Campus_Name:state.facultyCampusFilter||'',
        Category_Name:state.facultyCategoryFilter||'',
        Marked_By:state.session.user?.User_ID||'local',
        Marked_At:(i>=0?keep[i].Marked_At:savedAt),
        Updated_By:state.session.user?.User_ID||'local',
        Updated_At:savedAt
      };
      if(i>=0)keep[i]=rec;else keep.push(rec);
    });

    state.facultyAttendance=keep;
    state.facultyAttendanceDirty=false;
    state.facultyLastSavedAt=savedAt;
    const stamp=document.getElementById('facultyAttendanceSaveStamp');
    if(stamp)stamp.textContent='Last save: '+formatDateTime_(savedAt);
    if(!silent)showToast(`${rows.length} faculty attendance records saved locally`);
    renderFacultyAttendanceOnly();
  }
}

function startFacultyAutoSave(){
  if(window.__facultyAutoSaveTimer) clearInterval(window.__facultyAutoSaveTimer);
  window.__facultyAutoSaveTimer=setInterval(()=>{
    if(state.page==='attendance'&&state.attendanceMode==='faculty'&&(state.facultyBatchFilter||(state.facultyClassFilter&&state.facultyCampusFilter))&&document.querySelectorAll('.faculty-att-status').length){saveFacultyAttendance(true);}
  },30000);
}
startFacultyAutoSave();
function seedLocalFacultyData(){
  state.facultyOptions.subjects=['Physics','Chemistry','Botany','Zoology','Mathematics','English','MIL','Others'].map(x=>({Subject_ID:x.replace(/\W+/g,'_'),Subject_Name:x,Active_Flag:'TRUE'}));
  const batches=(state.data.batches||[]).slice(0,8); const faculties=[]; const assignments=[]; let i=1;
  batches.forEach(b=>{['Physics','Chemistry','Botany','Zoology'].slice(0,4).forEach(sub=>{const id=`FAC${String(i).padStart(3,'0')}`;faculties.push({Faculty_ID:id,Faculty_Name:`Faculty ${i}`,Branch_ID:b.Branch_ID||'BR001',Active_Flag:'TRUE'});assignments.push({Assignment_ID:`ASN${i}`,Faculty_ID:id,Batch_ID:b.Batch_ID,Subject_Name:sub,Branch_ID:b.Branch_ID||'BR001',Active_Flag:'TRUE'});i++;});});
  state.facultyOptions.faculties=faculties;state.facultyOptions.assignments=assignments;
}

function seedLocalFacultyData(){
  state.facultyOptions.subjects=['Physics','Chemistry','Botany','Zoology','Mathematics','English','MIL','Others'].map(x=>({Subject_ID:x.replace(/\W+/g,'_'),Subject_Name:x,Active_Flag:'TRUE'}));
  const batches=(state.data.batches||[]).slice(0,8); const faculties=[]; const assignments=[]; let i=1;
  batches.forEach(b=>{['Physics','Chemistry','Botany','Zoology'].slice(0,4).forEach(sub=>{const id=`FAC${String(i).padStart(3,'0')}`;faculties.push({Faculty_ID:id,Faculty_Name:`Faculty ${i}`,Branch_ID:b.Branch_ID||'BR001',Active_Flag:'TRUE'});assignments.push({Assignment_ID:`ASN${i}`,Faculty_ID:id,Batch_ID:b.Batch_ID,Subject_Name:sub,Branch_ID:b.Branch_ID||'BR001',Active_Flag:'TRUE'});i++;});});
  state.facultyOptions.faculties=faculties;state.facultyOptions.assignments=assignments;
}

function attendanceHTML(){
  const operator=attendanceOperatorUser();
  if(operator) state.campusFilter=assignedCampusName_();
  const catPool=(state.data.batches||[]).filter(b=>(effectiveUiBranch()==='ALL'||String(b.Branch_ID||'BR001')===effectiveUiBranch()) && (!operator || String(b.Campus_Name||b.Campus||'').trim()===assignedCampusName_())).map(b=>String(b.Category_Name||b.Category||'').trim()).filter(Boolean);
  const cats=['All',...new Set(catPool)];
  const isHoliday=(state.data.calendar||[]).some(e=>String(e.Calendar_Date).slice(0,10)===state.date && String(e.Attendance_Required).toUpperCase()==='FALSE');
  const superAdmin=isSuperAdmin();
  if(!superAdmin) state.branchFilter=String(state.session.user?.Branch_ID||'BR001');
  syncAttendanceFilters();
  if(operator) state.campusFilter=assignedCampusName_();
  const selectedBranch=effectiveUiBranch(); const rows=scopedBatchesForAttendance();
  const classes=attendanceClasses(), campuses=attendanceCampuses(), batchChoices=attendanceBatchChoices();
  const tabs=`<div class="attendance-mode-tabs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><button class="btn ${state.attendanceMode==='student'?'btn-primary':'btn-secondary'}" onclick="switchAttendanceMode('student')">Student Attendance</button><button class="btn ${state.attendanceMode==='faculty'?'btn-primary':'btn-secondary'}" onclick="switchAttendanceMode('faculty')">Faculty / Teacher Attendance</button></div>`;
  const filterMarkup=operator ? `<input class="input" type="date" value="${state.date}" onchange="state.date=this.value;state.openAttendanceBatchId='';state.attendanceDirty=false;loadData()"><select id="attendanceCategory" class="select" onchange="state.categoryFilter=this.value;state.classFilter='All';state.batchFilter='';render()"><option value="All">Select category</option>${cats.slice(1).map(c=>`<option value="${escapeAttr(c)}" ${state.categoryFilter===c?'selected':''}>${escapeHtml(c)}</option>`).join('')}</select><select id="attendanceClass" class="select" ${!state.categoryFilter||state.categoryFilter==='All'?'disabled':''} onchange="state.classFilter=this.value;state.batchFilter='';render()"><option value="">${state.categoryFilter&&state.categoryFilter!=='All'?'Select class':'Select category first'}</option>${state.categoryFilter&&state.categoryFilter!=='All'?classes.map(c=>`<option value="${escapeAttr(c)}" ${state.classFilter===c?'selected':''}>${escapeHtml(c)}</option>`).join(''):''}</select><div class="select-like locked-filter">${escapeHtml(assignedCampusName_()||'Assigned Campus')}</div><select id="attendanceBatch" class="select" ${(!state.categoryFilter||state.categoryFilter==='All'||!state.classFilter||state.classFilter==='All')?'disabled':''} onchange="state.batchFilter=this.value;render()"><option value="">${state.categoryFilter&&state.classFilter&&state.classFilter!=='All'?'Select batch':'Select class first'}</option>${state.categoryFilter&&state.classFilter&&state.classFilter!=='All'?batchChoices.map(b=>`<option value="${escapeAttr(b)}" ${state.batchFilter===b?'selected':''}>${escapeHtml(b)}</option>`).join(''):''}</select><button class="btn btn-secondary" onclick="go('settings')">Attendance Window</button>` : `${superAdmin?`<select class="select" onchange="state.branchFilter=this.value;state.categoryFilter='All';state.classFilter='All';state.campusFilter='';state.batchFilter='';render()"><option value="ALL">All branches</option>${branchOptionsHtml(selectedBranch)}</select>`:`<div class="select-like locked-filter">${escapeHtml(state.session.user?.Branch_Name||'Assigned Branch')}</div>`}${campusRestrictedUser()?`<div class="select-like locked-filter">${escapeHtml(state.session.user?.Campus_Name||campuses[0]||'Assigned Campus')}</div>`:`<select id="attendanceCampus" class="select" onchange="state.campusFilter=this.value;state.classFilter='All';state.batchFilter='';render()"><option value="">All campuses</option>${campuses.map(c=>`<option value="${escapeAttr(c)}" ${state.campusFilter===c?'selected':''}>${escapeHtml(c)}</option>`).join('')}</select>`}<select id="attendanceCategory" class="select" onchange="state.categoryFilter=this.value;state.classFilter='All';state.batchFilter='';render()"><option value="All">All categories</option>${cats.map(c=>`<option value="${escapeAttr(c)}" ${state.categoryFilter===c?'selected':''}>${c}</option>`).join('')}</select><select id="attendanceClass" class="select" ${!state.campusFilter?'disabled':''} onchange="state.classFilter=this.value;state.batchFilter='';render()"><option value="All">${state.campusFilter?'All classes':'Select campus first'}</option>${state.campusFilter?classes.map(c=>`<option value="${escapeAttr(c)}" ${state.classFilter===c?'selected':''}>${escapeHtml(c)}</option>`).join(''):''}</select><select id="attendanceBatch" class="select" ${(!state.campusFilter||state.classFilter==='All')?'disabled':''} onchange="state.batchFilter=this.value;render()"><option value="">${state.campusFilter&&state.classFilter!=='All'?'All batches':'Select class first'}</option>${state.campusFilter&&state.classFilter!=='All'?batchChoices.map(b=>`<option value="${escapeAttr(b)}" ${state.batchFilter===b?'selected':''}>${escapeHtml(b)}</option>`).join(''):''}</select><button class="btn btn-secondary" onclick="go('settings')">Attendance Window</button>`;
  return `${tabs}<div class="card attendance-filter-card"><div class="section-title" style="margin:0 0 12px"><div><h2 style="margin:0">Daily Attendance</h2><div class="muted">${operator?'Campus-specific daily student attendance. Lists cascade Category → Class → Campus → Batch.':'Campus-scoped daily student attendance. Lists cascade from branch → category → class → campus → batch.'}</div></div><span class="badge badge-blue">${superAdmin?'Super Admin':operator?'Campus Restricted':'Branch Restricted'}</span></div><div class="toolbar attendance-filters">${filterMarkup}</div>
  ${isHoliday?`<div class="badge badge-yellow" style="margin-bottom:14px">Attendance not required on this date according to the calendar.</div>`:''}
  <div class="grid grid-6" style="margin-bottom:16px">${metricCard('Eligible',attendanceCounts().eligible,'Current filter','blue')}${metricCard('Present',attendanceCounts().Present,'Marked','green')}${metricCard('Absent',attendanceCounts().Absent,'Marked','red')}${metricCard('Leave',attendanceCounts().Leave,'Marked','yellow')}${metricCard('Sick',attendanceCounts().Sick,'Marked','blue')}${metricCard('Not Marked',Math.max(0,attendanceCounts().Not_Marked),'Pending','gray')}</div>
  <div class="table-wrap"><table class="data-table"><thead><tr><th>Category</th><th>Class</th><th>Campus</th><th>Batch</th><th>Eligible</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(b=>{const x=batchAttendanceSummary(b); const badge=x.status==='Completed'?'badge-green':(x.status==='In Progress'?'badge-blue':'badge-yellow'); return `<tr><td>${escapeHtml(b.Category_Name||b.Category||'')}</td><td>${escapeHtml(classFromBatch_(b))}</td><td>${escapeHtml(b.Campus_Name||b.Campus||'')}</td><td><b>${escapeHtml(b.Batch_Code||'')}</b></td><td>${Number(b.Expected_Strength||0).toLocaleString()}</td><td><span class="badge ${badge}">${x.status}${x.marked?` • ${x.marked}/${x.eligible}`:''}</span></td><td><button class="btn btn-primary" onclick="openAttendance('${escapeAttr(b.Batch_ID)}')">${x.status==='Completed'?'Review':'Open'}</button></td></tr>`}).join('')||`<tr><td colspan="7" class="muted center">No matching campus/class/batch records.</td></tr>`}</tbody></table></div></div>`;
}

function openAttendance(batchId){
  const b=(state.data.batches||[]).find(x=>String(x.Batch_ID)===String(batchId));
  if(!b){showToast('Batch not found');return;}
  state.openAttendanceBatchId=String(batchId);
  state.attendanceDirty=false;
  if(typeof google!=='undefined'&&google.script&&google.script.run){
    showToast('Loading live roster…');
    google.script.run.withSuccessHandler(res=>{
      if(!res.attendanceRequired){ document.getElementById('content').innerHTML=`<div class="card"><div class="section-title" style="margin-top:0"><div><h2>${escapeHtml(b.Batch_Code)} • ${escapeHtml(b.Category_Name)}</h2><div class="muted">${escapeHtml(b.Campus_Name)} • ${formatDate(state.date)}</div></div><button class="btn btn-secondary" onclick="state.openAttendanceBatchId='';state.attendanceDirty=false;render()">Back</button></div><div class="alert"><b>Attendance not required today.</b><br>Calendar rule for this date suppresses routine attendance.</div></div>`; return; }
      renderAttendanceRoster(b,res.rows||[], 'Live roster generated from Current Allocation with effective-date control.');
    }).withFailureHandler(err=>{showToast('Live roster failed: '+(err.message||err)); renderAttendanceRoster(b,sourceAttendanceStudents_(b),'Fallback roster from UIN Master.');}).getAttendanceRoster(state.session.token,batchId,state.date);
  } else { renderAttendanceRoster(b,sourceAttendanceStudents_(b),'Demo roster from UIN Master.'); }
}
function renderAttendanceRoster(b,rows,sourceNote){
  const batchId=b.Batch_ID;
  const counts={Present:0,Absent:0,Leave:0,Sick:0,Not_Marked:0};
  rows.forEach(r=>{const st=String(r.Attendance_Status||'Not Marked'); if(Object.prototype.hasOwnProperty.call(counts,st.replace(/ /g,'_'))) counts[st.replace(/ /g,'_')]++; else counts.Not_Marked++;});
  document.getElementById('content').innerHTML=`<div class="card"><div class="section-title" style="margin-top:0"><div><h2>${escapeHtml(b.Batch_Code)} • ${escapeHtml(b.Category_Name)}</h2><div class="muted">${escapeHtml(b.Campus_Name)} • eligible source roster ${rows.length} • ${formatDate(state.date)}</div></div><button class="btn btn-secondary" onclick="state.openAttendanceBatchId='';state.attendanceDirty=false;render()">Back</button></div><div class="alert" style="margin-bottom:14px">${escapeHtml(sourceNote)}<br><b>Current saved status:</b> Present ${counts.Present} • Absent ${counts.Absent} • Leave ${counts.Leave} • Sick ${counts.Sick} • Not Marked ${counts.Not_Marked}</div><div class="toolbar"><button class="btn btn-success" onclick="markAll('Present')">Mark all Present</button><button class="btn btn-secondary" onclick="markAll('Absent')">Mark all Absent</button><button class="btn btn-secondary" onclick="markAll('Leave')">Mark all Leave</button><button class="btn btn-secondary" onclick="markAll('Sick')">Mark all Sick</button><button class="btn btn-primary" onclick="saveRosterAttendance('${escapeHtml(batchId)}')">Submit Attendance</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>UIN</th><th>Student</th><th>Father</th><th>Status</th><th>Attendance</th></tr></thead><tbody id="attBody">${rows.length?rows.map(r=>{const st=String(r.Attendance_Status||'Not Marked'); return `<tr><td><b>${escapeHtml(r.UIN)}</b></td><td>${escapeHtml(r.Student_Name)}</td><td>${escapeHtml(r.Father_Name||'')}</td><td>${escapeHtml(r.Overall_Status||'Active')}</td><td><select class="select att-select" data-uin="${escapeHtml(r.UIN)}">${['Not Marked','Present','Absent','Leave','Sick'].map(o=>`<option ${st===o?'selected':''}>${o}</option>`).join('')}</select></td></tr>`}).join(''):`<tr><td colspan="5" class="muted">No students are currently eligible for this batch on this date.</td></tr>`}</tbody></table></div></div>`;
}

function batchAttendanceSummary(b){
  const batchId=String(b.Batch_ID||'').trim();
  const batchCode=String(b.Batch_Code||'').trim().toUpperCase();
  const date=state.date;
  const studentUins=new Set();

  // Build the live eligible roster from current allocations/student master so
  // status is based on actual students, not only Batch Expected Strength.
  (state.data.allocations||[]).forEach(a=>{
    if(String(a.Allocation_Status||'Active')!=='Active') return;
    if(String(a.Batch_ID||'').trim()===batchId){
      const u=String(a.UIN||'').trim().toUpperCase();
      if(u) studentUins.add(u);
    }
  });
  (state.data.students||[]).forEach(s=>{
    const status=String(s.Overall_Status||'Active').trim().toLowerCase();
    if(['left','inactive','withdrawn','cancelled'].includes(status)) return;
    const sb=String(s.Batch_ID||'').trim();
    const sc=String(s.Batch_Code||s.Batch||s.Batch_Name||'').trim().toUpperCase();
    if((batchId && sb===batchId) || (batchCode && sc===batchCode)){
      const u=String(s.UIN||'').trim().toUpperCase();
      if(u) studentUins.add(u);
    }
  });

  const fallbackEligible=Number(b.Expected_Strength||0);
  const eligible=studentUins.size||fallbackEligible;
  const rows=(state.data.attendance||[]).filter(a=>normalizeDateKey_(a.Attendance_Date||'')===normalizeDateKey_(date));
  const unique={};
  rows.forEach(r=>{
    const u=String(r.UIN||'').trim().toUpperCase();
    if(!u) return;
    const sameBatch=String(r.Batch_ID||'').trim()===batchId || (!String(r.Batch_ID||'').trim() && studentUins.has(u));
    if(sameBatch && (!studentUins.size || studentUins.has(u))) unique[u]=String(r.Attendance_Status||'').trim();
  });

  const markedStatuses=new Set(['Present','Absent','Leave','Sick']);
  const marked=Object.values(unique).filter(st=>markedStatuses.has(st)).length;
  const status=eligible>0&&marked>=eligible?'Completed':marked>0?'In Progress':'Not Started';
  return {eligible,marked,status};
}

function sourceAttendanceStudents_(b){
  const active=(state.data.students||[]).filter(s=>String(s.Overall_Status||'Active').toLowerCase()!=='left' && String(s.Overall_Status||'Active').toLowerCase()!=='inactive');
  const norm=v=>String(v||'').trim().toLowerCase();
  const batchCode=norm(b.Batch_Code), campus=norm(b.Campus_Name);
  return active.filter(s=>{
    const sb=norm(s.Batch_Code||s.Batch||s.Batch_Name);
    const sc=norm(s.Campus_Name||s.Campus||s.Location_Name);
    const batchMatch=sb===batchCode;
    const campusMatch=!campus || !sc || sc===campus;
    return batchMatch && campusMatch;
  });
}
function saveRosterAttendance(batchId){
  const b=(state.data.batches||[]).find(x=>String(x.Batch_ID)===String(batchId));
  const rows=[...document.querySelectorAll('.att-select')].map(s=>({uin:s.dataset.uin,status:s.value,batchId:b?.Batch_ID||batchId,campusId:b?.Campus_ID||'',campusName:b?.Campus_Name||'',branchId:b?.Branch_ID||state.session.user?.Branch_ID||'BR001'}));
  if(!rows.length){showToast('No student roster to save');return;}
  if(typeof google!=='undefined'&&google.script&&google.script.run){
    showToast('Saving attendance…');
    google.script.run.withSuccessHandler(res=>{
      state.attendanceDirty=false;
      const applied=applyAuthoritativeMutationResponse_(res,'attendance',true);
      if(!applied) syncERPData({silent:true,force:true,preserveInputs:false});
      refreshDashboardSnapshot(true);
      showToast(`${res.saved||0} attendance records saved`);
      setTimeout(()=>openAttendance(batchId),150);
    }).withFailureHandler(err=>showToast('Save failed: '+(err.message||err))).saveAttendance(state.session.token,{date:state.date,batchId:b?.Batch_ID||batchId,rows,markedBy:'Campus/Location Incharge'});
  }else{
    const existing=state.data.attendance||[];
    const keep=existing.filter(a=>!(String(a.Attendance_Date||'').slice(0,10)===state.date && String(a.Batch_ID||'')===String(batchId)));
    rows.filter(r=>r.status && r.status!=='Not Marked').forEach(r=>keep.push({Attendance_ID:`${state.date}|${String(r.uin).trim().toUpperCase()}`,Attendance_Date:state.date,UIN:String(r.uin).trim().toUpperCase(),Batch_ID:r.batchId,Campus_ID:r.campusId,Attendance_Status:r.status,Branch_ID:r.branchId,Marked_At:new Date().toISOString(),Marked_By:state.session.user?.User_ID||'local'}));
    state.data.attendance=keep; state.data.dashboardSnapshot=null; showToast('Attendance saved locally'); render();
  }
}

function markAll(status){document.querySelectorAll('.att-select').forEach(x=>x.value=status)}
function saveDemoAttendance(batchId){const rows=[...document.querySelectorAll('.att-select')].map(s=>({uin:s.dataset.uin,status:s.value,batchId,campusId:''}));if(typeof google!=='undefined'&&google.script&&google.script.run){google.script.run.withSuccessHandler(()=>{showToast('Attendance saved');loadData()}).withFailureHandler(()=>showToast('Save failed')).saveAttendance(state.session.token,{date:state.date,rows,markedBy:'Admin Console'})}else{showToast('Demo attendance submitted locally');}}

let studentImportRows=[];
let studentImportHeaders=[];

function studentsHTML(){
  const count=(state.data.students||[]).length;
  const importPanel = (String(state.session.user?.Role||'')==='Admin' || state.importUnlocked) ? `
    <div class="card upload-panel">
      <div class="section-title" style="margin-top:0"><div><h2>UIN Master Import</h2><div class="muted">Admin-only source master import. Existing UINs are updated; new UINs are appended.</div></div><span class="badge badge-blue">${count.toLocaleString()} loaded</span></div>
      <div class="upload-drop" id="uinDrop" onclick="document.getElementById('uinFile').click()" ondragover="event.preventDefault();this.classList.add('dragover')" ondragleave="this.classList.remove('dragover')" ondrop="handleUinDrop(event)">
        <input id="uinFile" type="file" accept=".csv,.xlsx,.xls" style="display:none" onchange="handleUinFile(this.files[0])">
        <div style="font-size:30px">⇧</div><h3 style="margin:8px 0 4px">Drop CSV or Excel file here</h3><div class="muted">or click to browse • CSV / XLSX / XLS</div>
      </div>
      <div id="importPreview"></div>
      <div class="toolbar" style="margin-top:12px"><button class="btn btn-secondary" onclick="downloadUinTemplate()">Download Template</button><button class="btn btn-secondary" onclick="downloadCurrentUinCsv()">Export Current Master</button></div>
    </div>` : '';
  return `
  <div class="grid grid-2">
    ${importPanel}
    <div class="card">
      <h2 style="margin-top:0;font-size:16px">How the Master is Used</h2>
      <div class="list">
        <div class="list-item"><span><b>Student lookup</b><br><span class="muted">Search by UIN, name or father's name.</span></span><span class="badge badge-green">Live</span></div>
        <div class="list-item"><span><b>Attendance roster</b><br><span class="muted">Imported batch/campus fields can drive daily eligibility.</span></span><span class="badge badge-blue">UIN</span></div>
        <div class="list-item"><span><b>Movement history</b><br><span class="muted">UIN remains unchanged during transfers.</span></span><span class="badge badge-yellow">Audit</span></div>
        <div class="list-item"><span><b>Safe merge</b><br><span class="muted">Existing UINs update; new UINs append.</span></span><span class="badge badge-green">Recommended</span></div>
      </div>
      <div class="alert" style="margin-top:14px"><b>Recommended master columns</b><br><span class="muted">UIN, Student_Name, Father_Name, Programme, Class_Name, Category_Name, Batch_Code, Campus_Name, Residence_Status, Hostel_Name, Room_No, Overall_Status. Extra columns are retained.</span></div>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><div class="section-title" style="margin-top:0"><div><h2>Student Master</h2><div class="muted">Search the currently loaded UIN database.</div></div></div><div class="toolbar"><input class="input" id="studentSearch" placeholder="Search UIN / student / father name / batch / campus" oninput="filterStudents(this.value)" style="min-width:280px;flex:1"><select class="select" id="studentStatusFilter" onchange="filterStudents(document.getElementById('studentSearch')?.value||'')"><option value="">All Status</option><option>Active</option><option>Left</option><option>Inactive</option></select></div><div id="studentTable">${studentTable([])}</div></div>`
}
function filterStudents(q){const status=(document.getElementById('studentStatusFilter')?.value||'').toLowerCase();const query=(q||'').toLowerCase().trim();const items=(state.data.students||[]).filter(s=>{const hay=Object.values(s).join(' ').toLowerCase();const st=String(s.Overall_Status||'Active').toLowerCase();return (!query||hay.includes(query))&&(!status||st===status)}).slice(0,250);document.getElementById('studentTable').innerHTML=studentTable(items)}
function studentTable(rows){if(!rows.length)return '<div class="muted">No student records found. Import your UIN Master above to begin.</div>';return `<div class="table-wrap"><table class="data-table"><thead><tr><th>UIN</th><th>Student</th><th>Father</th><th>Programme</th><th>Class</th><th>Category</th><th>Batch</th><th>Campus</th><th>Residence</th><th>Status</th></tr></thead><tbody>${rows.map(s=>`<tr><td><b>${escapeHtml(s.UIN)}</b></td><td>${escapeHtml(s.Student_Name)}</td><td>${escapeHtml(s.Father_Name||'')}</td><td>${escapeHtml(s.Programme||s.Program||'')}</td><td>${escapeHtml(s.Class_Name||s.Class||'')}</td><td>${escapeHtml(s.Category_Name||s.Category||'')}</td><td>${escapeHtml(s.Batch_Code||s.Batch||'')}</td><td>${escapeHtml(s.Campus_Name||s.Campus||'')}</td><td>${escapeHtml(s.Residence_Status||'')}</td><td><span class="badge ${String(s.Overall_Status||'Active').toLowerCase()==='active'?'badge-green':'badge-yellow'}">${escapeHtml(s.Overall_Status||'Active')}</span></td></tr>`).join('')}</tbody></table></div>`}

function handleUinDrop(ev){ev.preventDefault();document.getElementById('uinDrop').classList.remove('dragover');const f=ev.dataTransfer.files?.[0];if(f)handleUinFile(f)}
function handleUinFile(file){if(!file)return;const ext=(file.name.split('.').pop()||'').toLowerCase();if(!['csv','xlsx','xls'].includes(ext)){showToast('Please choose CSV or Excel (.xlsx/.xls)');return;} if(ext==='csv'){const reader=new FileReader();reader.onload=()=>prepareStudentImport(parseCsvText(reader.result),file.name);reader.readAsText(file);}else{if(typeof XLSX==='undefined'){showToast('Excel reader is unavailable. Use CSV or reconnect to the internet and reload.');return;}const reader=new FileReader();reader.onload=e=>{try{const wb=XLSX.read(e.target.result,{type:'array'});const ws=wb.Sheets[wb.SheetNames[0]];const rows=XLSX.utils.sheet_to_json(ws,{defval:'',raw:false});prepareStudentImport(rows,file.name);}catch(err){showToast('Could not read Excel file: '+err.message)}};reader.readAsArrayBuffer(file);}}
function parseCsvText(text){const rows=[];let row=[],cell='',q=false;for(let i=0;i<text.length;i++){const ch=text[i],nx=text[i+1];if(ch==='"'){if(q&&nx==='"'){cell+='"';i++;}else q=!q;}else if(ch===','&&!q){row.push(cell);cell='';}else if((ch==='\n'||ch==='\r')&&!q){if(ch==='\r'&&nx==='\n')i++;row.push(cell);cell='';if(row.some(v=>String(v).trim()!=='')){rows.push(row)}row=[];}else{cell+=ch;}}row.push(cell);if(row.some(v=>String(v).trim()!==''))rows.push(row);if(!rows.length)return [];const headers=rows[0].map(x=>String(x).trim());return rows.slice(1).map(r=>{const o={};headers.forEach((h,i)=>o[h]=r[i]??'');return o;});}
function normalizeHeader(h){return String(h??'').replace(/^\uFEFF/,'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')}
function normalizeUIN(value){
  if(value===null||value===undefined)return '';
  let s=String(value).replace(/^\uFEFF/,'').trim();
  if(!s)return '';
  s=s.replace(/[\s,]/g,'');
  // Excel may expose a 10-digit numeric UIN as 1234567890.0
  if(/^\d{10}\.0+$/.test(s)) s=s.split('.')[0];
  // Excel may expose numeric UINs in scientific notation. Convert safely for 10-digit values.
  if(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(s)){
    const n=Number(s);
    if(Number.isFinite(n) && Number.isSafeInteger(Math.round(n))) s=Math.trunc(n).toString();
  }
  // Handle decimal numeric values created by spreadsheet exports.
  if(/^\d+\.\d+$/.test(s)){
    const n=Number(s);
    if(Number.isFinite(n) && Number.isInteger(n)) s=String(n);
  }
  return s;
}
function normalizeStudentRows(rows){const aliases={UIN:['uin','student_uin','u_i_n','uin_number','uin_no'],Student_Name:['student_name','student_name_full','name','student'],Father_Name:['father_name','father','fathers_name','fathername'],Programme:['programme','program','course'],Class_Name:['class_name','class','standard'],Category_Name:['category_name','category'],Batch_Code:['batch_code','batch','batch_name'],Campus_Name:['campus_name','campus','location','location_name'],Residence_Status:['residence_status','residential_status','residence','hosteller_day_scholar'],Hostel_Name:['hostel_name','hostel'],Room_No:['room_no','room','room_number'],Overall_Status:['overall_status','status','student_status'],Branch_ID:['branch_id','branch','institute_branch'],Branch_Name:['branch_name','branch_title']};return rows.map(src=>{const norm={};Object.keys(src||{}).forEach(k=>norm[normalizeHeader(k)]=src[k]);const out={};Object.entries(aliases).forEach(([dest,als])=>{const hit=als.find(a=>Object.prototype.hasOwnProperty.call(norm,a));if(hit)out[dest]=dest==='UIN'?normalizeUIN(norm[hit]):String(norm[hit]??'').replace(/^\uFEFF/,'').trim();});Object.keys(src||{}).forEach(k=>{const nk=normalizeHeader(k);if(!Object.values(aliases).flat().includes(nk)){out['EXTRA_'+String(k).trim()]=src[k];}});return out;});}
function prepareStudentImport(rawRows,fileName){const rows=normalizeStudentRows(rawRows);const errors=[];const seen=new Set();rows.forEach((r,i)=>{const rowNo=i+2;const uin=normalizeUIN(r.UIN);r.UIN=uin;if(!uin)errors.push(`Row ${rowNo}: UIN missing`);else if(!/^\d{10}$/.test(uin))errors.push(`Row ${rowNo}: UIN must be exactly 10 digits (found: ${uin})`);if(!r.Student_Name)errors.push(`Row ${rowNo}: Student name missing`);if(!r.Father_Name)errors.push(`Row ${rowNo}: Father name missing`);const key=uin;if(key&&seen.has(key))errors.push(`Row ${rowNo}: duplicate UIN ${key}`);if(key)seen.add(key);});studentImportRows=rows;studentImportHeaders=[...new Set(rows.flatMap(r=>Object.keys(r)))];const preview=rows.slice(0,8);document.getElementById('importPreview').innerHTML=`<div class="import-preview"><div class="section-title" style="margin:0 0 10px"><div><b>${escapeHtml(fileName)}</b><div class="muted">${rows.length.toLocaleString()} records • ${studentImportHeaders.length} columns detected</div></div><span class="badge ${errors.length?'badge-red':'badge-green'}">${errors.length?errors.length+' errors':'Ready to import'}</span></div>${errors.length?`<div class="alert alert-danger" style="margin-bottom:10px">${errors.slice(0,8).map(escapeHtml).join('<br>')}${errors.length>8?'<br>…':''}</div>`:''}<div class="table-wrap"><table class="data-table"><thead><tr>${studentImportHeaders.slice(0,12).map(h=>`<th>${escapeHtml(h.replace(/^EXTRA_/,'').replace(/_/g,' '))}</th>`).join('')}</tr></thead><tbody>${preview.map(r=>`<tr>${studentImportHeaders.slice(0,12).map(h=>`<td>${escapeHtml(r[h]??'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${!errors.length?`<div class="toolbar" style="margin-top:12px"><select class="select" id="uinImportMode"><option value="merge">Merge / Update existing UINs (Recommended)</option><option value="replace">Replace Students sheet (backup created automatically)</option></select><button class="btn btn-primary" onclick="confirmStudentImport()">Import ${rows.length.toLocaleString()} Students</button><button class="btn btn-secondary" onclick="clearStudentImport()">Cancel</button></div>`:''}</div>`}
function confirmStudentImport() {
  if (!studentImportRows.length) return;

  const modeEl = document.getElementById('uinImportMode');
  const mode = modeEl ? modeEl.value : 'merge';

  if (mode === 'replace' && !confirm(
    'Replace the entire Students master? A backup sheet will be created automatically.'
  )) return;

  const payload = {
    mode,
    headers: studentImportHeaders,
    rows: studentImportRows
  };

  if (typeof google !== 'undefined' && google.script && google.script.run) {
    showToast('Importing UIN Master…');

    google.script.run
      .withSuccessHandler(res => {
        const imported = Number(res.imported || 0);
        const verified = Number(res.verifiedCount || 0);

        clearStudentImport();

        syncAfterImport_(res, 'students', data => {
          const loaded = Array.isArray(data?.students)
            ? data.students.length
            : 0;

          showToast(
            `UIN import synchronized • ${imported.toLocaleString()} imported • ${loaded.toLocaleString()} loaded`
          );

          if (verified && loaded === 0) {
            setTimeout(() => showToast(
              `Server verified ${verified.toLocaleString()} Students, but the authorized frontend scope returned 0.`
            ), 2400);
          }
        }, {force:true, preserveInputs:false});
      })
      .withFailureHandler(err => {
        showToast('Import failed: ' + (err.message || err));
      })
      .importStudentsCsv(state.session.token, payload);
  } else {
    const existing = state.data.students || [];
    const map = new Map(existing.map(x => [String(x.UIN).toUpperCase(), x]));
    studentImportRows.forEach(r => map.set(String(r.UIN).toUpperCase(), r));
    state.data.students = [...map.values()];
    clearStudentImport();
    render();
    showToast(`${state.data.students.length.toLocaleString()} student records loaded locally`);
  }
}
function clearStudentImport(){studentImportRows=[];studentImportHeaders=[];const el=document.getElementById('importPreview');if(el)el.innerHTML=''}
function downloadUinTemplate(){const headers=['UIN','Student_Name','Father_Name','Programme','Class_Name','Category_Name','Batch_Code','Campus_Name','Residence_Status','Hostel_Name','Room_No','Overall_Status'];downloadTextFile(headers.join(',')+'\n', 'UIN_Master_Template.csv','text/csv')}
function downloadCurrentUinCsv(){const rows=state.data.students||[];if(!rows.length){showToast('No student master loaded');return;}const headers=[...new Set(rows.flatMap(r=>Object.keys(r)))];const csv=[headers,...rows.map(r=>headers.map(h=>csvEscape(r[h]??'')))].map(r=>r.join(',')).join('\n');downloadTextFile(csv,'UIN_Master_Export.csv','text/csv')}
function downloadTextFile(text,name,type){const blob=new Blob([text],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),500)}
function csvEscape(v){const s=String(v??'');return /[\",\n\r]/.test(s)?'\"'+s.replace(/\"/g,'\"\"')+'\"':s}
function escapeHtml(v){return String(v??'').replace(/[&<>\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[m]))}
function escapeAttr(v){return escapeHtml(v).replace(/`/g,'&#96;').replace(/\n/g,'&#10;').replace(/\r/g,'&#13;')}

function movementBatches(){
  const scope=effectiveUiBranch();
  return (state.data.batches||[]).filter(b=>(scope==='ALL'||String(b.Branch_ID||'BR001')===String(scope))).slice().sort((a,b)=>String(a.Batch_Code||'').localeCompare(String(b.Batch_Code||''),undefined,{numeric:true}));
}
function movementBatchOptions(selected=''){
  return `<option value="">Select batch</option>${movementBatches().map(b=>`<option value="${escapeAttr(b.Batch_ID||'')}" ${String(b.Batch_ID||'')===String(selected)?'selected':''}>${escapeHtml(b.Batch_Code||b.Batch_Name||'')} • ${escapeHtml(b.Campus_Name||'')} • ${escapeHtml(b.Category_Name||'')}</option>`).join('')}`;
}
function movementCampusOptions(selected=''){
  const scope=effectiveUiBranch();
  const vals=[...new Map((state.data.campuses||[]).filter(c=>(scope==='ALL'||String(c.Branch_ID||'BR001')===String(scope))).map(c=>[String(c.Campus_ID||c.Campus_Name),c])).values()];
  return `<option value="">Select campus</option>${vals.map(c=>`<option value="${escapeAttr(c.Campus_ID||'')}" ${String(c.Campus_ID||'')===String(selected)?'selected':''}>${escapeHtml(c.Campus_Name||c.Location_Name||'')}</option>`).join('')}`;
}
function reshuffleSourceBatchChanged(){
  const id=document.getElementById('reshuffleSourceBatch')?.value||'';
  const b=(state.data.batches||[]).find(x=>String(x.Batch_ID)===String(id));
  const dest=document.getElementById('reshuffleDestinationBatch');
  if(dest){
    const rows=movementBatches().filter(x=>String(x.Batch_ID)!==String(id)&&(!b||String(x.Campus_Name||'')===String(b.Campus_Name||'')));
    dest.innerHTML='<option value="">Select source students first</option>'+rows.map(x=>`<option value="${escapeAttr(x.Batch_ID||'')}">${escapeHtml(x.Batch_Code||x.Batch_Name||'')} • ${escapeHtml(x.Campus_Name||'')} • ${escapeHtml(x.Category_Name||'')}</option>`).join('');
    dest.disabled=true;
  }
  loadReshuffleStudents();
}
function updateReshuffleDestinationState(){
  const checked=[...document.querySelectorAll('.reshuffle-student:checked')];
  const dest=document.getElementById('reshuffleDestinationBatch');
  if(dest){
    dest.disabled=checked.length===0;
    if(checked.length===0){ dest.value=''; if(dest.options[0]) dest.options[0].textContent='Select source students first'; }
    else if(dest.options[0]) dest.options[0].textContent='Select destination batch';
  }
  const count=document.getElementById('reshuffleSelectedCount');
  if(count) count.textContent=`${checked.length.toLocaleString()} selected`;
}
function loadReshuffleStudents(){
  const src=document.getElementById('reshuffleSourceBatch')?.value||''; const box=document.getElementById('reshuffleStudents');
  if(!box)return;
  updateReshuffleDestinationState();
  if(!src){box.innerHTML='<div class="muted">Select a source batch to load students.</div>';return;}
  const sourceBatch=(state.data.batches||[]).find(b=>String(b.Batch_ID)===String(src));
  const sourceCode=String(sourceBatch?.Batch_Code||'');
  const rows=(state.data.students||[]).filter(s=>String(s.Batch_ID||'')===String(src)|| (sourceCode && String(s.Batch_Code||'')===sourceCode));
  if(!rows.length){box.innerHTML='<div class="muted">No students mapped to this source batch in the current student master/allocation data.</div>';return;}
  box.innerHTML=`<div class="toolbar" style="margin-bottom:8px"><label class="check-pill"><input type="checkbox" id="reshuffleSelectAll" onchange="document.querySelectorAll('.reshuffle-student').forEach(x=>x.checked=this.checked); updateReshuffleDestinationState()"> Select all</label><span class="muted">${rows.length.toLocaleString()} students</span><span class="badge badge-blue" id="reshuffleSelectedCount">0 selected</span></div><div class="choice-grid reshuffle-student-grid">${rows.map(s=>`<label class="choice-pill"><input class="reshuffle-student" type="checkbox" value="${escapeAttr(s.UIN||'')}" onchange="updateReshuffleDestinationState()"><span><b>${escapeHtml(s.UIN||'')}</b> • ${escapeHtml(s.Student_Name||'')}<small>Father: ${escapeHtml(s.Father_Name||'')}</small></span></label>`).join('')}</div>`;
  updateReshuffleDestinationState();
}
function movementsHTML(){
  const movements=state.data.movements||[]; const reshuffleAllowed=['Admin','Campus Admin','Attendance Operator'].includes(String(state.session.user?.Role||''));
  return `<div class="stack">
  <div class="card"><div class="section-title" style="margin-top:0"><div><h2>Movement Control</h2><div class="muted">Student movement using current batch and campus names. IDs are handled internally.</div></div></div>
  <div class="grid grid-2"><div><label class="small muted">UIN</label><input id="mvUin" class="input" placeholder="UIN"></div><div><label class="small muted">Movement Type</label><select id="mvType" class="select"><option>Batch Transfer</option><option>Campus Transfer</option><option>Residence Change</option><option>Campus + Batch Transfer</option><option>Student Exit</option></select></div></div>
  <div class="grid grid-2" style="margin-top:10px"><div><label class="small muted">From Batch</label><select id="mvFromBatch" class="select">${movementBatchOptions()}</select></div><div><label class="small muted">To Batch</label><select id="mvToBatch" class="select">${movementBatchOptions()}</select></div></div>
  <div class="grid grid-2" style="margin-top:10px"><div><label class="small muted">From Branch</label><select id="mvFromBranch" class="select"><option value="">Current / From Branch</option>${branchOptionsHtml(state.session.user?.Branch_ID||'BR001')}</select></div><div><label class="small muted">To Branch</label><select id="mvToBranch" class="select"><option value="">Select destination branch</option>${branchOptionsHtml(state.session.user?.Branch_ID||'BR001')}</select></div></div>
  <div class="grid grid-2" style="margin-top:10px"><div><label class="small muted">From Campus</label><select id="mvFromCampus" class="select">${movementCampusOptions()}</select></div><div><label class="small muted">To Campus</label><select id="mvToCampus" class="select">${movementCampusOptions()}</select></div></div>
  <div class="grid grid-2" style="margin-top:10px"><div><label class="small muted">New Residence</label><select id="mvResidence" class="select"><option value="">No change</option><option>Hosteller</option><option>Day Scholar</option></select></div><div><label class="small muted">Effective Date</label><input id="mvDate" type="date" class="input" value="${state.date}"></div></div>
  <div style="margin-top:10px"><label class="small muted">Reason</label><textarea id="mvReason" class="input" style="min-height:80px" placeholder="Reason / approval note"></textarea></div>
  <div class="toolbar" style="margin-top:12px"><button class="btn btn-primary" onclick="submitMovementRequest()">Create Movement Request</button><button class="btn btn-secondary" onclick="loadData()">Refresh</button></div></div>
  ${reshuffleAllowed?`<div class="card"><div class="section-title" style="margin-top:0"><div><h2>Batch Reshuffle</h2><div class="muted">Select students from any authorized source batch and move them to another batch. Source/destination batch names are shown; internal IDs remain hidden.</div></div><span class="badge badge-gold">Bulk Movement</span></div><div class="grid grid-3"><div><label class="small muted">Source Batch</label><select id="reshuffleSourceBatch" class="select" onchange="reshuffleSourceBatchChanged()">${movementBatchOptions()}</select></div><div><label class="small muted">Destination Batch</label><select id="reshuffleDestinationBatch" class="select" disabled><option value="">Select source students first</option></select><small class="muted" style="display:block;margin-top:5px">Select students below before choosing destination.</small></div><div><label class="small muted">Effective Date</label><input id="reshuffleDate" type="date" class="input" value="${state.date}"></div></div><div id="reshuffleStudents" class="card-soft" style="margin-top:12px"><div class="muted">Select a source batch to load students.</div></div><div class="toolbar" style="margin-top:12px"><textarea id="reshuffleReason" class="input" style="min-height:52px;max-width:520px" placeholder="Reason for batch reshuffle"></textarea><button class="btn btn-primary" onclick="submitBatchReshuffle()">Create Reshuffle Requests</button></div></div>`:''}
  <div class="card"><div class="section-title" style="margin-top:0"><h2>Movement Queue</h2><span class="badge badge-yellow">Operational authority</span></div><div class="list">${movements.length?movements.slice().reverse().map(m=>{const fb=(state.data.batches||[]).find(b=>String(b.Batch_ID)===String(m.From_Batch_ID));const tb=(state.data.batches||[]).find(b=>String(b.Batch_ID)===String(m.To_Batch_ID));const fc=(state.data.campuses||[]).find(c=>String(c.Campus_ID)===String(m.From_Campus_ID));const tc=(state.data.campuses||[]).find(c=>String(c.Campus_ID)===String(m.To_Campus_ID));return `<div class="list-item"><span><b>${escapeHtml(m.UIN)}</b> • ${escapeHtml(m.Movement_Type||'Movement')}<br><span class="muted">Batch ${escapeHtml(fb?.Batch_Code||m.From_Batch_ID||'—')} → ${escapeHtml(tb?.Batch_Code||m.To_Batch_ID||'—')} • Campus ${escapeHtml(fc?.Campus_Name||m.From_Campus_ID||'—')} → ${escapeHtml(tc?.Campus_Name||m.To_Campus_ID||'—')} • Effective ${escapeHtml(String(m.Effective_Date||'').slice(0,10))} • ${escapeHtml(m.Status||'Pending')}</span></span>${String(m.Status||'Pending').toLowerCase()==='pending'?`<button class="btn btn-success" onclick="approveMovementRequest('${escapeHtml(m.Movement_ID)}')">Approve</button>`:`<span class="badge badge-green">Approved</span>`}</div>`;}).join(''):'<div class="muted">No movement transactions yet.</div>'}</div></div></div>`;
}
function submitBatchReshuffle(){
  const src=document.getElementById('reshuffleSourceBatch')?.value||'', dst=document.getElementById('reshuffleDestinationBatch')?.value||'', date=document.getElementById('reshuffleDate')?.value||state.date;
  const uins=[...document.querySelectorAll('.reshuffle-student:checked')].map(x=>x.value).filter(Boolean);
  if(!src||!dst){showToast('Select source and destination batch.');return;} if(!uins.length){showToast('Select at least one student.');return;} if(src===dst){showToast('Source and destination batch must be different.');return;}
  const sb=(state.data.batches||[]).find(b=>String(b.Batch_ID)===String(src)); const db=(state.data.batches||[]).find(b=>String(b.Batch_ID)===String(dst));
  const reason=document.getElementById('reshuffleReason')?.value||'Batch reshuffle';
  if(isGAS()){showToast(`Creating ${uins.length} reshuffle request(s)…`);google.script.run.withSuccessHandler(res=>{showToast(`${res.created||uins.length} reshuffle requests created`);loadData();go('movements');}).withFailureHandler(err=>showToast(err.message||'Could not create reshuffle')).batchReshuffle(state.session.token,{sourceBatchId:src,destinationBatchId:dst,sourceCampusId:sb?.Campus_ID||'',destinationCampusId:db?.Campus_ID||'',effectiveDate:date,uins,reason});}
  else {showToast(`${uins.length} demo reshuffle request(s) created locally`);}
}
function submitMovementRequest(){
  const payload={UIN:document.getElementById('mvUin').value.trim(),Movement_Type:document.getElementById('mvType').value,From_Batch_ID:document.getElementById('mvFromBatch').value.trim(),To_Batch_ID:document.getElementById('mvToBatch').value.trim(),From_Branch_ID:document.getElementById('mvFromBranch')?.value||state.session.user?.Branch_ID||'BR001',To_Branch_ID:document.getElementById('mvToBranch')?.value||state.session.user?.Branch_ID||'BR001',From_Campus_ID:document.getElementById('mvFromCampus').value.trim(),To_Campus_ID:document.getElementById('mvToCampus').value.trim(),To_Residence:document.getElementById('mvResidence').value,Effective_Date:document.getElementById('mvDate').value,Reason:document.getElementById('mvReason').value,Status:'Pending',Requested_By:'Campus/Location Incharge'};
  if(!payload.UIN||!payload.Effective_Date){showToast('UIN and effective date are required');return;}
  if(typeof google!=='undefined'&&google.script&&google.script.run){google.script.run.withSuccessHandler(()=>{showToast('Movement request created');loadData();go('movements')}).withFailureHandler(err=>showToast('Movement request failed: '+(err.message||err))).saveMovement(state.session.token,payload);}else{showToast('Demo movement request created');}
}
function approveMovementRequest(id){
  if(typeof google!=='undefined'&&google.script&&google.script.run){google.script.run.withSuccessHandler(res=>{showToast(res.alreadyApproved?'Already approved':'Movement approved and current allocation updated');loadData();go('movements')}).withFailureHandler(err=>showToast('Approval failed: '+(err.message||err))).approveMovement(state.session.token,id,'Central Admin');}else{showToast('Demo movement approved');}
}

function calendarLocalDateKey(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function calendarMonthDays(year,month){const first=new Date(year,month,1);const start=first.getDay();const last=new Date(year,month+1,0).getDate();const cells=[];for(let i=0;i<start;i++)cells.push(null);for(let d=1;d<=last;d++)cells.push(new Date(year,month,d));while(cells.length%7)cells.push(null);return cells;}
function calendarEventsForDate(date){const d=typeof date==='string'?date:calendarLocalDateKey(date);return (state.data.calendar||[]).filter(e=>String(e.Calendar_Date||'').slice(0,10)===d);}
function calendarSelectedDates(){return Array.from(document.querySelectorAll('.calendar-day.calendar-selected')).map(el=>el.dataset.date).filter(Boolean);}
function toggleCalendarDate(date){const el=document.querySelector(`.calendar-day[data-date="${date}"]`);if(!el)return;el.classList.toggle('calendar-selected');const selected=calendarSelectedDates();const counter=document.getElementById('calendarSelectedCount');if(counter)counter.textContent=`${selected.length} date${selected.length===1?'':'s'} selected`;selectCalendarDate(date,false);}
function selectWeekdayDates(dayIndex){document.querySelectorAll('.calendar-day[data-date]').forEach(el=>el.classList.remove('calendar-selected'));document.querySelectorAll('.calendar-day[data-date]').forEach(el=>{const d=new Date(el.dataset.date+'T12:00:00');if(d.getDay()===dayIndex)el.classList.add('calendar-selected');});const counter=document.getElementById('calendarSelectedCount');const selected=calendarSelectedDates();if(counter)counter.textContent=`${selected.length} dates selected`;
}
function selectAllSundays(){selectWeekdayDates(0);}
function selectChosenWeekday(){const v=document.getElementById('calendarWeekdayPicker')?.value; if(v!=='') selectWeekdayDates(Number(v));}
function clearCalendarSelection(){document.querySelectorAll('.calendar-day[data-date]').forEach(el=>el.classList.remove('calendar-selected'));const counter=document.getElementById('calendarSelectedCount');if(counter)counter.textContent='0 dates selected';}
function calendarScopeOptions(selectedScope, selectedId){
  const branchOpts=(state.data.branches||[]).filter(b=>String(b.Active_Flag||'TRUE').toUpperCase()!=='FALSE').map(b=>`<option value="${escapeAttr(b.Branch_ID)}" ${String(selectedId)===String(b.Branch_ID)&&selectedScope==='Branch'?'selected':''}>${escapeHtml(b.Branch_Name||b.Branch_ID)}</option>`).join('');
  const campusOpts=(state.data.campuses||[]).map(c=>`<option value="${escapeAttr(c.Campus_ID||c.Campus_Name)}" ${String(selectedId)===String(c.Campus_ID||c.Campus_Name)&&selectedScope==='Campus'?'selected':''}>${escapeHtml(c.Campus_Name||c.Campus_ID)}</option>`).join('');
  return `<option ${selectedScope==='Institute'?'selected':''}>Institute</option><option ${selectedScope==='Branch'?'selected':''}>Branch</option><option ${selectedScope==='Campus'?'selected':''}>Campus</option><option ${selectedScope==='Category'?'selected':''}>Category</option><option ${selectedScope==='Batch'?'selected':''}>Batch</option>`;
}
function syncCalendarScopeTarget(){const scope=document.getElementById('calScope')?.value;const wrap=document.getElementById('calScopeTargetWrap');if(!wrap)return;let html='';if(scope==='Branch'){html=`<label class="small muted">Branch</label><select id="calScopeId" class="select"><option value="">Select branch</option>${(state.data.branches||[]).map(b=>`<option value="${escapeAttr(b.Branch_ID)}">${escapeHtml(b.Branch_Name||b.Branch_ID)}</option>`).join('')}</select>`;}else if(scope==='Campus'){html=`<label class="small muted">Campus</label><select id="calScopeId" class="select"><option value="">Select campus</option>${(state.data.campuses||[]).map(c=>`<option value="${escapeAttr(c.Campus_ID||c.Campus_Name)}">${escapeHtml(c.Campus_Name||c.Campus_ID)}</option>`).join('')}</select>`;}else if(scope==='Category'){html=`<label class="small muted">Category</label><select id="calScopeId" class="select"><option value="">Select category</option>${[...new Set((state.data.batches||[]).map(b=>String(b.Category_Name||'').trim()).filter(Boolean))].sort().map(x=>`<option>${escapeHtml(x)}</option>`).join('')}</select>`;}else if(scope==='Batch'){html=`<label class="small muted">Batch</label><select id="calScopeId" class="select"><option value="">Select batch</option>${(state.data.batches||[]).map(b=>`<option value="${escapeAttr(b.Batch_ID)}">${escapeHtml(b.Batch_Code||b.Batch_Name||b.Batch_ID)}</option>`).join('')}</select>`;}wrap.innerHTML=html?`<div style="margin-top:10px">${html}</div>`:'';}
function calendarHTML(){
  const admin=String(state.session.user?.Role||'')==='Admin' && String(state.session.user?.Branch_ID||'')==='ALL'; const today=new Date(state.date+'T12:00:00'); const year=state.calendarViewYear||today.getFullYear(); const month=state.calendarViewMonth==null?today.getMonth():state.calendarViewMonth; const cells=calendarMonthDays(year,month); const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const grid=cells.map(d=>{if(!d)return '<div class="calendar-day calendar-empty"></div>';const iso=calendarLocalDateKey(d);const ev=calendarEventsForDate(iso);const dayClass=ev.some(e=>String(e.Attendance_Required).toUpperCase()==='FALSE')?'day-off':ev.length?'day-event':'';return `<button type="button" class="calendar-day ${dayClass}" data-date="${iso}" onclick="toggleCalendarDate('${iso}')"><span class="calendar-number">${d.getDate()}</span>${ev.slice(0,2).map(e=>`<span class="calendar-chip ${String(e.Attendance_Required).toUpperCase()==='TRUE'?'chip-work':'chip-off'}">${escapeHtml(e.Event_Name||e.Calendar_Type||'Event')}</span>`).join('')}${ev.length>2?`<span class="calendar-more">+${ev.length-2} more</span>`:''}</button>`;}).join('');
  const events=(state.data.calendar||[]).slice().sort((a,b)=>String(a.Calendar_Date).localeCompare(String(b.Calendar_Date)));
  return `<div class="grid grid-2"><div class="card calendar-card"><div class="section-title" style="margin-top:0"><div><h2>Attendance Calendar</h2><div class="muted">Select one or multiple dates, choose a weekday pattern such as all Sundays, then apply one calendar rule.</div></div><div class="toolbar"><button class="btn btn-secondary" onclick="shiftCalendarMonth(-1)">‹</button><button class="btn btn-secondary" onclick="shiftCalendarMonth(0)">Today</button><button class="btn btn-secondary" onclick="shiftCalendarMonth(1)">›</button></div></div><div class="calendar-title"><h3>${new Date(year,month,1).toLocaleString(undefined,{month:'long',year:'numeric'})}</h3><span id="calendarSelectedCount" class="badge badge-blue">0 dates selected</span></div><div class="calendar-quickbar"><button class="btn btn-secondary" onclick="selectAllSundays()">Select all Sundays</button><select id="calendarWeekdayPicker" class="select compact-select" onchange="selectChosenWeekday()"><option value="">Select any weekday…</option><option value="0">Sunday</option><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option></select><button class="btn btn-secondary" onclick="clearCalendarSelection()">Clear selection</button></div><div class="calendar-weekdays">${weekdays.map(x=>`<div>${x}</div>`).join('')}</div><div class="calendar-grid">${grid}</div></div><div class="card"><div class="section-title" style="margin-top:0"><h2>Calendar Rule</h2><span class="badge badge-blue">Admin editable</span></div><div id="calendarEditor"><div class="muted">Select date(s) from the calendar.</div></div><div style="margin-top:14px"><h3 style="font-size:15px">Upcoming / Existing Logic</h3><div class="list">${events.length?events.map(e=>`<div class="list-item"><span><b>${formatDate(String(e.Calendar_Date).slice(0,10))}</b><br>${escapeHtml(e.Event_Name||'')} <span class="muted">• ${escapeHtml(e.Calendar_Type||'')} • ${escapeHtml(e.Scope_Type||'Institute')}</span></span>${admin?`<button class="btn btn-secondary" onclick="selectCalendarDate('${String(e.Calendar_Date).slice(0,10)}',true)">Edit</button>`:`<span class="badge ${String(e.Attendance_Required).toUpperCase()==='TRUE'?'badge-green':'badge-yellow'}">${String(e.Attendance_Required).toUpperCase()==='TRUE'?'Attendance Required':'No Attendance'}</span>`}</div>`).join(''):'<div class="muted">No calendar entries yet.</div>'}</div></div></div></div>`;
}
function shiftCalendarMonth(delta){const base=new Date(state.calendarViewYear||new Date(state.date+'T12:00:00').getFullYear(),state.calendarViewMonth==null?new Date(state.date+'T12:00:00').getMonth():state.calendarViewMonth,1);if(delta===0){state.calendarViewYear=new Date(state.date+'T12:00:00').getFullYear();state.calendarViewMonth=new Date(state.date+'T12:00:00').getMonth();}else{base.setMonth(base.getMonth()+delta);state.calendarViewYear=base.getFullYear();state.calendarViewMonth=base.getMonth();}clearCalendarSelection();render();}
function selectCalendarDate(date,resetSelection=true){
  if(resetSelection){clearCalendarSelection();const el=document.querySelector(`.calendar-day[data-date="${date}"]`);if(el)el.classList.add('calendar-selected');}
  const ev=calendarEventsForDate(date)[0]||{Calendar_Date:date,Calendar_Type:'Working Day',Event_Name:'',Scope_Type:'Institute',Scope_ID:'',Attendance_Required:true,Remarks:''};
  const el=document.getElementById('calendarEditor'); if(!el)return;
  const admin=String(state.session.user?.Role||'')==='Admin' && String(state.session.user?.Branch_ID||'')==='ALL';
  if(!admin){el.innerHTML=`<div class="alert"><b>${formatDate(date)}</b><br>${escapeHtml(ev.Event_Name||ev.Calendar_Type||'No special calendar rule')}<br><span class="muted">${String(ev.Attendance_Required).toUpperCase()==='TRUE'?'Attendance required':'Attendance not required'}</span></div>`;return;}
  const selectedCount=calendarSelectedDates().length;
  el.innerHTML=`<div class="alert">${selectedCount||1} date(s) selected. For example, choose all Sundays to apply one rule to every Sunday in the visible month.</div><div><label class="small muted">Calendar Type</label><select id="calType" class="select"><option ${ev.Calendar_Type==='Working Day'?'selected':''}>Working Day</option><option ${ev.Calendar_Type==='Declared Holiday'?'selected':''}>Declared Holiday</option><option ${ev.Calendar_Type==='Listed Holiday'?'selected':''}>Listed Holiday</option><option ${ev.Calendar_Type==='Official Event'?'selected':''}>Official Event</option><option ${ev.Calendar_Type==='Special Working Day'?'selected':''}>Special Working Day</option><option ${ev.Calendar_Type==='Exam Day'?'selected':''}>Exam Day</option></select></div><div style="margin-top:10px"><label class="small muted">Event / Remarks Title</label><input id="calEvent" class="input" value="${escapeAttr(ev.Event_Name||'')}" placeholder="e.g. Sunday / Independence Day / NEET Mock Exam"></div><div style="margin-top:10px"><label class="small muted">Scope</label><select id="calScope" class="select" onchange="syncCalendarScopeTarget()">${calendarScopeOptions(ev.Scope_Type,ev.Scope_ID)}</select><div id="calScopeTargetWrap"></div></div><div style="margin-top:10px"><label class="small muted">Attendance Required</label><select id="calAttendance" class="select"><option value="true" ${String(ev.Attendance_Required).toUpperCase()==='TRUE'?'selected':''}>Yes — Attendance Required</option><option value="false" ${String(ev.Attendance_Required).toUpperCase()!=='TRUE'?'selected':''}>No — Suppress Attendance</option></select></div><div style="margin-top:10px"><label class="small muted">Remarks</label><textarea id="calRemarks" class="input" style="min-height:70px">${escapeHtml(ev.Remarks||'')}</textarea></div><div class="toolbar" style="margin-top:12px"><button class="btn btn-primary" onclick="saveCalendarFromEditor('${escapeAttr(ev.Calendar_ID||'')}')">Apply to Selected Dates</button><button class="btn btn-secondary" onclick="clearCalendarSelection();selectCalendarDate('${escapeAttr(date)}')">Reset</button></div>`;
  setTimeout(()=>{if(document.getElementById('calScope'))syncCalendarScopeTarget();const target=document.getElementById('calScopeId');if(target && ev.Scope_ID)target.value=ev.Scope_ID;},0);
}
function saveCalendarFromEditor(id){const dates=calendarSelectedDates();const dateFallback=document.querySelector('.calendar-day.calendar-selected')?.dataset.date||state.date;const selectedDates=dates.length?dates:[dateFallback];const scope=document.getElementById('calScope')?.value||'Institute';const scopeId=document.getElementById('calScopeId')?.value||'';const event={Calendar_Date:selectedDates[0],Calendar_Type:document.getElementById('calType')?.value,Event_Name:document.getElementById('calEvent')?.value||'',Scope_Type:scope,Scope_ID:scopeId,Attendance_Required:document.getElementById('calAttendance')?.value==='true',Remarks:document.getElementById('calRemarks')?.value||'',Approved_By:state.session.user?.User_ID||''};if(scope!=='Institute'&&!scopeId){showToast('Select the target '+scope.toLowerCase());return;}if(isGAS()){google.script.run.withSuccessHandler(res=>{showToast(`${res.saved||selectedDates.length} calendar date(s) updated`);loadData();setTimeout(()=>{render();},350)}).withFailureHandler(err=>showToast(err.message||'Could not save calendar logic')).saveCalendarEventsBulk(state.session.token,{...event,Calendar_ID:id||''},selectedDates);}else{const arr=state.data.calendar||[];selectedDates.forEach((d,i)=>{const match=arr.find(e=>String(e.Calendar_Date||'').slice(0,10)===String(d)&&String(e.Scope_Type||'Institute')===scope&&String(e.Scope_ID||'')===scopeId);const row=Object.assign({},event,{Calendar_ID:match?.Calendar_ID||String(Date.now()+i),Calendar_Date:d});if(match)Object.assign(match,row);else arr.push(row);});showToast(`${selectedDates.length} calendar date(s) updated locally`);clearCalendarSelection();render();}}
function addDemoCalendarEvent(){selectCalendarDate(state.date);}

function batchClassName(b){const explicit=String(b.Class_Name||b.Class||'').trim();if(explicit)return explicit;const c=String(b.Category_Name||'').trim().toLowerCase();if(c.includes('challenger'))return 'Challengers';if(c.includes('xii'))return 'XII';if(c.includes('xi'))return 'XI';return '';}
function batchProgrammeOptions(){return [...new Set((state.data.batches||[]).map(b=>String(b.Programme||'').trim()).filter(Boolean))].sort();}
function batchCategoryOptions(){return [...new Set((state.data.batches||[]).map(b=>String(b.Category_Name||'').trim()).filter(Boolean))].sort();}
function batchCampusOptions(){return [...new Set((state.data.batches||[]).map(b=>String(b.Campus_Name||'').trim()).filter(Boolean))].sort();}
function batchEditRow(id){const b=(state.data.batches||[]).find(x=>String(x.Batch_ID)===String(id));if(!b)return;if(isFacultyAttendanceGroupBatch_(b)){showToast('Faculty Group records are managed through Faculty Master / Matrix import.');return;}const tr=[...document.querySelectorAll('tr[data-batch-id]')].find(x=>String(x.dataset.batchId)===String(id));if(!tr)return;const campusOpts=batchCampusOptions().map(v=>`<option ${String(v)===String(b.Campus_Name||'')?'selected':''}>${escapeHtml(v)}</option>`).join('');const catOpts=batchCategoryOptions().map(v=>`<option ${String(v)===String(b.Category_Name||'')?'selected':''}>${escapeHtml(v)}</option>`).join('');const progOpts=batchProgrammeOptions().map(v=>`<option ${String(v)===String(b.Programme||'')?'selected':''}>${escapeHtml(v)}</option>`).join('');tr.innerHTML=`<td>${escapeHtml(b.Branch_Name||'')}</td><td><select class="select compact-edit" id="editProg_${escapeAttr(id)}">${progOpts}</select></td><td><select class="select compact-edit" id="editCat_${escapeAttr(id)}">${catOpts}</select></td><td><select class="select compact-edit" id="editCampus_${escapeAttr(id)}">${campusOpts}</select></td><td><input class="input compact-edit" id="editBatch_${escapeAttr(id)}" value="${escapeAttr(b.Batch_Code||'')}"></td><td><select class="select compact-edit" id="editGender_${escapeAttr(id)}"><option ${String(b.Gender_Group||'')==='Boys'?'selected':''}>Boys</option><option ${String(b.Gender_Group||'')==='Girls'?'selected':''}>Girls</option><option ${String(b.Gender_Group||'')==='Co-ed'?'selected':''}>Co-ed</option></select></td><td><input class="input compact-edit" id="editStrength_${escapeAttr(id)}" type="number" min="0" step="1" value="${Number(b.Expected_Strength||0)}"></td><td class="actions-cell"><button class="btn btn-success" onclick="saveBatchEdit('${escapeAttr(id)}')">Save</button><button class="btn btn-secondary" onclick="render()">Cancel</button></td>`;}
function saveBatchEdit(id){if(!isSuperAdminSession()){showToast('Super Admin authorization required.');return;}const payload={Batch_Code:document.getElementById(`editBatch_${id}`)?.value.trim(),Campus_Name:document.getElementById(`editCampus_${id}`)?.value,Category_Name:document.getElementById(`editCat_${id}`)?.value,Programme:document.getElementById(`editProg_${id}`)?.value,Expected_Strength:document.getElementById(`editStrength_${id}`)?.value,Gender_Group:document.getElementById(`editGender_${id}`)?.value};if(!payload.Batch_Code||!payload.Campus_Name||!payload.Category_Name||!payload.Programme){showToast('Batch, Campus, Category and Programme are required.');return;}if(isGAS()){google.script.run.withSuccessHandler(res=>{refreshERPDataAndRender('batches',()=>showToast('Batch matrix row updated and synchronized'),{silent:true,force:true});}).withFailureHandler(err=>showToast(err.message||'Could not update batch')).adminUpdateBatch(state.session.token,id,payload);}else{const b=(state.data.batches||[]).find(x=>String(x.Batch_ID)===String(id));if(b)Object.assign(b,payload,{Expected_Strength:Number(payload.Expected_Strength)});showToast('Batch matrix row updated locally');render();}}
function batchMatrixTemplate(){downloadTextFile('Record_Type,Attendance_Group_Name,Branch_ID,Branch_Name,Programme,Category_Name,Class_Name,Campus_ID,Campus_Name,Batch_Code,Batch_Name,Gender_Group,Expected_Strength\nSTUDENT_BATCH,,BR001,Ajmal Super 40 Hojai,NEET,XI NEET,XI,, ,26XXX,26XXX,Boys,60\nFACULTY_GROUP,Trainee,BR001,Ajmal Super 40 Hojai,FACULTY,Trainee,,,,Trainee,Trainee,,0\n','Batch_Campus_Matrix_Template.csv','text/csv');}
let batchMatrixImportRows=[];
function normalizeBatchMatrixRows(rows){return rows.map(src=>{const n={};Object.keys(src||{}).forEach(k=>n[normalizeHeader(k)]=src[k]);const pick=arr=>{const h=arr.find(k=>Object.prototype.hasOwnProperty.call(n,k));return h!=null?String(n[h]??'').trim():'';};return {Record_Type:pick(['record_type','type']),Attendance_Group_Name:pick(['attendance_group_name','faculty_group','group_name']),Branch_ID:pick(['branch_id','branch']),Branch_Name:pick(['branch_name','branch_title']),Programme:pick(['programme','program']),Category_Name:pick(['category_name','category']),Class_Name:pick(['class_name','class']),Campus_ID:pick(['campus_id','location_id']),Campus_Name:pick(['campus_name','campus','location','location_name']),Batch_Code:pick(['batch_code','batch','batch_name']),Batch_Name:pick(['batch_name','batch']),Gender_Group:pick(['gender_group','gender']),Expected_Strength:pick(['expected_strength','strength','batch_total','student_strength'])};});}
function isSuperAdminSession(){const u=state.session.user||{};return String(u.Role||'')==='Super Admin'||(String(u.Role||'')==='Admin'&&String(u.Branch_ID||'')==='ALL');}

function openBatchMatrixImport(){const el=document.getElementById('batchMatrixImportPanel');if(el)el.classList.toggle('hidden');}
function handleBatchMatrixFile(input){const file=input.files?.[0];if(!file)return;const reader=new FileReader();reader.onload=e=>{try{let rows=[];if(/\.xlsx?$/.test(file.name.toLowerCase())&&typeof XLSX!=='undefined'){const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'});rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});}else{const text=typeof e.target.result==='string'?e.target.result:new TextDecoder().decode(e.target.result);rows=parseSimpleCsv(text);}batchMatrixImportRows=normalizeBatchMatrixRows(rows);const errors=[];const seen=new Set();batchMatrixImportRows.forEach((r,i)=>{const n=i+2;const trainee=String(r.Record_Type||'').toUpperCase()==='FACULTY_GROUP'||String(r.Attendance_Group_Name||'').trim().toLowerCase()==='trainee'||String(r.Category_Name||'').trim().toLowerCase()==='trainee';if(!r.Branch_ID)errors.push(`Row ${n}: Branch_ID missing`);if(!r.Campus_Name)errors.push(`Row ${n}: Campus missing`);if(trainee){r.Record_Type='FACULTY_GROUP';r.Attendance_Group_Name=r.Attendance_Group_Name||'Trainee';r.Category_Name='Trainee';r.Programme=r.Programme||'FACULTY';r.Expected_Strength='0';}else{if(!r.Programme)errors.push(`Row ${n}: Programme missing`);if(!r.Category_Name)errors.push(`Row ${n}: Category missing`);if(!r.Batch_Code)errors.push(`Row ${n}: Batch missing`);if(!/^\d+$/.test(String(r.Expected_Strength||'')))errors.push(`Row ${n}: Strength must be a whole number`);}const k=trainee?(r.Branch_ID||'BR001')+'|'+r.Campus_Name+'|FACULTY_GROUP|'+(r.Attendance_Group_Name||'Trainee'):(r.Branch_ID||'BR001')+'|'+r.Campus_Name+'|'+r.Batch_Code+'|'+r.Gender_Group;if(seen.has(k))errors.push(`Row ${n}: duplicate matrix allocation`);seen.add(k);});document.getElementById('batchMatrixImportPreview').innerHTML=`<div class="alert ${errors.length?'alert-danger':'alert-success'}">${errors.length?errors.slice(0,10).map(escapeHtml).join('<br>'):`${batchMatrixImportRows.length} rows ready to import.`}</div>${!errors.length?`<div class="toolbar"><button class="btn btn-primary" onclick="confirmBatchMatrixImport()">Import Matrix</button><button class="btn btn-secondary" onclick="openBatchMatrixImport()">Cancel</button></div>`:''}`;}catch(err){showToast('Could not read the matrix file: '+err.message)}};reader.readAsArrayBuffer(file);}
function parseSimpleCsv(text){const lines=String(text||'').split(/\r?\n/).filter(x=>x.trim()!=='');if(!lines.length)return[];const parse=(line)=>{const out=[];let cur='',q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(q&&line[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(ch===','&&!q){out.push(cur);cur='';}else cur+=ch;}out.push(cur);return out;};const heads=parse(lines[0]);return lines.slice(1).map(line=>{const vals=parse(line),o={};heads.forEach((h,i)=>o[h]=vals[i]??'');return o;});}
function confirmBatchMatrixImport() {
  if (!batchMatrixImportRows.length) return;
  if (!isSuperAdminSession()) {
    showToast('Super Admin authorization required.');
    return;
  }

  if (isGAS()) {
    const rowsToImport = batchMatrixImportRows.slice();
    showToast('Importing Batch / Campus Matrix…');

    google.script.run
      .withSuccessHandler(res => {
        batchMatrixImportRows = [];

        syncAfterImport_(res, 'batches', data => {
          const loaded = Array.isArray(data?.batches) ? data.batches.length : 0;
          showToast(
            `Batch Matrix synchronized • ${Number(res.inserted || 0)} inserted • ` +
            `${Number(res.updated || 0)} updated • ${loaded} loaded`
          );
        }, {force:true, preserveInputs:false});
      })
      .withFailureHandler(err => {
        showToast(err.message || 'Matrix import failed');
      })
      .importBatchMatrix(state.session.token, rowsToImport);
  } else {
    state.data.batches = batchMatrixImportRows.map((r, i) =>
      Object.assign({Batch_ID: 'IMP-' + (i + 1)}, r, {
        Expected_Strength: Number(r.Expected_Strength)
      })
    );
    const count = state.data.batches.length;
    batchMatrixImportRows = [];
    render();
    showToast(`${count} batch rows imported locally`);
  }
}
function batchesHTML(){
  const rows=state.data.batches||[];
  const admin=String(state.session.user?.Role||'')==='Admin' && String(state.session.user?.Branch_ID||'')==='ALL';
  return `<div class="card"><div class="section-title" style="margin-top:0"><div><h2>Batch / Campus Matrix</h2><span class="muted">${rows.length} matrix records • Student Batches + Faculty Groups</span></div><div class="toolbar">${admin?`<button class="btn btn-primary" onclick="openBatchMatrixImport()">⇧ Import Batch / Campus Matrix</button><button class="btn btn-secondary" onclick="batchMatrixTemplate()">Download Template</button>`:''}</div></div>${admin?`<div id="batchMatrixImportPanel" class="card-soft hidden" style="margin-bottom:14px"><div class="toolbar"><input id="batchMatrixFile" type="file" accept=".csv,.xlsx,.xls" class="input" onchange="handleBatchMatrixFile(this)"></div><div class="muted small">Student fields: Branch_ID, Branch_Name, Programme, Category_Name, Campus_ID, Campus_Name, Batch_Code, Gender_Group, Expected_Strength. Faculty group fields: Record_Type=FACULTY_GROUP, Attendance_Group_Name=Trainee, Branch_ID, Campus_Name. Class/Batch may be blank for a faculty group.</div><div id="batchMatrixImportPreview" style="margin-top:10px"></div></div>`:''}<div class="table-wrap"><table class="data-table"><thead><tr><th>Type</th><th>Branch</th><th>Category / Group</th><th>Class</th><th>Campus</th><th>Batch / Group</th><th>Gender</th><th>Strength</th>${admin?'<th>Action</th>':''}</tr></thead><tbody>${rows.map(b=>{const fg=isFacultyAttendanceGroupBatch_(b);return `<tr data-batch-id="${escapeAttr(b.Batch_ID||'')}"><td><span class="badge ${fg?'badge-purple':'badge-blue'}">${fg?'Faculty Group':'Student Batch'}</span></td><td>${escapeHtml(b.Branch_Name||b.Branch_ID||'')}</td><td><span class="badge ${fg?'badge-purple':'badge-blue'}">${escapeHtml(fg?facultyGroupName_(b):(b.Category_Name||''))}</span></td><td>${escapeHtml(fg?'—':(b.Class_Name||batchClassName(b)||'—'))}</td><td>${escapeHtml(b.Campus_Name||'')}</td><td><b>${escapeHtml(fg?facultyGroupName_(b):(b.Batch_Code||b.Batch_Name||''))}</b></td><td>${escapeHtml(fg?'—':(b.Gender_Group||''))}</td><td>${fg?'—':Number(b.Expected_Strength||0).toLocaleString()}</td>${admin?`<td><button class="btn btn-secondary" onclick="batchEditRow('${escapeAttr(b.Batch_ID||'')}')">✎ Edit</button></td>`:''}</tr>`}).join('')}</tbody></table></div></div>`;
}
let managementReportCache={};
function reportScopedBatches(){
  const scope=isSuperAdmin()?'ALL':String(state.session.user?.Branch_ID||'BR001');
  return (state.data.batches||[]).filter(b=>studentAttendanceBatch_(b)&&(scope==='ALL' || String(b.Branch_ID||'BR001')===scope));
}
function reportCampusOptions(selected=''){
  const vals=[...new Set(reportScopedBatches().map(b=>String(b.Campus_Name||b.Campus||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
  return `<option value="">All Campuses</option>${vals.map(v=>`<option value="${escapeAttr(v)}" ${String(v)===String(selected)?'selected':''}>${escapeHtml(v)}</option>`).join('')}`;
}
function reportClassOptions(selected='', campusValue=''){
  const vals=[...new Set(reportScopedBatches().filter(b=>!campusValue || String(b.Campus_Name||b.Campus||'')===String(campusValue)).map(batchClassName).filter(Boolean))].sort();
  return `<option value="">All Classes</option>${vals.map(v=>`<option value="${escapeAttr(v)}" ${String(v)===String(selected)?'selected':''}>${escapeHtml(v)}</option>`).join('')}`;
}
function reportBatchOptions(selected='', campusValue='', classValue=''){
  const rows=reportScopedBatches().filter(b=>(!campusValue || String(b.Campus_Name||b.Campus||'')===String(campusValue))&&(!classValue || batchClassName(b)===String(classValue)));
  const vals=[...new Set(rows.map(b=>String(b.Batch_Code||b.Batch||'').trim()).filter(Boolean))].sort();
  return `<option value="">All Batches</option>${vals.map(v=>`<option value="${escapeAttr(v)}" ${String(v)===String(selected)?'selected':''}>${escapeHtml(v)}</option>`).join('')}`;
}
function updateManagementClassSelect(){
  const campus=document.getElementById('managementCampusFilter')?.value||'';
  const cls=document.getElementById('managementClassFilter');
  const batch=document.getElementById('managementBatchFilter');
  if(cls){ cls.disabled=!campus; cls.innerHTML=campus?reportClassOptions('',campus):'<option value="">Select campus first</option>'; }
  if(batch){ batch.disabled=true; batch.innerHTML='<option value="">Select class first</option>'; }
}
function updateManagementBatchSelect(){
  const campus=document.getElementById('managementCampusFilter')?.value||'';
  const cls=document.getElementById('managementClassFilter')?.value||'';
  const batch=document.getElementById('managementBatchFilter');
  if(batch){ batch.disabled=!campus||!cls; batch.innerHTML=(campus&&cls)?reportBatchOptions('',campus,cls):'<option value="">Select class first</option>'; }
}
function managementReportFiltersHTML(){
  return `<div class="card" style="margin-top:16px"><div class="section-title" style="margin-top:0"><div><h3 style="margin:0">Report Filters</h3><div class="muted">Select campus first, then its associated class, then the batches associated with that class.</div></div><span class="badge badge-blue">Branch Scoped</span></div><div class="grid grid-4"><div><label class="small muted">Campus</label><select id="managementCampusFilter" class="select" onchange="updateManagementClassSelect()">${reportCampusOptions()}</select></div><div><label class="small muted">Class</label><select id="managementClassFilter" class="select" disabled onchange="updateManagementBatchSelect()"><option value="">Select campus first</option></select></div><div><label class="small muted">Batch</label><select id="managementBatchFilter" class="select" disabled><option value="">Select class first</option></select></div><div><label class="small muted">Operational Date</label><input id="managementDateFilter" type="date" class="input" value="${escapeAttr(state.date)}"></div></div></div>`;
}
function reportsHTML(){
  const cats=categoryTotals();
  const branches=(state.data.branches||[]).filter(br=>String(br.Active_Flag??'TRUE').toUpperCase()!=='FALSE' && (isSuperAdmin() || String(br.Branch_ID)===String(state.session.user?.Branch_ID||'BR001')));
  const reports=[
    ['attendance','Daily Attendance Report','Campus / category / batch attendance status for the selected operational date.','blue'],
    ['movement','Student Movement Register','Campus, batch and residential movement transactions with effective dates.','purple'],
    ['residence','Hosteller ↔ Day Scholar Report','Current and recorded residential-status conversions.','gold'],
    ['leftout','Left / Withdrawn Students','Students whose current master status is Left, Withdrawn, Inactive or Cancelled.','red'],
    ['exceptions','Attendance Exception Report','Absent, Leave, Sick and Not Marked students requiring attention.','green'],
    ['faculty','Faculty / Teacher Attendance Report','Subject-wise daily faculty attendance records.','purple']
  ];
  return `<div class="section-title"><div><h2>Management Reports</h2><span class="muted">Generate live reports from the authorised branch data and current ERP records.</span></div></div>
  <div class="grid grid-4">${branches.map(br=>{const id=String(br.Branch_ID);const st=(state.data.students||[]).filter(s=>String(s.Branch_ID||'BR001')===id && !['left','inactive','withdrawn','cancelled'].includes(String(s.Overall_Status||'Active').toLowerCase()));const ba=reportScopedBatches().filter(b=>String(b.Branch_ID||'BR001')===id);const n=st.length||ba.reduce((x,b)=>x+Number(b.Expected_Strength||0),0);return `<div class="card branch-report-card"><div class="metric-label">${escapeHtml(br.Branch_Name)}</div><div class="metric">${n.toLocaleString()}</div><div class="small muted">${ba.length} batches</div></div>`}).join('')}</div>
  <div class="grid grid-3">${Object.entries(cats).map(([k,v])=>`<div class="card"><div class="metric-label">${escapeHtml(k)}</div><div class="metric">${v.toLocaleString()}</div><div class="progress" style="margin-top:12px"><span style="width:${Math.min(100,Math.round(v/Math.max(1,Object.values(cats).reduce((a,b)=>a+b,0))*100))}%"></span></div><div class="small muted" style="margin-top:6px">Exact batch-matrix strength</div></div>`).join('')}</div>
  ${managementReportFiltersHTML()}
  <div class="card" style="margin-top:16px"><div class="section-title" style="margin-top:0"><div><h3 style="margin:0">Suggested Management Reports</h3><div class="muted">Choose the class and/or batch above, then generate a specific report.</div></div></div>
    <div class="grid grid-2">${reports.map(([key,title,desc,tone])=>`<div class="report-action-card report-${tone}"><div><div class="report-action-title">${escapeHtml(title)}</div><div class="small muted">${escapeHtml(desc)}</div></div><div class="toolbar"><button class="btn btn-primary" onclick="generateManagementReport('${key}')">Generate</button></div></div>`).join('')}</div>
    <div id="managementReportOutput" style="margin-top:16px"></div>
  </div>`;
}
function currentScopedStudents(filters={}){
  const scope=isSuperAdmin()?'ALL':String(state.session.user?.Branch_ID||'BR001');
  const campus=String(filters.campusName||'');
  const cls=String(filters.className||'');
  const batch=String(filters.batchCode||'');
  return (state.data.students||[]).filter(s=>{
    if(scope!=='ALL' && String(s.Branch_ID||'BR001')!==scope) return false;
    if(campus && String(s.Campus_Name||s.Campus||s.Location_Name||'')!==campus) return false;
    if(cls && String(s.Class_Name||s.Class||'')!==cls) return false;
    if(batch && String(s.Batch_Code||s.Batch||'')!==batch) return false;
    return true;
  });
}
function managementCampusName(row){
  if(row.Campus_Name) return row.Campus_Name;
  const b=(state.data.batches||[]).find(x=>String(x.Batch_ID)===String(row.Batch_ID));
  return b?.Campus_Name||row.Campus||'';
}
function managementBatchName(row){
  if(row.Batch_Code) return row.Batch_Code;
  const b=(state.data.batches||[]).find(x=>String(x.Batch_ID)===String(row.Batch_ID));
  return b?.Batch_Code||row.Batch_ID||'';
}
function generateManagementReport(type){
  const campusName=document.getElementById('managementCampusFilter')?.value||'';
  const className=document.getElementById('managementClassFilter')?.value||'';
  const batchCode=document.getElementById('managementBatchFilter')?.value||'';
  const reportDate=document.getElementById('managementDateFilter')?.value||state.date;
  if((className||batchCode) && !campusName){showToast('Select a campus first.');return;}
  if(batchCode && !className){showToast('Select a class before choosing a batch.');return;}
  const students=currentScopedStudents({campusName,className,batchCode});
  const att=state.data.attendance||[];
  const mov=state.data.movements||[];
  const res=state.data.residentialAllocations||[];
  const batchMatches=reportScopedBatches().filter(b=>(!campusName||String(b.Campus_Name||b.Campus||'')===campusName)&&(!className||String(b.Class_Name||b.Class||'')===className)&&(!batchCode||String(b.Batch_Code||b.Batch||'')===batchCode));
  let title='', headers=[], rows=[];
  if(type==='attendance'){
    title=`Daily Attendance Report • ${formatDate(reportDate)}`;
    headers=['UIN','Student Name',"Father's Name",'Category','Class','Campus','Batch','Attendance'];
    const today={};att.filter(a=>String(a.Attendance_Date||'').slice(0,10)===reportDate).forEach(a=>today[String(a.UIN||'').trim().toUpperCase()]=a);
    rows=students.map(s=>{const u=String(s.UIN||'').trim().toUpperCase();const a=today[u];return [u,s.Student_Name||'',s.Father_Name||'',s.Category_Name||'',s.Class_Name||'',managementCampusName(s),managementBatchName(s),a?.Attendance_Status||'Not Marked'];});
  }else if(type==='movement'){
    title='Student Movement Register';
    headers=['UIN','Movement Type','From Branch','To Branch','From Batch','To Batch','From Campus','To Campus','Residence','Effective Date','Status','Requested By'];
    rows=mov.filter(m=>{const u=String(m.UIN||'').trim().toUpperCase();return students.some(s=>String(s.UIN||'').trim().toUpperCase()===u);}).map(m=>[m.UIN||'',m.Movement_Type||'',m.From_Branch_ID||'',m.To_Branch_ID||'',managementBatchName({Batch_ID:m.From_Batch_ID}),managementBatchName({Batch_ID:m.To_Batch_ID}),m.From_Campus_ID||'',m.To_Campus_ID||'',m.To_Residence||'',m.Effective_Date||'',m.Status||'',m.Requested_By||'']);
  }else if(type==='residence'){
    title='Hosteller ↔ Day Scholar Conversion Report';
    headers=['UIN','Student Name',"Father's Name",'Old Residence','New Residence','Effective Date','Reason','Status'];
    rows=mov.filter(m=>{const typ=String(m.Movement_Type||'').toLowerCase();return typ.includes('residen') || m.To_Residence;}).filter(m=>students.some(s=>String(s.UIN||'').trim().toUpperCase()===String(m.UIN||'').trim().toUpperCase())).map(m=>[m.UIN||'',(students.find(s=>String(s.UIN||'').trim().toUpperCase()===String(m.UIN||'').trim().toUpperCase())||{}).Student_Name||'',(students.find(s=>String(s.UIN||'').trim().toUpperCase()===String(m.UIN||'').trim().toUpperCase())||{}).Father_Name||'',m.From_Residence||'',m.To_Residence||'',m.Effective_Date||'',m.Reason||'',m.Status||'']);
    if(!rows.length){rows=res.filter(r=>students.some(s=>String(s.UIN||'').trim().toUpperCase()===String(r.UIN||'').trim().toUpperCase())).map(r=>[r.UIN||'',(students.find(s=>String(s.UIN||'').trim().toUpperCase()===String(r.UIN||'').trim().toUpperCase())||{}).Student_Name||'',(students.find(s=>String(s.UIN||'').trim().toUpperCase()===String(r.UIN||'').trim().toUpperCase())||{}).Father_Name||'',r.Previous_Residence||'',r.Residence_Status||'',r.Effective_From||'',r.Reason||'',r.Status||'']);}
  }else if(type==='leftout'){
    title='Left / Withdrawn Students Report';
    headers=['UIN','Student Name',"Father's Name",'Branch','Category','Class','Batch','Status'];
    rows=students.filter(s=>['left','withdrawn','inactive','cancelled'].includes(String(s.Overall_Status||'').toLowerCase())).map(s=>[s.UIN||'',s.Student_Name||'',s.Father_Name||'',s.Branch_Name||'',s.Category_Name||'',s.Class_Name||'',s.Batch_Code||'',s.Overall_Status||'']);
  }else if(type==='faculty'){
    title=`Faculty / Teacher Attendance Report • ${formatDate(reportDate)}`;
    headers=['Date','Branch','Batch','Faculty','Subject','Attendance Status','Remarks'];
    const fa=state.data.facultyAttendance||[];
    rows=fa.filter(a=>String(a.Attendance_Date||'').slice(0,10)===reportDate).filter(a=>{
      if(campusName){const b=(state.data.batches||[]).find(x=>String(x.Batch_ID)===String(a.Batch_ID));if(String(b?.Campus_Name||b?.Campus||'')!==campusName)return false;}
      if(className){const b=(state.data.batches||[]).find(x=>String(x.Batch_ID)===String(a.Batch_ID));if(batchClassName(b)!==className)return false;}
      if(batchCode){const b=(state.data.batches||[]).find(x=>String(x.Batch_ID)===String(a.Batch_ID));if(String(b?.Batch_Code||'')!==batchCode)return false;}
      return true;
    }).map(a=>[a.Attendance_Date||'',a.Branch_Name||'',managementBatchName({Batch_ID:a.Batch_ID})||'',a.Faculty_Name||a.Faculty_ID||'',a.Subject_Name||'',a.Attendance_Status||'',a.Remarks||'']);
  }else{
    title=`Attendance Exception Report • ${formatDate(reportDate)}`;
    headers=['UIN','Student Name',"Father's Name",'Category','Class','Campus','Batch','Status'];
    const today={};att.filter(a=>String(a.Attendance_Date||'').slice(0,10)===reportDate).forEach(a=>today[String(a.UIN||'').trim().toUpperCase()]=a.Attendance_Status);
    rows=students.map(s=>{const u=String(s.UIN||'').trim().toUpperCase();return [u,s.Student_Name||'',s.Father_Name||'',s.Category_Name||'',s.Class_Name||'',managementCampusName(s),managementBatchName(s),today[u]||'Not Marked'];}).filter(r=>['Absent','Leave','Sick','Not Marked'].includes(r[7]));
  }
  // If no student master rows are present but batch matrix data matches, make that explicit rather than showing unrelated records.
  managementReportCache={type,title,headers,rows,filters:{campusName,className,batchCode,reportDate,batchCount:batchMatches.length}};
  renderManagementReport('managementReportOutput',managementReportCache);
}
function renderManagementReport(targetId,report){
  const el=document.getElementById(targetId); if(!el)return;
  const maxRows=report.rows||[];
  el.innerHTML=`<div class="report-output"><div class="report-header"><div><h3 style="margin:0">${escapeHtml(report.title)}</h3><div class="muted small">${maxRows.length.toLocaleString()} records • generated ${new Date().toLocaleString()}</div></div><div class="result-pdf-actions"><button class="btn btn-secondary" onclick="saveManagementReportAsPdf()">🖨 Save as PDF</button></div></div><div class="table-wrap"><table class="data-table"><thead><tr>${report.headers.map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${maxRows.length?maxRows.map(r=>`<tr>${r.map(v=>`<td>${escapeHtml(v??'')}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${report.headers.length}" class="muted center">No records found for this report.</td></tr>`}</tbody></table></div></div>`;
}
function saveManagementReportAsPdf(){
  const report=managementReportCache; if(!report){showToast('Generate a report first.');return;}
  const w=window.open('','_blank'); if(!w){showToast('Please allow pop-ups to save the report as PDF.');return;}
  const head=report.headers.map(h=>`<th>${escapeHtml(h)}</th>`).join('');
  const body=(report.rows||[]).map(r=>`<tr>${r.map(v=>`<td>${escapeHtml(v??'')}</td>`).join('')}</tr>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(report.title)}</title><style>@page{size:A4 landscape;margin:10mm}body{font-family:Arial,sans-serif;color:#172033;font-size:9px}h1{font-size:17px;color:#0b2f63;margin:0 0 4px}.sub{color:#667085;margin-bottom:10px}.table{width:100%;border-collapse:collapse}.table th,.table td{border:1px solid #cfd7e3;padding:4px;text-align:left}.table th{background:#0b2f63;color:#fff}.brand{font-weight:700;color:#dc2c1d;font-size:12px;margin-bottom:4px}</style></head><body><div class="brand">AJMAL SUPER 40</div><h1>${escapeHtml(report.title)}</h1><div class="sub">Generated from Student Operations ERP • ${new Date().toLocaleString()}</div><div class="sub"><b>Filters:</b> ${Object.entries(report.filters||{}).map(([k,v])=>`${escapeHtml(k)}: ${escapeHtml(v||'All')}`).join(' • ')}</div><table class="table"><thead><tr>${head}</tr></thead><tbody>${body||`<tr><td colspan="${report.headers.length}">No records found.</td></tr>`}</tbody></table></body></html>`);
  w.document.close(); w.focus(); setTimeout(()=>w.print(),350);
}
function userManagementHTML(){const isAdmin=String(state.session.user?.Role||'')==='Admin';if(!isAdmin)return '<div class="card"><b>Administrator access required.</b></div>';return `<div class="card"><div class="section-title" style="margin-top:0"><div><h2>User Management</h2><div class="muted">Admin-only account list. Passwords are never displayed; use Reset Password.</div></div><span class="badge badge-red">ADMIN ONLY</span></div><div id="userList" class="user-admin-list"></div></div>`}

function facultyAdminHtml(){
  if(!canManageFacultyMaster()) return '';
  const fopts=state.facultyOptions.faculties||[]; const aopts=state.facultyOptions.assignments||[];
  const batchMap=new Map((state.data.batches||[]).map(b=>[String(b.Batch_ID),b]));
  const splitList_ = v => String(v??'').split(/[,;|]/).map(x=>x.trim()).filter(Boolean);
  const rows=(fopts||[]).filter(f=>f&&String(f.Faculty_ID||'').trim()).map(f=>({
    f,
    subjects:splitList_(f.Subject||f.Subjects||''),
    branches:String(f.Branch_Name||f.Branch_ID||'').trim(),
    campuses:String(f.Campus_Name||f.Campus||'').trim(),
    classes:String(f.Class_Name||f.Class||'').trim(),
    batches:String(f.Batch_Batches||f['Batch/Batches']||f.Batches||f.Batch||'').trim()
  }));
  state._localFacultyEditRows=rows.map(r=>({Faculty_ID:r.f.Faculty_ID||'',Faculty_Name:r.f.Faculty_Name||'',Initials:r.f.Initials||'',Branch_ID:r.f.Branch_ID||'',Branch_Name:r.branches,Contact_Number:r.f.Contact_Number||'',Status:r.f.Status||'Active',subjects:r.subjects?String(r.subjects).split(/\s*[,;|]\s*/).filter(Boolean):[],campuses:r.campuses?String(r.campuses).split(/\s*[,;|]\s*/).filter(Boolean):[],classes:r.classes?String(r.classes).split(/\s*[,;|]\s*/).filter(Boolean):[],batches:r.batches?String(r.batches).split(/\s*[,;|]\s*/).filter(Boolean):[]}));
  return `<div class="card" style="margin-top:16px"><div class="section-title" style="margin-top:0"><div><h2 style="font-size:16px;margin:0">Faculty / Teacher Master & Assignments</h2><div class="muted">Faculty master is managed from the imported CSV/Excel source and mapped to Branch → Campus → Class → Batch → Subject.</div></div><span class="badge badge-red">${String(state.session.user?.Role||'')==='Super Admin'?'SUPER ADMIN':(String(state.session.user?.Role||'')==='Admin'?'ADMIN':'ACADEMIC ADMIN')}</span></div>
  <div class="card-soft" style="margin-top:12px"><div class="section-title" style="margin-top:0"><div><h3 style="margin:0">Import Faculty / Teacher Master</h3><div class="muted small">Use the standard template. Accepted: CSV, XLSX, XLS. The uploaded CSV/Excel file is the source of truth for this faculty list.</div></div></div><div class="grid grid-4" style="margin-top:10px"><div><label class="small muted">Import category</label><select id="facultyMasterImportCategory" class="select"><option value="">Use Category_Name from CSV</option><option value="School">AMRS School (Classes VI–X)</option><option value="AJMAL SUPER 40">AJMAL SUPER 40 (NEET / JEE)</option></select></div><div><label class="small muted">Source file</label><input id="facultyMasterFile" type="file" accept=".csv,.xlsx,.xls" class="input" onchange="handleFacultyMasterFile(this)"></div><div><label class="small muted">Source link (optional)</label><input id="facultyMasterSourceUrl" type="url" class="input" placeholder="Public CSV / Google Sheets published CSV link"></div><div class="toolbar" style="align-items:end"><button class="btn btn-secondary" onclick="facultyMasterTemplate()">Download Standard Template</button><button class="btn btn-primary" onclick="importFacultyFromSourceUrl()">Import from Link</button></div></div><div id="facultyMasterImportPreview" style="margin-top:10px"></div></div>
  <div class="toolbar" style="margin-top:12px;justify-content:space-between"><span class="muted small">${rows.length} faculty master records • ${aopts.length} active assignments</span><button class="btn btn-secondary" onclick="loadFacultyAdminData(true)">↻ Refresh Faculty List</button></div>
  <div class="table-wrap" style="margin-top:12px"><table class="data-table"><thead><tr><th>Faculty Name</th><th>Initials / Abbreviation</th><th>Category</th><th>Subject</th><th>Branch</th><th>Campus</th><th>Class</th><th>Batch / Batches</th><th>Contact Number</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows.length?rows.map((r,i)=>`<tr><td><b>${escapeHtml(r.f.Faculty_Name||'')}</b><div class="muted small">${escapeHtml(r.f.Faculty_ID||'')}</div></td><td>${escapeHtml(r.f.Initials||'')}</td><td>${escapeHtml(r.f.Category_Name||'—')}</td><td>${escapeHtml(r.subjects.join(', ')||'—')}</td><td>${escapeHtml(r.branches||'—')}</td><td>${escapeHtml(r.campuses||'—')}</td><td>${escapeHtml(r.classes||'—')}</td><td>${escapeHtml(r.batches||'—')}</td><td>${escapeHtml(r.f.Contact_Number||'—')}</td><td><span class="badge ${String(r.f.Active_Flag||'TRUE').toUpperCase()==='FALSE'?'badge-red':'badge-green'}">${escapeHtml(r.f.Status|| (String(r.f.Active_Flag||'TRUE').toUpperCase()==='FALSE'?'Inactive':'Active'))}</span></td><td><button class="btn btn-secondary btn-sm" onclick="openLocalFacultyEdit(${i})">Edit</button></td></tr>`).join(''):`<tr><td colspan="10" class="muted center">No faculty master data imported yet. Use the standard CSV/Excel template above.</td></tr>`}</tbody></table></div></div>`;
}
function openLocalFacultyEdit(index){const f=state._localFacultyEditRows?.[index];if(f)openFacultyEdit(f);}

function normalizeFacultyEditList(v){return String(v||'').split(/[,;|]/).map(x=>x.trim()).filter(Boolean);}
function openFacultyEdit(f){
  if(!canManageFacultyMaster()) return;
  const modal=document.getElementById('facultyEditModal')||document.createElement('div'); modal.id='facultyEditModal'; modal.className='modal-backdrop'; modal.classList.remove('hidden'); modal.setAttribute('aria-hidden','false');
  const branchRows=state.data.branches||[];
  window._editingFacultyOriginalId=String(f.Faculty_ID||'').trim();
  modal.innerHTML=`<div class="modal-card" style="max-width:980px;width:min(980px,96vw)"><div class="section-title" style="margin-top:0"><div><h2>Edit Faculty / Teacher Master</h2><div class="muted">Faculty ID and Initials / Abbreviation must be unique across all faculty records.</div></div><button class="icon-btn" onclick="closeFacultyEdit()">×</button></div><div class="grid grid-2" style="margin-top:12px"><div><label class="small muted">Faculty ID</label><div class="toolbar" style="gap:6px"><input id="editFacultyId" class="input" value="${escapeAttr(f.Faculty_ID||'')}" onblur="validateUniqueFacultyField('Faculty_ID')"><button id="editFacultyIdClear" type="button" class="btn btn-secondary btn-sm hidden" onclick="clearLockedFacultyField('Faculty_ID')">Clear & Edit</button></div><div id="editFacultyIdError" class="small" style="color:#b42318;margin-top:4px;min-height:16px"></div></div><div><label class="small muted">Faculty Name</label><input id="editFacultyName" class="input" value="${escapeAttr(f.Faculty_Name||'')}"></div><div><label class="small muted">Initials / Abbreviation</label><div class="toolbar" style="gap:6px"><input id="editFacultyInitials" class="input" value="${escapeAttr(f.Initials||'')}" onblur="validateUniqueFacultyField('Initials')"><button id="editFacultyInitialsClear" type="button" class="btn btn-secondary btn-sm hidden" onclick="clearLockedFacultyField('Initials')">Clear & Edit</button></div><div id="editFacultyInitialsError" class="small" style="color:#b42318;margin-top:4px;min-height:16px"></div></div><div><label class="small muted">Subject</label><input id="editFacultySubjects" class="input" value="${escapeAttr((f.subjects||[]).join(', '))}"></div><div><label class="small muted">Branch</label><select id="editFacultyBranch" class="select">${branchRows.map(b=>`<option value="${escapeAttr(b.Branch_ID)}" ${String(f.Branch_ID)===String(b.Branch_ID)?'selected':''}>${escapeHtml(b.Branch_Name)}</option>`).join('')}</select></div><div><label class="small muted">Campus</label><input id="editFacultyCampus" class="input" value="${escapeAttr((f.campuses||[]).join(', '))}"></div><div><label class="small muted">Class</label><input id="editFacultyClass" class="input" value="${escapeAttr((f.classes||[]).join(', '))}"></div><div><label class="small muted">Batch / Batches</label><input id="editFacultyBatches" class="input" value="${escapeAttr((f.batches||[]).join(', '))}"></div><div><label class="small muted">Contact Number</label><input id="editFacultyContact" class="input" value="${escapeAttr(f.Contact_Number||'')}"></div><div><label class="small muted">Status</label><select id="editFacultyStatus" class="select"><option value="Active" ${String(f.Status||'Active')==='Active'?'selected':''}>Active</option><option value="Inactive" ${String(f.Status||'')==='Inactive'?'selected':''}>Inactive</option></select></div></div><div class="toolbar" style="margin-top:16px;justify-content:flex-end"><button class="btn btn-secondary" onclick="closeFacultyEdit()">Cancel</button><button class="btn btn-primary" id="saveEditedFacultyBtn" onclick="saveEditedFacultyMaster()">Save Changes</button></div></div>`;
  if(!modal.parentNode) document.body.appendChild(modal);
}
function closeFacultyEdit(){const m=document.getElementById('facultyEditModal');if(m){m.classList.add('hidden');m.setAttribute('aria-hidden','true');m.innerHTML='';} window._editingFacultyOriginalId='';}
function facultyValueTaken(type,value,originalId){
  const v=String(value||'').trim().toLowerCase(); if(!v) return false;
  return (state.facultyOptions.faculties||[]).some(x=>String(x.Faculty_ID||'').trim()!==String(originalId||'').trim() && (type==='Faculty_ID'?String(x.Faculty_ID||'').trim().toLowerCase():String(x.Initials||'').trim().toLowerCase())===v);
}
function validateUniqueFacultyField(type){
  const id=type==='Faculty_ID'?'editFacultyId':'editFacultyInitials'; const clearId=type==='Faculty_ID'?'editFacultyIdClear':'editFacultyInitialsClear'; const errId=type==='Faculty_ID'?'editFacultyIdError':'editFacultyInitialsError';
  const el=document.getElementById(id), clear=document.getElementById(clearId), err=document.getElementById(errId); if(!el) return true;
  const dup=facultyValueTaken(type,el.value,window._editingFacultyOriginalId);
  if(dup){ el.readOnly=true; el.classList.add('input-error'); if(clear) clear.classList.remove('hidden'); if(err) err.textContent=type==='Faculty_ID'?'Faculty ID already available':'Initials / Abbreviation already allotted'; alert(type==='Faculty_ID'?'Faculty ID already available':'Initials / Abbreviation already allotted'); return false; }
  el.readOnly=false; el.classList.remove('input-error'); if(clear) clear.classList.add('hidden'); if(err) err.textContent=''; return true;
}
function clearLockedFacultyField(type){ const id=type==='Faculty_ID'?'editFacultyId':'editFacultyInitials'; const clearId=type==='Faculty_ID'?'editFacultyIdClear':'editFacultyInitialsClear'; const errId=type==='Faculty_ID'?'editFacultyIdError':'editFacultyInitialsError'; const el=document.getElementById(id); if(!el)return; el.readOnly=false; el.value=''; el.classList.remove('input-error'); document.getElementById(clearId)?.classList.add('hidden'); const err=document.getElementById(errId); if(err) err.textContent=''; el.focus(); }
function validateFacultyEditUniquenessBeforeSave(){ return validateUniqueFacultyField('Faculty_ID') && validateUniqueFacultyField('Initials'); }
function saveEditedFacultyMaster(){
  if(!canManageFacultyMaster()) return;
  if(!validateFacultyEditUniquenessBeforeSave()) return;
  const fid=document.getElementById('editFacultyId')?.value.trim();
  const originalFacultyId=String(window._editingFacultyOriginalId||fid||'').trim();
  const name=document.getElementById('editFacultyName')?.value.trim();
  const subjectText=document.getElementById('editFacultySubjects')?.value.trim();
  const branchId=document.getElementById('editFacultyBranch')?.value;
  const campusText=document.getElementById('editFacultyCampus')?.value.trim();
  const classText=document.getElementById('editFacultyClass')?.value.trim();
  const batchText=document.getElementById('editFacultyBatches')?.value.trim();
  const contact=document.getElementById('editFacultyContact')?.value.trim();
  const status=document.getElementById('editFacultyStatus')?.value;
  const subjects=normalizeFacultyEditList(subjectText);
  const campusNames=normalizeFacultyEditList(campusText);
  const classNames=normalizeFacultyEditList(classText);
  const batchNames=normalizeFacultyEditList(batchText);
  if(!fid||!name||!subjects.length||!batchNames.length){showToast('Faculty ID, name, at least one subject and batch are required.');return;}
  const branchName=(state.data.branches||[]).find(b=>String(b.Branch_ID)===String(branchId))?.Branch_Name||branchId;
  const payload={Original_Faculty_ID:originalFacultyId,Faculty_ID:fid,Faculty_Name:name,Initials:document.getElementById('editFacultyInitials')?.value.trim()||'',Branch_ID:branchId,Branch_Name:branchName,Subjects:subjects,Subject:subjectText,Campus_Names:campusNames,Campus_Name:campusText,Class_Names:classNames,Class_Name:classText,Batch_Names:batchNames,Batch_Batches:batchText,Contact_Number:contact,Status:status};
  const applyLocal=()=>{
    const f=(state.facultyOptions.faculties||[]).find(x=>String(x.Faculty_ID)===originalFacultyId);
    if(f) Object.assign(f,{
      Faculty_ID:fid,
      Faculty_Name:name,
      Initials:payload.Initials,
      Branch_ID:branchId,
      Branch_Name:branchName,
      Subject:payload.Subject,
      Subjects:subjects,
      Campus_Name:payload.Campus_Name,
      Class_Name:payload.Class_Name,
      Batch_Batches:payload.Batch_Batches,
      Contact_Number:contact,
      Status:status,
      Active_Flag:status==='Inactive'?'FALSE':'TRUE'
    });
    state.facultyOptions.assignments=(state.facultyOptions.assignments||[]).filter(a=>String(a.Faculty_ID)!==originalFacultyId);
    const batches=state.data.batches||[]; let n=0;
    batchNames.forEach(bq=>subjects.forEach(sub=>{
      const b=batches.find(x=>String(x.Batch_Code||x.Batch_Name||x.Batch_ID).trim().toLowerCase()===String(bq).trim().toLowerCase());
      state.facultyOptions.assignments.push({Assignment_ID:String(Date.now())+'-'+(n++),Faculty_ID:fid,Batch_ID:b?.Batch_ID||bq,Batch_Code:b?.Batch_Code||bq,Campus_Name:campusNames[0]||b?.Campus_Name||'',Class_Name:classNames[0]||b?.Class_Name||'',Subject_Name:sub,Branch_ID:branchId,Branch_Name:branchName,Active_Flag:status==='Inactive'?'FALSE':'TRUE'});
    }));
  };
  const refreshFacultySectionOnly=()=>{
    const host=document.getElementById('facultyAdminSection');
    if(!host || state.page!=='faculty') return;
    try { host.innerHTML=facultyAdminHtml(); }
    catch(err){ console.error('Faculty display refresh error',err); }
  };
  if(isGAS()){
    if(typeof google==='undefined'||!google.script?.run){showToast('ERP backend is unavailable.');return;}
    google.script.run
      .withSuccessHandler(()=>{
        applyLocal();
        showToast('Faculty details saved successfully.');
        closeFacultyEdit();
        // Update the edited row immediately, then verify against the authoritative sheet in the background.
        refreshFacultySectionOnly();
        setTimeout(()=>loadFacultyAdminData(true),120);
      })
      .withFailureHandler(err=>showToast(err?.message||'Could not save faculty details.'))
      .updateFacultyMasterAndAssignments(state.session.token,payload);
  } else {
    applyLocal();
    showToast('Faculty details updated.');
    closeFacultyEdit();
    refreshFacultySectionOnly();
  }
}
function facultyMasterTemplate(){
  const headers=['Faculty_ID','Faculty_Name','Initials/Abbreviation','Category_Name','Subject','Branch_ID','Branch_Name','Campus_Name','Class_Name','Batch/Batches','Contact_Number','Status','Remarks'];
  const csv=headers.join(',')+'\n'; const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='Faculty_Master_Template.csv'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function loadFacultyAdminData(force=false){
  if(!canManageFacultyMaster()) return;
  if(force){ state._facultySettingsLoaded=false; state._facultySettingsLoading=false; }
  if(state._facultySettingsLoading && !force) return;
  state._facultySettingsLoading=true;
  const applyFaculty=(o)=>{
    state.facultyOptions=o||state.facultyOptions||{faculties:[],assignments:[],subjects:[]};
    state._facultySettingsLoaded=true;
    state._facultySettingsLoading=false;
    if(state.page!=='settings' && state.page!=='faculty') return;
    const host=document.getElementById('facultyAdminSection');
    if(!host) return;
    try {
      const html=facultyAdminHtml();
      host.innerHTML=html;
    } catch(err) {
      host.innerHTML='<div class=\"card\"><div class=\"alert alert-danger\">Faculty Master data loaded, but the faculty panel could not be refreshed. Settings remains available.</div></div>';
      console.error('Faculty settings render error',err);
    }
  };
  const fail=(e)=>{state._facultySettingsLoading=false;showToast(e.message||'Could not load faculty master');};
  if(isGAS()) google.script.run.withSuccessHandler(applyFaculty).withFailureHandler(fail).getFacultyAdminData(state.session.token);
  else { applyFaculty(state.facultyOptions||{faculties:[],assignments:[],subjects:[]}); }
}
let facultyMasterImportRows=[];
function facultyHeaderKey_(k){return String(k||'').trim().toLowerCase().replace(/[\s_\/\-]+/g,'');}
function normalizeFacultyMasterRows(rows){
  return (rows||[]).map(r=>{
    const map={}; Object.keys(r||{}).forEach(k=>{map[facultyHeaderKey_(k)] = r[k];});
    const pick=(...keys)=>{for(const k of keys){const v=map[facultyHeaderKey_(k)]; if(v!==undefined && String(v).trim()!=='') return v;} return '';};
    return {
      Faculty_ID:String(pick('Faculty_ID','Faculty Id','FacultyID','ID')).trim(),
      Faculty_Name:String(pick('Faculty_Name','Faculty Name','FacultyName','Teacher Name','TeacherName','Name')).trim(),
      Initials:String(pick('Initials','Abbreviation','Initials/Abbreviation','Initials Abbreviation')).trim(),
      Subject:String(pick('Subject','Subjects','Subject Name','SubjectName')).trim(),
      Branch_ID:String(pick('Branch_ID','Branch Id','BranchID')).trim(),
      Branch_Name:String(pick('Branch_Name','Branch Name','Branch')).trim(),
      Category_Name:String(pick('Category_Name','Category Name','Category')).trim(),
      Campus_Name:String(pick('Campus_Name','Campus Name','Campus')).trim(),
      Class_Name:String(pick('Class_Name','Class Name','Class')).trim(),
      Batch_Batches:String(pick('Batch/Batches','Batch_Batches','Batch Batches','Batches','Batch','Batch Code','Batch_Code')).trim(),
      Contact_Number:String(pick('Contact_Number','Contact Number','Contact','Mobile','Mobile Number','Phone')).trim(),
      Status:String(pick('Status','Faculty Status')||'Active').trim(),
      Remarks:String(pick('Remarks','Remark','Notes')).trim()
    };
  });
}
function showFacultyMasterImportPreview(rows,source){
  facultyMasterImportRows=normalizeFacultyMasterRows(rows); const errors=[]; const seen=new Set(); facultyMasterImportRows.forEach((r,i)=>{const n=i+2;if(!r.Faculty_ID)errors.push(`Row ${n}: Faculty_ID missing`);if(!r.Faculty_Name)errors.push(`Row ${n}: Faculty_Name missing`);const k=r.Faculty_ID.toLowerCase();if(k&&seen.has(k))errors.push(`Row ${n}: duplicate Faculty_ID ${r.Faculty_ID}`);if(k)seen.add(k);});
  const el=document.getElementById('facultyMasterImportPreview'); if(!el)return;
  const headers=['Faculty Name','Initials / Abbreviation','Category','Subject','Branch','Campus','Class','Batch / Batches','Contact Number','Status'];
  const previewRows=facultyMasterImportRows.map(r=>[r.Faculty_Name,r.Initials,r.Category_Name||'—',r.Subject,r.Branch_Name||r.Branch_ID,r.Campus_Name,r.Class_Name,r.Batch_Batches,r.Contact_Number,r.Status]);
  const previewTable=previewRows.length?`<div class="table-wrap" style="margin-top:10px"><table class="data-table"><thead><tr>${headers.map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${previewRows.map(row=>`<tr>${row.map(v=>`<td>${escapeHtml(v||'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:'';
  el.innerHTML=`<div class="alert ${errors.length?'alert-danger':'alert-success'}">${errors.length?errors.slice(0,20).map(escapeHtml).join('<br>'):`${facultyMasterImportRows.length} faculty rows read from ${escapeHtml(source||'selected file')}. The preview below is exactly the uploaded file data.`}</div>${previewTable}${!errors.length&&facultyMasterImportRows.length?`<div class="toolbar"><button class="btn btn-primary" onclick="confirmFacultyMasterImport()">Replace Faculty Master with This File</button><button class="btn btn-secondary" onclick="document.getElementById('facultyMasterImportPreview').innerHTML=''">Cancel</button></div>`:''}`;
}
function handleFacultyMasterFile(input){const file=input.files?.[0];if(!file)return;const ext=(file.name.split('.').pop()||'').toLowerCase();if(!['csv','xlsx','xls'].includes(ext)){showToast('Please select CSV or Excel file');return;}if(ext==='csv'){const reader=new FileReader();reader.onload=()=>showFacultyMasterImportPreview(parseCsvText(reader.result),file.name);reader.readAsText(file);}else{if(typeof XLSX==='undefined'){showToast('Excel reader is unavailable. Use CSV or reload with internet access.');return;}const reader=new FileReader();reader.onload=e=>{try{const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'});const ws=wb.Sheets[wb.SheetNames[0]];showFacultyMasterImportPreview(XLSX.utils.sheet_to_json(ws,{defval:'',raw:false}),file.name);}catch(err){showToast('Could not read Excel file: '+err.message);}};reader.readAsArrayBuffer(file);}}
function confirmFacultyMasterImport() {
  if (!canManageFacultyMaster() || !facultyMasterImportRows.length) return;

  const source =
    document.getElementById('facultyMasterSourceUrl')?.value.trim() ||
    document.getElementById('facultyMasterFile')?.files?.[0]?.name ||
    'Faculty Master';

  if (isGAS()) {
    showToast('Importing faculty master…');

    google.script.run
      .withSuccessHandler(res => {
        facultyMasterImportRows = [];
        state._facultySettingsLoaded = false;
        state._facultySettingsLoading = false;

        syncAfterImport_(res, 'faculty', () => {
          loadFacultyAdminData(true);

          showToast(
            `Faculty import synchronized • ${Number(res.inserted || 0)} faculty • ` +
            `${Number(res.assignments || 0)} assignments`
          );

          if (Number(res.verifiedFacultyCount || 0) === 0) {
            setTimeout(() => showToast(
              'Warning: server verification found 0 Faculty records.'
            ), 2400);
          }
        }, {force:true, preserveInputs:false});
      })
      .withFailureHandler(e => {
        showToast(e.message || 'Faculty import failed');
      })
      .importFacultyMaster(
        state.session.token,
        facultyMasterImportRows,
        source,
        document.getElementById('facultyMasterImportCategory')?.value||''
      );
  } else {
    const newFaculties = [];
    const newAssignments = [];
    facultyMasterImportRows.forEach(r => {
      const fid = r.Faculty_ID;
      const f = {...r, Active_Flag: r.Status === 'Inactive' ? 'FALSE' : 'TRUE'};
      newFaculties.push(f);
      (state.facultyOptions.faculties ||= []).push(f);
    });
    state.facultyOptions.assignments = state.facultyOptions.assignments || newAssignments;
    facultyMasterImportRows = [];
    state._facultySettingsLoaded = true;
    state._facultySettingsLoading = false;
    render();
    showToast(`${newFaculties.length} faculty records imported locally`);
  }
}
function importFacultyFromSourceUrl() {
  if (!canManageFacultyMaster()) return;

  const url = document.getElementById('facultyMasterSourceUrl')?.value.trim();
  if (!url) {
    showToast('Enter a public CSV source link first.');
    return;
  }

  if (isGAS()) {
    showToast('Importing faculty master from source link…');

    google.script.run
      .withSuccessHandler(res => {
        state._facultySettingsLoaded = false;
        state._facultySettingsLoading = false;

        refreshERPDataAndRender('faculty', () => {
          loadFacultyAdminData(true);
          showToast(
            `Faculty link import synchronized • ${Number(res.inserted || 0)} faculty • ` +
            `${Number(res.assignments || 0)} assignments`
          );
        });
      })
      .withFailureHandler(e => {
        showToast(e.message || 'Could not import from source link');
      })
      .importFacultyMasterFromUrl(state.session.token, url, document.getElementById('facultyMasterImportCategory')?.value||'');
  } else {
    fetch(url)
      .then(r => {
        if (!r.ok) throw new Error('Source link could not be fetched');
        return r.text();
      })
      .then(t => showFacultyMasterImportPreview(parseCsvText(t), url))
      .catch(e => showToast(e.message));
  }
}

function saveSubjectMaster(){
  const name=document.getElementById('subjectNameInput')?.value.trim(); if(!name){showToast('Subject name is required.');return;}
  if(isGAS()) google.script.run.withSuccessHandler(res=>{refreshERPDataAndRender('faculty',()=>{loadFacultyAttendanceOptions();showToast('Subject saved and synchronized');},{silent:true,force:true});}).withFailureHandler(e=>showToast(e.message||'Could not save subject')).adminSaveSubject(state.session.token,{Subject_Name:name,Active_Flag:true});
  else {state.facultyOptions.subjects=state.facultyOptions.subjects||[]; if(!state.facultyOptions.subjects.some(x=>String(x.Subject_Name||'').toLowerCase()===name.toLowerCase())) state.facultyOptions.subjects.push({Subject_ID:'SUB-'+Date.now(),Subject_Name:name,Active_Flag:'TRUE'});showToast('Subject saved locally');render();}
}

function saveFacultyMaster(){
  const payload={Faculty_ID:document.getElementById('facultyIdInput')?.value.trim(),Faculty_Name:document.getElementById('facultyNameInput')?.value.trim(),Branch_ID:document.getElementById('facultyBranchInput')?.value,Status:document.getElementById('facultyStatusInput')?.value};
  if(!payload.Faculty_ID||!payload.Faculty_Name){showToast('Faculty ID and name are required.');return;}
  if(isGAS()) google.script.run.withSuccessHandler(res=>{refreshERPDataAndRender('faculty',()=>{loadFacultyAttendanceOptions();showToast('Faculty saved and synchronized');},{silent:true,force:true});}).withFailureHandler(e=>showToast(e.message||'Could not save faculty')).adminSaveFaculty(state.session.token,payload); else {state.facultyOptions.faculties=state.facultyOptions.faculties||[];const i=state.facultyOptions.faculties.findIndex(f=>String(f.Faculty_ID)===payload.Faculty_ID);if(i>=0)state.facultyOptions.faculties[i]=payload;else state.facultyOptions.faculties.push(payload);showToast('Faculty saved locally');render();}
}
function saveFacultyAssignment(){
  const payload={Faculty_ID:document.getElementById('facultyAssignFaculty')?.value,Batch_ID:document.getElementById('facultyAssignBatch')?.value,Subject_Name:document.getElementById('facultyAssignSubject')?.value};
  if(!payload.Faculty_ID||!payload.Batch_ID||!payload.Subject_Name){showToast('Select faculty, batch and subject.');return;}
  if(isGAS()) google.script.run.withSuccessHandler(res=>{refreshERPDataAndRender('faculty',()=>{loadFacultyAttendanceOptions();showToast('Faculty assignment saved and synchronized');},{silent:true,force:true});}).withFailureHandler(e=>showToast(e.message||'Could not save assignment')).adminSaveFacultyAssignment(state.session.token,payload); else {const b=(state.data.batches||[]).find(x=>String(x.Batch_ID)===payload.Batch_ID);state.facultyOptions.assignments.push({...payload,Assignment_ID:String(Date.now()),Branch_ID:b?.Branch_ID||facultyBranch(),Branch_Name:b?.Branch_Name||'',Active_Flag:'TRUE'});showToast('Assignment saved locally');render();}
}

function settingsHTML(){
  const canManageSettings=canManageProtectedSettings();
  const isSA=isActualSuperAdmin();
  const showAttendanceDefaults=canManageSettings;
  return `<div class="grid grid-2">
    ${canManageSettings?`<div class="card"><h2 style="font-size:16px;margin-top:0">Brand Theme</h2><p class="muted small">AJMAL SUPER 40 brand palette is applied across the ERP. Light and dark mode are available from the top-right theme control.</p><div class="list"><div class="list-item"><span>Primary</span><b>${getComputedStyle(document.documentElement).getPropertyValue('--brand-primary')}</b></div><div class="list-item"><span>Secondary</span><b>${getComputedStyle(document.documentElement).getPropertyValue('--brand-secondary')}</b></div><div class="list-item"><span>Accent</span><b>${getComputedStyle(document.documentElement).getPropertyValue('--brand-accent')}</b></div></div></div>`:''}
    ${showAttendanceDefaults?`<div class="card"><h2 style="font-size:16px;margin-top:0">Attendance Defaults</h2><div class="grid grid-2"><div><label class="small muted">Default start</label><input id="attendanceWindowStart" type="time" class="input" value="${String((state.data.settings||[]).find(x=>String(x.Key)==='ATTENDANCE_DEFAULT_START')?.Value||'')}"></div><div><label class="small muted">Default end</label><input id="attendanceWindowEnd" type="time" class="input" value="${String((state.data.settings||[]).find(x=>String(x.Key)==='ATTENDANCE_DEFAULT_END')?.Value||'')}"></div></div><div class="toolbar" style="margin-top:10px"><button class="btn btn-primary" onclick="saveAttendanceSettings()">Save Attendance Window</button></div><div class="list" style="margin-top:10px"><div class="list-item">Operator <b>Campus/Location Incharge</b></div><div class="list-item">Frequency <b>Once per day</b></div><div class="list-item">Holiday suppression <b>Automatic</b></div></div></div>`:''}
  </div>
  <div class="card" style="margin-top:16px"><div class="section-title" style="margin-top:0"><div><h2>User Access & Password Control</h2><div class="muted">Change your own password. Only Super Admin and Admin can manage the protected settings controls; every authenticated user can change their own password.</div></div><span class="badge ${canManageSettings?'badge-green':'badge-blue'}">${canManageSettings?'SETTINGS ADMIN':'AUTHENTICATED USER'}</span></div>
    <div class="grid grid-3">
      <div><label class="small muted">Current password</label><input id="currentPwd" class="input" type="password"></div>
      <div><label class="small muted">New password</label><input id="newPwd" class="input" type="password"></div>
      <div><label class="small muted">Confirm new password</label><input id="confirmPwd" class="input" type="password"></div>
    </div>
    <div class="toolbar" style="margin-top:12px"><button class="btn btn-primary" onclick="changeOwnPassword()">Change My Password</button></div>
    ${canManageSettings?`<div class="admin-user-panel"><div class="section-title" style="margin-top:18px"><div><h3 style="margin:0">User Management</h3><div class="muted">Create, edit, disable and scope ERP users. Admin and Attendance Operator use the same Branch → Campus scope; Attendance Operator also requires explicit batch assignments.</div></div><span class="badge badge-red">SUPER ADMIN &amp; ADMIN</span></div><input type="hidden" id="adminOriginalUserId"><div class="grid grid-4"><input id="adminUserId" class="input" placeholder="User ID"><input id="adminUserName" class="input" placeholder="User name"><select id="adminRole" class="select" onchange="onAdminUserRoleOrBranchChanged()"><option>Admin</option><option>Super Admin</option><option>Campus Admin</option><option>Attendance Operator</option><option>Result Operator</option><option>Academic Admin</option></select><select id="adminBranch" class="select" onchange="handleAdminBranchChanged()"><option value="ALL">All Branches</option>${branchOptionsHtml()}</select><div><select id="adminCampus" class="select"><option value="">All / No Specific Campus</option></select><div id="adminCampusHint" class="muted small" style="margin-top:4px">Optional when All Branches is selected.</div></div><input id="adminUserPassword" class="input" type="password" placeholder="New password (leave blank to keep existing)"><label class="checkline"><input id="adminUserActive" type="checkbox" checked> Active account</label></div><div id="attendanceBatchAssignmentPanel" class="card-soft" style="display:none;margin-top:12px"><div class="section-title" style="margin:0 0 8px"><div><b>Assigned Batches for Attendance Operator</b><div class="muted small">Select one or more batches directly from the existing Batch List. Only these batches and their associated data will be available to the operator.</div></div><span id="attendanceBatchAssignmentCount" class="badge badge-blue">0 selected</span></div><input id="attendanceBatchAssignmentSearch" class="input" placeholder="Search Batch Code / Category / Campus / Class" oninput="filterAttendanceBatchAssignmentList()"><div id="attendanceBatchAssignmentList" class="batch-assignment-list"></div></div><div class="toolbar" style="margin-top:10px"><button class="btn btn-secondary" onclick="prefillAMRSCampusUser('AMRS GN_School','AMRS_GN_SCHOOL')">Prefill AMRS GN_School User</button><button class="btn btn-secondary" onclick="prefillAMRSCampusUser('AMRS Jugijan','AMRS_JUGIJAN')">Prefill AMRS Jugijan User</button></div><div class="toolbar" style="margin-top:10px"><button class="btn btn-secondary" onclick="adminSaveUser()">Create / Update User</button><button class="btn btn-secondary" onclick="loadUsers()">Refresh User List</button></div><div id="userList" class="list" style="margin-top:12px"></div></div>`:''}  </div>`;
}

function saveAttendanceSettings(){
  const start=document.getElementById('attendanceWindowStart')?.value||'', end=document.getElementById('attendanceWindowEnd')?.value||'';
  if(!start||!end||start>=end){showToast('Set a valid attendance window with end time later than start time.');return;}
  state._preserveInputsUntil=Date.now()+5000;
  if(isGAS()){
    showToast('Saving Attendance Window…');
    google.script.run
      .withSuccessHandler(res=>{
        if(!res||!res.ok){showToast('Attendance window was not confirmed by the server.');return;}
        state.data.settings=Array.isArray(state.data.settings)?state.data.settings:[];
        const up=(k,v)=>{const x=state.data.settings.find(r=>String(r.Key)===k);if(x)x.Value=v;else state.data.settings.push({Key:k,Value:v});};
        up('ATTENDANCE_DEFAULT_START',res.start);
        up('ATTENDANCE_DEFAULT_END',res.end);
        // Show the confirmed values immediately, then verify the full ERP state from Sheet.
        const a=document.getElementById('attendanceWindowStart'); if(a)a.value=res.start;
        const b=document.getElementById('attendanceWindowEnd'); if(b)b.value=res.end;
        render();
        showToast(`Attendance window saved: ${res.start} – ${res.end}`);
        refreshERPDataAndRender('settings',null,{force:true,silent:true,preserveInputs:false});
      })
      .withFailureHandler(err=>showToast(err.message||'Could not save attendance window'))
      .saveAttendanceSettings(state.session.token,start,end);
  }else{
    state.data.settings=state.data.settings||[];
    const up=(k,v)=>{const x=state.data.settings.find(r=>String(r.Key)===k);if(x)x.Value=v;else state.data.settings.push({Key:k,Value:v});}; up('ATTENDANCE_DEFAULT_START',start);up('ATTENDANCE_DEFAULT_END',end);showToast('Attendance window saved locally');render();
  }
}
function changeOwnPassword(){const a=document.getElementById('currentPwd').value,b=document.getElementById('newPwd').value,c=document.getElementById('confirmPwd').value;if(!b||b!==c){showToast('New password and confirmation must match');return;}if(isGAS()){google.script.run.withSuccessHandler(()=>{showToast('Password changed successfully');document.getElementById('currentPwd').value='';document.getElementById('newPwd').value='';document.getElementById('confirmPwd').value='';}).withFailureHandler(err=>showToast(err.message||'Password change failed')).changeOwnPassword(state.session.token,a,b);}else{const users=JSON.parse(localStorage.getItem('erp-demo-users')||'[]');const me=users.find(x=>x.User_ID===state.session.user.User_ID);if(!me||me.Password!==a){showToast('Current password is incorrect');return;}me.Password=b;localStorage.setItem('erp-demo-users',JSON.stringify(users));showToast('Password changed locally');}}
function attendanceBatchAssignmentHTML(selectedIds=[]){
  const selected=new Set((selectedIds||[]).map(String));
  const rows=(state.data.batches||[]).slice().sort((a,b)=>{
    const ka=[String(a.Category_Name||a.Category||''),String(classFromBatch_(a)||''),String(a.Campus_Name||a.Campus||''),String(a.Batch_Code||a.Batch_Name||'')].join('\u0000').toLowerCase();
    const kb=[String(b.Category_Name||b.Category||''),String(classFromBatch_(b)||''),String(b.Campus_Name||b.Campus||''),String(b.Batch_Code||b.Batch_Name||'')].join('\u0000').toLowerCase();
    return ka.localeCompare(kb,undefined,{numeric:true,sensitivity:'base'});
  });
  const body=rows.map(b=>{
    const id=String(b.Batch_ID||'');
    const category=String(b.Category_Name||b.Category||'').trim();
    const cls=String(classFromBatch_(b)||'').trim();
    const campus=String(b.Campus_Name||b.Campus||'').trim();
    const batch=String(b.Batch_Code||b.Batch_Name||id).trim();
    const search=[category,cls,campus,batch].join(' ').toLowerCase();
    return `<tr class="attendance-batch-row" data-search="${escapeAttr(search)}"><td class="attendance-batch-select"><input type="checkbox" class="attendance-batch-check" value="${escapeAttr(id)}" ${selected.has(id)?'checked':''} onchange="updateAttendanceBatchAssignmentCount();updateAttendanceBatchMasterCheck()" aria-label="Assign batch ${escapeAttr(batch)}"></td><td>${escapeHtml(category)}</td><td>${escapeHtml(cls)}</td><td>${escapeHtml(campus)}</td><td><b>${escapeHtml(batch)}</b></td></tr>`;
  }).join('');
  return `<div class="attendance-batch-table-wrap"><table class="data-table attendance-batch-table"><thead><tr><th class="attendance-batch-select"><input type="checkbox" id="attendanceBatchMasterCheck" onchange="toggleAllAttendanceBatches(this.checked)" aria-label="Select all visible batches"></th><th>Category</th><th>Class</th><th>Campus</th><th>Batch</th></tr></thead><tbody>${body || '<tr><td colspan="5" class="muted">No batches are available in the existing Batch List.</td></tr>'}</tbody></table></div>`;
}
function renderAttendanceBatchAssignmentList(selectedIds=[]){
  const el=document.getElementById('attendanceBatchAssignmentList'); if(!el)return;
  el.innerHTML=attendanceBatchAssignmentHTML(selectedIds);
  updateAttendanceBatchAssignmentCount();
}
function updateAttendanceBatchAssignmentCount(){
  const n=document.querySelectorAll('.attendance-batch-check:checked').length;
  const el=document.getElementById('attendanceBatchAssignmentCount'); if(el)el.textContent=`${n} selected`;
  updateAttendanceBatchMasterCheck();
}
function updateAttendanceBatchMasterCheck(){
  const master=document.getElementById('attendanceBatchMasterCheck'); if(!master)return;
  const rows=[...document.querySelectorAll('.attendance-batch-row')].filter(r=>r.style.display!=='none');
  const checks=rows.map(r=>r.querySelector('.attendance-batch-check')).filter(Boolean);
  const checked=checks.filter(c=>c.checked).length;
  master.checked=checks.length>0 && checked===checks.length;
  master.indeterminate=checked>0 && checked<checks.length;
}
function toggleAllAttendanceBatches(checked){
  document.querySelectorAll('.attendance-batch-row').forEach(r=>{
    if(r.style.display==='none')return;
    const c=r.querySelector('.attendance-batch-check'); if(c)c.checked=!!checked;
  });
  updateAttendanceBatchAssignmentCount();
}
function filterAttendanceBatchAssignmentList(){
  const q=String(document.getElementById('attendanceBatchAssignmentSearch')?.value||'').trim().toLowerCase();
  document.querySelectorAll('.attendance-batch-row').forEach(r=>{r.style.display=!q||String(r.dataset.search||'').includes(q)?'table-row':'none';});
  updateAttendanceBatchMasterCheck();
}
function toggleAttendanceBatchAssignment(selectedIds){
  const panel=document.getElementById('attendanceBatchAssignmentPanel'); if(!panel)return;
  const show=String(document.getElementById('adminRole')?.value||'')==='Attendance Operator';
  panel.style.display=show?'block':'none';
  if(show){
    renderAttendanceBatchAssignmentList(selectedIds||[...document.querySelectorAll('.attendance-batch-check:checked')].map(x=>x.value));
  }
}
function selectedAttendanceBatchIds_(){
  return [...document.querySelectorAll('.attendance-batch-check:checked')].map(x=>String(x.value||'').trim()).filter(Boolean);
}
function populateAdminUser(u){
  if(!u) return;
  const set=(id,v)=>{const el=document.getElementById(id); if(el) el.value=v??'';};
  set('adminOriginalUserId',u.User_ID||'');
  set('adminUserId',u.User_ID||'');
  set('adminUserName',u.User_Name||'');
  const role=document.getElementById('adminRole'); if(role) role.value=u.Role||'Campus Admin';
  const branch=document.getElementById('adminBranch'); if(branch){branch.multiple=(u.Role==='Result Operator'||u.Role==='Academic Admin'); branch.size=branch.multiple?Math.min(4,Math.max(2,(state.data.branches||[]).length)):1; if(branch.multiple){const ids=Array.isArray(u.Assigned_Branch_IDs)?u.Assigned_Branch_IDs.map(String):[String(u.Branch_ID||'BR001')]; [...branch.options].forEach(o=>o.selected=ids.includes(String(o.value)));}else branch.value=u.Branch_ID||'BR001';}
  const campus=document.getElementById('adminCampus'); if(campus) campus.value=u.Campus_ID||'';
  set('adminUserPassword','');
  setTimeout(()=>{
    onAdminUserRoleOrBranchChanged();
    const c=document.getElementById('adminCampus'); if(c) c.value=u.Campus_ID||'';
    toggleAttendanceBatchAssignment(u.Attendance_Batch_IDs||[]);
  },0);
  const active=document.getElementById('adminUserActive'); if(active) active.checked = !['FALSE','0','NO','INACTIVE'].includes(String(u.Active_Flag).toUpperCase());
  document.querySelector('.admin-user-panel')?.scrollIntoView({behavior:'smooth',block:'center'});
}
function editAdminUser(index){
  const u=state.adminUsers?.[Number(index)];
  if(!u){showToast('User record could not be loaded. Refresh the user list and try again.');return;}
  populateAdminUser(u);
}
function deleteAdminUser(index){
  if(!isSuperAdminSession()){showToast('Super Admin authorization required.');return;}
  const u=state.adminUsers?.[Number(index)];
  if(!u){showToast('User record could not be loaded. Refresh the user list and try again.');return;}
  if(String(u.User_ID).toLowerCase()===String(state.session.user?.User_ID||'').toLowerCase()){showToast('You cannot delete your own logged-in account.');return;}
  if(!confirm(`Delete user "${u.User_ID}" permanently? This cannot be undone.`)) return;
  if(isGAS()){
    google.script.run.withSuccessHandler(()=>{if(String(document.getElementById('adminOriginalUserId')?.value||'').toLowerCase()===String(u.User_ID).toLowerCase())resetAdminUserForm();refreshERPDataAndRender('settings',()=>{loadUsers();showToast(`User ${u.User_ID} deleted and synchronized.`);},{silent:true,force:true});}).withFailureHandler(err=>showToast(err.message||'Could not delete user')).adminDeleteUser(state.session.token,u.User_ID);
  }else{
    const rows=JSON.parse(localStorage.getItem('erp-demo-users')||'[]');
    const next=rows.filter(x=>String(x.User_ID).toLowerCase()!==String(u.User_ID).toLowerCase());
    const activeAdmins=next.filter(x=>String(x.Role)==='Admin' && String(x.Active_Flag===undefined?'TRUE':x.Active_Flag).toUpperCase()!=='FALSE').length;
    if(String(u.Role)==='Admin' && activeAdmins<1){showToast('Cannot delete the last active Admin account.');return;}
    localStorage.setItem('erp-demo-users',JSON.stringify(next));showToast(`User ${u.User_ID} deleted successfully.`);if(String(document.getElementById('adminOriginalUserId')?.value||'').toLowerCase()===String(u.User_ID).toLowerCase())resetAdminUserForm();loadUsers();
  }
}

function loadUsers(){
  if(!canManageProtectedSettings())return;
  const renderRows=(rows)=>{
    state.adminUsers = Array.isArray(rows) ? rows : [];
    const el=document.getElementById('userList'); if(!el)return;
    el.innerHTML=state.adminUsers.map((u,idx)=>{
      const active=!['FALSE','0','NO','INACTIVE'].includes(String(u.Active_Flag).toUpperCase());
      return `<div class=\"list-item user-admin-row\"><span><b>${escapeHtml(u.User_ID)}</b><br><span class=\"muted\">${escapeHtml(u.User_Name)} • ${escapeHtml(u.Role)} • ${escapeHtml(u.Branch_Name||'AJMAL SUPER 40 Hojai')}${Array.isArray(u.Assigned_Branch_IDs)&&u.Assigned_Branch_IDs.length>1?` • ${u.Assigned_Branch_IDs.length} assigned branches`:''}${u.Campus_Name?` • ${escapeHtml(u.Campus_Name)}`:''} • ${u.Role==='Attendance Operator'?`${Array.isArray(u.Attendance_Batch_IDs)?u.Attendance_Batch_IDs.length:0} assigned batches • `:''}${escapeHtml(u.Password_Status||'Password set (masked)')}</span></span><span style=\"display:flex;align-items:center;gap:8px;flex-wrap:wrap\"><span class=\"badge ${active?'badge-green':'badge-red'}\">${active?'Active':'Disabled'}</span><button type=\"button\" class=\"btn btn-secondary btn-sm\" onclick=\"editAdminUser(${idx})\">Edit</button><button type=\"button\" class=\"btn btn-danger btn-sm\" onclick=\"deleteAdminUser(${idx})\">Delete</button></span></div>`;
    }).join('')||'<div class=\"muted\">No users.</div>';
  };
  if(isGAS()){
    google.script.run.withSuccessHandler(renderRows).withFailureHandler(err=>showToast(err.message||'Could not load users')).listUsers(state.session.token);
  }else{
    renderRows(JSON.parse(localStorage.getItem('erp-demo-users')||'[]'));
  }
}
function resetAdminUserForm(){
  ['adminOriginalUserId','adminUserId','adminUserName','adminUserPassword'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  const role=document.getElementById('adminRole'); if(role) role.value='Campus Admin';
  const branch=document.getElementById('adminBranch'); if(branch){branch.multiple=false;branch.size=1;branch.value=state.data.branches?.[0]?.Branch_ID||'BR001';}
  const campus=document.getElementById('adminCampus'); if(campus) campus.value='';
  const active=document.getElementById('adminUserActive'); if(active) active.checked=true;
  const search=document.getElementById('attendanceBatchAssignmentSearch'); if(search) search.value='';
  setTimeout(()=>{onAdminUserRoleOrBranchChanged();toggleAttendanceBatchAssignment([]);},0);
}
function prefillAMRSCampusUser(campusName,userId){
  const campus=(state.data.campuses||[]).find(c=>String(c.Campus_Name||c.Location_Name||'').trim().toLowerCase()===String(campusName).trim().toLowerCase());
  const branch=campus?.Branch_ID||'BR001';
  const role=document.getElementById('adminRole'); if(role)role.value='Campus Admin';
  const uid=document.getElementById('adminUserId'); if(uid)uid.value=userId||'';
  const uname=document.getElementById('adminUserName'); if(uname)uname.value=campusName;
  const branchEl=document.getElementById('adminBranch');
  if(branchEl){branchEl.multiple=false;branchEl.value=branch;onAdminUserRoleOrBranchChanged();}
  setTimeout(()=>{
    const campusEl=document.getElementById('adminCampus');
    if(campusEl&&campus)campusEl.value=campus.Campus_ID||'';
    const pwd=document.getElementById('adminUserPassword'); if(pwd)pwd.focus();
    showToast(`${campusName} Campus Admin details prefilled. Set the password, then click Create / Update User.`);
  },80);
}

function adminSaveUser(){
  const campusEl=document.getElementById('adminCampus');
  const campusId=campusEl?.value||'';
  const campusRow=(state.data.campuses||[]).find(c=>String(c.Campus_ID||'')===String(campusId));
  const role=document.getElementById('adminRole').value;
  const branchEl=document.getElementById('adminBranch');
  const assignedBranchIds=branchEl?.multiple?[...branchEl.selectedOptions].map(o=>String(o.value||'').trim()).filter(Boolean):[String(branchEl?.value||'ALL').trim()];
  const primaryBranch=assignedBranchIds[0]||'ALL';
  const obj={Original_User_ID:document.getElementById('adminOriginalUserId')?.value.trim()||'',User_ID:document.getElementById('adminUserId').value.trim(),User_Name:document.getElementById('adminUserName').value.trim(),Role:role,Branch_ID:role==='Super Admin'?'ALL':primaryBranch,Assigned_Branch_IDs:role==='Result Operator'||role==='Academic Admin'?assignedBranchIds:[],Campus_ID:campusId,Campus_Name:campusRow?.Campus_Name||campusRow?.Location_Name||'',Active_Flag:document.getElementById('adminUserActive')?.checked!==false,Password:document.getElementById('adminUserPassword').value,Attendance_Batch_IDs:selectedAttendanceBatchIds_()};
  if(!obj.User_ID||!obj.User_Name){showToast('User ID and name are required');return;}
  if(obj.Password&&obj.Password.length<8){showToast('Password must be at least 8 characters');return;}
  if((obj.Role==='Result Operator'||obj.Role==='Academic Admin')&&!obj.Assigned_Branch_IDs.length){showToast(`Select at least one branch for ${obj.Role}.`);return;}
  if(obj.Role==='Campus Admin' && (!obj.Branch_ID||obj.Branch_ID==='ALL'||!obj.Campus_ID)){showToast('Campus Admin requires a specific branch and campus.');return;}
  if((obj.Role==='Admin'||obj.Role==='Attendance Operator') && obj.Branch_ID!=='ALL' && !obj.Campus_ID){showToast('A campus is required when a specific branch is selected.');return;}
  if(obj.Role==='Attendance Operator'&&!obj.Attendance_Batch_IDs.length){showToast('Select at least one assigned batch for an Attendance Operator.');return;}
  if(isGAS()){
    google.script.run.withSuccessHandler(()=>{resetAdminUserForm();refreshERPDataAndRender('settings',()=>{loadUsers();showToast('User saved and synchronized');},{silent:true,force:true});}).withFailureHandler(err=>showToast(err.message||'Could not save user')).adminUpsertUser(state.session.token,obj);
  }else{
    const rows=JSON.parse(localStorage.getItem('erp-demo-users')||'[]'); const key=obj.Original_User_ID||obj.User_ID; const i=rows.findIndex(x=>String(x.User_ID).toLowerCase()===String(key).toLowerCase());
    if(i<0 && !obj.Password){showToast('Password is required for a new user');return;}
    if(i>=0){const old=rows[i];rows[i]=Object.assign({},old,obj);if(!obj.Password)rows[i].Password=old.Password;}else rows.push(obj);
    localStorage.setItem('erp-demo-users',JSON.stringify(rows));showToast('User saved locally');resetAdminUserForm();loadUsers();
  }
}


let resultImportRows=[];
let resultImportHeaders=[];
function resultsHTML(){
  const canUpload=['Admin','Result Operator'].includes(String(state.session.user?.Role||''));
  return `<div class="results-shell">
    <div class="result-hero card"><div><div class="eyebrow">ACADEMIC PERFORMANCE</div><h2 style="margin:4px 0">Students Result Report</h2><div class="muted">Central result database linked to UIN, category, batch and class.</div></div><div class="result-quick-actions"><button class="btn btn-primary" onclick="showResultTab('uin')">Search by UIN</button>${canUpload?`<button class="btn btn-secondary" onclick="requireResultUploadAccess()">🔒 Result Upload</button>`:''}</div></div>
    <div class="result-tabs"><button id="resultTabUin" class="result-tab active" onclick="showResultTab('uin')">Search Result by UIN</button><button id="resultTabClass" class="result-tab" onclick="showResultTab('class')">Class Wise Result</button><button id="resultTabBatch" class="result-tab" onclick="showResultTab('batch')">Batch Wise Result</button><button id="resultTabAverage" class="result-tab" onclick="showResultTab('average')">Average Result Analysis</button></div>
    <div id="resultPanel"></div>
    ${canUpload?`<div class="card result-upload-card" id="resultUploadPanel" style="display:${state.resultUploadProof?'block':'none'}"><div class="section-title" style="margin-top:0"><div><h3 style="margin:0">Result Upload</h3><div class="muted">Protected import • Admin / Result Operator only</div></div><span class="badge badge-red">AUTHORIZED</span></div><div class="card-soft" style="margin-bottom:12px"><div class="grid grid-2"><div><label class="small muted">Upload Category</label><select id="resultUploadCategory" class="select"><option value="">Use Category_Name from CSV</option><option value="School">AMRS School (Classes VI–X)</option><option value="AJMAL SUPER 40">AJMAL SUPER 40 (NEET / JEE)</option></select></div><div class="muted small" style="display:flex;align-items:end">School uploads are validated against AMRS Class VI–X batch and campus records.</div></div></div><div class="upload-drop" onclick="document.getElementById('resultFile').click()" ondragover="event.preventDefault();this.classList.add('dragover')" ondragleave="this.classList.remove('dragover')" ondrop="handleResultDrop(event)"><input id="resultFile" type="file" accept=".csv,.xlsx,.xls" style="display:none" onchange="handleResultFile(this.files[0])"><div style="font-size:30px">📊</div><h3 style="margin:8px 0 4px">Drop CSV or Excel result file here</h3><div class="muted">Recommended fields: UIN, Exam_Name, Exam_Date, Category_Name, Batch_Code, Physics_Marks, Chemistry_Marks, Botany_Marks, Zoology_Marks, Maths_Marks, Total_Obtained_Marks, Total_Max_Marks, Percentage, Rank</div></div><div id="resultImportPreview"></div></div>`:''}
  </div><div class="card" style="margin-top:16px"><div class="section-title" style="margin-top:0"><div><b>Recommended result import design</b><div class="muted">One row per UIN per exam. Subject marks can be provided as Physics_Marks, Chemistry_Marks, Biology_Marks, Maths_Marks or Subject_Name + Subject_Marks.</div></div></div></div>`;
}
function showResultTab(tab){document.querySelectorAll('.result-tab').forEach(b=>b.classList.remove('active'));const btn=document.getElementById('resultTab'+tab.charAt(0).toUpperCase()+tab.slice(1));if(btn)btn.classList.add('active');const p=document.getElementById('resultPanel');if(!p)return;if(tab==='uin')p.innerHTML=resultUinPanel();else if(tab==='class')p.innerHTML=resultClassPanel();else if(tab==='batch')p.innerHTML=resultBatchPanel();else p.innerHTML=resultAveragePanel();if(tab==='average')toggleAnalysisInputs();loadResultOptions();}
function loadResultOptions(filters={}){if(!isGAS())return;google.script.run.withSuccessHandler(o=>{state.resultOptions=o||state.resultOptions; if(state.page==='results'){const active=document.querySelector('.result-tab.active')?.id||'resultTabUin';const tab=active.replace('resultTab','').toLowerCase();if(document.getElementById('resultPanel')){if(tab==='class')document.getElementById('resultPanel').innerHTML=resultClassPanel();else if(tab==='batch')document.getElementById('resultPanel').innerHTML=resultBatchPanel();else if(tab==='average')document.getElementById('resultPanel').innerHTML=resultAveragePanel();}}}).withFailureHandler(err=>showToast(err.message||'Could not load result options')).getResultOptions(state.session.token,filters)}
function resultUinPanel(){const selected=resultBranchScopedRole_()?assignedBranchIds_()[0]||'':(isSuperAdmin()?'ALL':state.session.user?.Branch_ID);return `<div class="card result-panel"><div class="section-title" style="margin-top:0"><div><h3 style="margin:0">Search Result by UIN</h3><div class="muted">View exam-wise results linked to a permanent UIN. Subject columns are automatically limited to the subjects applicable to JEE / NEET.</div></div></div><div class="toolbar" style="align-items:flex-start"><select id="resultUinBranch" class="select">${resultBranchOptionsHtml(selected)}</select><input id="resultUin" class="input" placeholder="Enter UIN" style="min-width:240px"><div style="min-width:260px"><label class="small muted" style="display:block;margin-bottom:4px">Exam(s)</label><select id="resultExamUin" class="select" multiple size="4" onchange="syncResultExamMultiSelect(this)" style="min-height:96px"><option value="" selected>All Exams</option>${(state.resultOptions.exams||[]).map(x=>`<option value="${escapeAttr(x)}">${escapeHtml(x)}</option>`).join('')}</select><div class="muted tiny" style="margin-top:4px">Select one or more exams; leave All Exams selected for the full history.</div></div><button class="btn btn-primary" onclick="searchResultUin()">Search</button></div><div id="resultUinOut" style="margin-top:14px"></div></div>`}function resultClassPanel(){const bw=resultBranchScopedRole_();return `<div class="card result-panel"><div class="section-title" style="margin-top:0"><div><h3 style="margin:0">Class Wise Result</h3><div class="muted">${bw?'Filters cascade from branch → category → class → batch.':'Filters cascade from branch → campus → category → class → batch.'}</div></div></div><div class="toolbar"><select id="resultClassBranch" class="select" onchange="refreshResultClassFilters()">${resultBranchOptionsHtml(bw?assignedBranchIds_()[0]||'':(isSuperAdmin()?'ALL':state.session.user?.Branch_ID))}</select>${bw?'':`<select id="resultClassCampus" class="select" onchange="refreshResultClassFilters()"><option value="All">All Campuses</option>${(state.resultOptions.campuses||[]).map(x=>`<option>${escapeHtml(x)}</option>`).join('')}</select>`}<select id="resultClassCategory" class="select" onchange="refreshResultClassFilters()"><option value="All">All Categories</option>${(state.resultOptions.categories||[]).map(x=>`<option>${escapeHtml(x)}</option>`).join('')}</select><select id="resultClassName" class="select" disabled onchange="refreshResultClassFilters()"><option value="All">Select category first</option></select><select id="resultClassBatch" class="select" disabled onchange="refreshResultClassFilters()"><option value="All">Select class first</option></select><select id="resultClassExam" class="select"><option value="All">All Exams</option>${(state.resultOptions.exams||[]).map(x=>`<option>${escapeHtml(x)}</option>`).join('')}</select><button class="btn btn-primary" onclick="runClassResult()">Generate Report</button></div><div id="classResultOut" style="margin-top:14px"></div></div>`}
function resultBatchPanel(){const bw=resultBranchScopedRole_();return `<div class="card result-panel"><div class="section-title" style="margin-top:0"><div><h3 style="margin:0">Batch Wise Result</h3><div class="muted">${bw?'Select branch, category and class; campus selection is not required.':'Select branch, campus and class first; only associated batches will be available.'}</div></div></div><div class="toolbar"><select id="resultBatchBranch" class="select" onchange="refreshResultBatchFilters()">${resultBranchOptionsHtml(bw?assignedBranchIds_()[0]||'':(isSuperAdmin()?'ALL':state.session.user?.Branch_ID))}</select>${bw?'':`<select id="resultBatchCampus" class="select" onchange="refreshResultBatchFilters()"><option value="All">All Campuses</option>${(state.resultOptions.campuses||[]).map(x=>`<option>${escapeHtml(x)}</option>`).join('')}</select>`}<select id="resultBatchCategory" class="select" onchange="refreshResultBatchFilters()"><option value="All">All Categories</option>${(state.resultOptions.categories||[]).map(x=>`<option>${escapeHtml(x)}</option>`).join('')}</select><select id="resultBatchClass" class="select" disabled onchange="refreshResultBatchFilters()"><option value="All">Select category first</option></select><input id="batchSearchBox" class="input" placeholder="Filter batch list" disabled oninput="filterBatchChoices(this.value)"><select id="resultBatchExam" class="select"><option value="All">All Exams</option>${(state.resultOptions.exams||[]).map(x=>`<option>${escapeHtml(x)}</option>`).join('')}</select><button class="btn btn-primary" onclick="runBatchResult()">Generate Report</button></div><div id="batchChoices" class="multi-select-grid"><div class="muted">Select a class to display associated batches.</div></div><div id="batchResultOut" style="margin-top:14px"></div></div>`}
function resultAveragePanel(){const bw=resultBranchScopedRole_();return `<div class="card result-panel"><div class="section-title" style="margin-top:0"><div><h3 style="margin:0">Average Result Analysis</h3><div class="muted">${bw?'Select branch and analysis scope; campus selection is not required.':'Select branch → campus → category → class → batch/UIN to narrow the analysis.'}</div></div></div><div class="toolbar"><select id="analysisBranch" class="select" onchange="refreshAnalysisFilters()">${resultBranchOptionsHtml(bw?assignedBranchIds_()[0]||'':(isSuperAdmin()?'ALL':state.session.user?.Branch_ID))}</select>${bw?'':`<select id="analysisCampus" class="select" onchange="refreshAnalysisFilters()"><option value="All">All Campuses</option>${(state.resultOptions.campuses||[]).map(x=>`<option>${escapeHtml(x)}</option>`).join('')}</select>`}<select id="analysisScope" class="select" onchange="toggleAnalysisInputs()"><option value="category">Category</option><option value="class">Class</option><option value="batch">Batch</option><option value="uin">Individual Student</option></select><span id="analysisKeyWrap"></span><select id="analysisExam" class="select"><option value="All">All Exams</option>${(state.resultOptions.exams||[]).map(x=>`<option>${escapeHtml(x)}</option>`).join('')}</select><button class="btn btn-primary" onclick="runAverageAnalysis()">Analyse</button></div><div id="analysisOut" style="margin-top:14px"></div></div>`}
function resultOptionRows(){return state.resultOptions.optionRows||[];}function setSelectOptions(id, values, selected='All', allowAll=true){const el=document.getElementById(id);if(!el)return;const vals=[...new Set(values.filter(Boolean))].sort();el.innerHTML=(allowAll?'<option value="All">All</option>':'')+vals.map(v=>`<option ${String(v)===String(selected)?'selected':''}>${escapeHtml(v)}</option>`).join('');}
function scopedResultRows(branch,category,className,batch){return resultOptionRows().filter(r=>(branch==='ALL'||String(r.Branch_ID)===String(branch))&&(category==='All'||String(r.Category_Name)===String(category))&&(className==='All'||String(r.Class_Name)===String(className))&&(batch==='All'||String(r.Batch_Code)===String(batch)));}
function refreshResultExamSelect(id, rows, selected='All'){setSelectOptions(id,rows.map(r=>r.Exam_Name||''),selected,true)}
function filteredResultOptionRows(br, campus='All', cat='All', cls='All', batch='All'){return resultOptionRows().filter(r=>(br==='ALL'||String(r.Branch_ID)===br)&&(campus==='All'||String(r.Campus_Name||'')===campus)&&(cat==='All'||String(r.Category_Name)===cat)&&(cls==='All'||String(r.Class_Name)===cls)&&(batch==='All'||String(r.Batch_Code)===batch));}
function resultCampusOptions(br){const vals=[...new Set(resultOptionRows().filter(r=>br==='ALL'||String(r.Branch_ID)===br).map(r=>String(r.Campus_Name||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));return vals;}
function refreshResultCampusSelect(ids, br){ids.forEach(id=>{const el=document.getElementById(id);if(!el)return;const prev=el.value||'All';const vals=resultCampusOptions(br);el.innerHTML='<option value="All">All Campuses</option>'+vals.map(x=>`<option ${x===prev?'selected':''}>${escapeHtml(x)}</option>`).join('');});}
function refreshResultClassFilters(){
  const bw=resultBranchScopedRole_();
  const br=document.getElementById('resultClassBranch')?.value||'ALL';
  if(!bw) refreshResultCampusSelect(['resultClassCampus'],br);
  const campus=bw?'All':(document.getElementById('resultClassCampus')?.value||'All');
  const rows=resultOptionRows().filter(r=>(br==='ALL'||String(r.Branch_ID)===br)&&(!bw? (campus==='All'||String(r.Campus_Name||'')===campus):true));
  const cats=[...new Set(rows.map(r=>r.Category_Name).filter(Boolean))].sort();
  const catSel=document.getElementById('resultClassCategory');
  if(catSel){const prev=catSel.value;catSel.innerHTML='<option value="All">All Categories</option>'+cats.map(x=>`<option ${x===prev?'selected':''}>${escapeHtml(x)}</option>`).join('');}
  const cat=catSel?.value||'All';
  const classes=[...new Set(rows.filter(r=>cat==='All'||r.Category_Name===cat).map(r=>r.Class_Name).filter(Boolean))].sort();
  const classSel=document.getElementById('resultClassName');
  if(classSel){const prev=classSel.value;classSel.disabled=false;classSel.innerHTML='<option value="All">All Classes</option>'+classes.map(x=>`<option ${x===prev?'selected':''}>${escapeHtml(x)}</option>`).join('');}
  const cls=classSel?.value||'All';
  const batches=[...new Set(rows.filter(r=>(cat==='All'||r.Category_Name===cat)&&(cls==='All'||r.Class_Name===cls)).map(r=>r.Batch_Code).filter(Boolean))].sort();
  const bs=document.getElementById('resultClassBatch');
  if(bs){const prev=bs.value;bs.disabled=false;bs.innerHTML='<option value="All">All Batches</option>'+batches.map(x=>`<option ${x===prev?'selected':''}>${escapeHtml(x)}</option>`).join('');}
  refreshResultExamSelect('resultClassExam',filteredResultOptionRows(br,campus,cat,cls,bs?.value||'All'),document.getElementById('resultClassExam')?.value||'All');
}
function refreshResultBatchFilters(){
  const bw=resultBranchScopedRole_();
  const br=document.getElementById('resultBatchBranch')?.value||'ALL';
  if(!bw) refreshResultCampusSelect(['resultBatchCampus'],br);
  const campus=bw?'All':(document.getElementById('resultBatchCampus')?.value||'All');
  const rows=resultOptionRows().filter(r=>(br==='ALL'||String(r.Branch_ID)===br)&&(!bw?(campus==='All'||String(r.Campus_Name||'')===campus):true));
  const cats=[...new Set(rows.map(r=>r.Category_Name).filter(Boolean))].sort();
  const catSel=document.getElementById('resultBatchCategory');
  if(catSel){const prev=catSel.value;catSel.innerHTML='<option value="All">All Categories</option>'+cats.map(x=>`<option ${x===prev?'selected':''}>${escapeHtml(x)}</option>`).join('');}
  const cat=catSel?.value||'All';
  const classes=[...new Set(rows.filter(r=>cat==='All'||r.Category_Name===cat).map(r=>r.Class_Name).filter(Boolean))].sort();
  const cs=document.getElementById('resultBatchClass');
  if(cs){const prev=cs.value;cs.disabled=false;cs.innerHTML='<option value="All">All Classes</option>'+classes.map(x=>`<option ${x===prev?'selected':''}>${escapeHtml(x)}</option>`).join('');}
  const cls=cs?.value||'All';
  const batches=[...new Set(rows.filter(r=>(cat==='All'||r.Category_Name===cat)&&(cls==='All'||r.Class_Name===cls)).map(r=>r.Batch_Code).filter(Boolean))].sort();
  const box=document.getElementById('batchChoices'); if(box)box.innerHTML=(cls==='All')?'<div class="muted">Select a class to display associated batches.</div>':batches.map(x=>`<label class="choice-pill"><input type="checkbox" value="${escapeAttr(x)}"> <span>${escapeHtml(x)}</span></label>`).join('');
  const search=document.getElementById('batchSearchBox'); if(search)search.disabled=cls==='All';
  refreshResultExamSelect('resultBatchExam',filteredResultOptionRows(br,campus,cat,cls,'All'),document.getElementById('resultBatchExam')?.value||'All');
}
function refreshAnalysisFilters(){
  const bw=resultBranchScopedRole_();
  const br=document.getElementById('analysisBranch')?.value||'ALL';
  if(!bw) refreshResultCampusSelect(['analysisCampus'],br);
  const campus=bw?'All':(document.getElementById('analysisCampus')?.value||'All');
  const rows=resultOptionRows().filter(r=>(br==='ALL'||String(r.Branch_ID)===br)&&(!bw?(campus==='All'||String(r.Campus_Name||'')===campus):true));
  const wrap=document.getElementById('analysisKeyWrap'); if(!wrap)return;
  const scope=document.getElementById('analysisScope')?.value||'category';
  if(scope==='category'){const vals=[...new Set(rows.map(r=>r.Category_Name).filter(Boolean))].sort();wrap.innerHTML='<select id="analysisKeySelect" class="select"><option value="">Select Category</option>'+vals.map(x=>`<option value="${escapeAttr(x)}">${escapeHtml(x)}</option>`).join('')+'</select>';}
  else if(scope==='class'){const vals=[...new Set(rows.map(r=>r.Class_Name).filter(Boolean))].sort();wrap.innerHTML='<select id="analysisKeySelect" class="select"><option value="">Select Class</option>'+vals.map(x=>`<option value="${escapeAttr(x)}">${escapeHtml(x)}</option>`).join('')+'</select>';}
  else if(scope==='batch'){const vals=[...new Set(rows.map(r=>r.Batch_Code).filter(Boolean))].sort();wrap.innerHTML='<select id="analysisKeySelect" class="select"><option value="">Select Batch</option>'+vals.map(x=>`<option value="${escapeAttr(x)}">${escapeHtml(x)}</option>`).join('')+'</select>';}
  else {wrap.innerHTML='<input id="analysisKeySelect" class="input" placeholder="Enter UIN">';}
}
function syncResultExamMultiSelect(sel){const opts=[...sel.options];const all=opts.find(o=>o.value==='');const specific=opts.filter(o=>o.value&&o.selected);if(specific.length&&all)all.selected=false;if(!specific.length&&all)all.selected=true;}
function resultStreamType_(r){const hay=[r?.Category_Name,r?.Programme].map(x=>String(x||'')).join(' ').toUpperCase();if(/\bJEE\b/.test(hay))return 'JEE';if(/\bNEET\b/.test(hay))return 'NEET';return 'OTHER';}
function resultSubjectValue_(r,subject){const map={Physics:['Physics_Marks','Physics'],Chemistry:['Chemistry_Marks','Chemistry'],Botany:['Botany_Marks','Botany'],Zoology:['Zoology_Marks','Zoology'],Mathematics:['Maths_Marks','Mathematics_Marks','Mathematics','Maths']};const keys=map[subject]||[];for(const k of keys){if(r?.[k]!==undefined&&r?.[k]!==null&&String(r[k]).trim()!=='')return r[k];}const sn=String(r?.Subject_Name||'').trim().toLowerCase();if(sn===subject.toLowerCase()||((subject==='Mathematics')&&sn==='maths'))return r?.Subject_Marks??'';return '';}
function resultHasSubject_(r,subject){const v=resultSubjectValue_(r,subject);return v!==null&&v!==undefined&&String(v).trim()!=='';}
function resultApplicableSubjects_(r){const stream=resultStreamType_(r);if(stream==='JEE')return ['Physics','Chemistry','Mathematics'];if(stream==='NEET')return ['Physics','Chemistry','Botany','Zoology'];const order=['Physics','Chemistry','Botany','Zoology','Mathematics','English','MIL','Others'];return order.filter(x=>resultHasSubject_(r,x));}
function resultSubjectMax_(r,subject){const stream=resultStreamType_(r);const directKeys=[subject+'_Max_Marks',subject+'_Max',subject+'_Maximum',subject+'_Max_Subject_Marks',subject==='Mathematics'?'Maths_Max_Marks':''];for(const k of directKeys){if(k&&r?.[k]!==undefined&&r?.[k]!==null&&String(r[k]).trim()!==''){const n=Number(r[k]);if(Number.isFinite(n)&&n>0)return n;}}const n=Number(r?.Max_Subject_Marks);if(Number.isFinite(n)&&n>0)return n;if(stream==='NEET')return 180;if(stream==='JEE')return 100;return ''}
function resultCollapsedRows_(rows){const groups=new Map();(rows||[]).forEach(r=>{const key=[String(r.UIN||''),String(r.Exam_ID||r.Exam_Name||''),String(r.Exam_Date||'')].join('|').toUpperCase();let g=groups.get(key);if(!g){g=Object.assign({},r);groups.set(key,g);}else{const fields=['Student_Name','Father_Name','Programme','Class_Name','Category_Name','Batch_Code','Campus_Name','Branch_ID','Branch_Name','Percentage','Rank','Result_Status','Total_Obtained_Marks','Total_Max_Marks','Total_Marks','Max_Total_Marks'];fields.forEach(k=>{if((g[k]===undefined||g[k]===null||String(g[k]).trim()==='')&&r[k]!==undefined)g[k]=r[k];});['Physics_Marks','Chemistry_Marks','Botany_Marks','Zoology_Marks','Maths_Marks','Mathematics_Marks'].forEach(k=>{if((g[k]===undefined||g[k]===null||String(g[k]).trim()==='')&&r[k]!==undefined)g[k]=r[k];});const sn=String(r.Subject_Name||'').trim().toLowerCase();if(sn){if(sn==='physics')g.Physics_Marks=r.Subject_Marks??g.Physics_Marks;if(sn==='chemistry')g.Chemistry_Marks=r.Subject_Marks??g.Chemistry_Marks;if(sn==='botany')g.Botany_Marks=r.Subject_Marks??g.Botany_Marks;if(sn==='zoology')g.Zoology_Marks=r.Subject_Marks??g.Zoology_Marks;if(sn==='maths'||sn==='mathematics')g.Maths_Marks=r.Subject_Marks??g.Maths_Marks;}}});return [...groups.values()].sort((a,b)=>String(b.Exam_Date||'').localeCompare(String(a.Exam_Date||''))||String(a.Exam_Name||'').localeCompare(String(b.Exam_Name||'')));}
function resultSubjectsInline_(r){return resultApplicableSubjects_(r).map(sub=>{const max=resultSubjectMax_(r,sub),obt=resultSubjectValue_(r,sub);return `<span style="display:inline-block;margin:2px 5px 2px 0;padding:3px 7px;border:1px solid #d9e2ec;border-radius:999px;background:#f7fafc"><b>${escapeHtml(sub)}</b> ${escapeHtml(max===''?'':String(max)+' / ')}${escapeHtml(String(obt))}</span>`;}).join('')||'—';}
function resultTrendSvg_(trend){const pts=(trend||[]).slice(0,20);if(!pts.length)return '';const W=760,H=300,L=58,R=24,T=34,B=62,plotW=W-L-R,plotH=H-T-B;const x=i=>L+(pts.length===1?plotW/2:(i*(plotW/(pts.length-1))));const y=v=>T+(100-Math.max(0,Math.min(100,Number(v)||0)))*plotH/100;const line=(field)=>pts.map((p,i)=>`${x(i).toFixed(1)},${y(p[field]).toFixed(1)}`).join(' ');const labels=pts.map((p,i)=>{const label=String(p.exam||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').slice(0,18);const xx=x(i);return `<text x="${xx}" y="${H-30}" text-anchor="middle" font-size="10" fill="#64748b" transform="rotate(-25 ${xx} ${H-30})">${label}</text>`}).join('');const grid=[0,25,50,75,100].map(v=>{const yy=y(v);return `<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" stroke="#e5e7eb"/><text x="${L-8}" y="${yy+4}" text-anchor="end" font-size="10" fill="#64748b">${v}%</text>`}).join('');const dots=(field,color)=>pts.map((p,i)=>`<circle cx="${x(i)}" cy="${y(p[field])}" r="4" fill="${color}"/>`).join('');return `<div style="margin:16px 0 18px;padding:14px 16px;border:1px solid #dbe3ee;border-radius:12px;background:#fff"><div style="font-weight:700;color:#0b2f63;margin-bottom:6px">Performance Trend — Student vs Exam Topper</div><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Performance trend chart">${grid}<polyline fill="none" stroke="#0b2f63" stroke-width="3" points="${line('studentPct')}"/><polyline fill="none" stroke="#94a3b8" stroke-width="3" stroke-dasharray="6 5" points="${line('topperPct')}"/>${dots('studentPct','#0b2f63')}${dots('topperPct','#94a3b8')}${labels}<rect x="${L}" y="8" width="12" height="3" fill="#0b2f63"/><text x="${L+18}" y="13" font-size="10" fill="#334155">Student</text><rect x="${L+90}" y="8" width="12" height="3" fill="#94a3b8"/><text x="${L+108}" y="13" font-size="10" fill="#334155">Exam Topper</text></svg></div>`;}
function searchResultUin(){const u=document.getElementById('resultUin')?.value.trim();if(!u){showToast('Enter a UIN');return;}const sel=document.getElementById('resultExamUin');const selected=[...(sel?.selectedOptions||[])].map(o=>String(o.value||'').trim()).filter(Boolean);const examNames=selected;const branchId=document.getElementById('resultUinBranch')?.value||'ALL';const metaFilters={'UIN':u,'Exam':examNames.length?examNames.join(', '):'All Exams'};if(isGAS()){google.script.run.withSuccessHandler(res=>{const rows=res?.rows||[];renderResultRows('resultUinOut',rows,{title:`Student Result Report • ${u}`,subtitle:res?.student?`${res.student.Student_Name||''} • Father: ${res.student.Father_Name||''}`:'',filters:metaFilters,individual:true,trend:res?.trend||[],topperByExam:res?.topperByExam||{}});}).withFailureHandler(err=>showToast(err.message||'Result search failed')).getResultSearch(state.session.token,{uin:u,examNames,branchId});}else{const rows=(state.demoResults||[]).filter(r=>String(r.UIN).toUpperCase()===u.toUpperCase()&&(!examNames.length||examNames.includes(String(r.Exam_Name||''))));renderResultRows('resultUinOut',rows,{title:`Student Result Report • ${u}`,subtitle:rows[0]?`${rows[0].Student_Name||''} • Father: ${rows[0].Father_Name||''}`:'',filters:metaFilters,individual:true,trend:[],topperByExam:{}});}}
function toggleAnalysisInputs(){refreshAnalysisFilters();}
function runClassResult(){const p={groupBy:'class',branchId:document.getElementById('resultClassBranch')?.value||'ALL',campusName:document.getElementById('resultClassCampus')?.value||'All',category:document.getElementById('resultClassCategory')?.value||'All',className:document.getElementById('resultClassName')?.value||'All',batchCodes:(document.getElementById('resultClassBatch')?.value||'All')==='All'?[]:[document.getElementById('resultClassBatch').value],examName:document.getElementById('resultClassExam')?.value||'All'};runResultSummary('classResultOut',p)}
function runBatchResult(){const codes=[...document.querySelectorAll('#batchChoices input:checked')].map(x=>x.value);if(!codes.length){showToast('Select at least one batch');return;}runResultSummary('batchResultOut',{groupBy:'batch',branchId:document.getElementById('resultBatchBranch')?.value||'ALL',campusName:document.getElementById('resultBatchCampus')?.value||'All',category:document.getElementById('resultBatchCategory')?.value||'All',className:document.getElementById('resultBatchClass')?.value||'All',batchCodes:codes,examName:document.getElementById('resultBatchExam')?.value||'All'})}
function runAverageAnalysis(){const scope=document.getElementById('analysisScope')?.value||'category';const key=document.getElementById('analysisKeySelect')?.value||'';if(scope==='uin'&&!key){showToast('Enter a UIN');return;}runResultSummary('analysisOut',{groupBy:scope,branchId:document.getElementById('analysisBranch')?.value||'ALL',campusName:document.getElementById('analysisCampus')?.value||'All',category:scope==='category'?key:'All',className:scope==='class'?key:'All',batchCodes:scope==='batch'?[key]:[],uin:scope==='uin'?key:'',examName:document.getElementById('analysisExam')?.value||'All'})}
function resultPercentageValue_(value){if(value===null||value===undefined||String(value).trim()==='')return null;if(typeof value==='number'&&Number.isFinite(value))return Math.abs(value)<=1?value*100:value;const raw=String(value).trim().replace(/%/g,'');if(raw==='')return null;const n=Number(raw);if(!Number.isFinite(n))return null;return Math.abs(n)<=1?n*100:n;}
function resultPercentageText_(value){const n=resultPercentageValue_(value);return n===null?'—':(Number.isInteger(n)?String(n):String(Math.round(n*100)/100))+'%';}
function resultReportFilenamePart_(value){return String(value||'').trim().replace(/[^\w.-]+/g,'_').replace(/^_+|_+$/g,'');}
let resultReportCache={};
function runResultSummary(targetId,p){if(isGAS()){google.script.run.withSuccessHandler(res=>renderResultSummary(targetId,res||{},p)).withFailureHandler(err=>showToast(err.message||'Result analysis failed')).getResultSummary(state.session.token,p);}else{showToast('Connect the Google Sheets backend to generate the live report.');}}
function resultPdfActions(targetId){return `<div class="result-pdf-actions"><button class="btn btn-secondary" onclick="saveResultReportAsPdf('${targetId}')">🖨 Save as PDF</button><button class="btn btn-primary" onclick="downloadResultReportPdf('${targetId}')">⬇ Download as PDF</button></div>`;}
function renderResultRows(id,rows,meta={}){const el=document.getElementById(id);if(!el)return;if(!rows.length){resultReportCache[id]=null;el.innerHTML='<div class="muted">No result records found for this selection.</div>';return;}const collapsed=resultCollapsedRows_(rows);const title=meta.title||'Students Result Report',subtitle=meta.subtitle||'',filters=meta.filters||{},individual=meta.individual!==false;resultReportCache[id]={type:'rows',title,subtitle,filters,rows:collapsed,individual,trend:meta.trend||[],topperByExam:meta.topperByExam||{}};const trend=meta.trend||[];const trendHtml=trend.length?resultTrendSvg_(trend):'';const cards=collapsed.map(r=>{const pct=resultPercentageText_(r.Percentage),subjects=resultApplicableSubjects_(r),subjectRows=subjects.map(sub=>`<tr><td><b>${escapeHtml(sub)}</b></td><td>${escapeHtml(String(resultSubjectMax_(r,sub)))}</td><td>${escapeHtml(String(resultSubjectValue_(r,sub)))}</td></tr>`).join('');return `<div class="card-soft" style="margin:14px 0;padding:14px 16px;border:1px solid #dbe3ee;border-radius:12px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><h4 style="margin:0;color:#0b2f63">${escapeHtml(r.Exam_Name||'Exam')}</h4><div class="muted small" style="margin-top:3px">${escapeHtml(String(r.Exam_Date||'').slice(0,10))} • ${escapeHtml(r.Category_Name||'')} • ${escapeHtml(r.Class_Name||'')} • ${escapeHtml(r.Batch_Code||'')}</div></div><div style="text-align:right"><div class="small muted">Percentage</div><div style="font-size:24px;font-weight:800;color:#0b2f63">${escapeHtml(pct)}</div></div></div><div class="table-wrap" style="margin-top:12px"><table class="data-table"><thead><tr><th>Subject</th><th>Max Marks</th><th>Obtained Marks</th></tr></thead><tbody>${subjectRows||'<tr><td colspan="3" class="muted">No subject-wise marks stored for this result.</td></tr>'}</tbody><tfoot><tr><th>Total</th><th>${escapeHtml(String(r.Total_Max_Marks??r.Max_Total_Marks??''))}</th><th>${escapeHtml(String(r.Total_Obtained_Marks??r.Total_Marks??''))}${r.Rank?` <span class="muted small" style="margin-left:8px">Rank ${escapeHtml(r.Rank)}</span>`:''}</th></tr></tfoot></table></div></div>`;}).join('');el.innerHTML=`<div class="report-header"><div><h3 style="margin:0">${escapeHtml(title)}</h3>${subtitle?`<div class="muted" style="margin-top:4px">${escapeHtml(subtitle)}</div>`:''}<div class="report-filter-line">${Object.entries(filters).map(([k,v])=>`<span><b>${escapeHtml(k)}:</b> ${escapeHtml(v||'—')}</span>`).join('')}</div></div>${resultPdfActions(id)}</div>${trendHtml}${cards}`}
function renderResultSummary(id,res,p={}){const el=document.getElementById(id);if(!el)return;const rows=res.rows||[],details=resultCollapsedRows_(res.details||[]);const title=p.groupBy==='class'?'Class Wise Result Report':p.groupBy==='batch'?'Batch Wise Result Report':'Average Result Analysis Report';const filters={};if(p.branchId&&p.branchId!=='ALL'){const br=(state.data.branches||[]).find(x=>String(x.Branch_ID)===String(p.branchId));filters['Branch']=br?.Branch_Name||p.branchId;}if(p.campusName&&p.campusName!=='All')filters['Campus']=p.campusName;if(p.category&&p.category!=='All')filters['Category']=p.category;if(p.className&&p.className!=='All')filters['Class']=p.className;if(p.batchCodes?.length)filters['Batches']=p.batchCodes.join(', ');if(p.uin)filters['UIN']=p.uin;if(p.examName&&p.examName!=='All')filters['Exam']=p.examName;resultReportCache[id]={type:'summary',title,subtitle:'AJMAL SUPER 40 • Academic Performance Report',filters,summary:res,details};const detailRows=details.map(r=>`<tr><td>${escapeHtml(r.Branch_Name||'')}</td><td><b>${escapeHtml(r.UIN||'')}</b></td><td>${escapeHtml(r.Student_Name||'')}</td><td>${escapeHtml(r.Father_Name||'')}</td><td>${escapeHtml(r.Exam_Name||'')}</td><td>${escapeHtml(String(r.Exam_Date||'').slice(0,10))}</td><td>${escapeHtml(r.Category_Name||'')}</td><td>${escapeHtml(r.Class_Name||'')}</td><td>${escapeHtml(r.Batch_Code||'')}</td><td>${resultSubjectsInline_(r)}</td><td>${escapeHtml(r.Total_Obtained_Marks??r.Total_Marks??'')} / ${escapeHtml(r.Total_Max_Marks??r.Max_Total_Marks??'')}</td><td><b>${escapeHtml(resultPercentageText_(r.Percentage))}</b></td><td>${escapeHtml(r.Rank||'—')}</td></tr>`).join('');el.innerHTML=`<div class="report-header"><div><h3 style="margin:0">${escapeHtml(title)}</h3><div class="muted" style="margin-top:4px">AJMAL SUPER 40 • Academic Performance Report</div><div class="report-filter-line">${Object.entries(filters).map(([k,v])=>`<span><b>${escapeHtml(k)}:</b> ${escapeHtml(v||'—')}</span>`).join('')}</div></div>${resultPdfActions(id)}</div><div class="grid grid-4" style="margin-bottom:14px"><div class="card kpi"><div class="metric-label">Records</div><div class="metric">${Number(res.totalRecords||0).toLocaleString()}</div></div><div class="card kpi"><div class="metric-label">Overall Average</div><div class="metric">${res.overallAverage==null?'—':res.overallAverage+'%'}</div></div></div>${rows.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Group</th><th>Records</th><th>Average %</th><th>Highest %</th><th>Lowest %</th></tr></thead><tbody>${rows.map(r=>`<tr><td><b>${escapeHtml(r.group)}</b></td><td>${r.students}</td><td>${r.average==null?'—':r.average+'%'}</td><td>${r.highest==null?'—':r.highest+'%'}</td><td>${r.lowest==null?'—':r.lowest+'%'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="muted">No aggregate data available for this selection.</div>'}${details.length?`<div style="margin-top:16px"><h4 style="margin:0 0 8px">Detailed Student Result Records</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>Branch</th><th>UIN</th><th>Student Name</th><th>Father's Name</th><th>Exam</th><th>Date</th><th>Category</th><th>Class</th><th>Batch</th><th>Applicable Subjects</th><th>Total</th><th>Percentage</th><th>Rank</th></tr></thead><tbody>${detailRows}</tbody></table></div></div>`:'<div class="muted" style="margin-top:16px">No detailed student records available.</div>'}`}
function saveResultReportAsPdf(id){const report=resultReportCache[id];if(!report){showToast('Generate a report first.');return;}const w=window.open('','_blank');if(!w){showToast('Please allow pop-ups to print the report.');return;}w.document.open();w.document.write(buildPrintableResultHtml(report));w.document.close();w.focus();setTimeout(()=>w.print(),500);}
function downloadResultReportPdf(id){const report=resultReportCache[id];if(!report){showToast('Generate a report first.');return;}if(!isGAS()){saveResultReportAsPdf(id);return;}showToast('Preparing PDF…');google.script.run.withSuccessHandler(res=>{if(!res?.ok||!res.base64){showToast(res?.message||'PDF generation failed.');return;}try{const raw=atob(res.base64),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);const blob=new Blob([bytes],{type:'application/pdf'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=res.filename||'AJMAL_Result_Report.pdf';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);showToast('PDF downloaded successfully.');}catch(e){showToast('PDF was generated but could not be downloaded: '+(e.message||e));}}).withFailureHandler(err=>showToast(err?.message||'PDF generation failed')).generateResultPdf(state.session.token,report);}
function buildPrintableResultHtml(report){const filters=Object.entries(report.filters||{}).map(([k,v])=>`<span style="margin-right:16px"><b>${escapeHtml(k)}:</b> ${escapeHtml(v||'—')}</span>`).join('');const details=report.type==='rows'?report.rows:(report.details||[]),agg=report.type==='summary'?(report.summary?.rows||[]):[],individual=report.type==='rows'&&!!(report.individual||report.filters?.UIN),identity=individual&&details.length?details[0]:null,identityUin=identity?.UIN||report.filters?.UIN||'',identityStudent=identity?.Student_Name||'',identityFather=identity?.Father_Name||'';const trend=(report.trend||[]).slice(0,20),safeFileBase=individual?[identityUin,identityStudent,identityFather].map(resultReportFilenamePart_).filter(Boolean).join('_'):resultReportFilenamePart_(report.title||'AJMAL_Result_Report');const graph=individual&&trend.length?resultTrendSvg_(trend):'';const identityHtml=identity?`<div class="identity-wrap"><table class="identity"><thead><tr><th>UIN</th><th>Student Name</th><th>Father's Name</th></tr></thead><tbody><tr><td><b>${escapeHtml(identityUin)}</b></td><td>${escapeHtml(identityStudent)}</td><td>${escapeHtml(identityFather)}</td></tr></tbody></table></div>`:'';let body='';if(individual){body=details.map(r=>{const subjects=resultApplicableSubjects_(r),sh=subjects.map(x=>`<th>${escapeHtml(x)} Max</th><th>${escapeHtml(x)} Obt.</th>`).join(''),sv=subjects.map(x=>`<td>${escapeHtml(String(resultSubjectMax_(r,x)))}</td><td>${escapeHtml(String(resultSubjectValue_(r,x)))}</td>`).join('');return `<section class="exam-card"><div class="exam-head"><div><h2>${escapeHtml(r.Exam_Name||'Exam')}</h2><div>${escapeHtml(String(r.Exam_Date||'').slice(0,10))} • ${escapeHtml(r.Category_Name||'')} • ${escapeHtml(r.Class_Name||'')} • ${escapeHtml(r.Batch_Code||'')}</div></div><div class="score"><small>Percentage</small><strong>${escapeHtml(resultPercentageText_(r.Percentage))}</strong></div></div><table class="subject-table"><thead><tr><th>Subject</th><th>Max</th><th>Obtained</th>${subjects.map(x=>'' ).join('')}</tr></thead><tbody>${subjects.map(x=>`<tr><td><b>${escapeHtml(x)}</b></td><td>${escapeHtml(String(resultSubjectMax_(r,x)))}</td><td>${escapeHtml(String(resultSubjectValue_(r,x)))}</td></tr>`).join('')}</tbody></table><div class="exam-total"><b>Total:</b> ${escapeHtml(String(r.Total_Obtained_Marks??r.Total_Marks??''))} / ${escapeHtml(String(r.Total_Max_Marks??r.Max_Total_Marks??''))} &nbsp;&nbsp; <b>Rank:</b> ${escapeHtml(String(r.Rank||'—'))}</div></section>`;}).join('');}else{const detailRows=details.map(r=>`<tr><td>${escapeHtml(r.UIN||'')}</td><td>${escapeHtml(r.Student_Name||'')}</td><td>${escapeHtml(r.Father_Name||'')}</td><td>${escapeHtml(r.Exam_Name||'')}</td><td>${escapeHtml(String(r.Exam_Date||'').slice(0,10))}</td><td>${escapeHtml(r.Category_Name||'')}</td><td>${escapeHtml(r.Class_Name||'')}</td><td>${escapeHtml(r.Batch_Code||'')}</td><td>${resultSubjectsInline_(r)}</td><td>${escapeHtml(String(r.Total_Obtained_Marks??r.Total_Marks??''))} / ${escapeHtml(String(r.Total_Max_Marks??r.Max_Total_Marks??''))}</td><td>${escapeHtml(resultPercentageText_(r.Percentage))}</td><td>${escapeHtml(r.Rank||'—')}</td></tr>`).join('');body=`<table class="summary-table"><thead><tr><th>Group</th><th>Records</th><th>Average %</th><th>Highest %</th><th>Lowest %</th></tr></thead><tbody>${agg.map(r=>`<tr><td><b>${escapeHtml(r.group)}</b></td><td>${r.students}</td><td>${r.average==null?'—':r.average+'%'}</td><td>${r.highest==null?'—':r.highest+'%'}</td><td>${r.lowest==null?'—':r.lowest+'%'}</td></tr>`).join('')}</tbody></table>${details.length?`<h2 class="section-title">Detailed Student Result Records</h2><table class="detail-table"><thead><tr><th>UIN</th><th>Student</th><th>Father</th><th>Exam</th><th>Date</th><th>Category</th><th>Class</th><th>Batch</th><th>Applicable Subjects</th><th>Total</th><th>%</th><th>Rank</th></tr></thead><tbody>${detailRows}</tbody></table>`:''}`;}return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(safeFileBase||'AJMAL_Result_Report')}</title><style>@page{size:A4 portrait;margin:12mm 10mm 12mm}body{font-family:Arial,Helvetica,sans-serif;color:#172033;font-size:9.5px;line-height:1.35;margin:0}.brand{text-align:center;border-bottom:2px solid #0b2f63;padding-bottom:6px;margin-bottom:10px}.brand-title{font-weight:800;color:#0b2f63;font-size:18px;letter-spacing:.2px}.brand-sub{color:#64748b;font-size:9px}.filters{margin:7px 0 11px;padding:7px 9px;border:1px solid #dbe3ee;background:#f7fafc;border-radius:6px}.identity,.summary-table,.detail-table,.subject-table{width:100%;border-collapse:collapse}.identity th,.identity td,.summary-table th,.summary-table td,.detail-table th,.detail-table td,.subject-table th,.subject-table td{border:1px solid #cfd7e3;padding:5px 6px;vertical-align:top}.identity th,.summary-table th,.detail-table th,.subject-table th{background:#0b2f63;color:#fff;font-weight:700}.identity{margin:8px 0 12px}.exam-card{border:1px solid #dbe3ee;border-radius:8px;padding:10px 11px;margin:10px 0;page-break-inside:avoid}.exam-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:8px}.exam-head h2{font-size:13px;color:#0b2f63;margin:0 0 3px}.exam-head div{color:#64748b}.score{text-align:right}.score small{display:block;color:#64748b}.score strong{font-size:18px;color:#0b2f63}.exam-total{margin-top:8px;padding:7px 8px;background:#f7fafc;border-radius:5px}.section-title{font-size:13px;color:#0b2f63;margin:12px 0 7px}.detail-table{font-size:7.4px}.detail-table th,.detail-table td{padding:4px}.footer{margin-top:10px;color:#64748b;font-size:8px;text-align:center}.graph{margin:8px 0 12px}</style></head><body><div class="brand"><div class="brand-title">AJMAL SUPER 40</div><div class="brand-sub">Academic Performance Report</div></div><h1 style="color:#0b2f63;font-size:18px;margin:0 0 3px">Student Result Report</h1>${individual?`<div style="color:#64748b;font-size:9px;margin-bottom:8px">${escapeHtml(report.subtitle||'UIN-wise academic performance')}</div>`:`<div class="filters">${filters||'All Records'}</div>`}${identityHtml}${graph?`<div class="graph">${graph}</div>`:''}${body}<div class="footer">Generated from AJMAL SUPER 40 Student Operations ERP</div></body></html>`;}
function filterBatchChoices(q){const query=String(q||'').toLowerCase();document.querySelectorAll('#batchChoices .choice-pill').forEach(el=>{el.style.display=el.textContent.toLowerCase().includes(query)?'flex':'none';});}
function handleResultDrop(ev){ev.preventDefault();ev.currentTarget.classList.remove('dragover');const f=ev.dataTransfer.files?.[0];if(f)handleResultFile(f)}
function handleResultFile(file){
  if(!requireResultUploadAccess()||!file)return;
  const uploadCategory=document.getElementById('resultUploadCategory')?.value||'';
  const ext=(file.name.split('.').pop()||'').toLowerCase();
  if(!['csv','xlsx','xls'].includes(ext)){showToast('Please choose CSV or Excel result file');return;}
  if(ext==='csv'){
    const reader=new FileReader();
    reader.onload=()=>prepareResultImport(parseCsvText(reader.result),file.name,uploadCategory);
    reader.readAsText(file);
  }else{
    if(typeof XLSX==='undefined'){showToast('Excel reader is unavailable.');return;}
    const reader=new FileReader();
    reader.onload=e=>{try{
      const wb=XLSX.read(e.target.result,{type:'array'});
      const ws=wb.Sheets[wb.SheetNames[0]];
      prepareResultImport(XLSX.utils.sheet_to_json(ws,{defval:'',raw:false}),file.name,uploadCategory);
    }catch(err){showToast('Could not read result Excel file: '+err.message)}};
    reader.readAsArrayBuffer(file);
  }
}
function normalizeResultRows(rows){const aliases={UIN:['uin','student_uin'],Exam_ID:['exam_id','test_id','exam_code'],Exam_Name:['exam_name','exam','test_name','mock_test'],Exam_Date:['exam_date','test_date','date'],Programme:['programme','program'],Class_Name:['class_name','class','standard'],Category_Name:['category_name','category'],Batch_Code:['batch_code','batch','batch_name'],Campus_Name:['campus_name','campus','location'],Branch_ID:['branch_id','branch','institute_branch'],Branch_Name:['branch_name','branch_title'],Subject_Name:['subject_name','subject'],Subject_Marks:['subject_marks','marks_obtained','marks'],Max_Subject_Marks:['max_subject_marks','subject_max_marks'],Physics_Marks:['physics_marks','physics'],Chemistry_Marks:['chemistry_marks','chemistry'],Botany_Marks:['botany_marks','botany'],Zoology_Marks:['zoology_marks','zoology'],Biology_Marks:['biology_marks','biology'],Maths_Marks:['maths_marks','math_marks','mathematics_marks','mathematics'],Mathematics_Marks:['mathematics_marks','mathematics'],Total_Obtained_Marks:['total_obtained_marks','obtained_total','total_marks','total','marks_total','score'],Total_Max_Marks:['total_max_marks','max_total_marks','max_marks','maximum_marks','total_max'],Percentage:['percentage','percent','percentage_score'],Rank:['rank','air','overall_rank'],Result_Status:['result_status','status']};return rows.map(src=>{const norm={};Object.keys(src).forEach(k=>norm[normalizeHeader(k)]=src[k]);const out={};Object.entries(aliases).forEach(([dest,als])=>{const hit=als.find(a=>Object.prototype.hasOwnProperty.call(norm,a));if(hit)out[dest]=dest==='UIN'?normalizeUIN(norm[hit]):String(norm[hit]).trim();});Object.keys(src).forEach(k=>{const nk=normalizeHeader(k);if(!Object.values(aliases).flat().includes(nk))out['EXTRA_'+k]=src[k];});return out;})}
function prepareResultImport(rawRows,fileName,uploadCategory=''){
  const rows=normalizeResultRows(rawRows);
  const category=String(uploadCategory||'').trim();
  const errors=[];
  const seen=new Set();
  rows.forEach((r,i)=>{
    if(category) r.Category_Name=category;
    if(!r.UIN)errors.push(`Row ${i+2}: UIN missing`);
    else if(!/^\d{10}$/.test(String(r.UIN).trim()))errors.push(`Row ${i+2}: UIN must be exactly 10 digits (found: ${String(r.UIN).trim()})`);
    if(!r.Exam_Name)errors.push(`Row ${i+2}: Exam_Name missing`);
    const key=String(r.UIN||'').trim().toUpperCase()+'|'+String(r.Exam_ID||r.Exam_Name).trim().toUpperCase()+'|'+String(r.Subject_Name||'').trim().toUpperCase();
    if(seen.has(key))errors.push(`Row ${i+2}: duplicate result key`);
    seen.add(key);
  });
  resultImportRows=rows;
  resultImportHeaders=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  const el=document.getElementById('resultImportPreview');
  if(!el)return;
  el.innerHTML=`<div class="import-preview"><div class="section-title" style="margin:0 0 10px"><div><b>${escapeHtml(fileName)}</b><div class="muted">${rows.length.toLocaleString()} records${category?` • ${escapeHtml(category)} upload scope`:''}</div></div><span class="badge ${errors.length?'badge-red':'badge-green'}">${errors.length?errors.length+' errors':'Ready to import'}</span></div>${errors.length?`<div class="alert alert-danger">${errors.slice(0,8).map(escapeHtml).join('<br>')}</div>`:''}<div class="table-wrap"><table class="data-table"><thead><tr>${resultImportHeaders.slice(0,16).map(h=>`<th>${escapeHtml(h.replace(/^EXTRA_/,'').replace(/_/g,' '))}</th>`).join('')}</tr></thead><tbody>${rows.slice(0,8).map(r=>`<tr>${resultImportHeaders.slice(0,16).map(h=>`<td>${escapeHtml(r[h]??'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${!errors.length?`<div class="toolbar" style="margin-top:12px"><button class="btn btn-primary" onclick="confirmResultImport('${escapeAttr(fileName)}')">Import ${rows.length.toLocaleString()} Results</button><button class="btn btn-secondary" onclick="document.getElementById('resultImportPreview').innerHTML=''">Cancel</button></div>`:''}</div>`;
}
function confirmResultImport(fileName) {
  if (!state.resultUploadProof) {
    showToast('Please unlock Result Upload again.');
    return;
  }

  const proof = state.resultUploadProof;
  const rowsToImport = resultImportRows.slice();

  if (!rowsToImport.length) {
    showToast('No result rows are ready to import.');
    return;
  }

  if (isGAS()) {
    showToast('Importing results…');

    google.script.run
      .withSuccessHandler(res => {
        resultImportRows = [];
        const preview = document.getElementById('resultImportPreview');
        if (preview) preview.innerHTML = '';
        state.resultUploadProof = '';

        syncAfterImport_(res, 'results', () => {
          loadResultOptions();

          showToast(
            `Result import synchronized • ${Number(res.inserted || 0)} inserted • ` +
            `${Number(res.updated || 0)} updated`
          );

          if (Number(res.verifiedCount || 0) === 0) {
            setTimeout(() => showToast(
              'Warning: server verification found 0 Result records.'
            ), 2400);
          }
        }, {force:true, preserveInputs:false});
      })
      .withFailureHandler(err => {
        showToast(err.message || 'Result import failed');
      })
      .importResults(
        state.session.token,
        proof,
        {rows: rowsToImport, sourceFile: fileName, uploadCategory: document.getElementById('resultUploadCategory')?.value||''}
      );
  } else {
    showToast('Result import requires the Google Sheets backend.');
  }
}

function formatDate(d){try{return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}catch(e){return d}}
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)}
