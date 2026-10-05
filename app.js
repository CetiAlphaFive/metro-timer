import { ST, LINE_NAMES, DEFAULT_RIDES, DEFAULT_SETTINGS, parseTrains, plan, defaultDirection } from './logic.js';

const API = 'https://api.wmata.com';
const POLL_MS = 30_000;
const INCIDENT_MS = 120_000;
const STALE_MS = 90_000;
const RIDES_TTL_MS = 7 * 24 * 3600_000;

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// localStorage can throw (private mode, blocked storage); fall back to defaults.
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? { ...fallback, ...JSON.parse(v) } : { ...fallback }; }
  catch { return { ...fallback }; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const state = {
  settings: load('metro.settings', DEFAULT_SETTINGS),
  rides: { ...DEFAULT_RIDES },
  trains: [],
  fetchedAt: 0,
  error: null,
  incidents: [],
  incidentsAt: 0,
  dir: defaultDirection(new Date()),
  dirManual: false,
  inflight: false,
};

const cachedRides = load('metro.rides', {});
if (cachedRides.at) Object.assign(state.rides, cachedRides.rides);

// ---------- network ----------

async function api(path, key = state.settings.apiKey) {
  const r = await fetch(API + path, { headers: { api_key: key }, cache: 'no-store' });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('key'), { kind: 'key' });
  if (r.status === 429) throw Object.assign(new Error('rate'), { kind: 'rate' });
  if (!r.ok) throw Object.assign(new Error('http ' + r.status), { kind: 'http' });
  return r.json();
}

const STATIONS_PATH = `/StationPrediction.svc/json/GetPrediction/${[ST.VAN_NESS, ST.FARRAGUT_NORTH, ST.FARRAGUT_WEST, ST.VIRGINIA_SQ].join(',')}`;

async function refresh() {
  if (!state.settings.apiKey || state.inflight) return;
  state.inflight = true;
  try {
    const raw = await api(STATIONS_PATH);
    state.trains = parseTrains(raw);
    state.fetchedAt = Date.now();
    state.error = null;
  } catch (e) {
    state.error = e.kind || 'network';
  } finally {
    state.inflight = false;
  }
  if (Date.now() - state.incidentsAt > INCIDENT_MS) refreshIncidents();
  render();
}

async function refreshIncidents() {
  state.incidentsAt = Date.now();
  try {
    const raw = await api('/Incidents.svc/json/Incidents');
    state.incidents = (raw.Incidents || []).filter(i => /\b(RD|OR|SV)\b/.test(i.LinesAffected || ''));
    render();
  } catch {}
}

// Scheduled ride times between our stations, refreshed weekly.
async function refreshRides() {
  if (cachedRides.at && Date.now() - cachedRides.at < RIDES_TTL_MS) return;
  const rides = { ...DEFAULT_RIDES };
  try {
    await Promise.all(Object.keys(rides).map(async pair => {
      const [from, to] = pair.split('-');
      const raw = await api(`/Rail.svc/json/jSrcStationToDstStationInfo?FromStationCode=${from}&ToStationCode=${to}`);
      const t = raw.StationToStationInfos?.[0]?.RailTime;
      if (Number.isFinite(t) && t > 0) rides[pair] = t;
    }));
    state.rides = rides;
    save('metro.rides', { at: Date.now(), rides });
    render();
  } catch {}
}

// ---------- rendering ----------

const clockAt = minsFromNow => new Date(Date.now() + minsFromNow * 60_000)
  .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const mins = m => Math.max(0, Math.round(m));
const pill = line => `<span class="pill ${esc(line)}">${esc((LINE_NAMES[line] || line).slice(0, 3).toUpperCase())}</span>`;
const lineName = t => LINE_NAMES[t.line] || t.line;

function connText(conn, dir) {
  if (conn.estimate) {
    const what = dir === 'am' ? 'Orange/Silver' : 'Red';
    return `${what} connection not in live data yet (every ~${conn.headway} min)`;
  }
  const t = conn.train;
  return `→ ${lineName(t)} to ${esc(t.dest)} in ${mins(t.away)} min, ${Math.floor(conn.wait)} min to spare`;
}

function renderHero(p, dir) {
  const leaveWhere = dir === 'am' ? 'Leave home in' : 'Leave the office in';
  const originName = dir === 'am' ? 'Van Ness' : 'Virginia Sq';
  const endName = dir === 'am' ? 'Mercatus' : 'home';
  let html = `<div class="label">${leaveWhere}</div>`;
  if (!state.fetchedAt) {
    html += `<div class="big">…</div><div class="sub">${state.settings.apiKey ? 'Loading live trains' : 'Add your WMATA key in settings ⚙'}</div>`;
  } else if (!p.hero) {
    const headway = dir === 'am' ? 'Red trains run every ~6 min' : 'Orange/Silver trains run every ~5 min';
    html += `<div class="big">–</div><div class="sub">No train you can make is in the live data yet. ${headway}. This updates every 30 s.</div>`;
  } else {
    const h = p.hero, t = h.train, n = Math.floor(h.leaveIn);
    html += n <= 0
      ? `<div class="big now">Now</div>`
      : `<div class="big">${n}<small>min</small></div>`;
    html += `<div class="sub">by ${clockAt(h.leaveIn)} · ${lineName(t)} to ${esc(t.dest)} reaches ${originName} at ${clockAt(t.away)}</div>`;
    const approx = h.conn.estimate ? '≈ ' : '~';
    html += `<div class="eta">${approx}${clockAt(h.arriveIn)} at ${endName}</div>`;
  }
  if (p.hurry && state.fetchedAt) {
    const t = p.hurry.train;
    html += `<div class="hurry">Or hustle: ${lineName(t)} to ${esc(t.dest)} in ${mins(t.away)} min, if you leave right now with no time to spare.</div>`;
  }
  $('hero').innerHTML = html;
}

function renderOrigin(p, dir) {
  $('originTitle').textContent = dir === 'am' ? 'Van Ness · toward Glenmont' : 'Virginia Square · toward downtown';
  if (!p.deps.length) { $('originList').innerHTML = `<div class="empty">${state.fetchedAt ? 'No trains on the board.' : ''}</div>`; return; }
  $('originList').innerHTML = p.deps.slice(0, 6).map(d => {
    const t = d.train;
    const right = d.status === 'ok'
      ? `leave in ${Math.floor(d.leaveIn)}`
      : d.status === 'hurry' ? `<span class="tag hurry">hurry</span>` : `<span class="tag gone">too late</span>`;
    return `<div class="row ${d.status === 'gone' ? 'gone' : ''}">${pill(t.line)}
      <div class="main"><div class="t">${esc(t.dest)}</div><div class="d">arrives ${clockAt(t.away)}${t.cars ? ` · ${esc(t.cars)} cars` : ''}</div></div>
      <div class="right">${right}<div class="d">${mins(t.away)} min</div></div></div>`;
  }).join('');
}

function renderCrossing(p, dir) {
  $('crossHint').textContent = dir === 'am'
    ? `On the Red train? Find yours by when it reaches Farragut North, then walk ${state.settings.crossWalk} min to Farragut West.`
    : `On the Orange/Silver? Find yours by when it reaches Farragut West, then walk ${state.settings.crossWalk} min to Farragut North.`;
  const at = dir === 'am' ? 'Farragut N' : 'Farragut W';
  if (!p.crossing.length) { $('crossList').innerHTML = `<div class="empty">${state.fetchedAt ? 'No trains approaching.' : ''}</div>`; return; }
  $('crossList').innerHTML = p.crossing.map(c => {
    const t = c.train, conn = c.conn;
    const tag = conn.estimate ? `<span class="tag est">later</span>` : `<span class="tag ${conn.rating}">${conn.rating}</span>`;
    const hustle = conn.hustle
      ? `<div class="hustle">Speed-walk and you might catch the ${lineName(conn.hustle)} in ${mins(conn.hustle.away)} min</div>` : '';
    return `<div class="row">${pill(t.line)}
      <div class="main"><div class="t">${esc(t.dest)} · ${at} ${t.away < 0.5 ? 'now' : `in ${mins(t.away)} min`}</div><div class="d">${connText(conn, dir)}</div>${hustle}</div>
      <div class="right">${tag}</div></div>`;
  }).join('');
}

function renderTransferBoard(p, dir) {
  $('xferTitle').textContent = dir === 'am' ? 'Farragut West · toward Vienna / Ashburn' : 'Farragut North · toward Shady Grove';
  if (!p.transferBoard.length) { $('xferList').innerHTML = `<div class="empty">${state.fetchedAt ? 'No trains on the board.' : ''}</div>`; return; }
  $('xferList').innerHTML = p.transferBoard.slice(0, 5).map(t => `<div class="row">${pill(t.line)}
    <div class="main"><div class="t">${esc(t.dest)}</div><div class="d">${clockAt(t.away)}${t.cars ? ` · ${esc(t.cars)} cars` : ''}</div></div>
    <div class="right">${t.away < 0.5 ? 'now' : mins(t.away) + ' min'}</div></div>`).join('');
}

function renderBanners() {
  const out = [];
  const errMsg = {
    key: 'WMATA rejected the API key. Check it in settings ⚙.',
    rate: 'WMATA is rate-limiting requests. Retrying shortly.',
    http: 'WMATA returned an error. Showing the last data.',
    network: "Can't reach WMATA. Showing the last data.",
  }[state.error];
  if (errMsg) out.push(`<div class="banner err">${errMsg}</div>`);
  for (const i of state.incidents) {
    out.push(`<div class="banner">${esc(i.Description || '')}</div>`);
  }
  $('banners').innerHTML = out.join('');
}

function renderFooter() {
  const s = state.settings, r = state.rides;
  let ago = '';
  if (state.fetchedAt) {
    const sec = Math.round((Date.now() - state.fetchedAt) / 1000);
    const txt = sec < 60 ? `${sec}s ago` : `${Math.floor(sec / 60)}m ago`;
    ago = Date.now() - state.fetchedAt > STALE_MS ? `<span class="stale">Updated ${txt}</span>` : `Updated ${txt}`;
  }
  const rides = state.dir === 'am'
    ? `walk ${s.homeWalk} · Red ${r['A06-A02']} · cross ${s.crossWalk} · OR/SV ${r['C03-K03']} · walk ${s.officeWalk}`
    : `walk ${s.officeWalk} · OR/SV ${r['K03-C03']} · cross ${s.crossWalk} · Red ${r['A02-A06']} · walk ${s.homeWalk}`;
  $('footer').innerHTML = `${ago ? ago + ' · ' : ''}<button id="refreshBtn">Refresh</button><br>${rides} min · spare ${s.cushion}`;
  $('refreshBtn').onclick = refresh;
}

function render() {
  const elapsed = state.fetchedAt ? (Date.now() - state.fetchedAt) / 60_000 : 0;
  const p = plan(state.dir, state.trains, state.settings, state.rides, elapsed);
  $('amBtn').setAttribute('aria-pressed', String(state.dir === 'am'));
  $('pmBtn').setAttribute('aria-pressed', String(state.dir === 'pm'));
  renderBanners();
  renderHero(p, state.dir);
  renderOrigin(p, state.dir);
  renderCrossing(p, state.dir);
  renderTransferBoard(p, state.dir);
  renderFooter();
}

// ---------- settings ----------

const dlg = $('settings');
const NUM_FIELDS = ['homeWalk', 'officeWalk', 'cushion', 'crossWalk'];

function openSettings() {
  $('apiKey').value = state.settings.apiKey;
  for (const f of NUM_FIELDS) $(f).value = state.settings[f];
  $('keyStatus').textContent = '';
  $('keyStatus').className = '';
  dlg.showModal();
}

$('settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const next = { ...state.settings, apiKey: $('apiKey').value.trim() };
  for (const f of NUM_FIELDS) {
    const v = Number($(f).value);
    next[f] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_SETTINGS[f];
  }
  const status = $('keyStatus');
  if (!next.apiKey) { status.textContent = 'Paste your WMATA key first.'; status.className = 'err'; return; }
  if (next.apiKey !== state.settings.apiKey) {
    status.textContent = 'Checking key…'; status.className = '';
    $('saveBtn').disabled = true;
    try {
      await api(STATIONS_PATH, next.apiKey);
    } catch (err) {
      status.textContent = err.kind === 'key' ? 'WMATA rejected that key. Use the Primary key from your profile.' : "Couldn't reach WMATA to check the key. Try again.";
      status.className = 'err';
      $('saveBtn').disabled = false;
      return;
    }
    $('saveBtn').disabled = false;
  }
  const keyChanged = next.apiKey !== state.settings.apiKey;
  state.settings = next;
  save('metro.settings', next);
  dlg.close();
  if (keyChanged) { state.error = null; refreshRides(); refreshIncidents(); }
  refresh();
  render();
});
$('cancelBtn').onclick = () => dlg.close();
$('settingsBtn').onclick = openSettings;

// ---------- direction + lifecycle ----------

$('amBtn').onclick = () => { state.dir = 'am'; state.dirManual = true; render(); };
$('pmBtn').onclick = () => { state.dir = 'pm'; state.dirManual = true; render(); };

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!state.dirManual) state.dir = defaultDirection(new Date());
  if (Date.now() - state.fetchedAt > 10_000) refresh();
  render();
});

setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
setInterval(() => { if (document.visibilityState === 'visible') render(); }, 5_000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

render();
if (state.settings.apiKey) { refresh(); refreshRides(); }
else openSettings();
