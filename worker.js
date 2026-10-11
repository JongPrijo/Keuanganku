/* ================================================================
   KEUANGANKU BOT (Telegram)  -  berjalan di Cloudflare Workers (gratis)
   Mencatat pemasukan, pengeluaran, transfer, piutang & hutang lewat
   chat Telegram, langsung ke database Firebase yang sama dengan
   aplikasi Keuanganku.

   Variabel yang perlu diisi di Cloudflare (Settings > Variables and Secrets):
     TELEGRAM_TOKEN   (Secret) token dari @BotFather
     FIREBASE_SA      (Secret) isi file kunci service account (JSON) dari Firebase
     FIREBASE_UID     (Text)   User UID kamu (Firebase > Authentication > Users)
     ALLOWED_CHAT_ID  (Text)   ID Telegram kamu (bot akan memberitahukannya)
     WEBHOOK_SECRET   (Secret) kata acak bebas, mis. keuanganku-9f3k2
     TIMEZONE         (Text, opsional) default Asia/Makassar
   ================================================================ */

let S = { debts: [], accounts: [], txs: [] };
let TZ = 'Asia/Makassar';

/* ---------- format ---------- */
const fmtN = n => Math.round(n || 0).toLocaleString('id-ID');
const rp = n => 'Rp ' + fmtN(n);
const fmtDate = s => { if (!s) return '-'; const [y, m, d] = s.split('-'); return `${d}/${m}/${y}` };
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const cap = s => String(s).replace(/\b\w/g, c => c.toUpperCase());
function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
const stamp = () => localDate().replace(/-/g, '');

/* ---------- hitungan (sama dengan aplikasi) ---------- */
const paid = d => (d.payments || []).reduce((a, p) => a + p.amount, 0);
const remain = d => Math.max(0, d.amount - paid(d));
const sumRemain = a => a.reduce((x, d) => x + remain(d), 0);
const getAcc = id => S.accounts.find(a => a.id === id);
function accIO(a, month) { let i = 0, o = 0; S.txs.forEach(t => { if (t.accountId !== a.id) return; if (month && month !== 'all' && !t.date.startsWith(month)) return; t.type === 'in' ? i += t.amount : o += t.amount }); return { in: i, out: o } }
const accBal = a => { const io = accIO(a); return (a.initial || 0) + io.in - io.out };

/* ================= FIRESTORE (REST + service account) ================= */
let tokenCache = { token: null, exp: 0, key: '' };
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = s => b64url(new TextEncoder().encode(s));
async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.key === sa.client_email && tokenCache.exp - 60 > now) return tokenCache.token;
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlStr(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(header + '.' + claim));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + header + '.' + claim + '.' + b64url(sig)
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('Login Firebase gagal: ' + (j.error_description || j.error || res.status));
  tokenCache = { token: j.access_token, exp: now + (j.expires_in || 3600), key: sa.client_email };
  return j.access_token;
}
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  const fields = {}; for (const k of Object.keys(v)) if (v[k] !== undefined) fields[k] = toFs(v[k]);
  return { mapValue: { fields } };
}
function fromFs(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) { const o = {}; const f = v.mapValue.fields || {}; for (const k in f) o[k] = fromFs(f[k]); return o }
  return null;
}
function makeDb(env) {
  const sa = typeof env.FIREBASE_SA === 'string' ? JSON.parse(env.FIREBASE_SA) : env.FIREBASE_SA;
  const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users/${env.FIREBASE_UID}`;
  async function call(method, path, body, query = '') {
    const res = await fetch(base + path + query, { method, headers: { authorization: 'Bearer ' + await accessToken(sa), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 404 && method === 'GET') return null;
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Firestore ' + res.status + ': ' + (j.error && j.error.message || ''));
    return j;
  }
  return {
    async list(coll) {
      const out = []; let page = '';
      do {
        const j = await call('GET', '/' + coll, null, '?pageSize=300' + (page ? '&pageToken=' + encodeURIComponent(page) : ''));
        (j && j.documents || []).forEach(d => { const o = fromFs({ mapValue: { fields: d.fields || {} } }); o.id = o.id || d.name.split('/').pop(); out.push(o) });
        page = j && j.nextPageToken;
      } while (page);
      return out.sort((a, b) => (a.created || 0) - (b.created || 0));
    },
    set: (coll, obj) => call('PATCH', `/${coll}/${obj.id}`, { fields: toFs(obj).mapValue.fields }),
    del: (coll, id) => call('DELETE', `/${coll}/${id}`),
    async getRoot() { const j = await call('GET', ''); return j ? fromFs({ mapValue: { fields: j.fields || {} } }) : {} },
    setRootField: (field, val) => call('PATCH', '', { fields: { [field]: toFs(val) } }, '?updateMask.fieldPaths=' + field),
  };
}
async function loadAll(db) {
  const [debts, accounts, txs] = await Promise.all([db.list('debts'), db.list('accounts'), db.list('txs')]);
  debts.forEach(d => d.payments = d.payments || []);
  S = { debts, accounts, txs };
}

/* ================= MEMBACA PESAN ================= */
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const CONNECT = new Set(['ke', 'dari', 'di', 'pakai', 'pake', 'via', 'lewat', 'dgn', 'dengan', 'rek', 'rekening', 'akun', 'utk', 'untuk', 'buat', 'sebesar', 'senilai', 'rp', 'rp.']);
const EWALLETS = ['dana', 'ovo', 'gopay', 'shopeepay', 'linkaja', 'flip', 'sakuku', 'isaku', 'doku', 'jenius pay'];

// "25rb" "25k" "2jt" "2,5 juta" "25.000" "Rp25000" -> angka
function parseAmountAt(words, i) {
  let w = words[i].toLowerCase().replace(/^rp\.?/, '');
  let m = w.match(/^(\d+(?:[.,]\d+)*)(jt|juta|rb|ribu|k|m|jtan)?$/);
  if (!m) return null;
  let used = 1, suf = m[2];
  if (!suf && words[i + 1] && /^(jt|juta|rb|ribu|k|ribuan)$/i.test(words[i + 1])) { suf = words[i + 1].toLowerCase(); used = 2 }
  let n = m[1];
  if (suf) { n = Number(n.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); const mul = /^(jt|juta|m|jtan)$/.test(suf) ? 1e6 : 1e3; n = n * mul }
  else n = Number(n.replace(/[.,]/g, ''));
  if (!isFinite(n) || n <= 0) return null;
  return { value: Math.round(n), used };
}
function findAmount(words) {
  for (let i = 0; i < words.length; i++) { const a = parseAmountAt(words, i); if (a) return { ...a, index: i } }
  return null;
}
// cari nama rekening di dalam kata-kata (sampai 3 kata, misal "bank jago", "blu by bca")
function findAccount(words, skip = new Set()) {
  const free = (i, len) => ![...Array(len).keys()].some(k => skip.has(i + k));
  // 1) nama lengkap persis (sampai 3 kata): "bank jago", "blu by bca", "bca"
  for (let len = 3; len >= 1; len--)
    for (let i = 0; i + len <= words.length; i++) {
      if (!free(i, len)) continue;
      const phrase = norm(words.slice(i, i + len).join(''));
      const acc = phrase && S.accounts.find(a => norm(a.name) === phrase);
      if (acc) return { acc, index: i, len };
    }
  // 2) satu kata yang cocok dengan salah satu kata di nama rekening: "jago" -> "Bank Jago"
  for (let i = 0; i < words.length; i++) {
    if (!free(i, 1)) continue;
    const w = norm(words[i]); if (w.length < 3) continue;
    const acc = S.accounts.find(a => a.name.toLowerCase().split(/\s+/).map(norm).includes(w)) || S.accounts.find(a => norm(a.name).startsWith(w));
    if (acc) return { acc, index: i, len: 1 };
  }
  return null;
}
const CATS = [[/gaji|salary|thr|bonus/, 'Gaji'], [/makan|minum|kopi|jajan|resto|warung|sarapan|bakso|nasi/, 'Makan'], [/pulsa|kuota|paket data|internet/, 'Pulsa/Data'],
  [/listrik|pln|token|air|pdam|wifi|indihome|tagihan|bpjs|cicilan|kredit/, 'Tagihan'], [/bensin|bbm|pertalite|ojek|gojek|grab|maxim|parkir|tol|transport|tiket/, 'Transport'],
  [/belanja|shopee|tokopedia|lazada|beli|indomaret|alfamart|pasar/, 'Belanja'], [/top ?up|isi saldo/, 'Top up'], [/transfer|tf/, 'Transfer']];
const guessCat = note => { const n = (note || '').toLowerCase(); const c = CATS.find(([r]) => r.test(n)); return c ? c[1] : '' };

function takeDate(words) {
  const i = words.findIndex(w => /^(kemarin|kmrn|kemaren)$/i.test(w));
  if (i >= 0) { words.splice(i, 1); return localDate(-1) }
  const j = words.findIndex(w => /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(w));
  if (j >= 0) {
    const [d, m, y] = words[j].split('/'); words.splice(j, 1);
    const yy = y ? (y.length === 2 ? '20' + y : y) : localDate().slice(0, 4);
    return `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return localDate();
}
const cleanNote = ws => ws.filter(w => !CONNECT.has(w.toLowerCase())).join(' ').trim();

/* ================= PERINTAH ================= */
const HELP = `<b>📒 Keuanganku Bot</b>
Ketik seperti biasa, contoh:

<b>Pemasukan / pengeluaran</b>
• <code>masuk 2jt bca gaji oktober</code>
• <code>keluar 25rb dana makan siang</code>
• <code>keluar 150rb bca listrik kemarin</code>
• <code>transfer 500rb bca ke dana</code>

<b>Piutang & hutang</b>
• <code>piutang budi 500rb pinjam motor</code>
• <code>hutang toko andi 300rb</code>
• <code>cicil budi 200rb ke bca</code>  (cicilan + catat ke rekening)
• <code>piutang</code> / <code>hutang</code>  (lihat daftar)

<b>Lihat & lainnya</b>
• <code>saldo</code> atau <code>saldo bca</code>
• <code>hari ini</code> / <code>bulan ini</code>
• <code>rekap</code>  (kirim file Excel)
• <code>rekening</code> / <code>tambah rekening seabank</code>
• <code>batal</code>  (hapus catatan terakhir dari bot)

Nominal bisa ditulis 25rb, 25k, 25.000, 2jt, 2,5jt.
Tanggal: tambahkan <code>kemarin</code> atau <code>12/10</code>.`;

async function handle(text, db) {
  const raw = text.trim().replace(/\s+/g, ' ');
  const low = raw.toLowerCase();
  let words = raw.split(' ');
  const first = (words[0] || '').toLowerCase().replace(/^\//, '').replace(/@.*/, '');

  if (/^(start|help|bantuan|menu|tolong|\?)$/.test(first) && words.length <= 2) return { text: HELP };
  if (/^(batal|undo|urungkan)$/.test(first) || low === 'hapus terakhir') return undo(db);
  if (/^(rekap|excel|laporan|export|ekspor)$/.test(first)) return { excel: true };
  if (first === 'saldo') return saldo(words.slice(1));
  if (low === 'hari ini' || low === 'today') return ringkasHari();
  if (low === 'bulan ini' || low === 'ringkasan' || low === 'bulan') return ringkasBulan();
  if (/^(rekening|akun|dompet)$/.test(low)) return listRekening();
  if (/^tambah (rekening|akun|ewallet|e-wallet|bank)\b/.test(low)) return tambahRekening(words.slice(2), db);

  if (/^(masuk|pemasukan|terima|dapat|income|\+)$/.test(first) || /^\+\d/.test(first)) {
    if (/^\+\d/.test(first)) words[0] = first.slice(1); else words = words.slice(1);
    return catatTx('in', words, db);
  }
  if (first === 'bayar' && /^(hutang|utang)$/i.test(words[1] || '')) return cicil(words.slice(2), db, 'hutang');
  if (/^(keluar|pengeluaran|bayar|beli|belanja|expense|-)$/.test(first) || /^-\d/.test(first)) {
    if (/^-\d/.test(first)) words[0] = first.slice(1);
    else if (first !== 'belanja') words = words.slice(1);
    return catatTx('out', words, db);
  }
  if (/^(transfer|tf|pindah|pindahkan)$/.test(first)) return transfer(words.slice(1), db);
  if (/^(piutang|hutang|utang|pinjamkan|minjemin|pinjam)$/.test(first)) {
    const type = /^(piutang|pinjamkan|minjemin)$/.test(first) ? 'piutang' : 'hutang';
    if (words.length === 1) return listDebts(type);
    return catatDebt(type, words.slice(1), db);
  }
  if (/^(cicil|cicilan|angsur|nyicil)$/.test(first)) return cicil(words.slice(1), db, null);
  const bi = words.findIndex(w => /^(bayar|nyicil|cicil|nyetor)$/i.test(w));
  if (bi > 0 && findAmount(words)) return cicil([...words.slice(0, bi), ...words.slice(bi + 1)], db, 'piutang');

  return { text: 'Maaf, aku belum paham pesan itu 🙏\nKetik <code>bantuan</code> untuk melihat contoh.' };
}

function needAccount(word) {
  const names = S.accounts.map(a => a.name).join(', ');
  return { text: names ? `Rekening ${word ? '<b>' + esc(word) + '</b> ' : ''}tidak ditemukan.\nRekening kamu: ${esc(names)}\n\nTulis nama rekening di pesan, contoh: <code>keluar 25rb dana makan</code>\nAtau tambah dulu: <code>tambah rekening nama</code>` : 'Belum ada rekening. Tambahkan dulu, contoh: <code>tambah rekening bca 1234567890</code>' };
}

async function catatTx(type, words, db) {
  const date = takeDate(words);
  const amt = findAmount(words);
  if (!amt) return { text: `Nominalnya berapa? Contoh: <code>${type === 'in' ? 'masuk 2jt bca gaji' : 'keluar 25rb dana makan'}</code>` };
  const skip = new Set([...Array(amt.used).keys()].map(k => amt.index + k));
  const f = findAccount(words, skip);
  if (!f) return needAccount();
  for (let k = 0; k < f.len; k++) skip.add(f.index + k);
  const note = cleanNote(words.filter((_, i) => !skip.has(i)));
  const tx = { id: uid(), accountId: f.acc.id, type, amount: amt.value, note: note ? cap(note) : (type === 'in' ? 'Pemasukan' : 'Pengeluaran'), date, cat: guessCat(note), created: Date.now(), via: 'telegram' };
  await db.set('txs', tx); S.txs.push(tx);
  await remember(db, { txs: [tx.id] });
  const io = type === 'in' ? '✅ Pemasukan' : '✅ Pengeluaran';
  return { text: `${io} <b>${rp(tx.amount)}</b> ${type === 'in' ? 'ke' : 'dari'} <b>${esc(f.acc.name)}</b>\n📝 ${esc(tx.note)}${tx.cat ? ' · ' + tx.cat : ''}\n📅 ${fmtDate(date)}\n\nSaldo ${esc(f.acc.name)} sekarang: <b>${rp(accBal(f.acc))}</b>${accBal(f.acc) < 0 ? '\n⚠️ Saldo minus, cek lagi saldo awal rekening ini.' : ''}` };
}

async function transfer(words, db) {
  const date = takeDate(words);
  const amt = findAmount(words);
  if (!amt) return { text: 'Contoh: <code>transfer 500rb bca ke dana</code>' };
  const skip = new Set([...Array(amt.used).keys()].map(k => amt.index + k));
  const a = findAccount(words, skip); if (!a) return needAccount();
  for (let k = 0; k < a.len; k++) skip.add(a.index + k);
  const b = findAccount(words, skip); if (!b) return { text: 'Rekening tujuan tidak ditemukan. Contoh: <code>transfer 500rb bca ke dana</code>' };
  for (let k = 0; k < b.len; k++) skip.add(b.index + k);
  // "ke X" = tujuan, "dari X" = asal; tanpa kata itu: yang disebut pertama = asal
  let [from, to] = a.index < b.index ? [a, b] : [b, a];
  const before = x => (words[x.index - 1] || '').toLowerCase();
  if (before(from) === 'ke' || before(to) === 'dari') [from, to] = [to, from];
  if (from.acc.id === to.acc.id) return { text: 'Rekening asal dan tujuan sama.' };
  const extra = cleanNote(words.filter((_, i) => !skip.has(i)));
  const now = Date.now();
  const out = { id: uid(), accountId: from.acc.id, type: 'out', amount: amt.value, note: 'Transfer ke ' + to.acc.name + (extra ? ' (' + extra + ')' : ''), date, cat: 'Transfer keluar', created: now, via: 'telegram' };
  const inn = { id: uid(), accountId: to.acc.id, type: 'in', amount: amt.value, note: 'Transfer dari ' + from.acc.name + (extra ? ' (' + extra + ')' : ''), date, cat: 'Transfer masuk', created: now + 1, via: 'telegram' };
  await db.set('txs', out); await db.set('txs', inn); S.txs.push(out, inn);
  await remember(db, { txs: [out.id, inn.id] });
  return { text: `🔁 Transfer <b>${rp(amt.value)}</b>\n${esc(from.acc.name)} → ${esc(to.acc.name)}\n\nSaldo ${esc(from.acc.name)}: <b>${rp(accBal(from.acc))}</b>\nSaldo ${esc(to.acc.name)}: <b>${rp(accBal(to.acc))}</b>` };
}

async function catatDebt(type, words, db) {
  const date = takeDate(words);
  const amt = findAmount(words);
  if (!amt) {
    const name = words.join(' ');
    const list = S.debts.filter(d => d.type === type && remain(d) > 0 && norm(d.name).includes(norm(name)));
    if (list.length) return listDebts(type, list);
    return { text: `Contoh: <code>${type} ${type === 'piutang' ? 'budi' : 'toko andi'} 500rb</code>` };
  }
  const skip = new Set([...Array(amt.used).keys()].map(k => amt.index + k));
  const after = words.map((w, i) => ({ w, i })).filter(x => x.i > amt.index + amt.used - 1);
  const f = findAccount(after.map(x => x.w));
  if (f) for (let k = 0; k < f.len; k++) skip.add(after[f.index + k].i);
  const name = cleanNote(words.slice(0, amt.index));
  if (!name) return { text: `Nama orangnya siapa? Contoh: <code>${type} budi 500rb</code>` };
  const note = cleanNote(words.filter((_, i) => i > amt.index && !skip.has(i)));
  const d = { id: uid(), type, name: cap(name), amount: amt.value, date, due: '', note: note ? cap(note) : '', payments: [], created: Date.now(), via: 'telegram' };
  await db.set('debts', d); S.debts.push(d);
  const mem = { debts: [d.id], txs: [] };
  let accLine = '';
  if (f) {
    const tx = { id: uid(), accountId: f.acc.id, type: type === 'piutang' ? 'out' : 'in', amount: amt.value, note: (type === 'piutang' ? 'Dipinjamkan ke ' : 'Pinjaman dari ') + d.name, date, cat: type === 'piutang' ? 'Piutang' : 'Hutang', created: Date.now(), via: 'telegram' };
    await db.set('txs', tx); S.txs.push(tx); mem.txs.push(tx.id);
    accLine = `\n💳 ${type === 'piutang' ? 'Keluar dari' : 'Masuk ke'} ${esc(f.acc.name)}, saldo: <b>${rp(accBal(f.acc))}</b>`;
  }
  await remember(db, mem);
  const icon = type === 'piutang' ? '🟡 Piutang' : '🔴 Hutang';
  const tot = sumRemain(S.debts.filter(x => x.type === type));
  return { text: `${icon} dicatat\n👤 <b>${esc(d.name)}</b>: ${rp(d.amount)}${d.note ? '\n📝 ' + esc(d.note) : ''}${accLine}\n\nTotal ${type} belum lunas: <b>${rp(tot)}</b>` };
}

async function cicil(words, db, forceType) {
  const date = takeDate(words);
  const amt = findAmount(words);
  if (!amt) return { text: 'Contoh: <code>cicil budi 200rb</code> atau <code>budi bayar 200rb ke bca</code>' };
  const skip = new Set([...Array(amt.used).keys()].map(k => amt.index + k));
  const rest = words.map((w, i) => ({ w, i })).filter(x => !skip.has(x.i));
  // nama orang = kata sebelum nominal (tanpa kata hubung); rekening = sesudah nominal
  const after = rest.filter(x => x.i > amt.index);
  const f = findAccount(after.map(x => x.w));
  const accIdx = new Set(); if (f) for (let k = 0; k < f.len; k++) accIdx.add(after[f.index + k].i);
  let nameWords = rest.filter(x => x.i < amt.index).map(x => x.w);
  let type = forceType;
  if (/^(piutang|hutang|utang)$/i.test(nameWords[0] || '')) { type = /piutang/i.test(nameWords[0]) ? 'piutang' : 'hutang'; nameWords = nameWords.slice(1) }
  const name = norm(cleanNote(nameWords));
  if (!name) return { text: 'Nama orangnya siapa? Contoh: <code>cicil budi 200rb</code>' };
  let cands = S.debts.filter(d => remain(d) > 0 && (!type || d.type === type) && (norm(d.name) === name || norm(d.name).includes(name)));
  const exact = cands.filter(d => norm(d.name) === name); if (exact.length) cands = exact;
  if (!cands.length) return { text: `Tidak ada ${type || 'piutang/hutang'} aktif atas nama <b>${esc(cleanNote(nameWords))}</b>.\nKetik <code>piutang</code> atau <code>hutang</code> untuk melihat daftarnya.` };
  const types = new Set(cands.map(d => d.type));
  if (types.size > 1) return { text: `<b>${esc(cleanNote(nameWords))}</b> ada di piutang dan hutang. Tulis salah satunya:\n<code>cicil piutang ${esc(cleanNote(nameWords))} ${fmtN(amt.value)}</code>\n<code>cicil hutang ${esc(cleanNote(nameWords))} ${fmtN(amt.value)}</code>` };
  cands.sort((a, b) => a.date.localeCompare(b.date) || (a.created || 0) - (b.created || 0));
  const d = cands[0];
  const s = remain(d);
  const pay = { id: uid(), amount: amt.value, date, note: 'via Telegram' };
  d.payments.push(pay);
  await db.set('debts', d);
  const mem = { pay: { debt: d.id, pay: pay.id }, txs: [] };
  let accLine = '';
  if (f) {
    const tx = { id: uid(), accountId: f.acc.id, type: d.type === 'piutang' ? 'in' : 'out', amount: amt.value, note: (d.type === 'piutang' ? 'Cicilan dari ' : 'Bayar cicilan ke ') + d.name, date, cat: 'Cicilan', created: Date.now(), via: 'telegram' };
    await db.set('txs', tx); S.txs.push(tx); mem.txs.push(tx.id);
    accLine = `\n💳 ${d.type === 'piutang' ? 'Masuk ke' : 'Keluar dari'} ${esc(f.acc.name)}, saldo: <b>${rp(accBal(f.acc))}</b>`;
  }
  await remember(db, mem);
  const sisa = remain(d);
  const head = d.type === 'piutang' ? `🟡 Cicilan dari <b>${esc(d.name)}</b> diterima` : `🔴 Cicilan ke <b>${esc(d.name)}</b> dibayar`;
  return { text: `${head}: ${rp(amt.value)}\nSisa: <b>${rp(sisa)}</b> dari ${rp(d.amount)}${sisa <= 0 ? '\n🎉 <b>LUNAS!</b>' : ''}${amt.value > s ? '\n⚠️ Nominal melebihi sisa sebelumnya (' + rp(s) + ').' : ''}${accLine}` };
}

function saldo(words) {
  if (!S.accounts.length) return needAccount();
  if (words.length) { const f = findAccount(words); if (!f) return needAccount(words.join(' ')); const io = accIO(f.acc); const m = accIO(f.acc, localDate().slice(0, 7));
    return { text: `💳 <b>${esc(f.acc.name)}</b>${f.acc.number ? ' · ' + esc(f.acc.number) : ''}\nSaldo: <b>${rp(accBal(f.acc))}</b>\n\nTotal pemasukan: ${rp(io.in)}\nTotal pengeluaran: ${rp(io.out)}\nBulan ini: +${fmtN(m.in)} / −${fmtN(m.out)}` } }
  let tot = 0;
  const lines = S.accounts.map(a => { const b = accBal(a); tot += b; return `• ${esc(a.name)}: <b>${rp(b)}</b>` });
  const P = sumRemain(S.debts.filter(d => d.type === 'piutang')), H = sumRemain(S.debts.filter(d => d.type === 'hutang'));
  return { text: `💰 <b>Saldo semua rekening</b>\n${lines.join('\n')}\n\nTotal: <b>${rp(tot)}</b>\n🟡 Piutang belum lunas: ${rp(P)}\n🔴 Hutang belum lunas: ${rp(H)}` };
}
function txLines(list) { return list.map(t => { const a = getAcc(t.accountId); return `${t.type === 'in' ? '➕' : '➖'} ${rp(t.amount)} · ${esc(a ? a.name : '?')} · ${esc(t.note || '')}` }).join('\n') }
function ringkasHari() {
  const d = localDate(); const list = S.txs.filter(t => t.date === d);
  if (!list.length) return { text: 'Belum ada transaksi hari ini.' };
  const i = list.filter(t => t.type === 'in').reduce((a, t) => a + t.amount, 0), o = list.filter(t => t.type === 'out').reduce((a, t) => a + t.amount, 0);
  return { text: `📅 <b>Hari ini (${fmtDate(d)})</b>\n${txLines(list)}\n\nMasuk: <b>${rp(i)}</b>\nKeluar: <b>${rp(o)}</b>` };
}
function ringkasBulan() {
  const m = localDate().slice(0, 7); const list = S.txs.filter(t => t.date.startsWith(m) && !/^Transfer/.test(t.cat || ''));
  const i = list.filter(t => t.type === 'in').reduce((a, t) => a + t.amount, 0), o = list.filter(t => t.type === 'out').reduce((a, t) => a + t.amount, 0);
  const byCat = {}; list.filter(t => t.type === 'out').forEach(t => { const c = t.cat || 'Lainnya'; byCat[c] = (byCat[c] || 0) + t.amount });
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, v]) => `• ${esc(c)}: ${rp(v)}`).join('\n');
  return { text: `📊 <b>${BULAN[+m.slice(5) - 1]} ${m.slice(0, 4)}</b> (tanpa transfer antar rekening)\nMasuk: <b>${rp(i)}</b>\nKeluar: <b>${rp(o)}</b>\nSelisih: <b>${rp(i - o)}</b>${top ? '\n\nPengeluaran terbesar:\n' + top : ''}` };
}
function listDebts(type, list) {
  list = list || S.debts.filter(d => d.type === type && remain(d) > 0);
  if (!list.length) return { text: type === 'piutang' ? '🟡 Tidak ada piutang yang belum lunas.' : '🔴 Tidak ada hutang yang belum lunas.' };
  const lines = list.map(d => `• <b>${esc(d.name)}</b>: sisa ${rp(remain(d))} dari ${rp(d.amount)}${d.due ? ' · tempo ' + fmtDate(d.due) : ''}`);
  return { text: `${type === 'piutang' ? '🟡 <b>Piutang</b> (orang berhutang ke kamu)' : '🔴 <b>Hutang</b> (kamu berhutang)'}\n${lines.join('\n')}\n\nTotal: <b>${rp(sumRemain(list))}</b>` };
}
function listRekening() {
  if (!S.accounts.length) return needAccount();
  return { text: '💳 <b>Rekening</b>\n' + S.accounts.map(a => `• ${esc(a.name)} (${esc(a.kind)})${a.number ? ' · ' + esc(a.number) : ''}`).join('\n') };
}
async function tambahRekening(words, db) {
  const numIdx = words.findIndex(w => /^\+?\d[\d-]{5,}$/.test(w));
  const number = numIdx >= 0 ? words[numIdx] : '';
  const name = words.filter((_, i) => i !== numIdx).join(' ').trim();
  if (!name) return { text: 'Contoh: <code>tambah rekening seabank 901234567</code>' };
  if (S.accounts.some(a => norm(a.name) === norm(name))) return { text: `Rekening <b>${esc(name)}</b> sudah ada.` };
  const nm = name.length <= 4 ? name.toUpperCase() : cap(name);
  const kind = EWALLETS.some(e => norm(name).includes(norm(e))) ? 'E-Wallet' : 'Bank';
  const colors = ['#4da3ff', '#2ee59d', '#ff8a3d', '#b07cff', '#ff4d8d', '#00c2d1'];
  const a = { id: uid(), name: nm, kind, color: colors[S.accounts.length % colors.length], number, owner: '', initial: 0, logo: '', created: Date.now() };
  await db.set('accounts', a); S.accounts.push(a);
  await remember(db, { accounts: [a.id] });
  return { text: `✅ Rekening <b>${esc(nm)}</b> (${kind}) ditambahkan.\nAtur saldo awal & logo di aplikasi Keuanganku.` };
}

/* --- batal (undo) --- */
async function remember(db, last) { await db.setRootField('botLast', { ...last, at: Date.now() }) }
async function undo(db) {
  const root = await db.getRoot(); const L = root.botLast;
  if (!L || !L.at) return { text: 'Tidak ada catatan dari bot yang bisa dibatalkan.' };
  if (Date.now() - L.at > 24 * 3600e3) return { text: 'Catatan terakhir sudah lebih dari 24 jam. Hapus lewat aplikasi Keuanganku.' };
  const done = [];
  for (const id of L.txs || []) { const t = S.txs.find(x => x.id === id); if (t) { await db.del('txs', id); done.push(`${t.type === 'in' ? 'pemasukan' : 'pengeluaran'} ${rp(t.amount)}`) } }
  for (const id of L.debts || []) { const d = S.debts.find(x => x.id === id); if (d) { await db.del('debts', id); done.push(`${d.type} ${esc(d.name)} ${rp(d.amount)}`) } }
  for (const id of L.accounts || []) { const a = S.accounts.find(x => x.id === id); if (a) { await db.del('accounts', id); done.push(`rekening ${esc(a.name)}`) } }
  if (L.pay) { const d = S.debts.find(x => x.id === L.pay.debt); if (d) { const p = d.payments.find(p => p.id === L.pay.pay); if (p) { d.payments = d.payments.filter(x => x !== p); await db.set('debts', d); done.push(`cicilan ${esc(d.name)} ${rp(p.amount)}`) } } }
  await db.setRootField('botLast', null);
  return { text: done.length ? '↩️ Dibatalkan: ' + done.join(', ') : 'Catatan terakhir sudah tidak ada (mungkin sudah dihapus di aplikasi).' };
}

/* ================= EXCEL ================= */
/*XLSX-START*/
const CRC_T=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
function crc32(b){let c=0xFFFFFFFF;for(let i=0;i<b.length;i++)c=CRC_T[(c^b[i])&255]^(c>>>8);return(c^0xFFFFFFFF)>>>0}
function zipStore(files){
  const enc=new TextEncoder(),parts=[],cd=[];let off=0;const d=new Date();
  const dt=((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate(),tm=(d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1);
  for(const[name,data]of files){const nb=enc.encode(name),crc=crc32(data);
    const h=new DataView(new ArrayBuffer(30));h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x0800,true);h.setUint16(8,0,true);h.setUint16(10,tm,true);h.setUint16(12,dt,true);h.setUint32(14,crc,true);h.setUint32(18,data.length,true);h.setUint32(22,data.length,true);h.setUint16(26,nb.length,true);h.setUint16(28,0,true);
    parts.push(h,nb,data);
    const c=new DataView(new ArrayBuffer(46));c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x0800,true);c.setUint16(10,0,true);c.setUint16(12,tm,true);c.setUint16(14,dt,true);c.setUint32(16,crc,true);c.setUint32(20,data.length,true);c.setUint32(24,data.length,true);c.setUint16(28,nb.length,true);c.setUint32(42,off,true);
    cd.push(c,nb);off+=30+nb.length+data.length}
  const cdSize=cd.reduce((a,p)=>a+p.byteLength,0);
  const e=new DataView(new ArrayBuffer(22));e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,cdSize,true);e.setUint32(16,off,true);
  return new Blob([...parts,...cd,e],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
/* style: 0 teks, 1 header, 2 angka, 3 header angka, 4 teks tebal, 5 angka tebal, 6 judul */
const XLSX_STYLES='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF5"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFC9D1DC"/></left><right style="thin"><color rgb="FFC9D1DC"/></right><top style="thin"><color rgb="FFC9D1DC"/></top><bottom style="thin"><color rgb="FFC9D1DC"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="3" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="3" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
function xlsxBlob(sheets){
  const enc=new TextEncoder();
  const X=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'');
  const col=i=>{let s='';i++;while(i>0){const m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26)}return s};
  const used=new Set();
  const names=sheets.map(sh=>{let n=String(sh.name).replace(/[\[\]\*\?\/\\:]/g,' ').trim().slice(0,31)||'Sheet',b=n,k=2;while(used.has(n.toLowerCase())){const suf=' ('+(k++)+')';n=b.slice(0,31-suf.length)+suf}used.add(n.toLowerCase());return n});
  const hd='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files=[
    ['[Content_Types].xml',hd+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')+'</Types>'],
    ['_rels/.rels',hd+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml',hd+'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+names.map((n,i)=>`<sheet name="${X(n)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')+'</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels',hd+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')+`<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml',XLSX_STYLES]
  ];
  sheets.forEach((sh,i)=>{
    const rows=sh.rows.map((r,ri)=>`<row r="${ri+1}">`+(r||[]).map((c,ci)=>{if(c==null||c==='')return'';const o=typeof c==='object'?c:{v:c};if(o.v==null||o.v==='')return o.s!=null?`<c r="${col(ci)}${ri+1}" s="${o.s}"/>`:'';const ref=col(ci)+(ri+1);
      if(typeof o.v==='number'&&isFinite(o.v))return`<c r="${ref}" s="${o.s??2}"><v>${o.v}</v></c>`;
      return`<c r="${ref}" s="${o.s??0}" t="inlineStr"><is><t xml:space="preserve">${X(o.v)}</t></is></c>`}).join('')+'</row>').join('');
    const view=sh.freeze?`<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze+1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`:'';
    const cols=sh.cols?'<cols>'+sh.cols.map((w,ci)=>`<col min="${ci+1}" max="${ci+1}" width="${w}" customWidth="1"/>`).join('')+'</cols>':'';
    files.push([`xl/worksheets/sheet${i+1}.xml`,hd+`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${view}${cols}<sheetData>${rows}</sheetData></worksheet>`]);
  });
  return zipStore(files.map(([n,t])=>[n,enc.encode(t)]));
}
/*XLSX-END*/
const Hd=a=>a.map(v=>({v,s:typeof v==='number'?3:1}));
const Bd=v=>({v,s:typeof v==='number'?5:4});
const T=v=>({v,s:6});
const nowStr=()=>new Date().toLocaleString('id-ID',{timeZone:TZ});
function accSheet(a){
  const txs=S.txs.filter(t=>t.accountId===a.id).sort((x,y)=>x.date.localeCompare(y.date)||(x.created||0)-(y.created||0));
  let bal=a.initial||0,ti=0,to=0;
  const rows=[[T(`${a.name} (${a.kind})`)],['No. HP / Rekening',a.number||'-'],['Atas nama',a.owner||'-'],['Diunduh',nowStr()],[],
    Hd(['No','Tanggal','Keterangan','Kategori','Pemasukan','Pengeluaran','Saldo']),
    ['','','Saldo awal','','','',bal]];
  txs.forEach((t,i)=>{if(t.type==='in'){bal+=t.amount;ti+=t.amount}else{bal-=t.amount;to+=t.amount}
    rows.push([i+1,fmtDate(t.date),t.note||(t.type==='in'?'Pemasukan':'Pengeluaran'),t.cat||'',t.type==='in'?t.amount:'',t.type==='out'?t.amount:'',bal])});
  rows.push([Bd(''),Bd(''),Bd('TOTAL'),Bd(''),Bd(ti),Bd(to),Bd(bal)]);
  return{name:a.name,rows,cols:[6,12,34,16,16,16,18]};
}
function debtSheet(type){
  const ds=S.debts.filter(d=>d.type===type).sort((x,y)=>x.date.localeCompare(y.date));
  const isP=type==='piutang';let tA=0,tP=0,tS=0;
  const rows=[[T(isP?'Daftar Piutang (orang berhutang ke saya)':'Daftar Hutang (saya berhutang)')],['Diunduh',nowStr()],[],
    Hd(['No','Nama','Tanggal','Jatuh Tempo','Total',isP?'Sudah Diterima':'Sudah Dibayar','Sisa','Status','Catatan'])];
  ds.forEach((d,i)=>{const p=paid(d),s=remain(d);tA+=d.amount;tP+=p;tS+=s;rows.push([i+1,d.name,fmtDate(d.date),d.due?fmtDate(d.due):'-',d.amount,p,s,s<=0?'LUNAS':'Belum lunas',d.note||''])});
  rows.push([Bd(''),Bd('TOTAL'),Bd(''),Bd(''),Bd(tA),Bd(tP),Bd(tS),Bd(''),Bd('')]);
  return{name:isP?'Piutang':'Hutang',rows,cols:[6,22,12,13,16,16,16,13,30],freeze:4};
}
function buildSheets(){
  const sheets=[];
  let tb=0,ti=0,to=0;
  const r=[[T('Laporan Keuangan')],['Diunduh',nowStr()],[],Hd(['Rekening','Jenis','No. HP / Rekening','Atas Nama','Saldo Awal','Pemasukan','Pengeluaran','Saldo Akhir'])];
  S.accounts.forEach(a=>{const io=accIO(a),b=accBal(a);tb+=b;ti+=io.in;to+=io.out;r.push([a.name,a.kind,a.number||'-',a.owner||'-',a.initial||0,io.in,io.out,b])});
  r.push([Bd('TOTAL'),Bd(''),Bd(''),Bd(''),Bd(S.accounts.reduce((x,a)=>x+(a.initial||0),0)),Bd(ti),Bd(to),Bd(tb)]);
  r.push([],Hd(['Piutang & Hutang','Jumlah Data','Total','Sudah Dibayar','Sisa','Belum Lunas']));
  ['piutang','hutang'].forEach(t=>{const ds=S.debts.filter(d=>d.type===t);r.push([t==='piutang'?'Piutang (orang berhutang ke saya)':'Hutang (saya berhutang)',ds.length,ds.reduce((x,d)=>x+d.amount,0),ds.reduce((x,d)=>x+paid(d),0),sumRemain(ds),ds.filter(d=>remain(d)>0).length])});
  sheets.push({name:'Ringkasan',rows:r,cols:[34,12,20,18,16,16,16,16]});
  const all=[...S.txs].sort((x,y)=>x.date.localeCompare(y.date)||(x.created||0)-(y.created||0));
  const tr=[[T('Semua Transaksi')],['Diunduh',nowStr()],[],Hd(['No','Tanggal','Rekening','Jenis','Keterangan','Kategori','Pemasukan','Pengeluaran'])];
  all.forEach((t,i)=>{const a=getAcc(t.accountId);tr.push([i+1,fmtDate(t.date),a?a.name:'-',t.type==='in'?'Pemasukan':'Pengeluaran',t.note||'',t.cat||'',t.type==='in'?t.amount:'',t.type==='out'?t.amount:''])});
  tr.push([Bd(''),Bd(''),Bd('TOTAL'),Bd(''),Bd(''),Bd(''),Bd(ti),Bd(to)]);
  sheets.push({name:'Semua Transaksi',rows:tr,cols:[6,12,18,13,32,16,16,16],freeze:4});
  S.accounts.forEach(a=>sheets.push(accSheet(a)));
  sheets.push(debtSheet('piutang'),debtSheet('hutang'));
  const cr=[[T('Riwayat Cicilan')],['Diunduh',nowStr()],[],Hd(['Jenis','Nama','Tanggal Bayar','Nominal','Sisa Setelah Bayar','Catatan'])];
  S.debts.forEach(d=>{let rest=d.amount;[...d.payments].sort((a,b)=>a.date.localeCompare(b.date)).forEach(p=>{rest-=p.amount;cr.push([d.type==='piutang'?'Piutang':'Hutang',d.name,fmtDate(p.date),p.amount,Math.max(0,rest),p.note||''])})});
  sheets.push({name:'Riwayat Cicilan',rows:cr,cols:[11,22,14,16,18,30],freeze:4});
  return sheets;
}


/* ================= TELEGRAM ================= */
async function tg(env, method, body) {
  const isForm = body instanceof FormData;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, { method: 'POST', headers: isForm ? undefined : { 'content-type': 'application/json' }, body: isForm ? body : JSON.stringify(body) });
  return r.json().catch(() => ({}));
}
const reply = (env, chat_id, text) => tg(env, 'sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true });

async function onUpdate(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;
  const chat = msg.chat.id;
  if (String(chat) !== String(env.ALLOWED_CHAT_ID || '').trim()) {
    await reply(env, chat, `🔒 Bot ini pribadi.\nID Telegram kamu: <code>${chat}</code>\n\nKalau ini bot milikmu, isi ID itu ke variabel <b>ALLOWED_CHAT_ID</b> di Cloudflare.`);
    return;
  }
  if (!msg.text) { await reply(env, chat, 'Kirim pesan teks ya. Ketik <code>bantuan</code> untuk contoh.'); return }
  TZ = env.TIMEZONE || 'Asia/Makassar';
  const db = makeDb(env);
  try {
    await loadAll(db);
    const out = await handle(msg.text, db);
    if (out.excel) {
      if (!S.accounts.length && !S.debts.length) { await reply(env, chat, 'Belum ada data untuk direkap.'); return }
      const blob = xlsxBlob(buildSheets());
      const fd = new FormData();
      fd.append('chat_id', String(chat));
      fd.append('caption', `📊 Rekap Keuanganku ${fmtDate(localDate())}`);
      fd.append('document', blob, `Keuanganku_${stamp()}.xlsx`);
      await tg(env, 'sendDocument', fd);
      return;
    }
    await reply(env, chat, out.text);
  } catch (e) {
    await reply(env, chat, '⚠️ Gagal: ' + esc(e.message || e) + '\n\nCek pengaturan FIREBASE_SA dan FIREBASE_UID di Cloudflare.');
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Pasang webhook: buka https://<worker>/setup?key=WEBHOOK_SECRET sekali saja
    if (request.method === 'GET' && url.pathname === '/setup') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('Kunci salah.', { status: 403 });
      const r = await tg(env, 'setWebhook', { url: url.origin + '/telegram', secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'edited_message'], drop_pending_updates: true });
      await tg(env, 'setMyCommands', { commands: [{ command: 'saldo', description: 'Lihat saldo semua rekening' }, { command: 'rekap', description: 'Kirim rekap Excel' }, { command: 'batal', description: 'Batalkan catatan terakhir' }, { command: 'bantuan', description: 'Contoh cara mencatat' }] });
      return new Response(r.ok ? '✅ Webhook terpasang. Sekarang kirim pesan ke bot kamu di Telegram.' : '❌ Gagal: ' + JSON.stringify(r), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (request.method === 'POST' && url.pathname === '/telegram') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(onUpdate(update, env).catch(() => { }));
      return new Response('ok');
    }
    return new Response('Keuanganku Bot aktif.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
};

