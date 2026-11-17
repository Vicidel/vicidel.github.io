// Transit Reach: where can I go from Lausanne within X minutes by train/bus?
// Data built by scripts/build_reachability.py:
//   data/manifest.json, data/stations.json, data/reach_<origin>_<YYYYMMDD>.bin.gz

const WMTS = (layer, ext = 'png') =>
  `https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/3857/{z}/{x}/{y}.${ext}`;

const CHANGE_LABELS = ['Direct', '1', '2', '3', '4'];
const MODES = [  // bit values must match MODE_BITS in the python script
  {bit: 1, label: 'Train'}, {bit: 2, label: 'Bus'}, {bit: 4, label: 'Metro'},
  {bit: 8, label: 'Tram'}, {bit: 16, label: 'Boat'}, {bit: 32, label: 'Cable car'},
];
const DEFAULT_SLOT = '08:00';

const state = {
  origin: null, date: null, slot: 0,
  minTime: 0,
  maxTime: 90,
  changes: new Set([0, 1, 2]),
  modes: new Set(MODES.map(m => m.bit)),
  manifest: null,
  stations: null,    // [[id, name, lat, lon, modeBits], ...]
  reach: {},         // "origin|date" -> Uint8Array [slot][k][station]
};

// ------------------------------------------------------------------ map --- //

const map = L.map('map', {preferCanvas: true}).setView([46.52, 6.63], 9);

const topo = L.tileLayer(WMTS('ch.swisstopo.pixelkarte-farbe', 'jpeg'),
  {attribution: '© swisstopo', maxZoom: 18});
const topoGrey = L.tileLayer(WMTS('ch.swisstopo.pixelkarte-grau', 'jpeg'),
  {attribution: '© swisstopo', maxZoom: 18});
const world = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  {attribution: '© OpenStreetMap contributors © CARTO', maxZoom: 19});
const satellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {attribution: '© Esri', maxZoom: 18});

const overlays = {
  'SwissMobile Hiking': L.tileLayer(WMTS('ch.astra.wanderland'), {opacity: 0.7}),
  'SwissMobile Cycling': L.tileLayer(WMTS('ch.astra.veloland'), {opacity: 0.7}),
  'SwissTLM3D Hiking Trails': L.tileLayer(WMTS('ch.swisstopo.swisstlm3d-wanderwege'), {opacity: 0.7}),
  'Rail network': L.tileLayer(WMTS('ch.swisstopo.swisstlm3d-eisenbahnnetz'), {opacity: 0.8}),
  'PT stops (BAV)': L.tileLayer(WMTS('ch.bav.haltestellen-oev'), {opacity: 0.8, minZoom: 11}),
};

const reachLayer = L.layerGroup().addTo(map);
overlays['Reachable stops'] = reachLayer;

topoGrey.addTo(map);
L.control.layers(
  {'Topographic grey (CH)': topoGrey, 'Topographic (CH)': topo, 'World': world, 'Satellite': satellite},
  overlays, {position: 'topright'}).addTo(map);
L.control.scale({imperial: false}).addTo(map);

const panel = document.getElementById('panel');
L.DomEvent.disableClickPropagation(panel);
L.DomEvent.disableScrollPropagation(panel);

// --------------------------------------------------------------- helpers --- //

const $ = id => document.getElementById(id);
const setStatus = txt => { $('status').textContent = txt; };
const fmtMin = m => m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const isoToday = () => new Date().toLocaleDateString('sv');  // YYYY-MM-DD, local time

function colorFor(minutes, min, max) {
  const f = max > min ? Math.min(1, Math.max(0, (minutes - min) / (max - min))) : 0;
  return `hsl(${Math.round(120 * (1 - f))}, 85%, 42%)`;
}

function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  const label = d.toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric', month: 'short'});
  return iso === isoToday() ? `Today (${label})` : label;
}

// Station id for transport.opendata.ch (Swiss stop numbers are 85xxxxx)
function apiId(st) {
  const m = String(st[0]).match(/85\d{5}/);
  return m ? m[0] : st[1];
}

function fillSelect(el, items, value) {
  el.innerHTML = '';
  items.forEach(([v, label]) => el.add(new Option(label, v)));
  el.value = value;
}

function buildChecks(containerId, items, set, onChange) {
  const el = $(containerId);
  el.innerHTML = '';
  items.forEach(({value, label}) => {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = set.has(value);
    cb.addEventListener('change', () => {
      cb.checked ? set.add(value) : set.delete(value);
      onChange();
    });
    lbl.append(cb, ' ' + label);
    el.appendChild(lbl);
  });
}

// ----------------------------------------------------------------- data --- //

async function fetchJson(url) {
  const res = await fetch(url, {cache: 'no-cache'});
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function fetchGzBytes(url) {
  const res = await fetch(url, {cache: 'no-cache'});
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // Some servers already decode it (Content-Encoding: gzip); gzip magic = 1f 8b
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf;
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function currentReach() {
  return state.reach[`${state.origin}|${state.date}`];
}

async function loadReach() {
  const key = `${state.origin}|${state.date}`;
  if (state.reach[key]) return render();
  setStatus('Loading...');
  try {
    const ymd = state.date.replaceAll('-', '');
    state.reach[key] = await fetchGzBytes(`data/reach_${state.origin}_${ymd}.bin.gz`);
  } catch (e) {
    setStatus(`No data: ${e.message}. Run scripts/build_reachability.py.`);
    reachLayer.clearLayers();
    return;
  }
  render();
}

// Binary layout: [layer][slot][changes k][station], layer 0 = travel time
// (departure -> arrival), layer 1 = wait (selected time -> departure). Minutes.
function valueAt(reach, layer, k, i) {
  const m = state.manifest;
  const N = m.n_stations, K1 = m.max_changes + 1;
  return reach[((layer * m.slots.length + state.slot) * K1 + k) * N + i];
}
const minutesAt = (reach, k, i) => valueAt(reach, 0, k, i);
const waitAt = (reach, k, i) => valueAt(reach, 1, k, i);

// --------------------------------------------------------------- render --- //

function renderLegend() {
  const el = $('legend');
  el.style.background = 'linear-gradient(to right, hsl(120,85%,42%), hsl(60,85%,42%), hsl(0,85%,42%))';
  el.innerHTML = `<span style="left:0">${fmtMin(state.minTime)}</span>
    <span style="left:45%">${fmtMin(Math.round((state.minTime + state.maxTime) / 2))}</span>
    <span style="right:0">${fmtMin(state.maxTime)}</span>`;
}

function render() {
  $('mintime-lbl').textContent = fmtMin(state.minTime);
  $('maxtime-lbl').textContent = fmtMin(state.maxTime);
  renderLegend();
  reachLayer.clearLayers();
  const reach = currentReach();
  if (!reach) return;

  const NONE = state.manifest.none, K = state.manifest.max_changes;
  const modeMask = [...state.modes].reduce((a, b) => a | b, 0);
  let count = 0;
  state.stations.forEach((st, i) => {
    if (!(st[4] & modeMask)) return;
    // smallest number of changes that fits in the time budget
    let k = 0, d = NONE;
    for (; k <= K; k++) {
      d = minutesAt(reach, k, i);
      if (d !== NONE && d <= state.maxTime) break;
    }
    if (k > K || !state.changes.has(k)) return;
    // min time: hide places that are closer than that (fastest route, any changes)
    if (state.minTime > 0) {
      let fastest = NONE;
      for (let kk = 0; kk <= K; kk++) fastest = Math.min(fastest, minutesAt(reach, kk, i));
      if (fastest < state.minTime) return;
    }
    const isRail = st[4] & 1;
    L.circleMarker([st[2], st[3]], {
      radius: isRail ? 6 : 4,
      weight: isRail ? 1.5 : 0.5,
      color: '#222',
      fillColor: colorFor(d, state.minTime, state.maxTime),
      fillOpacity: 0.9,
    }).bindPopup(() => popupHtml(st, i), {maxWidth: 340})
      .on('popupopen', e => attachConnButton(e.popup, st))
      .addTo(reachLayer);
    count++;
  });
  setStatus(`${count} stops · leaving ${fmtDate(state.date)} from ${slotLabel()} ` +
    `(within ${state.manifest.max_wait ?? 60} min)`);
}

const slotLabel = () => state.manifest.slots[state.slot];

function popupHtml(st, i) {
  const reach = currentReach();
  const {none: NONE, max_changes: K} = state.manifest;
  const t0 = toMin(slotLabel());
  let rows = '', prev = '';
  for (let k = 0; k <= K; k++) {
    const d = minutesAt(reach, k, i);
    if (d === NONE) continue;
    const dep = t0 + waitAt(reach, k, i), arr = dep + d;
    if (`${dep}|${arr}` === prev) continue;  // same journey as with fewer changes
    prev = `${dep}|${arr}`;
    rows += `<tr><td>${k === 0 ? 'Direct' : k + ' change' + (k > 1 ? 's' : '')}</td>
      <td><b>${fmtMin(d)}</b></td><td>${fromMin(dep)} → ${fromMin(arr)}</td></tr>`;
  }
  const from = state.manifest.origins[state.origin].stops[0];
  return `<div class="popup"><b>${st[1]}</b>
    <div>Next journeys after ${slotLabel()} from ${from} (leave home → arrive)</div>
    <table><tr><th>Changes</th><th>Travel</th><th>Times</th></tr>${rows}</table>
    <button class="conn-btn">Live connections</button>
    <a href="${sbbUrl(from, st)}" target="_blank" rel="noopener">SBB</a>
    <div class="conns"></div></div>`;
}

// sbb.ch timetable deep link, e.g.
// ?stops=Lausanne_I8501120~Bercher_I8501177&date="2026-11-21"&time=15_10&moment=dep
function sbbUrl(fromName, toSt) {
  const fromSt = state.stations.find(s => s[1] === fromName);
  const stop = (s, name) => {
    const id = s && String(s[0]).match(/85\d{5}/);
    return id ? `${s[1]}_I${id[0]}` : name;
  };
  const q = new URLSearchParams({
    stops: `${stop(fromSt, fromName)}~${stop(toSt, toSt[1])}`,
    date: JSON.stringify(state.date),
    time: slotLabel().replace(':', '_'),
    moment: 'dep',
  });
  return `https://www.sbb.ch/en?${q}`;
}

function attachConnButton(popup, st) {
  const root = popup.getElement();
  const out = root.querySelector('.conns');
  root.querySelector('.conn-btn').onclick = async () => {
    out.textContent = 'Loading...';
    try {
      const from = state.manifest.origins[state.origin].stops[0];
      const url = `https://transport.opendata.ch/v1/connections?from=${encodeURIComponent(from)}` +
        `&to=${encodeURIComponent(apiId(st))}&date=${state.date}&time=${slotLabel()}&limit=4`;
      const json = await fetchJson(url);
      out.innerHTML = (json.connections || []).map(c => {
        const dep = c.from.departure.slice(11, 16);
        const arr = c.to.arrival.slice(11, 16);
        const dur = c.duration.replace(/^00d/, '').slice(0, 5);
        return `${dep} → ${arr} (${dur}) · ${c.transfers} chg · ${(c.products || []).join(', ')}`;
      }).join('<br>') || 'No connections found';
    } catch (e) {
      out.textContent = 'Error: ' + e.message;
    }
  };
}

// ----------------------------------------------------------------- init --- //

function defaultSlot(slots, date) {
  // today -> next slot after now; otherwise DEFAULT_SLOT
  let target = toMin(DEFAULT_SLOT);
  if (date === isoToday()) {
    const now = new Date();
    target = now.getHours() * 60 + now.getMinutes();
  }
  const i = slots.findIndex(s => toMin(s) >= target);
  return i === -1 ? slots.length - 1 : i;
}

async function init() {
  try {
    [state.manifest, state.stations] = await Promise.all([
      fetchJson('data/manifest.json'), fetchJson('data/stations.json')]);
  } catch (e) {
    setStatus(`No data (${e.message}). Run scripts/build_reachability.py.`);
    return;
  }
  const m = state.manifest;

  // origin
  const origins = Object.entries(m.origins);
  state.origin = origins[0][0];
  fillSelect($('origin'), origins.map(([k, o]) => [k, o.label]), state.origin);
  $('origin').onchange = e => { state.origin = e.target.value; loadReach(); };

  // date: today if available, else first upcoming, else first
  const today = isoToday();
  state.date = m.dates.find(d => d >= today) || m.dates[0];
  fillSelect($('date'), m.dates.map(d => [d, fmtDate(d) + (d < today ? ' (past)' : '')]), state.date);

  // time
  state.slot = defaultSlot(m.slots, state.date);
  fillSelect($('time'), m.slots.map((s, i) => [i, s]), state.slot);
  $('time').onchange = e => { state.slot = +e.target.value; render(); };
  $('date').onchange = e => { state.date = e.target.value; loadReach(); };

  // slider + checkboxes
  // min/max sliders, kept so that min <= max
  const sMin = $('mintime'), sMax = $('maxtime');
  sMin.max = sMax.max = m.max_minutes;
  sMin.value = state.minTime;
  sMax.value = state.maxTime;
  sMin.oninput = () => {
    if (+sMin.value > +sMax.value) sMax.value = sMin.value;
    state.minTime = +sMin.value; state.maxTime = +sMax.value; render();
  };
  sMax.oninput = () => {
    if (+sMax.value < +sMin.value) sMin.value = sMax.value;
    state.minTime = +sMin.value; state.maxTime = +sMax.value; render();
  };
  buildChecks('changes', CHANGE_LABELS.slice(0, m.max_changes + 1).map((label, value) => ({value, label})),
    state.changes, render);
  buildChecks('modes', MODES.map(m => ({value: m.bit, label: m.label})), state.modes, render);

  if (m.dates.every(d => d < today))
    setStatus('Data is outdated: rerun scripts/build_reachability.py');
  loadReach();
}

init();
