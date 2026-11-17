// Transit Reach: where can I go from Lausanne within X minutes by train/bus?
// Data: data/reach_<origin>.json built by scripts/build_reachability.py

const WMTS = (layer, ext = 'png') =>
  `https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/3857/{z}/{x}/{y}.${ext}`;

const CHANGE_LABELS = ['Direct', '1', '2', '3', '4'];
const MODES = [  // bit values must match MODE_BITS in the python script
  {key: 'rail', bit: 1, label: 'Train', on: true},
  {key: 'bus', bit: 2, label: 'Bus', on: true},
  {key: 'metro', bit: 4, label: 'Metro', on: true},
  {key: 'tram', bit: 8, label: 'Tram', on: true},
  {key: 'boat', bit: 16, label: 'Boat', on: true},
  {key: 'cable', bit: 32, label: 'Cable car', on: true},
];

const state = {
  origin: 'gare',
  maxTime: 90,
  changes: new Set([0, 1, 2]),
  modes: new Set(MODES.filter(m => m.on).map(m => m.bit)),
  data: {},      // origin -> {meta, stops}
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

// ------------------------------------------------------------- controls --- //

function buildChecks(containerId, items, set, onChange) {
  const el = document.getElementById(containerId);
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

function buildChangeChecks(maxChanges) {
  const items = CHANGE_LABELS.slice(0, maxChanges + 1).map((label, value) => ({value, label}));
  buildChecks('changes', items, state.changes, render);
}

buildChecks('modes', MODES.map(m => ({value: m.bit, label: m.label})), state.modes, render);

const slider = document.getElementById('maxtime');
const sliderLbl = document.getElementById('maxtime-lbl');
slider.value = state.maxTime;
slider.addEventListener('input', () => { state.maxTime = +slider.value; render(); });

const originSel = document.getElementById('origin');
originSel.value = state.origin;
originSel.addEventListener('change', () => { state.origin = originSel.value; loadOrigin(); });

// --------------------------------------------------------------- helpers --- //

const fmtMin = m => m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;

function colorFor(minutes, max) {
  const f = Math.min(1, minutes / max);
  return `hsl(${Math.round(120 * (1 - f))}, 85%, 42%)`;
}

// Station id for transport.opendata.ch (Swiss stop numbers are 85xxxxx)
function apiId(stop) {
  const m = String(stop.id).match(/85\d{5}/);
  return m ? m[0] : stop.n;
}

// Smallest number of changes that fits in the time budget (or null)
function minChanges(stop) {
  for (let k = 0; k < stop.d.length; k++)
    if (stop.d[k] != null && stop.d[k] <= state.maxTime) return k;
  return null;
}

function renderLegend() {
  const el = document.getElementById('legend');
  el.style.background = 'linear-gradient(to right, hsl(120,85%,42%), hsl(60,85%,42%), hsl(0,85%,42%))';
  el.innerHTML = `<span style="left:0">0</span>
    <span style="left:45%">${fmtMin(Math.round(state.maxTime / 2))}</span>
    <span style="right:0">${fmtMin(state.maxTime)}</span>`;
}

// --------------------------------------------------------------- render --- //

function render() {
  sliderLbl.textContent = fmtMin(state.maxTime);
  renderLegend();
  reachLayer.clearLayers();
  const data = state.data[state.origin];
  if (!data) return;

  const modeMask = [...state.modes].reduce((a, b) => a | b, 0);
  let count = 0;
  for (const s of data.stops) {
    if (!(s.m & modeMask)) continue;
    const k = minChanges(s);
    if (k == null || !state.changes.has(k)) continue;
    const isRail = s.m & 1;
    L.circleMarker([s.lat, s.lon], {
      radius: isRail ? 6 : 4,
      weight: isRail ? 1.5 : 0.5,
      color: '#222',
      fillColor: colorFor(s.d[k], state.maxTime),
      fillOpacity: 0.9,
    }).bindPopup(() => popupHtml(s, data.meta), {maxWidth: 320})
      .on('popupopen', e => attachConnButton(e.popup, s, data.meta))
      .addTo(reachLayer);
    count++;
  }
  const m = data.meta;
  document.getElementById('status').textContent =
    `${count} stops · ${m.date}, dep ${m.window} (every ${m.step_min} min)`;
}

function popupHtml(s, meta) {
  const rows = s.d.map((d, k) => d == null ? '' :
    `<tr><td>${k === 0 ? 'Direct' : k + ' change' + (k > 1 ? 's' : '')}</td>
     <td><b>${fmtMin(d)}</b></td><td>dep ${s.t[k]}</td></tr>`).join('');
  const search = `https://search.ch/fahrplan/?from=${encodeURIComponent(meta.origin_stops[0])}&to=${encodeURIComponent(s.n)}`;
  return `<div class="popup"><b>${s.n}</b>
    <table><tr><th>Changes</th><th>Fastest</th><th>Sample</th></tr>${rows}</table>
    <button class="conn-btn">Next connections</button>
    <a href="${search}" target="_blank" rel="noopener">search.ch</a>
    <div class="conns"></div></div>`;
}

function attachConnButton(popup, s, meta) {
  const root = popup.getElement();
  const btn = root.querySelector('.conn-btn');
  const out = root.querySelector('.conns');
  btn.onclick = async () => {
    out.textContent = 'Loading...';
    try {
      const from = meta.origin_stops[0];
      const url = `https://transport.opendata.ch/v1/connections?from=${encodeURIComponent(from)}` +
        `&to=${encodeURIComponent(apiId(s))}&limit=4`;
      const res = await fetch(url);
      const json = await res.json();
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

// ----------------------------------------------------------------- load --- //

async function loadOrigin() {
  const key = state.origin;
  if (!state.data[key]) {
    document.getElementById('status').textContent = 'Loading...';
    try {
      const res = await fetch(`data/reach_${key}.json`);
      if (!res.ok) throw new Error(res.status);
      state.data[key] = await res.json();
    } catch (e) {
      document.getElementById('status').textContent =
        `No data for "${key}" (data/reach_${key}.json). Run scripts/build_reachability.py.`;
      return;
    }
  }
  buildChangeChecks(state.data[key].meta.max_changes);
  render();
}

loadOrigin();
