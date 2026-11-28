/* ===== نظام المحاسب - منطق الواجهة =====
 * كل المستندات (فواتير، سندات، رواتب، يوميات، صيانة...) تولّد قيوداً محاسبية تلقائياً،
 * وكل الأرصدة (الحسابات، العملاء، الموردون، الخزائن، المخزون) تُحسب من الحركات ولا تُكتب يدوياً.
 */
(() => {

  // ---------- أدوات ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const sum = (arr, f) => arr.reduce((s, x) => s + (+f(x) || 0), 0);
  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ask = msg => importing || confirm(msg);
  const today = () => new Date().toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const accCode = v => String(v ?? '').split(' - ')[0].trim();


  // =====================================================================
  //                         طبقة قاعدة البيانات
  // سحابية مشتركة (claude.ai) — كل سجل مستند مستقل في مجموعة باسم الجدول،
  // ومزامنة لحظية بين كل المستخدمين والأجهزة. وإلا: محلية في المتصفح.
  // =====================================================================
  const APP_VERSION = '27/11/2026, 11:45';
  const LOCAL_KEY = 'acc-erp-v4';
  const PREFS_KEY = 'acc-erp-prefs';
  const DB_CAPACITY = 25000;
  const SETTINGS_PATH = 'meta/settings';
  const APPR_PATH = 'meta/approvals';
  const TABLES = ['appUsers', 'accounts', 'customers', 'suppliers', 'items', 'warehouses', 'departments', 'employees', 'attendance', 'payroll', 'leaves',
    'workers', 'dailyLabor', 'advances', 'cashboxes', 'receipts', 'payments', 'boxTransfers', 'journal', 'salesInvoices', 'salesQuotes', 'salesReturns',
    'purchaseOrders', 'purchaseInvoices', 'purchaseReturns', 'stockIn', 'stockOut', 'transfers', 'machines', 'machineOps', 'maintenanceOrders', 'maintenancePlan',
    'units', 'costCenters', 'crops', 'girlsFixed', 'girlsTemp', 'bangladesh', 'branches', 'salesItems', 'supplierAccruals', 'openingBalances',
    'expenseOrders', 'supplierPayReqs', 'purchaseQuotes', 'fixedAssets', 'stockRequests'];
  const TX_TABLES = ['journal', 'openingBalances', 'receipts', 'payments', 'boxTransfers', 'supplierAccruals', 'salesInvoices', 'salesQuotes', 'salesReturns', 'purchaseOrders', 'purchaseInvoices', 'purchaseReturns',
    'stockIn', 'stockOut', 'transfers', 'attendance', 'payroll', 'leaves', 'dailyLabor', 'advances', 'machineOps', 'maintenanceOrders'];
  const APP_NAME = 'Sawah ERP';
  // اسم البرنامج المعروض: اسم الشركة من الإعدادات إن وُجد، وإلا الاسم الافتراضي (والاسم القديم يُعامل كافتراضي)
  const appName = () => { const c = (db.settings.company || '').trim(); return c && !['نظام المحاسب', 'Sawah System'].includes(c) ? c : APP_NAME; };
  const DEFAULT_SETTINGS = { company: APP_NAME, taxNo: '', commercialReg: '', currency: 'ج.م', vat: 14, fiscalStart: `${new Date().getFullYear()}-01-01`, address: '' };
  const emptyDb = () => ({ ...Object.fromEntries(TABLES.map(t => [t, []])), settings: { ...DEFAULT_SETTINGS }, approvalCfg: {} });
  const normalize = data => {
    const d = emptyDb();
    for (const t of TABLES) if (Array.isArray(data?.[t])) d[t] = data[t].map(r => ({ ...r, id: String(r.id ?? genId()) }));
    if (data?.settings) Object.assign(d.settings, data.settings);
    if (data?.approvalCfg) d.approvalCfg = structuredClone(data.approvalCfg);
    return d;
  };
  const stripMeta = r => { const { id, _at, _by, _u, ...rest } = r; return rest; };
  const sortDeep = v => Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortDeep(v[k])])) : v;
  const stable = o => JSON.stringify(sortDeep(o));

  let db = emptyDb();
  let cache = {};
  const memo = (k, f) => (k in cache ? cache[k] : (cache[k] = f()));
  const store = { mode: 'loading', cloud: null, saved: new Map(), queue: [], pumping: false, status: 'connecting', lastSync: null,
    me: { id: null, name: '', avatarUrl: '', isOwner: false, canEdit: false }, user: null, canWrite: true, canAdmin: true, ready: false };
  let prefs = { fav: ['dashboard', 'salesInvoices', 'receipts', 'payments', 'accounts', 'journal', 'items', 'customers', 'reports', 'stockBalances'], pinned: true };

  function save(opts = {}) {
    cache = {};
    if (store.mode === 'local') { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(db)); } catch {} return; }
    if (store.mode !== 'cloud') return;
    // يحسب الفرق بين الذاكرة وآخر حالة محفوظة، ويضيف عمليات الكتابة إلى الطابور فوراً
    const seen = new Set();
    for (const t of TABLES) for (const r of db[t]) {
      const path = `${t}/${r.id}`; seen.add(path);
      const cmp = stable(stripMeta(r)), prev = store.saved.get(path);
      if (prev === cmp) continue;
      r._at = new Date().toISOString(); if (store.me.id) r._by = store.me.id;
      const cu = curUser(); if (cu) r._u = cu.username;
      store.queue.push({ path, body: { ...stripMeta(r), _at: r._at, ...(r._by ? { _by: r._by } : {}), ...(r._u ? { _u: r._u } : {}) }, cmp, prev });
      store.saved.set(path, cmp);
    }
    for (const path of [...store.saved.keys()]) if (path !== SETTINGS_PATH && path !== APPR_PATH && !seen.has(path)) {
      store.queue.push({ path, del: true, prev: store.saved.get(path) }); store.saved.delete(path);
    }
    const sc = stable(db.settings);
    if (opts.settings && store.saved.get(SETTINGS_PATH) !== sc) { store.queue.push({ path: SETTINGS_PATH, body: { ...db.settings }, cmp: sc, prev: store.saved.get(SETTINGS_PATH) }); store.saved.set(SETTINGS_PATH, sc); }
    const ac = stable(db.approvalCfg || {});
    if (opts.approvals && store.saved.get(APPR_PATH) !== ac) { store.queue.push({ path: APPR_PATH, body: structuredClone(db.approvalCfg || {}), cmp: ac, prev: store.saved.get(APPR_PATH) }); store.saved.set(APPR_PATH, ac); }
    pump();
  }

  // الكتابة للسحابة: عدة عمليات متوازية (أسرع كثيراً عند الاستيراد)، مع إعادة المحاولة عند الضغط أو الانقطاع المؤقت،
  // ولا تُكتب وثيقتان لنفس المسار في نفس الوقت حتى يبقى الترتيب صحيحاً
  const PUMP_WORKERS = 4; let WRITE_GAP = 220; // حد السرعة: حوالي 4.5 عملية في الثانية حتى لا نتجاوز حد السحابة
  store.inflight = new Map(); // عمليات قيد الإرسال الآن: تُعامل كتعديلات لم تُحفظ بعد حتى لا ترجعها لقطة أقدم من السحابة
  let nextSlot = 0, pauseUntil = 0, pauseStep = 0;
  const waitSlot = async () => { for (;;) { const now = Date.now(), at = Math.max(nextSlot, pauseUntil); if (at <= now) { nextSlot = now + WRITE_GAP; return; } await sleep(at - now); } };
  // النتيجة: 'ok' أو 'requeue' (تجاوز حد السرعة: تعود للطابور ويتوقف الحفظ مؤقتاً ثم يُستأنف تلقائياً) أو 'failed'
  async function writeOp(op) {
    const run = () => op.del ? store.cloud.doc(op.path).delete() : store.cloud.doc(op.path).set(op.body);
    for (let i = 0; ; i++) {
      await waitSlot();
      try { await run(); pauseStep = 0; return 'ok'; }
      catch (e) {
        if (e?.code === 'resource_exhausted') {
          pauseStep = Math.min(pauseStep + 1, 6); pauseUntil = Date.now() + Math.min(60000, 2500 * 2 ** (pauseStep - 1)) + Math.random() * 1000;
          setSync('paused'); return 'requeue';
        }
        if (e?.code === 'unavailable' && i < 5) { await sleep(Math.min(8000, 500 * 2 ** i) + Math.random() * 500); continue; }
        writeFailed(e, op); return 'failed';
      }
    }
  }
  async function pump() {
    if (store.pumping || !store.queue.length) return;
    store.pumping = true; setSync('saving');
    const busy = new Set();
    const worker = async () => {
      while (store.queue.length) {
        const ix = store.queue.findIndex(o => !busy.has(o.path));
        if (ix < 0) { await sleep(50); continue; }
        const [op] = store.queue.splice(ix, 1); busy.add(op.path); store.inflight.set(op.path, op);
        let res = 'ok';
        try { res = await writeOp(op); } finally { busy.delete(op.path); if (store.inflight.get(op.path) === op) store.inflight.delete(op.path); }
        if (res === 'requeue') store.queue.unshift(op); // لم تُحفظ بعد: تعود أول الطابور بنفس ترتيبها
        setSync(Date.now() < pauseUntil ? 'paused' : 'saving');
      }
    };
    await Promise.all(Array.from({ length: PUMP_WORKERS }, worker));
    store.pumping = false; store.lastSync = new Date(); setSync('saved');
    if (store.queue.length) pump();
  }
  // تحذير عند إغلاق الصفحة قبل اكتمال الحفظ
  addEventListener('beforeunload', e => { if (store.mode === 'cloud' && (store.queue.length || store.pumping)) { e.preventDefault(); e.returnValue = 'لم يكتمل حفظ البيانات بعد'; return e.returnValue; } });

  function writeFailed(e, op) {
    // التراجع عن التعديل في الذاكرة
    if (op.path === SETTINGS_PATH) { if (op.prev) db.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(op.prev) }; }
    else if (op.path === APPR_PATH) { db.approvalCfg = op.prev ? JSON.parse(op.prev) : {}; }
    else {
      const [t, id] = op.path.split('/');
      db[t] = db[t].filter(r => r.id !== id);
      if (op.prev) db[t].push({ ...JSON.parse(op.prev), id });
    }
    if (op.prev) store.saved.set(op.path, op.prev); else store.saved.delete(op.path);
    cache = {};
    const code = e?.code;
    if (code === 'invalid_argument' || code === 'not_granted') {
      if (op.path.startsWith('accounts/') || op.path.startsWith('meta/') || op.path.startsWith('appUsers/')) toast('هذا التعديل متاح لمدير النظام فقط', 4000);
      else { store.canWrite = false; applyRole(); toast('ليس لديك صلاحية التعديل — وضع المشاهدة فقط', 4000); }
    } else if (code === 'quota_exceeded') toast('امتلأت سعة قاعدة البيانات — احذف بيانات قديمة أو صدّر نسخة احتياطية', 6000);
    else toast('تعذّر الحفظ في قاعدة البيانات — تحقق من الاتصال', 4000);
    scheduleRender();
  }

  // =====================================================================
  //   قاعدة بيانات Supabase — عند فتح البرنامج من رابط GitHub أو تطبيق أندرويد (خارج claude.ai)
  //   البيانات في جدول واحد docs(path, body)، والحماية بقواعد على الخادم (supabase/setup.sql)
  // =====================================================================
  const SUPA = { url: 'https://rodzewcqzlamcerxvokq.supabase.co', key: 'sb_publishable_LvymxkvGinQx8ObxsVDJsg_hCtFQnI1', emailDomain: 'nezam-almohaseb.app',
    lib: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js' };
  const SUPA_REM = 'acc-supa-remember';
  // اسم المستخدم (قد يكون عربياً) ← بريد داخلي ثابت لا يظهر لأحد
  const loginEmail = uname => 'u' + [...enc.encode(String(uname).trim().toLowerCase())].map(b => b.toString(16).padStart(2, '0')).join('') + '@' + SUPA.emailDomain;
  const supaStorage = { // الجلسة في هذه النافذة فقط، إلا إذا اختار المستخدم "حفظ بيانات الدخول"
    area() { try { return localStorage.getItem(SUPA_REM) ? localStorage : sessionStorage; } catch { return sessionStorage; } },
    getItem(k) { try { return this.area().getItem(k); } catch { return null; } },
    setItem(k, v) { try { this.area().setItem(k, v); } catch {} },
    removeItem(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} },
  };
  const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load')); document.head.appendChild(s); });
  const supa = { sb: null, user: null };
  async function supaClient() {
    if (supa.sb) return supa.sb;
    if (!window.supabase?.createClient) await loadScript(SUPA.lib);
    supa.sb = window.supabase.createClient(SUPA.url, SUPA.key, { auth: { storage: supaStorage, persistSession: true, autoRefreshToken: true, storageKey: 'acc-supa-auth' } });
    return supa.sb;
  }
  function supaErr(e) {
    const msg = String(e?.message || e || '');
    const code = e?.code === '42501' || /row-level security|not allowed|permission/i.test(msg) ? 'not_granted'
      : e?.status === 429 || /rate limit|too many/i.test(msg) ? 'resource_exhausted'
      : /fetch|network|timeout|Failed to/i.test(msg) || e?.status === 0 || e?.status >= 500 ? 'unavailable' : 'unknown';
    return Object.assign(new Error(msg), { code });
  }
  // واجهة مطابقة لقاعدة claude.ai (collection/doc/onSnapshot/set/delete) حتى يعمل باقي البرنامج كما هو
  function supaAdapter(sb) {
    const docs = new Map(), colL = new Map(), docL = new Map(), errL = new Set();
    let loaded = false, flushT = null; const dirty = new Set();
    const collOf = p => p.split('/')[0];
    const emitColl = c => { const ls = colL.get(c); if (!ls?.size) return; const list = [];
      for (const [p, b] of docs) if (p.startsWith(c + '/') && p.split('/').length === 2) list.push({ id: p.slice(c.length + 1), data: () => b });
      const snap = { docs: list, metadata: { fromCache: false } }; ls.forEach(f => f(snap)); };
    const docSnap = p => { const b = docs.get(p); return { id: p, exists: b !== undefined, data: () => b }; };
    const emitDoc = p => { const ls = docL.get(p); if (ls?.size) ls.forEach(f => f(docSnap(p))); };
    const flush = () => { flushT = null; const cs = new Set(); for (const p of dirty) { emitDoc(p); cs.add(collOf(p)); } dirty.clear(); cs.forEach(emitColl); };
    const touch = p => { dirty.add(p); if (!flushT) flushT = setTimeout(flush, 120); };
    async function loadAll() {
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from('docs').select('path,body').order('path').range(from, from + 999);
        if (error) throw supaErr(error);
        for (const r of data) docs.set(r.path, r.body);
        if (data.length < 1000) break;
      }
    }
    const start = (async () => {
      sb.channel('acc-docs').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, ev => {
        if (ev.eventType === 'DELETE') { if (ev.old?.path) { docs.delete(ev.old.path); touch(ev.old.path); } }
        else if (ev.new?.path) { docs.set(ev.new.path, ev.new.body); touch(ev.new.path); }
      }).subscribe(st => { if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') errL.forEach(f => f({ code: 'unavailable' })); });
      await loadAll(); loaded = true;
      for (const c of colL.keys()) emitColl(c);
      for (const p of docL.keys()) emitDoc(p);
    })().catch(e => errL.forEach(f => f(supaErr(e))));
    const add = (m, k, f) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(f); return () => m.get(k).delete(f); };
    return {
      ready: start,
      collection: c => ({ onSnapshot(cb, err) { if (err) errL.add(err); const off = add(colL, c, cb); if (loaded) emitColl(c); return off; } }),
      doc: p => ({
        onSnapshot(cb, err) { if (err) errL.add(err); const off = add(docL, p, cb); if (loaded) cb(docSnap(p)); return off; },
        async get() { await start; return docSnap(p); },
        async set(body) { const { error } = await sb.from('docs').upsert({ path: p, coll: collOf(p), body }); if (error) throw supaErr(error); docs.set(p, body); touch(p); },
        async delete() { const { error } = await sb.from('docs').delete().eq('path', p); if (error) throw supaErr(error); docs.delete(p); touch(p); },
      }),
    };
  }
  // بعد نجاح تسجيل الدخول: تحميل البيانات والاشتراك في التغييرات
  let supaReady = null;
  function supaConnect() {
    if (supaReady) return supaReady;
    store.me = { id: supa.user.id, name: '', avatarUrl: '', isOwner: false, canEdit: false };
    store.cloud = supaAdapter(supa.sb);
    try { sessionStorage.setItem('acc-supa-tab', '1'); } catch {}
    supaReady = new Promise(res => { store.onReady = res; });
    loadPrefs(store.cloud).then(() => attachCloud());
    return supaReady;
  }
  // صلاحيات قاعدة البيانات حسب دور المستخدم في البرنامج
  function supaApplyUser(u) {
    const admin = isAdminUser(u);
    store.canAdmin = admin; store.canWrite = true;
    store.me = { ...store.me, name: u.name, isOwner: admin, canEdit: admin };
  }
  // إنشاء/تغيير بيانات دخول مستخدم على الخادم
  async function supaSetPassword(u, pass) {
    const sb = await supaClient();
    if (!u.authId) {
      const tmp = window.supabase.createClient(SUPA.url, SUPA.key, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'acc-supa-tmp' } });
      const { data, error } = await tmp.auth.signUp({ email: loginEmail(u.username), password: pass });
      if (error) throw new Error(/registered|exists/i.test(error.message) ? 'اسم المستخدم مسجّل من قبل على الخادم — اختر اسماً آخر' : 'تعذّر إنشاء حساب الدخول: ' + error.message);
      if (!data.user?.id || data.user.identities?.length === 0) throw new Error('اسم المستخدم مسجّل من قبل على الخادم — اختر اسماً آخر');
      u.authId = data.user.id; u.authEmail = loginEmail(u.username);
    } else if (u.authId === supa.user?.id) {
      const { error } = await sb.auth.updateUser({ password: pass }); if (error) throw new Error('تعذّر تغيير كلمة المرور: ' + error.message);
    } else {
      const { error } = await sb.rpc('acc_admin_set_password', { target: u.authId, new_password: pass }); if (error) throw new Error('تعذّر تعيين كلمة المرور: ' + error.message);
    }
    delete u.passHash; delete u.salt; delete u.iter;
  }
  async function supaSyncLogin(u) { // تغيير اسم المستخدم يغيّر بريد الدخول الداخلي
    if (!u.authId || u.authEmail === loginEmail(u.username)) return;
    const { error } = await supa.sb.rpc('acc_admin_set_login', { target: u.authId, new_email: loginEmail(u.username) });
    if (error) throw new Error('تعذّر تغيير اسم الدخول: ' + error.message);
    u.authEmail = loginEmail(u.username);
  }
  // عند استعادة نسخة احتياطية: يبقى حساب المدير الحالي مرتبطاً بدخوله، وتُنقل روابط الدخول لمن له حساب بنفس الاسم،
  // وتُحذف بصمات كلمات المرور القديمة (الدخول هنا عبر الخادم فقط)
  function supaMergeUsers(oldUsers) {
    const me = oldUsers.find(x => x.authId === supa.user?.id);
    const twin = me && db.appUsers.find(u => u.username === me.username);
    db.appUsers = db.appUsers.filter(u => u !== twin).map(u => {
      const ex = oldUsers.find(x => x.username === u.username && x.authId);
      const nu = { ...u, ...(ex ? { authId: ex.authId, authEmail: ex.authEmail } : {}) };
      delete nu.passHash; delete nu.salt; delete nu.iter; return nu;
    });
    if (me) {
      // نفس اسم المستخدم في النسخة: نحتفظ بمعرّفه القديم (حتى تبقى الاعتمادات والتوقيعات مرتبطة به) مع ربط دخوله الحالي ودور المدير
      const merged = twin ? { ...twin, authId: me.authId, authEmail: me.authEmail, role: 'admin', active: true, perms: me.perms, special: me.special } : me;
      delete merged.passHash; delete merged.salt; delete merged.iter;
      db.appUsers.unshift(merged);
      if (twin && session) { session.uid = merged.id; startSession(merged); }
    }
  }
  async function bootSupa() {
    store.mode = 'cloud'; store.backend = 'supa'; store.canAdmin = false; WRITE_GAP = 40;
    try { await supaClient(); }
    catch { content.innerHTML = '<div class="boot"><p>تعذّر الاتصال بالخادم — تحقق من الإنترنت ثم أعد فتح البرنامج</p></div>'; return; }
    const { data: hu } = await supa.sb.rpc('acc_has_users');
    store.hasUsers = hu !== false;
    const { data: { session: s } } = await supa.sb.auth.getSession();
    let remembered = false; try { remembered = !!localStorage.getItem(SUPA_REM); } catch {}
    setSync('saved');
    // جلسة مفتوحة في نفس النافذة (تحديث الصفحة): متابعة بدون طلب الدخول. غير ذلك: شاشة الدخول دائماً
    let inTab = false; try { inTab = sessionStorage.getItem('acc-supa-tab') === '1'; } catch {}
    // تحديث الصفحة في نفس النافذة لا يخرج من البرنامج (حتى مع حفظ بيانات الدخول)
    if (s?.user && (!remembered || inTab)) { supa.user = s.user; supaConnect(); return; }
    let msg = ''; try { msg = sessionStorage.getItem('acc-logout-msg') || ''; sessionStorage.removeItem('acc-logout-msg'); } catch {}
    showAuth(store.hasUsers ? 'login' : 'setup', msg);
  }
  async function supaLogin(uname, password, remember) {
    try { if (remember) localStorage.setItem(SUPA_REM, '1'); else localStorage.removeItem(SUPA_REM); } catch {}
    const { data, error } = await supa.sb.auth.signInWithPassword({ email: loginEmail(uname), password });
    if (error) return { error: /invalid|credentials/i.test(error.message) ? 'bad' : error.message };
    supa.user = data.user; return { ok: true };
  }
  async function supaLogout(msg) {
    let remembered = false; try { remembered = !!localStorage.getItem(SUPA_REM); sessionStorage.setItem('acc-logout-msg', msg || ''); sessionStorage.removeItem('acc-supa-tab'); } catch {}
    if (!remembered) await supa.sb?.auth.signOut().catch(() => {});
    location.reload();
  }

  // ----- الاتصال -----
  async function boot() {
    content.innerHTML = '<div class="boot"><div class="spinner"></div><p>جارٍ الاتصال بقاعدة البيانات…</p></div>';
    const hasRuntime = typeof window.claude?.use === 'function';
    if (!hasRuntime && SUPA.url && location.protocol !== 'file:') return bootSupa();
    const [cloud, user] = hasRuntime ? await Promise.all([claude.use('db').catch(() => null), claude.use('user').catch(() => null)]) : [null, null];
    store.user = user;
    if (user) {
      const me = await user.me();
      store.me = me;
      const w = await user.can('data.write');
      store.canAdmin = !!(me.isOwner || me.canEdit);
      store.canWrite = w === null ? true : !!w || store.canAdmin;
    }
    await loadPrefs(cloud);
    if (cloud) { store.cloud = cloud; store.mode = 'cloud'; attachCloud(); }
    else await initLocal(hasRuntime);
  }

  function attachCloud() {
    const waiting = new Set([...TABLES, SETTINGS_PATH, APPR_PATH]);
    const ready = () => { if (store.ready) return; store.ready = true; clearTimeout(slowTimer); setSync('saved'); authGate(); store.onReady?.(); };
    const got = key => { waiting.delete(key); if (!waiting.size) ready(); else if (store.ready) scheduleRender(); };
    const slowTimer = setTimeout(() => { setSync('slow'); ready(); }, 10000);
    const fail = e => { if (e?.code === 'revoked') { store.canWrite = false; applyRole(); } setSync('error'); };
    for (const t of TABLES) {
      store.cloud.collection(t).onSnapshot(snap => {
        for (const k of [...store.saved.keys()]) if (k.startsWith(t + '/')) store.saved.delete(k);
        db[t] = snap.docs.map(d => { const body = d.data(); store.saved.set(`${t}/${d.id}`, stable(stripMeta(body))); return { ...structuredClone(body), id: d.id }; });
        for (const op of [...store.inflight.values(), ...store.queue]) if (op.path.startsWith(t + '/')) { // عمليات لم تُرسل بعد أو قيد الإرسال: تبقى ظاهرة
          const id = op.path.split('/')[1]; db[t] = db[t].filter(r => r.id !== id);
          if (!op.del) db[t].push({ ...op.body, id }); if (op.del) store.saved.delete(op.path); else store.saved.set(op.path, op.cmp);
        }
        cache = {}; if (!snap.metadata.fromCache) store.lastSync = new Date();
        got(t); if (store.ready) scheduleRender();
        // وصل المستخدمون بعد عرض شاشة الإعداد الأول (اتصال بطيء): أعد اختيار الشاشة الصحيحة
        if (t === 'appUsers' && store.ready && state.authMode === 'setup' && db.appUsers.length) authGate();
      }, fail);
    }
    store.cloud.doc(SETTINGS_PATH).onSnapshot(snap => {
      db.settings = { ...DEFAULT_SETTINGS, ...(snap.exists ? structuredClone(snap.data()) : {}) };
      if (snap.exists) store.saved.set(SETTINGS_PATH, stable(db.settings));
      cache = {}; got(SETTINGS_PATH); if (store.ready) scheduleRender();
    }, fail);
    store.cloud.doc(APPR_PATH).onSnapshot(snap => {
      if (store.queue.some(op => op.path === APPR_PATH)) return got(APPR_PATH);
      db.approvalCfg = snap.exists ? structuredClone(snap.data()) : {};
      if (snap.exists) store.saved.set(APPR_PATH, stable(db.approvalCfg));
      cache = {}; got(APPR_PATH); if (store.ready) scheduleRender();
    }, fail);
  }

  async function initLocal(hasRuntime) {
    store.mode = 'local';
    let data = null;
    try { data = JSON.parse(localStorage.getItem(LOCAL_KEY)); } catch {}
    if (!data && !hasRuntime) data = await loadSeed();
    db = normalize(data);
    store.ready = true; setSync(hasRuntime ? 'offline' : 'local'); authGate();
  }
  const loadSeed = () => new Promise(res => {
    if (window.ACC_SEED) return res(window.ACC_SEED);
    const s = document.createElement('script'); s.src = 'seed.js';
    s.onload = () => res(window.ACC_SEED || null); s.onerror = () => res(null);
    document.head.appendChild(s);
  });

  // ----- تفضيلات المستخدم (المفضلة وتثبيت القائمة) — تُحفظ لكل مستخدم -----
  const prefsDoc = cloud => cloud && store.me.id ? cloud.doc(`data/users/${store.me.id}/prefs`) : null;
  async function loadPrefs(cloud) {
    try { const p = JSON.parse(localStorage.getItem(PREFS_KEY)); if (p) prefs = { ...prefs, ...p }; } catch {}
    const ref = prefsDoc(cloud);
    if (ref) { try { const snap = await ref.get(); if (snap.exists) prefs = { ...prefs, ...snap.data() }; } catch {} }
  }
  let prefsWriting = Promise.resolve();
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
    const ref = prefsDoc(store.cloud);
    if (ref) { const body = { fav: [...prefs.fav], pinned: prefs.pinned }; prefsWriting = prefsWriting.then(() => ref.set(body)).catch(() => {}); }
  }

  const money = n => `${nf.format(+n || 0)} ${esc(db.settings.currency)}`;
  const num = n => nf.format(+n || 0);
  const nfq = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });
  const qn = n => nfq.format(+n || 0);

  // =====================================================================
  //                      محرك الترحيل والأرصدة
  // =====================================================================
  const acc = code => db.accounts.find(a => a.code === code);
  const accLabel = a => `${a.code} - ${a.name}`;
  const codeSort = (a, b) => a.code.localeCompare(b.code, 'en', { numeric: true });
  const childrenOf = code => db.accounts.filter(a => a.parent === code).sort(codeSort);
  const hasChildren = code => db.accounts.some(a => a.parent === code);
  const leafAccounts = () => db.accounts.filter(a => !hasChildren(a.code)).sort(codeSort);
  // الحسابات التي يرحّل عليها النظام تلقائياً
  const SYS = { cash: '121', banks: '122', customers: '123', inventory: '124', empAdvances: '1281', otherDebit: '128', drawings: '214', suppliers: '231',
    accrued: '233', vat: '234', socialIns: '235', sales: '411', otherRev: '423', salaries: '34101', labor: '32105', maint: '32402', defPurchase: '1246', expenses: '3', revenue: '4', accruedSal: '236', chqIn: '129', chqOut: '237', wht: '238', cogs: '311', openEq: '215', finished: '126' };
  // حسابات المخزون: مخزون المواد الخام (124 وفروعه) + مخزون الإنتاج التام (126)
  const isInvAcc = code => String(code).startsWith(SYS.inventory) || code === SYS.finished;
  // مراكز التكلفة: كل مرتب أو أجر يُحمّل على المصروف التشغيلي أو التسويقي أو الإداري حسب نوع تكلفة الموظف/العامل
  const COST_TYPES = ['تشغيلية', 'تسويقية', 'إدارية'];
  // طبيعة الحساب: من الحساب نفسه أو أقرب أب محدد له طبيعة (مثل مسحوبات الملاك: مدين)، وإلا حسب الرقم الأول
  const isDebitNature = code => memo('nat:' + code, () => {
    for (let a = acc(code); a; a = acc(a.parent)) if (a.nature) return a.nature === 'مدين';
    return code[0] === '1' || code[0] === '3';
  });
  const isTreasury = code => code.startsWith(SYS.cash) || code.startsWith(SYS.banks);
  const catAcc = (parent, cat) => childrenOf(parent).find(a => a.name === cat)?.code || parent;
  const custAcc = name => catAcc(SYS.customers, db.customers.find(c => c.name === name)?.category);
  // حسابات العملاء (فئات تحت 123) وعملاء كل حساب
  const custAccOpts = () => childrenOf(SYS.customers).map(a => [a.code, accLabel(a)]);
  // نفس الاسم قد يتكرر في أكثر من حساب رئيسي (مثلاً مورد سيارات ومورد عمالة): الحساب يُؤخذ من تصنيف السجل نفسه
  const recAcc = (root, r) => catAcc(root, r?.category);
  const custOfAcc = code => [...new Set(db.customers.filter(c => !code || recAcc(SYS.customers, c) === code).map(c => c.name))];
  // المستند يخص حساب الطرف إذا كان حسابه (اسم الحساب) هو نفس الحساب، أو بدون حساب محدد
  const docOnAcc = (doc, code) => { if (!code) return true; const d = accCode(doc.account || doc.sacc || ''); return !d || !(d.startsWith(SYS.customers) || d.startsWith(SYS.suppliers)) || d === code; };
  // إيرادات مواد التعبئة (424)، وإن لم يوجد الحساب تُضم للمبيعات
  const packAcc = () => acc('424') ? '424' : SYS.otherRev;
  const suppAcc = name => catAcc(SYS.suppliers, db.suppliers.find(s => s.name === name)?.category);
  const ownerAcc = name => childrenOf(SYS.drawings).find(a => a.name === name)?.code;
  // فئات المرتبات: كل التزام تحت "أرصدة دائنة أخرى" يقابله مصروف بنفس الاسم بدون "المستحقة" تحت "الأجور والمرتبات"
  const SUFFIX = /\s*(ال)?مستحقة$/;
  // مطابقة الأسماء بدون "ال" والهمزات: "مرتبات العاملين" = "مرتبات عاملين"
  const normName = n => String(n || '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').trim().split(/\s+/).map(w => w.replace(/^ال(?=..)/, '')).join(' ');
  const leafByName = (root, n) => memo('lbn:' + root + ':' + n, () => { const k = normName(n); return leafAccounts().find(a => a.code.startsWith(root) && normName(a.name) === k)?.code; });
  // حساب المصروف = الاسم الأساسي + نوع التكلفة (مثال: مرتبات عاملين تشغيلية)، وإلا الإداري
  const expAcc = (base, ct, def) => leafByName(SYS.expenses, `${base} ${ct || 'إدارية'}`) || leafByName(SYS.expenses, `${base} إدارية`) || leafByName(SYS.expenses, base) || def;
  // فئات المرتبات = الالتزامات تحت "أرصدة دائنة أخرى" التي لها مصروف مقابل (لا تظهر الحراسة أو الدائنون مثلاً)
  const payGroups = () => childrenOf(SYS.accruedSal).map(a => a.name.replace(SUFFIX, '')).filter(n => COST_TYPES.some(ct => leafByName(SYS.expenses, `${n} ${ct}`)));
  const payAccs = (group, ct) => {
    const liab = childrenOf(SYS.accruedSal).find(a => a.name.replace(SUFFIX, '') === group);
    return { liab: liab?.code || SYS.accrued, exp: expAcc(group, ct, SYS.salaries) };
  };
  const workerCost = name => db.workers.find(w => w.name === name)?.costType || 'تشغيلية';
  const laborAcc = ct => expAcc('أجور العمالة', ct, SYS.labor);
  // حساب المبيعات المقابل لفئة العميل: عملاء السوق المحلي ← مبيعات السوق المحلي، وعملاء آخرون ← إيرادات أخرى
  const SALE_TYPES = [['local', 'السوق المحلي'], ['seedlings', 'الشتلات'], ['scrap', 'الخردة'], ['livestock', 'الثروة الحيوانية']];
  const saleType = r => r.stype || (r.account && acc(r.account) ? acc(r.account).name.replace(/^عملاء\s*/, '') : '') || (db.customers.find(c => c.name === r.customer)?.category || '').replace(/^عملاء\s*/, '');
  const salesAccR = r => leafByName(SYS.revenue, 'مبيعات ' + saleType(r)) || SYS.otherRev;
  const salesAcc = name => { const cat = db.customers.find(c => c.name === name)?.category || '';
    return leafByName(SYS.revenue, 'مبيعات ' + cat.replace(/^عملاء\s*/, '')) || SYS.otherRev; };
  // أنواع السلف = حسابات "سلف ..." تحت الأرصدة المدينة الأخرى
  const advCats = () => childrenOf(SYS.otherDebit).filter(a => a.name.startsWith('سلف')).map(a => a.name);
  const advAcc = t => childrenOf(SYS.otherDebit).find(a => a.name === t)?.code || SYS.empAdvances;
  const custCats = () => childrenOf(SYS.customers).map(a => a.name);
  // خيارات "الحساب الرئيسي": حسابات المستوى الرابع تحت الحساب الأب، تُعرض بالكود والاسم
  const mainAccOpts = root => () => childrenOf(root).map(a => [a.name, accLabel(a)]);
  // فئات المرتبات المستحقة (حسابات المستوى الرابع تحت المرتبات المستحقة) — القيمة اسم الفئة بدون "المستحقة"
  const payGroupOpts = () => childrenOf(SYS.accruedSal).filter(a => /مرتبات/.test(a.name)).map(a => [a.name.replace(SUFFIX, ''), accLabel(a)]);
  // كل الحسابات الفرعية (النهائية) تحت حساب في الدليل
  const leafUnder = code => leafAccounts().filter(a => a.code !== code && a.code.startsWith(code)).sort(codeSort);
  const expAccOpts = () => leafAccounts().filter(a => a.code.startsWith(SYS.expenses)).map(accLabel);
  // مجمع إهلاك الأصل حتى تاريخ (قسط ثابت شهري)
  const assetDep = (r, to = today()) => {
    const life = +r.life, base = (+r.cost || 0) - (+r.salvage || 0);
    if (!life || !r.buyDate || base <= 0 || r.buyDate > to) return 0;
    const months = (+to.slice(0, 4) - +r.buyDate.slice(0, 4)) * 12 + (+to.slice(5, 7) - +r.buyDate.slice(5, 7));
    return Math.min(base, Math.max(0, months) * base / (life * 12));
  };
  const suppCats = () => childrenOf(SYS.suppliers).map(a => a.name);
  const nature = code => isDebitNature(code) ? 'مدين' : 'دائن';
  const accType = code => ({ 1: 'أصول', 2: code[1] === '1' ? 'حقوق ملكية' : 'خصوم', 3: 'مصروفات', 4: 'إيرادات' }[code[0]] || '');
  const depth = a => { let d = 0, p = a.parent; while (p) { d++; p = acc(p)?.parent; } return d; };
  const subtree = code => memo('sub:' + code, () => { const s = new Set([code]); const w = c => childrenOf(c).forEach(x => { s.add(x.code); w(x.code); }); w(code); return s; });

  const boxAcc = name => db.cashboxes.find(b => b.name === name)?.accountNo;
  // أطراف القيد اليدوي: [{acc, dr, cr, note}] — والقيود القديمة (من حساب / إلى حساب / مبلغ) تُقرأ كطرفين
  const jLinesOf = r => Array.isArray(r.jlines) && r.jlines.length ? r.jlines : r.debit || r.credit ? [{ acc: r.debit, dr: +r.amount || 0, cr: 0 }, { acc: r.credit, dr: 0, cr: +r.amount || 0 }] : [];
  const jTotal = r => sum(jLinesOf(r), l => +l.dr || 0);
  const isCustomer = n => db.customers.some(c => c.name === n);
  // الرصيد الافتتاحي: نوعه يحدد الحساب، وطبيعة الحساب تحدد هل هو مدين أو دائن
  const OPEN_TYPES = ['خزينة / بنك', 'صنف في مخزن', 'عميل', 'مورد', 'حساب (مرتبات مستحقة، سلف، أصول، التزامات…)'];
  const openAcc = r => r.otype === OPEN_TYPES[0] ? boxAcc(r.box) : r.otype === OPEN_TYPES[1] ? (itemStore(r.item) || SYS.defPurchase)
    : r.otype === OPEN_TYPES[2] ? custAcc(r.party) : r.otype === OPEN_TYPES[3] ? suppAcc(r.party) : accCode(r.account);
  const openTarget = r => r.otype === OPEN_TYPES[0] ? r.box : r.otype === OPEN_TYPES[1] ? `${r.item} — ${r.warehouse} (${num(r.qty)} ${itemUnit(r.item)})`
    : r.otype === OPEN_TYPES[4] ? `${acc(accCode(r.account))?.name || r.account}${r.party ? ' — ' + r.party : ''}` : r.party;
  const natSide = r => { const a = openAcc(r); return a && acc(a) && isDebitNature(a) ? 'مدين' : 'دائن'; };
  // جانب الرصيد: من خانتي المدين/الدائن، والسجلات القديمة (مبلغ واحد) حسب طبيعة الحساب
  const obDr = r => +r.dr || +r.cr ? +r.dr || 0 : natSide(r) === 'مدين' ? +r.amount || 0 : 0;
  const obCr = r => +r.dr || +r.cr ? +r.cr || 0 : natSide(r) === 'دائن' ? +r.amount || 0 : 0;
  const openSide = r => obDr(r) ? 'مدين' : obCr(r) ? 'دائن' : natSide(r);
  // العميل: المدين يزيد رصيده — المورد: الدائن يزيد المستحق له
  const openOf = (kind, name) => sum(eff('openingBalances').filter(r => r.otype === kind && r.party === name), r => kind === OPEN_TYPES[3] ? obCr(r) - obDr(r) : obDr(r) - obCr(r));
  const custOpen = c => +(c?.opening || 0) + (+c?.openDr || 0) - (+c?.openCr || 0);
  const suppOpen = s => +(s?.opening || 0) + (+s?.openCr || 0) - (+s?.openDr || 0);
  // نوع الطرف حسب اسم الحساب: عملاء / موردون / مسحوبات مالك / عاملون / غيرها
  const partyKind = code => !code ? '' : code.startsWith(SYS.customers) ? 'c' : code.startsWith(SYS.suppliers) ? 's' : code.startsWith(SYS.drawings) ? 'o'
    : code.startsWith(SYS.otherDebit) || code.startsWith(SYS.accruedSal) || code.startsWith(SYS.expenses) ? 'e' : '';
  // قبض/صرف يخص عميلاً أو مورداً: السندات القديمة بدون حساب، أو التي حسابها من نفس النوع
  const isPartyDoc = (r, kind) => !r.account || partyKind(accCode(r.account)) === kind;
  const isSupplier = n => db.suppliers.some(s => s.name === n);
  const vatOf = r => +r.amount * (+(r.vatRate ?? db.settings.vat) || 0) / 100;
  const invTotal = r => +r.amount + vatOf(r);

  // كل القيود: اليدوية + المتولدة من المستندات
  const isChq = (r, via) => r.method === 'شيك' && !!acc(via);
  const isEff = r => (!r.appr || r.appr.status === 'approved') && r.chequeStatus !== 'مرتد';
  const eff = t => memo('eff:' + t, () => db[t].filter(isEff));
  // فرع المستند: المكتوب فيه، وإلا من مركز التكلفة أو المخزن أو الخزينة أو الموظف
  const brBox = n => n ? db.cashboxes.find(b => b.name === n)?.branch || '' : '';
  const brWh = n => n ? db.warehouses.find(w => w.name === n)?.branch || '' : '';
  const brCC = n => n ? db.costCenters.find(c => c.name === n)?.branch || '' : '';
  const brStaff = n => { if (!n) return ''; const s = allStaff().find(x => x.name === n); return s ? s.branch || brCC(s.costCenter) : ''; };
  const docBranch = r => r.branch || brCC(r.costCenter) || brWh(r.warehouse) || brBox(r.box) || brStaff(r.employee) || brStaff(r.worker) || brBox(r.from) || brWh(r.from) || '';
  const accBranch = code => memo('ab:' + code, () => db.cashboxes.find(b => b.accountNo === code)?.branch || '');
  function glEntries() {
    return memo('gl', () => {
      const E = [];
      const L = (acc, dr = 0, cr = 0) => ({ acc: String(acc ?? ''), dr: +dr || 0, cr: +cr || 0 });
      const add = (module, src, r, no, date, desc, lines) => {
        lines = lines.filter(l => l.acc && (l.dr || l.cr));
        if (lines.length) E.push({ module, src, id: r.id, no, date, desc, lines, manual: module === 'journal', branch: docBranch(r) });
      };
      eff('journal').forEach(r => add('journal', 'قيد يدوي', r, r.no, r.date, r.desc, jLinesOf(r).map(l => ({ ...L(accCode(l.acc), l.dr, l.cr), note: l.note || '' }))));
      eff('salesInvoices').forEach(r => add('salesInvoices', 'فاتورة مبيعات', r, r.no, r.date, `فاتورة مبيعات آجلة - ${r.customer}`,
        [L(custAcc(r.customer), invTotal(r)), L(salesAccR(r), 0, +r.amount - packOf(r)), L(packAcc(), 0, packOf(r)), L(SYS.vat, 0, vatOf(r))]));
      // تكلفة المبيعات: عند الصرف من المخزن — من حـ/ تكلفة البضاعة المباعة إلى حـ/ مخزون كل صنف (بالتكلفة)، والمردودات بالعكس
      const cogsLines = r => { const inv = {}; if (!r.warehouse || !Array.isArray(r.lines)) return [];
        r.lines.map(stockLine).filter(Boolean).forEach(l => { const it = db.items.find(i => i.name === l.item); const v = baseQty(l) * (+it?.cost || 0); if (!v) return; const a = itemStore(l.item) || SYS.defPurchase; inv[a] = (inv[a] || 0) + v; });
        return Object.entries(inv); };
      eff('salesInvoices').forEach(r => { const c = cogsLines(r); if (c.length) add('salesInvoices', 'تكلفة المبيعات', r, `${r.no}-ت`, r.date, `تكلفة مبيعات الفاتورة ${r.no} — ${linesSummary(r)}`, [L(SYS.cogs, sum(c, x => x[1])), ...c.map(([a, v]) => L(a, 0, v))]); });
      eff('salesReturns').forEach(r => { const c = cogsLines(r); if (c.length) add('salesReturns', 'إعادة للمخزون', r, `${r.no}-ت`, r.date, `إعادة أصناف المردودات ${r.no} للمخزون`, [...c.map(([a, v]) => L(a, v)), L(SYS.cogs, 0, sum(c, x => x[1]))]); });
      eff('salesReturns').forEach(r => add('salesReturns', 'مردودات مبيعات', r, r.no, r.date, `مردودات مبيعات ${saleType(r)} - ${r.customer}`, [L(salesAccR(r), +r.amount - packOf(r)), L(packAcc(), packOf(r)), L(custAcc(r.customer), 0, r.amount)]));
      eff('receipts').forEach(r => { const chq = isChq(r, SYS.chqIn);
        add('receipts', 'سند قبض', r, r.no, r.date, r.desc || `قبض من ${partyName(r)}${chq ? ` — شيك ${r.chequeNo}` : ''}`,
          [L(chq ? SYS.chqIn : boxAcc(r.box), r.amount), L(accCode(r.account) || (isCustomer(r.party) ? custAcc(r.party) : SYS.otherRev), 0, r.amount)]);
        if (chq && r.chequeStatus === 'محصّل') add('receipts', 'تحصيل شيك', r, `${r.no}-ت`, r.clearDate || r.chequeDate || r.date, `تحصيل الشيك ${r.chequeNo} — ${partyName(r)}`,
          [L(boxAcc(r.box), r.amount), L(SYS.chqIn, 0, r.amount)]); });
      // الرصيد الافتتاحي: بين الحساب و حـ/ 215 أرصدة افتتاحية — حسب طبيعة الحساب
      eff('openingBalances').forEach(r => { const a = openAcc(r), d = obDr(r), c = obCr(r); if (!a || !(d || c)) return;
        add('openingBalances', 'رصيد افتتاحي', r, r.no, r.date, r.desc || `رصيد افتتاحي — ${openTarget(r)}`, [L(a, d, c), L(SYS.openEq, c, d)]); });
      // استحقاق المورد: من حـ/ المصروف إلى حـ/ المورد (حساب فئته)
      eff('supplierAccruals').forEach(r => add('supplierAccruals', r.store ? 'استلام من مورد' : 'استحقاق مورد', r, r.no, r.date, r.desc || (r.store ? `استلام ${acc(accCode(r.store))?.name || ''} من ${r.party}${r.docNo ? ' — مستند ' + r.docNo : ''}` : `استحقاق ${r.party} — ${periodText(r)}`),
        [L(accCode(r.store || r.expAcc), r.amount), L(accCode(r.account) || suppAcc(r.party), 0, r.amount)]));
      eff('purchaseInvoices').forEach(r => add('purchaseInvoices', 'فاتورة مشتريات', r, r.no, r.date, `فاتورة مشتريات - ${r.supplier}${r.docNo ? ' — فاتورة ' + r.docNo : r.month || r.from ? ' — ' + periodText(r) : ''}`,
        [L(accCode(r.store || r.expAcc || r.account) || SYS.defPurchase, r.amount), L(accCode(r.sacc) || suppAcc(r.supplier), 0, r.amount)]));
      eff('purchaseReturns').forEach(r => add('purchaseReturns', 'مرتجع مشتريات', r, r.no, r.date, `مرتجع مشتريات - ${r.supplier}`,
        [L(suppAcc(r.supplier), r.amount), L(accCode(r.account) || SYS.defPurchase, 0, r.amount)]));
      eff('payments').forEach(r => { const chq = isChq(r, SYS.chqOut);
        add('payments', 'سند صرف', r, r.no, r.date, r.desc || `صرف إلى ${partyName(r)}${chq ? ` — شيك ${r.chequeNo}` : ''}`,
          [L(accCode(r.account) || (isSupplier(r.party) ? suppAcc(r.party) : ownerAcc(r.party) || SYS.accrued), r.amount), L(chq ? SYS.chqOut : boxAcc(r.box), 0, r.amount)]);
        if (chq && r.chequeStatus === 'مصروف') add('payments', 'صرف شيك', r, `${r.no}-ص`, r.clearDate || r.chequeDate || r.date, `صرف الشيك ${r.chequeNo} — ${partyName(r)}`,
          [L(SYS.chqOut, r.amount), L(boxAcc(r.box), 0, r.amount)]); });
      // إذن الإضافة: من حـ/ المخزون (حساب الإذن أو مخزون كل صنف) و حـ/ ض.ق.م إلى حـ/ المورد (الصافي) و حـ/ ضريبة الخصم والإضافة
      eff('stockIn').forEach(r => { const t = docTotals(r); if (t.sub <= 0) return;
        const inv = {}; linesOf(r).forEach(l => { const a = accCode(r.account) || itemStore(l.item) || SYS.defPurchase; inv[a] = (inv[a] || 0) + lineVal(l); });
        add('stockIn', 'إذن إضافة', r, r.no, r.date, r.notes || `استلام أصناف من ${r.supplier || r.source || ''} — ${linesSummary(r)}`,
          [...Object.entries(inv).map(([a, v]) => L(a, v)), L(SYS.vat, t.vat), L(r.supplier ? suppAcc(r.supplier) : SYS.accrued, 0, t.net), L(SYS.wht, 0, t.wht)]); });
      // إذن الصرف: من حـ/ الحساب المختار (مصروف / مركز تكلفة) إلى حـ/ مخزون كل صنف — بسعر التكلفة
      eff('stockOut').forEach(r => { const tot = docTotals(r).sub; if (tot <= 0 || !accCode(r.account)) return;
        const inv = {}; linesOf(r).forEach(l => { const a = itemStore(l.item) || SYS.defPurchase; inv[a] = (inv[a] || 0) + lineVal(l); });
        add('stockOut', 'إذن صرف', r, r.no, r.date, r.notes || `صرف أصناف إلى ${r.costCenter || r.to || ''} — ${linesSummary(r)}`,
          [L(accCode(r.account), tot), ...Object.entries(inv).map(([a, v]) => L(a, 0, v))]); });
      // الاستحقاق: من حـ/ المصروف إلى حـ/ المرتبات المستحقة (والتأمينات)، ثم الصرف: من حـ/ المستحقة إلى حـ/ الخزينة
      eff('boxTransfers').forEach(r => add('boxTransfers', 'تحويل خزائن وبنوك', r, r.no, r.date, r.desc || `تحويل من ${r.from} إلى ${r.to}`,
        [L(boxAcc(r.to), r.amount), L(boxAcc(r.from), 0, r.amount)]));
      eff('payroll').forEach(r => { const gross = +r.basic + +r.allowances, ded = +r.deductions, net = gross - ded, g = payAccs(r.group, r.costType || staffOf(r.employee)?.costType);
        const no = `PAY-${r.month}-${r.id}`, date = `${r.month}-28`;
        add('payroll', 'استحقاق رواتب', r, no, date, `استحقاق راتب ${r.employee} عن ${r.month}`,
          [L(g.exp, gross), L(SYS.socialIns, 0, ded), L(g.liab, 0, net)]);
        if (r.paid !== 'مستحق') add('payroll', 'صرف رواتب', r, `${no}-ص`, date, `صرف راتب ${r.employee} عن ${r.month}`,
          [L(g.liab, net), L(boxAcc(r.box), 0, net)]); });
      eff('dailyLabor').forEach(r => add('dailyLabor', 'يوميات عمال', r, `LAB-${r.id}`, r.date, `يومية ${r.worker} (${r.days} يوم)`,
        [L(laborAcc(workerCost(r.worker)), r.days * r.wage), L(boxAcc(r.box), 0, r.days * r.wage)]));
      eff('advances').forEach(r => { if (r.type === 'جزاء') return;
        add('advances', r.type === 'سلفة' ? 'سلفة عامل' : 'مكافأة عامل', r, `ADV-${r.id}`, r.date, `${r.type} - ${r.worker}`,
          [L(r.type === 'سلفة' ? advAcc(r.advType) : laborAcc(workerCost(r.worker)), r.amount), L(boxAcc(r.box), 0, r.amount)]); });
      eff('maintenanceOrders').forEach(r => { if (r.status !== 'مكتمل') return;
        add('maintenanceOrders', 'أمر صيانة', r, r.no, r.date, `صيانة ${r.machine}`, [L(SYS.maint, r.cost), L(boxAcc(r.box), 0, r.cost)]); });
      return E.sort((a, b) => -byDate(a, b) || (a.no < b.no ? 1 : -1));
    });
  }
  const movements = () => memo('mv', () => {
    const m = {};
    glEntries().forEach(e => e.lines.forEach(l => { const x = m[l.acc] ??= { dr: 0, cr: 0 }; x.dr += l.dr; x.cr += l.cr; }));
    return m;
  });
  // رصيد الحساب نفسه (افتتاحي + حركات) بطبيعته
  const ownBal = a => { const mv = movements()[a.code] || { dr: 0, cr: 0 }; return +a.balance + (isDebitNature(a.code) ? mv.dr - mv.cr : mv.cr - mv.dr); };
  // رصيد الحساب شاملاً كل فروعه
  // الحساب الفرعي المخالف لطبيعة أبيه (مثل مسحوبات الملاك تحت حقوق الملكية) يُطرح منه
  const rollup = code => memo('roll:' + code, () => { const a = acc(code); return (a ? ownBal(a) : 0) + sum(childrenOf(code), c => rollup(c.code) * (isDebitNature(c.code) === isDebitNature(code) ? 1 : -1)); });

  // ----- العملاء والموردون -----
  const custBal = (name, code) => memo('cb:' + name + '|' + (code || ''), () => {
    const c = db.customers.find(x => x.name === name && (!code || recAcc(SYS.customers, x) === code));
    const on = d => docOnAcc(d, code);
    return custOpen(c) + openOf(OPEN_TYPES[2], name) + sum(eff('salesInvoices').filter(i => i.customer === name && on(i)), invTotal)
      - sum(eff('salesReturns').filter(r => r.customer === name && on(r)), r => r.amount) - sum(eff('receipts').filter(r => r.party === name && isPartyDoc(r, 'c') && on(r)), r => r.amount);
  });
  const suppBal = (name, code) => memo('sb:' + name + '|' + (code || ''), () => {
    const on = d => docOnAcc(d, code);
    const s = db.suppliers.find(x => x.name === name && (!code || recAcc(SYS.suppliers, x) === code));
    return suppOpen(s) + openOf(OPEN_TYPES[3], name) + sum(eff('purchaseInvoices').filter(i => i.supplier === name && on(i)), i => i.amount) + sum(eff('stockIn').filter(r => r.supplier === name), r => docTotals(r).net) + sum(eff('supplierAccruals').filter(r => r.party === name && on(r)), r => +r.amount || 0)
      - sum(eff('purchaseReturns').filter(r => r.supplier === name && on(r)), r => r.amount) - sum(eff('payments').filter(r => r.party === name && isPartyDoc(r, 's') && on(r)), r => r.amount);
  });
  const salesPaid = inv => sum(eff('receipts').filter(r => r.invoice === inv.no), r => r.amount) + sum(eff('salesReturns').filter(r => r.invoice === inv.no), r => r.amount);
  const purchPaid = inv => sum(eff('payments').filter(r => r.invoice === inv.no), r => r.amount) + sum(eff('purchaseReturns').filter(r => r.invoice === inv.no), r => r.amount);
  const invStatus = (total, paid, due) => total - paid <= 0.01 ? 'مدفوعة' : due < today() ? 'متأخرة' : paid > 0 ? 'مدفوعة جزئياً' : 'معلقة';
  const salesStatus = r => invStatus(invTotal(r), salesPaid(r), r.due);
  const purchStatus = r => invStatus(+r.amount, purchPaid(r), r.due);

  // ----- المخزون -----
  // الإذن الواحد يحمل عدة أصناف (lines)؛ الأذون القديمة صنف واحد
  const linesOf = r => Array.isArray(r.lines) && r.lines.length ? r.lines : r.item ? [{ item: r.item, unit: r.unit, qty: r.qty, price: r.price || 0, vatRate: 0, whtRate: 0 }] : [];
  const lineVal = l => l.value != null && l.value !== '' ? +l.value || 0 : (+l.qty || 0) * (+l.price || 0);
  const lineTot = l => lineVal(l) - (+l.disc || 0) + (+l.pack || 0);
  const lineWeight = l => (+l.count > 0 ? +l.count : +l.qty || 0) * (+l.uw || 0);
  const lineVat = l => lineVal(l) * (+l.vatRate || 0) / 100, lineWht = l => lineVal(l) * (+l.whtRate || 0) / 100;
  const docTotals = r => { const ls = linesOf(r), sub = sum(ls, lineVal), vat = sum(ls, lineVat), wht = sum(ls, lineWht), disc = sum(ls, l => +l.disc || 0), pack = sum(ls, l => +l.pack || 0);
    return { sub, vat, wht, net: sub + vat - wht, disc, pack, total: sub - disc + pack, n: ls.length, qty: sum(ls, l => +l.qty || 0), count: sum(ls, l => +l.count || 0), weight: sum(ls, lineWeight) }; };
  const packOf = r => Array.isArray(r.lines) ? sum(r.lines, l => +l.pack || 0) : 0;
  const linesSummary = r => { const ls = linesOf(r); return ls.length ? ls.slice(0, 2).map(l => l.itype ? `${l.item} (${l.itype})` : l.item).join('، ') + (ls.length > 2 ? ` و${ls.length - 2} أخرى` : '') : ''; };
  const SALES_T = ['salesInvoices', 'salesReturns'];
  const stockRows = t => memo('sr:' + t, () => eff(t).filter(r => !SALES_T.includes(t) || (r.warehouse && Array.isArray(r.lines)))
    .flatMap(r => linesOf(r).map(l => SALES_T.includes(t) ? stockLine(l) : l).filter(Boolean).map(l => ({ ...l, date: r.date, no: r.no, warehouse: r.warehouse, doc: r }))));
  const itemStore = n => { const s = db.items.find(i => i.name === n)?.store; return s && acc(s) && !hasChildren(s) ? s : ''; };
  const stockMap = () => memo('stock', () => {
    const m = {}; const k = (i, w) => `${i}|${w}`;
    const addQ = (i, w, q) => { m[k(i, w)] = (m[k(i, w)] || 0) + (+q || 0); };
    db.items.forEach(i => addQ(i.name, i.warehouse, i.opening));
    eff('openingBalances').filter(r => r.otype === OPEN_TYPES[1]).forEach(r => addQ(r.item, r.warehouse, baseQty(r)));
    stockRows('stockIn').forEach(l => addQ(l.item, l.warehouse, baseQty(l)));
    stockRows('stockOut').forEach(l => addQ(l.item, l.warehouse, -baseQty(l)));
    stockRows('salesInvoices').forEach(l => addQ(l.item, l.warehouse, -baseQty(l)));
    stockRows('salesReturns').forEach(l => addQ(l.item, l.warehouse, baseQty(l)));
    eff('transfers').forEach(r => { addQ(r.item, r.from, -baseQty(r)); addQ(r.item, r.to, baseQty(r)); });
    return m;
  });
  const stockAt = (item, wh) => stockMap()[`${item}|${wh}`] || 0;
  const itemQty = item => sum(Object.entries(stockMap()).filter(([k]) => k.split('|')[0] === item), ([, q]) => q);

  // ----- الميكنة والصيانة -----
  const openMO = name => db.maintenanceOrders.some(m => m.machine === name && m.status !== 'مكتمل');
  const machineState = r => openMO(r.name) ? 'في الصيانة' : r.status;
  const planStatus = r => r.nextDate < today() ? 'متأخرة' : r.nextDate <= addDays(today(), 7) ? 'قريبة' : 'منتظمة';

  // ---------- الأيقونات ----------
  const I = p => `<svg viewBox="0 0 24 24">${p}</svg>`;
  const icons = {
    dash: I('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
    db: I('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'),
    ledger: I('<path d="M4 19V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14"/><path d="M4 19h16M8 15v-3M12 15V8M16 15v-5"/>'),
    cash: I('<rect x="2" y="6" width="20" height="13" rx="2"/><circle cx="12" cy="12.5" r="2.5"/><path d="M6 10v.01M18 15v.01"/>'),
    sales: I('<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>'),
    cart: I('<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.7 12.4a1.5 1.5 0 0 0 1.5 1.1h8.6a1.5 1.5 0 0 0 1.5-1.1L21 7H6"/>'),
    swap: I('<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>'),
    bank: I('<path d="M3 10 12 4l9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>'),
    box: I('<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>'),
    users: I('<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M17 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/>'),
    hardhat: I('<path d="M2 18h20v2H2z"/><path d="M4 18v-3a8 8 0 0 1 16 0v3"/><path d="M10 7V4h4v3M9 18v-6M15 18v-6"/>'),
    truck: I('<path d="M2 17V9h9l3 4h6v4"/><path d="M11 9V5H7v4"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/><path d="m14 13 3-6h3"/>'),
    wrench: I('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>'),
    gear: I('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
    shield: I('<path d="M12 3 4 6v6c0 5 3.4 8.6 8 9.9 4.6-1.3 8-4.9 8-9.9V6z"/><path d="m9 12 2 2 4-4"/>'),
    chevDown: '<svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" transform="rotate(180 12 12)"/></svg>',
    caret: I('<path d="m6 9 6 6 6-6"/>'),
    edit: I('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    del: I('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    export: I('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>'),
    print: I('<path d="M6 9V2h12v7"/><rect x="2" y="9" width="20" height="9" rx="2"/><path d="M6 14h12v8H6z"/>'),
    trend: I('<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>'),
    down: I('<path d="m3 7 6 6 4-4 8 8"/><path d="M14 17h7v-7"/>'),
    wallet: I('<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M16 13h2M2 10h20"/>'),
    list: I('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
    open: I('<path d="M14 3h7v7M21 3l-9 9"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>'),
    receive: I('<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M12 9v7M9 13l3 3 3-3"/>'),
    pay: I('<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M12 16V9M9 12l3-3 3 3"/>'),
  };

  // ---------- عرض الحالات ----------
  const GREEN = ['مدفوعة', 'نشط', 'حاضر', 'تعمل', 'مكتمل', 'مقبول', 'مستلم', 'معتمد', 'معتمدة', 'منتظمة', 'مكافأة'];
  const RED = ['متأخرة', 'غائب', 'متوقفة', 'مرفوض', 'موقوف', 'طارئة', 'جزاء', 'مفتوح', 'في الصيانة'];
  const pill = v => `<span class="pill ${GREEN.includes(v) ? 'green' : RED.includes(v) ? 'red' : 'amber'}">${esc(v)}</span>`;
  const plain = v => `<span class="pill">${esc(v)}</span>`;

  // ---------- مصادر القوائم المنسدلة ----------
  const names = k => () => db[k].map(r => r.name);
  // حقل الفرع: اختياري — إذا تُرك فارغاً يُستنتج من الخزينة أو المخزن أو مركز التكلفة
  const branchField = (label = 'الفرع', extra = {}) => C('branch', label, { input: 'select', optional: true, allowEmpty: '— تلقائي —', options: names('branches'), formOnly: true, ...extra });
  // الوحدات: كل وحدة = معامل × وحدتها الأساسية (طن = 1000 كجم، شيكارة = 50 كجم)
  const unitOf = n => db.units.find(u => u.name === n);
  const unitRoot = n => memo('ur:' + n, () => { let f = 1, u = unitOf(n), seen = new Set();
    while (u && u.base && u.base !== u.name && !seen.has(u.name)) { seen.add(u.name); f *= +u.factor || 1; u = unitOf(u.base); }
    return { root: u?.name || n, f }; });
  const convertQty = (q, from, to) => { if (!from || !to || from === to) return +q || 0; const a = unitRoot(from), b = unitRoot(to);
    return a.root === b.root ? (+q || 0) * a.f / b.f : NaN; };
  const sameFamily = (a, b) => unitRoot(a).root === unitRoot(b).root;
  const unitsFor = item => { const u = db.items.find(i => i.name === item)?.unit; return u ? db.units.filter(x => sameFamily(x.name, u)).map(x => x.name).concat(unitOf(u) ? [] : [u]) : db.units.map(x => x.name); };
  // كمية الحركة بوحدة الصنف الأساسية
  const baseQty = r => { const u = db.items.find(i => i.name === r.item)?.unit; const q = convertQty(r.qty, r.unit || u, u); return isNaN(q) ? +r.qty || 0 : q; };
  // فئات العاملين: كل قاعدة بيانات مرتبطة بفئة مرتبات (التزام + مصروف) في شجرة الحسابات
  const STAFF = { employees: 'مرتبات العاملين', girlsFixed: 'مرتبات البنات الثابتة', girlsTemp: 'مرتبات البنات المؤقتة', bangladesh: 'مرتبات بنجلاديش' };
  const allStaff = () => memo('staff', () => Object.entries(STAFF).flatMap(([t, g]) => db[t].map(r => ({ ...r, _t: t, group: r.payGroup || g }))));
  const staffOf = n => allStaff().find(x => x.name === n);
  const staffNames = () => allStaff().map(x => x.name);
  const opt = (...o) => () => o;
  const leafOpts = (...prefixes) => () => leafAccounts().filter(a => !prefixes.length || prefixes.some(p => a.code.startsWith(p))).map(accLabel);

  // ---------- تعريف الشاشات ----------
  // col: key, label, cls, render(v,row), input, options(), compute(row), full, total, optional, formOnly
  const C = (key, label, o = {}) => ({ key, label, ...o });
  const M = { cls: 'num', render: money, input: 'number' };
  const N = { cls: 'num', render: num, input: 'number' };
  const CODE = { cls: 'code' };
  const D = { input: 'date' };
  const status = (...o) => ({ render: pill, input: 'select', options: opt(...o) });
  const computed = (f, o = {}) => ({ cls: 'num', render: money, compute: f, ...o });
  const statusOf = (f, ...o) => ({ render: pill, compute: f, options: opt(...o) });
  const boxField = (label = 'الخزينة / البنك') => C('box', label, { input: 'select', options: names('cashboxes') });
  // تفاصيل الحركة البنكية: تظهر فقط عند اختيار بنك
  const PAY_METHODS = ['نقدي', 'شيك', 'تحويل بنكي'];
  const isBankBox = b => (typeof b === 'string' ? db.cashboxes.find(x => x.name === b) : b)?.type === 'بنك';
  const bankSide = (...keys) => f => keys.some(k => isBankBox(f[k]));
  // حالات الشيك: الوارد (سند قبض) والصادر (سند صرف)
  const CHQ_IN = ['تحت التحصيل', 'محصّل', 'مرتد'], CHQ_OUT = ['لم يُصرف', 'مصروف', 'مرتد'];
  const chqOpen = r => r.method === 'شيك' && (r.chequeStatus || CHQ_IN[0]) !== 'مرتد' && !['محصّل', 'مصروف'].includes(r.chequeStatus);
  // قائمة "اسم المستفيد" تتغير حسب "اسم الحساب" المختار
  const treasAccOpts = () => leafAccounts().filter(a => !isTreasury(a.code) && a.code !== SYS.chqIn && a.code !== SYS.chqOut).map(accLabel);
  // نطاق تعامل الخزينة: خزينة الإيرادات للعملاء فقط، والخزينة الرئيسية للموردين والمصروفات (والاستلام فيها بالتحويل من خزينة أو بنك)
  const BOX_ROLES = ['عام', 'إيرادات — العملاء', 'مصروفات — الموردين والمصروفات'];
  const boxRole = b => { const x = typeof b === 'string' ? db.cashboxes.find(c => c.name === b) : b; if (!x) return 'عام';
    if (x.role) return x.role; if (/الإيرادات|الايرادات/.test(x.name)) return BOX_ROLES[1]; if (/الرئيسي/.test(x.name)) return BOX_ROLES[2]; return 'عام'; };
  const isRevBox = b => boxRole(b) === BOX_ROLES[1], isExpBox = b => boxRole(b) === BOX_ROLES[2];
  // حسابات السند حسب الخزينة المختارة (kind: 'r' قبض، 'p' صرف)
  const boxAccOpts = (box, kind) => {
    const all = leafAccounts().filter(a => !isTreasury(a.code) && a.code !== SYS.chqIn && a.code !== SYS.chqOut);
    if (isRevBox(box)) return all.filter(a => a.code.startsWith(SYS.customers)).map(accLabel);
    if (isExpBox(box)) return kind === 'r' ? [] : all.filter(a => a.code.startsWith(SYS.suppliers) || a.code.startsWith(SYS.expenses)).map(accLabel);
    return all.map(accLabel);
  };
  const boxScopeErr = (d, kind) => {
    if (!d.box) return '';
    if (kind === 'r' && isExpBox(d.box)) return `"${d.box}" تستلم بالتحويل من خزينة أو بنك فقط — استخدم شاشة التحويلات بين الخزائن والبنوك`;
    const ok = boxAccOpts(d.box, kind).map(accCode);
    if (d.account && !ok.includes(accCode(d.account))) return isRevBox(d.box) ? `"${d.box}" تتعامل مع حسابات العملاء فقط` : `"${d.box}" تصرف على الموردين والمصروفات فقط`;
    return '';
  };
  // خزائن الصرف لأوامر الدفع وطلبات الدفع: الخزينة الرئيسية والبنوك (وليست خزينة الإيرادات)
  const payBoxOpts = () => db.cashboxes.filter(b => isExpBox(b) || isBankBox(b)).map(b => b.name);
  const partyOpts = v => { const code = accCode(v), k = partyKind(code);
    if (k === 'c') return [...new Set(db.customers.filter(c => code === SYS.customers || recAcc(SYS.customers, c) === code).map(c => c.name))];
    if (k === 's') return [...new Set(db.suppliers.filter(s => code === SYS.suppliers || recAcc(SYS.suppliers, s) === code).map(s => s.name))];
    if (k === 'o') return [acc(code)?.name].filter(Boolean);
    const hist = [...db.receipts, ...db.payments].filter(r => code && accCode(r.account) === code && r.party && r.party !== 'أخرى').map(r => r.party);
    return [...new Set(k === 'e' ? [...staffNames(), ...db.workers.map(w => w.name), ...hist] : hist)]; };
  const fixParty = (d, ok) => { if (d.party && !ok.includes(d.party)) { const m = ok.find(o => normAr(o) === normAr(d.party)); if (m) d.party = m; } };
  const inferAcc = n => { const c = isCustomer(n) ? custAcc(n) : isSupplier(n) ? suppAcc(n) : ownerAcc(n); return c && acc(c) ? accLabel(acc(c)) : ''; };
  const partyCheck = d => { if (!d.account && d.party) d.account = inferAcc(d.party); const code = accCode(d.account), k = partyKind(code), ok = partyOpts(d.account); fixParty(d, ok);
    if (!code) return 'اختر اسم الحساب';
    if (k === 'c' && !ok.includes(d.party)) return `اختر العميل من عملاء "${acc(code)?.name}"`;
    if (k === 's' && !ok.includes(d.party)) return `اختر المورد من موردي "${acc(code)?.name}"`;
    if (k === 'o') d.party = ok[0];
    return ''; };
  const fmtDMY = d => d ? d.split('-').reverse().join('-') : '';
  // الفترة حسب نوع المورد: سيارات وبرادات ← شهر (أكتوبر-2026)، عمالة ومعدات ← نص حر (من 1-7-2026 إلى 7-7-2026)، موردو المخازن ← بدون فترة
  const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const periodMonth = m => { const [y, mm] = String(m || '').split('-'); return y && +mm ? `${AR_MONTHS[+mm - 1]}-${y}` : String(m || ''); };
  const parseMonth = v => { const t = String(v || '').trim(); if (/^\d{4}-\d{2}$/.test(t)) return t;
    const m = t.match(/^(\d{1,2})[-/](\d{4})$/); if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
    const n = normAr(t), i = AR_MONTHS.findIndex(x => n.includes(normAr(x))), y = (t.match(/\d{4}/) || [])[0];
    return i >= 0 && y ? `${y}-${String(i + 1).padStart(2, '0')}` : t; };
  const periodMode = accV => { const k = suppKind(accV); if (k !== 'service') return k ? 'none' : '';
    const n = acc(accCode(accV))?.name || ''; return /سيار|براد|مبرد/.test(n) ? 'month' : 'text'; };
  const periodText = r => r.periodNote ? r.periodNote : r.month && !r.from ? periodMonth(r.month) : r.from || r.to ? `من ${fmtDMY(r.from)} إلى ${fmtDMY(r.to)}` : '';
  // تجهيز حقول الفترة عند الحفظ (accKey: حقل حساب المورد)
  // عمود واحد للفترة يقبل النص أو التاريخ كما هو (من … إلى … / أكتوبر-2026 / تاريخ)
  const periodCheck = (d, accV) => {
    if (periodMode(accV) === 'none') return '';
    let v = d.periodNote;
    if (v == null || v === '') v = d.month ? periodMonth(d.month) : d.from || d.to ? `من ${fmtDMY(d.from)} إلى ${fmtDMY(d.to)}` : '';
    v = String(v ?? '').trim();
    if (/^\d{5}(\.\d+)?$/.test(v)) { const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(+v) * 864e5); v = fmtDMY(dt.toISOString().slice(0, 10)); } // تاريخ Excel
    else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v = fmtDMY(v);
    else if (/^\d{4}-\d{2}$/.test(v)) v = periodMonth(v);
    if (!v) return 'اكتب الفترة (نص أو تاريخ — مثال: من 1-7-2026 إلى 7-7-2026 أو أكتوبر-2026)';
    d.periodNote = v; d.month = ''; d.from = ''; d.to = ''; d.periodType = '';
    return ''; };
  // حساب المصروف المقترح حسب نوع المورد (عمالة / معدات / سيارات)
  // موردو البضاعة (محاصيل / بضاعة / نقدي) يُستلم منهم مخزون، وغيرهم موردو خدمات بفترة وحساب مقابل
  const suppKind = accV => { const n = acc(accCode(accV))?.name || ''; return !n ? '' : /محاصيل|بضاع|نقد/.test(n) ? 'goods' : 'service'; };
  const defaultExpFor = accV => { const n = acc(accCode(accV))?.name || '';
    const c = /عمال/.test(n) ? laborAcc('تشغيلية') : /براد|مبرد/.test(n) ? leafByName(SYS.expenses, 'إيجار شاحنات مبردة تشغيلية') : /معدات/.test(n) ? leafByName(SYS.expenses, 'إيجار معدات تشغيلية') : /سيارات/.test(n) ? leafByName(SYS.expenses, 'إيجار سيارات تشغيلية') : '';
    return c && acc(c) ? accLabel(acc(c)) : ''; };
  const partyLabel = (name, accV) => { const k = partyKind(accCode(accV)); return k === 's' ? `الرصيد المستحق: ${money(suppBal(name))}` : k === 'c' ? `رصيد العميل: ${money(custBal(name))}` : ''; };
  const partyName = r => r.party && r.party !== 'أخرى' ? r.party : r.beneficiary || acc(accCode(r.account))?.name || r.party || '';
  const bankFields = (side, who, statuses = CHQ_IN, withBen = true) => [
    C('method', 'طريقة الإيداع / الصرف', { input: 'select', options: () => PAY_METHODS, formOnly: true, when: side }),
    C('chequeNo', 'رقم الشيك', { optional: true, formOnly: true, when: f => side(f) && f.method === 'شيك' }),
    C('chequeDate', 'تاريخ استحقاق الشيك', { input: 'date', optional: true, formOnly: true, when: f => side(f) && f.method === 'شيك' }),
    C('chequeStatus', 'حالة الشيك', { input: 'select', options: () => statuses, optional: true, formOnly: true, when: f => side(f) && f.method === 'شيك' }),
    C('clearDate', 'تاريخ التحصيل / الصرف', { input: 'date', optional: true, formOnly: true, when: f => side(f) && f.method === 'شيك' && ['محصّل', 'مصروف'].includes(f.chequeStatus) }),
    ...(withBen ? [C('beneficiary', who, { optional: true, formOnly: true, when: side })] : []),
    C('benAccount', 'رقم حساب المستفيد', { optional: true, formOnly: true, when: f => side(f) && f.method !== 'نقدي' }),
    C('benBank', 'بنك المستفيد', { optional: true, formOnly: true, when: f => side(f) && f.method !== 'نقدي' })];
  const bankCheck = (d, side, needBen, statuses = CHQ_IN) => {
    if (!side(d)) { ['method', 'chequeNo', 'chequeDate', 'chequeStatus', 'clearDate', 'beneficiary', 'benAccount', 'benBank'].forEach(k => { d[k] = ''; }); return ''; }
    if (d.method === 'شيك' && !d.chequeNo) return 'اكتب رقم الشيك';
    if (d.method === 'شيك' && !d.chequeDate) return 'اكتب تاريخ استحقاق الشيك';
    if (d.method === 'شيك' && !statuses.includes(d.chequeStatus)) d.chequeStatus = statuses[0];
    if (['محصّل', 'مصروف'].includes(d.chequeStatus)) d.clearDate ||= today(); else d.clearDate = '';
    if (d.method !== 'شيك') { d.chequeNo = ''; d.chequeDate = ''; d.chequeStatus = ''; d.clearDate = ''; }
    if (d.method === 'نقدي') { d.benAccount = ''; d.benBank = ''; }
    if (needBen && d.method === 'تحويل بنكي' && (!(d.beneficiary || d.party) || !d.benAccount || !d.benBank)) return 'التحويل البنكي يحتاج اسم المستفيد ورقم حسابه واسم البنك الخاص به';
    return '';
  };

  const itemUnit = n => db.items.find(i => i.name === n)?.unit || '';
  // فاتورة البيع / المردودات: الصافي = مجموع الأصناف، والمخزن اختياري
  // اسم الحساب واسم العميل: العميل يجب أن يكون من عملاء الحساب المختار
  function custAccCheck(d, noDue) {
    d.customer = String(d.customer || '').trim();
    if (!isCustomer(d.customer)) return d.customer ? `العميل "${d.customer}" غير موجود في قاعدة بيانات العملاء` : 'اختر اسم العميل';
    if (!d.account) d.account = custAcc(d.customer);
    if (!d.due && !noDue) d.due = addDays(d.date || today(), 30);
    if (!custOfAcc(d.account).includes(d.customer)) return `العميل "${d.customer}" ليس من ${acc(d.account)?.name || 'هذا الحساب'}`;
    const ty = acc(d.account)?.name.replace(/^عملاء\s*/, ''); if (ty && SALE_TYPES.some(([, t]) => t === ty)) d.stype = ty;
  }
  function salesLinesCheck(d, rec, dir) {
    const ls = (Array.isArray(d.lines) ? d.lines : []).filter(l => l.item || l.code);
    for (const l of ls) {
      if (!l.item && l.code) l.item = db.salesItems.find(i => String(i.code) === String(l.code))?.name || db.items.find(i => String(i.code) === String(l.code))?.name || '';
      const si = salesItemOf(l.item);
      if (!si && !db.items.some(i => i.name === l.item)) return `الصنف "${l.item}" غير موجود في قاعدة بيانات أصناف المبيعات`;
      if (si && d.stype && si.account !== salesAccOfType(d.stype)) return `الصنف "${l.item}" ليس من أصناف ${d.stype}`;
      if (!(+l.qty > 0) && !(+l.count > 0)) return `اكتب كمية أو عدد "${l.item}"`;
      if (!l.unit) l.unit = si?.unit || itemUnit(l.item);
      if (!+l.price) l.price = +si?.price || 0;
      if (l.uw === '' || l.uw == null) l.uw = +si?.weight || 0;
      const sl = stockLine(l); if (sl) { const ue = unitErr(sl); if (ue) return ue; }
      ['qty', 'price', 'count', 'uw', 'disc', 'pack'].forEach(k => { l[k] = +l[k] || 0; }); l.vatRate = 0; l.whtRate = 0; l.itype = String(l.itype || '').trim();
      l.value = l.value === '' || l.value == null ? +(l.qty * l.price).toFixed(2) : +l.value || 0;
      if (!(lineTot(l) > 0)) return `اكتب قيمة "${l.item}"`;
      if (l.dr !== '' && l.dr != null && Math.abs(+l.dr - lineTot(l)) > 0.05) return `"${l.item}": إجمالي مدين في الملف (${nf.format(+l.dr)}) لا يساوي إجمالي القيمة − الخصم + مواد التعبئة (${nf.format(lineTot(l))})`;
      if (l.tw !== '' && l.tw != null && +l.tw && lineWeight(l) && Math.abs(+l.tw - lineWeight(l)) > 0.05) return `"${l.item}": إجمالي الوزن في الملف (${nf.format(+l.tw)}) لا يساوي الكمية × سعة الوحدة (${nf.format(lineWeight(l))})`;
      delete l.code; delete l.dr; delete l.tw;
    }
    d.lines = ls;
    if (ls.length) d.amount = +sum(ls, lineTot).toFixed(2);
    else d.warehouse = '';
    if (!(+d.amount > 0)) return 'أضف الأصناف أو اكتب المبلغ';
    if (dir === 'out' && d.warehouse) {
      const need = {}; ls.map(stockLine).filter(Boolean).forEach(l => { need[l.item] = (need[l.item] || 0) + baseQty(l); });
      for (const [it, q] of Object.entries(need)) {
        const mine = rec && rec.warehouse === d.warehouse && isEff(rec) ? sum(linesOf(rec).map(stockLine).filter(l => l && l.item === it), baseQty) : 0;
        const avail = stockAt(it, d.warehouse) + mine;
        if (q > avail + 1e-9) return `الرصيد المتاح من "${it}" في ${d.warehouse} هو ${num(avail)} ${itemUnit(it)} فقط`;
      }
    }
    return '';
  }
  // التحقق من إذن متعدد الأصناف: الأصناف موجودة، الكميات، الوحدات، والرصيد عند الصرف
  function stockDocCheck(d, rec, dir) {
    const ls = (Array.isArray(d.lines) ? d.lines : []).filter(l => l.item);
    if (!ls.length) return 'أضف صنفاً واحداً على الأقل';
    for (const l of ls) {
      if (!db.items.some(i => i.name === l.item)) return `الصنف "${l.item}" غير موجود في قاعدة بيانات الأصناف`;
      if (!(+l.qty > 0)) return `اكتب كمية "${l.item}"`;
      const ue = unitErr(l); if (ue) return ue;
      ['qty', 'price', 'vatRate', 'whtRate'].forEach(k => { l[k] = +l[k] || 0; });
    }
    d.lines = ls; ['item', 'qty', 'unit'].forEach(k => { d[k] = ''; });
    if (dir === 'in' && sum(ls, lineVal) > 0 && !d.supplier) return 'اختر المورد — الأصناف لها سعر وستُرحّل على حسابه';
    if (dir === 'out') {
      if (sum(ls, lineVal) > 0 && !d.account) return 'اختر اسم الحساب (المصروف أو الجهة المدينة)';
      const need = {}; ls.forEach(l => { need[l.item] = (need[l.item] || 0) + baseQty(l); });
      for (const [it, q] of Object.entries(need)) {
        const mine = rec && rec.warehouse === d.warehouse ? sum(linesOf(rec).filter(l => l.item === it), baseQty) : 0;
        const avail = stockAt(it, d.warehouse) + mine;
        if (q > avail + 1e-9) return `الرصيد المتاح من "${it}" في ${d.warehouse} هو ${num(avail)} ${itemUnit(it)} فقط`;
      }
    }
    return '';
  }
  const unitErr = d => d.unit && d.item && isNaN(convertQty(1, d.unit, itemUnit(d.item))) ? `لا يمكن تحويل "${d.unit}" إلى وحدة الصنف "${itemUnit(d.item)}" — عرّف معامل التحويل في قاعدة بيانات الوحدات` : '';
  const unitPick = (f, v) => { const u = itemUnit(v); if (f.unit && u && !f.unit.value) [...f.unit.options].forEach(o => { o.hidden = o.value && !sameFamily(o.value, u); }); };
  const qtyNote = r => r.unit && r.unit !== itemUnit(r.item) ? ` (${num(r.qty)} ${r.unit})` : '';
  const invAccOpts = () => leafAccounts().filter(a => isInvAcc(a.code)).map(a => [a.code, a.name]);
  const staffCols = (nameLbl, idLbl) => [
    C('code', 'الكود', CODE), C('name', nameLbl, { full: true }),
    C('payGroup', 'الحساب الرئيسي (المرتبات المستحقة)', { input: 'select', optional: true, allowEmpty: '— حسب قاعدة البيانات —', options: payGroupOpts, full: true, render: v => v ? `<span class="pill">${esc(v)}</span>` : '—' }), C('nationalId', idLbl, { optional: true, cls: 'code' }), C('phone', 'الهاتف', { optional: true }),
    C('job', 'الوظيفة / العمل', { optional: true }), C('costCenter', 'مركز التكلفة', { input: 'select', optional: true, allowEmpty: '— بدون —', options: () => db.costCenters.map(c => [c.name, `${c.name} — ${c.branch || ''}`]) }),
    C('hireDate', 'تاريخ الالتحاق', D), C('salary', 'الراتب / الأجر', { ...M, total: true }),
    C('costType', 'نوع التكلفة', { render: plain, input: 'select', options: () => COST_TYPES }), C('status', 'الحالة', status('نشط', 'موقوف'))];
  const staffDb = (t, title, single, nameLbl, idLbl, ct) => ({ title, sub: `مرتباتهم تُرحّل على فئة "${STAFF[t]}" — حسب نوع التكلفة (تشغيلية / تسويقية / إدارية)`, single, key: 'name', filter: 'status',
    defaults: () => ({ costType: ct, status: 'نشط', payGroup: STAFF[t] }), cols: staffCols(nameLbl, idLbl), validate: (d, rec) => allStaff().some(x => x.name === d.name && !(x._t === t && x.id === rec?.id)) ? `"${d.name}" مسجل في قاعدة عاملين أخرى` : '' });

  // رصيد أول المدة بخانتين: مدين أو دائن (وليس الاثنين)
  const openPair = d => { d.openDr = +d.openDr || 0; d.openCr = +d.openCr || 0; d.opening = 0;
    if (d.openDr < 0 || d.openCr < 0) return 'رصيد أول المدة لا يكون سالباً';
    if (d.openDr && d.openCr) return 'اكتب رصيد أول المدة في خانة المدين أو الدائن وليس الاثنين'; return ''; };
  const modules = {
    // ===== البيانات الأساسية =====
    customers: { title: 'العملاء', sub: 'كل تصنيف له حساب مستقل في شجرة الحسابات تحت حـ/ العملاء — نفس الاسم يمكن تسجيله في أكثر من حساب رئيسي', single: 'عميل', key: 'name', keyScope: 'category', filter: 'category', cols: [
      C('code', 'الكود', CODE), C('name', 'اسم العميل', { full: true }),
      C('category', 'الحساب الرئيسي', { render: plain, input: 'select', options: mainAccOpts(SYS.customers), aka: ['التصنيف'] }),
      C('phone', 'الهاتف', { input: 'tel' }), C('city', 'المدينة'),
      C('limit', 'حد الائتمان', M), C('openDr', 'رصيد أول المدة — مدين', { ...M, optional: true, formOnly: true, aka: ['رصيد أول المدة'] }),
      C('openCr', 'رصيد أول المدة — دائن', { ...M, optional: true, formOnly: true }),
      C('balance', 'الرصيد الحالي', computed(r => custBal(r.name, recAcc(SYS.customers, r)), { total: true, render: (v, r) => v > +r.limit && +r.limit ? `<span class="pill red" title="تجاوز حد الائتمان">${money(v)}</span>` : money(v) }))],
      actions: [{ icon: 'list', title: 'كشف حساب العميل', fn: r => customerStatement(r) }],
      load: r => r.opening && !+r.openDr && !+r.openCr ? { openDr: +r.opening > 0 ? +r.opening : 0, openCr: +r.opening < 0 ? -r.opening : 0 } : {},
      validate: d => openPair(d) },
    suppliers: { title: 'الموردون', sub: 'كل تصنيف له حساب مستقل في شجرة الحسابات تحت حـ/ الموردين — نفس الاسم يمكن تسجيله في أكثر من حساب رئيسي', single: 'مورد', key: 'name', keyScope: 'category', filter: 'category', cols: [
      C('code', 'الكود', CODE), C('name', 'اسم المورد', { full: true }), C('phone', 'الهاتف', { input: 'tel' }), C('city', 'المدينة'),
      C('category', 'الحساب الرئيسي', { render: plain, input: 'select', options: mainAccOpts(SYS.suppliers), aka: ['التصنيف'] }),
C('openDr', 'رصيد أول المدة — مدين', { ...M, optional: true, formOnly: true }),
      C('openCr', 'رصيد أول المدة — دائن', { ...M, optional: true, formOnly: true, aka: ['رصيد أول المدة'] }),
      C('balance', 'المستحق للمورد', computed(r => suppBal(r.name, recAcc(SYS.suppliers, r)), { total: true }))],
      actions: [{ icon: 'list', title: 'كشف حساب المورد', fn: r => supplierStatement(r) }],
      load: r => r.opening && !+r.openDr && !+r.openCr ? { openCr: +r.opening > 0 ? +r.opening : 0, openDr: +r.opening < 0 ? -r.opening : 0 } : {},
      validate: d => openPair(d) },
    items: { title: 'الأصناف', sub: 'اسم المخزون (حساب الشجرة) › المجموعة › الصنف › الوحدة — الرصيد = أول المدة + الإضافة − الصرف', single: 'صنف', key: 'name', filter: 'category', cols: [
      C('code', 'كود الصنف', CODE), C('store', 'اسم المخزون', { input: 'select', optional: true, allowEmpty: '— اختر حساب المخزون —', options: invAccOpts, render: v => v ? `<span class="pill">${esc(acc(v)?.name || v)}</span>` : '—' }),
      C('category', 'المجموعة', { render: plain, suggest: () => [...new Set(db.items.map(i => i.category).filter(Boolean))] }), C('name', 'الصنف'),
      C('unit', 'الوحدة', { input: 'select', options: () => { const l = db.units.map(u => u.name); return l.length ? l : ['قطعة']; } }), C('warehouse', 'المخزن الأساسي', { input: 'select', options: names('warehouses') }),
      C('opening', 'رصيد أول المدة', N),
      C('qty', 'الرصيد الحالي', { cls: 'num', compute: r => itemQty(r.name), render: (v, r) => v < +r.min ? `<span class="pill red" title="أقل من حد الطلب">${num(v)}</span>` : `<b>${num(v)}</b>` }),
      C('min', 'حد الطلب', N), C('cost', 'التكلفة', M), C('price', 'سعر البيع', M),
      C('value', 'قيمة المخزون', computed(r => itemQty(r.name) * r.cost, { total: true }))],
      actions: [{ icon: 'list', title: 'كارت الصنف (الحركة)', fn: r => itemCard(r) }, { icon: 'plus', title: 'رصيد افتتاحي للصنف', write: true, target: 'openingBalances', fn: r => openRecordForm('openingBalances', null, { otype: OPEN_TYPES[1], item: r.name, warehouse: r.warehouse, cost: r.cost }) }] },
    warehouses: { title: 'المخازن', sub: 'بيانات المخازن وقيمة أرصدتها', single: 'مخزن', key: 'name', actions: [{ icon: 'box', title: 'فتح صفحة المخزن', fn: r => goTo('wh/' + r.id) }], cols: [
      C('code', 'الكود', CODE), C('name', 'اسم المخزن'), C('type', 'النوع', { render: plain, input: 'select', options: opt('خامات', 'إنتاج تام', 'قطع غيار', 'مواقع') }),
      C('location', 'الموقع'), branchField('الفرع', { allowEmpty: '—', formOnly: false, render: v => v ? plain(v) : '—' }), C('keeper', 'أمين المخزن'),
      C('itemsCount', 'أصناف بها رصيد', { cls: 'num', compute: r => db.items.filter(i => stockAt(i.name, r.name) > 0).length }),
      C('value', 'قيمة الرصيد', computed(r => sum(db.items, i => stockAt(i.name, r.name) * i.cost), { total: true }))] },
    units: { title: 'الوحدات ومعامل التحويل', sub: '1 وحدة = المعامل × الوحدة الأساسية — مثل: طن = 1000 كجم، شيكارة = 50 كجم', single: 'وحدة', key: 'name', cols: [
      C('code', 'الكود', CODE), C('name', 'الوحدة'), C('base', 'الوحدة الأساسية', { input: 'select', optional: true, allowEmpty: '— وحدة أساسية بذاتها —', options: () => db.units.map(u => u.name) }),
      C('factor', 'معامل التحويل', { ...N, render: qn, optional: true }),
      C('conv', 'التحويل', { compute: r => r.base && r.base !== r.name ? `1 ${r.name} = ${qn(+r.factor || 0)} ${r.base}` : 'وحدة أساسية', render: v => `<span class="hint">${esc(v)}</span>` }),
      C('family', 'تساوي بالوحدات الأخرى', { compute: r => db.units.filter(u => u.name !== r.name && sameFamily(u.name, r.name)).map(u => `${qn(convertQty(1, r.name, u.name))} ${u.name}`).join(' · '), render: v => `<span class="hint">${esc(v) || '—'}</span>` }),
      C('itemsCount', 'أصناف بها', { cls: 'num', compute: r => db.items.filter(i => i.unit === r.name).length })],
      defaults: () => ({ factor: 1 }),
      validate: d => { if (d.base && d.base !== d.name && !(+d.factor > 0)) return 'اكتب معامل التحويل (أكبر من صفر)'; if (!d.base || d.base === d.name) { d.base = ''; d.factor = 1; }
        let u = d.base, seen = new Set([d.name]); while (u) { if (seen.has(u)) return 'التحويل يرجع لنفس الوحدة — راجع الوحدة الأساسية'; seen.add(u); u = unitOf(u)?.base; } } },
    salesItems: { title: 'أصناف المبيعات', sub: 'نوع الحساب (مبيعات السوق المحلي / الشتلات / الخردة / الثروة الحيوانية) › الصنف › الوحدة — تظهر في فاتورة نوعها فقط', single: 'صنف مبيعات', key: 'name', filter: 'account', cols: [
      C('code', 'الكود', CODE),
      C('account', 'نوع الحساب', { input: 'select', options: () => leafAccounts().filter(a => a.code.startsWith('41')).map(a => [a.code, a.name]), render: v => `<span class="pill">${esc(acc(v)?.name || v)}</span>` }),
      C('name', 'اسم الصنف'), C('itype', 'أنواع الصنف', { optional: true, full: true, placeholder: 'مثال: ايرلي سويت، فليم، كريمسون', render: v => varietiesOf(v).length ? varietiesOf(v).map(x => `<span class="pill">${esc(x)}</span>`).join(' ') : '—' }),
      C('unit', 'الوحدة', { input: 'select', options: () => { const l = db.units.map(u => u.name); return l.length ? l : ['قطعة']; } }),
      C('weight', 'وزن الوحدة', { ...N, optional: true }),
      C('price', 'سعر البيع', { ...M, optional: true }),
      C('stockItem', 'الصنف المخزني المرتبط', { input: 'select', optional: true, allowEmpty: '— بدون (لا يُصرف من المخزن) —', options: names('items'), render: v => v ? esc(v) : '<span class="hint">—</span>' }),
      C('sold', 'الكمية المباعة', { cls: 'num', compute: r => sum(eff('salesInvoices').flatMap(i => Array.isArray(i.lines) ? i.lines : []).filter(l => l.item === r.name), l => +l.qty || 0) - sum(eff('salesReturns').flatMap(i => Array.isArray(i.lines) ? i.lines : []).filter(l => l.item === r.name), l => +l.qty || 0), render: num }),
      C('value', 'قيمة المبيعات', computed(r => sum(eff('salesInvoices').flatMap(i => Array.isArray(i.lines) ? i.lines : []).filter(l => l.item === r.name), lineVal), { total: true }))],
      validate: d => { if (d.stockItem && d.unit && isNaN(convertQty(1, d.unit, itemUnit(d.stockItem)))) return `وحدة "${d.unit}" لا تتحول لوحدة الصنف المخزني "${itemUnit(d.stockItem)}"`; } },
    branches: { title: 'الفروع', sub: 'الفروع ومراكز التكلفة التابعة لكل فرع', single: 'فرع', key: 'name', cols: [
      C('code', 'الكود', CODE), C('name', 'اسم الفرع'), C('address', 'العنوان', { optional: true }), C('manager', 'المسئول', { optional: true }), C('phone', 'الهاتف', { optional: true }),
      C('ccCount', 'مراكز التكلفة', { cls: 'num', compute: r => db.costCenters.filter(c => c.branch === r.name).length }),
      C('area', 'المساحة', { cls: 'num', compute: r => sum(db.costCenters.filter(c => c.branch === r.name), c => +c.area || 0), render: num, total: true })] },
    costCenters: { title: 'مراكز التكلفة', sub: 'الفرع › القطاع › مركز التكلفة والمساحة', single: 'مركز تكلفة', key: 'name', filter: 'branch', cols: [
      C('code', 'الكود', CODE), C('branch', 'الفرع', { render: plain, input: 'select', options: () => { const l = db.branches.map(b => b.name); return l.length ? l : [...new Set(db.costCenters.map(c => c.branch).filter(Boolean))]; } }),
      C('sector', 'القطاع', { suggest: () => [...new Set(db.costCenters.map(c => c.sector).filter(Boolean))] }), C('name', 'مركز التكلفة'),
      C('area', 'المساحة', { ...N, total: true }), C('areaUnit', 'وحدة المساحة', { input: 'select', options: opt('فدان', 'قيراط', 'م²', 'هكتار') }),
      C('staff', 'العاملون', { cls: 'num', compute: r => allStaff().filter(x => x.costCenter === r.name).length }),
      C('notes', 'ملاحظات', { optional: true, full: true, formOnly: true })],
      defaults: () => ({ areaUnit: 'فدان' }) },
    crops: { title: 'المحاصيل الزراعية', sub: 'المحصول والصنف', single: 'محصول', filter: 'name', cols: [
      C('code', 'الكود', CODE), C('name', 'المحصول', { suggest: () => [...new Set(db.crops.map(c => c.name))] }), C('variety', 'الصنف'),
      C('season', 'الموسم', { input: 'select', optional: true, allowEmpty: '—', options: opt('صيفي', 'شتوي', 'نيلي', 'معمّر') }), C('notes', 'ملاحظات', { optional: true, full: true })],
      validate: (d, rec) => db.crops.some(c => c !== rec && c.name === d.name && c.variety === d.variety) ? `${d.name} — ${d.variety} مسجل من قبل` : '' },
    girlsFixed: staffDb('girlsFixed', 'البنات الثابتة', 'عاملة ثابتة', 'الاسم', 'الرقم القومي', 'تشغيلية'),
    girlsTemp: staffDb('girlsTemp', 'البنات المؤقتة', 'عاملة مؤقتة', 'الاسم', 'الرقم القومي', 'تشغيلية'),
    bangladesh: staffDb('bangladesh', 'عمالة بنجلاديش', 'عامل', 'الاسم', 'رقم جواز السفر', 'تشغيلية'),
    departments: { title: 'الإدارات', sub: 'الهيكل التنظيمي — مرتبط ببيانات الموظفين', single: 'إدارة', key: 'name', cols: [
      C('code', 'الكود', CODE), C('name', 'اسم الإدارة'), C('manager', 'المدير'),
      C('staff', 'عدد الموظفين', { cls: 'num', compute: r => db.employees.filter(e => e.department === r.name).length }),
      C('cost', 'إجمالي الرواتب', computed(r => sum(db.employees.filter(e => e.department === r.name), e => e.salary), { total: true }))] },

    // ===== الحسابات =====
    journal: { title: 'القيود اليومية', sub: 'دفتر اليومية العامة', single: 'قيد يدوي', key: 'no', cols: [
      C('no', 'رقم القيد', CODE), C('date', 'التاريخ', D), C('desc', 'البيان', { full: true }), branchField(),
      C('jlines', 'أطراف القيد', { input: 'jlines', formOnly: true, full: true }),
      C('amount', 'المبلغ', { ...M, total: true, compute: jTotal })],
      wide: true,
      validate: d => {
        const ls = (Array.isArray(d.jlines) ? d.jlines : []).filter(l => l.acc || +l.dr || +l.cr);
        for (const [i, l] of ls.entries()) {
          const code = accCode(l.acc); l.dr = +(+l.dr || 0).toFixed(2); l.cr = +(+l.cr || 0).toFixed(2);
          if (!code || !acc(code)) return `اختر الحساب في السطر ${i + 1}`;
          if (hasChildren(code)) return `الحساب "${acc(code).name}" رئيسي — اختر حساباً فرعياً (السطر ${i + 1})`;
          if (l.dr && l.cr) return `السطر ${i + 1}: اكتب مبلغاً مديناً أو دائناً وليس الاثنين`;
          if (!l.dr && !l.cr) return `السطر ${i + 1}: اكتب المبلغ المدين أو الدائن`;
          if (l.dr < 0 || l.cr < 0) return `السطر ${i + 1}: المبلغ لا يكون سالباً`;
          l.acc = accLabel(acc(code));
        }
        if (ls.length < 2) return 'القيد يحتاج طرفين على الأقل (مدين ودائن)';
        const dr = sum(ls, l => l.dr), cr = sum(ls, l => l.cr);
        if (!ls.some(l => l.dr) || !ls.some(l => l.cr)) return 'القيد يحتاج طرفاً مديناً وطرفاً دائناً';
        if (Math.abs(dr - cr) > 0.005) return `القيد غير متوازن: المدين ${nf.format(dr)} والدائن ${nf.format(cr)} — الفرق ${nf.format(Math.abs(dr - cr))}`;
        d.jlines = ls; d.amount = +dr.toFixed(2); d.debit = ''; d.credit = '';
      } },

    // ===== الخزينة =====
    cashboxes: { title: 'الخزائن والبنوك', sub: 'النقدية (حـ/ 121) والبنوك (حـ/ 122) — الرصيد من شجرة الحسابات', single: 'خزينة / بنك', key: 'name', filter: 'type', cols: [
      C('code', 'الكود', CODE), C('name', 'الاسم', { full: true }), C('type', 'النوع', { render: plain, input: 'select', options: opt('خزينة', 'بنك', 'عهدة') }),
      C('accountNo', 'الحساب المرتبط', { input: 'select', options: () => leafAccounts().filter(a => isTreasury(a.code)).map(a => [a.code, accLabel(a)]), render: v => esc(acc(v) ? accLabel(acc(v)) : v) }),
      C('bankAccount', 'رقم الحساب بالبنك', { optional: true, cls: 'code' }),
      C('role', 'نطاق التعامل', { input: 'select', optional: true, allowEmpty: '— تلقائي حسب الاسم —', options: () => BOX_ROLES, render: (v, r) => plain(boxRole(r)) }),
      branchField('الفرع', { allowEmpty: '—', formOnly: false, render: v => v ? plain(v) : '—' }),
      C('balance', 'الرصيد', computed(r => acc(r.accountNo) ? ownBal(acc(r.accountNo)) : 0, { total: true }))],
      actions: [{ icon: 'cash', title: 'فتح صفحة الحركات', fn: r => goTo('box/' + r.id) }, { icon: 'list', title: 'كشف حركة الخزينة', fn: r => openLedger(r.accountNo) }],
      validate: (d, rec) => db.cashboxes.some(b => b.accountNo === d.accountNo && b !== rec) ? 'هذا الحساب مرتبط بخزينة أخرى' : '' },
    receipts: { title: 'سندات القبض', sub: 'اختر اسم الحساب ثم المستفيد من قائمته — يُرحّل بعد الاعتماد: من حـ/ الخزينة أو البنك إلى حـ/ الحساب المختار', single: 'سند قبض', key: 'no', cols: [
      C('no', 'رقم الحركة', CODE), C('date', 'تاريخ الحركة', D), boxField(), branchField(),
      C('account', 'اسم الحساب', { input: 'select', optional: true, allowEmpty: '— اختر الحساب —', dep: ['box'], options: v => boxAccOpts(v?.box, 'r'), full: true, render: (v, r) => `<span class="hint">${esc(v || (isCustomer(r.party) ? accLabel(acc(custAcc(r.party)) || { code: '', name: '' }) : '—'))}</span>` }),
      C('party', 'اسم المستفيد / الطرف', { optional: true, full: true, dyn: true, suggest: v => partyOpts(v?.account), render: (v, r) => esc(partyName(r)) }),
      C('invoice', 'سداد فاتورة', { input: 'select', optional: true, allowEmpty: '— بدون —', formOnly: true, options: () => db.salesInvoices.map(i => [i.no, `${i.no} — ${i.customer}`]), when: f => partyKind(accCode(f.account)) === 'c' }),
      C('amount', 'المبلغ', { ...M, total: true }), ...bankFields(bankSide('box'), '', CHQ_IN, false), C('desc', 'البيان', { full: true, optional: true })],
      defaults: () => ({ method: 'نقدي' }),
      validate: d => {
        const se = boxScopeErr(d, 'r'); if (se) return se;
        const be = bankCheck(d, bankSide('box'), false); if (be) return be;
        const pe = partyCheck(d); if (pe) return pe;
        const inv = db.salesInvoices.find(i => i.no === d.invoice);
        if (inv && inv.customer !== d.party) return `الفاتورة ${inv.no} تخص ${inv.customer}`;
      } },
    boxTransfers: { title: 'التحويلات بين الخزائن والبنوك', sub: 'يُرحّل: من حـ/ الخزينة أو البنك المحوَّل إليه إلى حـ/ المحوَّل منه', single: 'تحويل', key: 'no', prefix: 'BT-', cols: [
      C('no', 'رقم التحويل', CODE), C('date', 'التاريخ', D), C('from', 'من خزينة / بنك', { input: 'select', options: names('cashboxes') }),
      C('to', 'إلى خزينة / بنك', { input: 'select', dep: ['from'], options: v => db.cashboxes.map(b => b.name).filter(n => n !== v?.from) }), C('amount', 'المبلغ', { ...M, total: true }),
      ...bankFields(bankSide('from', 'to'), 'اسم المستفيد'), C('desc', 'البيان', { full: true, optional: true })],
      defaults: () => ({ method: 'نقدي' }),
      onSelect: { from: f => { f.method.value = isBankBox(f.from.value) && isBankBox(f.to.value) ? 'تحويل بنكي' : 'نقدي'; }, to: f => { f.method.value = isBankBox(f.from.value) && isBankBox(f.to.value) ? 'تحويل بنكي' : 'نقدي'; } },
      validate: (d, rec) => {
        if (d.from === d.to) return 'لا يمكن التحويل لنفس الخزينة';
        const be = bankCheck(d, bankSide('from', 'to'), false); if (be) return be;
        const a = acc(boxAcc(d.from)); const avail = a ? ownBal(a) + (rec && rec.from === d.from ? +rec.amount : 0) : 0;
        if (+d.amount > avail && !ask(`رصيد ${d.from} (${nf.format(avail)}) لا يكفي. متابعة؟`)) return 'تم الإلغاء';
      } },
    payments: { title: 'سندات الصرف', sub: 'اختر اسم الحساب ثم المستفيد من قائمته — يُرحّل بعد الاعتماد: من حـ/ الحساب المختار إلى حـ/ الخزينة أو البنك', single: 'سند صرف', key: 'no', cols: [
      C('no', 'رقم الحركة', CODE), C('date', 'تاريخ الحركة', D), boxField(), branchField(),
      C('account', 'اسم الحساب', { input: 'select', optional: true, allowEmpty: '— اختر الحساب —', dep: ['box'], options: v => boxAccOpts(v?.box, 'p'), full: true, render: (v, r) => `<span class="hint">${esc(v || (isSupplier(r.party) ? accLabel(acc(suppAcc(r.party)) || { code: '', name: '' }) : '—'))}</span>` }),
      C('party', 'اسم المستفيد', { optional: true, full: true, dyn: true, suggest: v => partyOpts(v?.account), render: (v, r) => esc(partyName(r)) }),
      C('invoice', 'سداد فاتورة', { input: 'select', optional: true, allowEmpty: '— بدون —', formOnly: true, dep: ['party', 'account'], options: v => db.purchaseInvoices.filter(i => !v?.party || i.supplier === v.party).map(i => [i.no, `${i.no} — ${i.supplier}`]), when: f => partyKind(accCode(f.account)) === 's' }),
      C('amount', 'المبلغ', { ...M, total: true }), ...bankFields(bankSide('box'), '', CHQ_OUT, false), C('desc', 'البيان', { full: true, optional: true })],
      defaults: () => ({ method: 'نقدي' }),
      validate: (d, rec) => {
        const se = boxScopeErr(d, 'p'); if (se) return se;
        const be = bankCheck(d, bankSide('box'), true, CHQ_OUT); if (be) return be;
        const pe = partyCheck(d); if (pe) return pe;
        const inv = db.purchaseInvoices.find(i => i.no === d.invoice);
        if (inv && inv.supplier !== d.party) return `الفاتورة ${inv.no} تخص ${inv.supplier}`;
        const a = acc(boxAcc(d.box)); const avail = a ? ownBal(a) + (rec && rec.box === d.box ? +rec.amount : 0) : 0;
        if (+d.amount > avail && !ask(`رصيد ${d.box} (${nf.format(avail)}) لا يكفي. هل تريد المتابعة؟`)) return 'تم الإلغاء';
      } },

    // ===== المبيعات =====
    salesInvoices: { title: 'كل فواتير المبيعات', sub: 'تُرحّل تلقائياً: من حـ/ فئة العميل إلى حـ/ مبيعات نفس الفئة و حـ/ الضرائب', single: 'فاتورة بيع', key: 'no', filter: 'status', cols: [
      C('no', 'رقم الفاتورة', CODE), C('date', 'التاريخ', D),
      C('account', 'اسم الحساب', { input: 'select', options: custAccOpts, render: v => `<span class="hint">${esc(acc(v)?.name || v || '')}</span>`, aka: ['حساب العميل'] }),
      C('customer', 'اسم العميل', { dyn: true, dynFrom: 'account', suggest: v => custOfAcc(v?.account), aka: ['العميل'] }),
      C('docNo', 'رقم المستند', { optional: true, cls: 'code' }),
      branchField('الفرع', { formOnly: false, render: v => v ? esc(v) : '<span class="hint">—</span>' }),
      C('revAcc', 'حساب الإيراد', { compute: r => accLabel(acc(salesAccR(r)) || { code: '', name: '' }), render: v => `<span class="hint">${esc(v)}</span>` }),
      C('due', 'الاستحقاق', { ...D, formOnly: true, optional: true }),
      C('warehouse', 'المخزن (للصرف من المخزون)', { input: 'select', optional: true, allowEmpty: '— بدون صرف من المخزن —', options: names('warehouses'), formOnly: true }),
      C('lines', 'الأصناف', { input: 'lines', formOnly: true, full: true, priceFrom: 'price', optionalLines: true }),
      C('itemsSum', 'الأصناف', { compute: r => linesSummary(r) || '—', render: (v, r) => Array.isArray(r.lines) && r.lines.length ? `${esc(v)} <span class="hint">(${r.lines.length})</span>` : '<span class="hint">—</span>' }),
      C('weight', 'إجمالي الوزن', { cls: 'num', compute: r => docTotals(r).weight, render: v => v ? num(v) : '—' }),
      C('amount', 'إجمالي القيمة (مدين)', { ...M, total: true, optional: true, aka: ['الصافي'] }), C('vatRate', 'نسبة الضريبة %', { ...N, formOnly: true, optional: true }),
      C('total', 'الإجمالي شامل الضريبة', computed(invTotal, { total: true })),
      C('remaining', 'المتبقي', computed(r => invTotal(r) - salesPaid(r), { total: true })),
      C('status', 'الحالة', statusOf(salesStatus, 'معلقة', 'مدفوعة جزئياً', 'مدفوعة', 'متأخرة'))],
      defaults: () => ({ vatRate: 0, due: addDays(today(), 30) }),
      load: r => r.account ? {} : { account: custAcc(r.customer) },
      actions: [{ icon: 'receive', title: 'تحصيل (سند قبض)', write: true, target: 'receipts', show: r => salesStatus(r) !== 'مدفوعة',
        fn: r => openRecordForm('receipts', null, { account: acc(custAcc(r.customer)) ? accLabel(acc(custAcc(r.customer))) : '', party: r.customer, invoice: r.no, amount: +(invTotal(r) - salesPaid(r)).toFixed(2), desc: `سداد فاتورة ${r.no}` }) }],
      wide: true,
      validate: (d, rec) => {
        const ce = custAccCheck(d); if (ce) return ce;
        const le = salesLinesCheck(d, rec, 'out'); if (le) return le;
        const c = db.customers.find(x => x.name === d.customer); if (!c || !+c.limit) return;
        const after = custBal(c.name) - (rec && rec.customer === c.name ? invTotal(rec) : 0) + +d.amount * (1 + (+d.vatRate || 0) / 100);
        if (after > +c.limit && !ask(`رصيد العميل سيصبح ${nf.format(after)} ويتجاوز حد الائتمان (${nf.format(c.limit)}). متابعة؟`)) return 'تم الإلغاء';
      } },
    salesQuotes: { title: 'عروض الأسعار', sub: 'عروض الأسعار المقدمة للعملاء (لا تُرحّل)', single: 'عرض سعر', key: 'no', filter: 'status', cols: [
      C('no', 'رقم العرض', CODE), C('customer', 'العميل', { input: 'select', options: names('customers'), full: true }), C('date', 'التاريخ', D), C('validUntil', 'ساري حتى', D),
      C('amount', 'القيمة', { ...M, total: true }), C('status', 'الحالة', status('مرسل', 'مقبول', 'مرفوض'))],
      actions: [{ icon: 'sales', title: 'تحويل إلى فاتورة', target: 'salesInvoices', show: r => r.status !== 'مرفوض',
        fn: r => openRecordForm('salesInvoices', null, { customer: r.customer, amount: r.amount }, () => { const x = db.salesQuotes.find(q => q.id === r.id); if (x) x.status = 'مقبول'; }), write: true }] },
    salesReturns: { title: 'كل فواتير المردودات', sub: 'تُرحّل: من حـ/ مبيعات النوع إلى حـ/ العميل', single: 'فاتورة مردودات', key: 'no', cols: [
      C('no', 'رقم فاتورة المردودات', CODE), C('date', 'التاريخ', D),
      C('account', 'اسم الحساب', { input: 'select', options: custAccOpts, render: v => `<span class="hint">${esc(acc(v)?.name || v || '')}</span>`, aka: ['حساب العميل'] }),
      C('customer', 'اسم العميل', { dyn: true, dynFrom: 'account', suggest: v => custOfAcc(v?.account), aka: ['العميل'] }),
      C('docNo', 'رقم المستند', { optional: true, cls: 'code' }),
      branchField('الفرع', { formOnly: false, render: v => v ? esc(v) : '<span class="hint">—</span>' }),
      C('invoice', 'فاتورة البيع الأصلية', { input: 'select', optional: true, allowEmpty: '— بدون —', options: () => db.salesInvoices.map(i => [i.no, `${i.no} — ${i.customer}`]), aka: ['الفاتورة'] }),
      C('warehouse', 'المخزن (لإعادة الأصناف للمخزون)', { input: 'select', optional: true, allowEmpty: '— بدون إعادة للمخزن —', options: names('warehouses'), formOnly: true }),
      C('lines', 'الأصناف', { input: 'lines', formOnly: true, full: true, priceFrom: 'price', optionalLines: true }),
      C('itemsSum', 'الأصناف', { compute: r => linesSummary(r) || '—', render: (v, r) => Array.isArray(r.lines) && r.lines.length ? `${esc(v)} <span class="hint">(${r.lines.length})</span>` : '<span class="hint">—</span>' }),
      C('weight', 'إجمالي الوزن', { cls: 'num', compute: r => docTotals(r).weight, render: v => v ? num(v) : '—' }),
      C('amount', 'إجمالي القيمة (دائن)', { ...M, total: true, optional: true, aka: ['القيمة', 'إجمالي القيمة (مدين)'] }), C('reason', 'السبب', { full: true, optional: true, formOnly: true })],
      wide: true,
      load: r => r.account ? {} : { account: custAcc(r.customer) },
      // اختيار فاتورة البيع الأصلية يملأ الحساب والعميل والفرع والمخزن منها
      onSelect: { invoice: (f, v) => { const inv = db.salesInvoices.find(i => i.no === v); if (!inv) return;
        const setv = (k, val) => { const el = f.namedItem(k); if (el && val && !el.value) { el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); } };
        const a = f.namedItem('account'); if (a) { a.value = inv.account || custAcc(inv.customer); a.dispatchEvent(new Event('change', { bubbles: true })); }
        const c = f.namedItem('customer'); if (c) c.value = inv.customer;
        setv('branch', inv.branch); setv('warehouse', inv.warehouse); } },
      validate: (d, rec) => { const ce = custAccCheck(d, true); if (ce) return ce; const le = salesLinesCheck(d, rec, 'in'); if (le) return le; const inv = db.salesInvoices.find(i => i.no === d.invoice); if (inv && inv.customer !== d.customer) return `الفاتورة ${inv.no} تخص ${inv.customer}`; } },

    // ===== الأرصدة الافتتاحية =====
    openingBalances: { title: 'الأرصدة الافتتاحية', sub: 'رصيد أول المدة لكل خزينة أو بنك أو صنف في مخزن أو عميل أو مورد أو حساب — يُرحّل بعد اعتماد المالك: بين الحساب و حـ/ 215 أرصدة افتتاحية', single: 'رصيد افتتاحي', key: 'no', prefix: 'OB-', filter: 'otype', cols: [
      C('no', 'رقم الحركة', CODE), C('date', 'تاريخ الرصيد', D),
      C('otype', 'نوع الرصيد', { input: 'select', options: () => OPEN_TYPES, render: plain }),
      C('box', 'الخزينة / البنك', { input: 'select', optional: true, allowEmpty: '—', options: names('cashboxes'), formOnly: true, when: f => f.otype === OPEN_TYPES[0] }),
      C('warehouse', 'المخزن', { input: 'select', optional: true, allowEmpty: '—', options: names('warehouses'), formOnly: true, when: f => f.otype === OPEN_TYPES[1] }),
      C('item', 'الصنف', { optional: true, formOnly: true, suggest: () => db.items.map(i => i.name), when: f => f.otype === OPEN_TYPES[1] }),
      C('qty', 'الكمية (بوحدة الصنف)', { ...N, optional: true, formOnly: true, when: f => f.otype === OPEN_TYPES[1] }),
      C('cost', 'تكلفة الوحدة', { ...M, optional: true, formOnly: true, when: f => f.otype === OPEN_TYPES[1] }),
      C('account', 'اسم الحساب', { input: 'select', optional: true, allowEmpty: '— اختر الحساب —', options: () => leafAccounts().filter(a => !isTreasury(a.code) && a.code !== SYS.openEq).map(accLabel), formOnly: true, full: true, when: f => f.otype === OPEN_TYPES[4] }),
      C('party', 'الاسم (العميل / المورد / الموظف)', { optional: true, formOnly: true, dyn: true, suggest: v => v?.otype === OPEN_TYPES[2] ? db.customers.map(c => c.name) : v?.otype === OPEN_TYPES[3] ? db.suppliers.map(x => x.name) : staffNames(), when: f => [OPEN_TYPES[2], OPEN_TYPES[3], OPEN_TYPES[4]].includes(f.otype) }),
      C('target', 'البيان / الجهة', { compute: openTarget }),
      C('accLbl', 'الحساب', { compute: r => { const a = openAcc(r); return a && acc(a) ? accLabel(acc(a)) : ''; }, render: v => `<span class="hint">${esc(v)}</span>` }),
      C('dr', 'مدين', { ...M, optional: true, formOnly: true, when: f => f.otype !== OPEN_TYPES[1] }),
      C('cr', 'دائن', { ...M, optional: true, formOnly: true, when: f => f.otype !== OPEN_TYPES[1] }),
      C('drv', 'مدين', computed(obDr, { total: true, render: v => v ? money(v) : '' })),
      C('crv', 'دائن', computed(obCr, { total: true, render: v => v ? money(v) : '' })),
      C('desc', 'ملاحظات', { optional: true, full: true, formOnly: true })],
      defaults: () => ({ otype: OPEN_TYPES[0], date: db.settings.fiscalStart || today() }),
      load: r => +r.dr || +r.cr ? {} : { dr: obDr(r), cr: obCr(r) },
      onSelect: { item: (f, v) => { const it = db.items.find(i => i.name === v); const c = f.namedItem('cost'); if (it && c && !+c.value) c.value = it.cost || 0; if (it && f.namedItem('warehouse') && !f.namedItem('warehouse').value) f.namedItem('warehouse').value = it.warehouse || ''; } },
      validate: (d, rec) => {
        const T = OPEN_TYPES; if (!T.includes(d.otype)) return 'اختر نوع الرصيد';
        const keep = { [T[0]]: ['box'], [T[1]]: ['warehouse', 'item', 'qty', 'cost'], [T[2]]: ['party'], [T[3]]: ['party'], [T[4]]: ['account', 'party'] }[d.otype];
        ['box', 'warehouse', 'item', 'qty', 'cost', 'account', 'party'].forEach(k => { if (!keep.includes(k)) d[k] = ''; });
        if (d.otype === T[0] && !db.cashboxes.some(b => b.name === d.box)) return 'اختر الخزينة أو البنك';
        if (d.otype === T[1]) {
          const it = db.items.find(i => normAr(i.name) === normAr(d.item)); if (!it) return 'اختر الصنف من قاعدة بيانات الأصناف'; d.item = it.name;
          if (!db.warehouses.some(w => w.name === d.warehouse)) return 'اختر المخزن';
          if (!(+d.qty > 0)) return 'اكتب الكمية';
          if (!(+d.cost > 0)) d.cost = +it.cost || 0;
          d.dr = +((+d.qty) * (+d.cost)).toFixed(2); d.cr = 0;
        }
        if (d.otype === T[2]) { const c = db.customers.find(x => normAr(x.name) === normAr(d.party)); if (!c) return 'اختر العميل'; d.party = c.name; }
        if (d.otype === T[3]) { const x = db.suppliers.find(y => normAr(y.name) === normAr(d.party)); if (!x) return 'اختر المورد'; d.party = x.name; }
        if (d.otype === T[4] && !accCode(d.account)) return 'اختر اسم الحساب';
        d.dr = +d.dr || 0; d.cr = +d.cr || 0;
        if (d.dr < 0 || d.cr < 0) return 'المبلغ لا يكون سالباً';
        if (d.dr && d.cr) return 'اكتب المبلغ في خانة المدين أو الدائن وليس الاثنين';
        if (!d.dr && !d.cr) return d.otype === T[1] ? 'اكتب الكمية والتكلفة' : 'اكتب المبلغ في خانة المدين أو الدائن';
        d.amount = d.dr || d.cr;
        const dup = db.openingBalances.find(r => r !== rec && r.otype === d.otype && openTarget(r) === openTarget(d) && (!r.appr || r.appr.status !== 'rejected'));
        if (dup && !ask(`يوجد رصيد افتتاحي مسجل لنفس الجهة (${dup.no}). متابعة؟`)) return 'تم الإلغاء';
      } },

    // ===== إدارة الموردين =====
    supplierAccruals: { title: 'استحقاقات الموردين', sub: 'موردو البضاعة (محاصيل / بضاعة / نقدي): المخزون المستلم والفرع ورقم المستند · موردو الخدمات (سيارات / برادات / عمالة / معدات): الشهر والحساب المقابل — يُرحّل بعد الاعتماد إلى حـ/ المورد', single: 'استحقاق مورد', key: 'no', prefix: 'SA-', filter: 'account', cols: [
      C('date', 'تاريخ الحركة', { ...D, aka: ['تاريخ الاستحقاق'] }), C('no', 'رقم الحركة', CODE),
      C('account', 'اسم الحساب', { input: 'select', allowEmpty: '— اختر حساب الموردين —', options: () => leafAccounts().filter(a => a.code.startsWith(SYS.suppliers)).map(accLabel), render: v => `<span class="pill">${esc(acc(accCode(v))?.name || v)}</span>` }),
      C('party', 'اسم المورد', { dyn: true, suggest: v => partyOpts(v?.account) }),
      // موردو البضاعة
      C('store', 'المخزون المستلم', { aka: ['المخزون', 'حساب المخزون'], input: 'select', optional: true, allowEmpty: '— اختر حساب المخزون —', options: () => leafAccounts().filter(a => isInvAcc(a.code)).map(accLabel), formOnly: true, when: f => suppKind(f.account) === 'goods' }),
      C('branch', 'الفرع', { input: 'select', optional: true, allowEmpty: '—', options: names('branches'), when: f => suppKind(f.account) === 'goods' }),
      C('docNo', 'رقم المستند', { aka: ['رقم الفاتورة', 'رقم مستند المورد'], optional: true, cls: 'code', when: f => suppKind(f.account) === 'goods' }),
      // موردو الخدمات
      C('periodNote', 'الفترة', { optional: true, formOnly: true, full: true, aka: ['الشهر', 'فترة الاستحقاق', 'الفترة (عمالة / معدات)', 'الشهر (سيارات / برادات)'], placeholder: 'نص أو تاريخ — مثال: من 1-7-2026 إلى 7-7-2026 أو أكتوبر-2026', render: (v, r) => esc(periodText(r)), when: f => periodMode(f.account) !== 'none' && periodMode(f.account) !== '' }),
      C('expAcc', 'الحساب المقابل', { aka: ['حساب المصروف المقابل', 'حساب المصروف'], input: 'select', optional: true, allowEmpty: '— اختر الحساب المقابل —', options: () => leafAccounts().filter(a => a.code.startsWith(SYS.expenses) || isInvAcc(a.code)).map(accLabel), formOnly: true, full: true, when: f => suppKind(f.account) === 'service' }),
      C('period', 'الفترة / المستند', { compute: r => r.store ? (r.docNo ? `مستند ${r.docNo}` : '—') : periodText(r) }),
      C('counter', 'الحساب المقابل', { compute: r => accCode(r.store || r.expAcc) ? accLabel(acc(accCode(r.store || r.expAcc)) || { code: '', name: r.store || r.expAcc }) : '', render: v => `<span class="hint">${esc(v)}</span>` }),
      C('amount', 'المبلغ', { ...M, total: true, aka: ['المبلغ المستحق'] }),
      C('bal', 'رصيد المورد الحالي', computed(r => suppBal(r.party))),
      C('desc', 'البيان', { optional: true, full: true, formOnly: true })],
      load: r => r.periodNote || r.store ? {} : { periodNote: periodText(r) },
      onSelect: { account: (f, v) => { const e = f.namedItem('expAcc'); if (e && !e.value && suppKind(v) === 'service') { const d = defaultExpFor(v); if (d) e.value = d; } },
        party: (f, v) => { const h = [...db.supplierAccruals].reverse().find(r => r.party === v);
          if (h?.expAcc && f.namedItem('expAcc')) f.namedItem('expAcc').value = h.expAcc; if (h?.store && f.namedItem('store') && !f.namedItem('store').value) f.namedItem('store').value = h.store; } },
      validate: (d, rec) => {
        const code = accCode(d.account); if (!code) return 'اختر اسم الحساب';
        fixParty(d, partyOpts(d.account)); if (!partyOpts(d.account).includes(d.party)) return `اختر المورد من موردي "${acc(code)?.name}"`;
        if (suppKind(d.account) === 'goods') {
          if (!accCode(d.store) || !isInvAcc(accCode(d.store))) return 'اختر المخزون المستلم';
          ['periodType', 'month', 'from', 'to', 'periodNote', 'expAcc'].forEach(k => { d[k] = ''; });
          if (d.docNo && db.supplierAccruals.some(r => r !== rec && r.party === d.party && r.docNo === d.docNo) && !ask(`رقم المستند ${d.docNo} مسجل من قبل لنفس المورد. متابعة؟`)) return 'تم الإلغاء';
        } else {
          ['store', 'branch', 'docNo'].forEach(k => { d[k] = ''; });
          const pe = periodCheck(d, d.account); if (pe) return pe;
          if (!accCode(d.expAcc)) return 'اختر الحساب المقابل';
          const dup = db.supplierAccruals.find(r => r !== rec && r.party === d.party && !r.store && periodText(r) === periodText(d));
          if (dup && !ask(`يوجد استحقاق للمورد ${d.party} عن نفس الفترة (${dup.no}). متابعة؟`)) return 'تم الإلغاء';
        }
        if (!(+d.amount > 0)) return 'اكتب المبلغ';
      } },

    // ===== المشتريات =====
    purchaseOrders: { title: 'أوامر الشراء', sub: 'طلبات الشراء (لا تُرحّل حتى تصدر الفاتورة)', single: 'أمر شراء', key: 'no', filter: 'status', cols: [
      C('no', 'رقم الأمر', CODE), C('supplier', 'المورد', { input: 'select', options: names('suppliers'), full: true }), C('date', 'التاريخ', D), C('delivery', 'موعد التوريد', D),
      C('warehouse', 'المخزن', { input: 'select', options: names('warehouses') }), C('lines', 'الأصناف', { input: 'lines', formOnly: true, full: true, pickOn: ['warehouse'], pick: v => v.warehouse ? i => !i.warehouse || i.warehouse === v.warehouse || stockAt(i.name, v.warehouse) > 0 : null }), C('itemsSum', 'الأصناف', { compute: linesSummary, render: (v, r) => `${esc(v || r.items || '')}` }),
      C('amount', 'القيمة (تُحسب من الأصناف)', { ...M, total: true, optional: true }), C('status', 'الحالة', status('جديد', 'معتمد', 'مستلم'))],
      validate: d => { if (linesOf(d).length) d.amount = +docTotals(d).sub.toFixed(2); if (!linesOf(d).length && !+d.amount) return 'أضف الأصناف من المخزن'; },
      actions: [{ icon: 'cart', title: 'تحويل إلى فاتورة مشتريات', target: 'purchaseInvoices', show: r => r.status !== 'جديد',
        fn: r => openRecordForm('purchaseInvoices', null, { sacc: acc(suppAcc(r.supplier)) ? accLabel(acc(suppAcc(r.supplier))) : '', supplier: r.supplier, amount: r.amount }, () => { const x = db.purchaseOrders.find(q => q.id === r.id); if (x) x.status = 'مستلم'; }), write: true }] },
    purchaseInvoices: { title: 'فواتير المشتريات', sub: 'موردو البضاعة (محاصيل / بضاعة / نقدي): المخزون المستلم والفرع ورقم فاتورة المورد · موردو الخدمات (سيارات / برادات / عمالة / معدات): الشهر والحساب المقابل — يُرحّل بعد الاعتماد إلى حـ/ المورد', single: 'فاتورة شراء', key: 'no', filter: 'status', cols: [
      C('date', 'تاريخ الحركة', { ...D, aka: ['التاريخ'] }), C('no', 'رقم الفاتورة', CODE),
      C('sacc', 'اسم الحساب', { input: 'select', optional: true, allowEmpty: '— اختر حساب الموردين —', options: () => leafAccounts().filter(a => a.code.startsWith(SYS.suppliers)).map(accLabel), render: (v, r) => `<span class="pill">${esc(acc(accCode(v) || suppAcc(r.supplier))?.name || '')}</span>` }),
      C('supplier', 'اسم المورد', { dyn: true, dynFrom: 'sacc', suggest: v => v?.sacc ? partyOpts(v.sacc) : db.suppliers.map(x => x.name), aka: ['المورد'] }),
      // موردو البضاعة
      C('store', 'المخزون المستلم', { aka: ['المخزون', 'حساب المخزون'], input: 'select', optional: true, allowEmpty: '— اختر حساب المخزون —', options: () => leafAccounts().filter(a => isInvAcc(a.code)).map(accLabel), formOnly: true, when: f => suppKind(f.sacc) === 'goods' }),
      C('branch', 'الفرع', { input: 'select', optional: true, allowEmpty: '—', options: names('branches'), when: f => suppKind(f.sacc) === 'goods' }),
      C('docNo', 'رقم فاتورة المورد', { aka: ['رقم المستند'], optional: true, cls: 'code', when: f => suppKind(f.sacc) === 'goods' }),
      // موردو الخدمات
      C('periodNote', 'الفترة', { optional: true, formOnly: true, full: true, aka: ['الشهر', 'فترة الاستحقاق', 'الفترة (عمالة / معدات)', 'الشهر (سيارات / برادات)'], placeholder: 'نص أو تاريخ — مثال: من 1-7-2026 إلى 7-7-2026 أو أكتوبر-2026', render: (v, r) => esc(periodText(r)), when: f => periodMode(f.sacc) !== 'none' && periodMode(f.sacc) !== '' }),
      C('expAcc', 'الحساب المقابل', { aka: ['يُحمّل على حساب', 'حساب المصروف'], input: 'select', optional: true, allowEmpty: '— اختر الحساب المقابل —', options: () => leafAccounts().filter(a => a.code.startsWith(SYS.expenses) || isInvAcc(a.code) || a.code.startsWith('11')).map(accLabel), formOnly: true, full: true, when: f => suppKind(f.sacc) === 'service' }),
      C('counter', 'الحساب المقابل', { compute: r => { const c = accCode(r.store || r.expAcc || r.account); return c && acc(c) ? accLabel(acc(c)) : ''; }, render: v => `<span class="hint">${esc(v)}</span>` }),
      C('period', 'الفترة / المستند', { compute: r => r.store || r.docNo ? (r.docNo ? `فاتورة ${r.docNo}` : '—') : periodText(r) || '—' }),
      C('due', 'الاستحقاق', D),
      C('amount', 'القيمة', { ...M, total: true }),
      C('remaining', 'المتبقي', computed(r => +r.amount - purchPaid(r), { total: true })),
      C('status', 'الحالة', statusOf(purchStatus, 'معلقة', 'مدفوعة جزئياً', 'مدفوعة', 'متأخرة'))],
      defaults: () => ({ due: addDays(today(), 30), store: acc(SYS.defPurchase) ? accLabel(acc(SYS.defPurchase)) : '' }),
      // الفواتير القديمة: الحساب المحمّل عليه يصبح المخزون المستلم أو الحساب المقابل
      load: r => r.sacc ? (r.periodNote || r.store ? {} : { periodNote: periodText(r) }) : { periodNote: periodText(r), sacc: acc(suppAcc(r.supplier)) ? accLabel(acc(suppAcc(r.supplier))) : '', ...(isInvAcc(accCode(r.account)) ? { store: r.account } : { expAcc: r.account, month: String(r.date || '').slice(0, 7) }) },
      onSelect: { sacc: (f, v) => { const e = f.namedItem('expAcc'); if (e && !e.value && suppKind(v) === 'service') { const d = defaultExpFor(v); if (d) e.value = d; } },
        supplier: (f, v) => { const sa = f.namedItem('sacc'); if (sa && !sa.value) { const c = suppAcc(v); if (acc(c) && c !== SYS.suppliers) sa.value = accLabel(acc(c)); }
          const h = [...db.purchaseInvoices].reverse().find(r => r.supplier === v); if (h?.expAcc && f.namedItem('expAcc')) f.namedItem('expAcc').value = h.expAcc; if (h?.store && f.namedItem('store')) f.namedItem('store').value = h.store; } },
      validate: (d, rec) => {
        if (!accCode(d.sacc) && d.supplier) { const c = suppAcc(d.supplier); if (acc(c)) d.sacc = accLabel(acc(c)); }
        const code = accCode(d.sacc); if (!code) return 'اختر اسم الحساب (فئة المورد)';
        fixParty({ get party() { return d.supplier; }, set party(x) { d.supplier = x; } }, partyOpts(d.sacc));
        if (!partyOpts(d.sacc).includes(d.supplier)) return `اختر المورد من موردي "${acc(code)?.name}"`;
        if (suppKind(d.sacc) === 'goods') {
          if (!accCode(d.store)) { const x = [d.account, d.expAcc].find(v => accCode(v) && isInvAcc(accCode(v))); if (x) d.store = x; }
          if (!accCode(d.store) || !isInvAcc(accCode(d.store))) return 'اختر المخزون المستلم';
          ['periodType', 'month', 'from', 'to', 'periodNote', 'expAcc'].forEach(k => { d[k] = ''; });
          if (d.docNo && db.purchaseInvoices.some(r => r !== rec && r.supplier === d.supplier && r.docNo === d.docNo) && !ask(`فاتورة المورد رقم ${d.docNo} مسجلة من قبل. متابعة؟`)) return 'تم الإلغاء';
        } else {
          if (!accCode(d.expAcc) && accCode(d.account)) d.expAcc = d.account;
          ['store', 'branch', 'docNo'].forEach(k => { d[k] = ''; });
          if (!d.periodNote && !d.month && !d.from && periodMode(d.sacc) === 'month') d.month = String(d.date || today()).slice(0, 7);
          const pe = periodCheck(d, d.sacc); if (pe) return pe;
          if (!accCode(d.expAcc)) return 'اختر الحساب المقابل';
        }
        d.account = d.store || d.expAcc;
        if (!(+d.amount > 0)) return 'اكتب قيمة الفاتورة';
      },
      actions: [{ icon: 'pay', title: 'سداد (سند صرف)', write: true, target: 'payments', show: r => purchStatus(r) !== 'مدفوعة',
        fn: r => openRecordForm('payments', null, { account: accLabel(acc(accCode(r.sacc) || suppAcc(r.supplier)) || { code: '', name: '' }), party: r.supplier, invoice: r.no, amount: +(r.amount - purchPaid(r)).toFixed(2), desc: `سداد فاتورة ${r.no}` }) }] },
    purchaseReturns: { title: 'مرتجعات المشتريات', sub: 'تُرحّل: من حـ/ الموردين إلى حـ/ المخزون', single: 'مرتجع', key: 'no', cols: [
      C('no', 'رقم المرتجع', CODE), C('supplier', 'المورد', { input: 'select', options: names('suppliers') }),
      C('invoice', 'الفاتورة', { input: 'select', optional: true, allowEmpty: '— بدون —', options: () => db.purchaseInvoices.map(i => [i.no, `${i.no} — ${i.supplier}`]) }),
      C('date', 'التاريخ', D), C('account', 'الحساب الدائن', { input: 'select', options: leafOpts(SYS.inventory, SYS.finished, '3', '11'), formOnly: true, full: true }),
      C('amount', 'القيمة', { ...M, total: true }), C('reason', 'السبب', { full: true })],
      defaults: () => ({ account: acc(SYS.defPurchase) ? accLabel(acc(SYS.defPurchase)) : '' }),
      validate: d => { const inv = db.purchaseInvoices.find(i => i.no === d.invoice); if (inv && inv.supplier !== d.supplier) return `الفاتورة ${inv.no} تخص ${inv.supplier}`; } },

    // ===== المخازن =====
    stockIn: { title: 'أذون الإضافة (الاستلام)', sub: 'استلام أصناف — عدة أصناف في الإذن · بعد الاعتماد يُرحّل: من حـ/ المخزون و ض.ق.م إلى حـ/ المورد و ض. الخصم والإضافة', single: 'إذن إضافة', key: 'no', wide: true, filter: 'warehouse', cols: [
      C('no', 'رقم الحركة', CODE), C('date', 'تاريخ الحركة', D), C('warehouse', 'اسم المخزن', { input: 'select', options: names('warehouses') }),
      C('account', 'اسم الحساب', { input: 'select', optional: true, allowEmpty: '— حساب مخزون كل صنف —', options: () => leafAccounts().filter(a => isInvAcc(a.code)).map(accLabel), render: v => `<span class="hint">${v ? esc(v) : 'حسب الصنف'}</span>` }),
      C('supplier', 'المورد', { input: 'select', optional: true, allowEmpty: '— بدون مورد —', options: names('suppliers'), render: (v, r) => esc(v || r.source || '—') }),
      C('branch', 'الفرع', { input: 'select', optional: true, allowEmpty: '—', options: names('branches') }),
      C('lines', 'الأصناف', { input: 'lines', formOnly: true, full: true, tax: true, pickOn: ['account', 'warehouse'],
        pick: v => (v.account || v.warehouse) ? i => (!v.account || !i.store || i.store === accCode(v.account)) && (!v.warehouse || !i.warehouse || i.warehouse === v.warehouse || stockAt(i.name, v.warehouse) > 0) : null }),
      C('itemsSum', 'الأصناف', { compute: linesSummary, render: (v, r) => `${esc(v)} <span class="hint">(${docTotals(r).n})</span>` }),
      C('sub', 'القيمة', computed(r => docTotals(r).sub, { total: true })), C('vat', 'ض.ق.م', computed(r => docTotals(r).vat, { total: true })),
      C('wht', 'ض. خصم وإضافة', computed(r => docTotals(r).wht, { total: true })), C('net', 'صافي الفاتورة', computed(r => docTotals(r).net, { total: true, render: v => `<b>${money(v)}</b>` })),
      C('notes', 'البيان', { optional: true, full: true, formOnly: true })],
      validate: (d, rec) => stockDocCheck(d, rec, 'in') },
    stockOut: { title: 'أذون الصرف', sub: 'صرف أصناف لمركز تكلفة — عدة أصناف في الإذن · بعد الاعتماد يُرحّل بالتكلفة: من حـ/ الحساب المختار إلى حـ/ المخزون', single: 'إذن صرف', key: 'no', wide: true, filter: 'warehouse', cols: [
      C('no', 'رقم الحركة', CODE), C('date', 'تاريخ الحركة', D), C('warehouse', 'اسم المخزن', { input: 'select', options: names('warehouses') }),
      C('account', 'اسم الحساب', { input: 'select', optional: true, allowEmpty: '— اختر الحساب المدين —', options: () => leafAccounts().filter(a => !isTreasury(a.code) && !isInvAcc(a.code) && /^[123]/.test(a.code)).map(accLabel), render: v => `<span class="hint">${esc(v || '—')}</span>` }),
      C('costCenter', 'جهة الصرف (مركز التكلفة)', { input: 'select', optional: true, allowEmpty: '— اختر مركز التكلفة —', options: () => db.costCenters.map(c => [c.name, `${c.name}${c.sector ? ' — ' + c.sector : ''}`]), render: (v, r) => esc(v || r.to || '—') }),
      C('branch', 'الفرع التابع له', { input: 'select', optional: true, allowEmpty: '—', options: names('branches') }),
      C('lines', 'الأصناف', { input: 'lines', formOnly: true, full: true, pickOn: ['warehouse'], pick: v => v.warehouse ? i => stockAt(i.name, v.warehouse) > 0 : null }),
      C('itemsSum', 'الأصناف', { compute: linesSummary, render: (v, r) => `${esc(v)} <span class="hint">(${docTotals(r).n})</span>` }),
      C('net', 'القيمة بالتكلفة', computed(r => docTotals(r).sub, { total: true, render: v => `<b>${money(v)}</b>` })),
      C('notes', 'البيان', { optional: true, full: true, formOnly: true })],
      onSelect: { costCenter: (f, v) => { const c = db.costCenters.find(x => x.name === v), b = f.namedItem('branch'); if (c && b) b.value = c.branch || ''; } },
      validate: (d, rec) => stockDocCheck(d, rec, 'out') },
    transfers: { title: 'التحويلات المخزنية', sub: 'نقل رصيد بين المخازن', single: 'تحويل', key: 'no', cols: [
      C('no', 'رقم التحويل', CODE), C('date', 'التاريخ', D), C('from', 'من مخزن', { input: 'select', options: names('warehouses') }),
      C('to', 'إلى مخزن', { input: 'select', dep: ['from'], options: v => db.warehouses.map(w => w.name).filter(n => n !== v?.from) }),
      C('item', 'الصنف', { input: 'select', dep: ['from'], options: v => db.items.filter(i => !v?.from || stockAt(i.name, v.from) > 0).map(i => [i.name, `${i.name} — رصيد ${num(stockAt(i.name, v?.from || ''))}`]) }), C('qty', 'الكمية', N), C('unit', 'الوحدة', { input: 'select', optional: true, allowEmpty: '— وحدة الصنف —', options: () => db.units.map(u => u.name) }), C('baseQty', 'بوحدة الصنف', { cls: 'num', compute: r => r.unit && r.unit !== itemUnit(r.item) ? baseQty(r) : '', render: (v, r) => v === '' ? '' : `${num(v)} ${esc(itemUnit(r.item))}` })],
      onSelect: { item: unitPick },
      validate: (d, rec) => {
        if (d.from === d.to) return 'لا يمكن التحويل لنفس المخزن';
        const ue = unitErr(d); if (ue) return ue;
        const avail = stockAt(d.item, d.from) + (rec && rec.item === d.item && rec.from === d.from ? baseQty(rec) : 0) - (rec && rec.item === d.item && rec.to === d.from ? baseQty(rec) : 0);
        if (baseQty(d) > avail) return `الرصيد المتاح من "${d.item}" في ${d.from} هو ${num(avail)} ${itemUnit(d.item)} فقط`;
      } },

    // ===== شئون العاملين =====
    employees: { title: 'العاملين', sub: 'مرتباتهم تُرحّل على فئة "مرتبات العاملين" — حسب نوع التكلفة (تشغيلية / تسويقية / إدارية)', single: 'موظف', key: 'name', filter: 'department', defaults: () => ({ costType: 'إدارية' }), cols: [
      C('code', 'الكود', CODE), C('name', 'اسم الموظف', { full: true }),
      C('payGroup', 'الحساب الرئيسي (المرتبات المستحقة)', { input: 'select', optional: true, allowEmpty: '— مرتبات العاملين —', options: payGroupOpts, full: true, render: v => v ? `<span class="pill">${esc(v)}</span>` : '—' }),
      C('department', 'الإدارة', { input: 'select', options: names('departments') }),
      C('job', 'الوظيفة'), C('costCenter', 'مركز التكلفة', { input: 'select', optional: true, allowEmpty: '— بدون —', options: () => db.costCenters.map(c => [c.name, `${c.name} — ${c.branch || ''}`]) }),
      C('costType', 'نوع التكلفة', { render: plain, input: 'select', options: () => COST_TYPES }),
      C('hireDate', 'تاريخ التعيين', D), C('salary', 'الراتب الأساسي', { ...M, total: true }),
      C('onLeave', 'الحالة اليوم', { compute: r => db.leaves.some(l => l.employee === r.name && l.status === 'معتمدة' && l.from <= today() && l.to >= today()) ? 'إجازة' : r.status, render: pill }),
      C('status', 'حالة التعاقد', { ...status('نشط', 'موقوف'), formOnly: true })] },
    attendance: { title: 'الحضور والانصراف', sub: 'سجل الحضور اليومي للموظفين', single: 'سجل حضور', filter: 'status', cols: [
      C('no', 'رقم الحركة', CODE),
      C('date', 'التاريخ', D), C('employee', 'الموظف / العامل', { input: 'select', options: staffNames, full: true }),
      C('timeIn', 'الحضور', { input: 'time', optional: true }), C('timeOut', 'الانصراف', { input: 'time', optional: true }), C('status', 'الحالة', status('حاضر', 'متأخر', 'غائب', 'إجازة'))] },
    payroll: { title: 'الرواتب', sub: 'الاستحقاق: من حـ/ المرتبات إلى حـ/ المرتبات المستحقة · الصرف: من حـ/ المستحقة إلى حـ/ الخزينة', single: 'راتب', filter: 'paid', cols: [
      C('no', 'رقم الحركة', CODE),
      C('month', 'الشهر', { input: 'month' }),
      C('group', 'الحساب الرئيسي (فئة المرتبات)', { render: plain, input: 'select', options: () => payGroupOpts().filter(([g]) => payGroups().includes(g)) }),
      C('employee', 'الموظف / العامل', { input: 'select', dep: ['group'], options: v => allStaff().filter(x => !v?.group || x.group === v.group).map(x => [x.name, `${x.name} — ${pageInfo(x._t).title}`]) }),
      C('costType', 'نوع التكلفة', { render: plain, input: 'select', options: () => COST_TYPES }),
      C('expAcc', 'حساب المصروف', { compute: r => accLabel(acc(payAccs(r.group, r.costType).exp) || { code: '', name: '' }), render: v => `<span class="hint">${esc(v)}</span>` }),
      C('basic', 'الأساسي', { ...M, total: true }), C('allowances', 'البدلات والحوافز', { ...M, total: true }), C('deductions', 'الاستقطاعات', { ...M, total: true }),
      C('net', 'صافي الراتب', computed(r => r.basic + r.allowances - r.deductions, { total: true, render: v => `<b>${money(v)}</b>` })),
      C('paid', 'الحالة', status('مستحق', 'مصروف')), boxField('يُصرف من')],
      defaults: () => ({ allowances: 0, deductions: 0, paid: 'مستحق', costType: 'إدارية', box: db.cashboxes.find(b => b.type === 'بنك')?.name }),
      onSelect: { employee: (f, v) => { const e = staffOf(v); if (e) { f.basic.value = e.salary; if (e.group) f.group.value = e.group; if (e.costType && f.costType) f.costType.value = e.costType; } } },
      actions: [{ icon: 'pay', title: 'صرف الراتب', write: true, show: r => r.paid === 'مستحق', fn: r => {
        const x = db.payroll.find(p => p.id === r.id); if (!x || !can('payroll', 'e')) return denied();
        x.paid = 'مصروف'; submitForApproval('payroll', x, true); save(); renderPage(); renderNav(); toast(`تم صرف راتب ${x.employee} من ${x.box}`); } }],
      validate: (d, rec) => db.payroll.some(p => p !== rec && p.month === d.month && p.employee === d.employee) ? `راتب ${d.employee} عن ${d.month} مسجل من قبل` : '' },
    leaves: { title: 'الإجازات', sub: 'الإجازة المعتمدة تظهر في حالة الموظف تلقائياً', single: 'إجازة', filter: 'status', cols: [
      C('no', 'رقم الحركة', CODE),
      C('employee', 'الموظف / العامل', { input: 'select', options: staffNames, full: true }), C('type', 'نوع الإجازة', { render: plain, input: 'select', options: opt('اعتيادية', 'عارضة', 'مرضية', 'بدون أجر') }),
      C('from', 'من', D), C('to', 'إلى', D), C('days', 'الأيام', { cls: 'num', compute: r => Math.max(0, Math.round((new Date(r.to) - new Date(r.from)) / 864e5) + 1) }),
      C('status', 'الحالة', status('قيد المراجعة', 'معتمدة', 'مرفوض'))],
      validate: d => d.to < d.from ? 'تاريخ النهاية قبل تاريخ البداية' : '' },

    // ===== شئون العمالة =====
    workers: { title: 'العمال', sub: 'نوع التكلفة يحدد حساب الأجور: تشغيلية أو تسويقية أو إدارية', single: 'عامل', key: 'name', filter: 'status', defaults: () => ({ costType: 'تشغيلية' }), cols: [
      C('code', 'الكود', CODE), C('name', 'اسم العامل', { full: true }), C('craft', 'الحرفة'), C('site', 'الموقع'),
      C('wage', 'اليومية', M), C('costType', 'نوع التكلفة', { render: plain, input: 'select', options: () => COST_TYPES }),
      C('days', 'أيام العمل', { cls: 'num', compute: r => sum(db.dailyLabor.filter(d => d.worker === r.name), d => d.days) }),
      C('advance', 'السلف', computed(r => sum(db.advances.filter(a => a.worker === r.name && a.type === 'سلفة'), a => a.amount), { total: true })),
      C('status', 'الحالة', status('نشط', 'موقوف'))] },
    dailyLabor: { title: 'يوميات العمال', sub: 'تُرحّل: من حـ/ أجور العمالة (حسب نوع تكلفة العامل) إلى حـ/ الخزينة', single: 'يومية', cols: [
      C('no', 'رقم الحركة', CODE),
      C('date', 'أسبوع', D), C('worker', 'العامل', { input: 'select', options: () => db.workers.filter(w => w.status === 'نشط').map(w => w.name) }), C('site', 'الموقع'),
      C('days', 'أيام العمل', N), C('wage', 'اليومية', M), C('total', 'المستحق', computed(r => r.days * r.wage, { total: true })), boxField('يُصرف من')],
      defaults: () => ({ days: 6, box: db.cashboxes.find(b => b.type === 'خزينة')?.name }),
      onSelect: { worker: (f, v) => { const w = db.workers.find(x => x.name === v); if (w) { f.wage.value = w.wage; f.site.value = w.site; } } } },
    advances: { title: 'السلف والجزاءات', sub: 'السلفة: من حـ/ نوع السلفة (أرصدة مدينة أخرى) · المكافأة: من حـ/ الأجور · الجزاء لا يُرحّل', single: 'حركة', filter: 'type', cols: [
      C('no', 'رقم الحركة', CODE),
      C('date', 'التاريخ', D), C('worker', 'العامل', { input: 'select', options: names('workers') }), C('type', 'النوع', status('سلفة', 'جزاء', 'مكافأة')),
      C('advType', 'نوع السلفة', { render: v => v ? plain(v) : '—', input: 'select', optional: true, allowEmpty: '— للسلفة فقط —', options: advCats }),
      C('amount', 'المبلغ', M), boxField(), C('notes', 'ملاحظات', { full: true, optional: true })],
      validate: d => d.type === 'سلفة' && !d.advType ? 'اختر نوع السلفة' : '' },

    // ===== الميكنة =====
    // ===== أوامر وطلبات الدفع (لا تُرحّل — تتحول إلى سند صرف بعد الاعتماد) =====
    expenseOrders: { title: 'أوامر دفع المصروفات', prefix: 'EXP-', sub: 'طلب صرف مصروف على حساب ومركز تكلفة — بعد الاعتماد يتحول إلى سند صرف', single: 'أمر دفع مصروف', key: 'no', filter: 'status', cols: [
      C('no', 'رقم الأمر', CODE), C('date', 'التاريخ', D), branchField(),
      C('box', 'يُصرف من (الخزينة الرئيسية / البنوك)', { input: 'select', options: payBoxOpts }),
      C('account', 'حساب المصروف', { input: 'select', options: expAccOpts, full: true, render: v => `<span class="hint">${esc(v || '')}</span>` }),
      C('costCenter', 'مركز التكلفة', { input: 'select', optional: true, allowEmpty: '— بدون —', options: () => db.costCenters.map(c => c.name) }),
      C('party', 'المستفيد', { optional: true }), C('amount', 'المبلغ', { ...M, total: true }),
      C('desc', 'البيان', { full: true, optional: true }), C('status', 'الحالة', status('جديد', 'معتمد', 'مدفوع', 'مرفوض'))],
      actions: [{ icon: 'pay', title: 'صرف — إنشاء سند صرف', target: 'payments', show: r => r.status === 'معتمد', write: true,
        fn: r => openRecordForm('payments', null, { box: r.box || payBoxOpts()[0] || '', account: r.account, party: r.party || '', amount: r.amount, desc: `أمر دفع مصروف ${r.no}${r.desc ? ' — ' + r.desc : ''}`, branch: r.branch || '' },
          () => { const x = db.expenseOrders.find(q => q.id === r.id); if (x) x.status = 'مدفوع'; }) }] },
    supplierPayReqs: { title: 'طلبات دفع الموردين', prefix: 'SPR-', sub: 'طلب سداد لمورد (كامل الرصيد أو فاتورة محددة) — بعد الاعتماد يتحول إلى سند صرف', single: 'طلب دفع مورد', key: 'no', filter: 'status', cols: [
      C('no', 'رقم الطلب', CODE), C('date', 'التاريخ', D),
      C('box', 'يُصرف من (الخزينة الرئيسية / البنوك)', { input: 'select', options: payBoxOpts }),
      C('sacc', 'الحساب الرئيسي', { input: 'select', optional: true, allowEmpty: '— كل حسابات الموردين —', options: () => childrenOf(SYS.suppliers).map(accLabel), formOnly: true }),
      C('supplier', 'المورد', { input: 'select', dep: ['sacc'], options: v => [...new Set(db.suppliers.filter(x => !v?.sacc || recAcc(SYS.suppliers, x) === accCode(v.sacc)).map(x => x.name))], full: true }),
      C('due', 'المستحق للمورد', computed(r => suppBal(r.supplier))),
      C('invoice', 'سداد فاتورة', { input: 'select', optional: true, allowEmpty: '— بدون —', dep: ['supplier'], options: v => db.purchaseInvoices.filter(i => !v?.supplier || i.supplier === v.supplier).map(i => [i.no, `${i.no} — ${i.supplier}`]) }),
      C('amount', 'المبلغ المطلوب', { ...M, total: true }), C('payDate', 'تاريخ السداد المطلوب', { ...D, optional: true }),
      C('desc', 'البيان', { full: true, optional: true }), C('status', 'الحالة', status('جديد', 'معتمد', 'مدفوع', 'مرفوض'))],
      validate: d => { const inv = db.purchaseInvoices.find(i => i.no === d.invoice); if (inv && inv.supplier !== d.supplier) return `الفاتورة ${inv.no} تخص ${inv.supplier}`; },
      actions: [{ icon: 'pay', title: 'صرف — إنشاء سند صرف', target: 'payments', show: r => r.status === 'معتمد', write: true,
        fn: r => { const a = acc(suppAcc(r.supplier));
          openRecordForm('payments', null, { box: r.box || payBoxOpts()[0] || '', account: a ? accLabel(a) : '', party: r.supplier, invoice: r.invoice || '', amount: r.amount, desc: `طلب دفع مورد ${r.no}${r.desc ? ' — ' + r.desc : ''}` },
            () => { const x = db.supplierPayReqs.find(q => q.id === r.id); if (x) x.status = 'مدفوع'; }); } }] },
    purchaseQuotes: { title: 'عروض أسعار الموردين', prefix: 'PQ-', sub: 'عروض الأسعار الواردة من الموردين — العرض المقبول يتحول إلى أمر توريد', single: 'عرض سعر', key: 'no', filter: 'status', cols: [
      C('no', 'رقم العرض', CODE), C('date', 'التاريخ', D), C('supplier', 'المورد', { input: 'select', options: names('suppliers'), full: true }),
      C('warehouse', 'المخزن', { input: 'select', options: names('warehouses') }), C('lines', 'الأصناف', { input: 'lines', formOnly: true, full: true, pickOn: ['warehouse'], pick: v => v.warehouse ? i => !i.warehouse || i.warehouse === v.warehouse || stockAt(i.name, v.warehouse) > 0 : null }), C('itemsSum', 'الأصناف', { compute: linesSummary, render: (v, r) => `${esc(v || r.items || '')}` }),
      C('amount', 'القيمة (تُحسب من الأصناف)', { ...M, total: true, optional: true }), C('validUntil', 'صالح حتى', { ...D, optional: true }),
      C('notes', 'ملاحظات', { optional: true, full: true, formOnly: true }), C('status', 'الحالة', status('جديد', 'مقبول', 'مرفوض'))],
      actions: [{ icon: 'cart', title: 'تحويل إلى أمر توريد', target: 'purchaseOrders', show: r => r.status === 'مقبول', write: true,
        fn: r => openRecordForm('purchaseOrders', null, { supplier: r.supplier, warehouse: r.warehouse || '', lines: r.lines || [], amount: r.amount, date: today() }) }],
      validate: d => { if (linesOf(d).length) d.amount = +docTotals(d).sub.toFixed(2); if (!linesOf(d).length && !+d.amount) return 'أضف الأصناف من المخزن'; } },
    stockRequests: { title: 'طلبات الصرف', sub: 'طلب صرف أصناف من مخزن لمركز تكلفة — بعد الاعتماد يتحول إلى إذن صرف', single: 'طلب صرف', key: 'no', prefix: 'MR-', filter: 'status', cols: [
      C('no', 'رقم الطلب', CODE), C('date', 'التاريخ', D),
      C('warehouse', 'المخزن', { input: 'select', options: names('warehouses') }),
      C('costCenter', 'جهة الصرف (مركز التكلفة)', { input: 'select', optional: true, allowEmpty: '— اختر —', options: () => db.costCenters.map(c => c.name) }),
      branchField(),
      C('lines', 'الأصناف المطلوبة', { input: 'lines', formOnly: true, full: true, pickOn: ['warehouse'], pick: v => v.warehouse ? i => stockAt(i.name, v.warehouse) > 0 : null }),
      C('itemsSum', 'الأصناف', { compute: linesSummary, render: v => esc(v) }),
      C('notes', 'البيان', { optional: true, full: true, formOnly: true }), C('status', 'الحالة', status('جديد', 'معتمد', 'منفذ', 'مرفوض'))],
      validate: d => { if (!linesOf(d).length) return 'أضف الأصناف المطلوبة'; },
      actions: [{ icon: 'pay', title: 'تنفيذ — إنشاء إذن صرف', target: 'stockOut', show: r => r.status === 'معتمد', write: true,
        fn: r => openRecordForm('stockOut', null, { warehouse: r.warehouse, costCenter: r.costCenter || '', branch: r.branch || '', lines: r.lines || [], notes: `طلب صرف ${r.no}${r.notes ? ' — ' + r.notes : ''}` },
          () => { const x = db.stockRequests.find(q => q.id === r.id); if (x) x.status = 'منفذ'; }) }] },
    // ===== الأصول الثابتة: الإهلاك بطريقة القسط الثابت حتى اليوم =====
    fixedAssets: { title: 'الأصول الثابتة', sub: 'سجل الأصول — الإهلاك بالقسط الثابت: (التكلفة − الخردة) ÷ العمر الإنتاجي، محسوب حتى اليوم', single: 'أصل ثابت', key: 'name', filter: 'category', cols: [
      C('code', 'الكود', CODE), C('name', 'اسم الأصل', { full: true }),
      C('category', 'النوع', { render: plain, suggest: () => [...new Set(['مباني', 'أراضي', 'آلات ومعدات', 'سيارات', 'أثاث ومفروشات', 'أجهزة كمبيوتر', 'آبار وشبكات ري', ...db.fixedAssets.map(a => a.category).filter(Boolean)])] }),
      C('account', 'حساب الأصل', { input: 'select', optional: true, allowEmpty: '— اختر من الدليل —', options: () => leafAccounts().filter(a => a.code.startsWith('11')).map(accLabel), formOnly: true }),
      C('branch', 'الفرع / الموقع', { input: 'select', optional: true, allowEmpty: '—', options: names('branches') }),
      C('buyDate', 'تاريخ الشراء', D), C('cost', 'التكلفة', { ...M, total: true }),
      C('life', 'العمر الإنتاجي (سنة)', { ...N, optional: true }), C('salvage', 'قيمة الخردة', { ...M, optional: true, formOnly: true }),
      C('dep', 'مجمع الإهلاك', computed(r => assetDep(r), { total: true })),
      C('book', 'القيمة الدفترية', computed(r => +r.cost - assetDep(r), { total: true })),
      C('status', 'الحالة', status('قيد الاستخدام', 'متوقف', 'مستبعد'))],
      defaults: () => ({ status: 'قيد الاستخدام', code: nextNo(db.fixedAssets, 'code') || 'FA-001' }) },
    machines: { title: 'المعدات والآلات', sub: 'الحالة تصبح "في الصيانة" تلقائياً عند وجود أمر صيانة مفتوح', single: 'معدة', key: 'name', filter: 'state', cols: [
      C('code', 'الكود', CODE), C('name', 'اسم المعدة', { full: true }), C('type', 'النوع'), C('serial', 'رقم الشاسيه / المسلسل', { cls: 'code' }),
      C('site', 'موقع العمل'), C('hourRate', 'تكلفة الساعة', M),
      C('hours', 'ساعات التشغيل', { cls: 'num', compute: r => sum(db.machineOps.filter(o => o.machine === r.name), o => o.hours) }),
      C('maint', 'تكلفة الصيانة', computed(r => sum(db.maintenanceOrders.filter(o => o.machine === r.name && o.status === 'مكتمل'), o => o.cost), { total: true })),
      C('state', 'الحالة', statusOf(machineState, 'تعمل', 'في الصيانة', 'متوقفة')),
      C('status', 'الحالة التشغيلية', { ...status('تعمل', 'متوقفة'), formOnly: true })] },
    machineOps: { title: 'تشغيل المعدات', sub: 'التكلفة = الساعات × تكلفة ساعة المعدة', single: 'تشغيل', cols: [
      C('no', 'رقم الحركة', CODE),
      C('date', 'التاريخ', D), C('machine', 'المعدة', { input: 'select', options: () => db.machines.filter(m => machineState(m) === 'تعمل').map(m => m.name) }),
      C('operator', 'السائق / المشغل', { input: 'select', options: names('workers') }),
      C('site', 'الموقع'), C('hours', 'ساعات التشغيل', { ...N, total: true }), C('fuel', 'الوقود (لتر)', { ...N, total: true }),
      C('cost', 'تكلفة التشغيل', computed(r => r.hours * (db.machines.find(m => m.name === r.machine)?.hourRate || 0), { total: true }))],
      onSelect: { machine: (f, v) => { const m = db.machines.find(x => x.name === v); if (m) f.site.value = m.site; } } },

    // ===== الصيانة =====
    maintenanceOrders: { title: 'أوامر الصيانة', sub: 'الأمر المكتمل يُرحّل: من حـ/ الصيانة إلى حـ/ الخزينة', single: 'أمر صيانة', key: 'no', filter: 'status', cols: [
      C('no', 'رقم الأمر', CODE), C('date', 'التاريخ', D), C('machine', 'المعدة', { input: 'select', options: names('machines'), full: true }),
      C('type', 'النوع', status('وقائية', 'طارئة')), C('technician', 'الفني المسئول', { input: 'select', options: () => [...db.employees.map(e => e.name), ...db.workers.map(w => w.name)] }),
      C('cost', 'التكلفة', { ...M, total: true }), boxField('تُصرف من'), C('status', 'الحالة', status('مفتوح', 'جاري التنفيذ', 'مكتمل'))],
      defaults: () => ({ cost: 0, status: 'مفتوح' }),
      afterSave: r => { if (r.status === 'مكتمل') db.maintenancePlan.filter(p => p.machine === r.machine && p.nextDate <= r.date).forEach(p => { p.lastDate = r.date; }); } },
    maintenancePlan: { title: 'الصيانة الدورية', sub: 'الحالة تُحسب من تاريخ الصيانة القادمة', single: 'بند صيانة', filter: 'status', cols: [
      C('no', 'رقم الحركة', CODE),
      C('machine', 'المعدة', { input: 'select', options: names('machines') }), C('task', 'العمل المطلوب', { full: true }), C('interval', 'الدورية'),
      C('lastDate', 'آخر صيانة', D), C('nextDate', 'الصيانة القادمة', D), C('status', 'الحالة', statusOf(planStatus, 'منتظمة', 'قريبة', 'متأخرة'))],
      actions: [{ icon: 'wrench', title: 'إنشاء أمر صيانة', write: true, target: 'maintenanceOrders', fn: r => openRecordForm('maintenanceOrders', null, { machine: r.machine, type: 'وقائية' }) }] },
  };

  // الروابط بين الجداول: عند تغيير الاسم يتحدث في كل مكان، ولا يُحذف سجل مستخدم
  const refs = {
    customers: [['openingBalances', 'party'], ['salesInvoices', 'customer'], ['salesQuotes', 'customer'], ['salesReturns', 'customer'], ['receipts', 'party']],
    suppliers: [['openingBalances', 'party'], ['purchaseOrders', 'supplier'], ['purchaseInvoices', 'supplier'], ['purchaseReturns', 'supplier'], ['payments', 'party'], ['stockIn', 'supplier'], ['supplierAccruals', 'party']],
    items: [['openingBalances', 'item'], ['stockIn', 'item'], ['stockOut', 'item'], ['transfers', 'item'], ['salesItems', 'stockItem']],
    warehouses: [['openingBalances', 'warehouse'], ['items', 'warehouse'], ['stockIn', 'warehouse'], ['stockOut', 'warehouse'], ['transfers', 'from'], ['transfers', 'to']],
    departments: [['employees', 'department']],
    employees: [['attendance', 'employee'], ['payroll', 'employee'], ['leaves', 'employee'], ['maintenanceOrders', 'technician']],
    girlsFixed: [['attendance', 'employee'], ['payroll', 'employee'], ['leaves', 'employee']],
    girlsTemp: [['attendance', 'employee'], ['payroll', 'employee'], ['leaves', 'employee']],
    bangladesh: [['attendance', 'employee'], ['payroll', 'employee'], ['leaves', 'employee']],
    salesItems: [['salesInvoices', 'item'], ['salesReturns', 'item']],
    units: [['items', 'unit'], ['salesItems', 'unit'], ['units', 'base'], ['stockIn', 'unit'], ['stockOut', 'unit'], ['transfers', 'unit']],
    costCenters: [['employees', 'costCenter'], ['girlsFixed', 'costCenter'], ['girlsTemp', 'costCenter'], ['bangladesh', 'costCenter'], ['stockOut', 'costCenter']],
    branches: [['costCenters', 'branch'], ['stockIn', 'branch'], ['stockOut', 'branch']],
    workers: [['dailyLabor', 'worker'], ['advances', 'worker'], ['machineOps', 'operator'], ['maintenanceOrders', 'technician']],
    machines: [['machineOps', 'machine'], ['maintenanceOrders', 'machine'], ['maintenancePlan', 'machine']],
    cashboxes: [['openingBalances', 'box'], ['receipts', 'box'], ['payments', 'box'], ['boxTransfers', 'from'], ['boxTransfers', 'to'], ['payroll', 'box'], ['dailyLabor', 'box'], ['advances', 'box'], ['maintenanceOrders', 'box']],
    salesInvoices: [['receipts', 'invoice'], ['salesReturns', 'invoice']],
    purchaseInvoices: [['payments', 'invoice'], ['purchaseReturns', 'invoice']],
  };
  const usages = (name, value) => (refs[name] || []).map(([t, f]) => [t, db[t].filter(r => r[f] === value || (Array.isArray(r.lines) && r.lines.some(l => l[f] === value))).length]).filter(([, n]) => n);

  // ---------- الصفحات الخاصة ----------
  const pages = {
    dashboard: { title: 'لوحة المعلومات', sub: 'نظرة عامة على أداء الشركة', render: renderDashboard },
    accounts: { title: 'شجرة الحسابات', sub: 'الأرصدة = الرصيد الافتتاحي + الحركات المرحّلة', render: renderTree },
    journal: { title: 'القيود اليومية', sub: 'القيود اليدوية والقيود المتولدة تلقائياً من المستندات', render: renderJournal },
    ledger: { title: 'كشف حساب', sub: 'حركة الحساب التفصيلية والرصيد المتحرك', render: renderLedger },
    reports: { title: 'القوائم المالية مجمّعة', sub: 'قائمة الدخل، المركز المالي، ميزان المراجعة في صفحة واحدة', render: () => renderReports() },
    stockBalances: { title: 'أرصدة المخازن', sub: 'رصيد كل صنف في كل مخزن', render: renderStockBalances },
    import: { title: 'استيراد البيانات', sub: 'من Excel أو CSV إلى أي جدول', render: renderImport },
    reportCenter: { title: 'مركز التقارير', sub: 'التقارير المالية والمحاسبية وتقارير الإدارات', render: renderReportCenter },
    approvals: { title: 'الموافقات', sub: 'اعتماد المستندات قبل ترحيلها', render: renderApprovals },
    users: { title: 'المستخدمون والصلاحيات', sub: 'حسابات الدخول وصلاحيات كل مستخدم', render: renderUsers },
    database: { title: 'قاعدة البيانات', sub: 'الجداول والسعة والنسخ الاحتياطي', render: renderDatabase },
    settings: { title: 'الإعدادات', sub: 'بيانات المنشأة', render: renderSettings },
  };
  // فواتير ومردودات كل نوع مبيعات: صفحات على نفس الجدول، العملاء من فئة النوع فقط
  const custOfType = ty => db.customers.filter(c => c.category === 'عملاء ' + ty).map(c => c.name);
  SALE_TYPES.forEach(([k, ty]) => {
    const view = r => saleType(r) === ty;
    const custCol = c => c.key === 'account' ? { ...c, options: () => custAccOpts().filter(([code]) => code === catAcc(SYS.customers, 'عملاء ' + ty)) }
      : c.key === 'customer' && c.dyn ? { ...c, suggest: v => custOfAcc(v?.account).filter(n => custOfType(ty).includes(n)) }
      : c.key === 'customer' ? { ...c, options: () => custOfType(ty), allowEmpty: undefined } : c.key === 'invoice' ? { ...c, options: () => db.salesInvoices.filter(view).map(i => [i.no, `${i.no} — ${i.customer}`]) } : c;
    modules['si_' + k] = { ...modules.salesInvoices, table: 'salesInvoices', view, fixed: { stype: ty }, title: `فواتير مبيعات ${ty}`, single: `فاتورة مبيعات ${ty}`,
      sub: `من حـ/ عملاء ${ty} إلى حـ/ مبيعات ${ty} و حـ/ الضرائب — بعد الاعتماد`, cols: modules.salesInvoices.cols.map(custCol) };
    modules['sr_' + k] = { ...modules.salesReturns, table: 'salesReturns', view, fixed: { stype: ty }, title: `مردودات مبيعات ${ty}`, single: `فاتورة مردودات ${ty}`,
      sub: `من حـ/ مبيعات ${ty} إلى حـ/ عملاء ${ty} — بعد الاعتماد`, cols: modules.salesReturns.cols.map(custCol) };
  });
  const tbl = n => modules[n]?.table || n;
  // أصناف المبيعات حسب نوع الفاتورة (حساب المبيعات)
  const salesAccOfType = ty => leafByName(SYS.revenue, 'مبيعات ' + ty);
  const salesItemsFor = ty => db.salesItems.filter(i => !ty || i.account === salesAccOfType(ty));
  const salesItemOf = n => db.salesItems.find(i => i.name === n);
  // أنواع الصنف: نص مفصول بفاصلة (، أو ,) — مثل: ايرلي سويت، فليم
  const varietiesOf = v => String(v || '').split(/[،,\n]/).map(s => s.trim()).filter(Boolean);
  // سطر البيع بما يقابله في المخزن: صنف مبيعات مربوط بصنف مخزني، أو صنف مخزني مباشرة
  const stockLine = l => { const si = salesItemOf(l.item); if (si) return si.stockItem && db.items.some(i => i.name === si.stockItem) ? { ...l, item: si.stockItem, unit: l.unit || si.unit } : null;
    return db.items.some(i => i.name === l.item) ? l : null; };
  const rowsOf = n => { const m = modules[n]; return m?.view ? db[m.table].filter(m.view) : db[n]; };
  const repPageInfo = id => {
    if (String(id).startsWith('st/')) { const k = id.slice(3); return STATEMENTS[k] ? { title: STATEMENTS[k], sub: 'من الأرصدة الحالية — يمكن طباعتها', render: () => renderReports(k) } : null; }
    if (!String(id).startsWith('rep/')) return null;
    const r = REPORTS.find(x => x.id === id.slice(4));
    return r ? { title: r.title, sub: 'حدد الفترة ثم اطبع أو صدّر', render: () => renderReportCenter(r.id) } : null;
  };
  // صفحة لكل حساب في الدليل (كشف حسابه)، وصفحة لكل تصنيف عملاء/موردين (قاعدة بياناته)
  const acctPageInfo = id => {
    const a = String(id).startsWith('acct/') && acc(id.slice(5));
    return a ? { title: a.name, sub: `حساب ${a.code} — الحركات والرصيد`, render: () => { state.ledger = a.code; return renderLedger(); } } : null;
  };
  const catPageInfo = id => {
    const m = String(id).match(/^(cust|supp)\/(.+)$/); if (!m) return null;
    const t = m[1] === 'cust' ? 'customers' : 'suppliers', cat = m[2];
    if (!(t === 'customers' ? custCats() : suppCats()).includes(cat)) return null;
    return { title: cat, sub: `${t === 'customers' ? 'عملاء' : 'موردو'} تصنيف ${cat}`, render: () => { state.filter = cat; return renderModule(t); } };
  };
  const pageInfo = id => pages[id] || modules[id] || boxPageInfo(id) || whPageInfo(id) || acctPageInfo(id) || catPageInfo(id) || repPageInfo(id);

  // ---------- القائمة الجانبية ----------
  const nav = [
    { title: 'دليل الحسابات', icon: 'list', items: ['accounts', 'openingBalances', 'journal', 'ledger',
      { title: 'التقارير المالية', icon: 'ledger', items: () => { try { return [...Object.keys(STATEMENTS).map(k => 'st/' + k), 'reports', ...REPORTS.filter(r => r.group === 'التقارير المالية').map(r => 'rep/' + r.id), 'rep/tb', 'rep/daybook']; } catch { return ['reports']; } } }] },
    { title: 'إدارة الخزينة والبنوك', icon: 'cash', items: [
      { title: 'الخزائن', icon: 'cash', items: () => [...db.cashboxes.filter(b => !isBankBox(b)).sort((a, b) => String(a.code).localeCompare(String(b.code))).map(b => 'box/' + b.id), 'receipts', 'payments', 'boxTransfers'] },
      { title: 'البنوك', icon: 'bank', items: () => [...db.cashboxes.filter(isBankBox).sort((a, b) => String(a.code).localeCompare(String(b.code))).map(b => 'box/' + b.id), 'bankMoves', 'rep/chqCollect', 'rep/chqDue'] },
      'cashboxes'] },
    { title: 'إدارة الحسابات', icon: 'ledger', items: [
      { title: 'الموردين', icon: 'truck', items: () => [...leafUnder(SYS.suppliers).map(a => 'acct/' + a.code), 'supplierAccruals', 'rep/apaging', 'rep/suppAccr', 'rep/purSupp', 'rep/purCat'] },
      { title: 'العملاء', icon: 'users', items: () => [...leafUnder(SYS.customers).map(a => 'acct/' + a.code), 'rep/araging', 'rep/salesCust', 'rep/salesCat', 'rep/partybal'] },
      'expenseOrders', 'supplierPayReqs',
      { title: 'التقارير المحاسبية', icon: 'trend', items: ['rep/treasuryDaily', 'rep/cashflow', 'bankMoves', 'stockBalances', 'rep/stkValue', 'rep/payrollRep', 'rep/apaging', 'rep/araging', 'rep/expgroups', 'rep/payParties', 'rep/monthly'] }] },
    { title: 'إدارة التكاليف', icon: 'trend', items: ['rep/costRep', 'costCenters', 'crops', 'stockOut'] },
    { title: 'إدارة شئون العاملين', icon: 'users', items: ['attendance', 'payroll', 'leaves', 'rep/payrollRep', 'rep/attRep', 'rep/deptRep'] },
    { title: 'إدارة شئون العمالة', icon: 'hardhat', items: ['dailyLabor', 'advances', 'rep/laborRep'] },
    { title: 'إدارة المشتريات', icon: 'cart', items: ['purchaseQuotes', 'purchaseOrders', 'purchaseInvoices', 'purchaseReturns', 'rep/purRep'] },
    { title: 'إدارة المبيعات', icon: 'sales', items: ['salesQuotes',
      { title: 'فواتير المبيعات', icon: 'sales', items: [...SALE_TYPES.map(([k]) => 'si_' + k), 'salesInvoices'] },
      { title: 'المردودات', icon: 'sales', items: [...SALE_TYPES.map(([k]) => 'sr_' + k), 'salesReturns'] },
      { title: 'تقارير المبيعات', icon: 'trend', items: ['rep/salesRep', 'rep/salesCust', 'rep/salesCat', 'rep/salesMonth'] }] },
    { title: 'إدارة المخازن', icon: 'box', items: () => [...db.warehouses.slice().sort((a, b) => String(a.code).localeCompare(String(b.code))).map(w => 'wh/' + w.id), 'stockBalances', 'stockRequests', 'purchaseQuotes', 'purchaseOrders', 'stockIn', 'stockOut', 'transfers', 'rep/stkMove', 'rep/stkLow', 'rep/stkValue'] },
    { title: 'إدارة الميكنة', icon: 'truck', items: ['machineOps', 'machines', 'rep/machRep'] },
    { title: 'إدارة الصيانة', icon: 'wrench', items: ['maintenanceOrders', 'maintenancePlan', 'rep/maintPlanRep'] },
    { title: 'إدارة الأصول الثابتة', icon: 'shield', items: ['fixedAssets', 'rep/assetRep'] },
    { title: 'قواعد البيانات', icon: 'db', items: [
      { title: 'قاعدة بيانات الموردين', icon: 'truck', items: () => ['suppliers', ...suppCats().map(c => 'supp/' + c)] },
      { title: 'قاعدة بيانات العملاء', icon: 'users', items: () => ['customers', ...custCats().map(c => 'cust/' + c)] },
      { title: 'قاعدة بيانات الموظفين', icon: 'users', items: ['employees', 'girlsFixed', 'girlsTemp', 'bangladesh', 'workers', 'departments'] },
      { title: 'قاعدة بيانات الأصول الثابتة', icon: 'shield', items: ['fixedAssets', 'machines'] },
      { title: 'الأصناف والمخازن', icon: 'box', items: ['salesItems', 'items', 'units', 'warehouses'] },
      { title: 'الفروع ومراكز التكلفة', icon: 'list', items: ['branches', 'costCenters', 'crops'] }] },
    { title: 'الإدارة والإعدادات', icon: 'shield', items: ['dashboard', 'reportCenter', 'approvals', 'users', 'import', 'database', 'settings'] },
  ];
  const EMO = {
    dashboard: '📊', reportCenter: '🗂️', approvals: '✅', users: '👥', database: '🗄️', settings: '⚙️', accounts: '🌳', journal: '📒', ledger: '📄', reports: '📈',
    cashboxes: '🗃️', bankMoves: '🧾', receipts: '📥', payments: '📤', boxTransfers: '🔄', import: '📥', salesInvoices: '🧾', salesQuotes: '💬', salesReturns: '↩️', si_local: '🏪', si_seedlings: '🌱', si_scrap: '♻️', si_livestock: '🐄', sr_local: '↩️', sr_seedlings: '↩️', sr_scrap: '↩️', sr_livestock: '↩️',
    purchaseOrders: '📝', purchaseInvoices: '🧾', purchaseReturns: '↪️', stockBalances: '📦', stockIn: '➕', stockOut: '➖', transfers: '🔁',
    attendance: '🕘', payroll: '💰', leaves: '🌴', dailyLabor: '👷', advances: '💵', machineOps: '⛽', maintenanceOrders: '🔧', maintenancePlan: '🗓️',
    expenseOrders: '🧾', supplierPayReqs: '📨', stockRequests: '📋', purchaseQuotes: '💬', fixedAssets: '🏗️', customers: '🤝', suppliers: '🚚', items: '🏷️', warehouses: '🏬', employees: '👔', units: '⚖️', salesItems: '🧺', supplierAccruals: '🗓️', openingBalances: '🧮', branches: '📍', costCenters: '🎯', crops: '🌱', girlsFixed: '👩‍🌾', girlsTemp: '👩', bangladesh: '🧑‍🔧', workers: '🦺', departments: '🏢', machines: '🚜',
  };
  // مسار كل صفحة داخل القائمة (لفتح المجموعات التي تحتويها)
  let pagePath = {};
  const itemsOf = g => typeof g.items === 'function' ? g.items() : g.items;
  const walkNav = (items, keys, titles) => items.forEach((it, i) => {
    const k = keys.length ? `${keys[keys.length - 1]}.${i}` : String(i);
    if (typeof it === 'string') pagePath[it] ??= { keys, titles };
    else walkNav(itemsOf(it), [...keys, k], [...titles, it.title]);
  });
  const buildPaths = () => { pagePath = {}; walkNav(nav, [], []); };
  buildPaths();
  const leavesOf = g => itemsOf(g).flatMap(it => typeof it === 'string' ? [it] : leavesOf(it));

  const badges = {
    approvals: () => myApprovals().length,
    salesInvoices: () => db.salesInvoices.filter(r => salesStatus(r) === 'متأخرة').length,
    ...Object.fromEntries(SALE_TYPES.map(([k, ty]) => ['si_' + k, () => db.salesInvoices.filter(r => saleType(r) === ty && salesStatus(r) === 'متأخرة').length])),
    purchaseInvoices: () => db.purchaseInvoices.filter(r => purchStatus(r) === 'متأخرة').length,
    items: () => db.items.filter(r => itemQty(r.name) < +r.min).length,
    maintenanceOrders: () => db.maintenanceOrders.filter(r => r.status !== 'مكتمل').length,
    maintenancePlan: () => db.maintenancePlan.filter(r => planStatus(r) === 'متأخرة').length,
  };
  const badge = n => n ? `<em class="badge">${n}</em>` : '';

  const state = { page: null, open: new Set(['0']), navTab: 'all', navQ: '', q: '', filter: '', collapsed: new Set(), ledger: '1211' };
  let pendingQuery = null;

  function leafHTML(p, withPath) {
    if (!can(p)) return '';
    const fav = prefs.fav.includes(p), info = pageInfo(p);
    return `<div class="nav-leaf ${state.page === p ? 'active' : ''}">
      <a href="#${p}" data-page="${p}"><span class="emo">${EMO[p] || (p.startsWith('rep/') ? '📑' : p.startsWith('st/') ? '📈' : p.startsWith('wh/') ? '🏬' : p.startsWith('box/') ? (isBankBox(db.cashboxes.find(b => 'box/' + b.id === p)) ? '🏦' : '💵') : p.startsWith('acct/') ? '📒' : p.startsWith('cust/') ? '🤝' : p.startsWith('supp/') ? '🚚' : '•')}</span><span class="nav-title">${info.title}${withPath ? `<small>${pagePath[p].titles.join(' › ')}</small>` : ''}</span>${badge(badges[p]?.() || 0)}</a>
      <button class="star ${fav ? 'on' : ''}" data-fav="${p}" title="${fav ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'}" aria-pressed="${fav}">${fav ? '★' : '☆'}</button></div>`;
  }
  function groupHTML(g, key, lvl) {
    const open = state.open.has(key);
    const leaves = leavesOf(g).filter(p => can(p));
    if (!leaves.length) return '';
    const total = sum(leaves, p => badges[p]?.() || 0);
    return `<div class="nav-group lvl${lvl} ${open ? 'open' : ''} ${leaves.includes(state.page) ? 'current' : ''}">
      <button class="nav-head" data-toggle="${key}" aria-expanded="${open}"><span class="nav-ico" style="--ic:${ICON_TINT[g.icon] || '#5b7fa6'}">${icons[g.icon]}</span><span class="nav-title">${g.title}</span>${open ? '' : badge(total)}${icons.chevDown}</button>
      <div class="nav-sub">${itemsOf(g).map((it, j) => typeof it === 'string' ? leafHTML(it) : groupHTML(it, `${key}.${j}`, lvl + 1)).join('')}</div>
    </div>`;
  }
  // ألوان أيقونات مجموعات القائمة (أيقونات مسطحة ملونة داخل مربع رمادي)
  const ICON_TINT = { list: '#2f86d6', ledger: '#2f86d6', box: '#e5892b', cash: '#2f9e5b', bank: '#2b7bbf', sales: '#e0533d', users: '#7b5cc4', cart: '#e3a21a',
    hardhat: '#d98b1f', truck: '#4f7fb8', wrench: '#6c7a89', trend: '#22a3a3', db: '#5d6d7e', shield: '#8a5cc4' };
  function renderNav() {
    buildPaths();
    const q = state.navQ.trim().toLowerCase();
    let html;
    if (q) {
      const hits = Object.keys(pagePath).filter(p => can(p) && [pageInfo(p).title, ...pagePath[p].titles].some(t => t.toLowerCase().includes(q)));
      html = hits.length ? hits.map(p => leafHTML(p, true)).join('') : '<div class="nav-empty">لا توجد نتائج في القائمة</div>';
    } else if (state.navTab === 'fav') {
      const fav = prefs.fav.filter(p => pagePath[p] && can(p));
      html = fav.length ? fav.map(p => leafHTML(p, true)).join('') : '<div class="nav-empty">لا توجد شاشات في المفضلة.<br>اضغط ☆ بجانب أي شاشة لإضافتها.</div>';
    } else html = nav.map((g, i) => groupHTML(g, String(i), 0)).join('');
    $('#nav').innerHTML = html;
    $('#favCount').textContent = prefs.fav.filter(p => pagePath[p] && can(p)).length;
    $$('.nav-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.navTab));
  }
  $('#nav').addEventListener('click', e => {
    const star = e.target.closest('[data-fav]');
    if (star) {
      const p = star.dataset.fav;
      prefs.fav = prefs.fav.includes(p) ? prefs.fav.filter(x => x !== p) : [...prefs.fav, p];
      savePrefs(); renderNav(); return;
    }
    const t = e.target.closest('[data-toggle]');
    if (t) { const k = t.dataset.toggle; state.open.has(k) ? state.open.delete(k) : state.open.add(k); renderNav(); return; }
    const a = e.target.closest('a[data-page]');
    if (a && a.getAttribute('href') === location.hash) route();
  });
  $$('.nav-tabs button').forEach(b => b.onclick = () => { state.navTab = b.dataset.tab; renderNav(); });
  $('#navSearch').addEventListener('input', e => { state.navQ = e.target.value; renderNav(); });

  // الانتقال إلى مستند مع البحث عنه
  function goTo(page, query = '') {
    pendingQuery = query;
    if (decodeURIComponent(location.hash.slice(1)) === page) route(); else location.hash = page;
  }
  function openLedger(code) { state.ledger = code; closeModal(); goTo('ledger'); }

  // ---------- لوحة التحكم ----------
  // =====================================================================
  // لوحة التحكم: رسوم بيانية تفاعلية (فلتر الفترة يطبّق على كل الكروت والرسوم)
  // الألوان: أزرق/برتقالي/أخضر مائي/أصفر بترتيب ثابت (تم فحصها لعمى الألوان)
  // =====================================================================
  const DASH_COLORS = ['#257de0', '#f47230', '#00b894', '#f2a600'];
  const DASH_SEQ = ['#84b9f3', '#519ced', '#257de0', '#1b64be', '#0f4a96'];
  const DASH_PRESETS = [['m1', 'هذا الشهر'], ['m3', 'آخر 3 شهور'], ['m6', 'آخر 6 شهور'], ['m12', 'آخر 12 شهر'], ['y', 'هذه السنة'], ['all', 'الكل']];
  let dashP = 'm12'; try { dashP = localStorage.getItem('acc-erp-dashp') || 'm12'; } catch {}
  let dashB = ''; try { dashB = localStorage.getItem('acc-erp-dashb') || ''; } catch {}
  const NO_BR = '__none';
  const inBr = b => !dashB || (dashB === NO_BR ? !b : b === dashB);
  const ym = d => d.slice(0, 7);
  const monthStart = (y, m) => new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  function dashRange(p) {
    const t = today(), y = +t.slice(0, 4), m = +t.slice(5, 7) - 1;
    if (p === 'all') { const d = glEntries().map(e => e.date).filter(Boolean).sort()[0] || t; return { from: d.slice(0, 8) + '01', to: t, all: true }; }
    if (p === 'y') return { from: `${y}-01-01`, to: t };
    const n = { m1: 1, m3: 3, m6: 6, m12: 12 }[p] || 12;
    return { from: monthStart(y, m - n + 1), to: t };
  }
  const prevRange = r => { const a = new Date(r.from), b = new Date(r.to), len = b - a; const pe = new Date(a - 864e5); return { from: new Date(pe - len).toISOString().slice(0, 10), to: pe.toISOString().slice(0, 10) }; };
  const monthsIn = r => { const out = []; let [y, m] = r.from.split('-').map(Number); const [ty, tm] = r.to.split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } if (out.length > 120) break; } return out; };
  // سلسلة آباء الحساب حتى الجذر
  const ancestors = code => memo('anc:' + code, () => { const out = []; let c = String(code), guard = 0; while (c && guard++ < 12) { out.push(c); c = acc(c)?.parent || ''; } return out; });
  const rootOf = code => ancestors(code).at(-1);
  const childOfRoot = (code, root) => { const a = ancestors(code); const i = a.indexOf(root); return i > 0 ? a[i - 1] : null; };
  // إيرادات/مصروفات فترة من القيود المرحّلة
  // expF: مجموعة مصروفات محددة (التعمق) — تُحسب مصروفاتها فقط، مع تفصيلها حسب الحساب التابع لها مباشرة
  function pl(r, expF) {
    const o = { rev: 0, exp: 0, expAll: 0, byMonth: {}, expBy: {}, expKid: {} };
    glEntries().forEach(e => { if (!e.date || e.date < r.from || e.date > r.to || !inBr(e.branch)) return; const k = ym(e.date), bm = o.byMonth[k] ||= { rev: 0, exp: 0, expAll: 0 };
      e.lines.forEach(l => { const an = ancestors(l.acc), root = an.at(-1);
        if (root === SYS.revenue) { const v = l.cr - l.dr; o.rev += v; bm.rev += v; }
        else if (root === SYS.expenses) { const v = l.dr - l.cr, g = childOfRoot(l.acc, SYS.expenses) || l.acc; o.expBy[g] = (o.expBy[g] || 0) + v; o.expAll += v; bm.expAll += v;
          if (expF) { const ix = an.indexOf(expF); if (ix < 0) return; const kid = ix > 0 ? an[ix - 1] : l.acc; o.expKid[kid] = (o.expKid[kid] || 0) + v; }
          o.exp += v; bm.exp += v; } }); });
    return o;
  }
  // رصيد النقدية (خزائن + بنوك) في نهاية كل شهر
  function cashSeries(months) {
    const isCash = c => { const a = ancestors(c); return (a.includes(SYS.cash) || a.includes(SYS.banks)) && inBr(accBranch(c)); };
    let bal = sum(db.accounts.filter(a => isCash(a.code)), a => +a.balance || 0);
    const ents = [...glEntries()].filter(e => e.date).sort(byDate); let i = 0;
    return months.map(mo => { const end = mo + '-31';
      while (i < ents.length && ents[i].date <= end) { ents[i].lines.forEach(l => { if (isCash(l.acc)) bal += l.dr - l.cr; }); i++; }
      return bal; });
  }
  const cmp = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  const monthLabel = (mo, withYear) => { const [y, m] = mo.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1, 15));
    return d.toLocaleDateString((window.UI_LOCALE || 'ar-EG') + '-u-nu-latn', withYear ? { month: 'short', year: 'numeric', timeZone: 'UTC' } : { month: 'short', timeZone: 'UTC' }); };
  const niceStep = v => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
  const niceMax = v => niceStep(v / 4) * 4;

  // ---- التلميح (Tooltip) — نصوص عبر textContent فقط ----
  let dashTips = [];
  const tipEl = () => { let t = $('#dashTip'); if (!t) { t = document.createElement('div'); t.id = 'dashTip'; t.className = 'dash-tip'; t.hidden = true; document.body.appendChild(t); } return t; };
  function showTip(i, ev) {
    const d = dashTips[i]; if (!d) return; const t = tipEl(); t.textContent = '';
    const h = document.createElement('div'); h.className = 'dt-h'; h.textContent = d.title; t.appendChild(h);
    d.rows.forEach(r => { const row = document.createElement('div'); row.className = 'dt-r';
      const k = document.createElement('i'); if (r.color) k.style.background = r.color; else k.className = 'none'; row.appendChild(k);
      const v = document.createElement('b'); v.textContent = r.v; row.appendChild(v);
      const l = document.createElement('span'); l.textContent = r.l; row.appendChild(l); t.appendChild(row); });
    t.hidden = false; const pad = 14, w = t.offsetWidth, hh = t.offsetHeight;
    let x = ev.clientX + pad, y = ev.clientY - hh - pad; if (x + w > innerWidth - 8) x = ev.clientX - w - pad; if (y < 8) y = ev.clientY + pad;
    t.style.left = x + 'px'; t.style.top = y + 'px';
  }
  const hideTip = () => { const t = $('#dashTip'); if (t) t.hidden = true; };
  const tip = (title, rows) => { dashTips.push({ title, rows }); return dashTips.length - 1; };

  // ---- رسم أعمدة (مجمّعة) — يتجه حسب اتجاه الواجهة، ويدعم التحديد والفلترة بالضغط ----
  function colChart(el, { cats, catTitles, series, colorsPerBar, extra, height = 240, sel = -1, xf }) {
    const W = Math.max(280, el.clientWidth), H = height, rtl = document.documentElement.dir === 'rtl';
    const padS = 52, padE = 10, top = 14, bot = 26, x0 = rtl ? padE : padS, x1 = rtl ? W - padS : W - padE;
    const all = series.flatMap(s => s.vals), mx = niceMax(Math.max(0, ...all)), mn = Math.min(0, ...all) < 0 ? -niceMax(-Math.min(...all)) : 0;
    const y = v => top + (mx - v) / (mx - mn) * (H - top - bot), n = cats.length, bw = (x1 - x0) / Math.max(1, n);
    const cx = i => rtl ? x1 - (i + 0.5) * bw : x0 + (i + 0.5) * bw;
    const ns = series.length, w = Math.max(3, Math.min(24, (bw * 0.72 - (ns - 1) * 2) / ns));
    let g = '';
    for (let k = 0; k <= 4; k++) { const v = mn + (mx - mn) * k / 4, yy = y(v);
      g += `<line class="grid" x1="${x0}" x2="${x1}" y1="${yy}" y2="${yy}"/><text class="ax" x="${rtl ? x1 + 8 : x0 - 8}" y="${yy + 4}" text-anchor="${rtl ? 'start' : 'end'}">${cmp.format(v)}</text>`; }
    const every = Math.ceil(n / Math.max(1, Math.floor((x1 - x0) / 60)));
    cats.forEach((c, i) => { if ((i % every === 0 && n - 1 - i >= every) || i === n - 1 || i === sel) g += `<text class="ax ${i === sel ? 'on' : ''}" x="${cx(i)}" y="${H - 8}" text-anchor="middle">${esc(c)}</text>`; });
    const yb = y(0);
    cats.forEach((c, i) => {
      const grp = ns * w + (ns - 1) * 2, dim = sel >= 0 && i !== sel ? ' dim' : '';
      series.forEach((s, j) => { const v = s.vals[i] || 0; if (!v) return;
        const off = -grp / 2 + j * (w + 2), xx = rtl ? cx(i) - off - w : cx(i) + off, yv = y(v), hgt = Math.abs(yb - yv), r = Math.min(4, w / 2, hgt);
        const t = Math.min(yv, yb), color = colorsPerBar ? colorsPerBar[i] : s.color;
        const d = v >= 0 ? `M${xx},${yb}V${t + r}Q${xx},${t} ${xx + r},${t}H${xx + w - r}Q${xx + w},${t} ${xx + w},${t + r}V${yb}Z`
          : `M${xx},${yb}V${yb + hgt - r}Q${xx},${yb + hgt} ${xx + r},${yb + hgt}H${xx + w - r}Q${xx + w},${yb + hgt} ${xx + w},${yb + hgt - r}V${yb}Z`;
        g += `<path class="mk${dim}" d="${d}" fill="${color}"/>`; });
      const ti = tip(catTitles?.[i] || c, [...series.map(s => ({ color: colorsPerBar ? colorsPerBar[i] : s.color, v: money(s.vals[i] || 0), l: s.name })), ...(extra ? [extra(i)] : []), ...(xf ? [{ v: '', l: i === sel ? 'اضغط لإلغاء الفلتر' : 'اضغط للفلترة' }] : [])]);
      g += `<rect class="hit ${xf ? 'clk' : ''}" data-tip="${ti}" ${xf ? `data-xf="${esc(xf(i))}"` : ''} x="${cx(i) - bw / 2}" y="${top}" width="${bw}" height="${H - top - bot}" tabindex="0"/>`;
    });
    g += `<line class="base" x1="${x0}" x2="${x1}" y1="${yb}" y2="${yb}"/>`;
    el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(el.dataset.label || '')}">${g}</svg>`;
  }
  // ---- خط زمني مع مساحة خفيفة ----
  function lineChart(el, { cats, catTitles, vals, name, color, height = 240, sel = -1 }) {
    const W = Math.max(280, el.clientWidth), H = height, rtl = document.documentElement.dir === 'rtl';
    const padS = 52, padE = 16, top = 22, bot = 26, x0 = rtl ? padE : padS, x1 = rtl ? W - padS : W - padE;
    const mx = niceMax(Math.max(0, ...vals)), mn = Math.min(0, ...vals) < 0 ? -niceMax(-Math.min(...vals)) : 0;
    const y = v => top + (mx - v) / (mx - mn) * (H - top - bot), n = vals.length;
    const px = i => n === 1 ? (x0 + x1) / 2 : rtl ? x1 - i * (x1 - x0) / (n - 1) : x0 + i * (x1 - x0) / (n - 1);
    let g = '';
    for (let k = 0; k <= 4; k++) { const v = mn + (mx - mn) * k / 4, yy = y(v);
      g += `<line class="grid" x1="${x0}" x2="${x1}" y1="${yy}" y2="${yy}"/><text class="ax" x="${rtl ? x1 + 8 : x0 - 8}" y="${yy + 4}" text-anchor="${rtl ? 'start' : 'end'}">${cmp.format(v)}</text>`; }
    const every = Math.ceil(n / Math.max(1, Math.floor((x1 - x0) / 60)));
    cats.forEach((c, i) => { if ((i % every === 0 && n - 1 - i >= every) || i === n - 1) g += `<text class="ax" x="${px(i)}" y="${H - 8}" text-anchor="middle">${esc(c)}</text>`; });
    const pts = vals.map((v, i) => `${px(i)},${y(v)}`).join(' ');
    g += `<polygon points="${px(0)},${y(Math.max(mn, 0))} ${pts} ${px(n - 1)},${y(Math.max(mn, 0))}" fill="${color}" opacity=".1"/>`;
    g += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const li = sel >= 0 ? sel : n - 1; g += `<circle cx="${px(li)}" cy="${y(vals[li])}" r="5" fill="${color}" stroke="#fff" stroke-width="2"/>`;
    g += `<text class="val" x="${px(li)}" y="${y(vals[li]) - 12}" text-anchor="${rtl ? 'start' : 'end'}">${cmp.format(vals[li])}</text>`;
    g += `<line class="xh" x1="0" x2="0" y1="${top}" y2="${H - bot}" visibility="hidden"/>`;
    const bw = n > 1 ? (x1 - x0) / (n - 1) : x1 - x0;
    vals.forEach((v, i) => { const ti = tip(catTitles?.[i] || cats[i], [{ color, v: money(v), l: name }]);
      g += `<rect class="hit" data-tip="${ti}" data-x="${px(i)}" x="${px(i) - bw / 2}" y="${top}" width="${bw}" height="${H - top - bot}" tabindex="0"/>`; });
    el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(el.dataset.label || '')}">${g}</svg>`;
  }
  // ---- خط صغير داخل كارت المؤشر (Sparkline) ----
  const spark = (vals, color = DASH_COLORS[0]) => { if (vals.length < 2) return ''; const W = 120, H = 30, mx = Math.max(...vals), mn = Math.min(...vals), rg = mx - mn || 1, rtl = document.documentElement.dir === 'rtl';
    const px = i => { const x = 2 + i * (W - 4) / (vals.length - 1); return rtl ? W - x : x; }, py = v => H - 3 - (v - mn) / rg * (H - 6);
    return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${vals.map((v, i) => `${px(i)},${py(v)}`).join(' ')}" fill="none" stroke="#9aa6b8" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${px(vals.length - 1)}" cy="${py(vals.at(-1))}" r="3" fill="${color}"/></svg>`; };
  // ---- أشرطة أفقية (HTML) — الضغط على الشريط يفلتر اللوحة ----
  const hbars = (rows, color = DASH_COLORS[0], o = {}) => { const mx = Math.max(1, ...rows.map(r => Math.abs(r.v)));
    return rows.length ? `<div class="hb">${rows.map(r => { const on = o.sel && r.key === o.sel, dim = o.sel && !on;
      const k = o.xf && o.xf(r);
      return `<div class="hb-row ${k ? 'clk' : ''} ${on ? 'on' : ''} ${dim ? 'dim' : ''}" data-tip="${tip(r.l, [{ color, v: money(r.v), l: r.sub || '' }, ...(k ? [{ v: '', l: on ? 'اضغط لإلغاء الفلتر' : o.hint || 'اضغط للفلترة' }] : [])])}" ${k ? `data-xf="${esc(k)}"` : ''} tabindex="0">
      <span class="hb-l" title="${esc(r.l)}">${esc(r.l)}</span><span class="hb-t"><i style="width:${Math.max(1.5, Math.abs(r.v) / mx * 100)}%;background:${color}"></i></span><b class="hb-v">${cmp.format(r.v)}</b></div>`; }).join('')}</div>`
      : '<div class="dash-empty">لا توجد بيانات بهذه الفلاتر</div>'; };
  // ---- شريط مقسّم (الكل وأجزاؤه) ----
  const segbar = (parts, o = {}) => { const tot = sum(parts, p => Math.max(0, p.v)); if (!tot) return '<div class="dash-empty">لا توجد بيانات بهذه الفلاتر</div>';
    const ps = parts.filter(p => p.v > 0);
    return `<div class="seg" role="img" aria-label="${esc(ps.map(p => `${p.l}: ${Math.round(p.v / tot * 100)}%`).join('، '))}">${ps.map(p => `<span class="seg-p ${o.xf ? 'clk' : ''}" style="flex:${p.v} 1 0;background:${p.color}" ${o.xf ? `data-xf="${esc(o.xf(p))}"` : ''} data-tip="${tip(p.l, [{ color: p.color, v: money(p.v), l: Math.round(p.v / tot * 100) + '%' }, ...(o.xf ? [{ v: '', l: o.hint || '' }] : [])])}" tabindex="0"><em style="color:${p.ink || '#fff'}">${Math.round(p.v / tot * 100)}%</em></span>`).join('')}</div>
      <ul class="dash-legend">${ps.map(p => `<li ${o.xf ? `class="clk" data-xf="${esc(o.xf(p))}"` : ''}><i style="background:${p.color}"></i><span>${esc(p.l)}</span><b>${money(p.v)}</b></li>`).join('')}</ul>`; };

  // ---- بيانات كل كارت: للجدول والتصدير والحركات التفصيلية ----
  let dashData = {};
  const dtable = (head, rows) => `<div class="dash-table" hidden><div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${i && typeof c === 'number' ? money(c) : esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  const dcard = (id, title, sub, body, data, cls = '', back = '') => { dashData[id] = data;
    return `<div class="card dash-card ${cls}" data-card="${id}"><div class="card-head"><div>${back}<h3>${title}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}</div><span class="spacer"></span>
      <div class="dc-act">
        ${data.drill ? `<button type="button" class="dc-b" data-act="drill" title="الحركات التفصيلية">☰<span>الحركات</span></button>` : ''}
        <button type="button" class="dc-b" data-act="table" title="عرض كجدول" aria-pressed="false">▦<span>جدول</span></button>
        <button type="button" class="dc-b" data-act="xlsx" title="تصدير Excel">⤓<span>Excel</span></button>
        <button type="button" class="dc-b" data-act="focus" title="تكبير">⛶</button>
      </div></div><div class="card-body">${body}${dtable(data.head, data.rows)}</div></div>`; };

  // ---- الفلاتر: الفترة (أو مدى مخصص) + الفرع + نوع المبيعات + الفلترة بالضغط على الرسوم ----
  let dashC = { from: '', to: '' }; try { dashC = JSON.parse(localStorage.getItem('acc-erp-dashc') || '{}') || {}; } catch {}
  let dashT = ''; try { dashT = localStorage.getItem('acc-erp-dasht') || ''; } catch {}
  const xf = { month: '', cust: '', exp: '' };
  const XF_LABEL = { month: 'الشهر', cust: 'العميل', exp: 'المصروفات', stype: 'نوع المبيعات', branch: 'الفرع' };
  const saveDash = () => { try { localStorage.setItem('acc-erp-dashp', dashP); localStorage.setItem('acc-erp-dashb', dashB); localStorage.setItem('acc-erp-dasht', dashT); localStorage.setItem('acc-erp-dashc', JSON.stringify(dashC)); } catch {} };
  const payBranch = (r, invT) => { const inv = r.invoice && db[invT].find(i => i.no === r.invoice); return r.branch || (inv ? docBranch(inv) : docBranch(r)); };

  function dashboardCharts() {
    dashTips = []; dashData = {};
    const R0 = dashP === 'custom' && dashC.from && dashC.to ? { from: dashC.from, to: dashC.to } : dashRange(dashP === 'custom' ? 'm12' : dashP);
    const months = monthsIn(R0), multiYear = months[0]?.slice(0, 4) !== months.at(-1)?.slice(0, 4);
    if (xf.month && !months.includes(xf.month)) xf.month = '';
    // الشهر المحدد بالضغط يضيّق كل شيء ما عدا رسم الأشهر نفسه
    const R = xf.month ? { from: xf.month + '-01', to: xf.month + '-31' } : R0;
    const P0 = pl(R0, xf.exp), P = xf.month ? pl(R, xf.exp) : P0, PR = R0.all && !xf.month ? null : pl(prevRange(R), xf.exp);
    const cats = months.map(m => monthLabel(m, multiYear && months.length <= 6)), titles = months.map(m => monthLabel(m, true));
    const revM = months.map(m => P0.byMonth[m]?.rev || 0), expM = months.map(m => P0.byMonth[m]?.exp || 0), expAllM = months.map(m => P0.byMonth[m]?.expAll || 0), cashM = cashSeries(months);
    const selM = xf.month ? months.indexOf(xf.month) : -1;
    // مستندات المبيعات بعد الفلاتر
    const inR = r => r.date >= R.from && r.date <= R.to && inBr(docBranch(r));
    const sOk = r => (!dashT || saleType(r) === dashT) && (!xf.cust || r.customer === xf.cust);
    const invs = eff('salesInvoices').filter(r => inR(r) && sOk(r)), rets = eff('salesReturns').filter(r => inR(r) && sOk(r));
    const salesBy = SALE_TYPES.map(([, ty]) => ({ key: ty, l: ty, v: sum(eff('salesInvoices').filter(r => inR(r) && saleType(r) === ty && (!xf.cust || r.customer === xf.cust)), r => r.amount) - sum(eff('salesReturns').filter(r => inR(r) && saleType(r) === ty && (!xf.cust || r.customer === xf.cust)), r => r.amount) }));
    const netSales = sum(invs, r => r.amount) - sum(rets, r => r.amount);
    // أكثر الأصناف مبيعاً (من بنود الفواتير)
    const itemMap = {}; invs.forEach(r => linesOf(r).forEach(l => { if (!l.item) return; const x = itemMap[l.item] ||= { v: 0, q: 0, unit: l.unit || '' }; x.v += lineVal(l); x.q += +l.qty || 0; }));
    const topItems = Object.entries(itemMap).map(([k, x]) => ({ key: k, l: k, v: x.v, sub: `${num(x.q)} ${x.unit}` })).sort((a, b) => b.v - a.v).slice(0, 6);
    // هيكل المصروفات أو تفاصيل مجموعة (Drill-down)
    const expGroups = childrenOf(SYS.expenses), expG = xf.exp && acc(xf.exp), expTop = expG && acc(childOfRoot(expG.code, SYS.expenses) || expG.code);
    const expParts = expGroups.map((a, i) => ({ key: a.code, l: a.name, v: P.expBy[a.code] || 0, color: DASH_COLORS[i % 4], ink: i === 0 ? '#fff' : '#191919' }));
    const expKids = expG ? Object.entries(P.expKid).map(([c, v]) => ({ key: c, l: acc(c)?.name || c, v, sub: c })).filter(x => x.v).sort((a, b) => b.v - a.v) : [];
    // أعمار الديون وأرصدة العملاء — بالفلاتر
    const filtered = dashB || dashT || xf.cust;
    const BK = ['لم تستحق', '1–30', '31–60', '61–90', '+90'], BKT = ['لم تستحق بعد', 'متأخرة 1–30 يوم', 'متأخرة 31–60 يوم', 'متأخرة 61–90 يوم', 'متأخرة أكثر من 90 يوم'], aging = [0, 0, 0, 0, 0], agingInv = [[], [], [], [], []], t0 = new Date(today());
    const openInv = eff('salesInvoices').filter(r => inBr(docBranch(r)) && sOk(r)).map(r => ({ r, rem: invTotal(r) - salesPaid(r) })).filter(x => x.rem > 0.005);
    openInv.forEach(x => { const d = x.r.due ? Math.floor((t0 - new Date(x.r.due)) / 864e5) : 0, b = d <= 0 ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : d <= 90 ? 3 : 4; aging[b] += x.rem; agingInv[b].push(x); });
    const cVal = n => filtered ? sum(openInv.filter(x => x.r.customer === n), x => x.rem) : custBal(n);
    const sVal = n => dashB ? sum(eff('purchaseInvoices').filter(i => i.supplier === n && inBr(docBranch(i))), i => i.amount) + sum(eff('stockIn').filter(i => i.supplier === n && inBr(docBranch(i))), i => docTotals(i).net)
      + sum(eff('supplierAccruals').filter(i => i.party === n && inBr(docBranch(i))), i => +i.amount || 0) - sum(eff('purchaseReturns').filter(i => i.supplier === n && inBr(docBranch(i))), i => i.amount)
      - sum(eff('payments').filter(i => i.party === n && isPartyDoc(i, 's') && inBr(payBranch(i, 'purchaseInvoices'))), i => i.amount) : suppBal(n);
    const custAll = db.customers.map(c => ({ key: c.name, l: c.name, v: cVal(c.name), sub: c.category || '' })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
    const topCust = custAll.slice(0, 6); if (xf.cust && !topCust.some(x => x.key === xf.cust)) { const c = custAll.find(x => x.key === xf.cust); if (c) topCust.push(c); }
    const topSupp = db.suppliers.map(s => ({ key: s.name, l: s.name, v: sVal(s.name), sub: acc(s.account)?.name || '' })).filter(x => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 6);
    const invAccs = [...childrenOf(SYS.inventory), acc(SYS.finished)].filter(Boolean);
    const whs = db.warehouses.filter(w => inBr(w.branch)), itemAccOf = i => { const c = String(i.store || SYS.defPurchase); return invAccs.find(a => ancestors(c).includes(a.code))?.code; };
    const invRows = invAccs.map(a => ({ l: a.name, sub: a.code, v: sum(db.items.filter(i => itemAccOf(i) === a.code), i => sum(whs, w => stockAt(i.name, w.name)) * (+i.cost || 0)) })).filter(x => x.v).sort((a, b) => b.v - a.v);
    const boxRows = db.cashboxes.filter(b => inBr(b.branch)).map(b => ({ l: b.name, v: acc(b.accountNo) ? ownBal(acc(b.accountNo)) : 0, sub: b.type || '', id: b.id })).filter(x => x.v).sort((a, b) => b.v - a.v);
    const cashNow = dashB ? sum(boxRows, x => x.v) : rollup(SYS.cash) + rollup(SYS.banks), receivable = sum(custAll, x => x.v);
    const delta = (cur, prev, upGood = true) => { if (prev == null || !PR || !prev) return '';
      const ch = (cur - prev) / Math.abs(prev) * 100, good = (ch >= 0) === upGood; return `<span class="dl ${Math.abs(ch) < 0.5 ? 'flat' : good ? 'good' : 'bad'}">${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch).toFixed(1)}% عن الفترة السابقة</span>`; };
    const net = P.rev - P.expAll, pnet = PR ? PR.rev - PR.expAll : null;
    const stat = (label, value, sub, icon, color, sp) => `<div class="kpi"><div class="kpi-icon ${color}">${icon}</div><div class="kpi-main"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-trend">${sub}</div>${sp || ''}</div></div>`;
    // الحركات التفصيلية (Drill-through)
    const revExpDrill = () => glEntries().filter(e => e.date && e.date >= R.from && e.date <= R.to && inBr(e.branch)).map(e => {
      let rv = 0, ex = 0; e.lines.forEach(l => { const a = ancestors(l.acc); if (a.at(-1) === SYS.revenue) rv += l.cr - l.dr; else if (a.at(-1) === SYS.expenses && (!xf.exp || a.includes(xf.exp))) ex += l.dr - l.cr; });
      return (rv || ex) && { cells: [e.date, e.no, e.desc, e.src, rv, ex], page: e.manual ? 'journal' : tbl(e.module), q: e.no }; }).filter(Boolean);
    const invDrill = list => list.map(x => { const r = x.r || x; return { cells: [r.date, r.no, r.customer, saleType(r), invTotal(r), invTotal(r) - salesPaid(r)], page: 'salesInvoices', q: r.no }; });
    const chips = [
      ...(dashB ? [['branch', dashB === NO_BR ? 'غير محدد الفرع' : dashB]] : []), ...(dashT ? [['stype', dashT]] : []),
      ...(xf.month ? [['month', titles[selM] || xf.month]] : []), ...(xf.cust ? [['cust', xf.cust]] : []), ...(xf.exp ? [['exp', acc(xf.exp)?.name || xf.exp]] : [])];

    dashDraw = () => {
      const c1 = $('[data-chart=revexp]', content); if (c1) colChart(c1, { cats, catTitles: titles, sel: selM, xf: i => 'month:' + months[i],
        series: [{ name: 'الإيرادات', color: DASH_COLORS[0], vals: revM }, { name: expG ? 'مصروفات: ' + expG.name : 'المصروفات', color: DASH_COLORS[1], vals: expM }], extra: i => ({ v: money(revM[i] - expAllM[i]), l: 'صافي الربح' }) });
      const c2 = $('[data-chart=cash]', content); if (c2) lineChart(c2, { cats, catTitles: titles, vals: cashM, name: 'رصيد النقدية', color: DASH_COLORS[0], sel: selM });
      const c3 = $('[data-chart=aging]', content); if (c3) colChart(c3, { cats: BK, catTitles: BKT, series: [{ name: 'المتبقي', color: DASH_SEQ[2], vals: aging }], colorsPerBar: DASH_SEQ, height: 220 });
      $$('.seg-p em', content).forEach(e => { e.style.visibility = e.offsetWidth + 10 > e.parentElement.offsetWidth ? 'hidden' : ''; });
    };
    const rangeTxt = `${fmtDMY(R.from)} — ${fmtDMY(R.to > today() ? today() : R.to)}`;
    return `
      <div class="bi-slicers">
        <div class="dash-filters" role="group" aria-label="الفترة">
          <span class="df-l">الفترة:</span>
          ${[...DASH_PRESETS, ['custom', 'مخصص']].map(([k, l]) => `<button type="button" class="df-b ${k === dashP ? 'on' : ''}" data-dp="${k}" aria-pressed="${k === dashP}">${k === dashP ? '✓ ' : ''}${l}</button>`).join('')}
          ${dashP === 'custom' ? `<span class="df-cust"><input type="date" class="input" id="dashFrom" value="${esc(R0.from)}" aria-label="من"><span>—</span><input type="date" class="input" id="dashTo" value="${esc(R0.to)}" aria-label="إلى"></span>` : ''}
        </div>
        <div class="dash-filters">
          <label class="df-br"><span class="df-l">الفرع:</span><select class="input df-sel" id="dashBranch" aria-label="الفرع">
            ${[['', 'كل الفروع'], ...db.branches.map(b => [b.name, b.name]), [NO_BR, 'غير محدد الفرع']].map(([v, l]) => `<option value="${esc(v)}" ${v === dashB ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label class="df-br"><span class="df-l">نوع المبيعات:</span><select class="input df-sel" id="dashType" aria-label="نوع المبيعات">
            ${[['', 'كل الأنواع'], ...SALE_TYPES.map(([, t]) => [t, t])].map(([v, l]) => `<option value="${esc(v)}" ${v === dashT ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <span class="df-r">${rangeTxt}</span>
        </div>
        <div class="bi-chips" ${chips.length ? '' : 'hidden'}>
          <span class="df-l">الفلاتر المطبّقة:</span>
          ${chips.map(([k, v]) => `<button type="button" class="bi-chip" data-clear="${k}" title="إزالة الفلتر"><small>${XF_LABEL[k]}</small> ${esc(v)} <b aria-hidden="true">×</b></button>`).join('')}
          <button type="button" class="link-btn" data-clear="all">مسح كل الفلاتر</button>
        </div>
        <div class="bi-hint">💡 اضغط على أي عمود أو شريط لفلترة اللوحة كلها، وعلى مجموعة مصروفات للتعمق في حساباتها.</div>
      </div>
      <div class="kpis">
        ${stat('الإيرادات', money(P.rev), delta(P.rev, PR?.rev), icons.trend, 'green', spark(revM, DASH_COLORS[0]))}
        ${stat(expG ? 'مصروفات: ' + esc(expG.name) : 'المصروفات', money(P.exp), delta(P.exp, PR?.exp, false), icons.down, 'red', spark(expM, DASH_COLORS[1]))}
        ${stat('صافي الربح', money(net), `${P.rev ? `هامش ربح ${Math.round(net / P.rev * 100)}%` : ''} ${delta(net, pnet)}`, icons.wallet, '', spark(revM.map((v, i) => v - expAllM[i])))}
        ${stat('صافي المبيعات', money(netSales), `للعملاء ${money(receivable)} · النقدية ${money(cashNow)}`, icons.cash, 'amber', spark(cashM))}
      </div>
      <div class="dash-grid">
        ${dcard('revexp', 'الإيرادات والمصروفات شهرياً', 'اضغط على شهر لفلترة اللوحة',
          `<ul class="dash-legend top"><li><i style="background:${DASH_COLORS[0]}"></i><span>الإيرادات</span></li><li><i style="background:${DASH_COLORS[1]}"></i><span>${expG ? 'مصروفات: ' + esc(expG.name) : 'المصروفات'}</span></li></ul>
           <div class="chart" data-chart="revexp" data-label="الإيرادات والمصروفات شهرياً"></div>`,
          { head: ['الشهر', 'الإيرادات', 'المصروفات', 'صافي الربح'], rows: months.map((m, i) => [titles[i], revM[i], expM[i], revM[i] - expAllM[i]]),
            drill: { title: 'القيود: الإيرادات والمصروفات', head: ['التاريخ', 'رقم القيد', 'البيان', 'المصدر', 'إيراد', 'مصروف'], get: revExpDrill } }, 'wide')}
        ${dcard('cash', 'رصيد النقدية', dashB ? 'خزائن وبنوك الفرع في نهاية كل شهر' : 'الخزائن والبنوك في نهاية كل شهر', `<div class="chart" data-chart="cash" data-label="رصيد النقدية"></div>`,
          { head: ['الشهر', 'الرصيد'], rows: months.map((m, i) => [titles[i], cashM[i]]) })}
        ${dcard('stype', 'المبيعات حسب النوع', 'صافي بعد المردودات — اضغط للفلترة', hbars(salesBy.filter(x => x.v), DASH_COLORS[0], { xf: r => 'stype:' + r.key, sel: dashT }),
          { head: ['النوع', 'صافي المبيعات'], rows: salesBy.map(x => [x.l, x.v]), drill: { title: 'فواتير المبيعات', head: ['التاريخ', 'رقم الفاتورة', 'العميل', 'النوع', 'الإجمالي', 'المتبقي'], get: () => invDrill(invs) } })}
        ${expG ? dcard('exp', `هيكل المصروفات › ${ancestors(expG.code).slice(0, -1).reverse().map(c => esc(acc(c)?.name || c)).join(' › ')}`, `إجمالي ${money(P.exp)} — حسب الحساب`, hbars(expKids, DASH_COLORS[expGroups.indexOf(expTop) % 4] || DASH_COLORS[1], { xf: r => childrenOf(r.key).length ? 'exp:' + r.key : '', hint: 'اضغط للتعمق في الحساب' }),
            { head: ['الحساب', 'المبلغ'], rows: expKids.map(x => [x.l, x.v]), drill: { title: 'قيود ' + expG.name, head: ['التاريخ', 'رقم القيد', 'البيان', 'المصدر', 'إيراد', 'مصروف'], get: () => revExpDrill().filter(x => x.cells[5]) } }, '',
            expG.parent && expG.parent !== SYS.expenses ? `<button type="button" class="bi-back" data-xf="exp:${esc(expG.parent)}">${document.documentElement.dir === 'rtl' ? '→' : '←'} ${esc(acc(expG.parent)?.name || '')}</button>` : `<button type="button" class="bi-back" data-clear="exp">${document.documentElement.dir === 'rtl' ? '→' : '←'} كل المصروفات</button>`)
          : dcard('exp', 'هيكل المصروفات', `إجمالي ${money(P.exp)} — اضغط للتعمق`, segbar(expParts, { xf: p => 'exp:' + p.key, hint: 'اضغط لعرض حسابات المجموعة' }),
            { head: ['المجموعة', 'المبلغ'], rows: expParts.map(x => [x.l, x.v]) })}
        ${dcard('items', 'أكثر الأصناف مبيعاً', 'قيمة البنود في فواتير الفترة', hbars(topItems, DASH_COLORS[2]), { head: ['الصنف', 'القيمة'], rows: topItems.map(x => [x.l, x.v]) })}
        ${dcard('cust', 'أكبر العملاء رصيداً', filtered ? 'المتبقي على فواتير الفلاتر — اضغط للفلترة' : 'مستحق من العملاء — اضغط للفلترة', hbars(topCust, DASH_COLORS[0], { xf: r => 'cust:' + r.key, sel: xf.cust }),
          { head: ['العميل', 'الرصيد'], rows: custAll.map(x => [x.l, x.v]), drill: { title: 'الفواتير المفتوحة', head: ['التاريخ', 'رقم الفاتورة', 'العميل', 'النوع', 'الإجمالي', 'المتبقي'], get: () => invDrill(openInv) } })}
        ${dcard('supp', 'أكبر الموردين رصيداً', 'مستحق للموردين', hbars(topSupp, DASH_COLORS[1]), { head: ['المورد', 'الرصيد'], rows: topSupp.map(x => [x.l, x.v]) })}
        ${dcard('aging', 'أعمار ديون العملاء', 'بالأيام بعد الاستحقاق', `<div class="chart" data-chart="aging" data-label="أعمار ديون العملاء"></div>`,
          { head: ['الفئة', 'المبلغ'], rows: BKT.map((b, i) => [b, aging[i]]), drill: { title: 'الفواتير المفتوحة حسب العمر', head: ['التاريخ', 'رقم الفاتورة', 'العميل', 'النوع', 'الإجمالي', 'المتبقي'], get: () => invDrill(agingInv.flat()) } })}
        ${dcard('inv', 'قيمة المخزون', 'الكمية × التكلفة — حسب حساب المخزون', hbars(invRows, DASH_COLORS[2]), { head: ['الحساب', 'القيمة'], rows: invRows.map(x => [x.l, x.v]) })}
        ${dcard('boxes', 'أرصدة الخزائن والبنوك', dashB ? 'خزائن وبنوك الفرع المختار' : 'الرصيد الحالي لكل خزينة وبنك', hbars(boxRows, DASH_COLORS[0]),
          { head: ['الخزينة / البنك', 'الرصيد'], rows: boxRows.map(x => [x.l, x.v]) }, 'wide')}
      </div>`;
  }
  let dashDraw = null;
  // نافذة الحركات التفصيلية
  function openDrill(d) {
    const rows = d.get(), numCols = d.head.map((h, i) => rows.some(r => typeof r.cells[i] === 'number'));
    let el = $('#biDrawer'); if (!el) { el = document.createElement('div'); el.id = 'biDrawer'; el.className = 'bi-drawer'; document.body.appendChild(el); }
    el.innerHTML = `<div class="bi-dr-box" role="dialog" aria-label="${esc(d.title)}"><div class="bi-dr-head"><b>${esc(d.title)}</b><span class="pill">${rows.length}</span><span class="spacer"></span>
      <button type="button" class="dc-b" data-dr="xlsx">⤓<span>Excel</span></button><button type="button" class="icon-btn" data-dr="close" aria-label="إغلاق"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      <div class="table-wrap"><table><thead><tr>${d.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="clk" data-row="${i}" title="فتح المستند">${r.cells.map((c, j) => `<td class="${numCols[j] ? 'num' : ''}">${numCols[j] ? (c ? money(c) : '') : esc(c ?? '')}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${d.head.length}" class="dash-empty">لا توجد حركات بهذه الفلاتر</td></tr>`}</tbody>
      ${rows.length ? `<tfoot><tr>${d.head.map((h, j) => `<td class="${numCols[j] ? 'num' : ''}">${j === 0 ? 'الإجمالي' : numCols[j] ? money(sum(rows, r => r.cells[j])) : ''}</td>`).join('')}</tr></tfoot>` : ''}</table></div></div>`;
    el.hidden = false;
    el.onclick = e => { if (e.target === el || e.target.closest('[data-dr=close]')) { el.hidden = true; return; }
      if (e.target.closest('[data-dr=xlsx]')) { exportGrid(d.title, d.head, rows.map(r => r.cells)); return; }
      const tr = e.target.closest('[data-row]'); if (tr) { const r = rows[+tr.dataset.row]; el.hidden = true; goTo(r.page, r.q); } };
  }
  async function exportGrid(title, head, rows) {
    const X = await loadXLSX(), name = `${title}-${today()}`;
    if (X) { const ws = X.utils.aoa_to_sheet([head, ...rows]); ws['!cols'] = head.map(h => ({ wch: Math.max(14, String(h).length + 4) })); const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'بيانات');
      saveFile(name + '.xlsx', new Blob([X.write(wb, { type: 'array', bookType: 'xlsx' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); }
    else downloadCSV(name, head, rows);
  }
  function wireDashboard() {
    dashDraw?.();
    const re = () => { saveDash(); renderPage(); };
    $$('[data-dp]', content).forEach(b => b.onclick = () => { dashP = b.dataset.dp; xf.month = ''; if (dashP === 'custom' && !dashC.from) { const r = dashRange('m12'); dashC = { from: r.from, to: r.to }; } re(); });
    const f = $('#dashFrom', content), t = $('#dashTo', content);
    [f, t].forEach(x => x && (x.onchange = () => { if (f.value && t.value && f.value <= t.value) { dashC = { from: f.value, to: t.value }; xf.month = ''; re(); } }));
    const bs = $('#dashBranch', content); if (bs) bs.onchange = () => { dashB = bs.value; re(); };
    const ts = $('#dashType', content); if (ts) ts.onchange = () => { dashT = ts.value; re(); };
    $$('.dash-card', content).forEach(card => { const id = card.dataset.card, d = dashData[id];
      card.querySelector('.dc-act').onclick = e => { const b = e.target.closest('[data-act]'); if (!b) return;
        if (b.dataset.act === 'table') { const tb = $('.dash-table', card), on = tb.hidden; tb.hidden = !on; b.setAttribute('aria-pressed', on); b.classList.toggle('on', on); $$('.chart, .hb, .seg, .dash-legend, .dash-empty', card).forEach(x => { if (!x.closest('.dash-table')) x.hidden = on; }); if (!on) dashDraw?.(); }
        else if (b.dataset.act === 'xlsx') exportGrid($('h3', card).textContent, d.head, d.rows);
        else if (b.dataset.act === 'drill') openDrill(d.drill);
        else if (b.dataset.act === 'focus') { const on = !card.classList.contains('focus'); card.classList.toggle('focus', on); document.body.classList.toggle('bi-focus', on); b.textContent = on ? '✕' : '⛶'; b.title = on ? 'تصغير' : 'تكبير'; dashDraw?.(); } }; });
    content.onclick = e => {
      const c = e.target.closest('[data-clear]'); if (c && content.contains(c)) { const k = c.dataset.clear;
        if (k === 'all') { xf.month = xf.cust = xf.exp = ''; dashB = ''; dashT = ''; } else if (k === 'branch') dashB = ''; else if (k === 'stype') dashT = ''; else xf[k] = ''; re(); return; }
      const h = e.target.closest('[data-xf]'); if (!h || !content.contains(h)) return;
      const [k, ...v] = h.dataset.xf.split(':'), val = v.join(':');
      if (k === 'stype') dashT = dashT === val ? '' : val; else xf[k] = xf[k] === val ? '' : val;
      hideTip(); re(); };
    content.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-xf]')) { e.preventDefault(); e.target.click(); } };
    const onMove = e => { const h = e.target.closest?.('[data-tip]'); if (!h || !content.contains(h)) { hideTip(); $$('.xh', content).forEach(l => l.setAttribute('visibility', 'hidden')); return; }
      showTip(+h.dataset.tip, e); const svg = h.closest('svg'), xh = svg && $('.xh', svg); if (xh) { xh.setAttribute('x1', h.dataset.x); xh.setAttribute('x2', h.dataset.x); xh.setAttribute('visibility', 'visible'); } };
    content.onpointermove = onMove; content.onpointerleave = () => hideTip();
    content.onfocusin = e => { const h = e.target.closest?.('[data-tip]'); if (h) { const r = h.getBoundingClientRect(); showTip(+h.dataset.tip, { clientX: r.left + r.width / 2, clientY: r.top }); } };
    content.onfocusout = () => hideTip();
  }
  addEventListener('keydown', e => { if (e.key !== 'Escape') return; const d = $('#biDrawer'); if (d && !d.hidden) { d.hidden = true; return; } const f = $('.dash-card.focus'); if (f) f.querySelector('[data-act=focus]').click(); });
  let dashRz; addEventListener('resize', () => { clearTimeout(dashRz); dashRz = setTimeout(() => { if (state.page === 'dashboard') dashDraw?.(); }, 150); });

  function renderDashboard() {
    const revenue = rollup('4'), expenses = rollup('3'), cash = rollup(SYS.cash) + rollup(SYS.banks);
    const receivable = sum(db.customers, c => custBal(c.name)), payable = sum(db.suppliers, s => suppBal(s.name));
    const boxes = db.cashboxes.map(b => ({ name: b.name, v: acc(b.accountNo) ? ownBal(acc(b.accountNo)) : 0 }));
    const boxMax = Math.max(1, ...boxes.map(x => x.v));
    const expGroups = childrenOf('3').map(a => ({ name: a.name, v: rollup(a.code) }));
    const expMax = Math.max(1, ...expGroups.map(x => x.v));

    const tile = (page, icon, title, lines) => `<a class="tile" href="#${page}"><div class="tile-icon">${icons[icon]}</div><div><h4>${title}</h4>${lines.map(l => `<p>${l}</p>`).join('')}</div></a>`;
    const low = db.items.filter(i => itemQty(i.name) < +i.min);
    const overdue = db.salesInvoices.filter(i => salesStatus(i) === 'متأخرة');
    const latePI = db.purchaseInvoices.filter(i => purchStatus(i) === 'متأخرة');
    const openMOs = db.maintenanceOrders.filter(m => m.status !== 'مكتمل');
    const latePlan = db.maintenancePlan.filter(m => planStatus(m) === 'متأخرة');
    const overLimit = db.customers.filter(c => +c.limit && custBal(c.name) > +c.limit);

    const mine = myApprovals();
    const alerts = [
      ...(mine.length ? [{ c: 'amber', i: 'shield', t: `${mine.length} مستند بانتظار اعتمادك`, s: 'لن تُرحّل قبل الاعتماد', h: 'approvals', q: '' }] : []),
      ...overdue.map(i => ({ c: 'red', i: 'sales', t: `فاتورة متأخرة ${esc(i.no)}`, s: `${esc(i.customer)} — المتبقي ${money(invTotal(i) - salesPaid(i))}`, h: 'salesInvoices', q: i.no })),
      ...latePI.map(i => ({ c: 'red', i: 'cart', t: `مستحق لمورد ${esc(i.no)}`, s: `${esc(i.supplier)} — المتبقي ${money(i.amount - purchPaid(i))}`, h: 'purchaseInvoices', q: i.no })),
      ...overLimit.map(c => ({ c: 'red', i: 'users', t: `تجاوز حد الائتمان: ${esc(c.name)}`, s: `الرصيد ${money(custBal(c.name))} — الحد ${money(c.limit)}`, h: 'customers', q: c.name })),
      ...low.map(i => ({ c: 'amber', i: 'box', t: `رصيد منخفض: ${esc(i.name)}`, s: `الرصيد ${num(itemQty(i.name))} ${esc(i.unit)} — حد الطلب ${num(i.min)}`, h: 'items', q: i.name })),
      ...latePlan.map(m => ({ c: 'amber', i: 'wrench', t: 'صيانة دورية متأخرة', s: `${esc(m.machine)} — ${esc(m.task)}`, h: 'maintenancePlan', q: m.machine })),
      ...openMOs.map(m => ({ c: '', i: 'truck', t: `أمر صيانة ${esc(m.no)} — ${esc(m.status)}`, s: esc(m.machine), h: 'maintenanceOrders', q: m.no })),
    ];

    content.innerHTML = `
      ${dashboardCharts()}

      <div class="section-title">الإدارات</div>
      <div class="tiles">
        ${tile('accounts', 'ledger', 'الحسابات', [`<b>${db.accounts.length}</b> حساب في الشجرة`, `<b>${glEntries().length}</b> قيد (${db.journal.length} يدوي)`])}
        ${tile('cashboxes', 'cash', 'الخزينة', [`الرصيد: <b>${money(sum(boxes, b => b.v))}</b>`, `<b>${db.receipts.length}</b> قبض · <b>${db.payments.length}</b> صرف`])}
        ${tile('salesInvoices', 'sales', 'المبيعات', [`مستحق من العملاء <b>${money(receivable)}</b>`, `<b>${overdue.length}</b> فاتورة متأخرة`])}
        ${tile('purchaseInvoices', 'cart', 'المشتريات', [`مستحق للموردين <b>${money(payable)}</b>`, `<b>${db.purchaseOrders.filter(p => p.status !== 'مستلم').length}</b> أمر شراء مفتوح`])}
        ${tile('stockBalances', 'box', 'المخازن', [`قيمة المخزون <b>${money(sum(db.items, i => itemQty(i.name) * i.cost))}</b>`, `<b>${low.length}</b> صنف تحت حد الطلب`])}
        ${tile('employees', 'users', 'شئون العاملين', [`<b>${db.employees.length}</b> موظف`, `رواتب مرحّلة: <b>${money(sum(db.payroll, p => p.basic + p.allowances - p.deductions))}</b>`])}
        ${tile('workers', 'hardhat', 'شئون العمالة', [`<b>${db.workers.filter(w => w.status === 'نشط').length}</b> عامل نشط`, `أجور: <b>${money(sum(db.dailyLabor, d => d.days * d.wage))}</b>`])}
        ${tile('machines', 'truck', 'الميكنة', [`<b>${db.machines.length}</b> معدة · <b>${db.machines.filter(m => machineState(m) === 'تعمل').length}</b> تعمل`, `<b>${num(sum(db.machineOps, o => o.hours))}</b> ساعة تشغيل`])}
        ${tile('maintenanceOrders', 'wrench', 'الصيانة', [`<b>${openMOs.length}</b> أمر صيانة مفتوح`, `<b>${latePlan.length}</b> صيانة دورية متأخرة`])}
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>أحدث القيود المرحّلة</h3><div class="spacer"></div><a class="btn ghost" href="#journal">دفتر اليومية</a></div>
          <div class="table-wrap"><table>
            <thead><tr><th>رقم القيد</th><th>التاريخ</th><th>البيان</th><th>المصدر</th><th>المبلغ</th></tr></thead>
            <tbody>${glEntries().slice(0, 7).map(e => `<tr><td class="code">${esc(e.no)}</td><td>${esc(e.date)}</td><td>${esc(e.desc)}</td><td><span class="src ${e.manual ? 'manual' : ''}">${e.src}</span></td><td class="num">${money(sum(e.lines, l => l.dr))}</td></tr>`).join('')}</tbody>
          </table></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>تنبيهات تحتاج متابعة</h3><div class="spacer"></div><span class="pill red">${alerts.length}</span></div>
          <ul class="alerts">${alerts.slice(0, 8).map(a => `<li><span class="a-ico kpi-icon ${a.c}">${icons[a.i]}</span><div>${a.t}<small>${a.s}</small></div><a href="#${a.h}" data-go="${a.h}" data-q="${esc(a.q)}">عرض</a></li>`).join('') || '<li class="empty">لا توجد تنبيهات</li>'}</ul>
        </div>
      </div>`;
    $$('[data-go]', content).forEach(a => a.addEventListener('click', e => { e.preventDefault(); goTo(a.dataset.go, a.dataset.q); }));
    wireDashboard();
  }
  const kpi = (label, value, trend, dir, color, icon) => `
    <div class="kpi"><div class="kpi-icon ${color}">${icon}</div>
      <div><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-trend ${dir}">${trend}</div></div></div>`;

  // ---------- الجداول العامة ----------
  const val = (r, c) => c.compute ? c.compute(r) : r[c.key];
  const cell = (r, c) => { const v = val(r, c); return c.render ? c.render(v, r) : esc(v); };
  const tableCols = m => m.cols.filter(c => !c.formOnly);

  function renderModule(name) {
    const m = modules[name];
    const T = tbl(name), all = rowsOf(name);
    const sel = (state.sel ||= {})[name] ||= new Set();
    [...sel].forEach(id => { if (!all.some(r => r.id === id)) sel.delete(id); });
    const showAppr = APPR_MODULES.includes(T) && (apprOn(T) || all.some(r => r.appr));
    const cols = [...tableCols(m), ...(showAppr ? [C('_appr', 'الاعتماد', { compute: r => apprText(T, r), render: (v, r) => apprPill(T, r) })] : [])];
    const q = state.q.trim().toLowerCase();
    let rows = all.filter(r => !q || m.cols.some(c => String(val(r, c) ?? '').toLowerCase().includes(q)));
    const dk = ['date', 'month', 'from'].find(k => m.cols.some(c => c.key === k));
    rows.sort(dk ? (a, b) => String(b[dk] ?? '').localeCompare(String(a[dk] ?? '')) || String(b.no ?? '').localeCompare(String(a.no ?? ''))
      : (a, b) => String(a.code ?? a.name ?? '').localeCompare(String(b.code ?? b.name ?? ''), 'ar'));
    const fcol = m.filter && m.cols.find(c => c.key === m.filter);
    if (fcol && state.filter) rows = rows.filter(r => val(r, fcol) === state.filter);
    const fopts = fcol ? (fcol.options ? fcol.options() : [...new Set(all.map(r => val(r, fcol)))]) : [];
    const totals = cols.filter(c => c.total);

    content.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>${m.title}</h3><div class="sub">${all.length} سجل</div></div>
          <div class="spacer"></div>
          <div class="toolbar">
            <input class="input" id="tblSearch" type="search" placeholder="بحث..." value="${esc(state.q)}">
            ${fcol ? `<select class="input" id="tblFilter"><option value="">${fcol.label}: الكل</option>${fopts.map(o => `<option ${o === state.filter ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>` : ''}
            <button class="btn ghost" id="exportBtn">${icons.export}تصدير</button>
            <button class="btn ghost" id="importBtn">${icons.receive}استيراد</button>
            <button class="btn ghost danger-ghost" id="clearScreenBtn" title="حذف كل سجلات هذه الشاشة">${icons.del}تفريغ الشاشة</button>
            <button class="btn primary" id="addBtn">${icons.plus}إضافة ${m.single}</button>
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th class="sel-col"><input type="checkbox" id="selAll" title="تحديد الكل"></th>${cols.map(c => `<th>${c.label}</th>`).join('')}<th></th></tr></thead>
          <tbody>
            ${rows.length ? rows.map(r => `<tr class="${sel.has(r.id) ? 'picked' : ''}">
              <td class="sel-col"><input type="checkbox" class="rsel" data-rid="${r.id}" ${sel.has(r.id) ? 'checked' : ''}></td>
              ${cols.map(c => `<td class="${c.cls ?? ''}">${cell(r, c)}</td>`).join('')}
              <td><div class="row-actions">
                ${canApprove(T, r) ? `<button class="ok" data-apr="${r.id}" title="اعتماد">✓</button><button class="del" data-rej="${r.id}" title="رفض">✕</button>` : ''}
                ${(m.actions || []).map((a, i) => !a.show || a.show(r) ? `<button data-act="${i}" data-id="${r.id}" class="${a.write ? 'w' : ''}" title="${a.title}">${icons[a.icon]}</button>` : '').join('')}
                ${APPR_MODULES.includes(T) || m.key === 'no' ? `<button data-print="${r.id}" title="طباعة المستند">${icons.print}</button>` : ''}
                <button data-edit="${r.id}" title="تعديل">${icons.edit}</button>
                <button class="del" data-del="${r.id}" title="حذف">${icons.del}</button>
              </div></td></tr>`).join('')
            : `<tr><td colspan="${cols.length + 2}" class="empty">لا توجد سجلات مطابقة</td></tr>`}
          </tbody>
        </table></div>
        <div class="bulk-bar" id="bulkBar" ${sel.size ? '' : 'hidden'}><b id="bulkN">${sel.size}</b> محدد
          <button type="button" class="btn ghost danger-ghost" id="bulkDel">${icons.del}حذف المحدد</button>
          <button type="button" class="btn ghost" id="bulkClear">إلغاء التحديد</button></div>
        <div class="table-foot">
          <span>عرض ${rows.length} من ${all.length}</span>
          <span>${totals.map(c => `${c.label}: <b>${(c.render === num || (c.cls === 'num' && !c.render) ? num : money)(sum(rows, r => val(r, c)))}</b>`).join(' &nbsp;·&nbsp; ')}</span>
        </div>
      </div>`;

    $('#tblSearch').addEventListener('input', e => { state.q = e.target.value; renderModule(name); const el = $('#tblSearch'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
    $('#tblFilter')?.addEventListener('change', e => { state.filter = e.target.value; renderModule(name); });
    $('#addBtn').onclick = () => openRecordForm(name);
    $('#importBtn').onclick = () => openImport(T, m.fixed?.stype && ['salesInvoices', 'salesReturns'].includes(T) ? { account: catAcc(SYS.customers, 'عملاء ' + m.fixed.stype), _title: m.title } : {});
    $('#exportBtn').onclick = () => downloadCSV(name, cols.map(c => c.label), rows.map(r => cols.map(c => val(r, c))));
    const find = id => db[T].find(r => r.id === id);
    $$('[data-act]', content).forEach(b => b.onclick = () => m.actions[+b.dataset.act].fn(find(b.dataset.id)));
    $$('[data-print]', content).forEach(b => b.onclick = () => printDoc(T, find(b.dataset.print), true));
    $$('[data-apr]', content).forEach(b => b.onclick = () => { if (decide(T, b.dataset.apr, true)) { save(); renderNav(); renderModule(name); toast(afterDecideMsg(T, b.dataset.apr)); } });
    $$('[data-rej]', content).forEach(b => b.onclick = () => rejectDoc(T, b.dataset.rej));
    $$('[data-edit]', content).forEach(b => b.onclick = () => openRecordForm(name, find(b.dataset.edit)));
    $$('[data-del]', content).forEach(b => b.onclick = () => deleteRecord(name, find(b.dataset.del)));
    const upd = () => { $('#bulkN').textContent = sel.size; $('#bulkBar').hidden = !sel.size; $('#selAll').checked = rows.length > 0 && rows.every(r => sel.has(r.id)); };
    $$('.rsel', content).forEach(c => c.onchange = () => { c.checked ? sel.add(c.dataset.rid) : sel.delete(c.dataset.rid); c.closest('tr').classList.toggle('picked', c.checked); upd(); });
    $('#selAll').onchange = e => { rows.forEach(r => e.target.checked ? sel.add(r.id) : sel.delete(r.id)); renderModule(name); };
    $('#bulkClear').onclick = () => { sel.clear(); renderModule(name); };
    $('#bulkDel').onclick = () => deleteMany(name, [...sel], () => sel.clear());
    $('#clearScreenBtn').onclick = () => clearScreen(name);
    upd();
  }

  // حذف عدة سجلات: البيانات الأساسية المستخدمة في حركات لا تُحذف (تُذكر في النتيجة)
  function deleteMany(name, ids, after) {
    if (!can(name, 'd')) return denied();
    const m = modules[name], T = tbl(name);
    const recs = db[T].filter(r => ids.includes(r.id));
    if (!recs.length) return;
    const blocked = m.key ? recs.filter(r => usages(T, r[m.key]).length) : [];
    const ok = recs.filter(r => !blocked.includes(r));
    const posted = ok.filter(r => glEntries().some(e => e.module === T && e.id === r.id)).length;
    if (!ok.length) return toast(`لا يمكن حذف المحدد: كل السجلات مستخدمة في حركات (${blocked.length})`, 4500);
    if (!confirm(`حذف ${ok.length} سجل من "${m.title}"؟${posted ? `\nسيتم إلغاء ${posted} قيد محاسبي مرتبط.` : ''}${blocked.length ? `\n${blocked.length} سجل مستخدم في حركات لن يُحذف.` : ''}`)) return;
    const del = new Set(ok.map(r => r.id));
    db[T] = db[T].filter(r => !del.has(r.id));
    after?.(); save(); renderPage(); renderNav();
    toast(`تم حذف ${ok.length} سجل${blocked.length ? ` — وتُرك ${blocked.length} مستخدم في حركات` : ''}`, 4000);
  }
  // تفريغ الشاشة: حذف كل سجلاتها بعد تأكيد بالكتابة، مع نسخة احتياطية اختيارية
  function clearScreen(name) {
    const m = modules[name], T = tbl(name), recs = rowsOf(name);
    if (!can(name, 'd') || !canSp('adminTools')) return denied();
    if (!recs.length) return toast('الشاشة فارغة بالفعل');
    const blocked = m.key ? recs.filter(r => usages(T, r[m.key]).length) : [];
    const posted = recs.filter(r => !blocked.includes(r) && glEntries().some(e => e.module === T && e.id === r.id)).length;
    const pending = recs.filter(r => r.appr?.status === 'pending').length;
    openModal(`تفريغ شاشة: ${m.title}`, [], {}, () => {
      if (normAr($('#clrWord').value) !== normAr('تفريغ')) { toast('اكتب كلمة "تفريغ" للتأكيد'); return false; }
      const go = () => { const ids = new Set(recs.filter(r => !blocked.includes(r)).map(r => r.id));
        db[T] = db[T].filter(r => !ids.has(r.id)); (state.sel || {})[name]?.clear?.();
        save(); renderPage(); renderNav(); toast(`تم تفريغ "${m.title}": حُذف ${ids.size} سجل${blocked.length ? ` — وتُرك ${blocked.length} مستخدم في حركات` : ''}`, 4500); };
      if ($('#clrBackup').checked) saveFile(`نسخة-${m.title}-${today()}.json`, JSON.stringify(recs, null, 2), 'application/json').finally(go); else go();
    });
    $('#modalBody').innerHTML = `<div class="clr-box">
      <p>سيتم حذف <b>${recs.length - blocked.length}</b> سجل من شاشة <b>${esc(m.title)}</b> نهائياً.</p>
      <ul>${posted ? `<li>سيُلغى <b>${posted}</b> قيد محاسبي مرتبط بهذه السجلات وتتغير الأرصدة والتقارير.</li>` : ''}
        ${pending ? `<li>منها <b>${pending}</b> مستند بانتظار الاعتماد.</li>` : ''}
        ${blocked.length ? `<li><b>${blocked.length}</b> سجل مستخدم في حركات أخرى لن يُحذف (احذف حركاته أولاً).</li>` : ''}</ul>
      <label class="check"><input type="checkbox" id="clrBackup" checked><span>تنزيل نسخة احتياطية من السجلات قبل الحذف</span></label>
      <div class="field"><label>للتأكيد اكتب كلمة <b>تفريغ</b></label><input class="input" id="clrWord" autocomplete="off"></div></div>`;
    $('#saveBtn').textContent = 'تفريغ الشاشة'; $('#saveBtn').classList.add('danger');
    setTimeout(() => $('#clrWord')?.focus(), 50);
  }

  function deleteRecord(name, r) {
    if (!can(name, 'd')) return denied();
    const m = modules[name], T = tbl(name);
    const used = m.key ? usages(T, r[m.key]) : [];
    if (used.length) return toast(`لا يمكن الحذف: مستخدم في ${used.map(([t, n]) => `${pageInfo(t).title} (${n})`).join('، ')}`, 4000);
    const posted = glEntries().some(e => e.module === T && e.id === r.id);
    if (!confirm(`هل تريد حذف هذا السجل (${m.single})؟${posted ? '\nسيتم إلغاء القيد المحاسبي المرتبط به.' : ''}`)) return;
    db[T] = db[T].filter(x => x.id !== r.id);
    save(); renderPage(); renderNav(); toast('تم الحذف');
  }

  // ---------- النافذة المنبثقة ----------
  const modal = $('#modal'), form = $('#modalForm');
  let onSubmit = null, condUpd = null;
  const field = (c, v, vals = {}) => {
    if (c.input === 'jlines') return `<div class="field full" data-f="${c.key}"><label>${c.label}</label><div class="jlines-box" data-jlines="${c.key}"></div><input type="hidden" name="${c.key}" value="${esc(JSON.stringify(Array.isArray(v) ? v : jLinesOf(vals)))}"></div>`;
    if (c.input === 'lines') return `<div class="field full" data-f="${c.key}"><label>${c.label}</label><div class="lines-box" data-lines="${c.key}" data-tax="${c.tax ? 1 : ''}"></div><input type="hidden" name="${c.key}" value="${esc(JSON.stringify(Array.isArray(v) ? v : []))}"></div>`;
    if (c.input === 'checks') return `<div class="field full"><label>${c.label}</label><div class="checks">${c.options().map(o => `<label class="check"><input type="checkbox" name="${c.key}" value="${esc(o)}"><span>${esc(o)}</span></label>`).join('')}</div></div>`;
    const input = c.input === 'select'
      ? `<select class="input" name="${c.key}" ${c.optional ? '' : 'required'}>${c.allowEmpty ? `<option value="">${c.allowEmpty}</option>` : ''}${c.options(vals).map(o => { const [ov, ol] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`; }).join('')}</select>`
      : `<input class="input" name="${c.key}" type="${c.input ?? 'text'}" ${c.input === 'number' ? 'step="any"' : ''} value="${esc(v)}" ${c.placeholder ? `placeholder="${esc(c.placeholder)}"` : ''} ${c.optional ? '' : 'required'} ${c.suggest ? `data-dl="dl-${c.key}" autocomplete="off"` : ''}>${c.suggest ? `<datalist id="dl-${c.key}">${c.suggest(vals).map(o => `<option value="${esc(o)}">`).join('')}</datalist>` : ''}`;
    return `<div class="field ${c.full ? 'full' : ''}" data-f="${c.key}"><label>${c.label}</label>${input}</div>`;
  };
  function openModal(title, fields, values, submit) {
    form.classList.remove('wide', 'info'); $('#saveBtn').classList.remove('danger');
    $('#saveBtn').textContent = 'حفظ'; $('#saveBtn').disabled = false;
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = `<div class="form-grid">${fields.map(c => field(c, values[c.key] ?? '', values)).join('')}</div>`; condUpd = null;
    onSubmit = submit;
    modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false');
    $('#modalBody .input')?.focus();
  }
  function openInfo(title, html) {
    form.classList.add('wide', 'info');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    onSubmit = null;
    modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false');
  }
  function closeModal() { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); onSubmit = null; condUpd = null; $('#modalBody').innerHTML = ''; }
  $$('[data-close]', modal).forEach(b => b.onclick = closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  form.addEventListener('change', () => condUpd?.());
  form.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(form);
    if (onSubmit && onSubmit(Object.fromEntries(fd), fd) !== false) closeModal();
  });

  // آخر تعديل: من وإمتى
  async function showAudit(r) {
    const el = document.createElement('div'); el.className = 'audit';
    const when = new Date(r._at).toLocaleString((window.UI_LOCALE || 'ar-EG'), { dateStyle: 'medium', timeStyle: 'short' });
    el.textContent = `آخر تعديل: ${when}`;
    $('#modalBody').appendChild(el);
    if (r._u) { const au = db.appUsers.find(x => x.username === r._u); el.textContent = `آخر تعديل: ${au?.name || r._u} — ${when}`; return; }
    if (r._by && store.user) { const ps = await store.user.profiles([r._by]); const n = ps[r._by]?.name; if (n) el.textContent = `آخر تعديل: ${n} — ${when}`; }
  }

  // رقم المستند التالي (INV-3105 → INV-3106)
  // ترقيم تلقائي لكل الشاشات: يكمل على آخر كود مسجل، وإذا كانت الشاشة فارغة يبدأ بالبادئة المحددة لها
  const AUTO_PREFIX = {
    customers: 'CUS-', suppliers: 'SUP-', items: 'ITM-', warehouses: 'WH-', units: 'U-', salesItems: 'SI-', branches: 'BR-', costCenters: 'CC-',
    crops: 'CR-', departments: 'DEP-', cashboxes: 'BOX-', employees: 'EMP-', workers: 'WRK-', girlsFixed: 'GF-', girlsTemp: 'GT-', bangladesh: 'BD-',
    fixedAssets: 'FA-', machines: 'MCH-', journal: 'JV-', receipts: 'RV-', payments: 'PV-', boxTransfers: 'BT-', openingBalances: 'OB-',
    supplierAccruals: 'SA-', salesInvoices: 'SL-', salesQuotes: 'SQ-', salesReturns: 'SR-', purchaseQuotes: 'PQ-', purchaseOrders: 'PO-',
    purchaseInvoices: 'PI-', purchaseReturns: 'PR-', stockIn: 'GRN-', stockOut: 'GIN-', transfers: 'TR-', maintenanceOrders: 'MO-',
    expenseOrders: 'EXP-', supplierPayReqs: 'SPR-', payroll: 'PAY-', dailyLabor: 'DL-', advances: 'ADV-', machineOps: 'OP-', leaves: 'LV-',
    attendance: 'ATT-', maintenancePlan: 'MP-', stockRequests: 'MR-' };
  const autoNo = (T, key) => nextNo(db[T] || [], key) || ((AUTO_PREFIX[T] || modules[T]?.prefix || (key === 'code' ? 'C-' : 'N-')) + '0001');
  const nextNo = (list, key) => {
    const nums = list.map(r => String(r[key] ?? '').match(/^(.*?)(\d+)$/)).filter(Boolean);
    if (!nums.length) return '';
    const [, prefix, n] = nums.reduce((a, b) => (+b[2] > +a[2] ? b : a));
    return prefix + String(+n + 1).padStart(n.length, '0');
  };

  function openRecordForm(name, record, prefill = {}, afterCreate, opts = {}) {
    const locks = (opts.lock || []).filter(k => k in prefill);
    if (!can(name, record ? 'e' : 'a')) return denied();
    const m = modules[name], T = tbl(name);
    const fields = m.cols.filter(c => !c.compute);
    const t = today();
    const defaults = Object.fromEntries(fields.map(c => [c.key, c.input === 'date' ? t : c.input === 'month' ? t.slice(0, 7) : '']));
    ['no', 'code'].forEach(k => { if (k in defaults) defaults[k] = autoNo(T, k); });
    const recId = record?.id;
    openModal(`${record ? 'تعديل' : 'إضافة'} ${m.single}`, fields, record ? { ...record, ...(m.load?.(record) || {}) } : { ...defaults, ...(m.defaults?.() || {}), ...prefill }, data => {
      // السجل الحالي من قاعدة البيانات (قد يكون مستخدم آخر عدّله أو حذفه)
      const cur = recId ? db[T].find(r => r.id === recId) : null;
      if (recId && !cur) { toast('هذا السجل حذفه مستخدم آخر'); return; }
      locks.forEach(k => { data[k] = prefill[k]; });
      fields.forEach(c => { if (c.input === 'number') data[c.key] = +data[c.key] || 0; if (c.input === 'lines' || c.input === 'jlines') { try { data[c.key] = JSON.parse(data[c.key] || '[]'); } catch { data[c.key] = []; } } });
      if (!cur) ['no', 'code'].forEach(k => { if (fields.some(c => c.key === k) && (!data[k] || db[T].some(r => r[k] === data[k]))) data[k] = autoNo(T, k); });
      if (m.key && db[T].some(r => r !== cur && r[m.key] === data[m.key] && (!m.keyScope || (r[m.keyScope] || '') === (data[m.keyScope] || '')))) { toast(`"${data[m.key]}" مسجل من قبل${m.keyScope ? ' في نفس الحساب الرئيسي' : ''}`); return false; }
      if (m.fixed && !cur) Object.assign(data, m.fixed);
      const err = m.validate?.(data, cur);
      if (err) { toast(err, 3500); return false; }
      const sv = v => v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
      const changed = !cur || fields.some(c => sv(cur[c.key]) !== sv(data[c.key]));
      let saved = cur;
      if (cur) {
        if (m.key && cur[m.key] !== data[m.key] && !db[T].some(r => r !== cur && r[m.key] === cur[m.key])) (refs[T] || []).forEach(([tb, f]) => db[tb].forEach(r => { if (r[f] === cur[m.key]) r[f] = data[m.key]; (Array.isArray(r.lines) ? r.lines : []).forEach(l => { if (l[f] === cur[m.key]) l[f] = data[m.key]; }); }));
        Object.assign(cur, data);
      } else {
        saved = { id: genId(), ...data, ...(m.fixed || {}) };
        db[T].unshift(saved);
        afterCreate?.(saved);
      }
      m.afterSave?.(saved);
      submitForApproval(T, saved, changed);
      save(); renderPage(); renderNav();
      if (saved.appr?.status === 'pending') return toast(`تم الحفظ — ${apprText(T, saved)} · لن يُرحّل قبل الاعتماد`, 4000);
      const mine = glEntries().filter(e => e.module === T && e.id === saved.id), posted = mine.find(e => e.no === saved.no) || mine[0];
      toast(posted ? `تم الحفظ والترحيل — قيد ${posted.no}` : cur ? 'تم حفظ التعديلات' : 'تمت الإضافة بنجاح');
    });
    if (record?._at) showAudit(record);
    if (m.wide) form.classList.add('wide');
    locks.forEach(k => { const el = form.elements.namedItem(k); if (!el) return;
      if (el.tagName === 'SELECT') { el.dataset.locked = '1'; el._px || enhanceSelect(el); syncSelect(el); } else { el.readOnly = true; el.classList.add('locked'); el.title = 'مقفل على هذه الشاشة'; }
      el.closest('.field')?.classList.add('field-locked'); });
    $$('#modalBody .jlines-box').forEach(box => initJLines(box, form.elements.namedItem(box.dataset.jlines)));
    $$('#modalBody .lines-box').forEach(box => { const lc = fields.find(c => c.key === box.dataset.lines);
      const sales = lc?.priceFrom === 'price';
      const typeNow = () => m.fixed?.stype || (form.elements.namedItem('account') ? acc(form.elements.namedItem('account').value)?.name.replace(/^عملاء\s*/, '') : '') || '';
      initLines(box, form.elements.namedItem(box.dataset.lines), { tax: !!box.dataset.tax, priceOf: it => +(sales ? it.price : it.cost) || 0, sales,
        pick: lc?.pick ? () => lc.pick(Object.fromEntries(new FormData(form))) : null, pickOn: lc?.pickOn || [],
        items: sales ? () => salesItemsFor(SALE_TYPES.some(([, t]) => t === typeNow()) ? typeNow() : '').map(i => ({ ...i, category: acc(i.account)?.name || '' })) : null,
        empty: sales ? `لا توجد أصناف ${m.fixed?.stype ? 'لـ ' + m.fixed.stype : 'مبيعات'} — أضفها من قواعد البيانات › أصناف المبيعات` : '',
        onTotal: lc?.priceFrom === 'price' ? (sub, t) => { sub = t ? t.total : sub; const a = form.elements.namedItem('amount'); if (a) { a.readOnly = sub > 0; if (sub > 0) a.value = +sub.toFixed(2); } } : null }); });
    // قوائم اقتراحات تتغير حسب حقل آخر (اسم المستفيد حسب اسم الحساب)
    const dyns = fields.filter(c => c.dyn);
    // حقول تظهر حسب الاختيار (مثل بيانات الشيك والتحويل البنكي عند اختيار بنك)
    const conds = fields.filter(c => c.when);
    if (conds.length || dyns.length) {
      let lastDyn = null;
      const upd = () => { const v = Object.fromEntries(new FormData(form)); conds.forEach(c => { const el = $(`#modalBody [data-f="${c.key}"]`); if (el) el.hidden = !c.when(v); });
        const sig = JSON.stringify([...dyns.map(c => v[c.dynFrom || 'account'] ?? ''), v.otype ?? '']); if (sig === lastDyn) return; const first = lastDyn === null; lastDyn = sig;
        dyns.forEach(c => { const src = v[c.dynFrom || 'account'], list = c.suggest(v), dl = $(`#dl-${c.key}`), inp = form.elements.namedItem(c.key); if (dl) dl.innerHTML = list.map(o => `<option value="${esc(o)}">${esc(['party', 'supplier'].includes(c.key) ? partyLabel(o, src) : '')}</option>`).join('');
          if (!inp) return; const pk = partyKind(accCode(src));
          inp.placeholder = list.length ? `اختر من ${list.length} — أو اكتب للبحث` : pk === 's' ? 'لا يوجد موردون على هذا الحساب — أضفهم من قاعدة بيانات الموردين' : pk === 'c' ? 'لا يوجد عملاء على هذا الحساب — أضفهم من قاعدة بيانات العملاء' : src ? 'اكتب اسم المستفيد' : 'اختر اسم الحساب أولاً';
          if (!first && inp.value && list.length && !list.includes(inp.value) && ['c', 's', 'o'].includes(partyKind(accCode(src)))) inp.value = '';
          if (list.length === 1 && !inp.value) inp.value = list[0]; }); };
      condUpd = upd; upd();
    }
    // الكود / رقم الحركة يتولد تلقائياً ولا يُكتب يدوياً
    if (!record) ['no', 'code'].forEach(k => { const el = form.elements.namedItem(k); if (el && el.tagName === 'INPUT') { el.readOnly = true; el.classList.add('auto-code'); el.title = 'ترقيم تلقائي'; } });
    // قوائم تابعة: عند تغيير الحساب/المخزن تُعاد بناء القائمة التابعة له ولا تعرض إلا ما يخصه
    const deps = fields.filter(c => c.dep && c.input === 'select');
    if (deps.length) {
      const rebuild = src => deps.filter(c => !src || c.dep.includes(src)).forEach(c => {
        const s = form.elements.namedItem(c.key); if (!s || s.tagName !== 'SELECT' || s.dataset.locked) return;
        const v = Object.fromEntries(new FormData(form)), cur = s.value, list = c.options(v).map(o => Array.isArray(o) ? o : [o, o]);
        s.innerHTML = (c.allowEmpty ? `<option value="">${c.allowEmpty}</option>` : '') + list.map(([ov, ol]) => `<option value="${esc(ov)}">${esc(ol)}</option>`).join('');
        s.value = list.some(([ov]) => String(ov) === String(cur)) ? cur : (c.allowEmpty ? '' : list.length === 1 ? list[0][0] : '');
        if (!c.allowEmpty && !list.some(([ov]) => String(ov) === String(cur)) && list.length !== 1) s.selectedIndex = -1;
        if (s.value !== cur) s.dispatchEvent(new Event('change', { bubbles: true }));
        syncSelect(s);
      });
      [...new Set(deps.flatMap(c => c.dep))].forEach(src => { const el = form.elements.namedItem(src); ['change', 'input'].forEach(ev => el?.addEventListener(ev, () => rebuild(src))); });
      if (!record) rebuild();
    }
    // تعبئة تلقائية عند اختيار عنصر مرتبط
    if (m.onSelect) {
      const f = form.elements;
      Object.entries(m.onSelect).forEach(([k, fn]) => { const el = f.namedItem(k); el?.addEventListener('change', e => fn(f, e.target.value)); if (!record && el && !(k in prefill)) fn(f, el.value); });
    }
  }

  // ---------- كومبوبوكس بحث: يعرض الخيارات المطابقة لما يُكتب ----------
  const normAr = x => String(x ?? '').toLowerCase().replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[\u064B-\u0652\u0640]/g, '').replace(/\s+/g, ' ').trim();
  const combo = (() => {
    const box = document.createElement('div'); box.className = 'combo-list'; box.hidden = true; document.body.appendChild(box);
    let inp = null, items = [], idx = -1, typed = false;
    const selOf = el => el?.dataset.sel ? el.previousElementSibling : null;
    const close = () => { const s = selOf(inp); if (s && inp) inp.value = selLabel(s); box.hidden = true; inp = null; idx = -1; };
    const pick = i => {
      const it = items[i]; if (!it || !inp) return; const el = inp, s = selOf(el);
      if (s) { s.value = it.v; el.value = it.l; box.hidden = true; inp = null; s.dispatchEvent(new Event('change', { bubbles: true })); return; }
      el.value = it.v; close(); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const hl = (t, q) => { if (!q) return esc(t); const nt = normAr(t), i = nt.indexOf(q); return i < 0 || nt.length !== t.length ? esc(t) : esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length)); };
    const show = el => {
      if (el.readOnly || el.disabled) return;
      const s = selOf(el), dl = s ? null : document.getElementById(el.dataset.dl); if (!s && !dl) return;
      const all = s ? [...s.options].map(o => ({ v: o.value, l: o.textContent.trim(), sel: true })) : [...dl.options].map(o => ({ v: o.value, l: o.textContent.trim() }));
      const q = s && !typed ? '' : normAr(el.value), words = q.split(' ').filter(Boolean);
      const main = o => o.sel ? o.l : o.v;
      items = all.filter(o => { const t = normAr(o.v + ' ' + o.l); return words.every(w => t.includes(w)); }).sort((a, b) => (normAr(main(a)).startsWith(q) ? 0 : 1) - (normAr(main(b)).startsWith(q) ? 0 : 1)).slice(0, 250);
      inp = el; idx = items.length ? Math.max(0, s && !typed ? items.findIndex(o => o.v === s.value) : 0) : -1;
      if (!all.length) { box.hidden = true; return; }
      box.innerHTML = items.length ? items.map((o, i) => `<div class="combo-opt ${i === idx ? 'on' : ''} ${o.sel && o.v === s.value ? 'cur' : ''}" data-i="${i}"><b>${hl(main(o), q)}</b>${!o.sel && o.l ? `<small>${esc(o.l)}</small>` : ''}</div>`).join('') + `<div class="combo-foot">${items.length} من ${all.length}${s ? ' — اكتب للبحث' : ''}</div>`
        : `<div class="combo-none">لا توجد نتيجة مطابقة لـ "${esc(el.value)}"</div>`;
      const r = el.getBoundingClientRect(); box.style.top = `${r.bottom + 4}px`; box.style.left = `${r.left}px`; box.style.width = `${Math.max(r.width, 240)}px`; box.hidden = false;
      box.querySelector('.combo-opt.on')?.scrollIntoView({ block: 'nearest' });
    };
    const move = d => { if (!items.length) return; idx = (idx + d + items.length) % items.length; $$('.combo-opt', box).forEach((o, i) => o.classList.toggle('on', i === idx)); box.querySelector('.combo-opt.on')?.scrollIntoView({ block: 'nearest' }); };
    document.addEventListener('focusin', e => { if (e.target.matches?.('[data-dl], [data-sel]')) { typed = false; if (e.target.dataset.sel) e.target.select?.(); show(e.target); } });
    document.addEventListener('mousedown', e => { if (e.target.matches?.('[data-sel]') && document.activeElement === e.target && box.hidden) { typed = false; show(e.target); } });
    document.addEventListener('input', e => { if (e.target.matches?.('[data-dl], [data-sel]') && e.isTrusted) { typed = true; show(e.target); } });
    document.addEventListener('keydown', e => {
      if (!inp || e.target !== inp) return;
      if (box.hidden) { if (e.key === 'ArrowDown' && inp.dataset.sel) { e.preventDefault(); typed = false; show(inp); } return; }
      const s = selOf(inp);
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter' && idx >= 0 && (s || normAr(inp.value) !== normAr(items[idx].v))) { e.preventDefault(); e.stopPropagation(); pick(idx); }
      else if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (e.key === 'Tab') { if (s && typed && idx >= 0) pick(idx); else close(); }
    }, true);
    box.addEventListener('mousedown', e => { const o = e.target.closest('.combo-opt'); if (o) { e.preventDefault(); pick(+o.dataset.i); } });
    document.addEventListener('focusout', e => { if (e.target === inp) setTimeout(() => { if (document.activeElement !== inp) close(); }, 120); });
    window.addEventListener('scroll', e => { if (inp && !box.contains(e.target)) show(inp); }, true);
    return { close };
  })();
  // كل قائمة اختيار (select) تتحول إلى كومبوبوكس بحث: يُكتب فيه الاسم أو الكود وتظهر النتائج المطابقة
  function selLabel(s) { const o = s.options[s.selectedIndex], t = o ? o.textContent.trim() : ''; return window.trUI ? window.trUI(t) : t; }
  function enhanceSelect(s) {
    if (s._px || s.closest('.lines-grid') || s.multiple) return;
    const px = document.createElement('input'); px.type = 'text'; px.className = 'input sel-proxy'; px.autocomplete = 'off'; px.dataset.sel = '1';
    px.setAttribute('aria-label', s.closest('.field')?.querySelector('label')?.textContent || s.name || '');
    s.classList.add('sel-hidden'); s.tabIndex = -1; s._px = px; s.after(px); syncSelect(s);
  }
  function syncSelect(s) { const px = s._px; if (!px) return; if (document.activeElement !== px) px.value = selLabel(s); px.disabled = s.disabled; px.readOnly = !!s.dataset.locked;
    px.classList.toggle('locked', !!s.dataset.locked); px.title = s.dataset.locked ? 'مقفل على هذه الشاشة' : ''; px.style.cssText = s.style.cssText.replace(/display:\s*none;?/, ''); }
  const syncAllSelects = () => $$('select.sel-hidden').forEach(syncSelect);
  new MutationObserver(muts => { let any = false;
    muts.forEach(m => { m.addedNodes.forEach(n => { if (n.nodeType !== 1) return; (n.matches('select.input') ? [n] : [...n.querySelectorAll('select.input')]).forEach(enhanceSelect); any = true; });
      if (m.target.tagName === 'SELECT' && m.target._px) any = true; });
    if (any) syncAllSelects(); }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('change', () => syncAllSelects());
  $$('select.input').forEach(enhanceSelect);

  // ---------- محرر أطراف القيد: الحساب (بحث) · مدين · دائن · بيان السطر ----------
  function initJLines(box, hidden) {
    let rows = []; try { rows = JSON.parse(hidden.value || '[]'); } catch {}
    rows = rows.map(l => ({ acc: l.acc || '', dr: +l.dr || '', cr: +l.cr || '', note: l.note || '' }));
    while (rows.length < 2) rows.push({ acc: '', dr: '', cr: '', note: '' });
    rows.push({ acc: '', dr: '', cr: '', note: '' });
    const ACCS = leafAccounts();
    const rowHTML = (l, i) => `<tr data-i="${i}"><td class="lg-n">${i + 1}</td>
      <td class="jl-acc"><input class="lg-in" data-k="acc" data-dl="dl-jl-accs" autocomplete="off" placeholder="اكتب اسم أو كود الحساب" value="${esc(l.acc)}"></td>
      <td><input class="lg-in num-in" data-k="dr" type="number" step="any" min="0" value="${esc(l.dr)}" placeholder="0"></td>
      <td><input class="lg-in num-in" data-k="cr" type="number" step="any" min="0" value="${esc(l.cr)}" placeholder="0"></td>
      <td class="jl-note"><input class="lg-in" data-k="note" value="${esc(l.note)}" placeholder="بيان السطر (اختياري)"></td>
      <td><button type="button" class="lg-del" data-del title="حذف السطر">✕</button></td></tr>`;
    const sync = () => {
      const clean = rows.filter(l => l.acc || +l.dr || +l.cr).map(l => ({ acc: l.acc, dr: +l.dr || 0, cr: +l.cr || 0, note: l.note || '' }));
      hidden.value = JSON.stringify(clean);
      const dr = sum(clean, l => l.dr), cr = sum(clean, l => l.cr), diff = +(dr - cr).toFixed(2);
      box.querySelector('tfoot').innerHTML = `<tr><td colspan="2">الإجمالي — ${clean.length} طرف</td><td class="num"><b>${money(dr)}</b></td><td class="num"><b>${money(cr)}</b></td>
        <td colspan="2">${!clean.length ? '' : diff === 0 && dr > 0 ? '<span class="pill green">القيد متوازن</span>' : `<span class="pill red">غير متوازن — الفرق ${money(Math.abs(diff))} ${diff > 0 ? '(المدين أكبر)' : '(الدائن أكبر)'}</span>`}</td></tr>`;
    };
    const draw = () => {
      box.innerHTML = `<datalist id="dl-jl-accs">${ACCS.map(a => `<option value="${esc(accLabel(a))}">${esc(accType(a.code))} · ${nature(a.code)}</option>`).join('')}</datalist>
        <div class="lg-wrap"><table class="lines-grid jlines-grid"><thead><tr><th>#</th><th>الحساب</th><th>مدين</th><th>دائن</th><th>بيان السطر</th><th></th></tr></thead>
        <tbody>${rows.map(rowHTML).join('')}</tbody><tfoot></tfoot></table></div>
        <div class="lg-bar"><button type="button" class="btn ghost" data-addline>＋ طرف جديد</button><button type="button" class="btn ghost" data-balance>⚖ موازنة آخر سطر</button>
        <span class="hint">اكتب المبلغ في خانة المدين أو الدائن لكل حساب — يجب أن يتساوى المجموعان</span></div>`;
      sync();
    };
    const addRow = () => { rows.push({ acc: '', dr: '', cr: '', note: '' }); box.querySelector('tbody').insertAdjacentHTML('beforeend', rowHTML(rows.at(-1), rows.length - 1)); };
    box.addEventListener('input', e => {
      const inp = e.target.closest('[data-k]'), tr = e.target.closest('tr[data-i]'); if (!inp || !tr) return;
      const i = +tr.dataset.i, k = inp.dataset.k, l = rows[i]; l[k] = inp.value;
      // مبلغ في جانب واحد فقط
      if (k === 'dr' && +inp.value) { l.cr = ''; tr.querySelector('[data-k="cr"]').value = ''; }
      if (k === 'cr' && +inp.value) { l.dr = ''; tr.querySelector('[data-k="dr"]').value = ''; }
      if (k === 'acc') { const q = normAr(inp.value), a = ACCS.find(x => normAr(accLabel(x)) === q || x.code === inp.value.trim() || normAr(x.name) === q); if (a && inp.value !== accLabel(a)) { inp.value = accLabel(a); l.acc = inp.value; } }
      if (i === rows.length - 1 && (l.acc || +l.dr || +l.cr)) addRow();
      sync();
    });
    box.addEventListener('click', e => {
      if (e.target.closest('[data-addline]')) { addRow(); box.querySelector('tbody tr:last-child [data-k="acc"]').focus(); return; }
      if (e.target.closest('[data-balance]')) { // يكمل الفرق في آخر سطر مستخدم
        const used = rows.filter(l => l.acc || +l.dr || +l.cr), dr = sum(used, l => +l.dr || 0), cr = sum(used, l => +l.cr || 0), diff = +(dr - cr).toFixed(2);
        if (!diff) return toast('القيد متوازن بالفعل');
        let t = rows.find(l => l.acc && !+l.dr && !+l.cr) || rows.find(l => !l.acc && !+l.dr && !+l.cr);
        if (!t) { addRow(); t = rows.at(-1); }
        if (diff > 0) { t.cr = diff; t.dr = ''; } else { t.dr = -diff; t.cr = ''; }
        if (rows.at(-1) === t) rows.push({ acc: '', dr: '', cr: '', note: '' });
        draw(); return;
      }
      const del = e.target.closest('[data-del]'); if (!del) return;
      rows.splice(+del.closest('tr').dataset.i, 1); if (!rows.length || rows.at(-1).acc || +rows.at(-1).dr || +rows.at(-1).cr) rows.push({ acc: '', dr: '', cr: '', note: '' }); draw();
    });
    box.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !e.target.matches('.lg-in')) return;
      e.preventDefault(); const all = $$('.lg-in', box), idx = all.indexOf(e.target); (all[idx + 1] || all[0]).focus(); all[idx + 1]?.select?.();
    });
    draw();
  }

  // ---------- محرر الأصناف (مثل Excel): صف لكل صنف، يجلب بيانات الصنف تلقائياً ----------
  function initLines(box, hidden, { tax, priceOf, onTotal, items, empty, sales, pick, pickOn = [] }) {
    const pickItems = () => { const f = pick && pick(); return f ? db.items.filter(f) : db.items; };
    let ITEMS = items ? items() : pickItems();
    let rows = []; try { rows = JSON.parse(hidden.value || '[]'); } catch {}
    rows = rows.map(l => ({ ...l, _it: l.item, _vEdited: sales && l.value != null && l.value !== '' && Math.abs(+l.value - (+l.qty || 0) * (+l.price || 0)) > 0.005 }));
    const blank = () => ({ item: '', unit: '', qty: '', price: '', vatRate: tax ? db.settings.vat ?? 14 : 0, whtRate: tax ? 1 : 0, ...(sales ? { count: '', uw: '', value: '', disc: '', pack: '' } : {}) });
    const typesOf = it => varietiesOf(it?.itype);
    const autoVal = l => !l._vEdited ? (+l.qty || 0) * (+l.price || 0) : +l.value || 0;
    rows.push(blank());
    const wh = () => form.elements.namedItem('warehouse')?.value || '';
    const itemOf = n => ITEMS.find(i => i.name === n);
    const stockOf = l => items ? stockLine({ ...l, unit: l.unit || itemOf(l.item)?.unit }) : l;
    const balOf = l => { const sl = stockOf(l); return sl && db.items.some(i => i.name === sl.item) ? num(stockAt(sl.item, wh())) + (sl.item !== l.item ? ` ${itemUnit(sl.item)}` : '') : '—'; };
    const unitOpts = l => { const it = itemOf(l.item); const list = it ? db.units.filter(x => !it.unit || sameFamily(x.name, it.unit)).map(x => x.name).concat(unitOf(it.unit) || !it.unit ? [] : [it.unit]) : db.units.map(u => u.name);
      return list.map(u => `<option ${u === (l.unit || it?.unit) ? 'selected' : ''}>${esc(u)}</option>`).join(''); };
    const cell = (k, v, cls = '', type = 'number') => `<td><input class="lg-in ${cls}" data-k="${k}" type="${type}" ${type === 'number' ? 'step="any" min="0"' : ''} value="${esc(v ?? '')}"></td>`;
    const rowHTML = (l, i) => { const it = itemOf(l.item);
      if (sales) return `<tr data-i="${i}"><td class="lg-n">${i + 1}</td>
        <td class="lg-codein"><input class="lg-in code" data-k="code" autocomplete="off" placeholder="الكود" value="${esc(it?.code || '')}"></td>
        <td class="lg-item"><input class="lg-in" data-k="item" data-dl="dl-lg-items" autocomplete="off" placeholder="اكتب اسم الصنف" value="${esc(l.item)}"></td>
        <td class="lg-itype"><input class="lg-in" data-k="itype" data-dl="dl-lg-itype" autocomplete="off" placeholder="${it && typesOf(it).length ? 'اختر النوع' : '—'}" value="${esc(l.itype || '')}"></td>
        <td><select class="lg-in" data-k="unit">${unitOpts(l)}</select></td>
        ${cell('qty', l.qty)}${cell('count', l.count)}${cell('uw', l.uw)}
        <td class="lg-ro num" data-c="tw"></td>
        ${cell('value', l._vEdited ? l.value : '', 'lg-val')}${cell('disc', l.disc)}${cell('pack', l.pack)}
        <td class="lg-ro num lg-tot" data-c="tot"></td>
        <td><button type="button" class="lg-del" data-del title="حذف الصف">✕</button></td></tr>`;
      return `<tr data-i="${i}"><td class="lg-n">${i + 1}</td>
        <td class="lg-item"><input class="lg-in" data-k="item" data-dl="dl-lg-items" autocomplete="off" placeholder="اكتب اسم أو كود الصنف" value="${esc(l.item)}"></td>
        <td class="lg-ro code" data-c="code">${esc(it?.code || '')}</td>
        <td><select class="lg-in" data-k="unit">${unitOpts(l)}</select></td>
        <td class="lg-ro num" data-c="bal">${it ? balOf(l) : ''}</td>
        ${cell('qty', l.qty)}${cell('price', l.price)}
        ${tax ? cell('vatRate', l.vatRate, 'pct') + cell('whtRate', l.whtRate, 'pct') : ''}
        <td class="lg-ro num" data-c="val"></td>${tax ? '<td class="lg-ro num" data-c="net"></td>' : ''}
        <td><button type="button" class="lg-del" data-del title="حذف الصف">✕</button></td></tr>`; };
    const sync = () => {
      if (sales) {
        const clean = rows.filter(l => l.item).map(l => ({ item: l.item, itype: String(l.itype || '').trim(), unit: l.unit || itemOf(l.item)?.unit || '', qty: +l.qty || 0, count: +l.count || 0, uw: +l.uw || 0, price: +l.price || 0,
          value: +autoVal(l).toFixed(2), disc: +l.disc || 0, pack: +l.pack || 0, vatRate: 0, whtRate: 0 }));
        hidden.value = JSON.stringify(clean);
        $$('tbody tr', box).forEach(tr => { const l = rows[+tr.dataset.i]; if (!l) return; const v = autoVal(l);
          tr.querySelector('[data-c="tw"]').textContent = l.item && lineWeight(l) ? num(lineWeight(l)) : '';
          const vi = tr.querySelector('[data-k="value"]'); if (vi && !l._vEdited && document.activeElement !== vi) { vi.value = ''; vi.placeholder = l.item && v ? nf.format(v) : ''; }
          tr.querySelector('[data-c="tot"]').textContent = l.item ? money(v - (+l.disc || 0) + (+l.pack || 0)) : ''; });
        const t = docTotals({ lines: clean }); onTotal?.(clean.length ? t.total : 0, clean.length ? t : null);
        box.querySelector('tfoot').innerHTML = `<tr><td colspan="5">${clean.length} صنف</td><td class="num"><b>${num(t.qty)}</b></td><td class="num"><b>${num(t.count)}</b></td><td></td><td class="num"><b>${num(t.weight)}</b></td>
          <td class="num"><b>${money(t.sub)}</b></td><td class="num"><b>${money(t.disc)}</b></td><td class="num"><b>${money(t.pack)}</b></td><td class="num"><b>${money(t.total)}</b></td><td></td></tr>`;
        const sm = box.querySelector('.lg-sum');
        if (sm) sm.innerHTML = `<span>القيمة <b>${money(t.sub)}</b></span><span>− الخصم <b>${money(t.disc)}</b></span><span>+ مواد التعبئة <b>${money(t.pack)}</b></span><span class="net">إجمالي القيمة (مدين) <b>${money(t.total)}</b></span>`;
        return;
      }
      const clean = rows.filter(l => l.item).map(l => ({ item: l.item, unit: l.unit || itemOf(l.item)?.unit || '', qty: +l.qty || 0, price: +l.price || 0, vatRate: tax ? +l.vatRate || 0 : 0, whtRate: tax ? +l.whtRate || 0 : 0 }));
      hidden.value = JSON.stringify(clean);
      $$('tbody tr', box).forEach(tr => { const l = rows[+tr.dataset.i]; if (!l) return;
        tr.querySelector('[data-c="val"]').textContent = l.item ? money(lineVal(l)) : '';
        const n = tr.querySelector('[data-c="net"]'); if (n) n.textContent = l.item ? money(lineVal(l) + lineVat(l) - lineWht(l)) : ''; });
      const t = docTotals({ lines: clean }); onTotal?.(clean.length ? t.sub : 0, null);
      box.querySelector('tfoot').innerHTML = `<tr><td colspan="5">${clean.length} صنف · إجمالي الكميات ${num(t.qty)}</td><td colspan="2"></td>${tax ? '<td colspan="2"></td>' : ''}<td class="num"><b>${money(t.sub)}</b></td>${tax ? `<td class="num"><b>${money(t.net)}</b></td>` : ''}<td></td></tr>`;
      const sm = box.querySelector('.lg-sum');
      if (sm) sm.innerHTML = tax ? `<span>القيمة <b>${money(t.sub)}</b></span><span>+ ضريبة القيمة المضافة <b>${money(t.vat)}</b></span><span>− ضريبة الخصم والإضافة <b>${money(t.wht)}</b></span><span class="net">صافي الفاتورة <b>${money(t.net)}</b></span>`
        : `<span class="net">${items ? 'إجمالي الأصناف (قبل الضريبة)' : 'إجمالي الإذن بالتكلفة'} <b>${money(t.sub)}</b></span>`;
    };
    const draw = () => {
      box.innerHTML = `${!ITEMS.length && empty ? `<div class="lg-empty">${esc(empty)}</div>` : ''}${sales ? '<datalist id="dl-lg-itype"></datalist>' : ''}<datalist id="dl-lg-items">${ITEMS.map(i => `<option value="${esc(i.name)}">${esc([i.code, i.category, i.unit].filter(Boolean).join(' · '))}</option>`).join('')}</datalist>
        <div class="lg-wrap"><table class="lines-grid ${sales ? 'sales-grid' : ''}"><thead><tr>${sales
          ? '<th>#</th><th>كود الصنف</th><th>اسم الصنف</th><th>نوع الصنف</th><th>الوحدة</th><th>الكمية</th><th>العدد</th><th>وزن الوحدة</th><th>إجمالي الوزن</th><th>القيمة</th><th>الخصم</th><th>قيمة مواد التعبئة</th><th>إجمالي القيمة (مدين)</th><th></th>'
          : `<th>#</th><th>الصنف</th><th>الكود</th><th>الوحدة</th><th>الرصيد</th><th>الكمية</th><th>السعر</th>${tax ? '<th>ض.ق.م %</th><th>خصم وإضافة %</th>' : ''}<th>القيمة</th>${tax ? '<th>الصافي</th>' : ''}<th></th>`}</tr></thead>
        <tbody>${rows.map(rowHTML).join('')}</tbody><tfoot></tfoot></table></div>
        <div class="lg-bar"><button type="button" class="btn ghost" data-addline>＋ صنف جديد</button><span class="hint">Enter للانتقال للخانة التالية — الصف الجديد يُضاف تلقائياً</span><div class="lg-sum"></div></div>`;
      sync();
    };
    const addRow = () => { rows.push(blank()); const tb = box.querySelector('tbody'); tb.insertAdjacentHTML('beforeend', rowHTML(rows.at(-1), rows.length - 1)); };
    const findItem = v => { const q = String(v || '').trim(); return ITEMS.find(i => i.name === q) || ITEMS.find(i => i.code && i.code.toLowerCase() === q.toLowerCase()); };
    box.addEventListener('input', e => {
      const inp = e.target.closest('[data-k]'), tr = e.target.closest('tr[data-i]'); if (!inp || !tr) return;
      const i = +tr.dataset.i, k = inp.dataset.k, l = rows[i];
      if (sales) {
        if (k === 'value') { l.value = inp.value; l._vEdited = inp.value !== ''; }
        else if (k !== 'code') l[k] = inp.value;
        if (k === 'item' || k === 'code') {
          const it = k === 'code' ? ITEMS.find(x => x.code && String(x.code).toLowerCase() === inp.value.trim().toLowerCase()) : findItem(inp.value);
          if (it) { const changedIt = l._it !== it.name; l.item = it.name; l._it = it.name;
            if (changedIt || !l.unit) l.unit = it.unit || ''; if (changedIt || !+l.price) l.price = priceOf(it); if (changedIt || l.uw === '') l.uw = +it.weight || '';
            if (k === 'code') tr.querySelector('[data-k="item"]').value = it.name; else { if (inp.value !== it.name) inp.value = it.name; tr.querySelector('[data-k="code"]').value = it.code || ''; }
            const ts = typesOf(it); if (changedIt) l.itype = ts[0] || ''; const ti = tr.querySelector('[data-k="itype"]'); ti.value = l.itype || ''; ti.placeholder = ts.length ? 'اختر النوع' : '—';
            tr.querySelector('[data-k="unit"]').innerHTML = unitOpts(l); tr.querySelector('[data-k="uw"]').value = l.uw; }
          else if (k === 'item') { l.item = inp.value; }
          if (i === rows.length - 1 && (l.item || inp.value)) addRow();
        }
        sync(); return;
      }
      l[k] = inp.value;
      if (k === 'item') {
        const it = findItem(inp.value);
        if (it) { if (inp.value !== it.name) inp.value = it.name; const changedIt = l._it !== it.name; l.item = it.name; if (changedIt || !l.unit) l.unit = it.unit || ''; if (changedIt || !+l.price) l.price = priceOf(it); l._it = it.name;
          tr.querySelector('[data-k="unit"]').innerHTML = unitOpts(l); tr.querySelector('[data-k="price"]').value = l.price;
          tr.querySelector('[data-c="code"]').textContent = it.code || ''; tr.querySelector('[data-c="bal"]').textContent = balOf(l); }
        else { tr.querySelector('[data-c="code"]').textContent = ''; tr.querySelector('[data-c="bal"]').textContent = ''; }
        if (i === rows.length - 1 && inp.value) addRow();
      }
      sync();
    });
    box.addEventListener('change', e => { const inp = e.target.closest('[data-k="unit"]'), tr = e.target.closest('tr[data-i]'); if (inp && tr) { rows[+tr.dataset.i].unit = inp.value; sync(); } });
    box.addEventListener('click', e => {
      if (e.target.closest('[data-addline]')) { addRow(); box.querySelector('tbody tr:last-child [data-k="item"]').focus(); return; }
      const del = e.target.closest('[data-del]'); if (!del) return;
      rows.splice(+del.closest('tr').dataset.i, 1); if (!rows.length || rows.at(-1).item) rows.push(blank()); draw();
    });
    // Enter ينقل للخانة التالية بدل حفظ النموذج
    box.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !e.target.matches('.lg-in')) return;
      e.preventDefault();
      const all = $$('.lg-in', box), idx = all.indexOf(e.target);
      (all[idx + 1] || all[0]).focus(); all[idx + 1]?.select?.();
    });
    // تحديث عمود الرصيد عند تغيير المخزن
    if (!sales) form.elements.namedItem('warehouse')?.addEventListener('change', () => $$('tbody tr', box).forEach(tr => { const l = rows[+tr.dataset.i]; if (l?.item) tr.querySelector('[data-c="bal"]').textContent = balOf(l); }));
    // قائمة أنواع الصنف تُبنى عند الوقوف على الخانة حسب صنف السطر
    if (sales) box.addEventListener('focusin', e => { const inp = e.target.closest('[data-k="itype"]'); if (!inp) return; const l = rows[+inp.closest('tr').dataset.i];
      const dl = box.querySelector('#dl-lg-itype'); if (dl) dl.innerHTML = typesOf(itemOf(l?.item)).map(x => `<option value="${esc(x)}"></option>`).join(''); }, true);
    // فاتورة المبيعات: أصناف نوع الحساب المختار فقط
    pickOn.forEach(k => form.elements.namedItem(k)?.addEventListener('change', () => { ITEMS = pickItems(); const dl = box.querySelector('#dl-lg-items');
      if (dl) dl.innerHTML = ITEMS.map(i => `<option value="${esc(i.name)}">${esc([i.code, i.category, i.unit].filter(Boolean).join(' · '))}</option>`).join(''); }));
    if (sales && items) form.elements.namedItem('account')?.addEventListener('change', () => { ITEMS = items(); const dl = box.querySelector('#dl-lg-items');
      if (dl) dl.innerHTML = ITEMS.map(i => `<option value="${esc(i.name)}">${esc([i.code, i.category, i.unit].filter(Boolean).join(' · '))}</option>`).join(''); });
    draw();
  }

  // ---------- الكشوف (عميل، مورد، صنف) ----------
  function statementHTML(opening, rows, { inc = 'مدين', dec = 'دائن', fmt = money, summary = [] } = {}) {
    let bal = opening;
    rows.sort(byDate);
    const body = rows.map(r => { bal += (r.a || 0) - (r.b || 0); return `<tr>
      <td>${esc(r.date)}</td><td class="code">${r.go ? `<button type="button" class="link-btn" data-go="${r.go}" data-q="${esc(r.ref)}">${esc(r.ref)}</button>` : esc(r.ref)}</td><td>${esc(r.desc)}</td>
      <td class="num">${r.a ? fmt(r.a) : '—'}</td><td class="num">${r.b ? fmt(r.b) : '—'}</td><td class="num ${bal < 0 ? 'neg' : ''}"><b>${fmt(bal)}</b></td></tr>`; }).join('');
    return `${summary.length ? `<div class="summary" style="margin:-20px -20px 16px">${summary.map(([l, v]) => `<div><span>${l}</span><b>${v}</b></div>`).join('')}</div>` : ''}
      <div class="table-wrap"><table class="stmt">
        <thead><tr><th>التاريخ</th><th>المستند</th><th>البيان</th><th>${inc}</th><th>${dec}</th><th>الرصيد</th></tr></thead>
        <tbody><tr class="opening"><td colspan="5">رصيد أول المدة</td><td class="num">${fmt(opening)}</td></tr>${body || '<tr><td colspan="6" class="empty">لا توجد حركات</td></tr>'}
        <tr class="closing"><td colspan="3">الإجمالي / الرصيد الختامي</td><td class="num">${fmt(sum(rows, r => r.a))}</td><td class="num">${fmt(sum(rows, r => r.b))}</td><td class="num">${fmt(bal)}</td></tr></tbody>
      </table></div>`;
  }
  const bindStatementLinks = () => $$('#modalBody [data-go]').forEach(b => b.onclick = () => { closeModal(); goTo(b.dataset.go, b.dataset.q); });

  function customerStatement(c) {
    const rows = [
      ...eff('salesInvoices').filter(i => i.customer === c.name && docOnAcc(i, recAcc(SYS.customers, c))).map(i => ({ date: i.date, ref: i.no, desc: 'فاتورة مبيعات', a: invTotal(i), go: 'salesInvoices' })),
      ...eff('salesReturns').filter(i => i.customer === c.name && docOnAcc(i, recAcc(SYS.customers, c))).map(i => ({ date: i.date, ref: i.no, desc: `مرتجع — ${i.reason}`, b: +i.amount, go: 'salesReturns' })),
      ...eff('receipts').filter(i => i.party === c.name && isPartyDoc(i, 'c') && docOnAcc(i, recAcc(SYS.customers, c))).map(i => ({ date: i.date, ref: i.no, desc: i.desc || 'سند قبض', b: +i.amount, go: 'receipts' })),
    ];
    openInfo(`كشف حساب العميل: ${c.name}`, statementHTML(custOpen(c), rows, { summary: [['التصنيف', esc(c.category || '—')], ['حد الائتمان', money(c.limit)], ['الرصيد الحالي', money(custBal(c.name, recAcc(SYS.customers, c)))], ['المتاح', money(Math.max(0, c.limit - custBal(c.name)))]] }));
    bindStatementLinks();
  }
  function supplierStatement(s) {
    const rows = [
      ...eff('purchaseInvoices').filter(i => i.supplier === s.name && docOnAcc(i, recAcc(SYS.suppliers, s))).map(i => ({ date: i.date, ref: i.no, desc: 'فاتورة مشتريات', a: +i.amount, go: 'purchaseInvoices' })),
      ...eff('purchaseReturns').filter(i => i.supplier === s.name && docOnAcc(i, recAcc(SYS.suppliers, s))).map(i => ({ date: i.date, ref: i.no, desc: `مرتجع — ${i.reason}`, b: +i.amount, go: 'purchaseReturns' })),
      ...eff('supplierAccruals').filter(i => i.party === s.name && docOnAcc(i, recAcc(SYS.suppliers, s))).map(i => ({ date: i.date, ref: i.no, desc: i.store ? `استلام ${acc(accCode(i.store))?.name || ''}${i.docNo ? ' — مستند ' + i.docNo : ''}` : `استحقاق ${periodText(i)}${i.desc ? ' — ' + i.desc : ''}`, a: +i.amount, go: 'supplierAccruals' })),
      ...eff('stockIn').filter(i => i.supplier === s.name).map(i => ({ date: i.date, ref: i.no, desc: `إذن إضافة — ${linesSummary(i)}`, a: docTotals(i).net, go: 'stockIn' })),
      ...eff('payments').filter(i => i.party === s.name && isPartyDoc(i, 's') && docOnAcc(i, recAcc(SYS.suppliers, s))).map(i => ({ date: i.date, ref: i.no, desc: i.desc || 'سند صرف', b: +i.amount, go: 'payments' })),
    ];
    openInfo(`كشف حساب المورد: ${s.name}`, statementHTML(suppOpen(s), rows, { inc: 'دائن (له)', dec: 'مدين (منه)', summary: [['التصنيف', esc(s.category || '—')], ['المستحق له', money(suppBal(s.name, recAcc(SYS.suppliers, s)))], ['عدد الفواتير', rows.filter(r => r.a).length], ['المسدد', money(sum(rows, r => r.b))]] }));
    bindStatementLinks();
  }
  function itemCard(it) {
    const rows = [
      ...stockRows('stockIn').filter(r => r.item === it.name).map(r => ({ date: r.date, ref: r.no, desc: `إضافة إلى ${r.warehouse} — من ${r.doc.supplier || r.doc.source || ''}${qtyNote(r)}`, a: baseQty(r), go: 'stockIn' })),
      ...eff('openingBalances').filter(r => r.otype === OPEN_TYPES[1] && r.item === it.name).map(r => ({ date: r.date, ref: r.no, desc: `رصيد افتتاحي — ${r.warehouse}`, a: baseQty(r), go: 'openingBalances' })),
      ...stockRows('salesInvoices').filter(r => r.item === it.name).map(r => ({ date: r.date, ref: r.no, desc: `بيع من ${r.warehouse} — ${r.doc.customer}${qtyNote(r)}`, b: baseQty(r), go: 'salesInvoices' })),
      ...stockRows('salesReturns').filter(r => r.item === it.name).map(r => ({ date: r.date, ref: r.no, desc: `مردودات إلى ${r.warehouse} — ${r.doc.customer}${qtyNote(r)}`, a: baseQty(r), go: 'salesReturns' })),
      ...stockRows('stockOut').filter(r => r.item === it.name).map(r => ({ date: r.date, ref: r.no, desc: `صرف من ${r.warehouse} — إلى ${r.doc.costCenter || r.doc.to || ''}${qtyNote(r)}`, b: baseQty(r), go: 'stockOut' })),
      ...eff('transfers').filter(r => r.item === it.name).map(r => ({ date: r.date, ref: r.no, desc: `تحويل من ${r.from} إلى ${r.to} (${num(r.qty)} ${r.unit || it.unit || ''})`, go: 'transfers' })),
    ];
    const whs = db.warehouses.map(w => [w.name, stockAt(it.name, w.name)]).filter(([, q]) => q);
    openInfo(`كارت الصنف: ${it.name}`, statementHTML(+it.opening || 0, rows, { inc: 'وارد', dec: 'منصرف', fmt: num,
      summary: [['الرصيد الحالي', `${num(itemQty(it.name))} ${esc(it.unit)}`], ['حد الطلب', num(it.min)], ['قيمة الرصيد', money(itemQty(it.name) * it.cost)], ['التوزيع', whs.map(([w, q]) => `${esc(w)}: ${num(q)}`).join('<br>') || '—']] }));
    bindStatementLinks();
  }

  // ---------- دفتر اليومية ----------
  function renderJournal() {
    const q = state.q.trim().toLowerCase();
    const name = c => acc(c) ? accLabel(acc(c)) : c;
    let entries = glEntries().filter(e => !q || [e.no, e.desc, e.src, e.date, ...e.lines.map(l => name(l.acc))].some(x => String(x).toLowerCase().includes(q)));
    if (state.filter) entries = entries.filter(e => e.src === state.filter);
    const srcs = [...new Set(glEntries().map(e => e.src))];
    const dr = sum(entries, e => sum(e.lines, l => l.dr)), cr = sum(entries, e => sum(e.lines, l => l.cr));
    const noSearch = mod => ['payroll', 'dailyLabor', 'advances'].includes(mod);
    const pend = db.journal.filter(r => !isEff(r) && r.appr?.status !== 'rejected');

    content.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>دفتر اليومية العامة</h3><div class="sub">${glEntries().length} قيد — ${db.journal.length} يدوي و ${glEntries().length - db.journal.length} متولد من المستندات</div></div>
          <div class="spacer"></div>
          <div class="toolbar">
            <input class="input" id="tblSearch" type="search" placeholder="بحث برقم القيد أو الحساب..." value="${esc(state.q)}">
            <select class="input" id="tblFilter"><option value="">المصدر: الكل</option>${srcs.map(s => `<option ${s === state.filter ? 'selected' : ''}>${s}</option>`).join('')}</select>
            <button class="btn ghost" id="exportBtn">${icons.export}تصدير</button>
            <button class="btn ghost danger-ghost" id="jClear" title="حذف كل القيود اليدوية">${icons.del}تفريغ القيود اليدوية</button>
            <button class="btn primary" id="addBtn">${icons.plus}قيد يدوي</button>
          </div>
        </div>
        <div class="summary">
          <div><span>عدد القيود</span><b>${entries.length}</b></div>
          <div><span>إجمالي المدين</span><b>${money(dr)}</b></div>
          <div><span>إجمالي الدائن</span><b>${money(cr)}</b></div>
          <div><span>التوازن</span><b>${Math.abs(dr - cr) < 0.01 ? '<span class="pill green">متوازن</span>' : `<span class="pill red">${money(dr - cr)}</span>`}</b></div>
        </div>
        ${pend.length ? `<div class="af-note warn" style="margin:10px 14px 0">قيود يدوية لم تُرحّل بعد: ${pend.map(r => `<b>${esc(r.no)}</b> (${esc(apprText('journal', r))}${canApprove('journal', r) ? ` <button type="button" class="link-btn" data-japr="${r.id}">اعتماد</button>` : ''} · <button type="button" class="link-btn" data-edit="${r.id}">فتح</button>)`).join('، ')}</div>` : ''}
        <div class="table-wrap"><table class="journal">
          <thead><tr><th>رقم القيد</th><th>التاريخ</th><th>البيان / الحساب</th><th>المصدر</th><th>مدين</th><th>دائن</th><th></th></tr></thead>
          <tbody>${entries.slice(0, 200).map(e => `
            <tr class="entry-head"><td class="code">${esc(e.no)}</td><td>${esc(e.date)}</td><td>${esc(e.desc)}</td><td><span class="src ${e.manual ? 'manual' : ''}">${e.src}</span></td><td></td><td></td>
              <td><div class="row-actions">${e.manual
                ? `<button data-edit="${e.id}" title="تعديل">${icons.edit}</button><button class="del" data-del="${e.id}" title="حذف">${icons.del}</button>`
                : `<button data-src="${e.module}" data-q="${esc(noSearch(e.module) ? '' : e.no)}" title="فتح المستند الأصلي">${icons.open}</button>`}</div></td></tr>
            ${e.lines.map((l, i) => `<tr class="entry-line ${l.cr ? 'cr' : ''} ${i === e.lines.length - 1 ? 'last' : ''}"><td></td><td></td>
              <td class="acc">${l.cr ? 'إلى حـ/ ' : 'من حـ/ '}<button class="link-btn" data-ledger="${esc(l.acc)}">${esc(name(l.acc))}</button>${l.note ? ` <span class="hint">— ${esc(l.note)}</span>` : ''}</td><td></td>
              <td class="num">${l.dr ? money(l.dr) : ''}</td><td class="num">${l.cr ? money(l.cr) : ''}</td><td></td></tr>`).join('')}`).join('')
            || '<tr><td colspan="7" class="empty">لا توجد قيود مطابقة</td></tr>'}</tbody>
        </table></div>
      </div>`;
    $('#tblSearch').addEventListener('input', e => { state.q = e.target.value; renderJournal(); const el = $('#tblSearch'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
    $('#tblFilter').addEventListener('change', e => { state.filter = e.target.value; renderJournal(); });
    $('#addBtn').onclick = () => openRecordForm('journal');
    $('#jClear') && ($('#jClear').onclick = () => clearScreen('journal'));
    $('#exportBtn').onclick = () => downloadCSV('journal', ['رقم القيد', 'التاريخ', 'البيان', 'المصدر', 'الحساب', 'مدين', 'دائن', 'بيان السطر'],
      entries.flatMap(e => e.lines.map(l => [e.no, e.date, e.desc, e.src, name(l.acc), l.dr, l.cr, l.note || ''])));
    $$('[data-edit]', content).forEach(b => b.onclick = () => openRecordForm('journal', db.journal.find(r => r.id === b.dataset.edit)));
    $$('[data-del]', content).forEach(b => b.onclick = () => deleteRecord('journal', db.journal.find(r => r.id === b.dataset.del)));
    $$('[data-src]', content).forEach(b => b.onclick = () => goTo(b.dataset.src, b.dataset.q));
    $$('[data-ledger]', content).forEach(b => b.onclick = () => openLedger(b.dataset.ledger));
    $$('[data-japr]', content).forEach(b => b.onclick = () => { if (decide('journal', b.dataset.japr, true)) { save(); renderNav(); renderJournal(); toast(afterDecideMsg('journal', b.dataset.japr)); } });
  }

  // ---------- كشف الحساب (دفتر الأستاذ) ----------
  function renderLedger() {
    const code = acc(state.ledger) ? state.ledger : '1211';
    const a = acc(code), set = subtree(code), deb = isDebitNature(code);
    const opening = sum(db.accounts.filter(x => set.has(x.code)), x => +x.balance);
    const rows = glEntries().map(e => {
      const ls = e.lines.filter(l => set.has(l.acc));
      if (!ls.length) return null;
      const d = sum(ls, l => l.dr), c = sum(ls, l => l.cr);
      const other = e.lines.filter(l => !set.has(l.acc)).map(l => acc(l.acc)?.name || l.acc);
      return { date: e.date, ref: e.no, desc: `${e.desc}${other.length ? ` (${[...new Set(other)].join('، ')})` : ''}`, a: deb ? d : c, b: deb ? c : d, go: e.manual ? 'journal' : e.module };
    }).filter(Boolean);
    const sorted = db.accounts.slice().sort(codeSort);
    content.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>كشف حساب: ${esc(accLabel(a))}</h3><div class="sub">${accType(code)} · طبيعته ${nature(code)}${hasChildren(code) ? ` · يشمل ${set.size - 1} حساب فرعي` : ''}</div></div>
          <div class="spacer"></div>
          <div class="ledger-pick">
            <select class="input" id="ledgerPick">${sorted.map(x => `<option value="${esc(x.code)}" ${x.code === code ? 'selected' : ''}>${'  '.repeat(depth(x))}${esc(accLabel(x))}</option>`).join('')}</select>
            <button class="btn ghost" data-print-page>${icons.print}طباعة</button>
          </div>
        </div>
        <div class="card-body">${statementHTML(opening, rows, {
          inc: deb ? 'مدين' : 'دائن', dec: deb ? 'دائن' : 'مدين',
          summary: [['الرصيد الافتتاحي', money(opening)], ['عدد الحركات', rows.length], ['إجمالي الحركة', money(sum(rows, r => r.a + r.b))], ['الرصيد الحالي', money(rollup(code))]] })}</div>
      </div>`;
    $('#ledgerPick').onchange = e => { state.ledger = e.target.value; renderLedger(); };
    $$('[data-go]', content).forEach(b => b.onclick = () => goTo(b.dataset.go, ['payroll', 'dailyLabor', 'advances'].includes(b.dataset.go) ? '' : b.dataset.q));
  }

  // ---------- أرصدة المخازن ----------
  function renderStockBalances() {
    const rows = [];
    db.items.forEach(i => db.warehouses.forEach(w => { const q = stockAt(i.name, w.name); if (q) rows.push({ i, w: w.name, q }); }));
    const f = state.filter;
    const shown = rows.filter(r => (!f || r.w === f) && (!state.q || r.i.name.includes(state.q) || r.i.code.includes(state.q)));
    content.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>أرصدة الأصناف بالمخازن</h3><div class="sub">محسوبة من أول المدة وأذون الإضافة والصرف والتحويلات</div></div>
          <div class="spacer"></div>
          <div class="toolbar">
            <input class="input" id="tblSearch" type="search" placeholder="بحث عن صنف..." value="${esc(state.q)}">
            <select class="input" id="tblFilter"><option value="">المخزن: الكل</option>${db.warehouses.map(w => `<option ${w.name === f ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>كود الصنف</th><th>الصنف</th><th>المخزن</th><th>الرصيد</th><th>الوحدة</th><th>التكلفة</th><th>القيمة</th><th></th></tr></thead>
          <tbody>${shown.map(r => `<tr><td class="code">${esc(r.i.code)}</td><td>${esc(r.i.name)}</td><td>${esc(r.w)}</td>
            <td class="num">${r.q < 0 ? `<span class="pill red">${num(r.q)}</span>` : `<b>${num(r.q)}</b>`}</td><td>${esc(r.i.unit)}</td>
            <td class="num">${money(r.i.cost)}</td><td class="num">${money(r.q * r.i.cost)}</td>
            <td><div class="row-actions"><button data-card="${r.i.id}" title="كارت الصنف">${icons.list}</button></div></td></tr>`).join('') || '<tr><td colspan="8" class="empty">لا توجد أرصدة</td></tr>'}</tbody>
        </table></div>
        <div class="table-foot"><span>${shown.length} رصيد</span><span>إجمالي القيمة: <b>${money(sum(shown, r => r.q * r.i.cost))}</b></span></div>
      </div>`;
    $('#tblSearch').addEventListener('input', e => { state.q = e.target.value; renderStockBalances(); const el = $('#tblSearch'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
    $('#tblFilter').addEventListener('change', e => { state.filter = e.target.value; renderStockBalances(); });
    $$('[data-card]', content).forEach(b => b.onclick = () => itemCard(db.items.find(i => i.id === b.dataset.card)));
  }

  // ---------- شجرة الحسابات ----------
  function renderTree() {
    const q = state.q.trim().toLowerCase();
    const matches = new Set();
    if (q) db.accounts.forEach(a => {
      if (a.code.includes(q) || a.name.toLowerCase().includes(q)) { let p = a; while (p) { matches.add(p.code); p = acc(p.parent); } }
    });
    const mark = s => q ? esc(s).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<mark>$&</mark>') : esc(s);
    const mv = movements();

    const rows = [];
    const walk = (parent, d) => childrenOf(parent).forEach(a => {
      if (q && !matches.has(a.code)) return;
      const kids = hasChildren(a.code);
      const closed = !q && state.collapsed.has(a.code);
      const own = mv[a.code];
      rows.push(`<tr class="lvl-${Math.min(d, 2)}">
        <td class="code">${mark(a.code)}</td>
        <td><div class="tree-name" style="padding-inline-start:${d * 22}px">
          ${kids ? `<button class="caret ${closed ? 'closed' : ''}" data-caret="${esc(a.code)}" aria-label="طي/توسيع">${icons.caret}</button>` : '<span class="leaf-dot"></span>'}
          <span>${mark(a.name)}</span></div></td>
        <td>${kids ? '<span class="pill">رئيسي</span>' : '<span class="pill green">فرعي</span>'}</td>
        <td>${accType(a.code)}</td>
        <td>${nature(a.code)}</td>
        <td class="num">${kids ? '' : money(a.balance)}</td>
        <td class="num">${own ? `<span class="hint">${num(own.dr)} / ${num(own.cr)}</span>` : ''}</td>
        <td class="num">${money(rollup(a.code))}</td>
        <td><div class="row-actions">
          <button data-ledger="${esc(a.code)}" title="كشف حساب">${icons.list}</button>
          <button data-addchild="${esc(a.code)}" title="إضافة حساب فرعي">${icons.plus}</button>
          <button data-editacc="${a.id}" title="تعديل">${icons.edit}</button>
          <button class="del" data-delacc="${a.id}" title="حذف">${icons.del}</button>
        </div></td></tr>`);
      if (kids && !closed) walk(a.code, d + 1);
    });
    walk(null, 0);

    content.innerHTML = `
      <div class="kpis">
        ${['1', '2', '3', '4'].map((c, i) => { const a = acc(c); return a ? kpi(a.name, money(rollup(c)), `${nature(c)} · ${childrenOf(c).length} مجموعات`, '', ['', 'amber', 'red', 'green'][i], icons[['wallet', 'ledger', 'down', 'trend'][i]]) : ''; }).join('')}
      </div>
      <div class="card">
        <div class="card-head">
          <div><h3>دليل الحسابات</h3><div class="sub">${db.accounts.length} حساب · ${leafAccounts().length} حساب فرعي</div></div>
          <div class="spacer"></div>
          <div class="toolbar">
            <input class="input" id="tblSearch" type="search" placeholder="بحث بالكود أو الاسم..." value="${esc(state.q)}">
            <button class="btn ghost" id="expandAll">توسيع الكل</button>
            <button class="btn ghost" id="collapseAll">طي الكل</button>
            <button class="btn ghost" id="exportBtn">${icons.export}تصدير</button>
            <button class="btn primary admin-only" id="addBtn">${icons.plus}حساب جديد</button>
          </div>
        </div>
        <div class="table-wrap"><table class="tree">
          <thead><tr><th>الكود</th><th>اسم الحساب</th><th>النوع</th><th>التصنيف</th><th>الطبيعة</th><th>الافتتاحي</th><th>الحركة مدين / دائن</th><th>الرصيد الحالي</th><th></th></tr></thead>
          <tbody>${rows.join('') || '<tr><td colspan="9" class="empty">لا توجد حسابات مطابقة</td></tr>'}</tbody>
        </table></div>
      </div>`;

    $('#tblSearch').addEventListener('input', e => { state.q = e.target.value; renderTree(); const el = $('#tblSearch'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
    $('#expandAll').onclick = () => { state.collapsed.clear(); renderTree(); };
    $('#collapseAll').onclick = () => { db.accounts.forEach(a => { if (a.parent && hasChildren(a.code)) state.collapsed.add(a.code); }); renderTree(); };
    $('#addBtn').onclick = () => openAccountForm();
    $('#exportBtn').onclick = () => {
      const out = [];
      const w = p => childrenOf(p).forEach(a => { out.push([a.code, a.name, a.parent ?? '', hasChildren(a.code) ? 'رئيسي' : 'فرعي', accType(a.code), nature(a.code), a.balance, rollup(a.code)]); w(a.code); });
      w(null);
      downloadCSV('chart-of-accounts', ['الكود', 'اسم الحساب', 'الحساب الأب', 'النوع', 'التصنيف', 'الطبيعة', 'الافتتاحي', 'الرصيد الحالي'], out);
    };
    $$('[data-caret]', content).forEach(b => b.onclick = () => { const c = b.dataset.caret; state.collapsed.has(c) ? state.collapsed.delete(c) : state.collapsed.add(c); renderTree(); });
    $$('[data-ledger]', content).forEach(b => b.onclick = () => openLedger(b.dataset.ledger));
    $$('[data-addchild]', content).forEach(b => b.onclick = () => openAccountForm(null, b.dataset.addchild));
    $$('[data-editacc]', content).forEach(b => b.onclick = () => openAccountForm(db.accounts.find(a => a.id === b.dataset.editacc)));
    $$('[data-delacc]', content).forEach(b => b.onclick = () => {
      if (!can('accounts', 'd')) return denied();
      const a = db.accounts.find(x => x.id === b.dataset.delacc);
      if (hasChildren(a.code)) return toast('لا يمكن حذف حساب له حسابات فرعية');
      if (movements()[a.code]) return toast('لا يمكن حذف حساب عليه حركات مرحّلة');
      if (db.cashboxes.some(x => x.accountNo === a.code)) return toast('الحساب مرتبط بخزينة / بنك');
      if (+a.balance && !confirm('الحساب له رصيد افتتاحي، وحذفه سيُخل بتوازن الميزان. متابعة؟')) return;
      if (!confirm(`حذف الحساب ${accLabel(a)}؟`)) return;
      db.accounts = db.accounts.filter(x => x.id !== a.id);
      save(); renderTree(); toast('تم حذف الحساب');
    });
  }

  function suggestCode(parent) {
    const kids = childrenOf(parent);
    if (!parent) return String(Math.max(0, ...kids.map(k => +k.code)) + 1);
    if (!kids.length) return parent + '1';
    return String(Math.max(...kids.map(k => +k.code)) + 1);
  }

  const accRefFields = [['journal', 'debit'], ['journal', 'credit'], ['receipts', 'account'], ['payments', 'account'], ['purchaseInvoices', 'account'], ['purchaseReturns', 'account']];
  function openAccountForm(a, parent) {
    if (!can('accounts', a ? 'e' : 'a')) return denied();
    const p = a ? a.parent : parent ?? null;
    const isLeaf = !a || !hasChildren(a.code);
    const fields = [
      { key: 'parent', label: 'الحساب الأب', input: 'select', optional: true, allowEmpty: '— حساب رئيسي (مستوى أول) —', full: true,
        options: () => db.accounts.filter(x => !a || x.code !== a.code).sort(codeSort).map(x => [x.code, accLabel(x)]) },
      { key: 'code', label: 'كود الحساب', input: 'text' },
      { key: 'name', label: 'اسم الحساب', input: 'text' },
      { key: 'nature', label: 'طبيعة الحساب', input: 'select', optional: true, allowEmpty: '— تلقائي حسب نوع الحساب —', options: () => ['مدين', 'دائن'] },
      ...(isLeaf ? [{ key: 'balDr', label: 'الرصيد الافتتاحي — مدين', input: 'number', optional: true }, { key: 'balCr', label: 'الرصيد الافتتاحي — دائن', input: 'number', optional: true }] : []),
    ];
    // الرصيد يُخزن موجباً في جانب طبيعة الحساب، ويُعرض في خانة المدين أو الدائن
    const natDebit = (code, natureVal, parent) => { if (natureVal) return natureVal === 'مدين'; for (let x = acc(parent); x; x = acc(x.parent)) if (x.nature) return x.nature === 'مدين'; return /^[13]/.test(code); };
    const b0 = a ? +a.balance || 0 : 0, d0 = a ? natDebit(a.code, a.nature, a.parent) : true;
    const balDr = d0 ? Math.max(b0, 0) : Math.max(-b0, 0), balCr = d0 ? Math.max(-b0, 0) : Math.max(b0, 0);
    openModal(a ? 'تعديل حساب' : 'إضافة حساب', fields,
      a ? { ...a, parent: a.parent ?? '', balDr: balDr || '', balCr: balCr || '' } : { parent: p ?? '', code: suggestCode(p), name: '', balDr: '', balCr: '' },
      data => {
        const bd = +data.balDr || 0, bc = +data.balCr || 0;
        if (bd < 0 || bc < 0) { toast('الرصيد لا يكون سالباً'); return false; }
        if (bd && bc) { toast('اكتب الرصيد الافتتاحي في خانة المدين أو الدائن وليس الاثنين'); return false; }
        data.balance = natDebit(data.code.trim(), data.nature, data.parent || null) ? bd - bc : bc - bd;
        if (a) { a = db.accounts.find(x => x.id === a.id); if (!a) { toast('هذا الحساب حذفه مستخدم آخر'); return; } }
        const code = data.code.trim(), par = data.parent || null;
        if (db.accounts.some(x => x.code === code && x !== a)) { toast('كود الحساب مستخدم من قبل'); return false; }
        if (a && par) { let x = par; while (x) { if (x === a.code) { toast('لا يمكن جعل الحساب تابعاً لأحد فروعه'); return false; } x = acc(x)?.parent; } }
        if (par && movements()[par] && !hasChildren(par) && !confirm('الحساب الأب عليه حركات مرحّلة وسيصبح حساباً رئيسياً. متابعة؟')) return false;
        if (a) {
          const old = a.code;
          if (old !== code && movements()[old]) { toast('لا يمكن تغيير كود حساب عليه حركات مرحّلة من المستندات'); return false; }
          Object.assign(a, { code, name: data.name.trim(), parent: par, nature: data.nature || '', balance: isLeaf ? +data.balance || 0 : a.balance });
          if (old !== code) {
            db.accounts.forEach(x => { if (x.parent === old) x.parent = code; });
            db.cashboxes.forEach(b => { if (b.accountNo === old) b.accountNo = code; });
          }
          accRefFields.forEach(([t, f]) => db[t].forEach(r => { if (accCode(r[f]) === old) r[f] = accLabel(a); }));
        } else {
          db.accounts.push({ id: genId(), code, name: data.name.trim(), parent: par, nature: data.nature || '', balance: +data.balance || 0 });
          if (par) state.collapsed.delete(par);
        }
        save(); renderTree(); toast(a ? 'تم حفظ الحساب' : 'تمت إضافة الحساب');
      });
  }

  // ---------- القوائم المالية ----------
  const STATEMENTS = { income: 'قائمة الدخل', balance: 'قائمة المركز المالي', tb: 'ميزان المراجعة بالأرصدة' };
  function renderReports(only) {
    const section = rootCode => childrenOf(rootCode).map(g => `
      <tr class="section"><td>${esc(g.name)}</td><td class="num">${money(rollup(g.code))}</td></tr>
      ${childrenOf(g.code).map(a => `<tr><td style="padding-inline-start:32px"><button class="link-btn" data-ledger="${esc(a.code)}">${esc(a.code)} - ${esc(a.name)}</button></td><td class="num">${money(rollup(a.code))}</td></tr>`).join('')}`).join('');
    const rev = rollup('4'), exp = rollup('3'), net = rev - exp;
    // ميزان المراجعة: كل حساب له رصيد خاص به
    const tb = db.accounts.filter(a => !hasChildren(a.code) || Math.abs(ownBal(a)) > 0.001).sort(codeSort)
      .map(a => { const b = ownBal(a); const d = isDebitNature(a.code) ? b : -b; return { a, d: d > 0 ? d : 0, c: d < 0 ? -d : 0 }; });
    const dr = sum(tb, r => r.d), cr = sum(tb, r => r.c);
    const dt = new Date().toLocaleDateString((window.UI_LOCALE || 'ar-EG'));

    const show = k => !only || only === k;
    content.innerHTML = `
      <div class="toolbar" style="margin-bottom:16px;justify-content:flex-end"><button class="btn ghost" data-print-page>${icons.print}طباعة</button></div>
      <div class="grid-2" style="grid-template-columns:${only ? 'minmax(0, 760px)' : '1fr 1fr'}">
        ${show('income') ? `<div class="card">
          <div class="card-head"><div><h3>قائمة الدخل</h3><div class="sub">عن الفترة حتى ${dt}</div></div></div>
          <table class="report"><tbody>
            <tr class="total"><td>الإيرادات</td><td class="num">${money(rev)}</td></tr>${section('4')}
            <tr class="total"><td>المصروفات</td><td class="num">${money(exp)}</td></tr>${section('3')}
            <tr class="total"><td>صافي ${net >= 0 ? 'الربح' : 'الخسارة'}</td><td class="num ${net >= 0 ? 'up' : 'down'}">${money(Math.abs(net))}</td></tr>
          </tbody></table>
        </div>` : ''}
        ${show('balance') ? `<div class="card">
          <div class="card-head"><div><h3>قائمة المركز المالي</h3><div class="sub">في ${dt}</div></div></div>
          <table class="report"><tbody>
            <tr class="total"><td>الأصول</td><td class="num">${money(rollup('1'))}</td></tr>${section('1')}
            <tr class="total"><td>الخصوم وحقوق الملكية</td><td class="num">${money(rollup('2'))}</td></tr>${section('2')}
            <tr><td style="padding-inline-start:32px">صافي ربح الفترة</td><td class="num">${money(net)}</td></tr>
            <tr class="total"><td>الإجمالي بعد صافي الربح</td><td class="num">${money(rollup('2') + net)}</td></tr>
          </tbody></table>
        </div>` : ''}
      </div>
      ${show('tb') ? `<div class="card">
        <div class="card-head"><div><h3>ميزان المراجعة بالأرصدة</h3><div class="sub">يشمل ${glEntries().length} قيد مرحّل</div></div><div class="spacer"></div>
          ${Math.abs(dr - cr) < 0.01 ? '<span class="pill green">الميزان متوازن</span>' : `<span class="pill red">فرق: ${money(Math.abs(dr - cr))}</span>`}</div>
        <div class="table-wrap"><table>
          <thead><tr><th>الكود</th><th>اسم الحساب</th><th>مدين</th><th>دائن</th></tr></thead>
          <tbody>${tb.map(r => `<tr><td class="code">${esc(r.a.code)}</td><td><button class="link-btn" data-ledger="${esc(r.a.code)}">${esc(r.a.name)}</button></td><td class="num">${r.d ? money(r.d) : '—'}</td><td class="num">${r.c ? money(r.c) : '—'}</td></tr>`).join('')}
          <tr style="font-weight:800;background:#f4f7fd"><td colspan="2">الإجمالي</td><td class="num">${money(dr)}</td><td class="num">${money(cr)}</td></tr>
          </tbody>
        </table></div>
      </div>` : ''}`;
    $$('[data-ledger]', content).forEach(b => b.onclick = () => openLedger(b.dataset.ledger));
  }

  // ---------- الإعدادات ----------
  function renderSettings() {
    const s = db.settings;
    const canSet = store.canAdmin && can('settings', 'e');
    const dis = canSet ? '' : 'disabled';
    const f = (k, l, t = 'text', full = false) => `<div class="field ${full ? 'full' : ''}"><label>${l}</label><input class="input" name="${k}" type="${t}" value="${esc(s[k])}" ${dis}></div>`;
    content.innerHTML = `
      <div class="card" style="max-width:860px">
        <div class="card-head"><div><h3>بيانات المنشأة</h3><div class="sub">${canSet ? 'تظهر في رأس القائمة والفواتير والتقارير' : 'ليس لديك صلاحية تعديل الإعدادات'}</div></div></div>
        <form class="card-body" id="settingsForm">
          <div class="form-grid">
            ${f('company', 'اسم المنشأة', 'text', true)}
            ${f('taxNo', 'رقم التسجيل الضريبي')}
            ${f('commercialReg', 'السجل التجاري')}
            ${f('currency', 'رمز العملة')}
            ${f('vat', 'نسبة الضريبة الافتراضية للفواتير الجديدة %', 'number')}
            ${f('fiscalStart', 'بداية السنة المالية', 'date')}
            ${f('address', 'العنوان', 'text')}
          </div>
          ${canSet ? '<div style="margin-top:20px"><button class="btn primary" type="submit">حفظ الإعدادات</button></div>' : ''}
        </form>
      </div>`;
    $('#settingsForm').addEventListener('submit', e => {
      e.preventDefault();
      Object.assign(db.settings, Object.fromEntries(new FormData(e.target)));
      db.settings.vat = +db.settings.vat || 0;
      save({ settings: true }); renderBrand(); toast('تم حفظ الإعدادات');
    });
  }

  // ---------- حالة قاعدة البيانات ----------
  const TABLE_TITLE = t => pageInfo(t)?.title || t;
  async function renderDatabase() {
    const total = sum(TABLES, t => db[t].length);
    const pct = Math.min(100, total / DB_CAPACITY * 100);
    const last = t => db[t].reduce((m, r) => (r._at && (!m || r._at > m._at) ? r : m), null);
    const cloud = store.mode === 'cloud';
    const rows = TABLES.map(t => ({ t, n: db[t].length, last: last(t) })).sort((a, b) => b.n - a.n);
    content.innerHTML = `
      <div class="card" style="margin-bottom:18px">
        <div class="card-head"><div><h3>النسخ الاحتياطي والاستعادة</h3><div class="sub">ملف JSON يحتوي على كل الجداول والإعدادات</div></div></div>
        <div class="card-body" style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn ghost ${canSp('backup') ? '' : 'hide'}" id="backupBtn">${icons.export}تنزيل نسخة احتياطية</button>
          <label class="btn primary admin-only ${canSp('backup') ? '' : 'hide'}" style="cursor:pointer">${icons.upload || icons.export}استعادة نسخة احتياطية<input type="file" id="restoreInput" accept="*/*" hidden></label>
          ${store.mode === 'local' ? '<button class="btn ghost" id="demoBtn">تحميل البيانات التجريبية</button>' : ''}
        </div>
      </div>
      <div class="kpis">
        ${kpi('نوع قاعدة البيانات', cloud ? 'سحابية مشتركة' : 'محلية', cloud ? 'مزامنة لحظية بين كل المستخدمين والأجهزة' : 'محفوظة في هذا المتصفح فقط', cloud ? 'up' : 'down', cloud ? 'green' : 'amber', icons.db)}
        ${kpi('عدد السجلات', num(total), `في ${TABLES.length} جدول`, '', '', icons.list)}
        ${kpi('القيود المرحّلة', num(glEntries().length), `${db.journal.length} يدوي`, '', '', icons.ledger)}
        ${kpi('السعة المستخدمة', `${pct.toFixed(1)}%`, `من ${num(DB_CAPACITY)} سجل`, '', pct > 80 ? 'red' : 'green', icons.wallet)}
      </div>
      <div class="card" style="margin-bottom:18px">
        <div class="card-head"><div><h3>الجداول</h3><div class="sub">${cloud ? `آخر مزامنة: ${store.lastSync ? store.lastSync.toLocaleTimeString((window.UI_LOCALE || 'ar-EG')) : '—'}` : 'وضع محلي'}</div></div>
          <div class="spacer"></div><div class="capacity" title="السعة المستخدمة"><span style="width:${pct}%"></span></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>الجدول</th><th>المسار</th><th>عدد السجلات</th><th>آخر تعديل</th><th>بواسطة</th><th></th></tr></thead>
          <tbody>${rows.map(r => `<tr><td><b>${esc(TABLE_TITLE(r.t))}</b></td><td class="code">${r.t}</td><td class="num">${num(r.n)}</td>
            <td>${r.last ? new Date(r.last._at).toLocaleString((window.UI_LOCALE || 'ar-EG'), { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
            <td data-uid="${esc(r.last?._by || '')}">${esc(r.last?._u ? (db.appUsers.find(x => x.username === r.last._u)?.name || r.last._u) : '—')}</td>
            <td><a class="link-btn" href="#${r.t}">فتح</a></td></tr>`).join('')}</tbody>
        </table></div>
      </div>
`;
    $('#backupBtn').onclick = () => download(`acc-backup-${today()}.json`, JSON.stringify(db, null, 2), 'application/json');
    $('#restoreInput').onchange = async e => {
      try {
        const data = JSON.parse(await e.target.files[0].text());
        if (!Array.isArray(data.accounts)) throw 0;
        if (!confirm('ستحل النسخة الاحتياطية محل كل البيانات الحالية لكل المستخدمين. متابعة؟')) return;
        const oldUsers = db.appUsers;
        db = normalize(data);
        if (store.backend === 'supa') supaMergeUsers(oldUsers);
        save({ settings: true, approvals: true }); renderBrand(); renderNav(); renderDatabase(); toast('جارٍ رفع النسخة الاحتياطية إلى قاعدة البيانات…', 4000);
        if (store.backend === 'supa' && db.appUsers.some(u => !u.authId)) setTimeout(() => toast('المستخدمون القادمون من النسخة الاحتياطية يحتاجون كلمة مرور جديدة: من شاشة المستخدمين اضغط "تعيين كلمة مرور" لكل مستخدم', 9000), 4500);
      } catch { toast('الملف غير صالح'); }
    };
    $('#demoBtn')?.addEventListener('click', async () => {
      if (!confirm('سيتم استبدال البيانات الحالية بالبيانات التجريبية. متابعة؟')) return;
      const sd = await loadSeed(); if (!sd) return toast('ملف البيانات التجريبية غير متاح');
      db = normalize(sd); save(); renderBrand(); renderNav(); renderDatabase(); toast('تم تحميل البيانات التجريبية');
    });
    const ids = [...new Set(rows.filter(r => !r.last?._u).map(r => r.last?._by).filter(Boolean))];
    if (ids.length && store.user) {
      const ps = await store.user.profiles(ids);
      $$('[data-uid]', content).forEach(td => { const p = ps[td.dataset.uid]; if (p) td.textContent = p.name || 'مستخدم'; });
    }
  }

  // ---------- تصدير ----------
  // حفظ الملفات: داخل claude.ai عبر خدمة الحفظ في المنصة (تطلب تأكيد المستخدم)، وخارجها بالطريقة العادية للمتصفح
  let dlApi;
  const dlReady = (async () => { try { dlApi = window.claude?.use ? await window.claude.use('downloads') : null; } catch { dlApi = null; } })();
  async function saveFile(filename, data, type) {
    await dlReady;
    if (dlApi) {
      try { await dlApi.save({ filename, data: data instanceof Blob ? data : new Blob([data], { type }) }); toast(`تم حفظ الملف: ${filename}`); return; }
      catch (e) {
        if (e?.code === 'declined') return toast('تم إلغاء الحفظ');
        if (e?.code === 'rate_limited') return toast('يوجد طلب حفظ مفتوح — أكمله أولاً ثم حاول مرة أخرى', 4000);
        if (e?.code === 'rejected_extension') return toast('نوع الملف غير مسموح بحفظه هنا', 4000);
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
    a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  function download(filename, text, type) { return saveFile(filename, text, type); }
  function downloadCSV(name, header, rows) {
    const line = arr => arr.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
    download(`${pageInfo(name)?.title || name}.csv`, '﻿' + [line(header), ...rows.map(line)].join('\n'), 'text/csv;charset=utf-8');
  }

  // =====================================================================
  //               تسجيل الدخول والمستخدمون والصلاحيات
  // =====================================================================
  const ACT_NAMES = { v: 'عرض', a: 'إضافة', e: 'تعديل', d: 'حذف' };
  const SPECIALS = [['export', 'تصدير وطباعة البيانات'], ['backup', 'النسخ الاحتياطي والاستعادة'],
    ['adminTools', 'أدوات المدير (تفريغ الخزائن وحذف الحركات)'], ['users', 'إدارة المستخدمين والصلاحيات'], ['import', 'استيراد البيانات من Excel / CSV'], ['approvalsSetup', 'إعداد دورة الموافقات']];
  const VIEW_ONLY = ['dashboard', 'ledger', 'reports', 'stockBalances', 'database'];
  const SPECIAL_PAGES = { users: 'users', import: 'import', approvals: 'approvalsSetup', reportCenter: '_all' };
  const actsOf = p => SPECIAL_PAGES[p] ? [] : VIEW_ONLY.includes(p) ? ['v'] : p === 'settings' ? ['v', 'e'] : ['v', 'a', 'e', 'd'];
  const permPages = () => [...Object.keys(pagePath).filter(p => !SPECIAL_PAGES[p] && p !== 'bankMoves' && !/^(box|wh|rep|st|acct|cust|supp)\//.test(p))];
  const grant = (list, acts) => Object.fromEntries(list.map(p => [p, actsOf(p).filter(a => acts.includes(a)).join('')]));
  const ROLES = {
    admin: { title: 'مدير النظام', build: () => ({ perms: grant(permPages(), 'vaed'), special: SPECIALS.map(s => s[0]) }) },
    accountant: { title: 'محاسب', build: () => ({ perms: { ...grant(permPages(), 'v'), ...grant(['accounts', 'journal', 'cashboxes', 'receipts', 'payments', 'expenseOrders', 'supplierPayReqs', 'fixedAssets', 'supplierAccruals', 'salesInvoices', 'salesReturns', 'purchaseInvoices', 'purchaseReturns', 'payroll', 'customers', 'suppliers'], 'vae') }, special: ['export'] }) },
    storekeeper: { title: 'أمين مخزن', build: () => ({ perms: { ...grant(['dashboard', 'suppliers', 'purchaseOrders'], 'v'), ...grant(['items', 'units', 'warehouses', 'stockBalances', 'stockIn', 'stockOut', 'transfers', 'stockRequests', 'purchaseQuotes', 'purchaseOrders'], 'vae'), ...grant(['branches', 'costCenters'], 'v') }, special: ['export'] }) },
    sales: { title: 'مندوب مبيعات', build: () => ({ perms: { ...grant(['dashboard', 'items', 'stockBalances'], 'v'), ...grant(['customers', 'salesItems', 'salesInvoices', 'salesQuotes', 'salesReturns', 'receipts'], 'vae') }, special: [] }) },
    hr: { title: 'شئون العاملين', build: () => ({ perms: { ...grant(['dashboard'], 'v'), ...grant(['employees', 'girlsFixed', 'girlsTemp', 'bangladesh', 'costCenters', 'attendance', 'payroll', 'leaves', 'departments', 'workers', 'dailyLabor', 'advances'], 'vae') }, special: ['export'] }) },
    maint: { title: 'الميكنة والصيانة', build: () => ({ perms: { ...grant(['dashboard', 'items', 'stockBalances'], 'v'), ...grant(['machines', 'machineOps', 'maintenanceOrders', 'maintenancePlan', 'stockOut'], 'vae') }, special: [] }) },
    viewer: { title: 'مشاهد', build: () => ({ perms: grant(permPages(), 'v'), special: [] }) },
    custom: { title: 'مخصص', build: () => ({ perms: { dashboard: 'v' }, special: [] }) },
  };
  const roleTitle = u => ROLES[u?.role]?.title || 'مخصص';

  const SESSION_KEY = 'acc-erp-session', LAST_USER_KEY = 'acc-erp-last-user', REMEMBER_KEY = 'acc-erp-remember';
  let session = null;
  const curUser = () => session ? db.appUsers.find(u => u.id === session.uid) : null;
  const isAdminUser = u => u?.role === 'admin';
  const activeAdmins = () => db.appUsers.filter(u => isAdminUser(u) && u.active !== false);
  function can(page, act = 'v') {
    const u = curUser(); if (!u) return false;
    if (isAdminUser(u)) return true;
    if (page === 'reportCenter') return true;
    if (String(page).startsWith('st/')) return String(u.perms?.reports || '').includes(act);
    if (String(page).startsWith('rep/')) { const r = REPORTS.find(x => x.id === page.slice(4)); return !!r && act === 'v' && can(r.need); }
    if (String(page).startsWith('wh/')) return act === 'v' && ['stockIn', 'stockOut', 'transfers', 'stockBalances', 'items'].some(x => String(u.perms?.[x] || '').includes('v'));
    if (String(page).startsWith('acct/')) return act === 'v' && can('ledger');
    if (String(page).startsWith('cust/')) return can('customers', act);
    if (String(page).startsWith('supp/')) return can('suppliers', act);
    if (page === 'bankMoves' || String(page).startsWith('box/')) return act === 'v' && ['receipts', 'payments', 'boxTransfers', 'cashboxes'].some(x => String(u.perms?.[x] || '').includes('v'));
    if (page === 'approvals') return isApprover(u) || (u.special || []).includes('approvalsSetup');
    if (SPECIAL_PAGES[page]) return (u.special || []).includes(SPECIAL_PAGES[page]);
    if (modules[page]?.table && u.perms?.[page] == null) return String(u.perms?.[modules[page].table] || '').includes(act);
    return String(u.perms?.[page] || '').includes(act);
  }
  const canSp = sp => { const u = curUser(); return !!u && (isAdminUser(u) || (u.special || []).includes(sp)); };
  const denied = () => toast('ليس لديك صلاحية لهذا الإجراء — راجع مدير النظام', 3500);

  // ----- تشفير كلمات المرور (PBKDF2 + ملح عشوائي) -----
  const enc = new TextEncoder();
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
  async function hashPass(pass, salt, iter = 150000) {
    const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: iter }, key, 256));
  }
  const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  async function setPassword(u, pass) { if (store.backend === 'supa') return supaSetPassword(u, pass); u.salt = randHex(16); u.iter = 150000; u.passHash = await hashPass(pass, u.salt, u.iter); }
  const USERNAME_RE = /^[A-Za-z0-9._\-؀-ۿ]{3,30}$/;
  const checkPass = (p, c) => p.length < 8 ? 'كلمة المرور يجب ألا تقل عن 8 أحرف' : !(/[0-9]/.test(p) && /[^0-9]/.test(p)) ? 'كلمة المرور يجب أن تحتوي على حروف وأرقام معاً' : p !== c ? 'كلمتا المرور غير متطابقتين' : '';

  // ----- الجلسة -----
  // الجلسة تبقى داخل نفس النافذة فقط (التحديث أو تغيير اللغة لا يطلب الدخول)، وفتح البرنامج من جديد يبدأ بشاشة الدخول
  async function startSession(u) {
    const exp = Date.now() + 864e5;
    session = { uid: u.id, exp, sig: await sha(u.passHash + exp + (store.me.id || '')) };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      localStorage.removeItem(SESSION_KEY);
      localStorage.setItem(LAST_USER_KEY, u.username);
    } catch {}
  }
  // حفظ بيانات الدخول على هذا الجهاز: لا تُحفظ كلمة المرور نفسها، بل مفتاح موقّع مرتبط بها
  // (يبطل تلقائياً إذا تغيرت كلمة المرور أو أوقف الحساب)
  const canWriteUsers = () => store.mode !== 'cloud' || store.canAdmin;
  const remSig = async (u, exp) => sha('remember|' + u.passHash + '|' + exp + '|' + (store.me.id || ''));
  async function saveRemember(u) { const exp = Date.now() + 30 * 864e5; try { localStorage.setItem(REMEMBER_KEY, JSON.stringify({ uid: u.id, username: u.username, exp, sig: await remSig(u, exp) })); } catch {} }
  const clearRemember = () => { try { localStorage.removeItem(REMEMBER_KEY); } catch {} };
  const getRemember = () => { try { const r = JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null'); return r && r.exp > Date.now() ? r : null; } catch { return null; } };
  async function restoreSession() {
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem(SESSION_KEY)); localStorage.removeItem(SESSION_KEY); } catch {}
    if (!s || !(s.exp > Date.now())) return false;
    const u = db.appUsers.find(x => x.id === s.uid);
    if (!u || u.active === false || s.sig !== await sha(u.passHash + s.exp + (store.me.id || ''))) return false;
    session = s; return true;
  }
  async function sessionStillValid() {
    const u = curUser();
    if (store.backend === 'supa') return !!u && u.active !== false;
    return !!u && u.active !== false && session.sig === await sha(u.passHash + session.exp + (store.me.id || ''));
  }
  function logout(msg) {
    if (store.backend === 'supa') { session = null; content.innerHTML = ''; return supaLogout(msg); }
    session = null;
    try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch {}
    content.innerHTML = '';
    closeModal(); $('#userMenu').hidden = true;
    showAuth('login', msg);
  }

  // خروج تلقائي بعد 30 دقيقة بدون أي نشاط
  const IDLE_MS = 30 * 60000; let lastAct = Date.now();
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { lastAct = Date.now(); }, { passive: true, capture: true }));
  setInterval(() => { if (session && Date.now() - lastAct > IDLE_MS) logout('تم تسجيل الخروج تلقائياً لعدم النشاط 30 دقيقة'); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && session && Date.now() - lastAct > IDLE_MS) logout('تم تسجيل الخروج تلقائياً لعدم النشاط 30 دقيقة'); });

  async function authGate() {
    if (store.backend === 'supa') {
      if (!supa.user) return showAuth(store.hasUsers ? 'login' : 'setup');
      const u = db.appUsers.find(x => x.authId === supa.user.id);
      if (u && u.active !== false) { supaApplyUser(u); await startSession(u); clearFails(); return unlock(); }
      if (!db.appUsers.length && !store.hasUsers) return; // إنشاء أول مدير يكمل من شاشة الإعداد
      return supaLogout('هذا الحساب غير مفعّل في البرنامج — راجع مدير النظام');
    }
    if (!db.appUsers.length) return showAuth('setup');
    if (await restoreSession()) return unlock();
    showAuth('login');
  }
  function unlock() {
    state.authMode = null;
    document.body.classList.remove('locked');
    $('#auth').hidden = true; $('#auth').innerHTML = '';
    applyRole(); route();
  }

  // ----- شاشة الدخول -----
  const IC = {
    user: I('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
    lock: I('<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
    eye: I('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: I('<path d="M3 3l18 18M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
    id: I('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.5"/><path d="M5.5 16.5a3.5 3.5 0 0 1 7 0M14 10h4M14 13h3"/>'),
    check: I('<path d="m5 12 5 5 9-10"/>'),
    shield: I('<path d="M12 3 4 6v6c0 5 3.4 8.6 8 9.9 4.6-1.3 8-4.9 8-9.9V6z"/><path d="m9 12 2 2 4-4"/>'),
    cloud: I('<path d="M7 18a5 5 0 0 1-.6-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>'),
    tree: I('<path d="M12 3v18M12 8H6v4M12 8h6v4M6 12v3M18 12v3"/>'),
  };
  const inputBox = (icon, attrs, eye) => `<div class="af-in">${icon}<input ${attrs}>${eye ? `<button type="button" class="eye" aria-label="إظهار كلمة المرور">${IC.eye}</button>` : ''}</div>`;
  // قفل الدخول بعد المحاولات الخاطئة — محفوظ على الجهاز ويتصاعد (1 ثم 5 ثم 15 ثم 60 دقيقة)
  const LOCK_KEY = 'acc-erp-lock';
  const lockGet = () => { try { return JSON.parse(localStorage.getItem(LOCK_KEY) || 'null') || { n: 0, lv: 0, until: 0 }; } catch { return { n: 0, lv: 0, until: 0 }; } };
  const lockSet = v => { try { localStorage.setItem(LOCK_KEY, JSON.stringify(v)); } catch {} };
  let failCount = lockGet().n, lockUntil = lockGet().until;
  function registerFail() {
    const L = lockGet(); L.n = (L.n || 0) + 1;
    if (L.n >= 5) { const mins = [1, 5, 15, 60][Math.min(L.lv || 0, 3)]; L.until = Date.now() + mins * 60000; L.lv = (L.lv || 0) + 1; L.n = 0; lockSet(L); lockUntil = L.until; failCount = 0; return mins; }
    lockSet(L); failCount = L.n; return 0;
  }
  const clearFails = () => { lockSet({ n: 0, lv: 0, until: 0 }); failCount = 0; lockUntil = 0; };

  function showAuth(mode, notice = '') {
    state.authMode = mode;
    document.body.classList.add('locked');
    const box = $('#auth'); box.hidden = false;
    const company = appName();
    const letter = [...company.trim()][0] || 'م';
    const canSetup = store.mode !== 'cloud' || store.canAdmin || store.backend === 'supa';
    const rem = getRemember();
    const lastUser = rem?.username || (() => { try { return localStorage.getItem(LAST_USER_KEY) || ''; } catch { return ''; } })();
    const SAVED_PW = '\u2022saved\u2022';
    let form;
    if (mode === 'setup' && !canSetup) {
      form = `<div class="auth-card"><div class="ac-head"><div class="ac-logo">${esc(letter)}</div><h2>النظام لم يُجهّز بعد</h2>
        <p>يجب أن يقوم مالك النظام بفتح البرنامج أولاً وإنشاء حساب مدير النظام، ثم يضيفك كمستخدم.</p></div>
        <button type="button" class="af-submit" onclick="location.reload()">إعادة المحاولة</button></div>`;
    } else if (mode === 'setup') {
      form = `<form class="auth-card" id="authForm" autocomplete="off">
        <div class="ac-head"><div class="ac-logo">${esc(letter)}</div><span class="ac-chip">${IC.shield} الإعداد الأول</span>
          <h2>إنشاء حساب مدير النظام</h2><p>هذا الحساب يملك كل الصلاحيات، ومنه تضيف باقي المستخدمين وتحدد صلاحياتهم.</p></div>
        <label class="af"><span>الاسم بالكامل</span>${inputBox(IC.id, 'name="name" required maxlength="60" placeholder="مثال: أحمد الصاوي"')}</label>
        <label class="af"><span>اسم المستخدم</span>${inputBox(IC.user, 'name="username" required autocomplete="username" placeholder="مثال: admin" dir="ltr"')}</label>
        <div class="af-2">
          <label class="af"><span>كلمة المرور</span>${inputBox(IC.lock, 'type="password" name="password" required autocomplete="new-password" placeholder="8 أحرف على الأقل (حروف وأرقام)" dir="ltr"', true)}</label>
          <label class="af"><span>تأكيد كلمة المرور</span>${inputBox(IC.lock, 'type="password" name="confirm" required autocomplete="new-password" dir="ltr"', true)}</label>
        </div>
        <div class="af-err" role="alert"></div>
        <button class="af-submit" type="submit"><span>إنشاء الحساب والدخول</span></button>
      </form>`;
    } else {
      form = `<form class="auth-card login" id="authForm" autocomplete="on">
        <div class="ac-head"><h2>تسجيل الدخول</h2><p>أدخل اسم المستخدم وكلمة المرور</p></div>
        ${notice ? `<div class="af-note">${esc(notice)}</div>` : ''}
        <label class="af"><span>اسم المستخدم</span>${inputBox(IC.user, `name="username" required autocomplete="username" dir="ltr" value="${esc(lastUser)}" placeholder="اسم المستخدم"`)}</label>
        <label class="af"><span>كلمة المرور</span>${inputBox(IC.lock, `type="password" name="password" required autocomplete="current-password" dir="ltr" placeholder="كلمة المرور" ${rem ? `value="${SAVED_PW}" data-saved="1"` : ''}`, !rem)}</label>
        ${rem ? '<div class="af-saved">🔐 كلمة المرور محفوظة على هذا الجهاز — اضغط "تسجيل الدخول"</div>' : ''}
        <div class="af-row">
          <label class="remember"><input type="checkbox" name="remember" ${rem ? 'checked' : ''}><i>${IC.check}</i><span>حفظ كلمة المرور</span></label>
          <button type="button" class="forgot" id="forgotBtn">نسيت كلمة المرور؟</button>
        </div>
        <div class="af-forgot" id="forgotBox" hidden>
          <b>استعادة كلمة المرور</b>
          <p>تواصل مع مدير النظام ليعيّن لك كلمة مرور جديدة من شاشة <b>المستخدمون والصلاحيات</b>.</p>
          ${store.mode === 'local' || store.me.isOwner ? '<button type="button" class="af-link" id="ownerReset">أنا مالك النظام — إعادة تعيين كلمة مرور أي مستخدم</button>' : ''}
        </div>
        <div class="af-err" role="alert"></div>
        <button class="af-submit go" type="submit"><span><i class="go-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></i>ادخل</span></button>
      </form>`;
    }
    box.innerHTML = `
      <div class="auth-wrap">
        <section class="auth-brand hero" aria-label="${esc(company)}">
          <div class="ab-shapes"><i></i><i></i><i></i></div>
          <div class="ab-inner">
            <div class="ab-logo">${esc(letter)}</div>
            <h1>${esc(company)}</h1>
            <p class="ab-tag">نظام محاسبة متكامل لإدارة الحسابات والخزينة والمبيعات والمشتريات والمخازن وشئون العاملين</p>
            <ul class="ab-feats">
              <li><span>${IC.tree}</span>شجرة حسابات كاملة وقيود يومية تلقائية</li>
              <li><span>${IC.cloud}</span>قاعدة بيانات سحابية بمزامنة لحظية</li>
              <li><span>${IC.shield}</span>صلاحيات دقيقة لكل مستخدم في كل شاشة</li>
            </ul>
          </div>
          <div class="ab-foot">الإصدار ${APP_VERSION}</div>
        </section>
        <section class="auth-panel">
          ${form}
          <div class="auth-status"><i class="online ${store.status === 'saved' ? 'ok' : store.mode === 'local' ? 'local' : ''}"></i>${store.mode === 'cloud' ? 'متصل بقاعدة البيانات السحابية' : 'قاعدة بيانات محلية في هذا المتصفح'}</div>
        </section>
      </div>`;

    $$('#auth .eye').forEach(b => b.onclick = () => {
      const inp = b.parentElement.querySelector('input'); const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password'; b.innerHTML = show ? IC.eyeOff : IC.eye;
      b.setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
    });
    $('#forgotBtn')?.addEventListener('click', () => { const f = $('#forgotBox'); f.hidden = !f.hidden; });
    $('#ownerReset')?.addEventListener('click', ownerReset);
    const f = $('#authForm');
    if (!f) return;
    const pw = f.querySelector('[name=password]');
    // تعديل كلمة المرور أو اسم المستخدم يلغي استخدام المحفوظة
    if (pw?.dataset.saved) { const drop = () => { if (!pw.dataset.saved) return; delete pw.dataset.saved; pw.value = ''; f.querySelector('.af-saved')?.remove(); };
      pw.addEventListener('keydown', e => { if (e.key !== 'Enter' && e.key !== 'Tab') drop(); }); pw.addEventListener('paste', drop);
      f.querySelector('[name=username]').addEventListener('input', drop); }
    if (mode === 'login' && pw?.dataset.saved) f.querySelector('.af-submit').focus();
    else (f.querySelector(mode === 'login' && lastUser ? '[name=password]' : 'input'))?.focus();
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      const err = f.querySelector('.af-err'), btn = f.querySelector('.af-submit');
      const fail = m => { err.textContent = m; f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake'); btn.disabled = false; btn.classList.remove('busy'); };
      err.textContent = ''; btn.disabled = true; btn.classList.add('busy');
      if (mode === 'setup') {
        const uname = d.username.trim().toLowerCase();
        if (!USERNAME_RE.test(uname)) return fail('اسم المستخدم من 3 إلى 30 حرفاً أو رقماً بدون مسافات');
        const pe = checkPass(d.password, d.confirm); if (pe) return fail(pe);
        if (store.backend === 'supa') {
          const { data: hu } = await supa.sb.rpc('acc_has_users');
          if (hu) { store.hasUsers = true; return showAuth('login', 'تم إعداد النظام من قبل — سجّل الدخول'); }
          let r = await supa.sb.auth.signUp({ email: loginEmail(uname), password: d.password });
          if (r.error && /registered|exists/i.test(r.error.message)) r = await supa.sb.auth.signInWithPassword({ email: loginEmail(uname), password: d.password });
          if (r.error || !r.data?.user) return fail('تعذّر إنشاء الحساب: ' + (r.error?.message || 'تحقق من إعدادات Supabase (إلغاء تأكيد البريد)'));
          if (!r.data.session) return fail('يجب إلغاء "Confirm email" من إعدادات Supabase أولاً');
          supa.user = r.data.user;
          await supaConnect();
          if (db.appUsers.length) return showAuth('login');
          const u = { id: genId(), name: d.name.trim(), username: uname, role: 'admin', active: true, authId: supa.user.id, authEmail: loginEmail(uname), ...ROLES.admin.build(), createdAt: new Date().toISOString() };
          db.appUsers.push(u); supaApplyUser(u); save();
          await startSession(u); unlock(); toast(`مرحباً ${u.name} — تم إنشاء حساب مدير النظام`, 3500);
          return;
        }
        if (db.appUsers.length) return showAuth('login');
        const u = { id: genId(), name: d.name.trim(), username: uname, role: 'admin', active: true, ...ROLES.admin.build(), createdAt: new Date().toISOString() };
        await setPassword(u, d.password);
        db.appUsers.push(u); save();
        await startSession(u); unlock(); toast(`مرحباً ${u.name} — تم إنشاء حساب مدير النظام`, 3500);
        return;
      }
      lockUntil = Math.max(lockUntil, lockGet().until || 0);
      if (Date.now() < lockUntil) return fail(`محاولات كثيرة خاطئة — انتظر ${Math.ceil((lockUntil - Date.now()) / 1000)} ثانية`);
      const uname = d.username.trim().toLowerCase();
      if (store.backend === 'supa') {
        if (pw?.dataset.saved) { // دخول بالجلسة المحفوظة على هذا الجهاز
          const { data: { session: s } } = await supa.sb.auth.getSession();
          if (s?.user && s.user.email === loginEmail(uname)) {
            if (!d.remember) { try { localStorage.removeItem(SUPA_REM); } catch {} clearRemember(); }
            supa.user = s.user; await supaConnect(); return;
          }
          clearRemember(); delete pw.dataset.saved; pw.value = ''; f.querySelector('.af-saved')?.remove(); pw.focus();
          return fail('انتهى الدخول المحفوظ — اكتب كلمة المرور من جديد');
        }
        const r = await supaLogin(uname, d.password, !!d.remember);
        if (r.error) {
          if (r.error !== 'bad') return fail('تعذّر الاتصال بالخادم: ' + r.error);
          const mins = registerFail();
          if (mins) return fail(`محاولات كثيرة خاطئة — تم إيقاف الدخول ${mins} دقيقة`);
          return fail(`اسم المستخدم أو كلمة المرور غير صحيحة (متبقي ${5 - failCount} محاولات)`);
        }
        clearFails();
        if (d.remember) { try { localStorage.setItem(REMEMBER_KEY, JSON.stringify({ uid: supa.user.id, username: uname, exp: Date.now() + 30 * 864e5, sig: 'supa' })); } catch {} } else clearRemember();
        try { localStorage.setItem(LAST_USER_KEY, uname); } catch {}
        await supaConnect(); return;
      }
      const u = db.appUsers.find(x => x.username === uname);
      // الدخول بكلمة المرور المحفوظة على هذا الجهاز
      if (pw?.dataset.saved) {
        const r = getRemember();
        if (u && r && r.uid === u.id && r.sig === await remSig(u, r.exp)) {
          if (u.active === false) return fail('هذا الحساب موقوف — راجع مدير النظام');
          if (!d.remember) clearRemember();
          await startSession(u); if (canWriteUsers()) { u.lastLogin = new Date().toISOString(); save(); }
          unlock(); toast(`مرحباً ${u.name}`); return;
        }
        clearRemember(); delete pw.dataset.saved; pw.value = ''; f.querySelector('.af-saved')?.remove(); pw.focus();
        return fail('كلمة المرور المحفوظة لم تعد صالحة (ربما تم تغييرها) — اكتبها من جديد');
      }
      const h = await hashPass(d.password, u?.salt || 'none', u?.iter || 150000);
      if (!u || h !== u.passHash) {
        const mins = registerFail();
        if (mins) return fail(`محاولات كثيرة خاطئة — تم إيقاف الدخول ${mins} دقيقة`);
        return fail(`اسم المستخدم أو كلمة المرور غير صحيحة (متبقي ${5 - failCount} محاولات)`);
      }
      if (u.active === false) return fail('هذا الحساب موقوف — راجع مدير النظام');
      clearFails();
      await startSession(u);
      if (d.remember) await saveRemember(u); else clearRemember();
      if (canWriteUsers()) { u.lastLogin = new Date().toISOString(); save(); }
      unlock(); toast(`مرحباً ${u.name}`);
    });
  }

  // استعادة بواسطة مالك النظام (هويته موثقة من claude.ai)
  function ownerReset() {
    openModal('إعادة تعيين كلمة مرور', [
      { key: 'uid', label: 'المستخدم', input: 'select', options: () => db.appUsers.map(u => [u.id, `${u.name} (${u.username})`]), full: true },
      { key: 'password', label: 'كلمة المرور الجديدة', input: 'password' }, { key: 'confirm', label: 'تأكيدها', input: 'password' }], {}, async d => {
      const pe = checkPass(d.password, d.confirm); if (pe) { toast(pe); return false; }
      const u = db.appUsers.find(x => x.id === d.uid); if (!u) return;
      try { await setPassword(u, d.password); } catch (e) { toast(e.message, 5000); return false; }
      u.active = true; save(); toast(`تم تعيين كلمة مرور جديدة للمستخدم ${u.username}`, 3500);
    });
  }

  // ----- قائمة المستخدم في التذييل -----
  $('#userBtn').onclick = e => { e.stopPropagation(); const m = $('#userMenu'); m.hidden = !m.hidden; $('#umUsers').hidden = !can('users'); };
  document.addEventListener('click', e => { if (!e.target.closest('#userMenu')) $('#userMenu').hidden = true; });
  $('#userMenu').addEventListener('click', e => {
    const b = e.target.closest('[data-um]'); if (!b) return;
    $('#userMenu').hidden = true;
    if (b.dataset.um === 'logout') logout('تم تسجيل الخروج بنجاح');
    if (b.dataset.um === 'users') goTo('users');
    if (b.dataset.um === 'pass') changeOwnPassword();
  });
  function changeOwnPassword() {
    const u = curUser(); if (!u) return;
    if (store.backend === 'supa') return openModal('تغيير كلمة المرور', [{ key: 'current', label: 'كلمة المرور الحالية', input: 'password', full: true },
      { key: 'password', label: 'كلمة المرور الجديدة', input: 'password' }, { key: 'confirm', label: 'تأكيد كلمة المرور', input: 'password' }], {}, async d => {
      const chk = await supa.sb.auth.signInWithPassword({ email: loginEmail(u.username), password: d.current });
      if (chk.error) { toast('كلمة المرور الحالية غير صحيحة'); return false; }
      const pe = checkPass(d.password, d.confirm); if (pe) { toast(pe); return false; }
      const { error } = await supa.sb.auth.updateUser({ password: d.password });
      if (error) { toast('تعذّر تغيير كلمة المرور: ' + error.message, 5000); return false; }
      toast('تم تغيير كلمة المرور');
    });
    if (!canWriteUsers()) { toast('لحماية الحسابات: تغيير كلمة المرور يتم عن طريق مالك النظام فقط', 4500); return; }
    openModal('تغيير كلمة المرور', [{ key: 'current', label: 'كلمة المرور الحالية', input: 'password', full: true },
      { key: 'password', label: 'كلمة المرور الجديدة', input: 'password' }, { key: 'confirm', label: 'تأكيد كلمة المرور', input: 'password' }], {}, async d => {
      if (await hashPass(d.current, u.salt, u.iter) !== u.passHash) { toast('كلمة المرور الحالية غير صحيحة'); return false; }
      const pe = checkPass(d.password, d.confirm); if (pe) { toast(pe); return false; }
      const live = db.appUsers.find(x => x.id === u.id);
      await setPassword(live, d.password); save();
      await startSession(live); if (getRemember()?.uid === live.id) await saveRemember(live);
      toast('تم تغيير كلمة المرور');
    });
  }

  // ----- شاشة المستخدمين والصلاحيات -----
  const permCount = u => isAdminUser(u) ? permPages().length : permPages().filter(p => String(u.perms?.[p] || '').includes('v')).length;
  function renderUsers() {
    const me = curUser();
    const list = db.appUsers.slice().sort((a, b) => (isAdminUser(b) - isAdminUser(a)) || a.name.localeCompare(b.name, 'ar'));
    const fmt = d => d ? new Date(d).toLocaleString((window.UI_LOCALE || 'ar-EG'), { dateStyle: 'medium', timeStyle: 'short' }) : '—';
    content.innerHTML = `
      <div class="kpis">
        ${kpi('عدد المستخدمين', num(db.appUsers.length), `${db.appUsers.filter(u => u.active !== false).length} نشط`, '', '', icons.users)}
        ${kpi('مديرو النظام', num(activeAdmins().length), 'يملكون كل الصلاحيات', '', 'amber', icons.shield)}
        ${kpi('الشاشات', num(permPages().length), 'يمكن تحديد صلاحية كل منها', '', 'green', icons.list)}
        ${kpi('أنت', esc(me?.name || ''), roleTitle(me), '', '', icons.wallet)}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>المستخدمون</h3><div class="sub">أضف مستخدماً وحدد اسم الدخول وكلمة المرور والصلاحيات في كل شاشة</div></div>
          <div class="spacer"></div><div class="toolbar"><button class="btn primary" id="addUserBtn">${icons.plus}إضافة مستخدم</button></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>المستخدم</th><th>اسم الدخول</th><th>الدور</th><th>الحالة</th><th>الشاشات المتاحة</th><th>آخر دخول</th><th></th></tr></thead>
          <tbody>${list.map(u => `<tr>
            <td><div class="u-cell"><span class="u-av">${esc([...u.name.trim()][0] || '؟')}</span><b>${esc(u.name)}</b>${u.id === me?.id ? '<span class="pill">أنت</span>' : ''}</div></td>
            <td class="code" dir="ltr">${esc(u.username)}</td>
            <td>${isAdminUser(u) ? `<span class="pill amber">${roleTitle(u)}</span>` : `<span class="pill">${roleTitle(u)}</span>`}</td>
            <td>${pill(u.active === false ? 'موقوف' : 'نشط')}</td>
            <td class="num">${permCount(u)} / ${permPages().length}</td>
            <td>${fmt(u.lastLogin)}</td>
            <td><div class="row-actions">
              <button data-uperm="${u.id}" title="الصلاحيات">${icons.shield}</button>
              <button data-upass="${u.id}" title="تعيين كلمة مرور">${IC.lock}</button>
              <button data-uedit="${u.id}" title="تعديل">${icons.edit}</button>
              <button class="del" data-udel="${u.id}" title="حذف">${icons.del}</button>
            </div></td></tr>`).join('')}</tbody>
        </table></div>
        <div class="table-foot"><span>كلمات المرور مشفّرة (PBKDF2) ولا يمكن لأحد قراءتها</span><span>${db.appUsers.length} مستخدم</span></div>
      </div>`;
    const find = id => db.appUsers.find(u => u.id === id);
    $('#addUserBtn').onclick = () => openUserForm();
    $$('[data-uedit]', content).forEach(b => b.onclick = () => openUserForm(find(b.dataset.uedit)));
    $$('[data-uperm]', content).forEach(b => b.onclick = () => openPerms(find(b.dataset.uperm)));
    $$('[data-upass]', content).forEach(b => b.onclick = () => resetUserPass(find(b.dataset.upass)));
    $$('[data-udel]', content).forEach(b => b.onclick = () => {
      const u = find(b.dataset.udel);
      if (u.id === me?.id) return toast('لا يمكنك حذف حسابك الحالي');
      if (isAdminUser(u) && activeAdmins().length <= 1) return toast('لا يمكن حذف آخر مدير للنظام');
      if (!confirm(`حذف المستخدم "${u.name}" نهائياً؟`)) return;
      db.appUsers = db.appUsers.filter(x => x.id !== u.id); save(); renderUsers(); toast('تم حذف المستخدم');
    });
  }

  function openUserForm(u) {
    const roleOpts = () => Object.entries(ROLES).map(([k, r]) => [k, r.title]);
    const fields = [
      { key: 'name', label: 'الاسم بالكامل', input: 'text', full: true },
      { key: 'username', label: 'اسم المستخدم (للدخول)', input: 'text' },
      { key: 'role', label: 'الدور', input: 'select', options: roleOpts },
      ...(u ? [] : [{ key: 'password', label: 'كلمة المرور', input: 'password' }, { key: 'confirm', label: 'تأكيد كلمة المرور', input: 'password' }]),
      { key: 'active', label: 'الحالة', input: 'select', options: () => [['1', 'نشط'], ['0', 'موقوف']] },
    ];
    openModal(u ? 'تعديل مستخدم' : 'إضافة مستخدم', fields, u ? { ...u, active: u.active === false ? '0' : '1' } : { role: 'accountant', active: '1' }, async d => {
      const uname = d.username.trim().toLowerCase();
      if (!USERNAME_RE.test(uname)) { toast('اسم المستخدم من 3 إلى 30 حرفاً أو رقماً بدون مسافات'); return false; }
      if (db.appUsers.some(x => x.username === uname && x.id !== u?.id)) { toast('اسم المستخدم مستخدم من قبل'); return false; }
      const active = d.active === '1';
      if (u) {
        const live = db.appUsers.find(x => x.id === u.id); if (!live) return;
        const losingAdmin = isAdminUser(live) && live.active !== false && (d.role !== 'admin' || !active);
        if (losingAdmin && activeAdmins().length <= 1) { toast('لا يمكن إلغاء صلاحية آخر مدير للنظام'); return false; }
        if (live.id === session.uid && !active) { toast('لا يمكنك إيقاف حسابك الحالي'); return false; }
        const roleChanged = live.role !== d.role;
        if (store.backend === 'supa' && live.authId && live.username !== uname) {
          const old = live.username; live.username = uname;
          try { await supaSyncLogin(live); } catch (e) { live.username = old; toast(e.message, 5000); return false; }
        }
        Object.assign(live, { name: d.name.trim(), username: uname, role: d.role, active });
        if (roleChanged && (d.role === 'admin' || confirm(`تطبيق صلاحيات الدور "${ROLES[d.role].title}" على المستخدم؟ (ستُستبدل صلاحياته الحالية)`))) Object.assign(live, ROLES[d.role].build());
        save(); scheduleRender(); toast('تم حفظ بيانات المستخدم');
      } else {
        const pe = checkPass(d.password, d.confirm); if (pe) { toast(pe); return false; }
        const nu = { id: genId(), name: d.name.trim(), username: uname, role: d.role, active, ...ROLES[d.role].build(), createdAt: new Date().toISOString() };
        try { await setPassword(nu, d.password); } catch (e) { toast(e.message, 5000); return false; }
        db.appUsers.push(nu); save(); scheduleRender();
        toast(`تمت إضافة ${nu.name} — يمكنك تعديل صلاحياته بالتفصيل`, 3500);
      }
    });
  }

  function resetUserPass(u) {
    openModal(`تعيين كلمة مرور: ${u.name}`, [{ key: 'password', label: 'كلمة المرور الجديدة', input: 'password' }, { key: 'confirm', label: 'تأكيد كلمة المرور', input: 'password' }], {}, async d => {
      const pe = checkPass(d.password, d.confirm); if (pe) { toast(pe); return false; }
      const live = db.appUsers.find(x => x.id === u.id); if (!live) return;
      try { await setPassword(live, d.password); } catch (e) { toast(e.message, 5000); return false; }
      save();
      if (live.id === session.uid) { await startSession(live); if (getRemember()?.uid === live.id) await saveRemember(live); }
      toast('تم تعيين كلمة المرور — ستنتهي جلسات هذا المستخدم المفتوحة', 3500);
    });
  }

  // مصفوفة الصلاحيات: كل شاشة × (عرض، إضافة، تعديل، حذف)
  function permMatrixHTML(perms, special, locked) {
    const dis = locked ? 'disabled' : '';
    const row = p => `<tr><td><span class="emo">${EMO[p] || '•'}</span>${esc(pageInfo(p).title)}</td>${['v', 'a', 'e', 'd'].map(a => actsOf(p).includes(a)
      ? `<td><label class="pchk"><input type="checkbox" name="p:${p}:${a}" ${locked || String(perms[p] || '').includes(a) ? 'checked' : ''} ${dis}><i>${IC.check}</i></label></td>` : '<td class="na">—</td>').join('')}</tr>`;
    const groups = [];
    const walk = (items, titles) => items.forEach(it => {
      if (typeof it === 'string') { if (SPECIAL_PAGES[it] || it === 'bankMoves' || /^(box|wh|rep|st)\//.test(it)) return; let g = groups.find(x => x.t === titles.join(' › ')); if (!g) groups.push(g = { t: titles.join(' › '), p: [] }); g.p.push(it); }
      else walk(itemsOf(it), [...titles, it.title]);
    });
    walk(nav, []);
    return `
      <div class="perm-tools">
        <label>تطبيق قالب جاهز:</label>
        <select class="input" id="permTpl" ${dis}><option value="">— اختر دوراً —</option>${Object.entries(ROLES).filter(([k]) => k !== 'admin').map(([k, r]) => `<option value="${k}">${r.title}</option>`).join('')}</select>
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-all="1" ${dis}>تحديد الكل</button>
        <button type="button" class="btn ghost" data-all="0" ${dis}>إلغاء الكل</button>
        <button type="button" class="btn ghost" data-all="v" ${dis}>عرض فقط للكل</button>
      </div>
      ${locked ? '<div class="af-note">هذا المستخدم "مدير النظام" ويملك كل الصلاحيات دائماً. لتقييده غيّر دوره أولاً.</div>' : ''}
      <div class="table-wrap perm-wrap"><table class="perm">
        <thead><tr><th>الشاشة</th>${['v', 'a', 'e', 'd'].map(a => `<th><button type="button" class="col-t" data-col="${a}" ${dis}>${ACT_NAMES[a]}</button></th>`).join('')}</tr></thead>
        <tbody>${groups.map((g, gi) => `<tr class="pg"><td colspan="5"><label class="pchk"><input type="checkbox" data-grp="${gi}" ${dis}><i>${IC.check}</i></label>${esc(g.t)}</td></tr>${g.p.map(row).join('').replace(/<tr>/g, `<tr data-g="${gi}">`)}`).join('')}</tbody>
      </table></div>
      <div class="perm-sp"><h4>صلاحيات خاصة</h4>${SPECIALS.map(([k, t]) => `<label class="check"><input type="checkbox" name="sp:${k}" ${locked || special.includes(k) ? 'checked' : ''} ${dis}><span>${t}</span></label>`).join('')}</div>`;
  }
  function openPerms(u) {
    const locked = isAdminUser(u);
    form.classList.add('wide'); form.classList.remove('info');
    if (locked) form.classList.add('info');
    $('#modalTitle').textContent = `صلاحيات: ${u.name} (${u.username})`;
    $('#modalBody').innerHTML = permMatrixHTML(u.perms || {}, u.special || [], locked);
    modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false');
    const body = $('#modalBody');
    const boxes = () => $$('input[name^="p:"]', body);
    const sync = () => $$('[data-grp]', body).forEach(g => { const bs = $$(`tr[data-g="${g.dataset.grp}"] input`, body); g.checked = bs.length && bs.every(b => b.checked); g.indeterminate = !g.checked && bs.some(b => b.checked); });
    body.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.grp) $$(`tr[data-g="${t.dataset.grp}"] input`, body).forEach(b => { b.checked = t.checked; });
      else if (t.name?.startsWith('p:')) {
        const [, p, a] = t.name.split(':');
        if (a === 'v' && !t.checked) $$(`input[name^="p:${p}:"]`, body).forEach(b => { b.checked = false; });
        if (a !== 'v' && t.checked) { const v = body.querySelector(`input[name="p:${p}:v"]`); if (v) v.checked = true; }
      }
      sync();
    });
    body.querySelectorAll('[data-all]').forEach(b => b.onclick = () => { boxes().forEach(x => { x.checked = b.dataset.all === '1' || (b.dataset.all === 'v' && x.name.endsWith(':v')); }); sync(); });
    body.querySelectorAll('[data-col]').forEach(b => b.onclick = () => {
      const col = boxes().filter(x => x.name.endsWith(':' + b.dataset.col)); const on = !col.every(x => x.checked);
      col.forEach(x => { x.checked = on; if (on) { const v = body.querySelector(`input[name="p:${x.name.split(':')[1]}:v"]`); if (v) v.checked = true; } });
      if (!on && b.dataset.col === 'v') boxes().forEach(x => { x.checked = false; });
      sync();
    });
    $('#permTpl')?.addEventListener('change', e => {
      const k = e.target.value; if (!k) return;
      const t = ROLES[k].build();
      boxes().forEach(x => { const [, p, a] = x.name.split(':'); x.checked = String(t.perms[p] || '').includes(a); });
      $$('input[name^="sp:"]', body).forEach(x => { x.checked = t.special.includes(x.name.slice(3)); });
      body.dataset.tpl = k; sync();
    });
    sync();
    onSubmit = locked ? null : (d, fd) => {
      const live = db.appUsers.find(x => x.id === u.id); if (!live) return;
      const perms = {};
      for (const k of fd.keys()) if (k.startsWith('p:')) { const [, p, a] = k.split(':'); perms[p] = (perms[p] || '') + a; }
      live.perms = perms;
      live.special = [...fd.keys()].filter(k => k.startsWith('sp:')).map(k => k.slice(3));
      live.role = body.dataset.tpl || (live.role === 'admin' ? 'admin' : live.role);
      if (live.role !== 'admin') { const t = ROLES[live.role]?.build(); if (t && (JSON.stringify(t.perms) !== JSON.stringify(perms))) live.role = 'custom'; }
      save(); scheduleRender(); toast(`تم حفظ صلاحيات ${live.name}`);
    };
  }

  // إخفاء ما لا يسمح به الدور بعد رسم أي شاشة
  function enforce() {
    const p = state.page;
    const rm = sel => $$(sel, content).forEach(el => el.remove());
    if (!can(p, 'a')) rm('#addBtn, [data-addchild]');
    if (!can(p, 'a') || !canSp('import')) rm('#importBtn');
    if (!can(p, 'e')) rm('[data-edit], [data-editacc]');
    if (!can(p, 'd')) rm('[data-del], [data-delacc], #clearScreenBtn, #jClear, .sel-col, #bulkBar');
    if (!canSp('export')) rm('#exportBtn, #bxExport, [data-print-page]');
    if (!canSp('import') || !['receipts', 'payments', 'boxTransfers'].some(x => can(x, 'a'))) rm('#bxImport');
    if (!can('openingBalances', 'a')) rm('[data-new-open]');
    $$('[data-wnew]', content).forEach(b => { if (!can(b.dataset.wnew, 'a')) b.remove(); });
    $$('[data-new]', content).forEach(b => { if (!can(b.dataset.new, 'a')) b.remove(); });
    $$('[data-bedit], [data-bchq]', content).forEach(b => { if (!can((b.dataset.bedit || b.dataset.bchq).split('|')[0], 'e')) b.remove(); });
    $$('[data-bdel], [data-wdel]', content).forEach(b => { if (!can((b.dataset.bdel || b.dataset.wdel).split('|')[0], 'd')) b.remove(); });
    $$('[data-wedit]', content).forEach(b => { if (!can(b.dataset.wedit.split('|')[0], 'e')) b.remove(); });
    if (!canSp('adminTools')) rm('#clearScreenBtn, #jClear');
    $$('[data-act]', content).forEach(b => { const a = modules[p]?.actions?.[+b.dataset.act]; if (a?.target && !can(a.target, 'a')) b.remove(); });
    $$('[data-go], [data-src], .link-btn[href]', content).forEach(b => { const g = b.dataset.go || b.dataset.src || b.getAttribute('href')?.slice(1); if (g && pageInfo(g) && !can(g)) b.replaceWith(document.createTextNode(b.textContent)); });
  }

  // =====================================================================
  //                 الاستيراد من Excel / CSV
  // =====================================================================
  let importing = false;
  const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  let xlsxPromise = null;
  const loadXLSX = () => xlsxPromise ??= new Promise(res => {
    if (window.XLSX) return res(window.XLSX);
    const s = document.createElement('script'); s.src = XLSX_URL;
    s.onload = () => res(window.XLSX || null); s.onerror = () => { xlsxPromise = null; res(null); };
    document.head.appendChild(s);
  });

  // شجرة الحسابات كجدول قابل للاستيراد
  const ACC_IMPORT = { title: 'شجرة الحسابات', single: 'حساب', key: 'code', cols: [
    C('code', 'كود الحساب'), C('name', 'اسم الحساب'), C('parent', 'كود الحساب الأب', { optional: true }),
    C('nature', 'الطبيعة', { optional: true, input: 'select', options: opt('مدين', 'دائن') }),
    C('balance', 'الرصيد الافتتاحي', { input: 'number', optional: true })],
    validate: d => { if (d.parent && !acc(d.parent)) return `الحساب الأب ${d.parent} غير موجود`; if (d.parent === d.code) return 'الحساب لا يكون أباً لنفسه'; } };
  const LINE_KEYS = ['item', 'unit', 'qty', 'price', 'vatRate', 'whtRate'];
  const SALES_LK = ['item', 'code', 'itype', 'unit', 'qty', 'count', 'uw', 'price', 'value', 'disc', 'pack', 'tw', 'dr'];
  // أعمدة أصناف المبيعات في ملف الاستيراد — "إجمالي الوزن" و"إجمالي مدين" للمراجعة فقط: يُحسبان ويُقارَنان بالملف
  const salesLineCols = () => [C('code', 'كود الصنف', { optional: true, aka: ['الكود'] }), C('item', 'اسم الصنف', { optional: true, aka: ['الصنف'] }), C('itype', 'نوع الصنف', { optional: true, aka: ['النوع'] }),
    C('qty', 'الكمية', { ...N, optional: true, aka: ['الكميه'] }), C('unit', 'الوحدة', { optional: true, aka: ['الوحده'] }), C('price', 'سعر الوحدة', { ...M, optional: true, aka: ['سعر الوحده', 'السعر'] }),
    C('uw', 'سعة الوحدة', { ...N, optional: true, aka: ['وزن الوحدة', 'سعة العبوة', 'سعة العبوه', 'سعة الوحده'] }), C('count', 'العدد', { ...N, optional: true }),
    C('tw', 'إجمالي الوزن', { ...N, optional: true, aka: ['الوزن بالكيلو', 'اجمالي الوزن'] }),
    C('value', 'إجمالي القيمة', { ...M, optional: true, aka: ['القيمة', 'اجمالي القيمه', 'القيمه قبل الاضافات والخصومات'] }), C('disc', 'الخصم', { ...M, optional: true, aka: ['خصم مسموح به'] }),
    C('pack', 'قيمة مواد التعبئة', { ...M, optional: true, aka: ['مواد التعبئة', 'مواد تعبئة', 'قيمه مواد التعبئه', 'قيمه مواد تعبئه'] }),
    C('dr', 'إجمالي مدين', { ...M, optional: true, aka: ['اجمالي مدين', 'اجمالي المدين', 'مدين'] })];
  // استيراد المبيعات: العميل الجديد يُكوَّد في قاعدة العملاء (بتصنيف اسم الحساب)،
  // والصنف الجديد يُكوَّد في أصناف المبيعات الخاصة بنوع المبيعات، والنوع الجديد يُضاف لأنواع الصنف
  function salesAutoCreate(d, made) {
    const name = String(d.customer || '').trim();
    const ca0 = childrenOf(SYS.customers).find(x => x.code === d.account);
    if (name && (ca0 ? !db.customers.some(c => c.name === name && c.category === ca0.name) : !isCustomer(name))) {
      const ca = ca0;
      if (ca) { db.customers.push({ id: genId(), code: nextNo(db.customers, 'code') || 'C-001', name, category: ca.name, phone: '', city: '', limit: 0 }); made.cust.push(name); cache = {}; }
    }
    if (!d.account && isCustomer(name)) d.account = custAcc(name);
    const sacc = salesAccR({ ...d, stype: '' });
    (Array.isArray(d.lines) ? d.lines : []).forEach(l => {
      const nm = String(l.item || '').trim(); if (!nm) return;
      const ty = String(l.itype || '').trim();
      const si = salesItemOf(nm);
      if (!si && !db.items.some(i => i.name === nm)) {
        const q = +l.qty || 0, v = l.value === '' || l.value == null ? 0 : +l.value || 0;
        db.salesItems.push({ id: genId(), code: nextNo(db.salesItems, 'code') || 'SI-001', account: sacc, name: nm, itype: ty, unit: l.unit || db.units[0]?.name || 'كجم',
          weight: +l.uw || 0, price: +l.price || (q && v ? +(v / q).toFixed(2) : 0), stockItem: '' });
        made.items.push(nm); cache = {};
      } else if (si && ty && !varietiesOf(si.itype).includes(ty)) { si.itype = [...varietiesOf(si.itype), ty].join('، '); made.types.push(`${nm} › ${ty}`); }
    });
  }
  // كود الصنف وحده يكفي في ملف الاستيراد
  const salesLineFix = l => { if (!l.item && l.code) l.item = db.salesItems.find(i => String(i.code) === String(l.code))?.name || db.items.find(i => String(i.code) === String(l.code))?.name || ''; return l; };
  const lineImportCols = (tax, opt) => [C('item', 'الصنف', { optional: !!opt }), C('unit', 'الوحدة', { optional: true }), C('qty', 'الكمية', { ...N, optional: !!opt }), C('price', 'السعر', { ...M, optional: true }),
    ...(tax ? [C('vatRate', 'ض.ق.م %', { ...N, optional: true }), C('whtRate', 'خصم وإضافة %', { ...N, optional: true })] : [])];
  const JL_KEYS = ['acc', 'dr', 'cr', 'note'];
  const importDef = t => t === 'accounts' ? ACC_IMPORT : t === 'journal' ? { ...modules.journal, lineImport: true, lineKey: 'jlines', lineKeys: JL_KEYS,
      cols: [...modules.journal.cols.filter(c => !['jlines', 'amount'].includes(c.key)), C('acc', 'الحساب', { input: 'select', options: leafOpts() }), C('dr', 'مدين', { ...M, optional: true }), C('cr', 'دائن', { ...M, optional: true }), C('note', 'بيان السطر', { optional: true })] }
    : ['salesInvoices', 'salesReturns'].includes(tbl(t)) && modules[t]?.cols.some(c => c.input === 'lines')
    ? { ...modules[t], lineImport: true, lineKeys: SALES_LK, lineFix: salesLineFix, prepare: salesAutoCreate, cols: [...modules[t].cols.filter(c => c.input !== 'lines' && !c.compute), ...salesLineCols()] }
    : modules[t]?.cols.some(c => c.input === 'lines')
    ? { ...modules[t], lineImport: true, cols: [...modules[t].cols.filter(c => c.input !== 'lines'), ...lineImportCols(modules[t].cols.some(c => c.tax), modules[t].cols.some(c => c.optionalLines))] } : modules[t];
  const importFields = t => importDef(t).cols.filter(c => !c.compute && c.input !== 'lines' && c.input !== 'jlines');
  const importTables = () => ['accounts', ...Object.keys(modules).filter(t => !modules[t].table)].filter(t => t === 'accounts' ? store.canAdmin && can('accounts', 'a') : can(t, 'a'));

  // ----- قراءة الملف -----
  const AR_DIGITS = s => String(s).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/٫/g, '.').replace(/٬/g, ',');
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/)[0] || '';
    const delim = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }
  async function readSheet(file) {
    if (/\.csv$|\.txt$/i.test(file.name)) return parseCSV(await file.text());
    const X = await loadXLSX();
    if (!X) throw new Error('تعذّر تحميل قارئ ملفات Excel — احفظ الملف بصيغة CSV وحاول مرة أخرى');
    const wb = X.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const sheets = wb.SheetNames.filter(n => n !== 'تعليمات').map(n => ({ name: n, rows: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }).filter(r => r.some(c => String(c).trim() !== '')) })).filter(x => x.rows.length);
    if (!sheets.length) return [];
    const rows = sheets[0].rows; rows.sheets = sheets; return rows;
  }

  // ----- تحويل القيم -----
  const pad = n => String(n).padStart(2, '0');
  const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function convert(c, raw) {
    if (raw instanceof Date) return c.input === 'month' ? isoOf(raw).slice(0, 7) : isoOf(raw);
    const v = AR_DIGITS(raw ?? '').trim();
    if (v === '') return '';
    if (c.input === 'number') {
      const n = Number(v.replace(/[,\s]/g, ''));
      if (!Number.isFinite(n)) throw new Error(`"${c.label}" يجب أن يكون رقماً`);
      return n;
    }
    if (c.input === 'date' || c.input === 'month') {
      let iso = '';
      if (/^\d{4,6}(\.\d+)?$/.test(v) && +v > 20000 && +v < 80000) iso = isoOf(new Date(Math.round((+v - 25569) * 864e5) + new Date().getTimezoneOffset() * 6e4));
      else if (/^\d{4}[-/.]\d{1,2}([-/.]\d{1,2})?$/.test(v)) { const [y, m, d = 1] = v.split(/[-/.]/); iso = `${y}-${pad(m)}-${pad(d)}`; }
      else if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(v)) { const [d, m, y] = v.split(/[-/.]/); iso = `${y}-${pad(m)}-${pad(d)}`; }
      else if (/^\d{1,2}[-/.]\d{4}$/.test(v)) { const [m, y] = v.split(/[-/.]/); iso = `${y}-${pad(m)}-01`; }
      if (!iso || Number.isNaN(new Date(iso).getTime())) throw new Error(`تاريخ غير صحيح في "${c.label}": ${v}`);
      return c.input === 'month' ? iso.slice(0, 7) : iso;
    }
    if (c.input === 'select') {
      const opts = c.options().map(o => Array.isArray(o) ? o.map(String) : [String(o), String(o)]);
      const nv = normAr(v), nameOf = x => normAr(String(x).replace(/^\d+\s-\s/, ''));
      const hit = opts.find(([ov, ol]) => ov === v || ol === v) || opts.find(([ov]) => /^\d+\s-\s/.test(ov) && accCode(ov) === accCode(v))
        || opts.find(([ov, ol]) => normAr(ov) === nv || normAr(ol) === nv) || opts.find(([ov, ol]) => nameOf(ov) === nameOf(v) || nameOf(ol) === nameOf(v));
      if (!hit) throw new Error(`"${v}" غير موجود في قائمة "${c.label}"`);
      return hit[0];
    }
    return v;
  }

  // ----- تحليل الملف إلى صفوف جاهزة -----
  function analyze(t, sheet, mode, preset = {}) {
    const def0 = importDef(t), fields = importFields(t);
    const def = Object.keys(preset).length ? { ...def0, defaults: () => ({ ...(def0.defaults?.() || {}), ...preset }) } : def0;
    const norm = s => normAr(String(s ?? '').replace(/[*:]/g, ''));
    const header = (sheet[0] || []).map(norm);
    const AKA = { 'رقم الحركة': ['رقم السند', 'رقم الإذن', 'رقم المستند', 'الرقم'], 'تاريخ الحركة': ['التاريخ'], 'اسم الحساب': ['الحساب المقابل', 'الحساب'], 'اسم المخزن': ['المخزن'],
      'اسم المستفيد / الطرف': ['المستلم منه', 'المستفيد', 'الطرف', 'العميل'], 'اسم المستفيد': ['المصروف إليه', 'المستفيد', 'الطرف', 'المورد'], 'رقم فاتورة المردودات': ['رقم المرتجع'], 'المبلغ المستحق': ['المبلغ'] };
    const names = c => [c.label, c.key, ...(AKA[c.label] || []), ...(c.aka || [])].map(norm);
    const colIdx = Object.fromEntries(fields.map(c => [c.key, header.findIndex(h => names(c).includes(h))]));
    const missingCols = fields.filter(c => !c.optional && !['no', 'code'].includes(c.key) && colIdx[c.key] < 0 && !(def.defaults && c.key in (def.defaults() || {})));
    const keyIdx = def.key ? colIdx[def.key] : -1;
    const seen = new Set();
    const rows = sheet.slice(1).map((r, i) => {
      const out = { line: i + 2, data: {}, status: 'new', msg: '' };
      try {
        for (const c of fields) if (colIdx[c.key] >= 0) out.data[c.key] = convert(c, r[colIdx[c.key]]);
        const keyVal = keyIdx >= 0 ? out.data[def.key] : '';
        const sc = def.keyScope, scVal = sc ? String(out.data[sc] ?? '') : '';
        const existing = keyVal !== '' && keyVal != null ? db[t].find(x => String(x[def.key]) === String(keyVal) && (!sc || String(x[sc] || '') === scVal)) : null;
        const seenKey = keyVal + (sc ? '|' + scVal : '');
        if (keyVal && seen.has(seenKey) && !def.lineImport) throw new Error(`"${keyVal}" مكرر في الملف${sc ? ' لنفس الحساب الرئيسي' : ''}`);
        if (def.lineImport && existing) throw new Error(`"${keyVal}" موجود من قبل`);
        if (keyVal) seen.add(seenKey);
        if (existing) {
          if (mode !== 'upsert') throw new Error(`"${keyVal}" موجود من قبل — اختر "إضافة وتحديث" لتعديله`);
          if (!can(t, 'e')) throw new Error('ليس لديك صلاحية التعديل');
          out.status = 'update'; out.id = existing.id;
          Object.keys(out.data).forEach(k => { if (out.data[k] === '' && !fields.find(c => c.key === k).optional) delete out.data[k]; });
        } else {
          if (missingCols.length) throw new Error(`أعمدة ناقصة: ${missingCols.map(c => c.label).join('، ')}`);
          const empty = fields.filter(c => !c.optional && !['no', 'code'].includes(c.key) && colIdx[c.key] >= 0 && (out.data[c.key] === '' || out.data[c.key] == null) && !(def.defaults && c.key in (def.defaults() || {})));
          if (empty.length) throw new Error(`حقول فارغة: ${empty.map(c => c.label).join('، ')}`);
        }
      } catch (e) { out.status = 'error'; out.msg = e.message; }
      return out;
    });
    const made = def.lineImport ? simulateGroups(t, def, rows, preset) : null;
    return { rows, made, unknown: (sheet[0] || []).filter((h, i) => h !== '' && !Object.values(colIdx).includes(i)), missingCols };
  }
  // نفس خطوات التنفيذ على نسخة مؤقتة: تظهر أخطاء كل مستند (العميل، الصنف، إجمالي مدين…) في المعاينة، ثم تُستعاد البيانات كما كانت
  function simulateGroups(t, def, rows, preset) {
    const made = { cust: [], items: [], types: [] };
    const bc = db.customers, bs = db.salesItems, bt = db[t], wasImp = importing;
    db.customers = bc.slice(); db.salesItems = bs.map(x => ({ ...x })); db[t] = bt.slice(); importing = true; cache = {};
    try {
      const groups = new Map();
      rows.forEach(r => { if (r.status === 'error') return; const k = r.data.no || '#' + r.line; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
      const LK = def.lineKeys || LINE_KEYS, key = def.lineKey || 'lines';
      for (const g of groups.values()) {
        const head = Object.fromEntries(Object.entries(g[0].data).filter(([k, v]) => !LK.includes(k) && !(k in preset && v === '')));
        const data = JSON.parse(JSON.stringify({ ...(def.defaults?.() || {}), ...head, [key]: g.map(r => Object.fromEntries(LK.map(k => [k, r.data[k] ?? '']))).map(l => def.lineFix ? def.lineFix(l) : l).filter(l => l[LK[0]]) }));
        if (!data.no) data.no = autoNo(t, 'no');
        let err = '';
        try { def.prepare?.(data, made); err = def.validate?.(data, null) || ''; } catch (e) { err = e.message; }
        if (err) g.forEach(r => { r.status = 'error'; r.msg = `${data.no ? `مستند ${data.no}: ` : ''}${err}`; });
        else { db[t].push({ id: '__sim', ...data }); cache = {}; }
      }
    } finally { db.customers = bc; db.salesItems = bs; db[t] = bt; importing = wasImp; cache = {}; }
    return made;
  }

  // ----- التنفيذ -----
  function runImport(t, rows, preset = {}) {
    const def0 = importDef(t);
    const def = Object.keys(preset).length ? { ...def0, defaults: () => ({ ...(def0.defaults?.() || {}), ...preset }) } : def0;
    let added = 0, updated = 0; const fails = [], made = { cust: [], items: [], types: [] };
    importing = true;
    try {
      if (def.lineImport) {
        const groups = new Map();
        rows.forEach(r => { if (r.status === 'error') { fails.push(r); return; } const k = r.data.no || '#' + r.line; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
        for (const g of groups.values()) {
          const LK = def.lineKeys || LINE_KEYS, key = def.lineKey || 'lines';
          const head = Object.fromEntries(Object.entries(g[0].data).filter(([k, v]) => !LK.includes(k) && !(k in preset && v === '')));
          const data = { ...(def.defaults?.() || {}), ...head, [key]: g.map(r => Object.fromEntries(LK.map(k => [k, r.data[k] ?? '']))).map(l => def.lineFix ? def.lineFix(l) : l).filter(l => l[LK[0]]) };
          if (!data.no) data.no = autoNo(t, 'no');
          def.prepare?.(data, made);
          const err = def.validate?.(data, null);
          if (err) { g.forEach(r => fails.push({ ...r, status: 'error', msg: err })); continue; }
          const rec = { id: genId(), ...data }; db[t].push(rec); added++;
          submitForApproval(t, rec, true); cache = {};
        }
        rows = [];
      }
      for (const r of rows) {
        if (r.status === 'error') { fails.push(r); continue; }
        const cur = r.id ? db[t].find(x => x.id === r.id) : null;
        const data = { ...r.data }; Object.keys(preset).forEach(k => { if (data[k] === '') delete data[k]; });
        if (t === 'accounts') { data.parent = data.parent || null; data.balance = +data.balance || 0; }
        // التحقق على نفس النسخة التي ستُحفظ (التحقق قد يكمّل حقولاً مثل نوع الفترة أو اسم المستفيد)
        const merged = { ...(cur || def.defaults?.() || {}), ...data };
        if (!cur) ['no', 'code'].forEach(k => { if ((modules[t]?.cols || []).some(c => c.key === k) && !merged[k]) merged[k] = autoNo(t, k); });
        const err = def.validate?.(merged, cur);
        if (err) { fails.push({ ...r, status: 'error', msg: err }); continue; }
        let rec = cur;
        if (cur) { const { id, ...rest } = merged; Object.assign(cur, rest); updated++; }
        else { rec = { ...merged, id: genId() }; db[t].push(rec); added++; }
        def.afterSave?.(rec);
        submitForApproval(t, rec, true);
        cache = {};
      }
    } finally { importing = false; }
    if (added || updated || made.cust.length || made.items.length || made.types.length) save();
    renderNav(); renderPage();
    return { added, updated, fails, made };
  }

  // ----- الواجهة -----
  async function downloadTemplate(t, preset = {}, title) {
    const fields = importFields(t), def0 = importDef(t), def = title ? { ...def0, title } : def0;
    // نموذج نوع مبيعات: المثال من فواتير نفس الحساب، وعمود الحساب مكتوب مسبقاً
    const sample0 = preset.account ? db[t].find(r => (r.account || custAcc(r.customer)) === preset.account) || db[t][0] : db[t][0];
    const sample = sample0 && Object.keys(preset).length ? { ...sample0, ...preset } : sample0;
    const head = fields.map(c => c.label + (c.optional ? '' : ' *'));
    const exVal = c => { const v = sample[c.key] ?? ''; if (v === '' || c.input !== 'select' || typeof c.options !== 'function') return v; const o = c.options().find(x => Array.isArray(x) && String(x[0]) === String(v)); return o ? o[1] : v; };
    const ex = sample ? fields.map(exVal) : fields.map(() => '');
    const X = await loadXLSX();
    if (X) {
      const ws = X.utils.aoa_to_sheet([head, ex]);
      ws['!cols'] = fields.map(c => ({ wch: Math.max(14, c.label.length + 4) }));
      const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'بيانات');
      const notes = [['تعليمات'], ['الصف الأول أسماء الأعمدة كما هي — الأعمدة المعلّمة بـ * مطلوبة للسجلات الجديدة'], ['الصف الثاني مثال من البيانات الحالية — احذفه أو عدّله'],
        ['التواريخ: 2026-11-23 أو 23/11/2026'], ['القوائم (العميل، المورد، الخزينة، الحساب...) يجب أن تطابق الأسماء الموجودة في البرنامج'],
        [def.key ? `للتعديل: اكتب ${fields.find(c => c.key === def.key)?.label} لسجل موجود واختر "إضافة وتحديث"، والأعمدة الفارغة لا تُغيَّر` : 'هذا الجدول يقبل الإضافة فقط']];
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(notes), 'تعليمات');
      const blob = new Blob([X.write(wb, { type: 'array', bookType: 'xlsx' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      saveFile(`نموذج-${def.title}.xlsx`, blob);
    } else downloadCSV(`نموذج-${def.title}`, head, [ex]);
  }

  function openImport(t0, preset = {}) {
    if (!canSp('import')) return denied();
    const tables = importTables();
    if (!tables.length) return denied();
    let t = tables.includes(t0) ? t0 : tables[0], parsed = null, sheet = null, view = 'all', page = 0, ignoreErr = false;
    const PAGE = 200;
    const reparse = () => { parsed = analyze(t, sheet.rows, sheet.mode || 'add', presetFor(t)); view = 'all'; page = 0; ignoreErr = false; };
    const presetFor = x => Object.fromEntries(Object.entries(preset).filter(([k]) => importFields(x).some(c => c.key === k)));
    const tplTitle = preset._title;
    // اختيار الورقة الأنسب للجدول (باسم الجدول) عند وجود أكثر من ورقة
    const bestSheet = (sheets, x) => sheets.find(w => normAr(w.name) === normAr(importDef(x).title)) || sheets.find(w => normAr(importDef(x).title).includes(normAr(w.name)) || normAr(w.name).includes(normAr(importDef(x).title))) || sheets[0];
    form.classList.add('wide'); form.classList.remove('info');
    $('#modalTitle').textContent = 'استيراد من Excel / CSV';
    const body = $('#modalBody');
    const draw = () => {
      const def = importDef(t), fields = importFields(t);
      const cnt = s => parsed ? parsed.rows.filter(r => r.status === s).length : 0;
      body.innerHTML = `
        <div class="imp-head">
          <div class="field"><label>الجدول</label><select class="input" id="impTable">${tables.map(x => `<option value="${x}" ${x === t ? 'selected' : ''}>${esc(importDef(x).title)}</option>`).join('')}</select></div>
          <div class="field"><label>طريقة الاستيراد</label><select class="input" id="impMode" ${def.key ? '' : 'disabled'}>
            <option value="add">إضافة سجلات جديدة فقط</option>${def.key && can(t, 'e') ? '<option value="upsert">إضافة وتحديث السجلات الموجودة</option>' : ''}</select></div>
        </div>
        <div class="imp-cols"><b>الأعمدة:</b> ${fields.map(c => `<span class="pill ${c.optional ? '' : 'amber'}">${esc(c.label)}${c.optional ? '' : ' *'}</span>`).join(' ')}
          ${def.key ? `<div class="hint">المفتاح للتحديث: <b>${esc(fields.find(c => c.key === def.key)?.label || '')}</b></div>` : '<div class="hint">هذا الجدول يقبل الإضافة فقط</div>'}</div>
        <div class="imp-actions">
          <button type="button" class="btn ghost" id="impTpl">${icons.export}تنزيل نموذج Excel</button>
          <label class="btn primary imp-file">${icons.plus}اختيار ملف (xlsx / csv)<input type="file" id="impFile" accept=".xlsx,.xls,.csv,.txt" hidden></label>
          <span class="hint" id="impName">${sheet ? esc(sheet.name) : 'لم يتم اختيار ملف'}</span>
          ${sheet?.sheets?.length > 1 ? `<label class="hint">الورقة: <select class="input" id="impSheet">${sheet.sheets.map((w, i) => `<option value="${i}" ${w.rows === sheet.rows ? 'selected' : ''}>${esc(w.name)} (${w.rows.length - 1} صف)</option>`).join('')}</select></label>` : ''}
        </div>
        ${Object.keys(presetFor(t)).length ? `<div class="af-note">الأعمدة غير الموجودة في الملف تأخذ: ${Object.entries(presetFor(t)).map(([k, v]) => `<b>${esc(importFields(t).find(c => c.key === k)?.label || k)}</b> = ${esc(k === 'account' && acc(v) ? acc(v).name : v)}`).join('، ')}</div>` : ''}
        ${parsed ? `
          <div class="summary imp-sum"><div><span>صفوف الملف</span><b>${parsed.rows.length}</b></div><div><span>جديد</span><b class="up">${cnt('new')}</b></div>
            <div><span>تحديث</span><b>${cnt('update')}</b></div><div><span>أخطاء (ستُتخطى)</span><b class="${cnt('error') ? 'down' : ''}">${cnt('error')}</b></div></div>
          ${parsed.unknown.length ? `<div class="af-note warn">أعمدة غير معروفة سيتم تجاهلها: ${parsed.unknown.map(esc).join('، ')}</div>` : ''}
          ${(() => { const mk = parsed.made; const parts = mk ? [mk.cust.length ? `${mk.cust.length} عميل جديد` : '', mk.items.length ? `${mk.items.length} صنف جديد` : '', mk.types.length ? `${mk.types.length} نوع صنف جديد` : ''].filter(Boolean) : [];
            return parts.length ? `<div class="af-note">سيتم تكويد تلقائياً: ${parts.join('، ')}${mk.cust.length ? `<br><small>العملاء: ${mk.cust.slice(0, 12).map(esc).join('، ')}${mk.cust.length > 12 ? ' …' : ''}</small>` : ''}${mk.items.length ? `<br><small>الأصناف: ${mk.items.map(esc).join('، ')}</small>` : ''}</div>` : ''; })()}
          ${cnt('error') ? `<div class="af-note warn imp-decide"><b>يوجد ${cnt('error')} صف بها أخطاء ولن يتم استيرادها.</b> راجع السبب في عمود "سبب الخطأ" (اضغط "الأخطاء فقط").
            <div class="imp-decide-row"><label class="check"><input type="checkbox" id="impIgnore" ${ignoreErr ? 'checked' : ''}> تجاهل الصفوف الخاطئة واستيراد الباقي (${cnt('new') + cnt('update')} صف)</label>
            <button type="button" class="btn ghost" id="impErrXlsx">${icons.export}تنزيل الصفوف الخاطئة (Excel)</button></div>
            <small>أو صحّح الملف واختره من جديد.</small></div>` : ''}
          ${(() => { const list = view === 'err' ? parsed.rows.filter(r => r.status === 'error') : parsed.rows, pages = Math.max(1, Math.ceil(list.length / PAGE)); page = Math.min(page, pages - 1);
            const pager = pages > 1 ? `<div class="imp-pager">${page > 0 ? `<button type="button" class="btn ghost" data-ipg="${page - 1}">→ السابق</button>` : ''}<span>صفحة ${page + 1} من ${pages} (الصفوف ${page * PAGE + 1}–${Math.min(list.length, (page + 1) * PAGE)} من ${list.length})</span>${page < pages - 1 ? `<button type="button" class="btn ghost" data-ipg="${page + 1}">التالي ←</button>` : ''}</div>` : '';
            return `<div class="imp-view"><button type="button" class="tab-btn ${view === 'all' ? 'on' : ''}" data-iv="all">كل الصفوف <em>${parsed.rows.length}</em></button>
              <button type="button" class="tab-btn ${view === 'err' ? 'on' : ''}" data-iv="err">الأخطاء فقط <em>${cnt('error')}</em></button></div>${pager}
          <div class="table-wrap imp-prev"><table>
            <thead><tr><th>الصف</th><th>الحالة</th><th>سبب الخطأ</th>${fields.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
            <tbody>${list.slice(page * PAGE, (page + 1) * PAGE).map(r => `<tr class="${r.status === 'error' ? 'bad' : ''}"><td class="num">${r.line}</td>
              <td>${r.status === 'new' ? '<span class="pill green">جديد</span>' : r.status === 'update' ? '<span class="pill">تحديث</span>' : '<span class="pill red">خطأ</span>'}</td>
              <td class="err-msg">${esc(r.msg)}</td>${fields.map(c => `<td>${esc(r.data[c.key] ?? '')}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${fields.length + 3}" class="hint">لا توجد صفوف</td></tr>`}</tbody>
          </table></div>${pager}`; })()}` : `
          <div class="imp-help"><p>1. نزّل النموذج وافتحه في Excel واملأ البيانات (يمكن لصق بيانات من برنامجك القديم).</p>
          <p>2. اختر الملف — ستظهر معاينة لكل صف قبل الحفظ، مع توضيح الأخطاء.</p>
          <p>3. اضغط "تنفيذ الاستيراد". كل الحركات تُرحّل تلقائياً كأنها أُدخلت يدوياً.</p></div>`}`;
      $('#impTable').onchange = e => { t = e.target.value; if (sheet) { if (sheet.sheets) sheet.rows = bestSheet(sheet.sheets, t).rows; reparse(); } draw(); };
      $('#impMode').onchange = () => { if (sheet) { sheet.mode = $('#impMode').value; reparse(); draw(); } };
      $('#impSheet') && ($('#impSheet').onchange = e => { sheet.rows = sheet.sheets[+e.target.value].rows; reparse(); draw(); });
      $$('[data-iv]', body).forEach(b => b.onclick = () => { view = b.dataset.iv; page = 0; draw(); });
      $$('[data-ipg]', body).forEach(b => b.onclick = () => { page = +b.dataset.ipg; draw(); body.querySelector('.imp-prev')?.scrollTo(0, 0); });
      const ig = $('#impIgnore'); if (ig) ig.onchange = () => { ignoreErr = ig.checked; $('#saveBtn').disabled = !canRun(); };
      $('#impErrXlsx') && ($('#impErrXlsx').onclick = () => exportGrid(`أخطاء استيراد ${importDef(t).title}`, ['الصف', 'سبب الخطأ', ...fields.map(c => c.label)],
        parsed.rows.filter(r => r.status === 'error').map(r => [r.line, r.msg, ...fields.map(c => r.data[c.key] ?? '')])));
      if (sheet) $('#impMode').value = sheet.mode || 'add';
      $('#impTpl').onclick = () => downloadTemplate(t, presetFor(t), tplTitle);
      $('#impFile').onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        $('#impName').textContent = 'جارٍ قراءة الملف…';
        try {
          const all = await readSheet(f), sheets = all.sheets;
          const rows = sheets ? bestSheet(sheets, t).rows : all;
          if (rows.length < 2) throw new Error('الملف فارغ أو لا يحتوي إلا على صف العناوين');
          const mode = $('#impMode').value;
          sheet = { name: f.name, rows, sheets, mode }; reparse(); draw();
        } catch (err) { $('#impName').textContent = err.message; toast(err.message, 4000); }
      };
      $('#saveBtn').textContent = 'تنفيذ الاستيراد';
      $('#saveBtn').disabled = !canRun();
    };
    // بها أخطاء: لا يُنفذ الاستيراد إلا بعد اختيار تجاهلها صراحةً
    const canRun = () => !!parsed && parsed.rows.some(r => r.status !== 'error') && (!parsed.rows.some(r => r.status === 'error') || ignoreErr);
    draw();
    modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false');
    onSubmit = () => {
      if (!parsed) return false;
      const res = runImport(t, parsed.rows, presetFor(t));
      form.classList.add('info');
      $('#modalTitle').textContent = 'نتيجة الاستيراد';
      body.innerHTML = `<div class="summary imp-sum"><div><span>تمت الإضافة</span><b class="up">${res.added}</b></div><div><span>تم التحديث</span><b>${res.updated}</b></div>
        <div><span>تم التخطي</span><b class="${res.fails.length ? 'down' : ''}">${res.fails.length}</b></div><div><span>الجدول</span><b>${esc(importDef(t).title)}</b></div></div>
        ${res.fails.length ? `<div class="table-wrap imp-prev"><table><thead><tr><th>الصف</th><th>السبب</th></tr></thead><tbody>${res.fails.map(f => `<tr class="bad"><td class="num">${f.line}</td><td class="err-msg">${esc(f.msg)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="af-note">تم استيراد كل الصفوف بنجاح.</div>'}`;
      $('#saveBtn').textContent = 'حفظ'; $('#saveBtn').disabled = false;
      const mk = res.made || {}, extra = [mk.cust?.length ? `${mk.cust.length} عميل جديد` : '', mk.items?.length ? `${mk.items.length} صنف جديد` : '', mk.types?.length ? `${mk.types.length} نوع صنف جديد` : ''].filter(Boolean);
      toast(`استيراد: ${res.added} جديد، ${res.updated} تحديث، ${res.fails.length} متخطى${extra.length ? ` — وتم تكويد ${extra.join('، ')}` : ''}`, 6000);
      return false;
    };
  }

  // صفحة الاستيراد: كل الجداول في مكان واحد
  function renderImport() {
    const tables = importTables();
    const groups = [['شجرة الحسابات والخزائن والأرصدة الافتتاحية', ['accounts', 'cashboxes', 'openingBalances']],
      ['قواعد البيانات', ['customers', 'suppliers', 'salesItems', 'items', 'units', 'warehouses', 'branches', 'costCenters', 'crops', 'employees', 'girlsFixed', 'girlsTemp', 'bangladesh', 'workers', 'departments', 'machines']],
      ['حركات الخزينة والبنوك', ['receipts', 'payments', 'boxTransfers']], ['الموردون والمشتريات', ['supplierAccruals', 'purchaseOrders', 'purchaseInvoices', 'purchaseReturns']],
      ['المبيعات', ['salesInvoices', 'salesReturns', 'salesQuotes']], ['المخازن', ['stockIn', 'stockOut', 'transfers']], ['الحسابات', ['journal']],
      ['العاملون والعمالة والميكنة', ['attendance', 'payroll', 'leaves', 'dailyLabor', 'advances', 'machineOps', 'maintenanceOrders', 'maintenancePlan']]];
    const listed = new Set(groups.flatMap(g => g[1])); const rest = tables.filter(x => !listed.has(x)); if (rest.length) groups.push(['أخرى', rest]);
    content.innerHTML = `
      <div class="card" style="margin-bottom:18px"><div class="card-body imp-help">
        <p><b>استيراد البيانات من Excel أو CSV</b> — لنقل قاعدة بيانات من برنامج آخر، أو إدخال حركات كثيرة مرة واحدة (قبض، صرف، تحويلات، فواتير، أذون مخازن، مرتجعات)، أو تعديل سجلات موجودة.</p>
        <p>نزّل نموذج الجدول، املأه، ثم ارفعه. ستظهر معاينة لكل صف قبل الحفظ، والصفوف التي بها أخطاء تُتخطى مع توضيح السبب. الحركات المستوردة تُرحّل للقيود تلقائياً.</p>
        <p class="hint">ابدأ بالبيانات الأساسية (العملاء، الموردين، الأصناف، الخزائن) قبل الحركات، لأن الحركات تشير إليها بالاسم.</p></div></div>
      ${groups.map(([g, list]) => { const ok = list.filter(x => tables.includes(x)); return ok.length ? `
        <div class="section-title">${g}</div>
        <div class="imp-grid">${ok.map(x => `<div class="imp-card"><div><b>${EMO[x] || '📄'} ${esc(importDef(x).title)}</b><small>${db[x].length} سجل · ${importDef(x).lineImport ? 'صف لكل صنف — نفس الرقم = مستند واحد' : importDef(x).key ? 'إضافة وتحديث' : 'إضافة فقط'}</small></div>
          <div class="imp-btns"><button class="btn ghost" data-tpl="${x}">نموذج</button><button class="btn primary" data-imp="${x}">استيراد</button></div></div>`).join('')}</div>` : ''; }).join('')}`;
    $$('[data-tpl]', content).forEach(b => b.onclick = () => downloadTemplate(b.dataset.tpl));
    $$('[data-imp]', content).forEach(b => b.onclick = () => openImport(b.dataset.imp));
  }

  // =====================================================================
  //                 دورة الموافقات (الاعتمادات) وطباعة المستندات
  // المستند الذي يحتاج اعتماداً لا يُرحّل ولا يؤثر في أي رصيد حتى تكتمل كل مستوياته
  // =====================================================================
  const APPR_MODULES = ['journal', 'openingBalances', 'receipts', 'payments', 'boxTransfers', 'supplierAccruals', 'salesInvoices', 'salesReturns', 'purchaseInvoices', 'purchaseReturns',
    'stockIn', 'stockOut', 'transfers', 'payroll', 'dailyLabor', 'advances', 'maintenanceOrders'];
  const QTY_MODULES = ['stockIn', 'stockOut', 'transfers'];
  const amountOf = (t, r) => t === 'payroll' ? (+r.basic + +r.allowances - +r.deductions) : t === 'dailyLabor' ? r.days * r.wage
    : t === 'maintenanceOrders' ? +r.cost || 0 : t === 'stockIn' || t === 'stockOut' ? (docTotals(r).sub ? docTotals(r).net : docTotals(r).qty) : QTY_MODULES.includes(t) ? +r.qty || 0 : +r.amount || 0;
  const apprGlobal = () => db.approvalCfg || {};
  const apprCfg = t => apprGlobal().modules?.[t];
  const apprOn = t => { const c = apprCfg(t); return !!(c?.enabled && c.levels?.length); };
  const needsAppr = (t, r) => apprOn(t) && amountOf(t, r) >= (+apprCfg(t).minAmount || 0);
  const userName = id => db.appUsers.find(u => u.id === id)?.name || '—';

  // عند إنشاء مستند أو تعديله: يدخل دورة الاعتماد من أولها
  function submitForApproval(t, r, changed = true) {
    if (!APPR_MODULES.includes(t) || !changed) return;
    if (!needsAppr(t, r)) { if (r.appr && r.appr.status !== 'approved') delete r.appr; return; }
    const by = curUser()?.id || null, at = new Date().toISOString();
    r.appr = { status: 'pending', level: 0, steps: [...(r.appr?.steps || []), { action: r.appr ? 'resubmit' : 'submit', by, at }] };
  }
  const isApprover = u => !!u && Object.values(apprGlobal().modules || {}).some(c => (c.levels || []).some(l => (l.users || []).includes(u.id)));
  function canApprove(t, r) {
    if (!r?.appr || r.appr.status !== 'pending' || !store.canWrite) return false;
    const u = curUser(); if (!u) return false;
    const g = apprGlobal();
    if (isAdminUser(u) && g.adminOverride !== false) return true;
    if (g.noSelf !== false && r.appr.steps?.[0]?.by === u.id) return false;
    const lvl = apprCfg(t)?.levels?.[r.appr.level];
    return !!lvl && (lvl.users || []).includes(u.id);
  }
  function decide(t, id, ok, note = '') {
    const r = db[t].find(x => x.id === id);
    if (!r || !canApprove(t, r)) return false;
    const levels = apprCfg(t)?.levels || [];
    r.appr.steps = [...(r.appr.steps || []), { action: ok ? 'approve' : 'reject', level: r.appr.level, by: curUser().id, at: new Date().toISOString(), note }];
    if (!ok) r.appr.status = 'rejected';
    else { r.appr.level++; if (r.appr.level >= levels.length) r.appr.status = 'approved'; }
    return true;
  }
  const apprText = (t, r) => {
    if (!r.appr) return '';
    if (r.appr.status === 'approved') return 'معتمد';
    if (r.appr.status === 'rejected') return 'مرفوض';
    const lv = apprCfg(t)?.levels || [];
    return `بانتظار: ${lv[r.appr.level]?.title || 'الاعتماد'} (${r.appr.level + 1}/${Math.max(lv.length, 1)})`;
  };
  const apprPill = (t, r) => !r.appr ? '<span class="hint">—</span>'
    : `<span class="pill ${r.appr.status === 'approved' ? 'green' : r.appr.status === 'rejected' ? 'red' : 'amber'}">${esc(apprText(t, r))}</span>`;
  const docNo = (t, r) => r.no || (t === 'payroll' ? `PAY-${r.month}` : t === 'dailyLabor' ? `LAB-${r.date}` : t === 'advances' ? `ADV-${r.date}` : '—');
  const docParty = r => r.customer || r.supplier || r.costCenter || (r.account && (r.party || r.desc) ? partyName(r) : r.party) || r.employee || r.worker || r.machine || (r.from && r.to ? `${r.from} ← ${r.to}` : '') || r.desc || '';
  const myApprovals = () => APPR_MODULES.flatMap(t => db[t].filter(r => canApprove(t, r)).map(r => ({ t, r })));
  const ACTION_TXT = { submit: 'أنشأ المستند', resubmit: 'عدّل وأعاد الإرسال', approve: 'اعتمد', reject: 'رفض' };

  // ----- شاشة الموافقات -----
  function renderApprovals() {
    const canSetup = canSp('approvalsSetup') && store.canAdmin;
    const tab = ['mine', 'pending', 'rejected', 'approved', 'setup'].includes(state.filter) ? state.filter : 'mine';
    if (tab === 'setup' && canSetup) return renderApprSetup();
    const all = APPR_MODULES.flatMap(t => db[t].filter(r => r.appr).map(r => ({ t, r })));
    const pick = { mine: x => canApprove(x.t, x.r), pending: x => x.r.appr.status === 'pending', rejected: x => x.r.appr.status === 'rejected', approved: x => x.r.appr.status === 'approved' }[tab];
    const list0 = all.filter(pick).sort((a, b) => String(b.r.date || b.r.month || '').localeCompare(String(a.r.date || a.r.month || '')));
    // فلتر نوع المستند، والتحديد محفوظ في الحالة فلا يضيع عند تحديث الصفحة من المزامنة
    const types = [...new Set(list0.map(x => x.t))], ftype = types.includes(state.apprType) ? state.apprType : '';
    const list = ftype ? list0.filter(x => x.t === ftype) : list0;
    const selKey = x => `${x.t}|${x.r.id}`, SEL = state.apprSel ||= new Set();
    const visible = new Set(list.map(selKey)); [...SEL].forEach(k => { if (!visible.has(k)) SEL.delete(k); });
    const allOn = list.length > 0 && list.every(x => SEL.has(selKey(x)));
    const cnt = k => all.filter({ mine: x => canApprove(x.t, x.r), pending: x => x.r.appr.status === 'pending', rejected: x => x.r.appr.status === 'rejected', approved: x => x.r.appr.status === 'approved' }[k]).length;
    const enabled = APPR_MODULES.filter(apprOn);
    content.innerHTML = `
      <div class="tabs-bar">
        ${[['mine', 'بانتظار اعتمادي'], ['pending', 'كل المعلّق'], ['rejected', 'المرفوض'], ['approved', 'المعتمد']].map(([k, l]) => `<button class="tab-btn ${tab === k ? 'on' : ''}" data-tab="${k}">${l} <em>${cnt(k)}</em></button>`).join('')}
        ${canSetup ? `<button class="tab-btn ${tab === 'setup' ? 'on' : ''}" data-tab="setup">⚙️ إعداد دورة الموافقات</button>` : ''}
      </div>
      ${!enabled.length ? `<div class="af-note warn">لم يتم تفعيل دورة موافقات لأي مستند بعد — كل الحركات تُرحّل فور حفظها.${canSetup ? ' فعّلها من "إعداد دورة الموافقات".' : ''}</div>` : ''}
      <div class="card">
        <div class="card-head"><div><h3>${{ mine: 'مستندات بانتظار اعتمادي', pending: 'كل المستندات المعلّقة', rejected: 'المستندات المرفوضة', approved: 'المستندات المعتمدة' }[tab]}</h3>
          <div class="sub">المستند المعلّق لا يُرحّل ولا يؤثر في الأرصدة حتى يُعتمد من كل المستويات</div></div>
          <div class="spacer"></div>
          <div class="toolbar">
            ${types.length > 1 ? `<select class="input appr-type" id="apprType" aria-label="نوع المستند"><option value="">كل المستندات (${list0.length})</option>${types.map(t => `<option value="${t}" ${t === ftype ? 'selected' : ''}>${esc(modules[t].title)} (${list0.filter(x => x.t === t).length})</option>`).join('')}</select>` : ''}
            ${tab === 'mine' && list.length ? `<button class="btn ghost" id="bulkApprove" ${SEL.size ? '' : 'disabled'}>✓ اعتماد المحدد (<span id="selN">${SEL.size}</span>)</button>
            <button class="btn primary" id="approveAll">✓✓ اعتماد الكل (${list.length})</button>` : ''}
          </div></div>
        <div class="table-wrap"><table>
          <thead><tr>${tab === 'mine' ? `<th><label class="pchk" title="تحديد الكل"><input type="checkbox" id="selAll" ${allOn ? 'checked' : ''}><i>${IC.check}</i></label></th>` : ''}<th>المستند</th><th>الرقم</th><th>التاريخ</th><th>الطرف / البيان</th><th>المبلغ</th><th>الحالة</th><th>أنشأه</th><th></th></tr></thead>
          <tbody>${list.map(({ t, r }) => `<tr class="${tab === 'mine' ? 'appr-row' : ''} ${SEL.has(`${t}|${r.id}`) ? 'picked' : ''}" data-k="${t}|${r.id}">
            ${tab === 'mine' ? `<td><label class="pchk"><input type="checkbox" class="sel" data-t="${t}" data-id="${r.id}" ${SEL.has(`${t}|${r.id}`) ? 'checked' : ''}><i>${IC.check}</i></label></td>` : ''}
            <td><span class="pill">${EMO[t] || ''} ${esc(modules[t].single)}</span></td><td class="code">${esc(docNo(t, r))}</td><td>${esc(r.date || r.month || '')}</td>
            <td>${esc(docParty(r))}</td><td class="num">${QTY_MODULES.includes(t) ? num(amountOf(t, r)) : money(amountOf(t, r))}</td>
            <td>${apprPill(t, r)}${r.appr.status === 'rejected' && r.appr.steps.at(-1)?.note ? `<small class="hint d-block">السبب: ${esc(r.appr.steps.at(-1).note)}</small>` : ''}</td>
            <td>${esc(userName(r.appr.steps?.[0]?.by))}</td>
            <td><div class="row-actions">
              <button data-view="${t}|${r.id}" title="عرض المستند">${icons.open}</button>
              <button data-print="${t}|${r.id}" title="طباعة">${icons.print}</button>
              ${canApprove(t, r) ? `<button class="ok" data-apr="${t}|${r.id}" title="اعتماد">✓</button><button class="del" data-rej="${t}|${r.id}" title="رفض">✕</button>` : ''}
            </div></td></tr>`).join('') || `<tr><td colspan="9" class="empty">${tab === 'mine' ? 'لا توجد مستندات بانتظار اعتمادك 👍' : 'لا توجد مستندات'}</td></tr>`}</tbody>
        </table></div>
      </div>`;
    $$('[data-tab]', content).forEach(b => b.onclick = () => { state.filter = b.dataset.tab; renderPage(); });
    const split = v => v.split('|');
    $$('[data-view]', content).forEach(b => b.onclick = () => { const [t, id] = split(b.dataset.view); viewDoc(t, id); });
    $$('[data-print]', content).forEach(b => b.onclick = () => { const [t, id] = split(b.dataset.print); printDoc(t, db[t].find(x => x.id === id)); });
    $$('[data-apr]', content).forEach(b => b.onclick = () => { const [t, id] = split(b.dataset.apr); if (decide(t, id, true)) { save(); renderNav(); renderPage(); toast(afterDecideMsg(t, id)); } });
    $$('[data-rej]', content).forEach(b => b.onclick = () => { const [t, id] = split(b.dataset.rej); rejectDoc(t, id); });
    $('#apprType')?.addEventListener('change', e => { state.apprType = e.target.value; SEL.clear(); renderPage(); });
    const syncSel = () => { const n = SEL.size; const s = $('#selN'); if (s) s.textContent = n; const b = $('#bulkApprove'); if (b) b.disabled = !n;
      const sa = $('#selAll'); if (sa) sa.checked = list.length > 0 && list.every(x => SEL.has(selKey(x))); };
    const setSel = (k, on) => { if (on) SEL.add(k); else SEL.delete(k); const tr = content.querySelector(`tr[data-k="${CSS.escape(k)}"]`); if (tr) { tr.classList.toggle('picked', on); const c = tr.querySelector('.sel'); if (c) c.checked = on; } };
    $('#selAll')?.addEventListener('change', e => { list.forEach(x => setSel(selKey(x), e.target.checked)); syncSel(); });
    $$('.sel', content).forEach(c => c.addEventListener('change', () => { setSel(`${c.dataset.t}|${c.dataset.id}`, c.checked); syncSel(); }));
    // الضغط على أي مكان في الصف يحدده (ما عدا الأزرار)
    $$('tr.appr-row', content).forEach(tr => tr.addEventListener('click', e => { if (e.target.closest('button, a, label, input')) return; const k = tr.dataset.k; setSel(k, !SEL.has(k)); syncSel(); }));
    const approveMany = keys => {
      let n = 0, fail = 0; keys.forEach(k => { const [t, id] = k.split('|'); if (decide(t, id, true)) n++; else fail++; });
      SEL.clear(); save(); renderNav(); renderPage(); toast(`تم اعتماد ${n} مستند${fail ? ` — وتعذّر ${fail}` : ''}`, 4000);
    };
    $('#bulkApprove')?.addEventListener('click', () => { if (!SEL.size) return toast('اختر مستنداً واحداً على الأقل'); approveMany([...SEL]); });
    $('#approveAll')?.addEventListener('click', () => {
      if (!confirm(`اعتماد كل المستندات المعروضة (${list.length} مستند${ftype ? ` — ${modules[ftype].title}` : ''})؟ سيتم ترحيل قيودها.`)) return;
      approveMany(list.map(selKey));
    });
  }
  const afterDecideMsg = (t, id) => { const r = db[t].find(x => x.id === id); return r?.appr?.status === 'approved' ? `تم الاعتماد النهائي والترحيل — ${docNo(t, r)}` : `تم الاعتماد — المستند انتقل إلى: ${apprText(t, r)}`; };
  function rejectDoc(t, id) {
    openModal('رفض المستند', [{ key: 'note', label: 'سبب الرفض (يظهر لمن أنشأ المستند)', input: 'text', full: true }], {}, d => {
      if (!d.note.trim()) { toast('اكتب سبب الرفض'); return false; }
      if (decide(t, id, false, d.note.trim())) { save(); renderNav(); renderPage(); toast('تم رفض المستند'); }
    });
  }
  function viewDoc(t, id) {
    const r = db[t].find(x => x.id === id); if (!r) return;
    if (can(t, 'e') && r.appr?.status !== 'approved') return openRecordForm(t, r);
    printDoc(t, r, true);
  }

  // ----- إعداد دورة الموافقات -----
  let apprDraft = null;
  function renderApprSetup() {
    const g = apprDraft ??= structuredClone(apprGlobal());
    g.modules ??= {};
    const users = db.appUsers.filter(u => u.active !== false);
    content.innerHTML = `
      <div class="tabs-bar">
        ${[['mine', 'بانتظار اعتمادي'], ['pending', 'كل المعلّق'], ['rejected', 'المرفوض'], ['approved', 'المعتمد']].map(([k, l]) => `<button class="tab-btn" data-tab="${k}">${l}</button>`).join('')}
        <button class="tab-btn on" data-tab="setup">⚙️ إعداد دورة الموافقات</button>
      </div>
      <form id="apprForm">
        <div class="card" style="margin-bottom:16px"><div class="card-body appr-global">
          <label class="check"><input type="checkbox" name="noSelf" ${g.noSelf !== false ? 'checked' : ''}><span>لا يعتمد المستخدم مستنداً أنشأه بنفسه (فصل المهام)</span></label>
          <label class="check"><input type="checkbox" name="adminOverride" ${g.adminOverride !== false ? 'checked' : ''}><span>مدير النظام يستطيع الاعتماد في أي مستوى</span></label>
        </div></div>
        <div class="appr-grid">${APPR_MODULES.map(t => { const c = g.modules[t] ||= { enabled: false, minAmount: 0, levels: [] }; return `
          <div class="card appr-card ${c.enabled ? 'on' : ''}" data-mod="${t}">
            <div class="appr-top">
              <label class="switch"><input type="checkbox" name="en:${t}" ${c.enabled ? 'checked' : ''}><i></i></label>
              <b>${EMO[t] || ''} ${esc(modules[t].title)}</b>
              <span class="spacer"></span>
              <label class="mini">${QTY_MODULES.includes(t) ? 'من كمية' : 'من مبلغ'} <input class="input" type="number" min="0" step="any" name="min:${t}" value="${+c.minAmount || 0}"></label>
            </div>
            <div class="appr-levels">${(c.levels || []).map((l, i) => `
              <div class="appr-level"><div class="lvl-head"><span class="lvl-no">${i + 1}</span>
                <input class="input" name="lt:${t}:${i}" value="${esc(l.title || '')}" placeholder="اسم المستوى، مثل: مراجعة المحاسب">
                <button type="button" class="icon-btn" data-rmlvl="${t}:${i}" title="حذف المستوى">${icons.del}</button></div>
                <div class="lvl-users">${users.map(u => `<label class="chip"><input type="checkbox" name="lu:${t}:${i}" value="${u.id}" ${(l.users || []).includes(u.id) ? 'checked' : ''}><span>${esc(u.name)}</span></label>`).join('') || '<span class="hint">أضف مستخدمين أولاً</span>'}</div>
              </div>`).join('') || '<div class="hint">لا توجد مستويات — أضف مستوى واحداً على الأقل</div>'}
              <button type="button" class="btn ghost add-lvl" data-addlvl="${t}">${icons.plus}إضافة مستوى اعتماد</button>
            </div>
          </div>`; }).join('')}</div>
        <div class="appr-save"><button class="btn primary" type="submit">حفظ دورة الموافقات</button><span class="hint">المستندات التي أُنشئت قبل التفعيل تبقى مرحّلة كما هي</span></div>
      </form>`;
    const collect = () => {
      const f = $('#apprForm'), fd = new FormData(f);
      g.noSelf = !!fd.get('noSelf'); g.adminOverride = !!fd.get('adminOverride');
      APPR_MODULES.forEach(t => {
        const c = g.modules[t];
        c.enabled = !!fd.get(`en:${t}`); c.minAmount = +fd.get(`min:${t}`) || 0;
        c.levels = (c.levels || []).map((l, i) => ({ title: String(fd.get(`lt:${t}:${i}`) || '').trim() || `المستوى ${i + 1}`, users: fd.getAll(`lu:${t}:${i}`) }));
      });
    };
    $$('[data-tab]', content).forEach(b => b.onclick = () => { apprDraft = null; state.filter = b.dataset.tab; renderPage(); });
    $$('[data-addlvl]', content).forEach(b => b.onclick = () => { collect(); const c = g.modules[b.dataset.addlvl]; c.levels.push({ title: `المستوى ${c.levels.length + 1}`, users: [] }); c.enabled = true; renderApprSetup(); });
    $$('[data-rmlvl]', content).forEach(b => b.onclick = () => { collect(); const [t, i] = b.dataset.rmlvl.split(':'); g.modules[t].levels.splice(+i, 1); renderApprSetup(); });
    $$('[name^="en:"]', content).forEach(x => x.onchange = () => x.closest('.appr-card').classList.toggle('on', x.checked));
    $('#apprForm').addEventListener('submit', e => {
      e.preventDefault(); collect();
      const bad = APPR_MODULES.find(t => g.modules[t].enabled && (!g.modules[t].levels.length || g.modules[t].levels.some(l => !l.users.length) && g.adminOverride === false));
      if (bad) return toast(`"${modules[bad].title}": أضف مستوى واحداً على الأقل وحدد من يعتمده`, 4000);
      db.approvalCfg = structuredClone(g); apprDraft = null;
      save({ approvals: true }); renderNav(); toast('تم حفظ دورة الموافقات');
    });
  }

  // ----- طباعة مستند احترافي -----
  const plainText = html => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent.trim(); };
  function printDoc(t, r, previewOnly) {
    if (!r) return;
    const m = modules[t], s = db.settings;
    const fieldRows = m.cols.filter(c => c.input !== 'lines' && c.key !== 'itemsSum').map(c => { const v = val(r, c); if (v === '' || v == null || Array.isArray(v)) return null;
      const txt = c.input === 'number' || c.compute && c.render === money ? (c.render === num ? num(v) : money(v)) : c.render ? plainText(c.render(v, r)) : String(v);
      return [c.label, txt]; }).filter(Boolean);
    const entries = glEntries().filter(e => e.module === t && e.id === r.id);
    const nm = c => acc(c) ? accLabel(acc(c)) : c;
    const html = `
      <div class="doc">
        <div class="doc-head"><div><h1>${esc(s.company || '')}</h1><p>${esc(s.address || '')}${s.taxNo ? ` · رقم التسجيل الضريبي: ${esc(s.taxNo)}` : ''}${s.commercialReg ? ` · س.ت: ${esc(s.commercialReg)}` : ''}</p></div>
          <div class="doc-title"><h2>${esc(t === 'salesInvoices' && saleType(r) ? `فاتورة مبيعات ${saleType(r)}` : t === 'salesReturns' && saleType(r) ? `فاتورة مردودات ${saleType(r)}` : m.single)}</h2><b>${esc(docNo(t, r))}</b><span>${esc(r.date || r.month || '')}</span></div></div>
        <div class="doc-status">${r.appr ? `حالة الاعتماد: <b>${esc(apprText(t, r))}</b>` : 'مستند مرحّل'}</div>
        <table class="doc-fields">${fieldRows.map(([l, v]) => `<tr><th>${esc(l)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
        ${t === 'journal' && jLinesOf(r).length ? `<h3>أطراف القيد</h3><table class="doc-lines"><thead><tr><th>#</th><th>الحساب</th><th>بيان السطر</th><th>مدين</th><th>دائن</th></tr></thead><tbody>
          ${jLinesOf(r).map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.acc)}</td><td>${esc(l.note || '')}</td><td>${+l.dr ? money(l.dr) : ''}</td><td>${+l.cr ? money(l.cr) : ''}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="3">الإجمالي</td><td><b>${money(sum(jLinesOf(r), l => +l.dr || 0))}</b></td><td><b>${money(sum(jLinesOf(r), l => +l.cr || 0))}</b></td></tr></tfoot></table>` : ''}
        ${Array.isArray(r.lines) && r.lines.length ? (() => { const tx = m.cols.some(c => c.tax), tt = docTotals(r); return `<h3>الأصناف</h3><table class="doc-lines"><thead><tr><th>#</th><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>السعر</th>${tx ? '<th>ض.ق.م</th><th>خصم وإضافة</th>' : ''}<th>القيمة</th></tr></thead><tbody>
          ${r.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.item)}</td><td>${esc(l.unit || itemUnit(l.item))}</td><td>${num(l.qty)}</td><td>${money(l.price)}</td>${tx ? `<td>${money(lineVat(l))}</td><td>${money(lineWht(l))}</td>` : ''}<td>${money(lineVal(l) + (tx ? lineVat(l) - lineWht(l) : 0))}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="${tx ? 7 : 5}">${tx ? `القيمة ${money(tt.sub)} + ض.ق.م ${money(tt.vat)} − ض. خصم وإضافة ${money(tt.wht)} = صافي الفاتورة` : 'الإجمالي بالتكلفة'}</td><td><b>${money(tx ? tt.net : tt.sub)}</b></td></tr></tfoot></table>`; })() : ''}
        ${entries.length ? `<h3>القيد المحاسبي</h3><table class="doc-lines"><thead><tr><th>رقم القيد</th><th>الحساب</th><th>مدين</th><th>دائن</th></tr></thead><tbody>
          ${entries.flatMap(e => e.lines.map(l => `<tr><td>${esc(e.no)}</td><td>${esc(nm(l.acc))}</td><td>${l.dr ? money(l.dr) : ''}</td><td>${l.cr ? money(l.cr) : ''}</td></tr>`)).join('')}</tbody></table>`
          : r.appr && r.appr.status !== 'approved' ? '<p class="doc-note">لم يُرحّل القيد بعد — بانتظار اكتمال الاعتمادات</p>' : ''}
        ${r.appr?.steps?.length ? `<h3>سجل الاعتمادات</h3><table class="doc-lines"><thead><tr><th>الإجراء</th><th>المستخدم</th><th>التاريخ</th><th>ملاحظة</th></tr></thead><tbody>
          ${r.appr.steps.map(st => `<tr><td>${ACTION_TXT[st.action] || st.action}${st.action === 'approve' || st.action === 'reject' ? ` (${esc(apprCfg(t)?.levels?.[st.level]?.title || `المستوى ${st.level + 1}`)})` : ''}</td><td>${esc(userName(st.by))}</td><td>${new Date(st.at).toLocaleString((window.UI_LOCALE || 'ar-EG'), { dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(st.note || '')}</td></tr>`).join('')}</tbody></table>` : ''}
        <div class="doc-sign">${['المُعِد', 'المراجع', 'المعتمد', 'المستلم'].map(x => `<div><span>${x}</span><i></i></div>`).join('')}</div>
        <div class="doc-foot">طُبع بواسطة ${esc(curUser()?.name || '')} — ${new Date().toLocaleString((window.UI_LOCALE || 'ar-EG'))}</div>
      </div>`;
    if (previewOnly) { openInfo(`${m.single} ${docNo(t, r)}`, `<div class="doc-preview">${html}</div><div style="margin-top:14px"><button type="button" class="btn primary" id="docPrint">${icons.print}طباعة</button></div>`); $('#docPrint').onclick = () => printDoc(t, r); return; }
    const area = $('#printArea'); area.innerHTML = html;
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); area.innerHTML = ''; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => { window.print(); setTimeout(done, 500); }, 50);
  }

  // =====================================================================
  //                           مركز التقارير
  // كل التقارير تعتمد على المستندات المعتمدة فقط، وبفترة (من / إلى)
  // =====================================================================
  const inRange = (d, f, t) => (!f || String(d) >= f) && (!t || String(d) <= t);
  const docDate = r => r.date || (r.month ? `${r.month}-28` : '');
  const monthOf = d => String(d || '').slice(0, 7);
  const sumBy = (list, keyFn, valFn) => { const m = new Map(); list.forEach(x => { const k = keyFn(x); m.set(k, (m.get(k) || 0) + (+valFn(x) || 0)); }); return m; };
  // حركة الحسابات خلال فترة وقبلها
  const mvBetween = (f, t) => { const m = {}; glEntries().forEach(e => { if (!inRange(e.date, f, t)) return; e.lines.forEach(l => { const x = m[l.acc] ??= { dr: 0, cr: 0 }; x.dr += l.dr; x.cr += l.cr; }); }); return m; };
  const mvBefore = f => { const m = {}; if (!f) return m; glEntries().forEach(e => { if (e.date >= f) return; e.lines.forEach(l => { const x = m[l.acc] ??= { dr: 0, cr: 0 }; x.dr += l.dr; x.cr += l.cr; }); }); return m; };
  const dayDiff = (a, b) => Math.floor((new Date(a) - new Date(b)) / 864e5);
  const M$ = 'money', N$ = 'num';
  const col = (label, type = 'text', o = {}) => ({ label, type, ...o });

  const REPORTS = [
    // ===== التقارير المالية =====
    { id: 'income', group: 'التقارير المالية', title: 'قائمة الدخل للفترة', need: 'reports', run: (f, t) => {
      const mv = mvBetween(f, t), withOpen = !f;
      const amt = a => { const x = mv[a.code] || { dr: 0, cr: 0 }; const base = withOpen ? +a.balance : 0; return a.code[0] === '4' ? base + x.cr - x.dr : base + x.dr - x.cr; };
      const rows = []; let rev = 0, exp = 0;
      [['4', 'الإيرادات'], ['3', 'المصروفات']].forEach(([root, title]) => {
        rows.push({ cls: 'section', cells: [title, '', ''] });
        let tot = 0;
        leafAccounts().filter(a => a.code[0] === root).forEach(a => { const v = amt(a); if (Math.abs(v) < 0.005) return; tot += v; rows.push([a.code, a.name, v]); });
        rows.push({ cls: 'total', cells: [`إجمالي ${title}`, '', tot] });
        root === '4' ? rev = tot : exp = tot;
      });
      rows.push({ cls: 'grand', cells: [rev - exp >= 0 ? 'صافي الربح' : 'صافي الخسارة', '', rev - exp] });
      return { cols: [col('الكود'), col('الحساب'), col('المبلغ', M$)], rows, noTotal: true, note: withOpen ? 'بدون تاريخ بداية: تشمل الأرصدة الافتتاحية' : 'حركة الفترة فقط' };
    } },
    { id: 'cashflow', group: 'التقارير المالية', title: 'حركة النقدية (الخزائن والبنوك)', need: 'cashboxes', run: (f, t) => {
      const mv = mvBetween(f, t), before = mvBefore(f);
      return { cols: [col('الخزينة / البنك'), col('النوع'), col('رصيد أول الفترة', M$), col('مقبوضات', M$), col('مدفوعات', M$), col('رصيد آخر الفترة', M$)],
        rows: db.cashboxes.map(b => { const a = acc(b.accountNo); const o = (a ? +a.balance : 0) + ((before[b.accountNo]?.dr || 0) - (before[b.accountNo]?.cr || 0));
          const i = mv[b.accountNo]?.dr || 0, out = mv[b.accountNo]?.cr || 0; return [b.name, b.type, o, i, out, o + i - out]; }) };
    } },
    { id: 'expgroups', group: 'التقارير المالية', title: 'المصروفات حسب المجموعة', need: 'reports', run: (f, t) => {
      const mv = mvBetween(f, t), withOpen = !f;
      const rows = childrenOf('3').map(g => { const v = sum([...subtree(g.code)].map(acc).filter(a => a && !hasChildren(a.code)), a => (withOpen ? +a.balance : 0) + (mv[a.code]?.dr || 0) - (mv[a.code]?.cr || 0)); return [g.code, g.name, v]; });
      const tot = sum(rows, r => r[2]);
      return { cols: [col('الكود'), col('المجموعة'), col('المبلغ', M$), col('النسبة %', N$, { noSum: true })], rows: rows.map(r => [...r, tot ? +(r[2] / tot * 100).toFixed(1) : 0]) };
    } },
    { id: 'monthly', group: 'التقارير المالية', title: 'الإيرادات والمصروفات شهرياً', need: 'reports', run: (f, t) => {
      const by = {}; glEntries().forEach(e => { if (!inRange(e.date, f, t)) return; const k = monthOf(e.date); const x = by[k] ??= { r: 0, e: 0 };
        e.lines.forEach(l => { if (l.acc[0] === '4') x.r += l.cr - l.dr; if (l.acc[0] === '3') x.e += l.dr - l.cr; }); });
      return { cols: [col('الشهر'), col('الإيرادات', M$), col('المصروفات', M$), col('الصافي', M$)], rows: Object.keys(by).sort().map(k => [k, by[k].r, by[k].e, by[k].r - by[k].e]) };
    } },
    // ===== التقارير المحاسبية =====
    { id: 'tb', group: 'التقارير المحاسبية', title: 'ميزان المراجعة بالمجاميع والأرصدة', need: 'reports', run: (f, t) => {
      const mv = mvBetween(f, t), before = mvBefore(f);
      const rows = db.accounts.filter(a => !hasChildren(a.code) || +a.balance).sort(codeSort).map(a => {
        const deb = isDebitNature(a.code); const ob = deb ? +a.balance : -a.balance;
        const o = ob + (before[a.code]?.dr || 0) - (before[a.code]?.cr || 0); const d = mv[a.code]?.dr || 0, c = mv[a.code]?.cr || 0; const cl = o + d - c;
        return [a.code, a.name, o > 0 ? o : 0, o < 0 ? -o : 0, d, c, cl > 0 ? cl : 0, cl < 0 ? -cl : 0];
      }).filter(r => r.slice(2).some(v => Math.abs(v) > 0.005));
      return { cols: [col('الكود'), col('الحساب'), col('افتتاحي مدين', M$), col('افتتاحي دائن', M$), col('حركة مدين', M$), col('حركة دائن', M$), col('ختامي مدين', M$), col('ختامي دائن', M$)], rows };
    } },
    { id: 'daybook', group: 'التقارير المحاسبية', title: 'دفتر اليومية للفترة', need: 'journal', run: (f, t) => {
      const nm = c => acc(c) ? accLabel(acc(c)) : c;
      const rows = glEntries().filter(e => inRange(e.date, f, t)).sort(byDate).flatMap(e => e.lines.map(l => [e.date, e.no, e.src, e.desc, nm(l.acc), l.dr, l.cr]));
      return { cols: [col('التاريخ'), col('رقم القيد'), col('المصدر'), col('البيان'), col('الحساب'), col('مدين', M$), col('دائن', M$)], rows };
    } },
    { id: 'araging', group: 'التقارير المحاسبية', title: 'أعمار ديون العملاء', need: 'customers', dateOnly: true, run: (f, t) => {
      const asOf = t || today();
      const rows = db.customers.map(c => {
        const b = [0, 0, 0, 0, 0];
        eff('salesInvoices').filter(i => i.customer === c.name && i.date <= asOf).forEach(i => { const rem = invTotal(i) - salesPaid(i); if (rem <= 0.005) return;
          const d = dayDiff(asOf, i.due || i.date); b[d <= 0 ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : d <= 90 ? 3 : 4] += rem; });
        const bal = custBal(c.name); const other = bal - sum(b, x => x);
        return [c.name, c.category || '', ...b, other, bal];
      }).filter(r => Math.abs(r.at(-1)) > 0.005);
      return { cols: [col('العميل'), col('التصنيف'), col('غير مستحق', M$), col('1-30 يوم', M$), col('31-60 يوم', M$), col('61-90 يوم', M$), col('أكثر من 90', M$), col('أرصدة سابقة/غير موزعة', M$), col('الرصيد', M$)], rows, note: `حتى تاريخ ${asOf} — حسب تاريخ الاستحقاق` };
    } },
    { id: 'apaging', group: 'التقارير المحاسبية', title: 'أعمار ديون الموردين', need: 'suppliers', dateOnly: true, run: (f, t) => {
      const asOf = t || today();
      const rows = db.suppliers.map(s => {
        const b = [0, 0, 0, 0, 0];
        eff('purchaseInvoices').filter(i => i.supplier === s.name && i.date <= asOf).forEach(i => { const rem = +i.amount - purchPaid(i); if (rem <= 0.005) return;
          const d = dayDiff(asOf, i.due || i.date); b[d <= 0 ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : d <= 90 ? 3 : 4] += rem; });
        const bal = suppBal(s.name); return [s.name, s.category || '', ...b, bal - sum(b, x => x), bal];
      }).filter(r => Math.abs(r.at(-1)) > 0.005);
      return { cols: [col('المورد'), col('التصنيف'), col('غير مستحق', M$), col('1-30 يوم', M$), col('31-60 يوم', M$), col('61-90 يوم', M$), col('أكثر من 90', M$), col('أرصدة سابقة/غير موزعة', M$), col('الرصيد', M$)], rows, note: `حتى تاريخ ${asOf}` };
    } },
    { id: 'partybal', group: 'التقارير المحاسبية', title: 'أرصدة العملاء والموردين حسب التصنيف', need: 'customers', noDate: true, run: () => ({
      cols: [col('النوع'), col('التصنيف'), col('الاسم'), col('الرصيد', M$)],
      rows: [...db.customers.map(c => ['عميل', c.category || '', c.name, custBal(c.name)]), ...db.suppliers.map(s => ['مورد', s.category || '', s.name, suppBal(s.name)])]
        .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1], 'ar')) }) },
    // ===== الخزينة =====
    { id: 'treasuryDaily', group: 'الخزينة', title: 'حركة الخزينة اليومية', need: 'receipts', run: (f, t) => {
      const days = {}; const addD = (d, k, v) => { if (!inRange(d, f, t)) return; (days[d] ??= { r: 0, p: 0, tr: 0 })[k] += +v || 0; };
      eff('receipts').forEach(r => addD(r.date, 'r', r.amount)); eff('payments').forEach(r => addD(r.date, 'p', r.amount)); eff('boxTransfers').forEach(r => addD(r.date, 'tr', r.amount));
      return { cols: [col('التاريخ'), col('المقبوضات', M$), col('المدفوعات', M$), col('الصافي', M$), col('تحويلات داخلية', M$)], rows: Object.keys(days).sort().map(d => [d, days[d].r, days[d].p, days[d].r - days[d].p, days[d].tr]) };
    } },
    { id: 'payParties', group: 'الخزينة', title: 'المدفوعات حسب المستفيد / الحساب', need: 'payments', run: (f, t) => {
      const m = sumBy(eff('payments').filter(r => inRange(r.date, f, t)), r => r.party === 'أخرى' ? `أخرى: ${r.account || ''}` : r.party, r => r.amount);
      return { cols: [col('المستفيد'), col('المبلغ', M$)], rows: [...m].sort((a, b) => b[1] - a[1]) };
    } },
    // ===== البنوك والشيكات =====
    { id: 'chqCollect', group: 'البنوك والشيكات', title: 'الشيكات تحت التحصيل', need: 'receipts', dateOnly: true, run: (f, t) => {
      const asOf = t || today();
      const rows = eff('receipts').filter(r => chqOpen(r) && r.date <= asOf).sort((a, b) => String(a.chequeDate).localeCompare(String(b.chequeDate))).map(r => {
        const d = dayDiff(r.chequeDate || r.date, asOf);
        return { cells: [r.chequeNo, r.no, r.date, r.party === 'أخرى' ? r.beneficiary || 'أخرى' : r.party, r.benBank || '', r.box, r.chequeDate, d > 0 ? `يستحق بعد ${d} يوم` : d === 0 ? 'مستحق اليوم' : `متأخر ${-d} يوم`, r.amount], cls: d < 0 ? 'warn' : '' };
      });
      return { cols: [col('رقم الشيك'), col('رقم السند'), col('تاريخ الاستلام'), col('العميل / المودِع'), col('بنك الشيك'), col('مودَع في'), col('تاريخ الاستحقاق'), col('الموقف'), col('المبلغ', M$)], rows,
        note: `الشيكات الواردة التي لم تُحصّل حتى ${asOf} — بعد التحصيل اضغط ✓ في صفحة البنك أو غيّر حالة الشيك في السند` };
    } },
    { id: 'chqDue', group: 'البنوك والشيكات', title: 'الشيكات المستحقة (الواردة والصادرة)', need: 'receipts', run: (f, t) => {
      const to = t || today(), ref = today();
      const pick = (tb, kind) => eff(tb).filter(r => chqOpen(r) && inRange(r.chequeDate || r.date, f, to)).map(r => ({ r, kind }));
      const list = [...pick('receipts', 'وارد — للتحصيل'), ...(can('payments') ? pick('payments', 'صادر — للصرف') : [])].sort((a, b) => String(a.r.chequeDate).localeCompare(String(b.r.chequeDate)));
      const rows = list.map(({ r, kind }) => { const d = dayDiff(ref, r.chequeDate || r.date), inc = kind.startsWith('وارد');
        return { cells: [r.chequeDate, kind, r.chequeNo, r.no, r.party === 'أخرى' ? r.beneficiary || 'أخرى' : r.beneficiary || r.party, r.box, r.benBank || '', d > 0 ? `متأخر ${d} يوم` : d === 0 ? 'اليوم' : `بعد ${-d} يوم`, inc ? +r.amount : 0, inc ? 0 : +r.amount], cls: d > 0 ? 'warn' : '' }; });
      const inc = sum(list.filter(x => x.kind.startsWith('وارد')), x => +x.r.amount), out = sum(list.filter(x => !x.kind.startsWith('وارد')), x => +x.r.amount);
      return { cols: [col('تاريخ الاستحقاق'), col('النوع'), col('رقم الشيك'), col('رقم السند'), col('الطرف / المستفيد'), col('البنك'), col('بنك الشيك / المستفيد'), col('الموقف'), col('وارد', M$), col('صادر', M$)], rows,
        note: `الشيكات التي يحل استحقاقها ${f ? `من ${f} ` : ''}حتى ${to} ولم تُحصّل أو تُصرف بعد — صافي: ${money(inc - out)}` };
    } },
    // ===== المبيعات =====
    { id: 'salesCust', group: 'المبيعات', title: 'المبيعات حسب العميل', need: 'salesInvoices', run: (f, t) => {
      const inv = eff('salesInvoices').filter(r => inRange(r.date, f, t)), ret = eff('salesReturns').filter(r => inRange(r.date, f, t)), rec = eff('receipts').filter(r => inRange(r.date, f, t));
      const rows = db.customers.map(c => { const iv = inv.filter(i => i.customer === c.name); const net = sum(iv, i => i.amount), vat = sum(iv, vatOf);
        return [c.name, c.category || '', iv.length, net, vat, net + vat, sum(ret.filter(r => r.customer === c.name), r => r.amount), sum(rec.filter(r => r.party === c.name), r => r.amount), custBal(c.name)]; })
        .filter(r => r[2] || r[6] || r[7]);
      return { cols: [col('العميل'), col('التصنيف'), col('عدد الفواتير', N$), col('الصافي', M$), col('الضريبة', M$), col('الإجمالي', M$), col('المرتجعات', M$), col('المحصّل', M$), col('الرصيد الحالي', M$, { noSum: false })], rows };
    } },
    { id: 'salesCat', group: 'المبيعات', title: 'المبيعات حسب تصنيف العملاء', need: 'salesInvoices', run: (f, t) => {
      const cat = n => db.customers.find(c => c.name === n)?.category || 'بدون تصنيف';
      const inv = sumBy(eff('salesInvoices').filter(r => inRange(r.date, f, t)), r => cat(r.customer), r => r.amount);
      const ret = sumBy(eff('salesReturns').filter(r => inRange(r.date, f, t)), r => cat(r.customer), r => r.amount);
      const keys = [...new Set([...custCats(), ...inv.keys(), ...ret.keys()])];
      return { cols: [col('التصنيف'), col('المبيعات', M$), col('المرتجعات', M$), col('صافي المبيعات', M$)], rows: keys.map(k => [k, inv.get(k) || 0, ret.get(k) || 0, (inv.get(k) || 0) - (ret.get(k) || 0)]) };
    } },
    { id: 'salesMonth', group: 'المبيعات', title: 'المبيعات الشهرية', need: 'salesInvoices', run: (f, t) => {
      const list = eff('salesInvoices').filter(r => inRange(r.date, f, t)); const months = [...new Set(list.map(r => monthOf(r.date)))].sort();
      return { cols: [col('الشهر'), col('عدد الفواتير', N$), col('الصافي', M$), col('الضريبة', M$), col('الإجمالي', M$)],
        rows: months.map(m => { const l = list.filter(r => monthOf(r.date) === m); return [m, l.length, sum(l, r => r.amount), sum(l, vatOf), sum(l, invTotal)]; }) };
    } },
    // ===== تقرير المبيعات: تقرير واحد يُشكَّل بالكامل — تفصيلي أو إجمالي، تجميع حتى 3 مستويات، واختيار الأعمدة =====
    ...(() => {
      const lmLines = (f, t, F) => {
        const ok = r => inRange(r.date, f, t) && (!F.stype || saleType(r) === F.stype) && (!F.branch || (F.branch === '__none' ? !docBranch(r) : docBranch(r) === F.branch)) && (!F.cust || r.customer === F.cust);
        const out = [];
        [['salesInvoices', 1], ['salesReturns', -1]].forEach(([tb, sg]) => eff(tb).filter(ok).forEach(r => {
          const ls = linesOf(r).length ? linesOf(r) : [{ item: '—', qty: 0, value: +r.amount }];
          ls.forEach(l => { if (F.item && l.item !== F.item) return; if (F.itype && (l.itype || '') !== F.itype) return;
            out.push({ r, sg, tb, item: l.item, itype: l.itype || '', unit: l.unit || '', qty: sg * (+l.qty || 0), count: sg * (+l.count || 0), weight: sg * lineWeight(l), price: +l.price || 0,
              value: sg * lineVal(l), disc: sg * (+l.disc || 0), pack: sg * (+l.pack || 0), total: sg * lineTot(l), branch: docBranch(r) || '—' }); }); }));
        return out;
      };
      // أبعاد التجميع (inv: البعد على مستوى الفاتورة فيُجمع عدد الفواتير بأمان)
      const DIMS = {
        branch: { label: 'الفرع', key: l => l.branch, inv: true }, cust: { label: 'العميل', key: l => l.r.customer || '—', inv: true },
        item: { label: 'الصنف', key: l => l.item }, itemType: { label: 'الصنف ونوعه', key: l => l.itype ? `${l.item} — ${l.itype}` : l.item }, itype: { label: 'نوع الصنف', key: l => l.itype || '—' },
        month: { label: 'الشهر', key: l => String(l.r.date || '').slice(0, 7), inv: true, sort: 'asc' }, day: { label: 'اليوم', key: l => l.r.date || '', inv: true, sort: 'asc' },
        stype: { label: 'نوع المبيعات', key: l => saleType(l.r) || '—', inv: true },
      };
      const MEAS = {
        n: { label: 'عدد الفواتير', type: N$, v: g => g.inv.size }, qty: { label: 'الكمية', type: N$, v: g => sum(g.ls, l => l.qty) }, weight: { label: 'إجمالي الوزن', type: N$, v: g => sum(g.ls, l => l.weight) },
        value: { label: 'إجمالي القيمة', type: M$, v: g => sum(g.ls, l => l.value) }, disc: { label: 'الخصم', type: M$, v: g => sum(g.ls, l => l.disc) }, pack: { label: 'مواد التعبئة', type: M$, v: g => sum(g.ls, l => l.pack) },
        total: { label: 'إجمالي مدين', type: M$, v: g => sum(g.ls, l => l.total) },
        // متوسط السعر = إجمالي مدين ÷ إجمالي الوزن
        avg: { label: 'متوسط السعر (مدين ÷ الوزن)', type: M$, noSum: true, v: g => { const w = sum(g.ls, l => l.weight); return w ? +(sum(g.ls, l => l.total) / w).toFixed(2) : 0; } },
        pct: { label: 'النسبة %', type: N$, noSum: true, v: (g, tot) => tot ? +(sum(g.ls, l => l.total) / tot * 100).toFixed(1) : 0 },
      };
      const grp = ls => ({ ls, inv: new Set(ls.map(l => l.tb + l.r.id)) });
      const subtotalCells = (levels, depth, label, ms, g, tot) => [...levels.map((_, i) => i === depth ? `إجمالي ${label}` : ''), ...ms.map(k => MEAS[k].v(g, tot))];
      const MS0 = ['n', 'qty', 'weight', 'value', 'disc', 'pack', 'total', 'pct'];
      return [{ id: 'salesRep', group: 'المبيعات', title: 'تقرير المبيعات', need: 'salesInvoices', builder: true, detailLabel: 'تفصيلي (سطر لكل صنف)',
        defaults: () => ({ stype: 'السوق المحلي', branch: '', cust: '', item: '', itype: '', mode: 'sum', g1: 'branch', g2: '', g3: '', ms: [...MS0] }),
        dims: [['branch', 'الفرع'], ['cust', 'العميل'], ['item', 'الصنف'], ['itemType', 'الصنف ونوعه'], ['itype', 'نوع الصنف'], ['month', 'الشهر'], ['day', 'اليوم'], ['stype', 'نوع المبيعات']],
        meas: [['n', 'عدد الفواتير'], ['qty', 'الكمية'], ['weight', 'إجمالي الوزن'], ['value', 'إجمالي القيمة'], ['disc', 'الخصم'], ['pack', 'مواد التعبئة'], ['total', 'إجمالي مدين'], ['avg', 'متوسط السعر'], ['pct', 'النسبة %']],
        onFilter: (F, k) => { if (k === 'item' || k === 'stype') F.itype = ''; },
        filterUI: F => { const base = eff('salesInvoices').concat(eff('salesReturns')).filter(r => !F.stype || saleType(r) === F.stype), lines = base.flatMap(r => linesOf(r));
          return [['stype', 'نوع المبيعات', SALE_TYPES.map(([, t]) => t), 'كل الأنواع'], ['branch', 'الفرع', [...db.branches.map(b => b.name), ['__none', 'بدون فرع']], 'كل الفروع'],
            ['cust', 'العميل', [...new Set(base.map(r => r.customer).filter(Boolean))].sort(), 'كل العملاء'], ['item', 'الصنف', [...new Set(lines.map(l => l.item).filter(Boolean))].sort(), 'كل الأصناف'],
            ['itype', 'نوع الصنف', [...new Set(lines.filter(l => !F.item || l.item === F.item).map(l => l.itype).filter(Boolean))].sort(), 'كل الأنواع']]; },
        run: (f, t, F) => {
        const ls = lmLines(f, t, F), tot = sum(ls, l => l.total);
        const levels = [F.g1, F.g2, F.g3].filter((k, i, arr) => k && DIMS[k] && arr.indexOf(k) === i);
        // في التفصيلي: عدد الفواتير ومتوسط السعر بلا معنى لكل سطر (السعر ظاهر في عمود سعر الوحدة)
        const ms = (F.ms && F.ms.length ? F.ms : ['n', 'qty', 'weight', 'value', 'disc', 'pack', 'total', 'pct']).filter(k => MEAS[k] && !(F.mode === 'detail' && (k === 'n' || k === 'avg')));
        const invSafe = levels.every(k => DIMS[k].inv);
        const mcols = ms.map(k => col(MEAS[k].label, MEAS[k].type, { noSum: MEAS[k].noSum || (k === 'n' && (!invSafe || F.mode === 'detail')) }));
        const note = `${F.mode === 'detail' ? 'تفصيلي' : 'إجمالي'}${levels.length ? ' حسب ' + levels.map(k => DIMS[k].label).join(' ← ') : ''} · ${F.stype || 'كل أنواع المبيعات'} · ${F.branch ? (F.branch === '__none' ? 'بدون فرع' : F.branch) : 'كل الفروع'}${F.cust ? ' · ' + F.cust : ''}${F.item ? ' · ' + F.item : ''}${F.itype ? ' (' + F.itype + ')' : ''}`;
        // ترتيب المجموعات: بالأكبر قيمة، والتواريخ تصاعدياً
        const order = (k, entries) => entries.sort((p, q) => DIMS[k].sort === 'asc' ? String(p[0]).localeCompare(String(q[0])) : sum(q[1], l => l.total) - sum(p[1], l => l.total));
        const split = (k, arr) => { const m = new Map(); arr.forEach(l => { const v = DIMS[k].key(l); (m.get(v) || m.set(v, []).get(v)).push(l); }); return order(k, [...m]); };
        if (F.mode === 'detail') {
          const DET = [col('التاريخ'), col('رقم الفاتورة'), col('رقم المستند'), col('الفرع'), col('العميل'), col('الصنف'), col('نوع الصنف'), col('الوحدة'), col('سعر الوحدة', M$, { noSum: true })];
          const lineCells = l => [l.r.date, l.r.no + (l.sg < 0 ? ' (مردود)' : ''), l.r.docNo || '', l.branch, l.r.customer, l.item, l.itype || '—', l.unit, l.price, ...ms.map(k => k === 'n' ? 1 : k === 'avg' ? l.price : k === 'pct' ? (tot ? +(l.total / tot * 100).toFixed(2) : 0) : l[k])];
          const sorted = [...ls].sort((p, q) => byDate(p.r, q.r) || String(p.r.no).localeCompare(String(q.r.no)));
          const rows = [];
          const walk = (arr, d) => { if (d >= levels.length) { arr.forEach(l => rows.push(lineCells(l))); return; }
            split(levels[d], arr).forEach(([v, sub]) => { rows.push({ cls: 'section', cells: [`${DIMS[levels[d]].label}: ${v}`, ...Array(DET.length + ms.length - 1).fill('')] }); walk(sub, d + 1);
              const g = grp(sub); rows.push({ cls: 'total', cells: [`إجمالي ${v}`, ...Array(DET.length - 1).fill(''), ...ms.map(k => MEAS[k].v(g, tot))] }); }); };
          walk(sorted, 0);
          return { cols: [...DET, ...mcols], rows, note: note + ` · ${ls.length} سطر` };
        }
        if (!levels.length) { const g = grp(ls); return { cols: [col('البيان'), ...mcols], rows: ls.length ? [['كل المبيعات', ...ms.map(k => MEAS[k].v(g, tot))]] : [], note }; }
        const rows = [];
        // صفوف أول كل مجموعة تحمل اسمها، والباقي فارغ للقراءة
        const walk2 = (arr, d, prefix) => split(levels[d], arr).forEach(([v, sub]) => {
          if (d === levels.length - 1) { rows.push([...prefix, v, ...ms.map(k => MEAS[k].v(grp(sub), tot))]); prefix = prefix.map(() => ''); return; }
          walk2(sub, d + 1, [...prefix, v]); prefix = prefix.map(() => '');
          rows.push({ cls: 'total', cells: subtotalCells(levels, d, v, ms, grp(sub), tot) });
        });
        walk2(ls, 0, []);
        return { cols: [...levels.map(k => col(DIMS[k].label)), ...mcols], rows, note: note + ` · ${ls.length} سطر`, dims: DIMS, meas: MEAS };
      } }];
    })(),
    // ===== تقرير المشتريات: نفس المنشئ — فواتير المشتريات واستحقاقات الموردين وأذون الإضافة من مورد، والمرتجعات بالسالب =====
    ...(() => {
      const PDOC = { purchaseInvoices: 'فاتورة مشتريات', supplierAccruals: 'استحقاق مورد', stockIn: 'إذن إضافة', purchaseReturns: 'مرتجع مشتريات' };
      const accName = v => acc(accCode(v))?.name || accCode(v) || '—';
      const purLines = (f, t, F) => {
        const out = [];
        const push = (tb, r, sg, o) => {
          const x = { r, tb, sg, doc: PDOC[tb], supplier: o.supplier || '—', supAcc: o.supAcc || '—', branch: docBranch(r) || '—', item: o.item || '—', unit: o.unit || '', price: +o.price || 0,
            qty: sg * (+o.qty || 0), value: sg * (+o.value || 0), vat: sg * (+o.vat || 0), wht: sg * (+o.wht || 0) };
          x.net = x.value + x.vat - x.wht;
          if (F.doc && x.tb !== F.doc) return; if (F.supAcc && x.supAcc !== F.supAcc) return; if (F.supplier && x.supplier !== F.supplier) return;
          if (F.branch && (F.branch === '__none' ? x.branch !== '—' : x.branch !== F.branch)) return; if (F.item && x.item !== F.item) return;
          out.push(x);
        };
        const inR = r => inRange(r.date, f, t);
        eff('purchaseInvoices').filter(inR).forEach(r => push('purchaseInvoices', r, 1, { supplier: r.supplier, supAcc: accName(r.sacc || suppAcc(r.supplier)), item: accName(r.store || r.expAcc || r.account || SYS.defPurchase), value: r.amount }));
        eff('supplierAccruals').filter(inR).forEach(r => push('supplierAccruals', r, 1, { supplier: r.party, supAcc: accName(r.account || suppAcc(r.party)), item: accName(r.store || r.expAcc), value: r.amount }));
        eff('stockIn').filter(r => inR(r) && r.supplier).forEach(r => linesOf(r).forEach(l => push('stockIn', r, 1, { supplier: r.supplier, supAcc: accName(suppAcc(r.supplier)), item: l.item, unit: l.unit, price: l.price, qty: l.qty,
          value: lineVal(l), vat: lineVat(l), wht: lineWht(l) })));
        eff('purchaseReturns').filter(inR).forEach(r => push('purchaseReturns', r, -1, { supplier: r.supplier, supAcc: accName(suppAcc(r.supplier)), item: accName(r.account || SYS.defPurchase), value: r.amount }));
        return out;
      };
      const DIMS = {
        branch: { label: 'الفرع', key: l => l.branch, inv: true }, supplier: { label: 'المورد', key: l => l.supplier, inv: true }, supAcc: { label: 'حساب المورد (نوعه)', key: l => l.supAcc, inv: true },
        item: { label: 'الصنف / الحساب', key: l => l.item }, doc: { label: 'نوع المستند', key: l => l.doc, inv: true },
        month: { label: 'الشهر', key: l => String(l.r.date || '').slice(0, 7), inv: true, sort: 'asc' }, day: { label: 'اليوم', key: l => l.r.date || '', inv: true, sort: 'asc' },
      };
      const MEAS = {
        n: { label: 'عدد المستندات', type: N$, v: g => g.inv.size }, qty: { label: 'الكمية', type: N$, v: g => sum(g.ls, l => l.qty) },
        value: { label: 'القيمة', type: M$, v: g => sum(g.ls, l => l.value) }, vat: { label: 'ض.ق.م', type: M$, v: g => sum(g.ls, l => l.vat) }, wht: { label: 'ض. خصم وإضافة', type: M$, v: g => sum(g.ls, l => l.wht) },
        net: { label: 'الصافي (دائن للمورد)', type: M$, v: g => sum(g.ls, l => l.net) },
        avg: { label: 'متوسط السعر', type: M$, noSum: true, v: g => { const q = sum(g.ls, l => l.qty); return q ? +(sum(g.ls, l => l.value) / q).toFixed(2) : 0; } },
        pct: { label: 'النسبة %', type: N$, noSum: true, v: (g, tot) => tot ? +(sum(g.ls, l => l.net) / tot * 100).toFixed(1) : 0 },
      };
      const grp = ls => ({ ls, inv: new Set(ls.map(l => l.tb + l.r.id)) });
      const MS0 = ['n', 'qty', 'value', 'vat', 'wht', 'net', 'pct'];
      return [{ id: 'purRep', group: 'المشتريات', title: 'تقرير المشتريات', need: 'purchaseInvoices', builder: true, detailLabel: 'تفصيلي (سطر لكل مستند / صنف)',
        defaults: () => ({ supAcc: '', branch: '', supplier: '', item: '', doc: '', mode: 'sum', g1: 'supplier', g2: '', g3: '', ms: [...MS0] }),
        dims: Object.entries(DIMS).map(([k, d]) => [k, d.label]), meas: Object.entries(MEAS).map(([k, m]) => [k, m.label]),
        filterUI: F => { const all = purLines('', '', {});
          return [['doc', 'نوع المستند', Object.entries(PDOC), 'كل المستندات'], ['supAcc', 'حساب المورد (نوعه)', [...new Set(all.map(l => l.supAcc))].sort(), 'كل الأنواع'],
            ['branch', 'الفرع', [...db.branches.map(b => b.name), ['__none', 'بدون فرع']], 'كل الفروع'], ['supplier', 'المورد', [...new Set(all.filter(l => !F.supAcc || l.supAcc === F.supAcc).map(l => l.supplier))].sort(), 'كل الموردين'],
            ['item', 'الصنف / الحساب', [...new Set(all.map(l => l.item))].sort(), 'الكل']]; },
        run: (f, t, F) => {
          const ls = purLines(f, t, F), tot = sum(ls, l => l.net);
          const levels = [F.g1, F.g2, F.g3].filter((k, i, arr) => k && DIMS[k] && arr.indexOf(k) === i);
          const ms = (F.ms && F.ms.length ? F.ms : MS0).filter(k => MEAS[k] && !(F.mode === 'detail' && (k === 'n' || k === 'avg')));
          const invSafe = levels.every(k => DIMS[k].inv);
          const mcols = ms.map(k => col(MEAS[k].label, MEAS[k].type, { noSum: MEAS[k].noSum || (k === 'n' && !invSafe) }));
          const note = `${F.mode === 'detail' ? 'تفصيلي' : 'إجمالي'}${levels.length ? ' حسب ' + levels.map(k => DIMS[k].label).join(' ← ') : ''} · ${F.doc ? PDOC[F.doc] : 'كل المستندات'} · ${F.branch ? (F.branch === '__none' ? 'بدون فرع' : F.branch) : 'كل الفروع'}${F.supAcc ? ' · ' + F.supAcc : ''}${F.supplier ? ' · ' + F.supplier : ''}${F.item ? ' · ' + F.item : ''}`;
          const order = (k, entries) => entries.sort((p, q) => DIMS[k].sort === 'asc' ? String(p[0]).localeCompare(String(q[0])) : sum(q[1], l => l.net) - sum(p[1], l => l.net));
          const split = (k, arr) => { const m = new Map(); arr.forEach(l => { const v = DIMS[k].key(l); (m.get(v) || m.set(v, []).get(v)).push(l); }); return order(k, [...m]); };
          if (F.mode === 'detail') {
            const DET = [col('التاريخ'), col('نوع المستند'), col('الرقم'), col('رقم المستند'), col('الفرع'), col('المورد'), col('الصنف / الحساب'), col('الوحدة'), col('السعر', M$, { noSum: true })];
            const lineCells = l => [l.r.date, l.doc, l.r.no || '', l.r.docNo || '', l.branch, l.supplier, l.item, l.unit, l.price, ...ms.map(k => k === 'pct' ? (tot ? +(l.net / tot * 100).toFixed(2) : 0) : l[k])];
            const rows = [];
            const walk = (arr, d) => { if (d >= levels.length) { arr.forEach(l => rows.push(lineCells(l))); return; }
              split(levels[d], arr).forEach(([v, sub]) => { rows.push({ cls: 'section', cells: [`${DIMS[levels[d]].label}: ${v}`, ...Array(DET.length + ms.length - 1).fill('')] }); walk(sub, d + 1);
                const g = grp(sub); rows.push({ cls: 'total', cells: [`إجمالي ${v}`, ...Array(DET.length - 1).fill(''), ...ms.map(k => MEAS[k].v(g, tot))] }); }); };
            walk([...ls].sort((p, q) => byDate(p.r, q.r) || String(p.r.no).localeCompare(String(q.r.no))), 0);
            return { cols: [...DET, ...mcols], rows, note: note + ` · ${ls.length} سطر` };
          }
          if (!levels.length) { const g = grp(ls); return { cols: [col('البيان'), ...mcols], rows: ls.length ? [['كل المشتريات', ...ms.map(k => MEAS[k].v(g, tot))]] : [], note }; }
          const rows = [];
          const walk2 = (arr, d, prefix) => split(levels[d], arr).forEach(([v, sub]) => {
            if (d === levels.length - 1) { rows.push([...prefix, v, ...ms.map(k => MEAS[k].v(grp(sub), tot))]); prefix = prefix.map(() => ''); return; }
            walk2(sub, d + 1, [...prefix, v]); prefix = prefix.map(() => '');
            rows.push({ cls: 'total', cells: [...levels.map((_, i) => i === d ? `إجمالي ${v}` : ''), ...ms.map(k => MEAS[k].v(grp(sub), tot))] });
          });
          walk2(ls, 0, []);
          return { cols: [...levels.map(k => col(DIMS[k].label)), ...mcols], rows, note: note + ` · ${ls.length} سطر` };
        } }];
    })(),
    // ===== المشتريات =====
    { id: 'purSupp', group: 'المشتريات', title: 'المشتريات حسب المورد', need: 'purchaseInvoices', run: (f, t) => {
      const inv = eff('purchaseInvoices').filter(r => inRange(r.date, f, t)), ret = eff('purchaseReturns').filter(r => inRange(r.date, f, t)), pay = eff('payments').filter(r => inRange(r.date, f, t));
      const rows = db.suppliers.map(s => { const iv = inv.filter(i => i.supplier === s.name);
        return [s.name, s.category || '', iv.length, sum(iv, i => i.amount), sum(ret.filter(r => r.supplier === s.name), r => r.amount), sum(pay.filter(r => r.party === s.name), r => r.amount), suppBal(s.name)]; })
        .filter(r => r[2] || r[4] || r[5]);
      return { cols: [col('المورد'), col('التصنيف'), col('عدد الفواتير', N$), col('المشتريات', M$), col('المرتجعات', M$), col('المسدد', M$), col('المستحق له', M$)], rows };
    } },
    { id: 'suppAccr', group: 'المشتريات', title: 'استحقاقات الموردين حسب الحساب والفترة', need: 'supplierAccruals', run: (f, t) => {
      const list = eff('supplierAccruals').filter(r => inRange(r.date, f, t)).sort((a, b) => String(a.account).localeCompare(String(b.account)) || String(a.party).localeCompare(String(b.party), 'ar') || byDate(a, b));
      const rows = []; let last = null;
      list.forEach(r => { const a = acc(accCode(r.account))?.name || '';
        if (a !== last) { const g = list.filter(x => (acc(accCode(x.account))?.name || '') === a); rows.push({ cells: [a, `${g.length} استحقاق`, '', '', sum(g, x => +x.amount)], cls: 'section' }); last = a; }
        rows.push([r.party, r.store ? `مستند ${r.docNo || '—'}${r.branch ? ' · ' + r.branch : ''}` : periodText(r), r.no, acc(accCode(r.store || r.expAcc))?.name || '', +r.amount]); });
      return { cols: [col('المورد'), col('الفترة / المستند'), col('رقم الحركة'), col('الحساب المقابل'), col('المبلغ المستحق', M$)], rows, note: 'مجمّعة حسب اسم الحساب (فئة المورد)' };
    } },
    { id: 'purCat', group: 'المشتريات', title: 'المشتريات حسب تصنيف الموردين', need: 'purchaseInvoices', run: (f, t) => {
      const cat = n => db.suppliers.find(s => s.name === n)?.category || 'بدون تصنيف';
      const inv = sumBy(eff('purchaseInvoices').filter(r => inRange(r.date, f, t)), r => cat(r.supplier), r => r.amount);
      const keys = [...new Set([...suppCats(), ...inv.keys()])];
      return { cols: [col('التصنيف'), col('المشتريات', M$)], rows: keys.map(k => [k, inv.get(k) || 0]) };
    } },
    // ===== المخازن =====
    { id: 'stkMove', group: 'المخازن', title: 'حركة الأصناف للفترة', need: 'items', run: (f, t) => {
      const q = (list, it, sign, fieldWh) => sum(list.filter(r => r.item === it), r => baseQty(r) * sign);
      const rows = db.items.map(it => {
        const before = r => f && r.date < f, within = r => inRange(r.date, f, t);
        const IN = [...stockRows('stockIn'), ...stockRows('salesReturns'), ...eff('openingBalances').filter(r => r.otype === OPEN_TYPES[1])], OUT = [...stockRows('stockOut'), ...stockRows('salesInvoices')];
        const open = +it.opening + q(IN.filter(before), it.name, 1) - q(OUT.filter(before), it.name, 1);
        const inn = q(IN.filter(within), it.name, 1), out = q(OUT.filter(within), it.name, 1);
        const close = open + inn - out;
        return [it.code, it.name, it.unit, open, inn, out, close, close * it.cost];
      });
      return { cols: [col('الكود'), col('الصنف'), col('الوحدة'), col('رصيد أول الفترة', N$), col('وارد', N$), col('منصرف', N$), col('رصيد آخر الفترة', N$), col('القيمة بالتكلفة', M$)], rows };
    } },
    { id: 'stkLow', group: 'المخازن', title: 'أصناف تحت حد الطلب', need: 'items', noDate: true, run: () => ({
      cols: [col('الكود'), col('الصنف'), col('المجموعة'), col('الرصيد', N$), col('حد الطلب', N$), col('العجز', N$)],
      rows: db.items.filter(i => itemQty(i.name) < +i.min).map(i => [i.code, i.name, i.category, itemQty(i.name), +i.min, +i.min - itemQty(i.name)]) }) },
    { id: 'stkValue', group: 'المخازن', title: 'قيمة المخزون حسب المخزن والمجموعة', need: 'stockBalances', noDate: true, run: () => {
      const rows = []; db.warehouses.forEach(w => { const m = sumBy(db.items.filter(i => stockAt(i.name, w.name)), i => i.category, i => stockAt(i.name, w.name) * i.cost); m.forEach((v, k) => rows.push([w.name, k, v])); });
      return { cols: [col('المخزن'), col('المجموعة'), col('القيمة', M$)], rows };
    } },
    // ===== شئون العاملين =====
    { id: 'payrollRep', group: 'شئون العاملين', title: 'كشف الرواتب', need: 'payroll', run: (f, t) => {
      const list = eff('payroll').filter(r => inRange(r.month, f && f.slice(0, 7), t && t.slice(0, 7))).sort((a, b) => a.month.localeCompare(b.month));
      return { cols: [col('الشهر'), col('الموظف'), col('فئة المرتبات'), col('الأساسي', M$), col('البدلات', M$), col('الاستقطاعات', M$), col('الصافي', M$), col('الحالة')],
        rows: list.map(r => [r.month, r.employee, r.group || '', +r.basic, +r.allowances, +r.deductions, r.basic + r.allowances - r.deductions, r.paid || 'مصروف']) };
    } },
    { id: 'attRep', group: 'شئون العاملين', title: 'ملخص الحضور والانصراف', need: 'attendance', run: (f, t) => {
      const list = db.attendance.filter(r => inRange(r.date, f, t)); const st = ['حاضر', 'متأخر', 'غائب', 'إجازة'];
      return { cols: [col('الموظف'), ...st.map(s => col(s, N$)), col('الإجمالي', N$)],
        rows: [...new Set(list.map(r => r.employee))].map(e => { const c = st.map(s => list.filter(r => r.employee === e && r.status === s).length); return [e, ...c, sum(c, x => x)]; }) };
    } },
    { id: 'deptRep', group: 'شئون العاملين', title: 'الموظفون والرواتب حسب الإدارة', need: 'employees', noDate: true, run: () => ({
      cols: [col('الإدارة'), col('عدد الموظفين', N$), col('إجمالي الرواتب الأساسية', M$)],
      rows: db.departments.map(d => { const e = db.employees.filter(x => x.department === d.name); return [d.name, e.length, sum(e, x => x.salary)]; }) }) },
    // ===== إدارة التكاليف =====
    { id: 'costRep', group: 'إدارة التكاليف', title: 'التكاليف حسب مركز التكلفة', need: 'costCenters', run: (f, t) => {
      const inP = d => inRange(d, f, t), mIn = m => m && inRange(m + '-15', f, t);
      const staffCC = n => staffOf(n)?.costCenter || '';
      const issue = cc => sum(stockRows('stockOut').filter(l => l.doc.costCenter === cc && inP(l.doc.date)), l => baseQty(l) * (+db.items.find(i => i.name === l.item)?.cost || 0));
      const sal = cc => sum(eff('payroll').filter(r => mIn(r.month) && staffCC(r.employee) === cc), r => +r.basic + +r.allowances - +r.deductions);
      const lab = cc => sum(eff('dailyLabor').filter(r => inP(r.date) && staffCC(r.worker) === cc), r => r.days * r.wage);
      const exp = cc => sum(db.expenseOrders.filter(r => r.costCenter === cc && inP(r.date) && ['معتمد', 'مدفوع'].includes(r.status)), r => r.amount);
      const rows = db.costCenters.map(c => { const v = [sal(c.name), lab(c.name), issue(c.name), exp(c.name)]; const tot = v.reduce((a, b) => a + b, 0);
        return [c.branch || '', c.name, +c.area || 0, ...v, tot, +c.area ? tot / +c.area : 0]; }).filter(r => r[7]);
      return { cols: [col('الفرع'), col('مركز التكلفة'), col('المساحة', N$), col('الرواتب', M$), col('أجور العمالة', M$), col('صرف مخزني', M$), col('مصروفات (أوامر دفع)', M$), col('إجمالي التكلفة', M$), col('التكلفة لكل وحدة مساحة', M$, { noSum: true })], rows };
    } },
    // ===== الأصول الثابتة =====
    { id: 'assetRep', group: 'الأصول الثابتة', title: 'سجل الأصول الثابتة والإهلاك', need: 'fixedAssets', run: (f, t) => ({
      cols: [col('الكود'), col('الأصل'), col('النوع'), col('الفرع'), col('تاريخ الشراء'), col('التكلفة', M$), col('إهلاك الفترة', M$), col('مجمع الإهلاك في نهاية الفترة', M$), col('القيمة الدفترية', M$), col('الحالة')],
      rows: db.fixedAssets.filter(a => !a.buyDate || a.buyDate <= (t || today())).map(a => { const end = assetDep(a, t || today()), start = f ? assetDep(a, f) : 0;
        return [a.code, a.name, a.category, a.branch || '', a.buyDate, +a.cost, end - start, end, +a.cost - end, a.status]; }) }) },
    // ===== شئون العمالة =====
    { id: 'laborRep', group: 'شئون العمالة', title: 'أجور وسلف العمال', need: 'dailyLabor', run: (f, t) => {
      const lab = eff('dailyLabor').filter(r => inRange(r.date, f, t)), adv = eff('advances').filter(r => inRange(r.date, f, t));
      const s = (w, type) => sum(adv.filter(a => a.worker === w && a.type === type), a => a.amount);
      return { cols: [col('العامل'), col('الحرفة'), col('أيام العمل', N$), col('الأجور', M$), col('السلف', M$), col('المكافآت', M$), col('الجزاءات', M$), col('الصافي المستحق', M$)],
        rows: db.workers.map(w => { const l = lab.filter(x => x.worker === w.name); const wages = sum(l, x => x.days * x.wage);
          return [w.name, w.craft, sum(l, x => x.days), wages, s(w.name, 'سلفة'), s(w.name, 'مكافأة'), s(w.name, 'جزاء'), wages + s(w.name, 'مكافأة') - s(w.name, 'سلفة') - s(w.name, 'جزاء')]; })
          .filter(r => r[2] || r[4] || r[5] || r[6]) };
    } },
    // ===== الميكنة والصيانة =====
    { id: 'machRep', group: 'الميكنة والصيانة', title: 'تشغيل وتكلفة المعدات', need: 'machines', run: (f, t) => {
      const ops = db.machineOps.filter(r => inRange(r.date, f, t)), mo = eff('maintenanceOrders').filter(r => inRange(r.date, f, t));
      return { cols: [col('المعدة'), col('الحالة'), col('ساعات التشغيل', N$), col('الوقود (لتر)', N$), col('تكلفة التشغيل', M$), col('أوامر الصيانة', N$), col('تكلفة الصيانة', M$), col('التكلفة الكلية', M$)],
        rows: db.machines.map(m => { const o = ops.filter(x => x.machine === m.name), mm = mo.filter(x => x.machine === m.name); const run = sum(o, x => x.hours) * m.hourRate, mc = sum(mm.filter(x => x.status === 'مكتمل'), x => x.cost);
          return [m.name, machineState(m), sum(o, x => x.hours), sum(o, x => x.fuel), run, mm.length, mc, run + mc]; }) };
    } },
    { id: 'maintPlanRep', group: 'الميكنة والصيانة', title: 'الصيانة الدورية المستحقة', need: 'maintenancePlan', noDate: true, run: () => ({
      cols: [col('المعدة'), col('العمل المطلوب'), col('آخر صيانة'), col('الصيانة القادمة'), col('الحالة'), col('أيام متبقية', N$, { noSum: true })],
      rows: db.maintenancePlan.map(p => [p.machine, p.task, p.lastDate, p.nextDate, planStatus(p), dayDiff(p.nextDate, today())]).sort((a, b) => a[5] - b[5]) }) },
    // ===== الاعتمادات =====
    { id: 'apprRep', group: 'الاعتمادات', title: 'المستندات المعلّقة حسب النوع', need: 'approvals', noDate: true, run: () => ({
      cols: [col('نوع المستند'), col('بانتظار الاعتماد', N$), col('مرفوض', N$), col('قيمة المعلّق', M$)],
      rows: APPR_MODULES.map(t => { const p = db[t].filter(r => r.appr?.status === 'pending'), rj = db[t].filter(r => r.appr?.status === 'rejected');
        return [modules[t].title, p.length, rj.length, QTY_MODULES.includes(t) ? 0 : sum(p, r => amountOf(t, r))]; }).filter(r => r[1] || r[2]) }) },
  ];

  const fmtCell = (c, v) => c.type === M$ ? money(v) : c.type === N$ ? num(v) : esc(v);
  // فلاتر وتشكيل التقارير القابلة للتشكيل — تُحفظ لكل تقرير طوال الجلسة
  function repFilters(rep) {
    if (!rep.builder) return {};
    const F = (state.rFs ||= {})[rep.id] ||= rep.defaults();
    return { ...F, ms: [...F.ms] };
  }
  function repFiltersHTML(rep) {
    if (!rep.builder) return '';
    const F = repFilters(rep), d0 = rep.defaults();
    const sel = (k, label, opts, allLbl) => `<label class="rf"><span>${label}</span><select class="input" data-rf="${k}"><option value="">${allLbl}</option>${opts.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${v === F[k] ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select></label>`;
    const ui = rep.filterUI(F);
    return `<div class="rep-filters">${ui.map(x => sel(...x)).join('')}
      ${ui.some(([k]) => (F[k] || '') !== (d0[k] || '')) ? '<button type="button" class="link-btn" id="rfClear">مسح الفلاتر</button>' : ''}
    </div>${repBuilderHTML(rep, F)}`;
  }
  function repBuilderHTML(rep, F) {
    const gsel = (k, n) => `<label class="rf"><span>تجميع ${n}</span><select class="input" data-rf="${k}"><option value="">${n === 1 ? '— بدون تجميع —' : '— لا شيء —'}</option>${rep.dims.map(([v, l]) => `<option value="${v}" ${F[k] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
    return `<div class="rep-builder">
      <div class="rb-mode" role="group" aria-label="نوع التقرير"><span>نوع التقرير:</span>
        <button type="button" class="df-b ${F.mode !== 'detail' ? 'on' : ''}" data-rmode="sum">إجمالي</button><button type="button" class="df-b ${F.mode === 'detail' ? 'on' : ''}" data-rmode="detail">${rep.detailLabel || 'تفصيلي'}</button></div>
      <div class="rb-groups">${gsel('g1', 1)}${F.g1 ? gsel('g2', 2) : ''}${F.g1 && F.g2 ? gsel('g3', 3) : ''}</div>
      <div class="rb-meas"><span>الأعمدة:</span>${rep.meas.map(([k, l]) => `<label class="rb-chip ${F.ms.includes(k) ? 'on' : ''}"><input type="checkbox" data-rms="${k}" ${F.ms.includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
    </div>`;
  }
  function runReport(rep) {
    const out = rep.run(state.rFrom || '', state.rTo || '', repFilters(rep));
    const rows = out.rows.map(r => Array.isArray(r) ? { cells: r } : r);
    const totals = out.noTotal ? null : out.cols.map((c, i) => (c.type === M$ || c.type === N$) && !c.noSum ? sum(rows.filter(r => !r.cls || r.cls === 'warn'), r => r.cells[i]) : null);
    return { ...out, rows, totals };
  }
  function reportTableHTML(rep, res) {
    return `<table class="rep-table">
      <thead><tr>${res.cols.map(c => `<th class="${c.type !== 'text' ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${res.rows.map(r => `<tr class="${r.cls || ''}">${r.cells.map((v, i) => `<td class="${res.cols[i].type !== 'text' ? 'num' : ''}">${v === '' ? '' : fmtCell(res.cols[i], v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${res.cols.length}" class="empty">لا توجد بيانات في هذه الفترة</td></tr>`}</tbody>
      ${res.totals && res.rows.length ? `<tfoot><tr>${res.totals.map((v, i) => `<td class="${v != null ? 'num' : ''}">${i === 0 ? 'الإجمالي' : v != null ? fmtCell(res.cols[i], v) : ''}</td>`).join('')}</tr></tfoot>` : ''}
    </table>`;
  }
  function renderReportCenter(only) {
    const list = REPORTS.filter(r => can(r.need));
    const groups = [...new Set(list.map(r => r.group))];
    const rep = only ? list.find(r => r.id === only) : list.find(r => r.id === state.report) || list[0];
    if (!rep) { content.innerHTML = '<div class="boot"><p>لا توجد تقارير متاحة لصلاحياتك</p></div>'; return; }
    if (!only) state.report = rep.id;
    const res = runReport(rep);
    const period = rep.noDate ? 'الوضع الحالي' : rep.dateOnly ? `حتى ${state.rTo || today()}` : `${state.rFrom || 'من البداية'} — ${state.rTo || 'حتى اليوم'}`;
    content.innerHTML = `
      <div class="rep-layout ${only ? 'single' : ''}">
        ${only ? '' : `<aside class="rep-menu">${groups.map(g => `<div class="rep-group"><h4>${esc(g)}</h4>${list.filter(r => r.group === g).map(r => `<button class="rep-item ${r.id === rep.id ? 'on' : ''}" data-rep="${r.id}">${esc(r.title)}</button>`).join('')}</div>`).join('')}</aside>`}
        <section class="card rep-main">
          <div class="card-head"><div><h3>${esc(rep.title)}</h3><div class="sub">${esc(rep.group)} · ${esc(period)}${res.note ? ` · ${esc(res.note)}` : ''}</div></div>
            <div class="spacer"></div>
            <div class="toolbar">
              ${rep.noDate ? '' : `${rep.dateOnly ? '' : `<label class="date-f">من <input class="input" type="date" id="rFrom" value="${esc(state.rFrom || '')}"></label>`}<label class="date-f">${rep.dateOnly ? 'حتى تاريخ' : 'إلى'} <input class="input" type="date" id="rTo" value="${esc(state.rTo || '')}"></label>
              <select class="input" id="rQuick"><option value="">فترة سريعة…</option><option value="month">هذا الشهر</option><option value="lastMonth">الشهر السابق</option><option value="quarter">هذا الربع</option><option value="year">هذه السنة</option><option value="all">كل الفترات</option></select>`}
              <button class="btn ghost" id="exportBtn">${icons.export}تصدير</button>
              <button class="btn ghost" id="repPrint">${icons.print}طباعة</button>
            </div></div>
          ${repFiltersHTML(rep)}
          <div class="table-wrap">${reportTableHTML(rep, res)}</div>
          <div class="table-foot"><span>${res.rows.filter(r => !r.cls).length} صف</span><span>يعتمد على المستندات المعتمدة فقط</span></div>
        </section>
      </div>`;
    $$('[data-rep]', content).forEach(b => b.onclick = () => { state.report = b.dataset.rep; renderPage(); });
    if (rep.builder) {
      const RF = () => (state.rFs ||= {})[rep.id] ||= rep.defaults();
      $$('[data-rf]', content).forEach(s => s.addEventListener('change', () => { const F = RF(); F[s.dataset.rf] = s.value; rep.onFilter?.(F, s.dataset.rf);
        if (s.dataset.rf === 'g1' && !s.value) { F.g2 = ''; F.g3 = ''; } if (s.dataset.rf === 'g2' && !s.value) F.g3 = ''; renderPage(); }));
      $('#rfClear')?.addEventListener('click', () => { const F = RF(), d0 = rep.defaults(); rep.filterUI(F).forEach(([k]) => { F[k] = d0[k] || ''; }); renderPage(); });
      $$('[data-rmode]', content).forEach(b => b.onclick = () => { RF().mode = b.dataset.rmode; renderPage(); });
      $$('[data-rms]', content).forEach(c => c.onchange = () => { const F = RF(); F.ms = rep.meas.map(([k]) => k).filter(k => k === c.dataset.rms ? c.checked : F.ms.includes(k)); if (!F.ms.length) F.ms = [rep.meas.at(-2)[0]]; renderPage(); });
    }
    const setP = () => { state.rFrom = $('#rFrom')?.value || ''; state.rTo = $('#rTo')?.value || ''; renderPage(); };
    $('#rFrom')?.addEventListener('change', setP); $('#rTo')?.addEventListener('change', setP);
    $('#rQuick')?.addEventListener('change', e => {
      const d = new Date(), y = d.getFullYear(), m = d.getMonth(), iso = x => isoOf(x);
      const q = { month: [new Date(y, m, 1), new Date(y, m + 1, 0)], lastMonth: [new Date(y, m - 1, 1), new Date(y, m, 0)], quarter: [new Date(y, m - m % 3, 1), new Date(y, m - m % 3 + 3, 0)], year: [new Date(y, 0, 1), new Date(y, 11, 31)] }[e.target.value];
      if (e.target.value === 'all') { state.rFrom = ''; state.rTo = ''; } else if (q) { state.rFrom = iso(q[0]); state.rTo = iso(q[1]); }
      renderPage();
    });
    $('#exportBtn').onclick = () => downloadCSV(rep.title, res.cols.map(c => c.label), [...res.rows.map(r => r.cells), ...(res.totals ? [res.totals.map((v, i) => i === 0 ? 'الإجمالي' : v ?? '')] : [])]);
    $('#repPrint').onclick = () => {
      const s = db.settings, area = $('#printArea');
      area.innerHTML = `<div class="doc"><div class="doc-head"><div><h1>${esc(s.company || '')}</h1><p>${esc(s.address || '')}</p></div>
        <div class="doc-title"><h2>${esc(rep.title)}</h2><span>${esc(period)}${res.note ? ` — ${esc(res.note)}` : ''}</span></div></div>${reportTableHTML(rep, res)}
        <div class="doc-foot">طُبع بواسطة ${esc(curUser()?.name || '')} — ${new Date().toLocaleString((window.UI_LOCALE || 'ar-EG'))}</div></div>`;
      document.body.classList.add('printing');
      const done = () => { document.body.classList.remove('printing'); area.innerHTML = ''; window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done); setTimeout(() => { window.print(); setTimeout(done, 500); }, 50);
    };
  }

  // =====================================================================
  // طباعة أي صفحة (القوائم المالية وكشوف الحسابات وغيرها) بنفس قالب التقارير: بدون صفحة فارغة، وجدول احترافي
  // =====================================================================
  function printPage() {
    const s = db.settings, area = $('#printArea');
    const box = content.cloneNode(true);
    // إزالة عناصر التحكم من النسخة المطبوعة
    // الروابط داخل الجداول (مثل اسم الحساب) تُطبع كنص، وباقي الأزرار تُحذف
    box.querySelectorAll('td button, td a, th button').forEach(el => { if (el.closest('.row-actions')) return; const t = document.createElement('span'); t.textContent = el.textContent; el.replaceWith(t); });
    box.querySelectorAll('.toolbar, .row-actions, button, .btn, .ledger-pick, .rep-filters, .rb-mode, .rb-meas, .tabbar, input[type=search], .chart, svg.spark').forEach(el => el.remove());
    box.querySelectorAll('select').forEach(sel => { const t = document.createElement('b'); t.textContent = sel.options[sel.selectedIndex]?.textContent || ''; sel.replaceWith(t); });
    box.querySelectorAll('table').forEach(t => t.classList.add('print-table'));
    area.innerHTML = `<div class="doc"><div class="doc-head"><div><h1>${esc(appName())}</h1><p>${esc(s.address || '')}</p></div>
      <div class="doc-title"><h2>${esc($('#pageTitle').textContent)}</h2><span>${esc(new Date().toLocaleDateString(window.UI_LOCALE || 'ar-EG'))}</span></div></div>
      ${box.innerHTML}
      <div class="doc-foot">طُبع بواسطة ${esc(curUser()?.name || '')} — ${new Date().toLocaleString(window.UI_LOCALE || 'ar-EG')}</div></div>`;
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); area.innerHTML = ''; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done); setTimeout(() => { window.print(); setTimeout(done, 500); }, 50);
  }
  document.addEventListener('click', e => { if (e.target.closest('[data-print-page]')) { e.preventDefault(); printPage(); } });

  // =====================================================================
  // صفحة لكل مخزن: الأرصدة والحركات، والأذون تُفتح والمخزن مقفل عليها
  // =====================================================================
  const whPageInfo = id => {
    const w = String(id).startsWith('wh/') && db.warehouses.find(x => x.id === id.slice(3));
    return w ? { title: w.name, sub: `${w.type || 'مخزن'}${w.location ? ' — ' + w.location : ''} — الأرصدة والحركات`, render: () => renderWarehouse(w) } : null;
  };
  function whMoves(w) {
    const rows = [];
    const push = (t, r, kind, item, q, dir, party) => rows.push({ t, r, date: r.date, no: r.no, kind, item, q, dir, party });
    eff('openingBalances').filter(r => r.otype === OPEN_TYPES[1] && r.warehouse === w.name).forEach(r => push('openingBalances', r, 'رصيد افتتاحي', r.item, baseQty(r), 1, ''));
    stockRows('stockIn').filter(l => l.warehouse === w.name).forEach(l => push('stockIn', l.doc, 'إذن إضافة', l.item, baseQty(l), 1, l.doc.supplier || l.doc.source || ''));
    stockRows('stockOut').filter(l => l.warehouse === w.name).forEach(l => push('stockOut', l.doc, 'إذن صرف', l.item, baseQty(l), -1, l.doc.costCenter || l.doc.to || ''));
    stockRows('salesInvoices').filter(l => l.warehouse === w.name).forEach(l => push('salesInvoices', l.doc, 'فاتورة بيع', l.item, baseQty(l), -1, l.doc.customer));
    stockRows('salesReturns').filter(l => l.warehouse === w.name).forEach(l => push('salesReturns', l.doc, 'مردودات مبيعات', l.item, baseQty(l), 1, l.doc.customer));
    eff('transfers').filter(r => r.from === w.name || r.to === w.name).forEach(r => push('transfers', r, r.to === w.name ? 'تحويل وارد' : 'تحويل صادر', r.item, baseQty(r), r.to === w.name ? 1 : -1, r.to === w.name ? r.from : r.to));
    return rows.sort((a, b) => -byDate(a, b) || String(b.no).localeCompare(String(a.no)));
  }
  function renderWarehouse(w) {
    const v = (state.whView ||= {})[w.id] ||= { q: '' };
    const items = db.items.map(i => ({ i, q: stockAt(i.name, w.name) })).filter(x => Math.abs(x.q) > 1e-9 || x.i.warehouse === w.name);
    const value = sum(items, x => x.q * (+x.i.cost || 0)), low = items.filter(x => x.q < +x.i.min).length;
    const mv = whMoves(w), q = normAr(v.q);
    const shown = mv.filter(m => !q || normAr([m.no, m.item, m.party, m.kind].join(' ')).includes(q)).slice(0, 300);
    const lock = { warehouse: w.name };
    content.innerHTML = `
      <div class="kpis">
        ${kpi('قيمة المخزون', money(value), 'بسعر التكلفة', 'up', 'blue', icons.box)}
        ${kpi('أصناف بها رصيد', num(items.filter(x => x.q > 0).length), `${items.length} صنف في المخزن`, '', 'green', icons.list)}
        ${kpi('أقل من حد الطلب', num(low), 'تحتاج إعادة طلب', low ? 'down' : '', 'red', icons.down)}
        ${kpi('الحركات', num(mv.length), 'إضافة · صرف · بيع · تحويل', '', 'amber', icons.swap)}
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-head"><div><h3>أرصدة ${esc(w.name)}</h3><div class="sub">الكمية بوحدة الصنف الأساسية</div></div><div class="spacer"></div>
          <div class="toolbar">
            <button class="btn primary" data-wnew="stockIn">${icons.receive}إذن إضافة</button>
            <button class="btn primary" data-wnew="stockOut">${icons.pay}إذن صرف</button>
            <button class="btn ghost" data-wnew="transfers">${icons.swap}تحويل لمخزن آخر</button>
            <button class="btn ghost" data-wnew="openingBalances">${icons.plus}رصيد افتتاحي</button>
          </div></div>
        <div class="table-wrap"><table><thead><tr><th>الكود</th><th>الصنف</th><th>المجموعة</th><th>الوحدة</th><th>الرصيد</th><th>حد الطلب</th><th>التكلفة</th><th>القيمة</th><th></th></tr></thead>
          <tbody>${items.length ? items.map(x => `<tr><td class="code">${esc(x.i.code || '')}</td><td>${esc(x.i.name)}</td><td>${esc(x.i.category || '')}</td><td>${esc(x.i.unit || '')}</td>
            <td class="num">${x.q < +x.i.min ? `<span class="pill red">${num(x.q)}</span>` : `<b>${num(x.q)}</b>`}</td><td class="num">${num(x.i.min || 0)}</td><td class="num">${money(x.i.cost || 0)}</td><td class="num">${money(x.q * (+x.i.cost || 0))}</td>
            <td><div class="row-actions"><button data-wcard="${esc(x.i.id)}" title="كارت الصنف">${icons.list}</button></div></td></tr>`).join('') : '<tr><td colspan="9" class="empty">لا توجد أصناف في هذا المخزن</td></tr>'}</tbody></table></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>حركات المخزن</h3><div class="sub">${mv.length} حركة معتمدة</div></div><div class="spacer"></div>
          <div class="toolbar"><input class="input" id="whQ" type="search" placeholder="بحث: رقم، صنف، مورد، جهة…" value="${esc(v.q)}"></div></div>
        <div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>رقم المستند</th><th>نوع الحركة</th><th>الصنف</th><th>الطرف / الجهة</th><th>وارد</th><th>صادر</th><th></th></tr></thead>
          <tbody>${shown.length ? shown.map(m => `<tr><td>${esc(m.date)}</td><td class="code">${esc(m.no)}</td><td><span class="pill ${m.dir > 0 ? 'green' : 'red'}">${esc(m.kind)}</span></td><td>${esc(m.item)}</td><td>${esc(m.party || '—')}</td>
            <td class="num">${m.dir > 0 ? num(m.q) : ''}</td><td class="num">${m.dir < 0 ? num(m.q) : ''}</td>
            <td><div class="row-actions"><button data-wprint="${m.t}|${m.r.id}" title="طباعة المستند">${icons.print}</button><button data-wedit="${m.t}|${m.r.id}" title="تعديل">${icons.edit}</button><button class="del" data-wdel="${m.t}|${m.r.id}" title="حذف">${icons.del}</button></div></td></tr>`).join('') : '<tr><td colspan="8" class="empty">لا توجد حركات</td></tr>'}</tbody></table></div>
      </div>`;
    $('#whQ').oninput = e => { v.q = e.target.value; renderWarehouse(w); const el = $('#whQ'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
    $$('[data-wnew]', content).forEach(b => b.onclick = () => { const t = b.dataset.wnew;
      if (t === 'transfers') openRecordForm(t, null, { from: w.name }, null, { lock: ['from'] });
      else if (t === 'openingBalances') openRecordForm(t, null, { otype: OPEN_TYPES[1], warehouse: w.name }, null, { lock: ['otype', 'warehouse'] });
      else openRecordForm(t, null, lock, null, { lock: ['warehouse'] }); });
    $$('[data-wcard]', content).forEach(b => b.onclick = () => itemCard(db.items.find(i => i.id === b.dataset.wcard)));
    $$('[data-wprint]', content).forEach(b => b.onclick = () => { const [t, id] = b.dataset.wprint.split('|'); printDoc(t, db[t].find(r => r.id === id), true); });
    $$('[data-wedit]', content).forEach(b => b.onclick = () => { const [t, id] = b.dataset.wedit.split('|'); openRecordForm(t, db[t].find(r => r.id === id)); });
    $$('[data-wdel]', content).forEach(b => b.onclick = () => { const [t, id] = b.dataset.wdel.split('|'); const r = db[t].find(x => x.id === id); if (r) deleteRecord(t, r); });
  }

  // =====================================================================
  // صفحات الخزائن والبنوك: صفحة مستقلة لكل خزينة وكل بنك
  // =====================================================================
  const TREAS_MODS = ['receipts', 'payments', 'boxTransfers'];
  const boxPageInfo = id => {
    if (id === 'bankMoves') return { title: 'حركات كل البنوك', sub: 'الإيداعات والمصروفات والتحويلات البنكية', render: () => renderBox(null) };
    const b = id.startsWith('box/') && db.cashboxes.find(x => x.id === id.slice(4));
    if (!b) return null;
    return { title: b.name, sub: isBankBox(b) ? `حساب بنكي${b.bankAccount ? ` رقم ${b.bankAccount}` : ''} — الحركات والرصيد` : 'حركات الخزينة والرصيد', render: () => renderBox(b) };
  };
  const methodOf = (t, r) => r.method || 'نقدي';
  function boxRows(boxes) {
    const codes = new Set(boxes.map(b => b.accountNo)), names = new Set(boxes.map(b => b.name));
    const rows = [];
    glEntries().forEach(e => e.lines.forEach(l => {
      if (!codes.has(l.acc)) return;
      const mod = e.manual ? 'journal' : e.module, doc = TREAS_MODS.includes(mod) ? db[mod].find(r => r.id === e.id) : null;
      const box = boxes.find(b => b.accountNo === l.acc);
      rows.push(boxRow(mod, doc, box, e, l.dr, l.cr));
    }));
    // المستندات المعلّقة على الاعتماد تظهر ولا تدخل في الرصيد
    TREAS_MODS.forEach(t => db[t].forEach(r => {
      const wait = isEff(r) && t !== 'boxTransfers' && chqOpen(r) && isChq(r, t === 'payments' ? SYS.chqOut : SYS.chqIn);
      if (r.appr?.status !== 'pending' && r.chequeStatus !== 'مرتد' && !wait) return;
      [t === 'boxTransfers' ? [r.from, 'out'] : null, t === 'boxTransfers' ? [r.to, 'in'] : [r.box, t === 'receipts' ? 'in' : 'out']].filter(Boolean).forEach(([bn, dir]) => {
        if (!names.has(bn)) return;
        const box = boxes.find(b => b.name === bn);
        rows.push({ ...boxRow(t, r, box, { date: r.date, no: r.no, desc: r.desc || '' }, dir === 'in' ? +r.amount : 0, dir === 'out' ? +r.amount : 0), pending: true, bounced: r.chequeStatus === 'مرتد', wait });
      });
    }));
    return rows.sort((a, b) => byDate(a, b) || String(a.no).localeCompare(String(b.no)));
  }
  function boxRow(mod, doc, box, e, dr, cr) {
    const bank = isBankBox(box);
    let kind = e.src || pageInfo(mod)?.single || '', party = '';
    if (mod === 'receipts') { kind = bank ? 'إيداع' : 'قبض'; party = doc ? partyName(doc) : ''; }
    else if (mod === 'payments') { kind = 'صرف'; party = doc ? partyName(doc) : ''; }
    else if (mod === 'boxTransfers') { const incoming = dr > 0; kind = incoming ? 'تحويل وارد' : 'تحويل صادر'; party = doc?.beneficiary || (incoming ? doc?.from : doc?.to); }
    return { mod, doc, id: doc?.id || e.id, box: box?.name, date: e.date, no: e.no, kind, party: party || '',
      chqStatus: doc?.method === 'شيك' ? doc.chequeStatus || (mod === 'payments' ? CHQ_OUT[0] : CHQ_IN[0]) : '', chqOpen: doc ? chqOpen(doc) : false,
      method: doc ? methodOf(mod, doc) : '', cheque: doc?.chequeNo ? `${doc.chequeNo}${doc.chequeDate ? ` · ${doc.chequeDate}` : ''}` : '',
      benAccount: doc?.benAccount || '', benBank: doc?.benBank || '', desc: e.desc || doc?.desc || '', in: dr, out: cr };
  }
  function renderBox(box) {
    const boxes = box ? [box] : db.cashboxes.filter(isBankBox);
    const bank = box ? isBankBox(box) : true, pageId = state.page;
    const bs = state.boxView ||= {};
    const v = bs[pageId] ||= { q: '', kind: '', method: '', from: '', to: '' };
    const all = boxRows(boxes);
    const opening = sum(boxes, b => +(acc(b.accountNo)?.balance || 0));
    let bal = opening; all.forEach(r => { if (!r.pending) bal += r.in - r.out; r.bal = r.pending ? null : bal; });
    const before = v.from ? all.filter(r => !r.pending && r.date < v.from) : [];
    const openFor = v.from ? (before.length ? before[before.length - 1].bal : opening) : opening;
    const q = v.q.trim().toLowerCase();
    const rows = all.filter(r => (!v.from || r.date >= v.from) && (!v.to || r.date <= v.to) && (!v.kind || r.kind === v.kind) && (!v.method || r.method === v.method)
      && (!q || [r.no, r.party, r.desc, r.benAccount, r.benBank, r.cheque, r.box].some(x => String(x || '').toLowerCase().includes(q))));
    const cur = sum(boxes, b => acc(b.accountNo) ? ownBal(acc(b.accountNo)) : 0);
    const eff = rows.filter(r => !r.pending), pend = all.filter(r => r.pending && !r.bounced && !r.wait).length, waitR = all.filter(r => r.wait);
    const kinds = [...new Set(all.map(r => r.kind))];
    const opt = (list, sel, lbl) => `<option value="">${lbl}: الكل</option>${list.map(o => `<option ${o === sel ? 'selected' : ''}>${esc(o)}</option>`).join('')}`;
    const lbl = bank ? { in: 'إيداع', out: 'صرف / سحب', tr: 'تحويل' } : { in: 'قبض', out: 'صرف', tr: 'تحويل' };
    content.innerHTML = `
      <div class="kpis">
        ${kpi('الرصيد الحالي', money(cur), box ? esc(acc(box.accountNo) ? accLabel(acc(box.accountNo)) : '') : `${boxes.length} بنك`, cur >= 0 ? 'up' : 'down', 'blue', icons.cash)}
        ${kpi(bank ? 'إجمالي الإيداعات' : 'إجمالي المقبوضات', money(sum(eff, r => r.in)), `${eff.filter(r => r.in).length} حركة`, 'up', 'green', icons.receive)}
        ${kpi(bank ? 'إجمالي المسحوبات' : 'إجمالي المدفوعات', money(sum(eff, r => r.out)), `${eff.filter(r => r.out).length} حركة`, 'down', 'red', icons.pay)}
        ${kpi('شيكات لم تُحصّل / تُصرف', money(sum(waitR, r => r.in - r.out)), `${waitR.length} شيك · ${pend} مستند بانتظار الاعتماد`, '', 'amber', icons.shield)}
      </div>
      <div class="card">
        <div class="card-head">
          <div><h3>${box ? esc(box.name) : 'حركات كل البنوك'}</h3><div class="sub">${bank ? 'كل حركة بنكية: نوعها (إيداع / صرف / تحويل) وطريقتها (نقدي / شيك / تحويل بنكي) وبيانات المستفيد' : 'حركات القبض والصرف والتحويل والرصيد المتحرك'}</div></div>
          <div class="spacer"></div>
          <div class="toolbar">
            <button class="btn primary" data-new="receipts">${icons.receive}${lbl.in}</button>
            <button class="btn primary" data-new="payments">${icons.pay}${lbl.out}</button>
            <button class="btn ghost" data-new="boxTransfers">${icons.swap}${lbl.tr}</button>
            ${box ? `<button class="btn ghost" id="boxLedger">${icons.ledger}كشف الحساب</button>` : ''}
            ${box ? `<button class="btn ghost" data-new-open="1">${icons.plus}رصيد افتتاحي</button>` : ''}
            <button class="btn ghost" id="bxImport">${icons.receive}استيراد</button>
            <button class="btn ghost" id="bxExport">${icons.export}تصدير</button>
          </div>
        </div>
        <div class="card-head box-filters">
          <input class="input" id="bxQ" type="search" placeholder="بحث: رقم، مستفيد، رقم حساب، شيك…" value="${esc(v.q)}">
          <select class="input" id="bxKind">${opt(kinds, v.kind, 'نوع الحركة')}</select>
          ${bank ? `<select class="input" id="bxMethod">${opt(PAY_METHODS, v.method, 'الطريقة')}</select>` : ''}
          <label class="bx-date">من <input class="input" type="date" id="bxFrom" value="${v.from}"></label>
          <label class="bx-date">إلى <input class="input" type="date" id="bxTo" value="${v.to}"></label>
        </div>
        <div class="table-wrap"><table class="box-table">
          <thead><tr><th>التاريخ</th><th>رقم المستند</th>${box ? '' : '<th>البنك</th>'}<th>نوع الحركة</th>${bank ? '<th>الطريقة / الشيك</th>' : ''}<th>${bank ? 'المستفيد / الطرف' : 'الطرف'}</th>${bank ? '<th>حساب وبنك المستفيد</th>' : ''}<th>وارد</th><th>صادر</th><th>الرصيد</th><th></th></tr></thead>
          <tbody>
            <tr class="open-row"><td colspan="${(box ? 5 : 6) + (bank ? 2 : 0)}">رصيد ${v.from ? `أول الفترة (${v.from})` : 'افتتاحي'}</td><td class="num"><b>${money(openFor)}</b></td><td></td></tr>
            ${rows.length ? rows.map(r => `<tr class="${r.pending ? 'pending' : ''}">
              <td>${esc(r.date)}</td><td class="code">${esc(r.no)}</td>${box ? '' : `<td>${esc(r.box)}</td>`}
              <td class="bx-kind"><span class="pill ${r.in ? 'green' : 'red'}">${esc(r.kind)}</span>${r.bounced ? ' <span class="pill red">شيك مرتد</span>' : r.wait ? ` <span class="pill amber">${esc(r.chqStatus)}</span>` : r.pending ? ' <span class="pill amber">بانتظار الاعتماد</span>' : ''}</td>
              ${bank ? `<td class="bx-meth">${r.method ? `<span class="pill ${r.method === 'شيك' ? 'amber' : r.method === 'تحويل بنكي' ? 'blue' : 'gray'}">${esc(r.method)}</span>${r.cheque ? `<small class="bx-sub">شيك ${esc(r.cheque)}${r.chqStatus && !r.bounced ? ` · ${esc(r.chqStatus)}` : ''}</small>` : ''}` : '—'}</td>` : ''}
              <td class="bx-party">${esc(r.party || r.desc) || '—'}${r.party && r.desc ? `<small class="bx-sub">${esc(r.desc)}</small>` : ''}</td>
              ${bank ? `<td class="bx-ben">${r.benAccount || r.benBank ? `<span class="code">${esc(r.benAccount)}</span><small class="bx-sub">${esc(r.benBank)}</small>` : '—'}</td>` : ''}
              <td class="num">${r.in ? money(r.in) : ''}</td><td class="num">${r.out ? money(r.out) : ''}</td>
              <td class="num">${r.bal == null ? '—' : `<b>${money(r.bal)}</b>`}</td>
              <td><div class="row-actions">${r.chqOpen && (!r.pending || r.wait) ? `<button class="ok" data-bchq="${r.mod}|${r.id}" title="${r.mod === 'payments' ? 'تم صرف الشيك' : 'تم تحصيل الشيك'}">✓</button>` : ''}${r.doc ? `<button data-bprint="${r.mod}|${r.id}" title="طباعة المستند">${icons.print}</button><button data-bedit="${r.mod}|${r.id}" title="تعديل">${icons.edit}</button><button class="del" data-bdel="${r.mod}|${r.id}" title="حذف">${icons.del}</button>` : r.mod ? `<button data-bgo="${r.mod}|${esc(r.no)}" title="فتح المستند">${icons.list}</button>` : ''}</div></td>
            </tr>`).join('') : `<tr><td colspan="${(box ? 8 : 9) + (bank ? 2 : 0)}" class="empty">لا توجد حركات</td></tr>`}
          </tbody>
        </table></div>
        <div class="table-foot"><span>عرض ${rows.length} حركة</span><span>الوارد: <b>${money(sum(eff, r => r.in))}</b> &nbsp;·&nbsp; الصادر: <b>${money(sum(eff, r => r.out))}</b> &nbsp;·&nbsp; الرصيد الحالي: <b>${money(cur)}</b></span></div>
      </div>`;
    const keep = id => { const el = $('#' + id); el?.focus(); if (el?.type === 'search') el.setSelectionRange(el.value.length, el.value.length); };
    $('#bxQ').oninput = e => { v.q = e.target.value; renderBox(box); keep('bxQ'); };
    $('#bxKind').onchange = e => { v.kind = e.target.value; renderBox(box); };
    $('#bxMethod') && ($('#bxMethod').onchange = e => { v.method = e.target.value; renderBox(box); });
    $('#bxFrom').onchange = e => { v.from = e.target.value; renderBox(box); };
    $('#bxTo').onchange = e => { v.to = e.target.value; renderBox(box); };
    $('#boxLedger') && ($('#boxLedger').onclick = () => openLedger(box.accountNo));
    $$('[data-new-open]', content).forEach(b => b.onclick = () => openRecordForm('openingBalances', null, { otype: OPEN_TYPES[0], box: box.name }, null, { lock: ['otype', 'box'] }));
    $('#bxImport').onclick = () => openImport('payments', box ? { box: box.name, from: box.name } : {});
    $('#bxExport').onclick = () => downloadCSV(box ? box.name : 'حركات البنوك', ['التاريخ', 'رقم المستند', 'البنك / الخزينة', 'نوع الحركة', 'الطريقة', 'رقم الشيك', 'المستفيد / الطرف', 'رقم حساب المستفيد', 'بنك المستفيد', 'البيان', 'وارد', 'صادر', 'الرصيد'],
      rows.map(r => [r.date, r.no, r.box, r.kind, r.method, r.cheque, r.party, r.benAccount, r.benBank, r.desc, r.in, r.out, r.bal ?? 'معلّق']));
    $$('[data-new]', content).forEach(b => b.onclick = () => {
      const t = b.dataset.new, name = box?.name;
      const pre = name ? (t === 'boxTransfers' ? { from: name } : { box: name }) : {};
      openRecordForm(t, null, pre, null, { lock: Object.keys(pre) });
    });
    const parse = s => { const [t, id] = s.split('|'); return [t, db[t]?.find(r => r.id === id)]; };
    $$('[data-bprint]', content).forEach(b => b.onclick = () => { const [t, r] = parse(b.dataset.bprint); printDoc(t, r, true); });
    $$('[data-bedit]', content).forEach(b => b.onclick = () => { const [t, r] = parse(b.dataset.bedit); openRecordForm(t, r); });
    $$('[data-bdel]', content).forEach(b => b.onclick = () => { const [t, r] = parse(b.dataset.bdel); if (r) deleteRecord(t, r); });
    $$('[data-bchq]', content).forEach(b => b.onclick = () => { const [t, r] = parse(b.dataset.bchq); if (!r || !can(t, 'e')) return denied();
      r.chequeStatus = t === 'payments' ? 'مصروف' : 'محصّل'; r.clearDate = today(); save(); renderPage(); renderNav(); toast(`الشيك ${r.chequeNo} — ${r.chequeStatus}`); });
    $$('[data-bgo]', content).forEach(b => b.onclick = () => { const [t, no] = b.dataset.bgo.split('|'); goTo(t, ['payroll', 'dailyLabor', 'advances'].includes(t) ? '' : no); });
  }

  // ---------- التوجيه ----------
  const content = $('#content');
  const renderPage = () => {
    if (!can(state.page)) { content.innerHTML = '<div class="boot"><p>لا توجد شاشات متاحة لحسابك — راجع مدير النظام لتحديد صلاحياتك.</p></div>'; return; }
    const pi = pageInfo(state.page), r = pi?.render ? pi.render() : renderModule(state.page);
    enforce(); if (r?.then) r.then(enforce);
  };
  const isMobile = () => matchMedia('(max-width: 900px)').matches;
  // =====================================================================
  // الإشعارات: جرس أعلى الصفحة — كل مستخدم يرى ما تسمح به صلاحياته فقط
  // =====================================================================
  const NOTIF_KEY = () => `acc-erp-notif-seen-${curUser()?.id || 'x'}`;
  const notifSeen = () => { try { return new Set(JSON.parse(localStorage.getItem(NOTIF_KEY()) || '[]')); } catch { return new Set(); } };
  const saveSeen = s => { try { localStorage.setItem(NOTIF_KEY(), JSON.stringify([...s].slice(-500))); } catch {} };
  const lastStep = r => r.appr?.steps?.at(-1);
  function buildNotifs() {
    const u = curUser(); if (!u) return [];
    const out = [], now = Date.now(), week = 7 * 864e5;
    // مستندات بانتظار اعتمادي
    myApprovals().slice(0, 30).forEach(({ t, r }) => out.push({ id: `ap:${t}:${r.id}:${r.appr.level}`, icon: '⏳', cls: 'amber', page: 'approvals',
      title: `${modules[t].single} ${docNo(t, r)} بانتظار اعتمادك`, sub: `${docParty(r) || ''}${amountOf(t, r) ? ' · ' + money(amountOf(t, r)) : ''}`, at: lastStep(r)?.at }));
    // مستنداتي: رُفضت أو اعتُمدت حديثاً
    APPR_MODULES.forEach(t => db[t].forEach(r => {
      if (!r.appr || r.appr.steps?.[0]?.by !== u.id) return; const ls = lastStep(r);
      if (r.appr.status === 'rejected') out.push({ id: `rej:${t}:${r.id}:${ls?.at}`, icon: '⛔', cls: 'red', page: tbl(t), q: r.no || '', title: `تم رفض ${modules[t].single} ${docNo(t, r)}`, sub: ls?.note ? `السبب: ${ls.note}` : `بواسطة ${userName(ls?.by)}`, at: ls?.at });
      else if (r.appr.status === 'approved' && ls?.at && now - new Date(ls.at) < week) out.push({ id: `ok:${t}:${r.id}:${ls.at}`, icon: '✅', cls: 'green', page: tbl(t), q: r.no || '', title: `تم اعتماد ${modules[t].single} ${docNo(t, r)}`, sub: `بواسطة ${userName(ls.by)} — تم الترحيل`, at: ls.at });
    }));
    const day = today();
    const agg = (page, icon, cls, n, title, sub) => { if (n && can(page)) out.push({ id: `${page}:${day}:${n}`, icon, cls, page, title, sub, at: `${day}T00:00:00`, n, agg: 1 }); };
    agg('salesInvoices', '🧾', 'red', db.salesInvoices.filter(r => salesStatus(r) === 'متأخرة').length, 'فواتير مبيعات متأخرة السداد', 'تجاوزت تاريخ الاستحقاق');
    agg('purchaseInvoices', '🧾', 'amber', db.purchaseInvoices.filter(r => purchStatus(r) === 'متأخرة').length, 'فواتير مشتريات متأخرة السداد', 'مستحقة للموردين');
    agg('items', '📦', 'amber', db.items.filter(r => itemQty(r.name) < +r.min).length, 'أصناف تحت حد الطلب', 'تحتاج إعادة طلب');
    agg('rep/chqDue', '💳', 'amber', eff('receipts').filter(r => chqOpen(r) && (r.chequeDate || r.date) <= day).length + eff('payments').filter(r => chqOpen(r) && (r.chequeDate || r.date) <= day).length, 'شيكات مستحقة اليوم أو متأخرة', 'لم تُحصّل أو تُصرف بعد');
    agg('maintenancePlan', '🔧', 'amber', db.maintenancePlan.filter(r => planStatus(r) === 'متأخرة').length, 'صيانة دورية متأخرة', 'المعدات تحتاج صيانة');
    agg('maintenanceOrders', '🛠️', '', db.maintenanceOrders.filter(r => r.status !== 'مكتمل').length, 'أوامر صيانة مفتوحة', 'لم تكتمل بعد');
    return out.filter(n => can(n.page) || n.page === 'approvals').sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  }
  const timeAgo = at => { if (!at) return ''; const m = Math.round((Date.now() - new Date(at)) / 6e4), L = window.ACC_LANG || 'ar';
    const [v, u] = m < 60 ? [m, 0] : m < 1440 ? [Math.round(m / 60), 1] : [Math.round(m / 1440), 2];
    if (m < 1) return { ar: 'الآن', en: 'now', es: 'ahora' }[L];
    return L === 'en' ? `${v} ${['min', 'h', 'd'][u]} ago` : L === 'es' ? `hace ${v} ${['min', 'h', 'd'][u]}` : `منذ ${v} ${['دقيقة', 'ساعة', 'يوم'][u]}`; };
  function renderBell() {
    const btn = $('#notifBtn'); if (!btn) return;
    const list = buildNotifs(), seen = notifSeen(), unread = list.filter(n => !seen.has(n.id)).length;
    btn.querySelector('.notif-n').textContent = unread > 99 ? '99+' : unread || '';
    btn.classList.toggle('has', unread > 0);
    const sqN = $('#sqNotif'), sqA = $('#sqAppr'), ap = myApprovals().length;
    if (sqN) { sqN.textContent = unread > 99 ? '99+' : unread || ''; sqN.hidden = !unread; }
    if (sqA) { sqA.textContent = ap > 99 ? '99+' : ap || ''; sqA.hidden = !ap; }
    const panel = $('#notifPanel');
    if (!panel.hidden) panel.innerHTML = `<div class="notif-head"><b>الإشعارات</b>${unread ? `<span class="pill amber">${unread} جديد</span>` : ''}<span class="spacer"></span>${list.length ? '<button type="button" class="link-btn" id="notifAll">تعليم الكل كمقروء</button>' : ''}</div>
      <div class="notif-list">${list.length ? list.map(n => `<button type="button" class="notif-item ${seen.has(n.id) ? '' : 'unread'}" data-nid="${esc(n.id)}" data-npage="${esc(n.page)}" data-nq="${esc(n.q || '')}">
        <span class="notif-ico ${n.cls}">${n.icon}</span><span class="notif-txt"><b>${esc(n.title)}</b><small>${esc(n.sub || '')}</small></span><time>${n.agg ? `<span class="pill">${n.n}</span>` : esc(timeAgo(n.at))}</time></button>`).join('')
        : '<div class="notif-empty">لا توجد إشعارات 👍</div>'}</div>`;
  }
  $$('.side-quick [data-sq]').forEach(b => b.addEventListener('click', e => { const k = b.dataset.sq;
    if (k === 'notif') { e.stopPropagation(); document.body.classList.remove('nav-open'); $('#notifBtn')?.click(); return; }
    if (can(k)) goTo(k); else toast('ليست لديك صلاحية لهذه الشاشة'); }));
  $('#notifBtn')?.addEventListener('click', e => { e.stopPropagation(); const p = $('#notifPanel'); p.hidden = !p.hidden; renderBell(); });
  document.addEventListener('click', e => {
    const p = $('#notifPanel'); if (!p || p.hidden) return;
    if (e.target.closest('#notifAll')) { const s = notifSeen(); buildNotifs().forEach(n => s.add(n.id)); saveSeen(s); renderBell(); return; }
    const it = e.target.closest('[data-nid]');
    if (it) { const s = notifSeen(); s.add(it.dataset.nid); saveSeen(s); p.hidden = true; renderBell(); goTo(it.dataset.npage, it.dataset.nq); return; }
    if (!e.target.closest('#notifPanel')) p.hidden = true;
  });

  // ---------- تبويبات الصفحات (مثل المتصفح): كل صفحة تُفتح في تبويب ويبقى ما قبلها مفتوحاً ----------
  const TABS_KEY = 'acc-erp-tabs', MAX_TABS = 14;
  const tabs = { list: [], view: {} };
  try { const t = JSON.parse(localStorage.getItem(TABS_KEY)); if (Array.isArray(t?.list)) tabs.list = t.list.filter(x => typeof x === 'string').slice(0, MAX_TABS); } catch {}
  const saveTabs = () => { try { localStorage.setItem(TABS_KEY, JSON.stringify({ list: tabs.list })); } catch {} };
  const tabIcon = p => EMO[p] || (p.startsWith('rep/') ? '📑' : p.startsWith('st/') ? '📈' : p.startsWith('wh/') ? '🏬' : p.startsWith('box/') ? (isBankBox(db.cashboxes.find(b => 'box/' + b.id === p)) ? '🏦' : '💵') : p.startsWith('acct/') ? '📒' : p.startsWith('cust/') ? '🤝' : p.startsWith('supp/') ? '🚚' : '📄');
  function renderTabs() {
    const bar = $('#tabBar'); if (!bar) return;
    tabs.list = tabs.list.filter(p => pageInfo(p) && can(p));
    bar.innerHTML = tabs.list.map(p => `<div class="tab ${p === state.page ? 'on' : ''}" data-tab-p="${esc(p)}" title="${esc(pageInfo(p).title)}" role="tab" aria-selected="${p === state.page}">
        <span class="tab-ico">${tabIcon(p)}</span><span class="tab-t">${esc(pageInfo(p).title)}</span>${badge(badges[p]?.() || 0)}
        <button type="button" class="tab-x" data-tab-x="${esc(p)}" title="إغلاق التبويب" aria-label="إغلاق">✕</button></div>`).join('')
      + (tabs.list.length > 1 ? `<button type="button" class="tab-closeall" id="tabCloseAll" title="إغلاق كل التبويبات عدا الحالي">إغلاق الباقي</button>` : '');
    bar.hidden = !tabs.list.length;
    bar.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function closeTab(p) {
    const i = tabs.list.indexOf(p); if (i < 0) return;
    tabs.list.splice(i, 1); delete tabs.view[p]; saveTabs();
    if (p === state.page) { const next = tabs.list[i] || tabs.list[i - 1] || 'dashboard'; if (decodeURIComponent(location.hash.slice(1)) === next) route(); else location.hash = next; }
    else renderTabs();
  }
  document.addEventListener('click', e => {
    const x = e.target.closest('[data-tab-x]'); if (x) { e.stopPropagation(); closeTab(x.dataset.tabX); return; }
    if (e.target.closest('#tabCloseAll')) { tabs.list = tabs.list.filter(p => p === state.page); saveTabs(); renderTabs(); return; }
    const t = e.target.closest('[data-tab-p]'); if (t && t.dataset.tabP !== state.page) location.hash = t.dataset.tabP;
  });
  document.addEventListener('auxclick', e => { const t = e.target.closest('[data-tab-p]'); if (t && e.button === 1) { e.preventDefault(); closeTab(t.dataset.tabP); } });

  function route() {
    if (!store.ready || !curUser()) return;
    buildPaths();
    const hash = decodeURIComponent(location.hash.slice(1)) || 'dashboard';
    let page = pageInfo(hash) ? hash : 'dashboard';
    if (!can(page)) page = ['dashboard', ...Object.keys(pagePath)].find(x => can(x)) || page;
    // حفظ حالة التبويب السابق (البحث والفلتر ومكان التمرير) واسترجاع حالة التبويب المفتوح
    if (state.page && page !== state.page) tabs.view[state.page] = { q: state.q, filter: state.filter, y: window.scrollY };
    const back = page !== state.page && pendingQuery === null ? tabs.view[page] : null;
    if (page !== state.page || pendingQuery !== null) { state.q = pendingQuery ?? back?.q ?? ''; state.filter = back?.filter ?? ''; pendingQuery = null; }
    if (!tabs.list.includes(page)) {
      const at = tabs.list.indexOf(state.page); tabs.list.splice(at < 0 ? tabs.list.length : at + 1, 0, page);
      while (tabs.list.length > MAX_TABS) { const drop = tabs.list.find(p => p !== page); tabs.list.splice(tabs.list.indexOf(drop), 1); delete tabs.view[drop]; }
      saveTabs();
    }
    const changed = page !== state.page;
    state.page = page;
    const path = pagePath[page];
    if (changed && path) path.keys.forEach(k => state.open.add(k));

    const info = pageInfo(page);
    $('#pageTitle').textContent = info.title;
    $('#pageSub').textContent = path?.titles.length ? `${path.titles.join(' › ')} › ${info.sub}` : info.sub;
    document.title = `${info.title} | ${appName()}`;
    closeModal();
    renderBrand();
    renderNav();
    renderTabs(); renderBell();
    renderPage();
    if (!(prefs.pinned && isMobile())) document.body.classList.remove('nav-open');
    if (changed) window.scrollTo(0, back?.y || 0);
  }

  // إعادة الرسم عند وصول تحديثات من مستخدمين آخرين (مع الحفاظ على مكان الكتابة)
  let renderTimer;
  // أثناء حفظ كمية كبيرة (استيراد/اعتماد جماعي) كل سجل يصل يطلب إعادة رسم: نحدّها بمرة كل 3 ثوانٍ حتى تبقى الصفحة قابلة للاستخدام
  let lastRenderAt = 0;
  function scheduleRender() {
    const busySync = store.pumping || store.queue.length > 0;
    if (busySync && renderTimer) return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null; lastRenderAt = Date.now();
      if (!store.ready) return;
      if (document.body.classList.contains('locked')) { const want = db.appUsers.length ? 'login' : 'setup'; if (state.authMode !== want) showAuth(want); return; }
      if (!state.page) return;
      sessionStillValid().then(ok => { if (!ok && session) logout('انتهت جلستك أو تم تعديل حسابك — سجّل الدخول مرة أخرى'); });
      const a = document.activeElement, id = a?.id, pos = a?.selectionStart;
      const inContent = a && content.contains(a);
      renderBrand(); renderNav(); renderTabs(); renderBell();
      if (!(inContent && !id)) renderPage();
      if (id && inContent) { const el = document.getElementById(id); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} } }
    }, busySync ? Math.max(80, 3000 - (Date.now() - lastRenderAt)) : 80);
  }

  // ---------- رأس القائمة وتذييلها ----------
  function renderBrand() {
    const name = appName();
    $('#brandName').textContent = name;
    $('#brandLetter').textContent = [...name.trim()][0] || 'م';
  }
  function roleText() {
    if (store.mode === 'local') return 'وضع محلي';
    if (store.me.isOwner) return 'مالك النظام';
    if (store.canAdmin) return 'مدير — كل الصلاحيات';
    return store.canWrite ? 'إدخال وتعديل' : 'مشاهدة فقط';
  }
  function applyRole() {
    const u = curUser();
    document.body.classList.toggle('ro', !store.canWrite);
    document.body.classList.toggle('no-admin', !store.canAdmin);
    $('#userName').textContent = u?.name || store.me.name || 'مستخدم';
    $('#userRole').textContent = u ? roleTitle(u) : roleText();
    $('#userAvatar').textContent = [...(u?.name || 'م').trim()][0] || 'م';
    $('#roBanner').hidden = store.canWrite;
    $('.admin-tools').hidden = !(canSp('adminTools') && store.canWrite);
  }
  function setSync(s) {
    store.status = s;
    const map = { connecting: ['جارٍ الاتصال…', ''], saved: ['متصل — مزامنة لحظية', 'ok'], saving: ['جارٍ الحفظ…', 'busy'], slow: ['الاتصال بطيء — قد تكون البيانات قديمة', 'warn'],
      error: ['انقطع الاتصال بقاعدة البيانات', 'err'], local: ['قاعدة بيانات محلية', 'local'], offline: ['قاعدة البيانات غير متاحة — حفظ مؤقت في المتصفح', 'warn'] };
    let [txt, cls] = map[s] || map.connecting;
    if (s === 'saving' && store.queue?.length > 5) txt = `جارٍ الحفظ… متبقي ${nf.format(store.queue.length)} سجل — لا تغلق الصفحة`;
    if (s === 'paused') { txt = `الحفظ متوقف لحظياً (حد سرعة قاعدة البيانات) ويُستأنف تلقائياً — متبقي ${nf.format(store.queue?.length || 0)} سجل، لا تغلق الصفحة`; cls = 'warn'; }
    const pill = $('#syncPill'); pill.className = `sync ${cls}`; pill.querySelector('span').textContent = txt;
    $('#onlineDot').className = `online ${cls}`;
    $('#onlineDot').title = txt;
  }
  function applyPin() {
    document.body.classList.toggle('unpinned', !prefs.pinned);
    $('#pinBtn').classList.toggle('on', prefs.pinned);
    $('#pinBtn').title = prefs.pinned ? 'إلغاء تثبيت القائمة' : 'تثبيت القائمة';
  }

  // ---------- أدوات المدير ----------
  $('#clearBoxesBtn').onclick = () => {
    if (!canSp('adminTools')) return denied();
    openModal('تفريغ خزائن محددة', [{ key: 'boxes', label: 'اختر الخزائن / البنوك التي ستُحذف سندات القبض والصرف الخاصة بها', input: 'checks', options: () => db.cashboxes.map(b => b.name) },
      { key: 'confirm', label: 'للتأكيد اكتب كلمة: تفريغ', input: 'text', full: true }], {}, (data, fd) => {
      const boxes = fd.getAll('boxes');
      if (!boxes.length) { toast('اختر خزينة واحدة على الأقل'); return false; }
      if (data.confirm.trim() !== 'تفريغ') { toast('اكتب كلمة "تفريغ" للتأكيد'); return false; }
      const n = db.receipts.filter(r => boxes.includes(r.box)).length + db.payments.filter(r => boxes.includes(r.box)).length;
      db.receipts = db.receipts.filter(r => !boxes.includes(r.box));
      db.payments = db.payments.filter(r => !boxes.includes(r.box));
      save(); scheduleRender(); toast(`تم حذف ${n} سند من ${boxes.length} خزينة`, 3500);
    });
  };
  $('#clearMovesBtn').onclick = () => {
    if (!canSp('adminTools')) return denied();
    const n = sum(TX_TABLES, t => db[t].length);
    const OPTS = [`حذف كل الحركات (${n} حركة: فواتير، سندات، تحويلات، قيود، أذون مخازن، رواتب...)`, 'تصفير الأرصدة الافتتاحية في شجرة الحسابات',
      'تصفير أرصدة أول المدة للعملاء والموردين', 'تصفير أرصدة أول المدة (الكميات) للأصناف'];
    openModal('تفريغ الحركات والأرصدة', [{ key: 'what', label: 'اختر ما تريد تفريغه — البيانات الأساسية (العملاء، الموردين، الأصناف، الحسابات، المستخدمين) تبقى كما هي', input: 'checks', options: () => OPTS },
      { key: 'confirm', label: 'للتأكيد اكتب: تفريغ', input: 'text', full: true }], {}, (data, fd) => {
      const what = fd.getAll('what').map(w => OPTS.indexOf(w));
      if (!what.length) { toast('اختر عنصراً واحداً على الأقل'); return false; }
      if (data.confirm.trim() !== 'تفريغ') { toast('اكتب كلمة "تفريغ" للتأكيد'); return false; }
      if (what.includes(1) && !store.canAdmin) { toast('تصفير أرصدة شجرة الحسابات متاح لمدير النظام فقط'); return false; }
      const done = [];
      if (what.includes(0)) { TX_TABLES.forEach(t => { db[t] = []; }); done.push(`${n} حركة`); }
      if (what.includes(1)) { db.accounts.forEach(a => { a.balance = 0; }); done.push('أرصدة الحسابات'); }
      if (what.includes(2)) { db.customers.forEach(c => { c.opening = 0; c.openDr = 0; c.openCr = 0; }); db.suppliers.forEach(c => { c.opening = 0; c.openDr = 0; c.openCr = 0; }); done.push('أرصدة العملاء والموردين'); }
      if (what.includes(3)) { db.items.forEach(i => { i.opening = 0; }); done.push('كميات الأصناف'); }
      save(); scheduleRender(); toast(`تم تفريغ: ${done.join('، ')}`, 4000);
    });
  };

  let toastTimer;
  function toast(msg, ms = 2400) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // البحث العام في كل قواعد البيانات
  $('#globalSearch').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    const hitAcc = db.accounts.some(a => a.code.includes(q) || a.name.toLowerCase().includes(q));
    const hit = Object.keys(modules).filter(k => k !== 'journal' && can(k)).find(k => db[k].some(r => modules[k].cols.some(c => String(val(r, c) ?? '').toLowerCase().includes(q))))
      || (hitAcc ? 'accounts' : glEntries().some(en => en.no.toLowerCase().includes(q) || en.desc.toLowerCase().includes(q)) ? 'journal' : null);
    if (!hit) return toast('لا توجد نتائج');
    goTo(hit, e.target.value.trim());
  });

  $('#menuBtn').onclick = () => document.body.classList.toggle('nav-open');
  $('#overlay').onclick = () => document.body.classList.remove('nav-open');
  $('#pinBtn').onclick = () => { prefs.pinned = !prefs.pinned; savePrefs(); applyPin(); if (!prefs.pinned) document.body.classList.remove('nav-open');
    toast(prefs.pinned ? '📌 تم تثبيت القائمة' : 'القائمة غير مثبتة — مرّر الماوس على حافة الشاشة أو اضغط ☰ لفتحها'); };
  // غير مثبتة: المرور على حافة الشاشة يفتح القائمة، والخروج منها يغلقها
  let hoverOpen = false;
  $('#edgeHot').addEventListener('mouseenter', () => { if (prefs.pinned || isMobile()) return; hoverOpen = true; document.body.classList.add('nav-open'); });
  $('#sidebar').addEventListener('mouseleave', () => { if (!hoverOpen || prefs.pinned) return; hoverOpen = false; if (!document.querySelector('.user-menu:not([hidden])')) document.body.classList.remove('nav-open'); });
  $('#refreshBtn').onclick = () => location.reload();
  // اللغة: العربية / English / Español — تُحفظ لكل متصفح
  (() => { const b = $('#langBtn'), L = window.ACC_LANG || 'ar', NAMES = { ar: 'العربية', en: 'English', es: 'Español' };
    b.querySelector('span').textContent = NAMES[L]; b.querySelector('b').textContent = L.toUpperCase();
    const menu = document.createElement('div'); menu.className = 'user-menu lang-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
    menu.innerHTML = Object.entries(NAMES).map(([k, n]) => `<button type="button" role="menuitem" data-lang="${k}" class="${k === L ? 'on' : ''}">${k === L ? '✓ ' : ''}${n}</button>`).join('');
    b.after(menu);
    b.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    menu.onclick = e => { const x = e.target.closest('[data-lang]'); if (x && x.dataset.lang !== L) window.setLang?.(x.dataset.lang); menu.hidden = true; };
    document.addEventListener('click', e => { if (!e.target.closest('.lang-menu, #langBtn')) menu.hidden = true; });
  })();
  $('#versionText').textContent = `الإصدار ${APP_VERSION}`;
  window.addEventListener('hashchange', route);

  (async () => {
    applyPin(); setSync('connecting');
    await boot();
    applyPin(); applyRole();
  })();
})();
