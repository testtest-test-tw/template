/* =====================================================================
   選屋系統 · 後台
   資料存在 Supabase；規則檢查在資料庫端（save_owner / save_group）再做一次，
   畫面上的試算只是即時提示。
   ===================================================================== */
const C = window.APP_CONFIG || {};
const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const fmt = n => Math.round(Number(n) || 0).toLocaleString('zh-TW');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fnum = f => { const m = String(f).match(/^B(\d+)$/); return m ? -+m[1] : parseInt(f); };
const pad3 = n => String(n).padStart(3, '0');
const todayStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const tstr = t => new Date(t).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const DSTATE = ['待收', '收到紙本', '已歸檔'];

/* ---------- 狀態 ---------- */
let ME = { email: '', role: 'staff', name: '' };
let SET = {}, O = [], ON = {}, G = [], UINFO = {}, PINFO = {}, UP = {}, R = new Set(), STAFF = [], ANN = [];
let DOCS = [];
const V = { view: 'owners', filter: 'all', q: '', drawer: null, ov: null };
const isAdmin = () => ME.role === 'admin';
const isUnit = c => c in UINFO;

/* ---------- 共用 UI ---------- */
function busy(on, t) { $('#busy').hidden = !on; if (t) $('#busy-t').textContent = t; }
let tt; function toast(m) { let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); } t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 3200); }
function confirmBox(msg, ok, okLabel = '確認') {
  const root = $('#modal-root');
  root.innerHTML = `<div class="scrim" id="scrim"><div class="modal narrow" role="alertdialog" aria-modal="true"><p style="font-size:15px;margin:0 0 6px">${msg}</p><div class="mf"><button class="btn" id="cx">取消</button><button class="btn pri" id="cy">${okLabel}</button></div></div></div>`;
  $('#cx').onclick = () => root.innerHTML = ''; $('#cy').onclick = () => { root.innerHTML = ''; ok(); };
}
function closeModal() { $('#modal-root').innerHTML = ''; }
async function rpc(fn, args) { const { data, error } = await sb.rpc(fn, args); if (error) throw new Error(error.message); return data; }

/* ---------- 登入 ---------- */
async function boot() {
  if (!C.SUPABASE_URL || C.SUPABASE_URL.includes('YOUR-')) { document.body.innerHTML = '<p style="padding:24px">尚未設定資料庫連線：請編輯 config.js。</p>'; return; }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return showLogin();
  await enter(session);
}
function showLogin(msg) {
  $('#app').hidden = true; $('#login').hidden = false; $('#lg-err').textContent = msg || '';
  $('#login-form').onsubmit = async e => {
    e.preventDefault(); $('#lg-btn').disabled = true; $('#lg-err').textContent = '';
    const { data, error } = await sb.auth.signInWithPassword({ email: $('#lg-email').value.trim(), password: $('#lg-pw').value });
    $('#lg-btn').disabled = false;
    if (error) { $('#lg-err').textContent = 'Email 或密碼不正確'; return; }
    await enter(data.session);
  };
}
async function enter(session) {
  const email = session.user.email;
  const ok = await rpc('is_staff').catch(() => false);
  if (!ok) { await sb.auth.signOut(); return showLogin(`${email} 不在選屋人員名單中，請管理員到「案件設定 → 人員與權限」加入。`); }
  const { data: me } = await sb.from('staff').select('*').ilike('email', email).maybeSingle();
  ME = { email, role: me?.role || 'staff', name: me?.name || email };
  $('#login').hidden = true; $('#app').hidden = false;
  $('#who').textContent = `${ME.name || ME.email} · ${isAdmin() ? '管理員' : '選屋人員'}`;
  await loadAll();
  subscribe();
  render();
}
$('#logout').onclick = async () => { await sb.auth.signOut(); location.reload(); };

/* ---------- 讀取資料 ---------- */
async function all(table, sel = '*', order) {
  let out = [], from = 0;
  for (;;) {
    let q = sb.from(table).select(sel).range(from, from + 999);
    if (order) q = q.order(order);
    const { data, error } = await q; if (error) throw new Error(table + '：' + error.message);
    out = out.concat(data); if (data.length < 1000) return out; from += 1000;
  }
}
async function loadAll() {
  const [settings, owners, units, parking, picks, groups, members, docs, staff, ann] = await Promise.all([
    all('settings'), all('owners', '*', 'no'), all('units', '*', 'sort'), all('parking', '*', 'sort'), all('picks', '*', 'id'),
    all('merge_groups', '*', 'id'), all('merge_members'), all('documents'), all('staff'), all('announcements', '*', 'id')]);
  SET = Object.fromEntries(settings.map(s => [s.key, s.value]));
  DOCS = SET.docs || [];
  UINFO = {}; PINFO = {}; UP = {}; R = new Set();
  units.forEach(u => { UINFO[u.code] = u; UP[u.code] = +u.price; if (!u.open) R.add(u.code); });
  parking.forEach(p => { PINFO[p.code] = p; UP[p.code] = +p.price; if (!p.open) R.add(p.code); });
  O = owners.map(o => ({
    no: o.no, name: o.name, agent: o.agent, value: +o.value, st: o.participation, formal: o.sel_formal,
    u: [], p: [], docs: DOCS.map(() => 0), files: DOCS.map(() => null), date: o.sel_date || '', phone: o.phone, addr: o.address, idno: o.id_no,
    note: o.note, over: o.over_approved, noMerge: o.no_merge, store: o.store_priority, redo: o.redo, updated: o.updated_at, by: o.updated_by
  }));
  ON = {}; O.forEach(o => ON[o.no] = o);
  G = groups.map(g => ({ id: g.id, m: [], u: [], p: [], over: g.over_approved }));
  const GI = {}; G.forEach(g => GI[g.id] = g);
  members.forEach(m => GI[m.group_id] && GI[m.group_id].m.push([m.owner_no, +m.amount]));
  picks.forEach(p => {
    const t = p.owner_no != null ? ON[p.owner_no] : GI[p.group_id]; if (!t) return;
    (p.kind === 'unit' ? t.u : t.p).push(p.code);
  });
  docs.forEach(d => { const o = ON[d.owner_no]; if (o && d.doc_idx < o.docs.length) { o.docs[d.doc_idx] = d.state; o.files[d.doc_idx] = d.file_url ? { url: d.file_url, name: d.file_name } : null; } });
  STAFF = staff; ANN = ann.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id);
  $('#case-name').textContent = SET.short_name || '';
  $('#test-flag').hidden = !SET.test_mode;
  document.title = (SET.short_name || '') + ' 選屋後台';
  if (!V.ov) V.ov = towers()[0] || 'P';
}
let reloadT;
function subscribe() {
  sb.channel('db').on('postgres_changes', { event: '*', schema: 'public' }, () => {
    clearTimeout(reloadT);
    reloadT = setTimeout(async () => { if ($('#modal-root').innerHTML) return; await loadAll(); render(); }, 700);
  }).subscribe();
}
async function refresh() { await loadAll(); render(); }

/* ---------- 計算 ---------- */
const CAP = () => Number(SET.cap_ratio || 1.1);
const MIN = () => Number(SET.min_unit_value || 0);
const PPU = () => Number(SET.park_per_unit || 1);
const cap = o => Math.round(o.value * CAP());
const own = o => o.u.concat(o.p).reduce((s, c) => s + (UP[c] || 0), 0);
const groupsOf = no => G.filter(g => g.m.some(m => m[0] === no));
const contrib = o => groupsOf(o.no).reduce((s, g) => s + g.m.find(m => m[0] === o.no)[1], 0);
const used = o => own(o) + contrib(o);
const zb = o => used(o) - o.value;
const gtotal = g => g.u.concat(g.p).reduce((s, c) => s + (UP[c] || 0), 0);
function claims() {
  const m = {};
  O.forEach(o => { if (o.st !== '參與') return; o.u.concat(o.p).forEach(c => (m[c] = m[c] || []).push({ k: 'o', no: o.no, formal: o.formal })); });
  G.forEach(g => g.u.concat(g.p).forEach(c => (m[c] = m[c] || []).push({ k: 'g', id: g.id, formal: true })));
  return m;
}
function need(o) {
  const inG = groupsOf(o.no).length > 0;
  return DOCS.map((d, i) => [d, i]).filter(([d]) => d.applies === 'all' || (d.applies === 'participate' && o.st !== '不參與') || (d.applies === 'merge' && inG)).map(([, i]) => i);
}
const docsOk = o => need(o).every(i => o.docs[i] === 2);
const docCount = o => { const n = need(o); return [n.filter(i => o.docs[i] === 2).length, n.length]; };
const hasSel = o => o.u.length + o.p.length > 0 || groupsOf(o.no).length > 0;
const claimName = c => c.k === 'o' ? ON[c.no].name : '合併組（' + G.find(g => g.id === c.id).m.map(m => ON[m[0]].name).join('、') + '）';
function status(o, CL) {
  if (o.st === '不參與') return ['不參與權變', 'b-mute'];
  if (o.redo && !o.u.length) return ['需重選', 'b-bad'];
  if (!hasSel(o)) return o.value < MIN() ? ['未達最小單元', 'b-warn'] : ['尚未選屋', 'b-acc'];
  const codes = o.u.concat(o.p).concat(groupsOf(o.no).flatMap(g => g.u.concat(g.p)));
  if (codes.some(c => (CL[c] || []).length > 1)) return ['重複', 'b-bad'];
  if (own(o) > cap(o)) return o.over ? ['已核准超選', 'b-warn'] : ['超選', 'b-bad'];
  if (!o.formal && o.u.length + o.p.length) return ['草稿', 'b-warn'];
  if (groupsOf(o.no).length && !o.u.length) return ['合併已選', 'b-ok'];
  return ['已選', 'b-ok'];
}
const towers = () => [...new Set(Object.values(UINFO).filter(u => u.use === '住宅').map(u => u.unit.replace(/\d+$/, '')))].sort();
const hasShops = () => Object.values(UINFO).some(u => u.use !== '住宅');
const typesOf = k => [...new Set(Object.values(UINFO).filter(u => k === 'SHOP' ? u.use !== '住宅' : u.use === '住宅' && u.unit.replace(/\d+$/, '') === k).map(u => u.unit))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const floorsOf = k => [...new Set(Object.values(UINFO).filter(u => k === 'SHOP' ? u.use !== '住宅' : u.use === '住宅' && u.unit.replace(/\d+$/, '') === k).map(u => u.floor))].sort((a, b) => fnum(b) - fnum(a));
const pfloors = () => [...new Set(Object.values(PINFO).map(p => p.floor))].sort((a, b) => fnum(a) - fnum(b));
const areaTabs = () => towers().map(t => [t, t + ' 棟']).concat(hasShops() ? [['SHOP', '店鋪']] : []).concat(Object.keys(PINFO).length ? [['P', '車位']] : []);

/* ---------- 編號簡寫 ---------- */
function norm(t) {
  t = t.trim().toUpperCase().replace(/\s/g, ''); if (!t) return null;
  if (t in UP) return t;
  let m = t.match(/^0?(\d{1,2})F?-?([A-Z])(\d{1,2})$/); if (m) { const c = `${+m[1]}F-${m[2]}${+m[3]}`; if (c in UP) return c; }
  m = t.match(/^B(\d)-?(\d{1,3})$/); if (m) { const c = `B${m[1]}-${+m[2]}`; if (c in UP) return c; }
  return t;
}
const parse = s => [...new Set(s.split(/[,，、\s]+/).map(norm).filter(Boolean))];

function validate({ units, parks, value, capv, selfNo, groupId, agreed, st, formal = true }) {
  const E = [], W = [], CL = claims(), all = units.concat(parks);
  all.forEach(c => { if (!(c in UP)) E.push(`找不到「${c}」，請確認編號（戶別如 9F-B9，車位如 B5-57）`); });
  units.forEach(c => { if (c in PINFO) E.push(`${c} 是車位，請填在「車位」欄`); });
  parks.forEach(c => { if (c in UINFO) E.push(`${c} 是房屋，請填在「戶別」欄`); });
  all.forEach(c => { if (R.has(c)) E.push(`${c} 為保留戶，不開放選配`); });
  if (parks.length > units.length * PPU()) E.push(`一戶房屋最多搭配 ${PPU()} 個車位：目前 ${units.length} 戶、${parks.length} 個車位`);
  all.forEach(c => {
    const o = (CL[c] || []).filter(x => !(x.k === 'o' && x.no === selfNo) && !(x.k === 'g' && x.id === groupId));
    if (o.length) (SET.dup_mode === 'block' ? E : W).push(`${c} 已被 ${o.map(claimName).join('、')} 選配${SET.dup_mode === 'block' ? '' : '，登錄後會標為「重複待抽籤」'}`);
  });
  const total = all.reduce((s, c) => s + (UP[c] || 0), 0);
  if (formal && st === '參與' && total > capv) {
    const mode = SET.over_cap_mode || 'approve';
    if (mode === 'block') E.push(`超過選配上限 NT$${fmt(total - capv)}`);
    else if (mode === 'approve' && !agreed) E.push(`超過選配上限 NT$${fmt(total - capv)}。依選配說明，超出上限須先與實施者達成協議，請由管理員勾選下方確認`);
    else W.push(mode === 'allow' ? '超過選配上限，會標示為「超選」' : '已註記與實施者達成協議，允許超出上限');
  }
  if (formal && st === '參與' && selfNo && value < MIN() && all.length) E.push(`應分配權利價值未達最小分配單元（${fmt(MIN())} 元），不能單獨選配，請改用「合併管理」`);
  return { E, W, total };
}

/* ---------- 版面 ---------- */
const IC = {
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4v2h6V4M9 11h6M9 15h4"/></svg>',
  merge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5M15 14c3 0 6 1.5 6 4.5"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>',
  dice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/></svg>',
  coin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5v11"/></svg>',
  mega: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 10v4h3l7 4V6L7 10z"/><path d="M17 9c1 1 1 5 0 6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>'
};
const NAV = [['h', '選配作業'], ['owners', '地主清單', 'list'], ['merge', '合併管理', 'merge'], ['overview', '選屋總覽', 'grid'], ['lottery', '重複與抽籤', 'dice'], ['docs', '文件歸檔', 'doc'], ['h', '報表'], ['zb', '找補彙總與匯出', 'coin'], ['h', '前台'], ['ann', '公告管理', 'mega']];
function renderNav() {
  const CL = claims(); const dupN = Object.values(CL).filter(v => v.length > 1).length;
  $('#nav').innerHTML = NAV.map(n => n[0] === 'h' ? `<p class="navh">${n[1]}</p>` : `<button data-v="${n[0]}" ${V.view === n[0] ? 'aria-current="page"' : ''}>${IC[n[2]]}${n[1]}${n[0] === 'lottery' && dupN ? `<span class="cnt">${dupN}</span>` : ''}</button>`).join('');
  $('#nav2').innerHTML = `<button data-open="1">${IC.ext}開啟前台</button>` + (isAdmin() ? `<button data-v="import" ${V.view === 'import' ? 'aria-current="page"' : ''}>${IC.up}匯入資料</button><button data-v="settings" ${V.view === 'settings' ? 'aria-current="page"' : ''}>${IC.gear}案件設定</button>` : '');
  $$('nav [data-v]').forEach(b => b.onclick = () => { V.view = b.dataset.v; V.drawer = null; $('#side').classList.remove('show'); render(); });
  $('[data-open]').onclick = () => window.open('./', '_blank');
  const done = O.filter(o => o.st === '不參與' || (o.st === '參與' && hasSel(o) && (o.formal || !o.u.length))).length;
  $('#p-done').textContent = `${done} / ${O.length}`; $('#p-bar').style.width = (O.length ? done / O.length * 100 : 0) + '%';
  $('#p-dup').textContent = dupN; $('#p-doc').textContent = O.filter(o => o.st !== '未申請' && !docsOk(o)).length;
}
function render() {
  renderNav();
  const f = { owners: vOwners, merge: vMerge, overview: vOverview, lottery: vLottery, docs: vDocs, zb: vZb, settings: vSettings, ann: vAnn, import: vImport }[V.view] || vOwners;
  f(); renderDrawer();
}

/* ---------- 地主清單 ---------- */
const FILTERS = [['all', '全部'], ['done', '已完成選屋'], ['none', '尚未選屋'], ['doc', '收件未齊'], ['dup', '重複'], ['over', '超選'], ['draft', '草稿'], ['low', '未達最小單元'], ['np', '不參與權變'], ['store', '店面優先']];
function match(o, f, CL) {
  const s = status(o, CL)[0];
  return f === 'all' || (f === 'done' && ['已選', '合併已選', '已核准超選'].includes(s)) || (f === 'none' && ['尚未選屋', '需重選'].includes(s)) || (f === 'doc' && o.st !== '未申請' && !docsOk(o)) || (f === 'dup' && s === '重複') || (f === 'over' && ['超選', '已核准超選'].includes(s)) || (f === 'draft' && s === '草稿') || (f === 'low' && o.value < MIN()) || (f === 'np' && o.st === '不參與') || (f === 'store' && o.store);
}
function vOwners() {
  const CL = claims();
  const cnt = Object.fromEntries(FILTERS.map(([k]) => [k, O.filter(o => match(o, k, CL)).length]));
  const q = V.q.trim();
  const rows = O.filter(o => match(o, V.filter, CL) && (!q || o.name.includes(q) || String(o.no) === q || o.u.concat(o.p).some(c => c.includes(q.toUpperCase()))));
  $('#main').innerHTML = `
  <div class="ph"><h1>地主清單</h1><input class="search" id="q" placeholder="搜尋姓名、編號或戶別…" value="${esc(V.q)}"><button class="btn sm" id="rl">重新整理</button><span class="updated">其他人員的登錄會自動同步</span></div>
  <div class="stats">
    <div class="stat"><div class="n">${O.length}</div><div class="l">地主總數</div></div>
    <div class="stat ok"><div class="n">${cnt.done}</div><div class="l">已完成選屋</div></div>
    <div class="stat"><div class="n">${cnt.none}</div><div class="l">尚未選屋</div></div>
    <div class="stat bad"><div class="n">${cnt.dup}</div><div class="l">重複待抽籤</div></div>
    <div class="stat warn"><div class="n">${cnt.doc}</div><div class="l">收件未齊</div></div>
    <div class="stat"><div class="n">${cnt.np}</div><div class="l">不參與權變</div></div>
  </div>
  <div class="chips">${FILTERS.filter(([k]) => k !== 'store' || cnt.store).map(([k, l]) => `<button class="chip" data-f="${k}" aria-pressed="${V.filter === k}">${l}<b>${cnt[k]}</b></button>`).join('')}</div>
  <div class="tbl">
    <div class="tr th"><span>編號</span><span>地主</span><span>權值 ／ 上限 ／ 已用</span><span>狀態</span><span>收件</span><span></span></div>
    ${rows.map(o => {
      const [s, c] = status(o, CL); const [a, b] = docCount(o); const z = zb(o); const gs = groupsOf(o.no);
      const codes = o.u.concat(o.p); const gcodes = gs.flatMap(g => g.u.concat(g.p));
      return `<div class="tr ${V.drawer === o.no ? 'on' : ''}" data-no="${o.no}" tabindex="0">
      <span class="num sub">${o.no}</span>
      <span><div class="nm">${esc(o.name)}${o.agent ? ` <span class="sub">（委託 ${esc(o.agent)}）</span>` : ''}${o.store ? ' <span class="badge b-acc">店面優先</span>' : ''}</div><div class="sel">${codes.join('、') || (gcodes.length ? '<span class="sub">合併：</span>' + gcodes.join('、') : '<span class="sub">—</span>')}</div></span>
      <span><div class="money3"><span>權值</span><span>上限</span><span>已用</span><b>${fmt(o.value)}</b><b>${fmt(cap(o))}</b><b>${used(o) ? fmt(used(o)) : '—'}</b></div>
      ${used(o) ? `<div class="zb ${z > 0 ? 'pay' : 'ret'}">找補 ${z > 0 ? '補' : '退'} NT$${fmt(Math.abs(z))}</div>` : ''}</span>
      <span><span class="badge ${c}">${s}</span></span>
      <span class="docn ${o.st === '未申請' ? '' : a === b ? 'ok' : 'no'}">${o.st === '未申請' ? '<span class="sub">—</span>' : a + '/' + b}</span>
      <span class="chev">›</span></div>`;
    }).join('') || '<div class="tr" style="cursor:default"><span></span><span class="sub">沒有符合的地主</span></div>'}
  </div>`;
  const q2 = $('#q'); q2.oninput = e => { V.q = e.target.value; const p = q2.selectionStart; vOwners(); const n = $('#q'); n.focus(); n.setSelectionRange(p, p); };
  $('#rl').onclick = async () => { busy(true, '重新整理…'); await refresh().finally(() => busy(false)); };
  $$('.chip').forEach(b => b.onclick = () => { V.filter = b.dataset.f; vOwners(); });
  $$('.tr[data-no]').forEach(r => { const go = () => { V.drawer = +r.dataset.no; render(); }; r.onclick = go; r.onkeydown = e => { if (e.key === 'Enter') go(); }; });
}

/* ---------- 側邊詳細 ---------- */
async function renderDrawer() {
  $('.app').classList.toggle('dopen', !!V.drawer);
  const d = $('#drawer'); if (!V.drawer) { d.classList.remove('open'); return; }
  const o = ON[V.drawer]; if (!o) { V.drawer = null; d.classList.remove('open'); return; }
  const CL = claims(), [s, c] = status(o, CL), u = used(o), cp = cap(o), z = zb(o), gs = groupsOf(o.no);
  const pct = u / o.value * 100, max = Math.max(CAP() * 100 + 15, pct + 5);
  const chip = x => `<span class="code ${(CL[x] || []).length > 1 ? 'dup' : ''}">${x}<small>${fmt(UP[x])}</small></span>`;
  d.classList.add('open');
  d.innerHTML = `<div class="dh"><div><h2>${esc(o.name)}</h2><div class="sub">編號 ${o.no}${o.agent ? ` · 委託人 ${esc(o.agent)}` : ''} · 權值 ${fmt(o.value)}</div></div><span class="badge ${c}" style="margin-left:auto">${s}</span><button class="x" id="dx" aria-label="關閉">×</button></div>
  <div class="sec"><h3>選配使用率</h3>
    <div class="usage"><i class="${own(o) > cp ? 'over' : ''}" style="width:${Math.min(pct, max) / max * 100}%"></i><span class="mk" style="left:${100 / max * 100}%"><span style="transform:translateX(-100%)">100% 權值</span></span><span class="mk" style="left:${CAP() * 100 / max * 100}%"><span style="transform:none">${Math.round(CAP() * 100)}% 上限</span></span></div>
    <dl class="kv"><dt>已用</dt><dd>${fmt(u)}（${pct.toFixed(1)}%）</dd><dt>選配上限</dt><dd>${fmt(cp)}</dd><dt>找補</dt><dd class="big-zb ${z > 0 ? 'zb pay' : 'zb ret'}">${u ? (z > 0 ? '需補差 ' : '可退 ') + 'NT$' + fmt(Math.abs(z)) : '—'}</dd></dl>
    ${o.value < MIN() ? `<p class="msg w" style="margin:8px 0 0">未達最小分配單元（${fmt(MIN())} 元），只能領補償金或合併選配。</p>` : ''}
    ${o.over ? `<p class="msg w" style="margin:8px 0 0">已註記：與實施者達成協議，允許超出上限。</p>` : ''}
    ${o.noMerge ? `<p class="msg e" style="margin:8px 0 0">已註記查封／假扣押，不得合併分配。</p>` : ''}
  </div>
  <div class="sec"><h3>選配內容（個人）${!o.formal && o.u.length + o.p.length ? ' · 草稿' : ''}</h3><div class="codes">${o.u.concat(o.p).map(chip).join('') || `<span class="sub">${o.st === '不參與' ? '不參與權變' : '尚未選配'}</span>`}</div>
  ${gs.map(g => `<h3 style="margin-top:10px">合併選配 · 與 ${g.m.filter(m => m[0] !== o.no).map(m => esc(ON[m[0]].name)).join('、')}</h3><div class="codes">${g.u.concat(g.p).map(chip).join('')}</div><div class="sub" style="margin-top:4px">本人出資 NT$${fmt(g.m.find(m => m[0] === o.no)[1])} ／ 總價 NT$${fmt(gtotal(g))}</div>`).join('')}
  <div class="acts">
    <button class="btn pri full" id="d-edit">${o.u.length + o.p.length ? '改選' : '選屋登錄'}</button>
    <button class="btn" id="d-call">記錄通話</button><button class="btn" id="d-print">列印選配確認單</button>
    ${isAdmin() ? `<button class="btn full" id="d-flags">註記（店面優先／不得合併）</button>` : ''}
  </div></div>
  <div class="sec"><h3>收件進度 · ${docCount(o).join(' / ')}</h3>
    ${DOCS.map((dd, i) => {
      const req = need(o).includes(i) || dd.applies === 'optional';
      const f = o.files[i];
      return `<div class="doc ${req ? '' : 'na'}"><span class="dot s${o.docs[i]}"></span><span>${esc(dd.name)}${dd.applies === 'optional' ? '<span class="sub">（選填）</span>' : ''}${req ? '' : '<span class="sub">（不需）</span>'}${f ? ` · <a href="${esc(f.url)}" target="_blank" rel="noopener">開啟檔案</a>` : ''}</span>
      ${req ? `<span class="st">${DSTATE.map((t, k) => `<button data-doc="${i}" data-s="${k}" aria-pressed="${o.docs[i] === k}">${t}</button>`).join('')}</span>` : ''}</div>`;
    }).join('')}
    <p class="hint">用「文件歸檔」上傳掃描檔後，會自動標為已歸檔，存到 Drive 的「${pad3(o.no)}_${esc(o.name)}」資料夾。</p>
  </div>
  <div class="sec"><h3>聯絡資料</h3><dl class="kv"><dt>電話</dt><dd>${esc(o.phone) || '—'}</dd><dt>地址</dt><dd style="font-family:var(--sans)">${esc(o.addr) || '—'}</dd><dt>身分證字號</dt><dd>${o.idno ? esc(o.idno.slice(0, 3)) + '*****' + esc(o.idno.slice(-2)) : '<span style="color:var(--warn)">未填（前台無法查詢）</span>'}</dd><dt>選配日期</dt><dd>${esc(o.date) || '—'}</dd><dt>備註</dt><dd style="font-family:var(--sans);white-space:pre-wrap">${esc(o.note) || '—'}</dd></dl></div>
  <div class="sec"><h3>通話紀錄</h3><div class="log" id="d-calls"><span class="sub">載入中…</span></div></div>
  <div class="sec"><h3>異動歷程</h3><div class="log" id="d-log"><span class="sub">載入中…</span></div></div>`;
  $('#dx').onclick = () => { V.drawer = null; render(); };
  $('#d-edit').onclick = () => openSelect(o);
  $('#d-call').onclick = () => openCall(o);
  $('#d-print').onclick = () => printSheet(o);
  if ($('#d-flags')) $('#d-flags').onclick = () => openFlags(o);
  d.querySelectorAll('[data-doc]').forEach(b => b.onclick = async () => {
    try { await rpc('set_doc', { p_owner: o.no, p_idx: +b.dataset.doc, p_state: +b.dataset.s }); o.docs[+b.dataset.doc] = +b.dataset.s; render(); }
    catch (e) { toast('儲存失敗：' + e.message); }
  });
  const no = o.no;
  const [{ data: calls }, { data: logs }] = await Promise.all([
    sb.from('calls').select('*').eq('owner_no', no).order('at', { ascending: false }).limit(50),
    sb.from('audit_log').select('*').eq('owner_no', no).order('at', { ascending: false }).limit(50)]);
  if (V.drawer !== no || !$('#d-calls')) return;
  $('#d-calls').innerHTML = (calls || []).map(c => `<div><time>${tstr(c.at)}</time><span>${esc(c.by)}：${esc(c.content)}</span></div>`).join('') || '<span class="sub">尚無紀錄</span>';
  $('#d-log').innerHTML = (logs || []).map(l => `<div><time>${tstr(l.at)}</time><span>${esc(l.by)}：${esc(l.action)} ${esc(l.detail)}</span></div>`).join('') || '<span class="sub">尚無異動</span>';
}

/* ---------- 銷控表選擇器（登錄視窗共用） ---------- */
function pickerGrid(st, mine, capLeft, selfNo, groupId) {
  const CL = claims();
  const cls = c => R.has(c) ? 'r' : mine.has(c) ? 'me' : ((CL[c] || []).filter(x => !(x.k === 'o' && x.no === selfNo) && !(x.k === 'g' && x.id === groupId)).length ? 't' : '');
  if (st.pick === 'P') {
    const f = st.pf || pfloors()[pfloors().length - 1];
    return Object.values(PINFO).filter(p => p.floor === f).map(p => `<button class="cell ${cls(p.code)} ${UP[p.code] > capLeft && !mine.has(p.code) ? 'af' : ''}" data-pk="${p.code}" title="${p.code} NT$${fmt(p.price)}">${p.code.split('-').pop()}</button>`).join('');
  }
  const T = typesOf(st.pick), F = floorsOf(st.pick);
  return `<table class="g"><tr><th></th>${T.map(t => `<th>${t}</th>`).join('')}</tr>${F.map(f => `<tr><th class="fl">${f}</th>${T.map(t => {
    const c = f + '-' + t; if (!(c in UINFO)) return '<td></td>';
    return `<td><button class="cell ${cls(c)} ${UP[c] > capLeft && !mine.has(c) && !R.has(c) ? 'af' : ''}" data-pk="${c}" title="${c} NT$${fmt(UP[c])}">${fmt(UP[c] / 10000)}</button></td>`;
  }).join('')}</tr>`).join('')}</table>`;
}
function pickerBlock(st) {
  return `<div class="picker"><div class="pt"><span class="hint">從銷控表點選：</span>${areaTabs().map(([k, l]) => `<button class="btn sm" type="button" data-tab="${k}" ${st.pick === k ? 'style="border-color:var(--accent);color:var(--accent)"' : ''}>${l}</button>`).join('')}
    ${st.pick === 'P' ? `<select id="m-pf" style="width:auto;padding:4px 8px">${pfloors().map(f => `<option ${f === (st.pf || pfloors()[pfloors().length - 1]) ? 'selected' : ''}>${f}</option>`).join('')}</select>` : ''}
    <span class="hint">${st.pick === 'P' ? '數字為車位號碼' : '格內數字為總價（萬元）'} · 綠＝已被選 · 淡＝超過剩餘額度</span></div>
    <div class="pg" id="pg"></div></div>`;
}

/* ---------- 選屋登錄 ---------- */
function openSelect(o) {
  const st = { u: o.u.join(', '), p: o.p.join(', '), stt: o.st === '未申請' ? '參與' : o.st, agreed: o.over, pick: areaTabs()[0]?.[0] || 'P', pf: null,
    ph: o.phone, id: o.idno, ad: o.addr, dt: o.date || todayStr(), nt: o.note };
  const root = $('#modal-root');
  function draw() {
    const units = parse(st.u), parks = parse(st.p);
    const v = validate({ units, parks, value: o.value, capv: cap(o), selfNo: o.no, agreed: st.agreed, st: st.stt });
    const contribs = contrib(o), tot = v.total + contribs, z = tot - o.value;
    const mine = new Set(units.concat(parks));
    root.innerHTML = `<div class="scrim" id="scrim"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
      <div class="mh"><h2 id="mt">${o.u.length + o.p.length ? '改選' : '選屋登錄'} — ${esc(o.name)}</h2><span class="sub">編號 ${o.no}</span><button class="x" id="mx" aria-label="關閉">×</button></div>
      <div class="mgrid"><div class="stack">
        <div class="row2"><label class="f">應分配權利價值<input value="NT$${fmt(o.value)}" disabled></label><label class="f">選配上限（${Math.round(CAP() * 100)}%）<input value="NT$${fmt(cap(o))}" disabled></label></div>
        <div class="part"><label class="f">參與狀態<select id="m-st"><option value="參與">參與選配（需選戶別／車位）</option><option value="不參與">不參與權變（領補償金）</option><option value="未申請">尚未表態</option></select></label></div>
        <label class="f">已選戶別（可簡寫：9b9 → 9F-B9，逗號分隔）<input id="m-u" value="${esc(st.u)}" autocomplete="off" ${st.stt !== '參與' ? 'disabled' : ''}></label>
        <label class="f">已選車位（可簡寫：b557 → B5-57，逗號分隔）<input id="m-p" value="${esc(st.p)}" autocomplete="off" ${st.stt !== '參與' ? 'disabled' : ''}></label>
        ${st.stt === '參與' ? pickerBlock(st) : ''}
        <div class="row2"><label class="f">通訊電話<input id="m-ph" value="${esc(st.ph)}"></label><label class="f">身分證字號（前台查詢用）<input id="m-id" value="${esc(st.id)}" placeholder="例：A123456789" maxlength="10"></label></div>
        <div class="row2"><label class="f">通訊地址<input id="m-ad" value="${esc(st.ad)}"></label><label class="f">選配日期<input id="m-dt" type="date" value="${esc(st.dt)}"></label></div>
        <label class="f">備註<textarea id="m-nt" placeholder="例：地主現場到訪選定／電話確認改選原因">${esc(st.nt)}</textarea></label>
      </div>
      <div class="calc" aria-live="polite">
        <strong>試算</strong>
        ${units.concat(parks).map(c => `<div class="line"><span class="num">${esc(c)}${isUnit(c) ? ` <span class="sub">${UINFO[c].total} 坪</span>` : c in PINFO ? ` <span class="sub">${esc(PINFO[c].size)}</span>` : ''}</span><b>${c in UP ? fmt(UP[c]) : '—'}</b></div>`).join('') || '<span class="hint">輸入或點選戶別、車位後會即時計算</span>'}
        ${contribs ? `<div class="line"><span>合併組出資</span><b>${fmt(contribs)}</b></div>` : ''}
        <hr><div class="line"><span>選配總價</span><b>${fmt(tot)}</b></div>
        <div class="line"><span>應分配權利價值</span><b>${fmt(o.value)}</b></div>
        <div class="line"><span>使用率</span><b style="color:${v.total > cap(o) ? 'var(--bad)' : 'inherit'}">${(tot / o.value * 100).toFixed(1)}%</b></div>
        <div class="line"><span>剩餘可選（至上限）</span><b>${fmt(cap(o) - v.total)}</b></div>
        <div class="line" style="font-size:15px"><span>找補</span><b class="zb ${z > 0 ? 'pay' : 'ret'}">${tot ? (z > 0 ? '補 ' : '退 ') + 'NT$' + fmt(Math.abs(z)) : '—'}</b></div>
        ${v.E.map(e => `<div class="msg e">${esc(e)}</div>`).join('')}${v.W.map(e => `<div class="msg w">${esc(e)}</div>`).join('')}
        ${!v.E.length && v.total && st.stt === '參與' ? '<div class="msg o">檢查通過，可以正式登錄</div>' : ''}
        ${v.total > cap(o) && st.stt === '參與' && (SET.over_cap_mode || 'approve') === 'approve' ? (isAdmin() ? `<label class="agree"><input type="checkbox" id="m-ag" ${st.agreed ? 'checked' : ''}>已與實施者達成協議，允許超出上限（請在備註寫明協議內容）</label>` : (o.over ? '<div class="hint">此地主先前已由管理員核准超選</div>' : '<div class="hint">超出上限需管理員確認</div>')) : ''}
      </div></div>
      <div class="mf"><button class="btn" id="m-cancel">取消</button><button class="btn" id="m-draft">存草稿</button><button class="btn ok" id="m-save" ${v.E.length ? 'disabled' : ''}>✓ 正式登錄</button></div>
    </div></div>`;
    $('#m-st').value = st.stt;
    const pg = $('#pg'); if (pg) pg.innerHTML = pickerGrid(st, mine, cap(o) - v.total, o.no, null);
    const keep = (id, k) => { const el = $(id); el.oninput = e => { st[k] = e.target.value; const p = el.selectionStart; draw(); const n = $(id); n.focus(); try { n.setSelectionRange(p, p); } catch (_) { } }; };
    keep('#m-u', 'u'); keep('#m-p', 'p');
    ['ph', 'id', 'ad', 'dt', 'nt'].forEach(k => { const el = $('#m-' + k); el.oninput = el.onchange = e => st[k] = e.target.value; });
    $('#m-st').onchange = e => { st.stt = e.target.value; draw(); };
    const ag = $('#m-ag'); if (ag) ag.onchange = e => { st.agreed = e.target.checked; draw(); };
    root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { st.pick = b.dataset.tab; draw(); });
    const pf = $('#m-pf'); if (pf) pf.onchange = e => { st.pf = e.target.value; draw(); };
    root.querySelectorAll('[data-pk]').forEach(b => b.onclick = () => {
      const c = b.dataset.pk; if (R.has(c)) return; const k = c in PINFO ? 'p' : 'u'; const cur = parse(st[k]);
      st[k] = (cur.includes(c) ? cur.filter(x => x !== c) : cur.concat(c)).join(', '); const sc = $('#pg').scrollTop; draw(); $('#pg').scrollTop = sc;
    });
    $('#mx').onclick = closeModal; $('#m-cancel').onclick = closeModal;
    const commit = async formal => {
      busy(true, formal ? '正式登錄中…' : '存草稿中…');
      try {
        const res = await rpc('save_owner', { p: {
          no: o.no, participation: st.stt, units: st.stt === '參與' ? units : [], parks: st.stt === '參與' ? parks : [], formal,
          over_approved: !!st.agreed, phone: st.ph, id_no: st.id.trim(), address: st.ad, sel_date: st.dt, note: st.nt } });
        if (!res.ok) { busy(false); toast('未儲存：' + res.errors.join('；')); return; }
        closeModal(); await refresh(); busy(false);
        toast(formal ? `已正式登錄 ${o.name}，前台會在 30 秒內更新` : '已存成草稿，前台不會顯示');
      } catch (e) { busy(false); toast('儲存失敗：' + e.message); }
    };
    $('#m-draft').onclick = () => commit(false);
    $('#m-save').onclick = () => { if (!v.E.length) commit(true); };
  }
  draw();
}
function openCall(o) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="scrim"><div class="modal narrow" role="dialog" aria-modal="true"><div class="mh"><h2>記錄通話 — ${esc(o.name)}</h2><button class="x" id="mx">×</button></div>
  <div class="stack"><label class="f">電話<input value="${esc(o.phone)}" id="c-ph"></label><label class="f">通話內容<textarea id="c-t" placeholder="例：地主詢問 12F 是否還有 B 棟邊間，約週六下午到場"></textarea></label></div>
  <div class="mf"><button class="btn" id="c-x">取消</button><button class="btn pri" id="c-s">儲存</button></div></div></div>`;
  $('#mx').onclick = closeModal; $('#c-x').onclick = closeModal;
  $('#c-s').onclick = async () => {
    const t = $('#c-t').value.trim(); if (!t) { $('#c-t').focus(); return; }
    const { error } = await sb.from('calls').insert({ owner_no: o.no, phone: $('#c-ph').value, content: t });
    if (error) return toast('儲存失敗：' + error.message);
    if ($('#c-ph').value !== o.phone) await rpc('update_owner_info', { p: { no: o.no, phone: $('#c-ph').value } }).catch(() => { });
    closeModal(); await refresh(); toast('通話紀錄已儲存');
  };
}
function openFlags(o) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="scrim"><div class="modal narrow" role="dialog" aria-modal="true"><div class="mh"><h2>註記 — ${esc(o.name)}</h2><button class="x" id="mx">×</button></div>
  <div class="stack"><label class="toggle">店面優先（更新前持有一樓店面，可優先選配相對位次店鋪）<input type="checkbox" id="f-s" ${o.store ? 'checked' : ''}></label>
  <label class="toggle">不得合併（原土地或建物遭查封、假扣押、假處分或破產登記）<input type="checkbox" id="f-m" ${o.noMerge ? 'checked' : ''}></label></div>
  <div class="mf"><button class="btn" id="f-x">取消</button><button class="btn pri" id="f-ok">儲存</button></div></div></div>`;
  $('#mx').onclick = closeModal; $('#f-x').onclick = closeModal;
  $('#f-ok').onclick = async () => {
    try { await rpc('update_owner_info', { p: { no: o.no, store_priority: $('#f-s').checked, no_merge: $('#f-m').checked } }); closeModal(); await refresh(); toast('註記已儲存'); }
    catch (e) { toast('儲存失敗：' + e.message); }
  };
}
function printSheet(o) {
  const gs = groupsOf(o.no), w = window.open('', '_blank'); if (!w) return toast('瀏覽器擋住了新視窗，請允許彈出視窗');
  const row = c => `<tr><td>${c}</td><td>${isUnit(c) ? '房屋 · ' + UINFO[c].total + ' 坪' : '車位 · ' + esc(PINFO[c]?.size || '')}</td><td style="text-align:right">${fmt(UP[c])}</td></tr>`;
  w.document.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(o.name)} 選配確認單</title><style>body{font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif;padding:32px;color:#111;max-width:760px;margin:auto}h1{font-size:20px;text-align:center;margin:0}h2{font-size:15px;margin:22px 0 6px}p{margin:4px 0}table{width:100%;border-collapse:collapse;font-size:14px}td,th{border:1px solid #999;padding:6px 8px}th{background:#eee;text-align:left}.sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:48px}.sign div{border-top:1px solid #333;padding-top:6px;font-size:13px}@media print{button{display:none}}</style></head><body>
  <button onclick="print()" style="float:right">列印</button><h1>${esc(SET.case_name || '')}</h1><p style="text-align:center">選配確認單</p>
  <h2>受配人</h2><table><tr><th>編號</th><td>${o.no}</td><th>姓名</th><td>${esc(o.name)}${o.agent ? '（委託人 ' + esc(o.agent) + '）' : ''}</td></tr><tr><th>應分配權利價值</th><td>NT$${fmt(o.value)}</td><th>選配上限</th><td>NT$${fmt(cap(o))}</td></tr><tr><th>電話</th><td>${esc(o.phone)}</td><th>選配日期</th><td>${esc(o.date)}</td></tr></table>
  <h2>個人選配</h2><table><tr><th>編號</th><th>類別</th><th style="text-align:right">價值（元）</th></tr>${o.u.concat(o.p).map(row).join('') || '<tr><td colspan="3">無</td></tr>'}</table>
  ${gs.map(g => `<h2>合併選配（與 ${g.m.filter(m => m[0] !== o.no).map(m => esc(ON[m[0]].name)).join('、')}）</h2><table><tr><th>編號</th><th>類別</th><th style="text-align:right">價值（元）</th></tr>${g.u.concat(g.p).map(row).join('')}<tr><th colspan="2">本人出資</th><td style="text-align:right">${fmt(g.m.find(m => m[0] === o.no)[1])}</td></tr></table>`).join('')}
  <h2>找補試算</h2><table><tr><th>選配總價</th><td style="text-align:right">NT$${fmt(used(o))}</td></tr><tr><th>應分配權利價值</th><td style="text-align:right">NT$${fmt(o.value)}</td></tr><tr><th>${zb(o) > 0 ? '應補差額' : '應退差額'}</th><td style="text-align:right">NT$${fmt(Math.abs(zb(o)))}</td></tr></table>
  <p style="font-size:12px;margin-top:10px">本確認單金額僅供參考，實際以核定之權利變換計畫為準。</p>
  <div class="sign"><div>受配人簽章</div><div>經辦人員：${esc(ME.name || ME.email)}</div></div></body></html>`);
  w.document.close();
}

/* ---------- 合併管理 ---------- */
function vMerge() {
  $('#main').innerHTML = `<div class="ph"><h1>合併選配管理</h1><button class="btn pri" id="g-new">＋ 新增合併組</button>
  <p class="desc">多位地主以剩餘權值合併，共同選配戶別與車位。出資預設按剩餘權值比例分攤，可手動調整；${SET.merge_cap_mode === 'each' ? '每人出資不可超過自己的剩餘額度。' : '上限只檢查全組總額。'}找補按各人出資計算。</p></div>
  ${G.map(g => {
    const tot = gtotal(g); const gcap = g.m.reduce((s, m) => s + cap(ON[m[0]]) - own(ON[m[0]]), 0); const gv = g.m.reduce((s, m) => s + ON[m[0]].value - own(ON[m[0]]), 0);
    return `<div class="gcard"><div class="ph" style="margin:0"><h3>${g.m.map(m => esc(ON[m[0]].name)).join('、')}（${g.m.length} 人合併）</h3><span style="flex:1"></span><button class="btn sm" data-ge="${g.id}">編輯</button>${isAdmin() ? `<button class="btn sm" data-gd="${g.id}">刪除</button>` : ''}</div>
   <div class="ginner"><div class="gbox"><div class="l">合併選配內容</div><div class="v">${g.u.concat(g.p).join('、') || '—'}</div><div class="sub">總價 NT$${fmt(tot)}</div></div>
   <div class="gbox"><div class="l">${g.m.length} 人剩餘權利價值加總</div><div class="v">NT$${fmt(gv)}</div><div class="sub">可選上限 NT$${fmt(gcap)}</div></div>
   <div class="gbox"><div class="l">各人出資與找補</div>${g.m.map(m => { const o = ON[m[0]]; const z = m[1] - (o.value - own(o)); return `<div class="mem"><span>${esc(o.name)} <span class="sub">${fmt(m[1])}</span></span><span class="zb ${z > 0 ? 'pay' : 'ret'}">${z > 0 ? '補' : '退'} ${fmt(Math.abs(z))}</span></div>`; }).join('')}</div></div></div>`;
  }).join('') || '<p class="sub">尚未建立合併組</p>'}`;
  $('#g-new').onclick = () => openGroup(null);
  $$('[data-ge]').forEach(b => b.onclick = () => openGroup(G.find(g => g.id === +b.dataset.ge)));
  $$('[data-gd]').forEach(b => b.onclick = () => {
    const g = G.find(x => x.id === +b.dataset.gd);
    confirmBox(`刪除「${g.m.map(m => esc(ON[m[0]].name)).join('、')}」的合併組？他們的合併選配會一起取消。`, async () => {
      try { await rpc('delete_group', { p_id: g.id }); await refresh(); toast('已刪除合併組'); } catch (e) { toast('刪除失敗：' + e.message); }
    }, '刪除');
  });
}
function openGroup(g) {
  const st = { mem: g ? g.m.map(m => m[0]) : [], amt: g ? Object.fromEntries(g.m) : {}, u: g ? g.u.join(', ') : '', p: g ? g.p.join(', ') : '', q: '', manual: !!g, agreed: !!(g && g.over), pick: areaTabs()[0]?.[0] || 'P', pf: null };
  const root = $('#modal-root');
  const rem = no => ON[no].value - own(ON[no]);
  const remCap = no => cap(ON[no]) - own(ON[no]);
  function auto(total) { const ws = st.mem.map(rem).map(x => Math.max(x, 0)), sw = ws.reduce((a, b) => a + b, 0) || 1; let acc = 0; st.mem.forEach((no, i) => { if (i < st.mem.length - 1) { const a = Math.round(total * ws[i] / sw); st.amt[no] = a; acc += a; } else st.amt[no] = total - acc; }); }
  function draw() {
    const units = parse(st.u), parks = parse(st.p), all = units.concat(parks);
    const total = all.reduce((s, c) => s + (UP[c] || 0), 0);
    if (!st.manual) auto(total);
    else if (st.mem.length) { let acc = 0; st.mem.slice(0, -1).forEach(no => acc += (+st.amt[no] || 0)); st.amt[st.mem[st.mem.length - 1]] = total - acc; }
    const gcap = st.mem.reduce((s, no) => s + remCap(no), 0);
    const v = validate({ units, parks, value: 0, capv: gcap, selfNo: null, groupId: g ? g.id : -1, agreed: st.agreed, st: '參與' });
    if (st.mem.length < 2) v.E.unshift('請至少選擇 2 位地主');
    st.mem.forEach(no => { if (ON[no].noMerge) v.E.push(`${ON[no].name} 已註記查封／假扣押，依法不得合併分配`); if (ON[no].st === '不參與') v.E.push(`${ON[no].name} 目前為「不參與權變」`); if (SET.merge_cap_mode === 'each' && (+st.amt[no] || 0) > remCap(no)) v.E.push(`${ON[no].name} 的出資超過自己的剩餘額度`); });
    st.mem.slice(0, -1).forEach(no => { if ((+st.amt[no] || 0) < 0) v.E.push(`${ON[no].name} 出資不可為負數`); });
    if (st.mem.length && st.amt[st.mem[st.mem.length - 1]] < 0) v.E.push('前面成員的出資加總超過選配總價');
    const q = st.q.trim();
    const list = O.filter(o => o.st !== '不參與' && (!q || o.name.includes(q) || String(o.no) === q));
    root.innerHTML = `<div class="scrim"><div class="modal" role="dialog" aria-modal="true"><div class="mh"><h2>${g ? '編輯合併組' : '新增合併組'}</h2><button class="x" id="mx">×</button></div>
    <div class="mgrid"><div class="stack">
      <label class="f">搜尋並選擇組員（姓名或編號）<input id="g-q" value="${esc(st.q)}" placeholder="例：林貴龍 或 61"></label>
      <div class="mlist">${list.map(o => `<label><input type="checkbox" data-m="${o.no}" ${st.mem.includes(o.no) ? 'checked' : ''}>${o.no}　${esc(o.name)}${o.value < MIN() ? ' <span class="badge b-warn">未達最小單元</span>' : ''}${o.noMerge ? ' <span class="badge b-bad">不得合併</span>' : ''}<span class="r" style="${remCap(o.no) <= 0 ? 'color:var(--bad)' : ''}">剩餘額度 ${fmt(remCap(o.no))}</span></label>`).join('')}</div>
      <div class="codes">${st.mem.map(no => `<span class="code">${esc(ON[no].name)} <button class="btn sm" style="padding:0 6px;border:0" data-rm="${no}" aria-label="移除">×</button></span>`).join('')}</div>
      <label class="f">合併選配戶別（可簡寫，逗號分隔）<input id="g-u" value="${esc(st.u)}"></label>
      <label class="f">合併選配車位<input id="g-p" value="${esc(st.p)}"></label>
      ${pickerBlock(st)}
      <div><div class="ph" style="margin:0 0 6px"><strong style="font-size:13px">各人出資</strong><span class="hint">預設按剩餘權值比例；改了之後最後一位自動補足</span><span style="flex:1"></span><button class="btn sm" id="g-auto">↻ 自動分攤</button></div>
      <div class="split h"><span>組員</span><span>出資金額</span><span>剩餘權值</span><span>出資比</span></div>
      ${st.mem.map((no, i) => `<div class="split" style="margin-top:6px"><span>${esc(ON[no].name)}</span><input data-a="${no}" value="${st.amt[no] || 0}" ${i === st.mem.length - 1 ? 'disabled' : ''} inputmode="numeric"><span class="num sub">${fmt(rem(no))}</span><span class="num">${total ? ((st.amt[no] || 0) / total * 100).toFixed(1) : '0.0'}%</span></div>`).join('')}
      </div>
    </div>
    <div class="calc"><strong>試算</strong>
      <div class="line"><span>選配總價</span><b>${fmt(total)}</b></div>
      <div class="line"><span>合併可用上限（各人剩餘額度加總）</span><b>${fmt(gcap)}</b></div>
      <div class="line"><span>已分配金額</span><b>${fmt(st.mem.reduce((s, no) => s + (+st.amt[no] || 0), 0))}</b></div>
      <hr><strong style="font-size:13px">各人找補</strong>
      ${st.mem.map(no => { const z = (+st.amt[no] || 0) - rem(no); return `<div class="line"><span>${esc(ON[no].name)}</span><b class="zb ${z > 0 ? 'pay' : 'ret'}">${z > 0 ? '補' : '退'} NT$${fmt(Math.abs(z))}</b></div>`; }).join('') || '<span class="hint">選擇組員後顯示</span>'}
      ${v.E.map(e => `<div class="msg e">${esc(e)}</div>`).join('')}${v.W.map(e => `<div class="msg w">${esc(e)}</div>`).join('')}
      ${total > gcap && isAdmin() && (SET.over_cap_mode || 'approve') === 'approve' ? `<label class="agree"><input type="checkbox" id="g-ag" ${st.agreed ? 'checked' : ''}>已與實施者達成協議，允許超出上限</label>` : ''}
      ${!v.E.length && total ? `<div class="msg o">檢查通過。${SET.merge_cap_mode === 'each' ? '' : '個人出資可超過自己的額度，只檢查全組總額。'}</div>` : ''}
    </div></div>
    <div class="mf"><button class="btn" id="g-x">取消</button><button class="btn ok" id="g-s" ${v.E.length || !total ? 'disabled' : ''}>✓ 儲存合併組</button></div></div></div>`;
    const pg = $('#pg'); if (pg) pg.innerHTML = pickerGrid(st, new Set(all), gcap - total, null, g ? g.id : -1);
    const keep = (id, fn) => { const el = $(id); el.oninput = e => { fn(e.target.value); const p = el.selectionStart; draw(); const n = $(id); n.focus(); try { n.setSelectionRange(p, p); } catch (_) { } }; };
    keep('#g-q', x => st.q = x); keep('#g-u', x => st.u = x); keep('#g-p', x => st.p = x);
    root.querySelectorAll('[data-a]').forEach(el => { el.oninput = e => { st.manual = true; st.amt[+el.dataset.a] = +e.target.value.replace(/[^\d]/g, '') || 0; const id = el.dataset.a, p = el.selectionStart; draw(); const n = root.querySelector(`[data-a="${id}"]`); n.focus(); try { n.setSelectionRange(p, p); } catch (_) { } }; });
    root.querySelectorAll('[data-m]').forEach(c => c.onchange = () => { const no = +c.dataset.m; st.mem = c.checked ? st.mem.concat(no) : st.mem.filter(x => x !== no); st.manual = false; draw(); });
    root.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { st.mem = st.mem.filter(x => x !== +b.dataset.rm); st.manual = false; draw(); });
    root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { st.pick = b.dataset.tab; draw(); });
    const pf = $('#m-pf'); if (pf) pf.onchange = e => { st.pf = e.target.value; draw(); };
    root.querySelectorAll('[data-pk]').forEach(b => b.onclick = () => { const c = b.dataset.pk; if (R.has(c)) return; const k = c in PINFO ? 'p' : 'u'; const cur = parse(st[k]); st[k] = (cur.includes(c) ? cur.filter(x => x !== c) : cur.concat(c)).join(', '); const sc = $('#pg').scrollTop; draw(); $('#pg').scrollTop = sc; });
    $('#g-auto').onclick = () => { st.manual = false; draw(); };
    const ag = $('#g-ag'); if (ag) ag.onchange = e => { st.agreed = e.target.checked; draw(); };
    $('#mx').onclick = closeModal; $('#g-x').onclick = closeModal;
    $('#g-s').onclick = async () => {
      if (v.E.length) return; busy(true, '儲存合併組…');
      try {
        const res = await rpc('save_group', { p: { id: g ? g.id : null, members: st.mem.map(no => ({ no, amount: +st.amt[no] || 0 })), units, parks, over_approved: st.agreed } });
        if (!res.ok) { busy(false); return toast('未儲存：' + res.errors.join('；')); }
        closeModal(); await refresh(); busy(false); toast('合併組已儲存');
      } catch (e) { busy(false); toast('儲存失敗：' + e.message); }
    };
  }
  draw();
}

/* ---------- 選屋總覽 ---------- */
function vOverview() {
  const CL = claims();
  const nm = x => x.k === 'o' ? ON[x.no].name + (x.formal ? '' : '(草)') : '合併';
  const cell = c => { const cl = CL[c] || []; const cls = R.has(c) ? 'r' : cl.length > 1 ? 'd' : cl.length ? 't' : ''; return `<button class="ovc ${cls}" data-c="${c}" title="${c} NT$${fmt(UP[c])}"><b>${c.split('-').pop()}</b>${R.has(c) ? '保留' : esc(cl.map(nm).join('/'))}</button>`; };
  let body = '', codes = [];
  if (V.ov === 'P') { body = pfloors().map(f => { const l = Object.values(PINFO).filter(p => p.floor === f); codes = codes.concat(l.map(p => p.code)); return `<h3 style="font-size:13px;margin:6px 0">${f}（${l.length} 位）</h3><div class="pkrow">${l.map(p => cell(p.code)).join('')}</div>`; }).join(''); }
  else { const T = typesOf(V.ov), F = floorsOf(V.ov); body = `<table class="g"><tr><th></th>${T.map(t => `<th>${t}</th>`).join('')}</tr>${F.map(f => `<tr><th class="fl">${f}</th>${T.map(t => { const c = f + '-' + t; if (!(c in UINFO)) return '<td></td>'; codes.push(c); return `<td>${cell(c)}</td>`; }).join('')}</tr>`).join('')}</table>`; }
  const taken = codes.filter(c => CL[c]).length;
  $('#main').innerHTML = `<div class="ph"><h1>選屋總覽</h1><span class="updated">後台看得到選配人姓名；前台${SET.show_names ? '也會' : '只'}顯示${SET.show_names ? '姓名' : '已選／未選'}</span></div>
  <div class="ov-tabs">${areaTabs().map(([k, l]) => `<button class="chip" data-ov="${k}" aria-pressed="${V.ov === k}">${l}</button>`).join('')}<span class="updated" style="align-self:center;margin-left:8px">已選 ${taken} / ${codes.length}</span></div>
  <div class="ovg">${body}</div>`;
  $$('[data-ov]').forEach(b => b.onclick = () => { V.ov = b.dataset.ov; vOverview(); });
  $$('.ovc').forEach(b => b.onclick = () => { const cl = CL[b.dataset.c] || []; if (cl[0] && cl[0].k === 'o') { V.drawer = cl[0].no; renderDrawer(); } else if (cl[0]) { V.view = 'merge'; render(); } });
}

/* ---------- 重複與抽籤 ---------- */
function vLottery() {
  const CL = claims(); const dups = Object.entries(CL).filter(([, v]) => v.length > 1);
  const redo = O.filter(o => o.redo && !o.u.length);
  const late = O.filter(o => o.st === '未申請' && o.value >= MIN());
  $('#main').innerHTML = `<div class="ph"><h1>重複與抽籤</h1><p class="desc">${SET.lottery_text ? '公開抽籤：' + esc(SET.lottery_text) + '。' : ''}現場抽完後，在這裡點選中籤者；未中籤者會自動改成「需重選」，進入第二階段。</p></div>
  <h2 style="font-size:15px;margin:6px 0 10px">第一階段 · 重複選配（${dups.length}）</h2>
  ${dups.map(([c, v]) => `<div class="lot"><div><div class="c">${c}</div><div class="sub">NT$${fmt(UP[c])}</div></div><div class="cands">${v.map((x, i) => `<div class="cand">${esc(claimName(x))}${x.formal ? '' : ' <span class="badge b-warn">草稿</span>'}<button class="btn sm ok" data-win="${c}" data-i="${i}">中籤</button></div>`).join('')}</div></div>`).join('') || '<p class="sub">目前沒有重複選配</p>'}
  <h2 style="font-size:15px;margin:18px 0 10px">第二階段 · 需重選（${redo.length}）</h2>
  <div class="tbl">${redo.map(o => `<div class="tr" data-no="${o.no}"><span class="num sub">${o.no}</span><span class="nm">${esc(o.name)}</span><span class="sub">依抽出的順位，就剩餘戶別重新選配</span><span><span class="badge b-bad">需重選</span></span><span></span><span class="chev">›</span></div>`).join('') || '<div class="tr" style="cursor:default"><span></span><span class="sub">尚無</span></div>'}</div>
  <h2 style="font-size:15px;margin:18px 0 10px">第三階段 · 未於期限內申請、且超過最小分配單元（${late.length}）</h2>
  <div class="tbl">${late.map(o => `<div class="tr" data-no="${o.no}"><span class="num sub">${o.no}</span><span class="nm">${esc(o.name)}</span><span class="num sub">權值 ${fmt(o.value)}</span><span><span class="badge b-acc">第三階段</span></span><span></span><span class="chev">›</span></div>`).join('') || '<div class="tr" style="cursor:default"><span></span><span class="sub">尚無</span></div>'}</div>`;
  $$('[data-win]').forEach(b => b.onclick = () => {
    const c = b.dataset.win, i = +b.dataset.i, w = CL[c][i];
    confirmBox(`確認 ${c} 由「${esc(claimName(w))}」中籤？其他人會移除此位置${isUnit(c) ? '並改為「需重選」' : ''}。`, async () => {
      try { await rpc('lottery_win', { p_code: c, p_owner: w.k === 'o' ? w.no : null, p_group: w.k === 'g' ? w.id : null }); await refresh(); toast(`${c} 抽籤結果已登錄`); }
      catch (e) { toast('登錄失敗：' + e.message); }
    });
  });
  $$('.tr[data-no]').forEach(r => r.onclick = () => { V.drawer = +r.dataset.no; renderDrawer(); });
}

/* ---------- 文件歸檔（PDF 拆頁 → 指定地主 → 合併上傳 Drive） ---------- */
const LIBS = {};
function loadScript(src) { return LIBS[src] || (LIBS[src] = new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('無法載入 ' + src)); document.head.appendChild(s); })); }
async function pdfLibs() {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js');
}
let BATCH = { files: [], pages: [] };  // pages: {f, i, no, doc, start, guess, manual}
const docShort = i => (DOCS[i]?.name || '文件').replace(/^附件[一二三四五六七八九十]+\s*/, '');
function vDocs() {
  const driveOk = !!SET.drive_script_url;
  const opts = no => `<option value="">— 選擇地主 —</option>` + O.map(o => `<option value="${o.no}" ${o.no === no ? 'selected' : ''}>${o.no} ${esc(o.name)}</option>`).join('');
  const groups = batchGroups();
  $('#main').innerHTML = `<div class="ph"><h1>文件歸檔</h1><p class="desc">把掃描好的 PDF 拖進來（一份或多份都可以），系統會拆成一頁一頁。在每一頁指定地主與文件，後面的頁面會自動沿用上一頁。確認後，同一位地主、同一份文件的頁面合併成一個 PDF，存到 Google Drive，並標記為已歸檔。</p></div>
  ${driveOk ? '' : `<p class="msg w">尚未設定 Google Drive 上傳網址。${isAdmin() ? '請到「案件設定 → 文件」填入 Apps Script 網址。' : '請管理員到「案件設定」設定。'}</p>`}
  <label class="drop" id="drop" for="pdf-in">把 PDF 拖到這裡，或點這裡選擇檔案<input type="file" id="pdf-in" accept="application/pdf" multiple hidden>
    <div class="hint" style="margin-top:6px">${BATCH.files.length ? `已載入：${BATCH.files.map(f => esc(f.name)).join('、')}（共 ${BATCH.pages.length} 頁）` : '檔案只在你的瀏覽器處理，按「確認歸檔」後才會上傳'}</div></label>
  ${BATCH.pages.length ? `<div class="ph"><button class="btn" id="b-ocr">自動辨識姓名（文字辨識）</button><span class="hint" id="ocr-st">辨識結果只是建議，請逐頁確認</span><span style="flex:1"></span><button class="btn" id="b-clear">清除</button></div>
  <div class="batch">${BATCH.pages.map((p, k) => `<div class="pgc ${p.start ? 'split-start' : ''}">
    <canvas id="cv${k}" aria-label="第 ${k + 1} 頁縮圖"></canvas>
    <div class="ocr ${p.guess ? 'ok' : 'no'}">第 ${k + 1} 頁${p.guess ? ` · 辨識到 ${esc(ON[p.guess]?.name || '')}` : p.ocrDone ? ' · 辨識不到姓名' : ''}</div>
    <select data-bo="${k}" aria-label="第 ${k + 1} 頁地主">${opts(p.no)}</select>
    <select data-bd="${k}" aria-label="第 ${k + 1} 頁文件">${DOCS.map((d, i) => `<option value="${i}" ${i === p.doc ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
    ${k > 0 ? `<label class="hint" style="display:flex;gap:6px;align-items:center"><input type="checkbox" style="width:auto" data-bs="${k}" ${p.start ? 'checked' : ''}>從這頁開始新文件</label>` : ''}
  </div>`).join('')}</div>
  <div class="result-list"><strong style="font-family:var(--sans)">將產生 ${groups.length} 個檔案</strong>${groups.map(g => `<div>${g.no ? esc(fileName(g)) : '⚠️ 未指定地主'}　<span class="sub">第 ${g.idx.map(i => i + 1).join('、')} 頁</span></div>`).join('')}</div>
  <div class="progress" id="up-prog" hidden><i style="width:0"></i></div>
  <div class="mf"><button class="btn ok" id="b-go" ${!driveOk || groups.some(g => !g.no) ? 'disabled' : ''}>確認歸檔</button></div>` : ''}`;
  const inp = $('#pdf-in'); inp.onchange = e => addPdfs([...e.target.files]);
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; };
  drop.ondragleave = () => drop.style.borderColor = '';
  drop.ondrop = e => { e.preventDefault(); drop.style.borderColor = ''; addPdfs([...e.dataTransfer.files].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name))); };
  if (!BATCH.pages.length) return;
  BATCH.pages.forEach((p, k) => drawThumb(p, $('#cv' + k)));
  $$('[data-bo]').forEach(s => s.onchange = e => { setPage(+s.dataset.bo, { no: +e.target.value || null }); vDocs(); });
  $$('[data-bd]').forEach(s => s.onchange = e => { setPage(+s.dataset.bd, { doc: +e.target.value }); vDocs(); });
  $$('[data-bs]').forEach(s => s.onchange = e => { BATCH.pages[+s.dataset.bs].start = e.target.checked; vDocs(); });
  $('#b-clear').onclick = () => { BATCH = { files: [], pages: [] }; vDocs(); };
  $('#b-ocr').onclick = runOcr;
  $('#b-go').onclick = uploadBatch;
}
function setPage(k, patch) {
  const P = BATCH.pages; Object.assign(P[k], patch, { manual: true });
  for (let j = k + 1; j < P.length && !P[j].manual; j++) { if ('no' in patch) P[j].no = P[k].no; if ('doc' in patch) P[j].doc = P[k].doc; }
}
function batchGroups() {
  const out = [];
  BATCH.pages.forEach((p, i) => { const l = out[out.length - 1]; if (l && l.no === p.no && l.doc === p.doc && !p.start) l.idx.push(i); else out.push({ no: p.no, doc: p.doc, idx: [i] }); });
  return out;
}
function fileName(g) { const o = ON[g.no]; return `${pad3(o.no)}_${o.name}_${docShort(g.doc)}.pdf`; }
async function addPdfs(files) {
  if (!files.length) return;
  busy(true, '讀取 PDF…');
  try {
    await pdfLibs();
    for (const f of files) {
      const buf = await f.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
      const fi = BATCH.files.push({ name: f.name, buf, doc }) - 1;
      for (let i = 0; i < doc.numPages; i++) {
        const prev = BATCH.pages[BATCH.pages.length - 1];
        BATCH.pages.push({ f: fi, i, no: prev ? prev.no : null, doc: prev ? prev.doc : 0, start: !prev || i === 0, guess: null, manual: false });
      }
    }
  } catch (e) { toast('讀取失敗：' + e.message); }
  busy(false); vDocs();
}
async function renderPage(p, scale) {
  const page = await BATCH.files[p.f].doc.getPage(p.i + 1);
  const vp = page.getViewport({ scale });
  const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
  await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise; return cv;
}
async function drawThumb(p, target) {
  if (!target) return;
  if (!p.thumb) p.thumb = await renderPage(p, 0.35);
  target.width = p.thumb.width; target.height = p.thumb.height; target.getContext('2d').drawImage(p.thumb, 0, 0);
}
async function runOcr() {
  const stEl = $('#ocr-st'); $('#b-ocr').disabled = true;
  try {
    stEl.textContent = '載入文字辨識（第一次約需 20 秒）…';
    await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
    const worker = await Tesseract.createWorker(['chi_tra', 'eng']);
    const names = O.map(o => [o.no, o.name]).filter(([, n]) => n.length >= 2).sort((a, b) => b[1].length - a[1].length);
    const ids = O.filter(o => o.idno).map(o => [o.no, o.idno.toUpperCase()]);
    const KW = [[/合併/, 'merge'], [/委託/, 'optional'], [/意願/, 'all'], [/申請/, 'participate']];
    for (let k = 0; k < BATCH.pages.length; k++) {
      const p = BATCH.pages[k]; stEl.textContent = `辨識中 ${k + 1} / ${BATCH.pages.length}…`;
      const cv = await renderPage(p, 1.6);
      const { data: { text } } = await worker.recognize(cv);
      const t = text.replace(/\s/g, '').toUpperCase();
      let hit = ids.find(([, id]) => t.includes(id)) || names.find(([, n]) => t.includes(n));
      p.guess = hit ? hit[0] : null; p.ocrDone = true;
      if (hit && !p.manual) { p.no = hit[0]; for (let j = k + 1; j < BATCH.pages.length && !BATCH.pages[j].manual; j++) BATCH.pages[j].no = hit[0]; if (k > 0 && BATCH.pages[k - 1].no !== hit[0]) p.start = true; }
      const kw = KW.find(([re]) => re.test(text.replace(/\s/g, '')));
      if (kw && !p.manual) { const di = DOCS.findIndex(d => d.applies === kw[1]); if (di >= 0) { if (BATCH.pages[k - 1] && BATCH.pages[k - 1].doc !== di) p.start = true; p.doc = di; for (let j = k + 1; j < BATCH.pages.length && !BATCH.pages[j].manual; j++) BATCH.pages[j].doc = di; } }
    }
    await worker.terminate();
    vDocs(); toast('辨識完成，請逐頁確認');
  } catch (e) { stEl.textContent = '文字辨識失敗，請手動指定：' + e.message; $('#b-ocr').disabled = false; }
}
async function uploadBatch() {
  const groups = batchGroups(); if (groups.some(g => !g.no)) return;
  const { data: { session } } = await sb.auth.getSession();
  const prog = $('#up-prog'); prog.hidden = false; $('#b-go').disabled = true;
  const srcs = await Promise.all(BATCH.files.map(f => PDFLib.PDFDocument.load(f.buf, { ignoreEncryption: true })));
  let done = 0; const fails = [];
  for (const g of groups) {
    try {
      const out = await PDFLib.PDFDocument.create();
      for (const k of g.idx) { const p = BATCH.pages[k]; const [cp] = await out.copyPages(srcs[p.f], [p.i]); out.addPage(cp); }
      const b64 = await out.saveAsBase64();
      const o = ON[g.no], name = fileName(g);
      const r = await fetch(SET.drive_script_url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token: session.access_token, folder: `${pad3(o.no)}_${o.name}`, fileName: name, data: b64 }) }).then(r => r.json());
      if (!r.ok) throw new Error(r.error || '上傳失敗');
      await rpc('set_doc', { p_owner: g.no, p_idx: g.doc, p_state: 2, p_file_id: r.id, p_file_url: r.url, p_file_name: name });
    } catch (e) { fails.push(fileName(g) + '：' + e.message); }
    done++; prog.firstElementChild.style.width = (done / groups.length * 100) + '%';
  }
  if (fails.length) { toast(`${fails.length} 個檔案失敗：` + fails[0]); $('#b-go').disabled = false; }
  else { BATCH = { files: [], pages: [] }; toast(`已歸檔 ${groups.length} 個檔案到 Google Drive`); }
  await refresh();
}

/* ---------- 找補彙總與匯出 ---------- */
function vZb() {
  const rows = O.filter(o => used(o)); const pay = rows.filter(o => zb(o) > 0), ret = rows.filter(o => zb(o) < 0);
  const sp = pay.reduce((s, o) => s + zb(o), 0), sr = ret.reduce((s, o) => s - zb(o), 0);
  $('#main').innerHTML = `<div class="ph"><h1>找補彙總與匯出</h1><button class="btn pri" id="x1">匯出全部資料（Excel）</button><span class="hint">建議每天收工前匯出一次備份</span></div>
  <div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="stat bad"><div class="n">${fmt(sp / 10000)}<span style="font-size:13px"> 萬</span></div><div class="l">地主應補差額合計（${pay.length} 人）</div></div><div class="stat ok"><div class="n">${fmt(sr / 10000)}<span style="font-size:13px"> 萬</span></div><div class="l">實施者應退合計（${ret.length} 人）</div></div><div class="stat"><div class="n">${fmt((sp - sr) / 10000)}<span style="font-size:13px"> 萬</span></div><div class="l">淨額</div></div></div>
  <div class="wrapx"><table class="list"><thead><tr><th>編號</th><th>地主</th><th>選配內容</th><th class="r">應分配權利價值</th><th class="r">選配總價</th><th class="r">找補</th></tr></thead><tbody>
  ${rows.map(o => { const z = zb(o); return `<tr><td class="num">${o.no}</td><td>${esc(o.name)}</td><td class="num">${o.u.concat(o.p).concat(groupsOf(o.no).length ? ['（合併）'] : []).join('、')}</td><td class="r num">${fmt(o.value)}</td><td class="r num">${fmt(used(o))}</td><td class="r num zb ${z > 0 ? 'pay' : 'ret'}">${z > 0 ? '補' : '退'} ${fmt(Math.abs(z))}</td></tr>`; }).join('')}</tbody></table></div>`;
  $('#x1').onclick = exportAll;
}
async function exportAll() {
  busy(true, '產生 Excel…');
  try {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    const CL = claims();
    const s1 = O.map(o => {
      const r = { 編號: o.no, 地主: o.name, 委託人: o.agent, 參與狀態: o.st, 狀態: status(o, CL)[0], 個人選配戶別: o.u.join('、'), 個人選配車位: o.p.join('、'),
        合併選配: groupsOf(o.no).map(g => g.u.concat(g.p).join('、')).join('；'), 合併出資: contrib(o), 應分配權利價值: o.value, 選配上限: cap(o), 選配總價: used(o), 找補: used(o) ? zb(o) : '',
        選配日期: o.date, 電話: o.phone, 地址: o.addr, 身分證字號: o.idno, 備註: o.note };
      DOCS.forEach((d, i) => r[d.name] = need(o).includes(i) || d.applies === 'optional' ? DSTATE[o.docs[i]] : '不需');
      return r;
    });
    const s2 = G.flatMap(g => g.m.map(([no, amt]) => ({ 合併組: g.id, 地主編號: no, 地主: ON[no].name, 選配: g.u.concat(g.p).join('、'), 選配總價: gtotal(g), 出資: amt, 剩餘權值: ON[no].value - own(ON[no]), 找補: amt - (ON[no].value - own(ON[no])) })));
    const s3 = Object.values(UINFO).map(u => ({ 單元編號: u.code, 用途: u.use, 總建物坪: u.total, 總價: u.price, 開放: u.open ? '是' : '否', 選配人: (CL[u.code] || []).map(claimName).join('、'), 重複: (CL[u.code] || []).length > 1 ? '是' : '' }));
    const s4 = Object.values(PINFO).map(p => ({ 車位編號: p.code, 樓層: p.floor, 類型: p.type, 尺寸: p.size, 價格: p.price, 開放: p.open ? '是' : '否', 選配人: (CL[p.code] || []).map(claimName).join('、'), 重複: (CL[p.code] || []).length > 1 ? '是' : '' }));
    const wb = XLSX.utils.book_new();
    [['地主選配', s1], ['合併組', s2], ['房屋單元', s3], ['車位', s4]].forEach(([n, d]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.length ? d : [{}]), n));
    const blob = new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${SET.short_name || '選屋'}_選配結果_${todayStr()}.xlsx`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) { toast('匯出失敗：' + e.message); }
  busy(false);
}

/* ---------- 公告 ---------- */
function vAnn() {
  $('#main').innerHTML = `<div class="ph"><h1>公告管理</h1><p class="desc">公告會顯示在前台首頁，依日期新到舊排列。${isAdmin() ? '' : '只有管理員可以新增或刪除公告。'}</p></div>
  ${isAdmin() ? `<div class="gcard stack"><div class="row2"><label class="f">標題<input id="a-t" placeholder="例：抽籤結果公告"></label><label class="f">日期<input id="a-d" type="date" value="${todayStr()}"></label></div><label class="f">內容<textarea id="a-c"></textarea></label><div class="mf" style="margin:0"><button class="btn pri" id="a-s">發布到前台</button></div></div>` : ''}
  ${ANN.map(a => `<div class="gcard"><div class="ph" style="margin:0"><h3>${esc(a.title)}</h3><span class="sub">${esc(a.date)}</span>${a.published ? '' : '<span class="badge b-mute">未發布</span>'}<span style="flex:1"></span>${isAdmin() ? `<button class="btn sm" data-ap="${a.id}">${a.published ? '下架' : '發布'}</button><button class="btn sm" data-ad="${a.id}">刪除</button>` : ''}</div><p style="margin:6px 0 0;white-space:pre-wrap">${esc(a.content)}</p></div>`).join('')}`;
  if (!isAdmin()) return;
  $('#a-s').onclick = async () => { const t = $('#a-t').value.trim(); if (!t) return $('#a-t').focus(); const { error } = await sb.from('announcements').insert({ title: t, content: $('#a-c').value, date: $('#a-d').value || todayStr() }); if (error) return toast('發布失敗：' + error.message); await refresh(); toast('公告已發布'); };
  $$('[data-ad]').forEach(b => b.onclick = () => confirmBox('刪除這則公告？', async () => { await sb.from('announcements').delete().eq('id', +b.dataset.ad); await refresh(); }, '刪除'));
  $$('[data-ap]').forEach(b => b.onclick = async () => { const a = ANN.find(x => x.id === +b.dataset.ap); await sb.from('announcements').update({ published: !a.published }).eq('id', a.id); await refresh(); });
}

/* ---------- 匯入資料（標準 Excel 範本） ---------- */
let IMP = null;
function vImport() {
  $('#main').innerHTML = `<div class="ph"><h1>匯入資料</h1><p class="desc">使用「選屋系統_匯入範本.xlsx」，包含「地主」「房屋單元」「車位」三個工作表。已存在的編號會更新，新的編號會新增；身分證、電話、地址只有在 Excel 有填時才會覆蓋。</p></div>
  <label class="drop" for="x-in">選擇 Excel 檔<input type="file" id="x-in" accept=".xlsx,.xls" hidden></label>
  <div id="imp"></div>`;
  $('#x-in').onchange = e => readExcel(e.target.files[0]);
  if (IMP) showImp();
}
async function readExcel(file) {
  if (!file) return; busy(true, '讀取 Excel…');
  try {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    const wb = XLSX.read(await file.arrayBuffer());
    const sh = n => wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '' }) : [];
    const num = v => v === '' || v == null ? null : Number(String(v).replace(/[,\s元]/g, ''));
    const str = v => String(v ?? '').trim();
    const E = [];
    const owners = sh('地主').filter(r => num(r['編號'])).map(r => {
      const o = { no: num(r['編號']), name: str(r['所有權人']), agent: str(r['委託人／代理人']), before_value: num(r['更新前土地權利價值(元)']), ratio: num(r['更新前權利價值比率']), value: num(r['更新後應分配權利價值(元)']),
        store_priority: str(r['店面優先']) === '是', no_merge: str(r['不得合併']) === '是' };
      if (str(r['身分證字號'])) o.id_no = str(r['身分證字號']).toUpperCase();
      if (str(r['聯絡電話'])) o.phone = str(r['聯絡電話']);
      if (str(r['通訊地址'])) o.address = str(r['通訊地址']);
      if (str(r['備註'])) o.note = str(r['備註']);
      if (!o.name || !o.value) E.push(`地主第 ${o.no} 號缺少姓名或權值`);
      return o;
    });
    const units = sh('房屋單元').filter(r => str(r['單元編號']) && num(r['序號'])).map(r => ({ code: str(r['單元編號']).toUpperCase(), use: str(r['使用類別']) || '住宅', floor: str(r['樓層']).toUpperCase(), unit: str(r['戶別']).toUpperCase(),
      main: num(r['主建物(坪)']), aux: num(r['附屬建物(坪)']), common: num(r['共有部分(坪)']), total: num(r['總建物(坪)']), price_per: num(r['建物單價(元/坪)']), terrace: num(r['露臺面積(坪)']), terrace_per: num(r['露臺單價(元/坪)']), terrace_val: num(r['露臺總價值(元)']),
      price: num(r['總價(元，含露臺)']), open: str(r['開放狀態']) !== '保留', sort: num(r['序號']) || 0 }));
    const parking = sh('車位').filter(r => str(r['車位編號']) && num(r['序號'])).map(r => ({ code: str(r['車位編號']).toUpperCase(), floor: str(r['樓層']).toUpperCase(), type: str(r['類型']), size: str(r['尺寸']), price: num(r['價格(元)']), open: str(r['開放狀態']) !== '保留', sort: num(r['序號']) || 0 }));
    units.forEach(u => { if (!u.price) E.push(`${u.code} 缺少總價`); if (u.code !== `${u.floor}-${u.unit}`) E.push(`${u.code} 的單元編號應為「樓層-戶別」（${u.floor}-${u.unit}）`); });
    parking.forEach(p => { if (!p.price) E.push(`${p.code} 缺少價格`); });
    const dupNo = owners.map(o => o.no).filter((n, i, a) => a.indexOf(n) !== i); if (dupNo.length) E.push('地主編號重複：' + [...new Set(dupNo)].join('、'));
    IMP = { file: file.name, owners, units, parking, E };
  } catch (e) { IMP = { E: ['讀取失敗：' + e.message], owners: [], units: [], parking: [] }; }
  busy(false); showImp();
}
function showImp() {
  const sum = a => a.reduce((s, x) => s + (x.value || x.price || 0), 0);
  $('#imp').innerHTML = `<div class="gcard imp"><strong>${esc(IMP.file || '')}</strong>
  <div>地主 ${IMP.owners.length} 位（權值合計 ${fmt(sum(IMP.owners))}）· 房屋單元 ${IMP.units.length} 戶 · 車位 ${IMP.parking.length} 個</div>
  ${IMP.E.slice(0, 20).map(e => `<div class="msg e">${esc(e)}</div>`).join('')}${IMP.E.length > 20 ? `<div class="msg e">…另有 ${IMP.E.length - 20} 個問題</div>` : ''}
  <div class="mf" style="margin:0"><button class="btn ok" id="imp-go" ${IMP.E.length || !(IMP.owners.length + IMP.units.length + IMP.parking.length) ? 'disabled' : ''}>匯入</button></div></div>`;
  $('#imp-go').onclick = () => confirmBox(`匯入 ${IMP.owners.length} 位地主、${IMP.units.length} 戶、${IMP.parking.length} 個車位？已選配的資料不會被刪除。`, async () => {
    busy(true, '匯入中…');
    try {
      for (const [t, rows, key] of [['owners', IMP.owners, 'no'], ['units', IMP.units, 'code'], ['parking', IMP.parking, 'code']]) {
        for (let i = 0; i < rows.length; i += 500) { const { error } = await sb.from(t).upsert(rows.slice(i, i + 500), { onConflict: key }); if (error) throw new Error(t + '：' + error.message); }
      }
      await sb.from('audit_log').insert({ action: '匯入資料', detail: `${IMP.file}：地主 ${IMP.owners.length}、房屋 ${IMP.units.length}、車位 ${IMP.parking.length}` });
      IMP = null; await refresh(); toast('匯入完成');
    } catch (e) { toast('匯入失敗：' + e.message); }
    busy(false);
  }, '匯入');
}

/* ---------- 案件設定 ---------- */
function vSettings() {
  const s = SET, ms = s.milestones || [];
  const sel = (id, v, opts) => `<select id="${id}">${opts.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const tg = (id, l, c) => `<label class="toggle">${l}<input type="checkbox" id="${id}" ${c ? 'checked' : ''}></label>`;
  $('#main').innerHTML = `<div class="ph"><h1>案件設定</h1><span class="updated">只有管理員看得到這頁</span><span style="flex:1"></span><button class="btn pri" id="s-save">儲存設定</button></div>
  <div class="set">
   <section><h2>基本資料</h2><label class="f">個案名稱<input id="s-case_name" value="${esc(s.case_name)}"></label><div class="row2"><label class="f">簡稱<input id="s-short_name" value="${esc(s.short_name)}"></label><label class="f">地區<input id="s-location" value="${esc(s.location)}"></label></div><label class="f">實施者<input id="s-developer" value="${esc(s.developer)}"></label><label class="f">服務專線<input id="s-contact" value="${esc(s.contact)}"></label>${tg('s-test_mode', '測試模式（前台顯示「測試頁面」橫幅）', s.test_mode)}</section>
   <section><h2>時程</h2><div class="row2"><label class="f">申請分配開始<input type="date" id="s-apply_start" value="${esc(s.apply_start)}"></label><label class="f">申請分配截止<input type="date" id="s-apply_end" value="${esc(s.apply_end)}"></label></div><label class="f">截止時間<input type="time" id="s-apply_end_time" value="${esc(s.apply_end_time || '17:00')}"></label><label class="f">公開抽籤（時間地點）<input id="s-lottery_text" value="${esc(s.lottery_text)}"></label>
     <div class="f" style="font-size:13px;color:var(--ink3)">前台時程列</div><div id="ms">${ms.map((m, i) => msRow(m, i)).join('')}</div><button class="btn sm" id="ms-add" style="justify-self:start">＋ 新增階段</button></section>
   <section><h2>選配規則</h2><div class="row2"><label class="f">選配上限（權值 %）<input id="s-cap" value="${Math.round((s.cap_ratio || 1.1) * 1000) / 10}" inputmode="decimal"></label><label class="f">最小分配單元價值（元）<input id="s-min_unit_value" value="${s.min_unit_value || 0}" inputmode="numeric"></label></div>
     <label class="f">每戶最多搭配車位<input id="s-park_per_unit" value="${s.park_per_unit || 1}" inputmode="numeric"></label>
     <label class="f">超出上限時${sel('s-over_cap_mode', s.over_cap_mode || 'approve', [['approve', '擋下，管理員註記協議後才可登錄'], ['block', '直接擋下'], ['allow', '可登錄，標示「超選」']])}</label>
     <label class="f">重複選配時${sel('s-dup_mode', s.dup_mode || 'allow', [['allow', '可登錄，標示「重複待抽籤」'], ['block', '直接擋下']])}</label>
     <label class="f">合併選配上限${sel('s-merge_cap_mode', s.merge_cap_mode || 'group', [['group', '只檢查全組總額'], ['each', '每人出資不可超過自己的額度']])}</label></section>
   <section><h2>保留戶</h2><p class="hint" style="margin:0">保留戶、不開放戶在「匯入資料」的 Excel 用「開放狀態＝保留」設定，也可以在這裡直接改。</p><label class="f">不開放的戶別／車位（逗號分隔）<input id="s-closed" value="${[...R].join(', ')}"></label></section>
   <section><h2>文件</h2><div id="docs">${DOCS.map((d, i) => docRow(d, i)).join('')}</div><button class="btn sm" id="doc-add" style="justify-self:start">＋ 新增文件</button>
     <label class="f">Google Drive 上傳網址（Apps Script 部署網址）<input id="s-drive_script_url" value="${esc(s.drive_script_url)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
     <p class="hint" style="margin:0">檔名格式：編號_姓名_文件名稱.pdf，存在 Drive 的「編號_姓名」資料夾。</p></section>
   <section><h2>前台顯示</h2>${tg('s-show_names', '銷控表顯示選配人姓名', s.show_names)}${tg('s-show_prices', '顯示房屋與車位價格', s.show_prices)}${tg('s-show_plans', '顯示平面圖', s.show_plans !== false)}<label class="f">自動更新間隔（秒）<input id="s-refresh_sec" value="${s.refresh_sec || 30}" inputmode="numeric"></label>
     <label class="f">前台存取密碼（測試期間用；留空＝所有人都能看）<input id="s-public_passcode" value="${esc(s.public_passcode || '')}" autocomplete="off"></label></section>
   <section style="grid-column:1/-1"><h2>人員與權限</h2><div class="wrapx"><table class="list"><thead><tr><th>Email</th><th>姓名</th><th>角色</th><th></th></tr></thead><tbody>${STAFF.map(p => `<tr><td>${esc(p.email)}</td><td>${esc(p.name)}</td><td>${p.role === 'admin' ? '管理員' : '選屋人員'}</td><td class="r">${p.email.toLowerCase() === ME.email.toLowerCase() ? '<span class="sub">（你）</span>' : `<button class="btn sm" data-rm="${esc(p.email)}">移除</button>`}</td></tr>`).join('')}</tbody></table></div>
     <div class="row2"><label class="f">Email<input id="n-email" type="email"></label><label class="f">姓名<input id="n-name"></label></div><label class="f">角色${sel('n-role', 'staff', [['staff', '選屋人員（登錄選屋、上傳文件、記錄通話）'], ['admin', '管理員（另可改設定、匯入、刪除合併組、核准超選）']])}</label>
     <button class="btn" id="n-add" style="justify-self:start">＋ 加入人員</button>
     <p class="hint" style="margin:0">加入名單後，還要在 Supabase → Authentication → Users → Add user 用同一個 Email 建立帳號和密碼，對方才能登入。</p></section>
  </div>`;
  $('#ms-add').onclick = () => { $('#ms').insertAdjacentHTML('beforeend', msRow({ name: '', date: '', status: '' }, $$('#ms .ms-row').length)); bindRm(); };
  $('#doc-add').onclick = () => { $('#docs').insertAdjacentHTML('beforeend', docRow({ name: '', applies: 'participate' }, $$('#docs .ms-row').length)); bindRm(); };
  bindRm();
  $('#n-add').onclick = async () => {
    const email = $('#n-email').value.trim().toLowerCase(); if (!email) return $('#n-email').focus();
    const { error } = await sb.from('staff').upsert({ email, name: $('#n-name').value.trim(), role: $('#n-role').value });
    if (error) return toast('加入失敗：' + error.message); await refresh(); toast('已加入人員名單');
  };
  $$('[data-rm]').forEach(b => b.onclick = () => confirmBox(`把 ${esc(b.dataset.rm)} 移出人員名單？對方將無法再登入後台。`, async () => { await sb.from('staff').delete().eq('email', b.dataset.rm); await refresh(); }, '移除'));
  $('#s-save').onclick = saveSettings;
}
const msRow = (m, i) => `<div class="ms-row" style="margin-bottom:6px"><input data-ms="name" value="${esc(m.name)}" placeholder="階段名稱"><input data-ms="date" value="${esc(m.date)}" placeholder="日期，例 115/08/12"><select data-ms="status"><option value="">未開始</option><option value="now" ${m.status === 'now' ? 'selected' : ''}>進行中</option><option value="done" ${m.status === 'done' ? 'selected' : ''}>已完成</option></select><button class="btn sm" data-x aria-label="刪除">×</button></div>`;
const docRow = (d, i) => `<div class="ms-row" style="margin-bottom:6px;grid-template-columns:1fr 160px 32px"><input data-dn value="${esc(d.name)}" placeholder="例：附件二 意願調查表"><select data-da><option value="all" ${d.applies === 'all' ? 'selected' : ''}>全部地主</option><option value="participate" ${d.applies === 'participate' ? 'selected' : ''}>參與選配者</option><option value="merge" ${d.applies === 'merge' ? 'selected' : ''}>合併選配者</option><option value="optional" ${d.applies === 'optional' ? 'selected' : ''}>選填</option></select><button class="btn sm" data-x aria-label="刪除">×</button></div>`;
function bindRm() { $$('[data-x]').forEach(b => b.onclick = () => b.parentElement.remove()); }
async function saveSettings() {
  const v = id => $('#s-' + id).value.trim(), c = id => $('#s-' + id).checked;
  const docs = [...$$('#docs .ms-row')].map(r => ({ name: r.querySelector('[data-dn]').value.trim(), applies: r.querySelector('[data-da]').value })).filter(d => d.name);
  if (docs.length < DOCS.length) { const ok = await new Promise(r => confirmBox('你刪除了文件項目。已記錄的收件狀態是依順序對應的，刪除中間的項目會讓後面的狀態錯位。確定要儲存？', () => r(true))); if (!ok) return; }
  const rows = [
    ['case_name', v('case_name')], ['short_name', v('short_name')], ['location', v('location')], ['developer', v('developer')], ['contact', v('contact')], ['test_mode', c('test_mode')],
    ['apply_start', v('apply_start')], ['apply_end', v('apply_end')], ['apply_end_time', v('apply_end_time')], ['lottery_text', v('lottery_text')],
    ['milestones', [...$$('#ms .ms-row')].map(r => ({ name: r.querySelector('[data-ms=name]').value.trim(), date: r.querySelector('[data-ms=date]').value.trim(), status: r.querySelector('[data-ms=status]').value })).filter(m => m.name)],
    ['cap_ratio', Math.round(Number(v('cap')) * 10) / 1000], ['min_unit_value', Number(v('min_unit_value').replace(/,/g, '')) || 0], ['park_per_unit', Number(v('park_per_unit')) || 1],
    ['over_cap_mode', v('over_cap_mode')], ['dup_mode', v('dup_mode')], ['merge_cap_mode', v('merge_cap_mode')],
    ['docs', docs], ['drive_script_url', v('drive_script_url')],
    ['show_names', c('show_names')], ['show_prices', c('show_prices')], ['show_plans', c('show_plans')], ['refresh_sec', Math.max(10, Number(v('refresh_sec')) || 30)], ['public_passcode', v('public_passcode')]];
  const capv = rows.find(r => r[0] === 'cap_ratio')[1];
  if (!(capv > 0.5 && capv < 3)) return toast('選配上限請填百分比，例如 110');
  busy(true, '儲存設定…');
  try {
    const priv = new Set(['over_cap_mode', 'dup_mode', 'merge_cap_mode', 'drive_script_url', 'public_passcode']);
    const { error } = await sb.from('settings').upsert(rows.map(([key, value]) => ({ key, value, is_public: !priv.has(key) })));
    if (error) throw new Error(error.message);
    const closed = new Set(parse(v('closed')));
    const chU = Object.values(UINFO).filter(u => u.open === closed.has(u.code)).map(u => ({ ...u, open: !closed.has(u.code) }));
    const chP = Object.values(PINFO).filter(p => p.open === closed.has(p.code)).map(p => ({ ...p, open: !closed.has(p.code) }));
    if (chU.length) { const { error: e1 } = await sb.from('units').upsert(chU); if (e1) throw new Error(e1.message); }
    if (chP.length) { const { error: e2 } = await sb.from('parking').upsert(chP); if (e2) throw new Error(e2.message); }
    await sb.from('audit_log').insert({ action: '修改案件設定', detail: '' });
    await refresh(); toast('設定已儲存');
  } catch (e) { toast('儲存失敗：' + e.message); }
  busy(false);
}

/* ---------- 啟動 ---------- */
$('#menu').onclick = () => $('#side').classList.toggle('show');
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if ($('#modal-root').innerHTML) closeModal(); else if (V.drawer) { V.drawer = null; render(); } } });
boot().catch(e => { document.body.insertAdjacentHTML('afterbegin', `<p class="msg e" style="margin:16px">啟動失敗：${esc(e.message)}</p>`); });
