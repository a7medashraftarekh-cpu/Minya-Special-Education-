import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where,
  getDocs, onSnapshot, writeBatch, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------- إعدادات ---------- */
const APP_VERSION = "2026.10.22-3";
const LECTURE_MINUTES = 180; // المحاضرة تُغلق تلقائيًا بعد هذه المدة
const COLLEGE = "كلية التربية النوعية";
const CLASS_NAME = "الفرقة الأولى – إعلام";
const SCAN_LIB = "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js";
const XLSX_LIB = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
const CODE_DOMAIN = "@code.attendance.app";   // الحساب بالكود الجامعي
const PHONE_DOMAIN = "@phone.attendance.app";  // حسابات الدكاترة (برقم الهاتف)

/* ---------- حماية أساسية للواجهة ---------- */
// تنبيه: هذه الإجراءات رادعة فقط، والحماية الحقيقية هي قواعد Firestore (firestore.rules).
try { if (window.top !== window.self) window.top.location = window.self.location; } // منع تضمين الموقع داخل صفحة أخرى
catch { document.documentElement.innerHTML = ""; }
window.addEventListener("keydown", e => {
  const k = String(e.key || "").toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  const devtools =
    e.key === "F12" ||
    (ctrl && e.shiftKey && ["i", "j", "c", "k"].includes(k)) ||
    (ctrl && !e.shiftKey && k === "u") ||
    (e.metaKey && e.altKey && ["i", "j", "c", "u"].includes(k));
  if (devtools) { e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener("contextmenu", e => { if (!e.target.closest?.("input, textarea")) e.preventDefault(); });

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------- أدوات صغيرة ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
if ($("#ver")) $("#ver").textContent = `v${APP_VERSION}`;
const esc = x => String(x ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
const toDate = t => (t?.toDate ? t.toDate() : t ? new Date(t) : null);
const fmt = t => { const d = toDate(t); return d ? d.toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" }) : "…"; };
const fmtDay = t => { const d = toDate(t); return d ? d.toLocaleDateString("ar-EG", { dateStyle: "medium" }) : ""; };
const fmtShort = t => { const d = toDate(t); return d ? d.toLocaleDateString("ar-EG", { day: "numeric", month: "numeric" }) : ""; };
const num = n => Number(n).toLocaleString("ar-EG");
const setMain = html => { $("#main").innerHTML = html; };
const byName = (a, b, key = "name") => String(a[key]).localeCompare(String(b[key]), "ar");
const genderLabel = g => (g === "male" ? "ذكر" : g === "female" ? "أنثى" : "غير محدد");

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

// أي خطأ غير متوقع يظهر كتنبيه واحد بدل أن تتعطل الصفحة
let lastSoftFail = 0;
function softFail() {
  if (Date.now() - lastSoftFail < 5000) return;
  lastSoftFail = Date.now();
  try { toast("حدث خطأ غير متوقع، حاول مرة أخرى"); } catch { /* ignore */ }
}
window.addEventListener("unhandledrejection", e => { console.error(e.reason); e.preventDefault(); softFail(); });
window.addEventListener("error", e => { if (e.error) { console.error(e.error); softFail(); } });

function errText(e) {
  const map = {
    "auth/invalid-credential": "الكود/رقم الهاتف أو كلمة المرور غير صحيحة",
    "auth/invalid-email": "البيانات المدخلة غير صحيحة",
    "auth/email-already-in-use": "هذا الحساب مسجل بالفعل، سجّل الدخول",
    "auth/weak-password": "كلمة المرور ضعيفة، استخدم 6 أحرف على الأقل",
    "auth/network-request-failed": "لا يوجد اتصال بالإنترنت",
    "auth/too-many-requests": "محاولات كثيرة، حاول مرة أخرى بعد قليل",
    "permission-denied": "لا توجد صلاحية لهذه العملية. تأكد من نشر ملف firestore.rules الجديد"
  };
  return map[e?.code] || e?.message || "حدث خطأ غير متوقع";
}

function openModal(html) { const m = $("#modal"); m.innerHTML = html; m.classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); }
$("#modal").onclick = closeModal;
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

/* ---------- الكود الجامعي ورقم الهاتف ---------- */
const normPhone = v => String(v || "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[\s\-+()]/g, "");
const validPhone = p => /^\d{10,15}$/.test(p);
const validCode = c => /^\d{8}$/.test(c);
// يُظهر أول رقمين وآخر رقمين فقط
const maskPhone = v => { const p = normPhone(v); return p.length > 4 ? p.slice(0, 2) + "*".repeat(p.length - 4) + p.slice(-2) : p; };
// الطالب يدخل بالكود الجامعي (8 أرقام)، والدكتور برقم الهاتف، وتبقى الحسابات القديمة بالبريد
function loginEmail(v) {
  v = String(v || "").trim();
  if (v.includes("@")) return v;
  const p = normPhone(v);
  if (validCode(p)) return p + CODE_DOMAIN;
  if (validPhone(p)) return p + PHONE_DOMAIN;
  throw new Error("اكتب الكود الجامعي (8 أرقام) أو رقم الهاتف");
}

// ذكور ثم إناث (ثم "غير محدد")، وكل مجموعة مرتبة أبجديًا
const GENDER_GROUPS = [["male", "الذكور"], ["female", "الإناث"], ["", "غير محدد"]];
function groupByGender(list, nameKey = "name") {
  const g = x => (x.gender === "male" || x.gender === "female" ? x.gender : "");
  return GENDER_GROUPS
    .map(([key, title]) => ({ key, title, items: list.filter(x => g(x) === key).sort((a, b) => byName(a, b, nameKey)) }))
    .filter(grp => grp.items.length);
}

function loadScript(src, ready) {
  return new Promise((resolve, reject) => {
    if (ready()) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("تعذر تحميل مكتبة مطلوبة، تحقق من الاتصال"));
    document.head.appendChild(s);
  });
}

/* ---------- الحالة ---------- */
let user = null;
let profile = null;
let isDoctor = false;
let isLeader = false;
let isStaff = false;      // دكتور أو ليدر (أي ليدر بما فيهم الرئيسي)
let isMainLeader = false; // أول ليدر يدخل: أعلى صلاحية
let isLecturer = false;   // الدكتور والليدر الرئيسي: يبدؤون المحاضرات وينهونها ويحذفونها
let mainLeaderId = null;
let doctorExists = null;
let tab = "";
let registering = false;
let unsub = null;
let scanner = null;
let authNotice = "";
let scanLectureId = null; // المحاضرة المختارة في ماسح الحضور

const clearLive = () => { if (unsub) { unsub(); unsub = null; } };
async function stopScanner() {
  if (!scanner) return;
  const s = scanner;
  scanner = null;
  try { await s.stop(); } catch { /* غير مشغّل */ }
  try { s.clear(); } catch { /* ignore */ }
}

/* ---------- QR ---------- */
function qrSvg(text) {
  if (qrcode.stringToBytesFuncs?.["UTF-8"]) qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), m = 4;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m},${r + m}h1v1h-1z`;
  const size = n + m * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 8}" height="${size * 8}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
const cardPayload = code => `ATT1:${code}`;

/* ---------- الشاشات الأساسية ---------- */
function showAuth() { $("#loading").classList.add("hidden"); $("#appView").classList.add("hidden"); $("#authView").classList.remove("hidden"); }
function showApp() { $("#loading").classList.add("hidden"); $("#authView").classList.add("hidden"); $("#appView").classList.remove("hidden"); }

/* =====================================================
   الدخول والتسجيل
   ===================================================== */
function authScreen(mode = "login") {
  const titles = { login: "تسجيل الدخول", register: "حساب طالب جديد", setup: "إعداد النظام لأول مرة" };
  let fields = "", submit = "دخول", links = "";
  if (mode === "login") {
    fields = `
      <label>الكود الجامعي أو رقم الهاتف<input id="fId" type="text" autocomplete="username" required></label>
      <label>كلمة المرور<input id="fPass" type="password" autocomplete="current-password" required></label>`;
    links = `<button type="button" class="secondary full" id="goRegister">أول مرة؟ أنشئ حسابك بالكود الجامعي</button>`;
  } else if (mode === "register") {
    fields = `
      <label>الكود الجامعي<input id="fCode" inputmode="numeric" maxlength="8" placeholder="8 أرقام" autocomplete="username" required></label>
      <label>الاسم الرباعي<input id="fName" autocomplete="name" placeholder="مثال: أحمد محمد علي حسن" required></label>
      <label>كلمة المرور (6 أحرف على الأقل)<input id="fPass" type="password" minlength="6" autocomplete="new-password" required></label>
      <label>تأكيد كلمة المرور<input id="fPass2" type="password" minlength="6" autocomplete="new-password" required></label>`;
    submit = "إنشاء الحساب";
    links = `<button type="button" class="link" id="goLogin">لدي حساب بالفعل</button>`;
  } else {
    fields = `
      <p class="muted">تتم هذه الخطوة مرة واحدة فقط لإنشاء حساب الليدر الرئيسي (مدير النظام). تحتاج مفتاح الإعداد الذي كتبته في القواعد.</p>
      <label>الاسم الكامل<input id="fName" autocomplete="name" required></label>
      <label>رقم الهاتف (تدخل به)<input id="fPhone" type="tel" inputmode="tel" autocomplete="username" required></label>
      <label>كلمة المرور (6 أحرف على الأقل)<input id="fPass" type="password" minlength="6" autocomplete="new-password" required></label>
      <label>مفتاح الإعداد<input id="fKey" type="password" autocomplete="off" required></label>`;
    submit = "إنشاء حساب الليدر الرئيسي";
    links = `<button type="button" class="link" id="goLogin">رجوع لتسجيل الدخول</button>`;
  }
  $("#authCard").innerHTML = `
    <h1>${titles[mode]}</h1>
    <form id="authForm">${fields}<button class="primary full" id="authSubmit">${submit}</button></form>
    <div id="authMsg" class="msg" role="alert">${esc(authNotice)}</div>
    ${links}`;
  authNotice = "";
  $("#authForm").onsubmit = e => { e.preventDefault(); submitAuth(mode); };
  if ($("#goRegister")) $("#goRegister").onclick = () => authScreen("register");
  if ($("#goLogin")) $("#goLogin").onclick = () => authScreen("login");
}

async function submitAuth(mode) {
  const msg = $("#authMsg"), btn = $("#authSubmit");
  msg.textContent = "";
  btn.disabled = true;
  try {
    const pass = $("#fPass").value;
    if (mode === "login") {
      await signInWithEmailAndPassword(auth, loginEmail($("#fId").value), pass); // onAuthStateChanged يكمل
      return;
    }
    if (mode === "register") {
      const code = normPhone($("#fCode").value);
      if (!validCode(code)) throw new Error("الكود الجامعي 8 أرقام");
      if (pass.length < 6) throw new Error("كلمة المرور 6 أحرف على الأقل");
      if (pass !== $("#fPass2").value) throw new Error("كلمتا المرور غير متطابقتين");
      const name = $("#fName").value.trim().replace(/\s+/g, " ");
      if (name.split(" ").length < 4) throw new Error("اكتب الاسم رباعيًا (أربع كلمات على الأقل)");
      registering = true;
      const cred = await createUserWithEmailAndPassword(auth, code + CODE_DOMAIN, pass);
      try {
        await setDoc(doc(db, "users", cred.user.uid), {
          uid: cred.user.uid, code, name, role: "student", status: "incomplete", createdAt: serverTimestamp()
        });
      } catch (e) {
        await cred.user.delete().catch(() => {});
        throw e;
      }
      registering = false;
      await enter(cred.user);
      return;
    }
    // إعداد النظام لأول مرة: حساب الليدر الرئيسي (محمي بمفتاح الإعداد الموجود في القواعد)
    const name = $("#fName").value.trim().replace(/\s+/g, " ");
    const phone = normPhone($("#fPhone").value);
    const key = $("#fKey").value;
    if (name.length < 3) throw new Error("اكتب الاسم الكامل");
    if (!validPhone(phone)) throw new Error("اكتب رقم هاتف صحيح (أرقام فقط)");
    if (pass.length < 6) throw new Error("كلمة المرور 6 أحرف على الأقل");
    if (!key) throw new Error("اكتب مفتاح الإعداد");
    registering = true;
    const cred = await createUserWithEmailAndPassword(auth, phone + PHONE_DOMAIN, pass);
    const uid = cred.user.uid;
    try {
      const bt = writeBatch(db);
      bt.set(doc(db, "users", uid), { uid, name, phoneMasked: maskPhone(phone), role: "student", status: "approved", createdAt: serverTimestamp() });
      bt.set(doc(db, "userPrivate", uid), { uid, phone });
      bt.set(doc(db, "settings", "mainLeader"), { uid, setupKey: key, createdAt: serverTimestamp() });
      bt.set(doc(db, "leaders", uid), { uid, name, promotedBy: uid, createdAt: serverTimestamp() });
      await bt.commit();
    } catch (e) {
      await cred.user.delete().catch(() => {});
      throw new Error(e.code === "permission-denied" ? "مفتاح الإعداد غير صحيح، أو تم إعداد النظام من قبل" : errText(e));
    }
    registering = false;
    try { history.replaceState(null, "", location.pathname); } catch { /* ignore */ }
    await enter(cred.user);
  } catch (e) {
    registering = false;
    msg.textContent = errText(e);
    btn.disabled = false;
  }
}

onAuthStateChanged(auth, async u => {
  if (registering) return;
  clearLive();
  await stopScanner();
  if (!u) {
    user = null; profile = null; isDoctor = isLeader = isStaff = isMainLeader = isLecturer = false; mainLeaderId = null;
    try { doctorExists = (await getDoc(doc(db, "settings", "doctor"))).exists(); } catch { doctorExists = null; }
    authScreen(location.hash === "#setup" ? "setup" : "login");
    showAuth();
    return;
  }
  try { await enter(u); }
  catch (e) { console.error(e); authNotice = errText(e); await signOut(auth); }
});
$("#logoutBtn").onclick = () => signOut(auth);

/* =====================================================
   الدخول للتطبيق وتحديد الدور
   ===================================================== */
async function enter(u) {
  user = u;
  const [p, d, dl, l] = await Promise.all([
    getDoc(doc(db, "users", u.uid)),
    getDoc(doc(db, "settings", "doctor")),
    getDoc(doc(db, "doctors", u.uid)),
    getDoc(doc(db, "leaders", u.uid))
  ]);
  if (!p.exists()) {
    authNotice = "هذا الحساب غير مكتمل. أنشئ حسابًا جديدًا بالكود الجامعي أو تواصل مع الليدر.";
    await signOut(auth);
    return;
  }
  profile = p.data();
  doctorExists = d.exists();
  isDoctor = dl.exists() || (d.exists() && d.data().uid === u.uid);
  isLeader = !isDoctor && l.exists();
  isStaff = isDoctor || isLeader;
  if (profile.role === "doctor" && !isDoctor) {
    authNotice = "تم إلغاء صلاحيات هذا الحساب. تواصل مع الليدر الرئيسي.";
    await signOut(auth);
    return;
  }

  mainLeaderId = null;
  isMainLeader = false;
  if (isStaff) {
    let m = await getDoc(doc(db, "settings", "mainLeader"));
    if (!m.exists() && isLeader) {
      // أول ليدر يدخل يصبح الليدر الرئيسي
      let claimed = false;
      try { await setDoc(doc(db, "settings", "mainLeader"), { uid: u.uid, createdAt: serverTimestamp() }); claimed = true; } catch { /* سبقه ليدر آخر */ }
      if (claimed) { try { await updateDoc(doc(db, "users", u.uid), { status: "approved" }); profile.status = "approved"; } catch { /* غير حرج */ } }
      m = await getDoc(doc(db, "settings", "mainLeader"));
    }
    mainLeaderId = m.exists() ? m.data().uid : null;
    isMainLeader = isLeader && mainLeaderId === u.uid;
  }
  isLecturer = isDoctor || isMainLeader;

  $("#userName").textContent = profile.name;
  $("#userRole").textContent = isDoctor ? "دكتور" : isMainLeader ? "ليدر رئيسي" : isLeader ? "ليدر" : "طالب";
  showApp();

  if (!isStaff) {
    if (profile.status === "incomplete") return onboardScreen();
    if (profile.status !== "approved") return statusScreen(profile.status === "removed");
  }
  tab = !isStaff ? "card" : isLecturer ? "live" : "scan";
  buildTabs();
  render();
}

function statusScreen(removed) {
  $("#tabs").innerHTML = "";
  setMain(`<div class="card center">
    <h1>${removed ? "تم رفض حسابك" : "حسابك قيد المراجعة"}</h1>
    <p class="muted">${removed ? "تم رفض أو إيقاف حسابك. تواصل مع الليدر الرئيسي." : "تم استلام بياناتك. سيظهر كارنيهك بعد موافقة الليدر الرئيسي على حسابك."}</p>
    <button class="primary" id="refreshBtn">تحديث الحالة</button>
  </div>`);
  $("#refreshBtn").onclick = () => enter(user).catch(e => toast(errText(e)));
}

/* إكمال البيانات عند أول دخول: صورة + رقم هاتف + النوع */
async function onboardScreen() {
  $("#tabs").innerHTML = "";
  const rg = "";
  setMain(`
    <section class="card">
      <h1>أهلًا ${esc(profile.name)}</h1>
      <p class="muted">أكمل بياناتك لمرة واحدة: صورتك الشخصية، رقم هاتفك، والنوع.</p>
      <form id="obForm">
        <div class="photo-pick">
          <img id="obPreview" class="hidden" alt="الصورة الشخصية">
          <label class="photo-btn" for="obPhoto">اختيار صورة أو التقاطها<input id="obPhoto" type="file" accept="image/*"></label>
        </div>
        <label>رقم الهاتف<input id="obPhone" type="tel" inputmode="tel" autocomplete="tel" required></label>
        <fieldset class="gender"><legend>النوع</legend>
          <label><input type="radio" name="obGender" value="male" ${rg === "male" ? "checked" : ""} required> ذكر</label>
          <label><input type="radio" name="obGender" value="female" ${rg === "female" ? "checked" : ""}> أنثى</label>
        </fieldset>
        <button class="primary full" id="obSubmit">حفظ ومتابعة</button>
      </form>
      <div id="obMsg" class="msg" role="alert"></div>
    </section>`);
  let photoData = "";
  $("#obPhoto").onchange = async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      photoData = await compressPhoto(f);
      $("#obPreview").src = photoData;
      $("#obPreview").classList.remove("hidden");
      $("#obMsg").textContent = "";
    } catch (err) { $("#obMsg").textContent = err.message; }
  };
  $("#obForm").onsubmit = async e => {
    e.preventDefault();
    const msg = $("#obMsg"), btn = $("#obSubmit");
    msg.textContent = "";
    const phone = normPhone($("#obPhone").value);
    const gender = document.querySelector('input[name="obGender"]:checked')?.value;
    if (!photoData) { msg.textContent = "أضف صورتك الشخصية"; return; }
    if (!validPhone(phone)) { msg.textContent = "اكتب رقم هاتف صحيح (أرقام فقط)"; return; }
    if (!gender) { msg.textContent = "اختر النوع"; return; }
    btn.disabled = true;
    try {
      const bt = writeBatch(db);
      bt.set(doc(db, "photos", user.uid), { uid: user.uid, data: photoData });
      bt.set(doc(db, "userPrivate", user.uid), { uid: user.uid, phone });
      bt.update(doc(db, "users", user.uid), { status: "pending", gender, phoneMasked: maskPhone(phone) });
      await bt.commit();
      await enter(user);
    } catch (err) { msg.textContent = errText(err); btn.disabled = false; }
  };
}

// تصغير الصورة (300×400) وحفظها JPEG صغيرة الحجم
async function compressPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("تعذر قراءة الصورة، اختر صورة أخرى"));
      i.src = url;
    });
    const W = 300, H = 400;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    const r = Math.max(W / img.width, H / img.height);
    const w = img.width * r, h = img.height * r;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    return c.toDataURL("image/jpeg", 0.75);
  } finally { URL.revokeObjectURL(url); }
}

/* ---------- التنقل ---------- */
function tabsFor() {
  if (!isStaff) return [["card", "بطاقتي"], ["mine", "حضوري"], ["account", "حسابي"]];
  const t = [];
  if (isLecturer) t.push(["live", "المحاضرة"]);
  t.push(["scan", "تسجيل الحضور"], ["lectures", "المحاضرات"], ["sheets", "الكشوف"], ["students", "الطلاب"]);
  if (isMainLeader) t.push(["admin", "الإدارة"]);
  if (!isDoctor) t.push(["account", "حسابي"]);
  return t;
}
function buildTabs() {
  $("#tabs").innerHTML = tabsFor().map(([k, l]) => `<button data-tab="${k}" ${k === tab ? 'class="active" aria-current="page"' : ""}>${l}</button>`).join("");
  $$("#tabs button").forEach(b => b.onclick = () => go(b.dataset.tab));
}
async function go(t) {
  await stopScanner();
  clearLive();
  tab = t;
  buildTabs();
  render();
}
async function render() {
  setMain(`<div class="card muted">جارٍ التحميل...</div>`);
  const views = { live: liveTab, scan: scanTab, lectures: lecturesTab, sheets: sheetsTab, students: studentsTab, admin: adminTab, card: cardTab, mine: mineTab, account: accountTab };
  try { await views[tab](); }
  catch (e) {
    console.error(e);
    setMain(`<div class="card"><h2>تعذر تحميل البيانات</h2><p class="muted">${esc(errText(e))}</p><button class="primary" id="retry">إعادة المحاولة</button></div>`);
    $("#retry").onclick = render;
  }
}

/* =====================================================
   المحاضرات (الدكتور والليدر الرئيسي)
   ===================================================== */
async function closeLecture(id) {
  await updateDoc(doc(db, "lectures", id), { status: "closed", closedAt: serverTimestamp() });
}
const isLive = l => l.status === "active" && toDate(l.endAt)?.getTime() > Date.now();

async function liveTab() {
  const [ls, cs] = await Promise.all([
    getDocs(query(collection(db, "lectures"), where("status", "==", "active"))),
    getDocs(collection(db, "courses"))
  ]);
  const own = l => isMainLeader || l.doctorId === user.uid;
  const active = [], stale = [];
  ls.docs.forEach(d => {
    const l = { id: d.id, ...d.data() };
    if (!own(l)) return;
    (isLive(l) ? active : stale).push(l);
  });
  for (const l of stale) await closeLecture(l.id).catch(() => {}); // محاضرة انتهى وقتها
  const courses = cs.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => isMainLeader || c.doctorId === user.uid).sort(byName);

  setMain(`
    ${active.length ? `<section class="card"><h2>محاضرات جارية</h2><div class="list">
      ${active.map(l => `<div class="item static">
        <div><b>${esc(l.title)}</b><small>${esc(l.courseName || "")} — ${esc(l.doctorName || "")}</small><small>${fmt(l.startAt)}</small></div>
        <div class="acts">
          <button class="primary small" data-scan="${esc(l.id)}">ماسح الحضور</button>
          <button class="secondary small" data-open="${esc(l.id)}">فتح</button>
          <button class="danger small" data-end="${esc(l.id)}">إنهاء</button>
        </div></div>`).join("")}</div></section>` : ""}
    <form class="card" id="startForm">
      <h1>محاضرة جديدة</h1>
      ${courses.length ? `
        <label>المادة<select id="lecCourse">${courses.map(c => `<option value="${esc(c.id)}">${esc(c.name)} — ${esc(c.doctorName || "")}</option>`).join("")}</select></label>
        <label>عنوان المحاضرة (اختياري)<input id="lecTitle" maxlength="60" placeholder="مثال: المحاضرة 3"></label>
        <button class="primary big full" id="startBtn">ابدأ المحاضرة</button>`
      : `<p class="muted">لا توجد مواد مسندة إليك. اطلب من الليدر الرئيسي إضافة مادة وتعيينك عليها.</p>`}
    </form>`);

  $$("[data-scan]").forEach(b => b.onclick = () => { scanLectureId = b.dataset.scan; go("scan"); });
  $$("[data-open]").forEach(b => b.onclick = () => lectureView(b.dataset.open));
  $$("[data-end]").forEach(b => b.onclick = async () => {
    if (!confirm("إنهاء المحاضرة؟ لن يمكن تسجيل حضور جديد بعد ذلك.")) return;
    try { await closeLecture(b.dataset.end); go("live"); } catch (e) { toast(errText(e)); }
  });
  if ($("#startForm") && courses.length) {
    $("#startForm").onsubmit = async e => {
      e.preventDefault();
      const course = courses.find(c => c.id === $("#lecCourse").value);
      $("#startBtn").disabled = true;
      try {
        const id = doc(collection(db, "lectures")).id;
        const bt = writeBatch(db);
        // إغلاق أي محاضرة جارية أخرى لنفس الدكتور
        active.filter(l => l.doctorId === course.doctorId).forEach(l => bt.update(doc(db, "lectures", l.id), { status: "closed", closedAt: serverTimestamp() }));
        bt.set(doc(db, "lectures", id), {
          title: $("#lecTitle").value.trim() || `${course.name} - ${new Date().toLocaleDateString("ar-EG")}`,
          courseId: course.id, courseName: course.name,
          doctorId: course.doctorId, doctorName: course.doctorName || "",
          startAt: serverTimestamp(),
          endAt: Timestamp.fromDate(new Date(Date.now() + LECTURE_MINUTES * 60000)),
          status: "active", createdAt: serverTimestamp()
        });
        await bt.commit();
        scanLectureId = id;
        go("scan");
      } catch (err) { toast(errText(err)); $("#startBtn").disabled = false; }
    };
  }
}

async function lecturesTab() {
  const q = isDoctor && !isMainLeader
    ? query(collection(db, "lectures"), where("doctorId", "==", user.uid))
    : collection(db, "lectures");
  const ls = await getDocs(q);
  const list = ls.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (toDate(b.startAt)?.getTime() || 0) - (toDate(a.startAt)?.getTime() || 0));
  setMain(`
    <h1>المحاضرات</h1>
    <div class="list">
      ${list.map(l => `<button class="item" data-id="${esc(l.id)}">
        <div><b>${esc(l.title)}</b><small>${esc(l.courseName || "")}${l.doctorName ? " — " + esc(l.doctorName) : ""}</small><small>${fmt(l.startAt)}</small></div>
        <span class="badge ${isLive(l) ? "ok" : ""}">${isLive(l) ? "جارية" : "منتهية"}</span>
      </button>`).join("") || `<div class="card muted">لا توجد محاضرات بعد.</div>`}
    </div>`);
  $$(".item").forEach(b => b.onclick = () => lectureView(b.dataset.id));
}

async function lectureView(id) {
  clearLive();
  const l = await getDoc(doc(db, "lectures", id));
  if (!l.exists()) { toast("المحاضرة غير موجودة"); return go(tab); }
  const lec = { id, ...l.data() };
  const live = isLive(lec);
  const canManage = isMainLeader || (isDoctor && lec.doctorId === user.uid);

  setMain(`
    ${tab === "lectures" ? `<button class="link back" id="backBtn">رجوع إلى المحاضرات</button>` : ""}
    <section class="card">
      <div class="lec-head">
        <div><h1>${esc(lec.title)}</h1><p class="muted">${esc(lec.courseName || "")}${lec.doctorName ? " — " + esc(lec.doctorName) : ""}<br>${fmt(lec.startAt)}</p></div>
        <span class="badge ${live ? "ok" : ""}">${live ? "جارية" : "منتهية"}</span>
      </div>
      ${live ? `<div class="row">
        ${isLeader || canManage ? `<button class="primary" id="goScan">ماسح الحضور</button>` : ""}
        ${canManage ? `<button class="danger" id="endBtn">إنهاء المحاضرة</button>` : ""}
      </div>` : ""}
    </section>
    <section class="card">
      <div class="count-row"><strong id="cnt">٠</strong><span>طالب حضروا</span></div>
      <ul id="attList" class="att"></ul>
      ${canManage ? `<button class="primary full" id="manualBtn">تحضير طالب يدويًا</button>` : ""}
      <label>نوع الكشف<select id="exType">
        <option value="all">حضور وغياب (كل الطلاب)</option><option value="present">الحاضرون فقط</option><option value="absent">الغائبون فقط</option></select></label>
      <div class="row"><button class="secondary" id="exXlsx">تنزيل Excel</button><button class="secondary" id="exPdf">PDF / طباعة</button></div>
      ${canManage ? `<button class="danger full" id="delLecBtn">حذف المحاضرة</button>` : ""}
    </section>`);

  if ($("#backBtn")) $("#backBtn").onclick = () => go("lectures");
  if ($("#goScan")) $("#goScan").onclick = () => { scanLectureId = id; go("scan"); };
  if ($("#endBtn")) $("#endBtn").onclick = async () => {
    if (!confirm("إنهاء المحاضرة؟ لن يمكن تسجيل حضور جديد بعد ذلك.")) return;
    try { await closeLecture(id); lectureView(id); } catch (e) { toast(errText(e)); }
  };

  let rows = [], times = {};
  const drawList = () => {
    $("#cnt").textContent = num(rows.length);
    const row = r => `<li>
      <div><b>${esc(r.studentName)}</b><small>${esc(r.studentCode || "")}</small></div>
      ${isMainLeader ? `<time>${times[r.id] ? fmt(times[r.id]).split("،").pop().trim() : "…"}</time>` : ""}
      ${isMainLeader ? `<button class="icon-btn" data-del="${esc(r.id)}" aria-label="حذف هذا التسجيل">×</button>` : ""}
    </li>`;
    $("#attList").innerHTML = groupByGender(rows, "studentName")
      .map(gr => `<li class="grp">${gr.title} (${num(gr.items.length)})</li>${gr.items.map(row).join("")}`).join("")
      || `<li class="empty">لم يسجّل أحد حتى الآن</li>`;
    $$("[data-del]").forEach(b => b.onclick = async () => {
      if (!confirm("حذف تسجيل الحضور هذا؟")) return;
      try {
        const bt = writeBatch(db);
        bt.delete(doc(db, "attendance", b.dataset.del));
        bt.delete(doc(db, "attendanceTimes", b.dataset.del));
        await bt.commit();
      } catch (e) { toast(errText(e)); }
    });
  };
  const u1 = onSnapshot(query(collection(db, "attendance"), where("lectureId", "==", id)), snap => {
    rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    drawList();
  }, e => toast(errText(e)));
  let u2 = () => {};
  if (isMainLeader) {
    u2 = onSnapshot(query(collection(db, "attendanceTimes"), where("lectureId", "==", id)), snap => {
      times = {};
      snap.docs.forEach(d => { const t = toDate(d.data().createdAt); if (t) times[d.id] = t; });
      drawList();
    }, () => {});
  }
  unsub = () => { u1(); u2(); };

  const exportNow = async kind => {
    try {
      const ds = await lectureDataset(lec, $("#exType").value);
      if (kind === "xlsx") await exportExcel(ds); else printDataset(ds);
    } catch (e) { toast(errText(e)); }
  };
  $("#exXlsx").onclick = () => exportNow("xlsx");
  $("#exPdf").onclick = () => exportNow("pdf");

  if ($("#manualBtn")) $("#manualBtn").onclick = () => manualAdd(lec, () => rows);
  if ($("#delLecBtn")) $("#delLecBtn").onclick = async () => {
    if (!isMainLeader && rows.length) { toast("لا يمكن حذف محاضرة سُجّل فيها حضور. يحذفها الليدر الرئيسي فقط."); return; }
    if (!confirm(`حذف "${lec.title}" نهائيًا؟${rows.length ? "\nسيتم حذف سجلات حضورها أيضًا ولا يمكن التراجع." : ""}`)) return;
    try {
      clearLive();
      const refs = [doc(db, "lectures", id)];
      rows.forEach(r => { refs.push(doc(db, "attendance", r.id), doc(db, "attendanceTimes", r.id)); });
      for (let i = 0; i < refs.length; i += 400) {
        const b = writeBatch(db);
        refs.slice(i, i + 400).forEach(r => b.delete(r));
        await b.commit();
      }
      toast("تم حذف المحاضرة");
      go(tab === "live" ? "live" : "lectures");
    } catch (e) { toast(errText(e)); lectureView(id); }
  };
}

// الطلاب المعتمدون (أسماؤهم كما كتبوها وقبلها الليدر الرئيسي)
async function approvedStudents() {
  const snap = await getDocs(query(collection(db, "users"), where("role", "==", "student")));
  return snap.docs.map(d => d.data()).filter(u => u.status === "approved");
}

/* تحضير يدوي من الطلاب المعتمدين */
async function manualAdd(lec, getRows) {
  let students;
  try { students = await approvedStudents(); } catch (e) { toast(errText(e)); return; }
  if (!students.length) { toast("لا يوجد طلاب معتمدون بعد"); return; }
  openModal(`
    <div class="sheet" id="sheet">
      <h2>تحضير طالب يدويًا</h2>
      <input id="mSearch" class="search" type="search" placeholder="ابحث بالاسم أو الكود">
      <ul id="mList" class="att pick"></ul>
      <button class="secondary full" id="mClose">إغلاق</button>
    </div>`);
  $("#sheet").onclick = e => e.stopPropagation();
  $("#mClose").onclick = closeModal;
  const draw = () => {
    const present = new Set(getRows().map(r => r.studentId));
    const k = $("#mSearch").value.trim().toLowerCase();
    const list = students.filter(s => `${s.name} ${s.code || ""}`.toLowerCase().includes(k));
    const item = s => `<li><div><b>${esc(s.name)}</b><small>${esc(s.code || "")}</small></div>
      ${present.has(s.uid) ? `<span class="badge ok">حاضر</span>` : `<button class="primary small" data-add="${esc(s.uid)}">تحضير</button>`}</li>`;
    $("#mList").innerHTML = groupByGender(list).map(gr => `<li class="grp">${gr.title}</li>${gr.items.slice(0, 80).map(item).join("")}`).join("")
      || `<li class="empty">لا توجد نتائج</li>`;
    $$("[data-add]").forEach(b => b.onclick = async () => {
      const st = students.find(x => x.uid === b.dataset.add);
      b.disabled = true;
      try {
        await writeAttendance(lec, { uid: st.uid, code: st.code || "", name: st.name, gender: st.gender || "" }, "manual");
        toast(`تم تحضير ${st.name}`);
        setTimeout(draw, 500);
      } catch (e) { toast(errText(e)); b.disabled = false; }
    });
  };
  $("#mSearch").oninput = draw;
  draw();
}

// كتابة سجل الحضور + وقته (الوقت في مجموعة منفصلة يقرؤها الليدر الرئيسي والطالب صاحبها فقط)
async function writeAttendance(lec, st, method) {
  const attId = `${lec.id}_${st.uid}`;
  const bt = writeBatch(db);
  bt.set(doc(db, "attendance", attId), {
    lectureId: lec.id, courseId: lec.courseId || "", courseName: lec.courseName || "", doctorId: lec.doctorId || "",
    studentId: st.uid, studentCode: st.code || "", studentName: st.name, gender: st.gender || "",
    lectureTitle: String(lec.title).slice(0, 60), status: "present", method, by: user.uid
  });
  bt.set(doc(db, "attendanceTimes", attId), { lectureId: lec.id, studentId: st.uid, createdAt: serverTimestamp() });
  await bt.commit();
  return attId;
}

/* =====================================================
   ماسح الحضور: الدكتور أو الليدر يمسح كارنيه الطالب فيُسجَّل فورًا
   ===================================================== */
let scanLog = [];
let lastScan = { code: "", t: 0 };
let scanBusy = false;

async function scanTab() {
  const snap = await getDocs(query(collection(db, "lectures"), where("status", "==", "active")));
  const lectures = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(l => isLive(l) && (isLeader || l.doctorId === user.uid))
    .sort((a, b) => (toDate(b.startAt)?.getTime() || 0) - (toDate(a.startAt)?.getTime() || 0));
  if (!lectures.length) {
    setMain(`<section class="card center"><h1>لا توجد محاضرة جارية</h1>
      <p class="muted">يبدأ الدكتور أو الليدر الرئيسي المحاضرة أولًا، ثم يظهر الماسح هنا.</p>
      <button class="primary" id="refreshScan">تحديث</button></section>`);
    $("#refreshScan").onclick = () => go("scan");
    return;
  }
  if (!lectures.find(l => l.id === scanLectureId)) scanLectureId = lectures[0].id;
  scanLog = [];
  setMain(`
    <section class="card">
      <h1>تسجيل الحضور بمسح الكارنيه</h1>
      <label>المحاضرة<select id="scanLec">${lectures.map(l =>
        `<option value="${esc(l.id)}" ${l.id === scanLectureId ? "selected" : ""}>${esc(l.courseName || "محاضرة")} — ${esc(l.title)}</option>`).join("")}</select></label>
      <div id="reader"></div>
      <button class="primary big full" id="openCam">فتح الكاميرا</button>
      <button class="ghost full hidden" id="stopCam">إيقاف الكاميرا</button>
      <div id="scanRes"></div>
      <label>أو اكتب الكود الجامعي<input id="mCode" inputmode="numeric" maxlength="8" placeholder="8 أرقام"></label>
      <button class="secondary full" id="mGo">تسجيل بالكود</button>
      <ul id="scanLog" class="att"></ul>
    </section>`);
  const lecNow = () => lectures.find(l => l.id === $("#scanLec").value) || lectures[0];
  $("#scanLec").onchange = () => { scanLectureId = $("#scanLec").value; };

  $("#openCam").onclick = async () => {
    $("#openCam").classList.add("hidden");
    try {
      await loadScript(SCAN_LIB, () => window.Html5Qrcode);
      $("#reader").classList.add("on");
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      scanner = new Html5Qrcode("reader");
      await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 240, height: 240 } },
        text => { const m = /^ATT1:(\d{8})$/.exec(String(text).trim()) || /^(\d{8})$/.exec(String(text).trim()); if (m) handleCode(m[1], "scan", lecNow()); },
        () => {});
      $("#stopCam").classList.remove("hidden");
    } catch (e) {
      await stopScanner();
      $("#reader").classList.remove("on");
      $("#scanRes").innerHTML = `<div class="result bad">${esc(e.message?.includes("مكتبة") ? e.message : "تعذر تشغيل الكاميرا. اسمح للموقع باستخدام الكاميرا وتأكد أنه يعمل عبر HTTPS.")}</div>`;
      $("#openCam").textContent = "إعادة المحاولة";
      $("#openCam").classList.remove("hidden");
    }
  };
  $("#stopCam").onclick = async () => {
    await stopScanner();
    $("#reader").classList.remove("on");
    $("#stopCam").classList.add("hidden");
    $("#openCam").textContent = "فتح الكاميرا";
    $("#openCam").classList.remove("hidden");
  };
  $("#mGo").onclick = () => {
    const c = normPhone($("#mCode").value);
    if (!validCode(c)) { toast("الكود الجامعي 8 أرقام"); return; }
    handleCode(c, "code", lecNow());
    $("#mCode").value = "";
  };
}

function scanResultHtml(r) {
  return `<div class="scan-res ${r.ok ? "ok" : "bad"}">
    ${r.photo ? `<img src="${esc(r.photo)}" alt="">` : `<div class="noimg">${esc((r.name || "؟").charAt(0))}</div>`}
    <div><b>${esc(r.name || "")}</b><small>${esc(r.code || "")}</small><span>${esc(r.msg)}</span></div></div>`;
}

async function handleCode(code, method, lec) {
  if (scanBusy) return;
  if (code === lastScan.code && Date.now() - lastScan.t < 4000) return; // نفس الكارنيه خلال ثوانٍ
  scanBusy = true;
  lastScan = { code, t: Date.now() };
  if ($("#scanRes")) $("#scanRes").innerHTML = `<div class="result">جارٍ التسجيل...</div>`;
  let res;
  try {
    const r = await registerByCode(code, method, lec);
    res = { ok: true, ...r, msg: `تم تسجيل الحضور ✓${r.msg ? " " + r.msg : ""}` };
    try { navigator.vibrate?.(60); } catch { /* غير مدعوم */ }
  } catch (e) {
    console.error(e);
    res = { ok: false, msg: e.message || "تعذر التسجيل", ...(e.info || { code }) };
  }
  scanBusy = false;
  if (!$("#scanRes")) return;
  $("#scanRes").innerHTML = scanResultHtml(res);
  scanLog.unshift(res);
  scanLog = scanLog.slice(0, 8);
  $("#scanLog").innerHTML = scanLog.map(r => `<li><div><b>${esc(r.name || r.code)}</b><small>${esc(r.msg)}</small></div><span class="badge ${r.ok ? "ok" : ""}">${r.ok ? "✓" : "✗"}</span></li>`).join("");
}

async function registerByCode(code, method, lec) {
  const us = await getDocs(query(collection(db, "users"), where("code", "==", code)));
  const acct = us.docs[0]?.data();
  if (!acct) { const e = new Error("هذا الكود غير مسجّل في الموقع. يجب أن ينشئ الطالب حسابه أولًا."); e.info = { code }; throw e; }
  let photo = "";
  try { const ph = await getDoc(doc(db, "photos", acct.uid)); if (ph.exists()) photo = ph.data().data; } catch { /* الصورة اختيارية */ }
  const info = { name: acct.name, code, photo };
  if (acct.status === "removed") { const e = new Error("حساب هذا الطالب مرفوض أو موقوف"); e.info = info; throw e; }
  if (acct.status !== "approved") { const e = new Error("حساب الطالب لم يُعتمد بعد من الليدر الرئيسي"); e.info = info; throw e; }
  try {
    await writeAttendance(lec, { uid: acct.uid, code, name: acct.name, gender: acct.gender || "" }, method);
  } catch (e) {
    if (e.code === "permission-denied") {
      let already = false;
      try { already = (await getDoc(doc(db, "attendance", `${lec.id}_${acct.uid}`))).exists(); } catch { /* ignore */ }
      const err = new Error(already ? "تم تسجيل حضوره من قبل" : "تعذر التسجيل: تأكد أن المحاضرة ما زالت جارية");
      err.info = info;
      throw err;
    }
    throw e;
  }
  return { ...info, msg: "" };
}

/* =====================================================
   الطلاب (قائمة الطلاب + الموافقات + الليدرز)
   ===================================================== */
async function studentsTab() {
  const [us, lds] = await Promise.all([
    getDocs(query(collection(db, "users"), where("role", "==", "student"))),
    getDocs(collection(db, "leaders"))
  ]);
  const leaderIds = new Set(lds.docs.map(d => d.id));
  const users = us.docs.map(d => d.data());
  const priv = {}; // الأرقام الكاملة: الليدر الرئيسي فقط
  if (isMainLeader) { try { (await getDocs(collection(db, "userPrivate"))).forEach(d => { priv[d.id] = d.data().phone; }); } catch { /* ignore */ } }
  const phoneOf = u => (u ? (isMainLeader ? (priv[u.uid] || "") : (u.phoneMasked || "")) : "");
  const phoneHtml = u => `<span dir="ltr">${esc(phoneOf(u))}</span>`;

  const rows = users.map(u => ({ key: u.uid, code: u.code || "", name: u.name, gender: u.gender || "", user: u }));
  const statusOf = r => (leaderIds.has(r.user.uid) ? "approved" : (r.user.status || "pending"));
  const stLabel = { incomplete: "لم يُكمل بياناته", pending: "قيد المراجعة", approved: "معتمد", removed: "مرفوض/موقوف" };

  setMain(`
    <h1>الطلاب <small class="muted">(${num(rows.length)})</small></h1>
    <div id="pendingBox"></div>
    <div id="editBox"></div>
    <input id="search" class="search" type="search" placeholder="ابحث بالاسم أو الكود أو الهاتف">
    <div class="card table-wrap"><table class="table">
      <thead><tr><th>الاسم</th><th>الكود</th><th>الحالة</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
    <div id="removedBox"></div>`);

  // طلبات تعديل الحسابات (الليدر الرئيسي فقط)
  let reqs = [];
  if (isMainLeader) { try { reqs = (await getDocs(collection(db, "editRequests"))).docs.map(d => d.data()).filter(r => r.status === "pending"); } catch { /* ignore */ } }
  const findUser = uid => users.find(x => x.uid === uid);
  let pendShown = 20;

  const setStatus = async (uid, status, msg) => {
    try { await updateDoc(doc(db, "users", uid), { status }); findUser(uid).status = status; toast(msg); draw(); }
    catch (e) { toast(errText(e)); }
  };

  const draw = () => {
    const pending = rows.filter(r => r.user && statusOf(r) === "pending");
    const removed = rows.filter(r => statusOf(r) === "removed");
    const canPromote = isMainLeader || (isDoctor && !mainLeaderId && leaderIds.size === 0);

    // طلبات الانضمام
    const shown = pending.slice(0, pendShown);
    $("#pendingBox").innerHTML = !pending.length ? "" : isMainLeader
      ? `<div class="card"><h2>طلبات قيد المراجعة (${num(pending.length)})</h2>
          <div class="list">${shown.map(r => `<div class="item static">
            <img class="thumb" data-ph="${esc(r.user.uid)}" alt="">
            <div><b>${esc(r.name)}</b><small>${esc(r.code)} · ${phoneHtml(r.user)} · ${genderLabel(r.user.gender)}</small></div>
            <div class="acts"><button class="primary small" data-approve="${esc(r.user.uid)}">قبول</button><button class="ghost small" data-reject="${esc(r.user.uid)}">رفض</button></div>
          </div>`).join("")}</div>
          <div class="row">
            <button class="primary" id="approveShown">قبول الظاهرين (${num(shown.length)})</button>
            ${pending.length > shown.length ? `<button class="secondary" id="moreBtn">عرض المزيد</button>` : ""}
          </div></div>`
      : `<div class="card muted">يوجد ${num(pending.length)} طلب بانتظار موافقة الليدر الرئيسي.</div>`;
    shown.forEach(async r => { // الصور تُحمّل تباعًا
      const img = $(`img[data-ph="${r.user.uid}"]`);
      if (!img) return;
      try { const p = await getDoc(doc(db, "photos", r.user.uid)); if (p.exists()) img.src = p.data().data; } catch { /* ignore */ }
    });

    // طلبات التعديل
    const editable = reqs.filter(r => findUser(r.uid));
    $("#editBox").innerHTML = !(isMainLeader && editable.length) ? "" : `
      <div class="card"><h2>طلبات تعديل الحسابات (${num(editable.length)})</h2><div class="list">
        ${editable.map(r => {
          const cur = findUser(r.uid), curPhone = priv[r.uid] || "", lines = [];
          if (r.name !== cur.name) lines.push(`الاسم: ${esc(cur.name)} ← <b>${esc(r.name)}</b>`);
          if (r.phone !== curPhone) lines.push(`الهاتف: <span dir="ltr">${esc(curPhone || "—")}</span> ← <b dir="ltr">${esc(r.phone)}</b>`);
          if (r.gender !== (cur.gender || "")) lines.push(`النوع: ${genderLabel(cur.gender)} ← <b>${genderLabel(r.gender)}</b>`);
          return `<div class="item static req"><div><b>${esc(cur.name)}</b>${lines.map(l => `<small>${l}</small>`).join("") || "<small>لا تغيير فعلي</small>"}</div>
            <div class="acts"><button class="primary small" data-eapprove="${esc(r.uid)}">موافقة</button><button class="ghost small" data-ereject="${esc(r.uid)}">رفض</button></div></div>`;
        }).join("")}</div></div>`;

    // الجدول
    const k = $("#search").value.trim().toLowerCase();
    const list = rows.filter(r => statusOf(r) !== "removed" && `${r.name} ${r.code} ${phoneOf(r.user)}`.toLowerCase().includes(k));
    const rowHtml = r => {
      const st = statusOf(r), lead = r.user && leaderIds.has(r.user.uid), btns = [];
      if (r.user && lead) { if (isMainLeader && r.user.uid !== mainLeaderId) btns.push(`<button class="ghost small" data-demote="${esc(r.user.uid)}">إلغاء ليدر</button>`); }
      else if (r.user && st === "approved") {
        if (canPromote) btns.push(`<button class="secondary small" data-promote="${esc(r.user.uid)}">ترقية لليدر</button>`);
        if (isMainLeader) btns.push(`<button class="ghost small" data-remove="${esc(r.user.uid)}">إزالة</button>`);
      }
      return `<tr><td>${esc(r.name)}${lead ? ` <span class="badge ok">${r.user.uid === mainLeaderId ? "ليدر رئيسي" : "ليدر"}</span>` : ""}${r.user ? `<small class="block">${phoneHtml(r.user)}</small>` : ""}</td>
        <td dir="ltr">${esc(r.code || "—")}</td><td>${stLabel[st]}</td><td><div class="acts">${btns.join("")}</div></td></tr>`;
    };
    $("#rows").innerHTML = groupByGender(list).map(gr => `<tr class="grp"><td colspan="4">${gr.title} (${num(gr.items.length)})</td></tr>${gr.items.map(rowHtml).join("")}`).join("")
      || `<tr><td colspan="4" class="empty">لا يوجد طلاب</td></tr>`;

    $("#removedBox").innerHTML = !(isMainLeader && removed.length) ? "" : `
      <div class="card"><h2>حسابات موقوفة (${num(removed.length)})</h2><div class="list">
        ${removed.map(r => `<div class="item static"><div><b>${esc(r.name)}</b><small>${esc(r.code)}</small></div>
          <button class="secondary small" data-restore="${esc(r.user.uid)}">إعادة تفعيل</button></div>`).join("")}</div></div>`;

    // الأحداث
    if ($("#moreBtn")) $("#moreBtn").onclick = () => { pendShown += 20; draw(); };
    if ($("#approveShown")) $("#approveShown").onclick = async () => {
      if (!confirm(`قبول ${shown.length} حساب؟`)) return;
      try {
        const bt = writeBatch(db);
        shown.forEach(r => bt.update(doc(db, "users", r.user.uid), { status: "approved" }));
        await bt.commit();
        shown.forEach(r => { r.user.status = "approved"; });
        toast("تم قبول الحسابات");
        draw();
      } catch (e) { toast(errText(e)); }
    };
    $$("[data-approve]").forEach(b => b.onclick = () => setStatus(b.dataset.approve, "approved", "تم قبول الحساب"));
    $$("[data-restore]").forEach(b => b.onclick = () => setStatus(b.dataset.restore, "approved", "تمت إعادة التفعيل"));
    $$("[data-reject]").forEach(b => b.onclick = () => { if (confirm(`رفض حساب ${findUser(b.dataset.reject).name}؟`)) setStatus(b.dataset.reject, "removed", "تم رفض الحساب"); });
    $$("[data-remove]").forEach(b => b.onclick = () => { if (confirm(`إزالة ${findUser(b.dataset.remove).name}؟`)) setStatus(b.dataset.remove, "removed", "تمت إزالة الطالب"); });
    $$("[data-promote]").forEach(b => b.onclick = async () => {
      const st = findUser(b.dataset.promote);
      if (!confirm(`ترقية ${st.name} إلى ليدر؟\nسيشاهد المحاضرات والكشوف ويمسح الكارنيهات لتسجيل الحضور.`)) return;
      b.disabled = true;
      try {
        await setDoc(doc(db, "leaders", st.uid), { uid: st.uid, name: st.name, promotedBy: user.uid, createdAt: serverTimestamp() });
        leaderIds.add(st.uid); toast(`تمت ترقية ${st.name} إلى ليدر`); draw();
      } catch (e) { toast(errText(e)); b.disabled = false; }
    });
    $$("[data-demote]").forEach(b => b.onclick = async () => {
      const st = findUser(b.dataset.demote);
      if (!confirm(`إلغاء صلاحيات الليدر عن ${st.name}؟`)) return;
      b.disabled = true;
      try { await deleteDoc(doc(db, "leaders", st.uid)); leaderIds.delete(st.uid); toast("تم إلغاء الليدر"); draw(); }
      catch (e) { toast(errText(e)); b.disabled = false; }
    });
    $$("[data-eapprove]").forEach(b => b.onclick = async () => {
      const uid = b.dataset.eapprove, r = reqs.find(x => x.uid === uid), cur = findUser(uid);
      b.disabled = true;
      try {
        const upd = {};
        if (r.name !== cur.name) upd.name = r.name;
        if (r.gender !== (cur.gender || "")) upd.gender = r.gender;
        const phoneChanged = r.phone !== (priv[uid] || "");
        const bt = writeBatch(db);
        if (phoneChanged) { upd.phoneMasked = maskPhone(r.phone); bt.set(doc(db, "userPrivate", uid), { uid, phone: r.phone }); }
        if (Object.keys(upd).length) bt.update(doc(db, "users", uid), upd);
        bt.delete(doc(db, "editRequests", uid));
        await bt.commit();
        Object.assign(cur, upd);
        if (phoneChanged) priv[uid] = r.phone;
        reqs = reqs.filter(x => x.uid !== uid);
        toast("تمت الموافقة على التعديل"); draw();
      } catch (e) { toast(errText(e)); b.disabled = false; }
    });
    $$("[data-ereject]").forEach(b => b.onclick = async () => {
      const uid = b.dataset.ereject;
      b.disabled = true;
      try { await updateDoc(doc(db, "editRequests", uid), { status: "rejected" }); reqs = reqs.filter(x => x.uid !== uid); toast("تم رفض الطلب"); draw(); }
      catch (e) { toast(errText(e)); b.disabled = false; }
    });
  };
  $("#search").oninput = draw;
  draw();
}

/* =====================================================
   الإدارة (الليدر الرئيسي): قائمة الطلاب + الدكاترة + المواد
   ===================================================== */
async function createSecondaryUser(email, pass) {
  const sec = getApps().find(a => a.name === "sec") || initializeApp(firebaseConfig, "sec");
  const sAuth = getAuth(sec);
  const cred = await createUserWithEmailAndPassword(sAuth, email, pass);
  return { cred, sAuth };
}

async function adminTab() {
  if (!isMainLeader) { setMain(`<div class="card muted">هذه الصفحة للليدر الرئيسي فقط.</div>`); return; }
  const [ds, cs] = await Promise.all([getDocs(collection(db, "doctors")), getDocs(collection(db, "courses"))]);
  const doctors = ds.docs.map(d => d.data()).sort(byName);
  const courses = cs.docs.map(d => ({ id: d.id, ...d.data() })).sort(byName);
  setMain(`
    <section class="card">
      <h2>الدكاترة (${num(doctors.length)})</h2>
      <div class="list">${doctors.map(d => `<div class="item static"><div><b>${esc(d.name)}</b></div><button class="ghost small" data-deldoc="${esc(d.uid)}">إلغاء الصلاحية</button></div>`).join("") || `<p class="muted">لا يوجد دكاترة بعد.</p>`}</div>
      <form id="docForm">
        <h3>إضافة دكتور</h3>
        <label>الاسم<input id="dName" required></label>
        <label>رقم الهاتف (يدخل به)<input id="dPhone" type="tel" inputmode="tel" required></label>
        <label>كلمة المرور (6 أحرف على الأقل)<input id="dPass" type="password" minlength="6" autocomplete="new-password" required></label>
        <button class="primary full" id="dBtn">إنشاء حساب الدكتور</button>
      </form>
    </section>
    <section class="card">
      <h2>المواد (${num(courses.length)})</h2>
      <div class="list">${courses.map(c => `<div class="item static"><div><b>${esc(c.name)}</b><small>${esc(c.doctorName || "")}</small></div><button class="ghost small" data-delcourse="${esc(c.id)}">حذف</button></div>`).join("") || `<p class="muted">لا توجد مواد بعد.</p>`}</div>
      <form id="courseForm">
        <h3>إضافة مادة</h3>
        <label>اسم المادة<input id="cName" maxlength="100" required></label>
        <label>الدكتور<select id="cDoc">${doctors.map(d => `<option value="${esc(d.uid)}">${esc(d.name)}</option>`).join("")}</select></label>
        <button class="primary full" id="cBtn" ${doctors.length ? "" : "disabled"}>إضافة المادة</button>
      </form>
    </section>`);

  $("#docForm").onsubmit = async e => {
    e.preventDefault();
    const name = $("#dName").value.trim().replace(/\s+/g, " "), phone = normPhone($("#dPhone").value), pass = $("#dPass").value;
    if (name.length < 3) { toast("اكتب اسم الدكتور"); return; }
    if (!validPhone(phone)) { toast("رقم هاتف غير صحيح"); return; }
    $("#dBtn").disabled = true;
    let sec = null;
    try {
      sec = await createSecondaryUser(phone + PHONE_DOMAIN, pass);
      const uid = sec.cred.user.uid;
      try {
        const bt = writeBatch(db);
        bt.set(doc(db, "users", uid), { uid, name, phoneMasked: maskPhone(phone), role: "doctor", status: "approved", createdAt: serverTimestamp() });
        bt.set(doc(db, "userPrivate", uid), { uid, phone });
        bt.set(doc(db, "doctors", uid), { uid, name, createdBy: user.uid, createdAt: serverTimestamp() });
        await bt.commit();
      } catch (err) { await sec.cred.user.delete().catch(() => {}); throw err; }
      toast("تم إنشاء حساب الدكتور");
      adminTab();
    } catch (err) { toast(errText(err)); $("#dBtn").disabled = false; }
    finally { if (sec) await signOut(sec.sAuth).catch(() => {}); }
  };

  $("#courseForm").onsubmit = async e => {
    e.preventDefault();
    const d = doctors.find(x => x.uid === $("#cDoc").value);
    if (!d) { toast("أضف دكتورًا أولًا"); return; }
    $("#cBtn").disabled = true;
    try {
      await setDoc(doc(collection(db, "courses")), { name: $("#cName").value.trim(), doctorId: d.uid, doctorName: d.name, createdBy: user.uid, createdAt: serverTimestamp() });
      toast("تمت إضافة المادة"); adminTab();
    } catch (err) { toast(errText(err)); $("#cBtn").disabled = false; }
  };
  $$("[data-delcourse]").forEach(b => b.onclick = async () => {
    if (!confirm("حذف المادة؟ (المحاضرات السابقة تبقى كما هي)")) return;
    try { await deleteDoc(doc(db, "courses", b.dataset.delcourse)); adminTab(); } catch (e) { toast(errText(e)); }
  });
  $$("[data-deldoc]").forEach(b => b.onclick = async () => {
    if (!confirm("إلغاء صلاحيات هذا الدكتور؟ لن يستطيع الدخول كدكتور.")) return;
    try { await deleteDoc(doc(db, "doctors", b.dataset.deldoc)); adminTab(); } catch (e) { toast(errText(e)); }
  });
}

/* =====================================================
   الكشوف: طباعة PDF وتصدير Excel
   ===================================================== */
const GROUP_TITLE = { male: "الطلاب (ذكور)", female: "الطالبات (إناث)", "": "غير محدد" };

// كشف محاضرة واحدة: كل الطلاب (حضور/غياب) أو الحاضرون فقط أو الغائبون فقط
async function lectureDataset(lec, type) {
  const [studs, as] = await Promise.all([
    approvedStudents(),
    getDocs(query(collection(db, "attendance"), where("lectureId", "==", lec.id)))
  ]);
  const present = new Set(as.docs.map(d => d.data().studentId));
  const byId = {};
  studs.forEach(u => { byId[u.uid] = { uid: u.uid, code: u.code || "", name: u.name, gender: u.gender || "" }; });
  as.docs.forEach(d => { const a = d.data(); if (!byId[a.studentId]) byId[a.studentId] = { uid: a.studentId, code: a.studentCode || "", name: a.studentName, gender: a.gender || "" }; });
  const people = Object.values(byId).map(p => ({ ...p, present: present.has(p.uid) }));
  const list = people.filter(p => type === "all" || (type === "present" ? p.present : !p.present));
  const kind = { all: "كشف حضور وغياب", present: "كشف الحاضرين", absent: "كشف الغائبين" }[type];
  const presentCount = people.filter(p => p.present).length;
  return {
    title: `${kind} — ${lec.title}`,
    lines: [
      `${COLLEGE} — ${CLASS_NAME}`,
      `المادة: ${lec.courseName || "—"}${lec.doctorName ? " — " + lec.doctorName : ""}`,
      `التاريخ: ${fmt(lec.startAt)}`,
      `الحاضرون: ${num(presentCount)}  |  الغائبون: ${num(people.length - presentCount)}  |  الإجمالي: ${num(people.length)}`
    ],
    head: ["م", "الاسم", "الكود", type === "all" ? "الحالة" : "التوقيع"],
    groups: groupByGender(list).map(gr => ({
      title: GROUP_TITLE[gr.key],
      rows: gr.items.map((p, i) => [num(i + 1), p.name, p.code, type === "all" ? (p.present ? "حاضر" : "غائب") : ""])
    })),
    legend: [],
    filename: `${kind} - ${lec.title}`.slice(0, 80)
  };
}

// الكشف الكامل: كل الطلاب × كل المحاضرات (لدكتور معيّن أو للجميع)
async function matrixDataset(doctorId, doctorName, courseId, courseName) {
  const [studs, ls, as] = await Promise.all([
    approvedStudents(), getDocs(collection(db, "lectures")), getDocs(collection(db, "attendance"))
  ]);
  const lectures = ls.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(l => (!doctorId || l.doctorId === doctorId) && (!courseId || l.courseId === courseId))
    .sort((a, b) => (toDate(a.startAt)?.getTime() || 0) - (toDate(b.startAt)?.getTime() || 0));
  if (!lectures.length) throw new Error("لا توجد محاضرات لهذا الاختيار");
  const ids = new Set(lectures.map(l => l.id));
  const present = new Set();
  const byId = {};
  studs.forEach(u => { byId[u.uid] = { uid: u.uid, code: u.code || "", name: u.name, gender: u.gender || "" }; });
  as.docs.forEach(d => {
    const a = d.data();
    if (!ids.has(a.lectureId) || !a.studentId) return;
    present.add(`${a.lectureId}|${a.studentId}`);
    if (!byId[a.studentId]) byId[a.studentId] = { uid: a.studentId, code: a.studentCode || "", name: a.studentName, gender: a.gender || "" };
  });
  const people = Object.values(byId);
  const males = people.filter(p => p.gender === "male").length, females = people.filter(p => p.gender === "female").length;
  return {
    title: "كشف الحضور الكلي",
    lines: [
      `${COLLEGE} — ${CLASS_NAME}`,
      `الدكتور: ${doctorName || "كل الدكاترة"}${courseName ? " — المادة: " + courseName : ""}`,
      `عدد الطلاب: ${num(people.length)} (ذكور ${num(males)} / إناث ${num(females)})  |  عدد المحاضرات: ${num(lectures.length)}`,
      "علامة ✓ = حاضر، والخانة الفارغة = غائب"
    ],
    head: ["م", "الاسم", "الكود", ...lectures.map((l, i) => `${num(i + 1)}\n${fmtShort(l.startAt)}`), "المجموع"],
    groups: groupByGender(people).map(gr => ({
      title: GROUP_TITLE[gr.key],
      rows: gr.items.map((p, i) => {
        const cells = lectures.map(l => present.has(`${l.id}|${p.uid}`));
        return [num(i + 1), p.name, p.code, ...cells.map(c => (c ? "✓" : "")), `${num(cells.filter(Boolean).length)} / ${num(lectures.length)}`];
      })
    })),
    legend: lectures.map((l, i) => `${num(i + 1)}: ${l.courseName ? l.courseName + " – " : ""}${l.title} (${fmtDay(l.startAt)})`),
    filename: `كشف الحضور الكلي${doctorName ? " - " + doctorName : ""}`.slice(0, 80)
  };
}

// PDF: نافذة الطباعة (اختر "حفظ كملف PDF")
function printDataset(ds) {
  const cols = ds.head.length;
  const dense = cols > 24 ? "ps-xdense" : cols > 14 ? "ps-dense" : "";
  const cls = i => (i === 0 ? "c-no" : i === 1 ? "c-name" : "c-lec");
  const th = ds.head.map((h, i) => `<th class="${cls(i)}">${esc(h).replace(/\n/g, "<br>")}</th>`).join("");
  const tables = ds.groups.map(gr => `
    <h3 class="ps-grp">${esc(gr.title)} — ${num(gr.rows.length)}</h3>
    <table class="ps-table ${dense}"><thead><tr>${th}</tr></thead>
      <tbody>${gr.rows.map(r => `<tr>${r.map((c, i) => `<td class="${cls(i)}">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`).join("")
    || `<p class="ps-empty">لا توجد أسماء في هذا الكشف.</p>`;
  let st = $("#pageStyle");
  if (!st) { st = document.createElement("style"); st.id = "pageStyle"; document.head.appendChild(st); }
  st.textContent = `@page { size: A4 ${cols > 6 ? "landscape" : "portrait"}; margin: 10mm; }`;
  $("#printSheet").innerHTML = `
    <div class="ps-head"><h1>${esc(ds.title)}</h1>${ds.lines.map(l => `<p>${esc(l)}</p>`).join("")}</div>
    ${tables}
    ${ds.legend.length ? `<div class="ps-legend"><b>المحاضرات:</b> ${ds.legend.map(esc).join(" &nbsp;•&nbsp; ")}</div>` : ""}
    <p class="ps-foot">طُبع بتاريخ ${new Date().toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" })}</p>`;
  setTimeout(() => window.print(), 150);
}

// Excel: ورقة لكل مجموعة (ذكور/إناث)
async function exportExcel(ds) {
  try { await loadScript(XLSX_LIB, () => window.XLSX); } catch { return exportCsv(ds); }
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  const head = ds.head.map(h => String(h).replace("\n", " "));
  const groups = ds.groups.length ? ds.groups : [{ title: "الكشف", rows: [] }];
  groups.forEach(gr => {
    const aoa = [[ds.title], ...ds.lines.map(l => [l]), [gr.title], head, ...gr.rows, ...(ds.legend.length ? [[], ["المحاضرات:"], ...ds.legend.map(l => [l])] : [])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = head.map((h, i) => ({ wch: i === 1 ? 38 : i === 0 ? 5 : i === 2 ? 12 : 9 }));
    XLSX.utils.book_append_sheet(wb, ws, gr.title.slice(0, 28).replace(/[\\/?*[\]:]/g, " "));
  });
  XLSX.writeFile(wb, `${ds.filename.replace(/[\\/:*?"<>|]/g, " ")}.xlsx`);
}
function exportCsv(ds) {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [];
  ds.groups.forEach(gr => { lines.push(q(gr.title)); lines.push(ds.head.map(h => q(String(h).replace("\n", " "))).join(",")); gr.rows.forEach(r => lines.push(r.map(q).join(","))); lines.push(""); });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
  a.download = `${ds.filename.replace(/[\\/:*?"<>|]/g, " ")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function sheetsTab() {
  const [ds, cs] = await Promise.all([getDocs(collection(db, "doctors")), getDocs(collection(db, "courses"))]);
  let doctors = ds.docs.map(d => d.data()).sort(byName);
  if (isDoctor && !isMainLeader) doctors = [doctors.find(d => d.uid === user.uid) || { uid: user.uid, name: profile.name }];
  const courses = cs.docs.map(d => ({ id: d.id, ...d.data() })).sort(byName);
  const canAll = !(isDoctor && !isMainLeader);
  setMain(`
    <section class="card">
      <h1>الكشوف</h1>
      <p class="muted">كشف كامل لكل الطلاب وكل المحاضرات، لكل دكتور على حدة. وكشف كل محاضرة لوحدها من صفحة المحاضرة.</p>
      <label>الدكتور<select id="shDoc">${canAll ? `<option value="">كل الدكاترة</option>` : ""}${doctors.map(d => `<option value="${esc(d.uid)}">${esc(d.name)}</option>`).join("")}</select></label>
      <label>المادة<select id="shCourse"></select></label>
      <div class="row"><button class="primary" id="shXlsx">تنزيل Excel</button><button class="primary" id="shPdf">PDF / طباعة</button></div>
    </section>`);
  const fillCourses = () => {
    const d = $("#shDoc").value;
    $("#shCourse").innerHTML = `<option value="">كل المواد</option>` + courses.filter(c => !d || c.doctorId === d).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  };
  $("#shDoc").onchange = fillCourses;
  fillCourses();
  const run = async kind => {
    const d = doctors.find(x => x.uid === $("#shDoc").value), c = courses.find(x => x.id === $("#shCourse").value);
    try {
      const data = await matrixDataset(d?.uid || "", d?.name || "", c?.id || "", c?.name || "");
      if (kind === "xlsx") await exportExcel(data); else printDataset(data);
    } catch (e) { toast(errText(e)); }
  };
  $("#shXlsx").onclick = () => run("xlsx");
  $("#shPdf").onclick = () => run("pdf");
}

/* =====================================================
   الطالب: الكارنيه + حضوري + حسابي
   ===================================================== */
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("img")); i.src = src; });
}

async function buildCard({ name, code, photo }) {
  const W = 1012, H = 638;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  try { await Promise.all([document.fonts.load('700 40px "IBM Plex Sans Arabic"'), document.fonts.load('400 28px "IBM Plex Sans Arabic"')]); } catch { /* ignore */ }
  const F = (w, s) => `${w} ${s}px "IBM Plex Sans Arabic", Tahoma, Arial, sans-serif`;
  x.direction = "rtl";
  x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  x.fillStyle = "#173f7a"; x.fillRect(0, 0, W, 130);
  x.fillStyle = "#fff"; x.textAlign = "center";
  x.font = F(700, 44); x.fillText(COLLEGE, W / 2, 62);
  x.font = F(400, 28); x.fillText(`بطاقة حضور الطالب — ${CLASS_NAME}`, W / 2, 106);
  x.strokeStyle = "#173f7a"; x.lineWidth = 8; x.strokeRect(4, 4, W - 8, H - 8);

  // الصورة (يمين)
  const pw = 240, ph = 320, px = W - 60 - pw, py = 165;
  x.save();
  x.beginPath();
  if (x.roundRect) x.roundRect(px, py, pw, ph, 18); else x.rect(px, py, pw, ph);
  x.clip();
  x.fillStyle = "#e9eff8"; x.fillRect(px, py, pw, ph);
  if (photo) { try { x.drawImage(await loadImage(photo), px, py, pw, ph); } catch { /* ignore */ } }
  x.restore();
  x.strokeStyle = "#173f7a"; x.lineWidth = 4;
  x.beginPath(); if (x.roundRect) x.roundRect(px, py, pw, ph, 18); else x.rect(px, py, pw, ph); x.stroke();

  // الاسم والكود (يسار الصورة)
  const right = px - 30, maxW = right - 60;
  x.fillStyle = "#12233f"; x.textAlign = "right"; x.font = F(700, 40);
  const lines = []; let cur = "";
  String(name).split(" ").forEach(w => { const t = cur ? `${cur} ${w}` : w; if (x.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; });
  if (cur) lines.push(cur);
  lines.slice(0, 3).forEach((l, i) => x.fillText(l, right, 215 + i * 52));
  x.font = F(700, 34); x.fillStyle = "#173f7a";
  x.fillText(`الكود الجامعي: ${code}`, right, 420);
  x.font = F(400, 26); x.fillStyle = "#627088";
  x.fillText("اعرض الـ QR لتسجيل حضورك", right, 470);

  // QR (يسار أسفل)
  try {
    const qr = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(cardPayload(code)))}`);
    x.imageSmoothingEnabled = false;
    x.drawImage(qr, 60, 350, 250, 250);
  } catch { /* ignore */ }
  return c;
}

async function cardTab() {
  if (!profile.code) { setMain(`<div class="card muted">هذا الحساب بدون كود جامعي، لا يوجد كارنيه.</div>`); return; }
  let photo = "";
  try { const p = await getDoc(doc(db, "photos", user.uid)); if (p.exists()) photo = p.data().data; } catch { /* ignore */ }
  const canvas = await buildCard({ name: profile.name, code: profile.code, photo });
  setMain(`
    <section class="card center">
      <h1>بطاقتي</h1>
      <img id="cardImg" class="card-img" alt="الكارنيه">
      <p class="muted">اعرض الـ QR على الدكتور أو الليدر ليتم تسجيل حضورك فورًا.</p>
      <button class="primary full" id="dlCard">تحميل الكارنيه</button>
    </section>`);
  $("#cardImg").src = canvas.toDataURL("image/png");
  $("#dlCard").onclick = () => canvas.toBlob(b => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `كارنيه-${profile.code}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "image/png");
}

async function mineTab() {
  const snap = await getDocs(query(collection(db, "attendance"), where("studentId", "==", user.uid)));
  const times = {};
  try { (await getDocs(query(collection(db, "attendanceTimes"), where("studentId", "==", user.uid)))).forEach(d => { times[d.id] = toDate(d.data().createdAt); }); } catch { /* اختياري */ }
  const rows = snap.docs.map(d => ({ ...d.data(), at: times[d.id] || null })).sort((a, b) => (b.at?.getTime() || 0) - (a.at?.getTime() || 0));
  setMain(`
    <section class="card count-card"><strong>${num(rows.length)}</strong><span>محاضرة حضرتها</span></section>
    <div class="list">
      ${rows.map(r => `<div class="item static"><div><b>${esc(r.lectureTitle || "محاضرة")}</b><small>${esc(r.courseName || "")}</small><small>${fmt(r.at)}</small></div><span class="badge ok">حاضر</span></div>`).join("")
        || `<div class="card muted">لا توجد سجلات بعد.</div>`}
    </div>`);
}

/* حسابي: أي تعديل يصل إلى الليدر الرئيسي ولا يُطبَّق إلا بموافقته */
async function accountTab() {
  const [pSnap, privSnap, reqSnap] = await Promise.all([
    getDoc(doc(db, "users", user.uid)),
    getDoc(doc(db, "userPrivate", user.uid)).catch(() => null),
    isMainLeader ? Promise.resolve(null) : getDoc(doc(db, "editRequests", user.uid)).catch(() => null)
  ]);
  const cur = pSnap.data();
  const curPhone = privSnap?.exists() ? privSnap.data().phone : "";
  const req = reqSnap?.exists() ? reqSnap.data() : null;

  if (req && req.status === "pending") {
    setMain(`
      <section class="card"><h1>حسابي</h1>
        <p class="muted">طلب التعديل بانتظار موافقة الليدر الرئيسي. لن تتغير بياناتك قبل الموافقة.</p>
        <div class="list">
          <div class="item static"><div><b>الاسم المطلوب</b><small>${esc(req.name)}</small></div></div>
          <div class="item static"><div><b>رقم الهاتف المطلوب</b><small dir="ltr">${esc(req.phone)}</small></div></div>
          <div class="item static"><div><b>النوع المطلوب</b><small>${genderLabel(req.gender)}</small></div></div>
        </div>
        <button class="ghost full" id="cancelReq">إلغاء الطلب</button>
      </section>`);
    $("#cancelReq").onclick = async () => {
      try { await deleteDoc(doc(db, "editRequests", user.uid)); toast("تم إلغاء الطلب"); accountTab(); } catch (e) { toast(errText(e)); }
    };
    return;
  }
  setMain(`
    <section class="card">
      <h1>حسابي</h1>
      ${req && req.status === "rejected" ? `<div class="result bad">تم رفض آخر طلب تعديل. يمكنك إرسال طلب جديد.</div>` : ""}
      <p class="muted">${isMainLeader ? "تُحفظ التعديلات مباشرة." : "أي تعديل يصل إلى الليدر الرئيسي ولا يُطبَّق إلا بعد موافقته."}</p>
      <form id="accForm">
        <label>الاسم<input id="aName" value="${esc(cur.name)}" autocomplete="name" required></label>
        <label>رقم الهاتف<input id="aPhone" type="tel" inputmode="tel" value="${esc(curPhone)}" required></label>
        <fieldset class="gender"><legend>النوع</legend>
          <label><input type="radio" name="aGender" value="male" ${cur.gender === "male" ? "checked" : ""} required> ذكر</label>
          <label><input type="radio" name="aGender" value="female" ${cur.gender === "female" ? "checked" : ""}> أنثى</label>
        </fieldset>
        <button class="primary full" id="accSubmit">${isMainLeader ? "حفظ التعديلات" : "إرسال طلب التعديل"}</button>
      </form>
      <p class="muted">ملاحظة: تسجيل الدخول يستمر بالكود الجامعي (أو الرقم) الذي سجّلت به أول مرة.</p>
      <div id="accMsg" class="msg" role="alert"></div>
    </section>`);
  $("#accForm").onsubmit = async e => {
    e.preventDefault();
    const msg = $("#accMsg"), btn = $("#accSubmit");
    msg.textContent = "";
    const name = $("#aName").value.trim().replace(/\s+/g, " ");
    const phone = normPhone($("#aPhone").value);
    const gender = document.querySelector('input[name="aGender"]:checked')?.value;
    if (name.length < 3) { msg.textContent = "اكتب الاسم"; return; }
    if (!validPhone(phone)) { msg.textContent = "اكتب رقم هاتف صحيح (أرقام فقط)"; return; }
    if (!gender) { msg.textContent = "اختر النوع"; return; }
    if (name === cur.name && phone === curPhone && gender === (cur.gender || "")) { msg.textContent = "لم تغيّر أي معلومة"; return; }
    btn.disabled = true;
    try {
      if (isMainLeader) {
        const upd = {};
        if (name !== cur.name) upd.name = name;
        if (gender !== (cur.gender || "")) upd.gender = gender;
        const bt = writeBatch(db);
        if (phone !== curPhone) { upd.phoneMasked = maskPhone(phone); bt.set(doc(db, "userPrivate", user.uid), { uid: user.uid, phone }); }
        if (Object.keys(upd).length) bt.update(doc(db, "users", user.uid), upd);
        await bt.commit();
        profile.name = name; profile.gender = gender;
        $("#userName").textContent = name;
        toast("تم حفظ التعديلات");
      } else {
        await setDoc(doc(db, "editRequests", user.uid), { uid: user.uid, name, phone, gender, status: "pending", createdAt: serverTimestamp() });
        toast("تم إرسال طلب التعديل");
      }
      accountTab();
    } catch (err) { msg.textContent = errText(err); btn.disabled = false; }
  };
}
