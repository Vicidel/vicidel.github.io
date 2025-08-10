const LOCAL_ROADS = './data/lausanne_roads.geojson';
const ACTIVITIES_MANIFEST = './data/manifest.json';
const PASSWORD = 'mapsarecool';

let activeBaseLayer = null;
let roadLayer;  // Declare it globally if needed outside initMap()
let stravaLayerGroup = L.layerGroup();  // Layer group for Strava traces
const stravaLayers = {
  Cycling: L.layerGroup(),
  HikingWalking: L.layerGroup(),
  Running: L.layerGroup(),
  Other: L.layerGroup()
};
const layerRegistry = {};                 // global layer lookup
let stravaVisibilityInitialized = false;  // show all once on first dataset load

let allActivities = [];                           // currently loaded dataset
let currentDateRange = {start: null, end: null};  // Date objects
let dateRangeControl = null;                      // Leaflet control instance
const DAY_MS = 24 * 60 * 60 * 1000;


// ---------------------- DATE FILTER ---------------------- //

function parseActivityDate(a) {
  // Prefer local start date if present
  const iso = a.start_date_local || a.start_date;
  if (!iso) return null;
  // Keep only date portion to avoid TZ drift when converting to Date
  const ymd = iso.slice(0, 10);  // "YYYY-MM-DD"
  // Construct as UTC to keep slider math stable
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatYMD(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function clampDateToRange(date, minD, maxD) {
  if (date < minD) return new Date(minD.getTime());
  if (date > maxD) return new Date(maxD.getTime());
  return date;
}

function buildDateRangeControl(minDate, maxDate, onChange) {
  const Control = L.Control.extend({
    options: {position: 'topleft'},
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-bar');
      container.style.background = '#fff';
      container.style.padding = '8px 10px';
      container.style.minWidth = '220px';
      container.style.boxShadow = '0 1px 5px rgba(0,0,0,0.3)';
      container.style.borderRadius = '6px';
      container.title = 'Filter activities by date';

      const title = document.createElement('div');
      title.textContent = 'Date filter';
      title.style.fontWeight = '600';
      title.style.marginBottom = '6px';
      container.appendChild(title);

      const labels = document.createElement('div');
      labels.style.display = 'flex';
      labels.style.justifyContent = 'space-between';
      labels.style.fontSize = '12px';
      labels.style.marginBottom = '4px';
      const leftLbl = document.createElement('span');
      const rightLbl = document.createElement('span');
      labels.appendChild(leftLbl);
      labels.appendChild(rightLbl);
      container.appendChild(labels);

      // We use number inputs representing days since epoch (UTC) for stability
      const minDays = Math.floor(minDate.getTime() / DAY_MS);
      const maxDays = Math.floor(maxDate.getTime() / DAY_MS);

      const track = document.createElement('div');
      track.style.display = 'flex';
      track.style.gap = '6px';
      track.style.alignItems = 'center';

      const sliderMin = document.createElement('input');
      sliderMin.type = 'range';
      sliderMin.min = String(minDays);
      sliderMin.max = String(maxDays);
      sliderMin.step = '1';
      sliderMin.value = String(minDays);
      sliderMin.style.width = '100%';

      const sliderMax = document.createElement('input');
      sliderMax.type = 'range';
      sliderMax.min = String(minDays);
      sliderMax.max = String(maxDays);
      sliderMax.step = '1';
      sliderMax.value = String(maxDays);
      sliderMax.style.width = '100%';

      // Prevent map drag while interacting
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      function syncLabelsAndEmit() {
        const start = new Date(Number(sliderMin.value) * DAY_MS);
        const end = new Date(Number(sliderMax.value) * DAY_MS);
        leftLbl.textContent = formatYMD(start);
        rightLbl.textContent = formatYMD(end);
        onChange({start, end});
      }

      function ensureOrder(e) {
        // Keep min <= max by nudging the moved handle
        let vMin = Number(sliderMin.value);
        let vMax = Number(sliderMax.value);
        if (vMin > vMax) {
          if (e.target === sliderMin)
            sliderMax.value = String(vMin);
          else
            sliderMin.value = String(vMax);
        }
        syncLabelsAndEmit();
      }

      sliderMin.addEventListener('input', ensureOrder);
      sliderMax.addEventListener('input', ensureOrder);

      track.appendChild(sliderMin);
      track.appendChild(sliderMax);
      container.appendChild(track);

      // Initialize labels
      leftLbl.textContent = formatYMD(minDate);
      rightLbl.textContent = formatYMD(maxDate);

      // Expose a small API for updates when a new dataset loads
      container._updateRange = (newMin, newMax) => {
        const nMin = Math.floor(newMin.getTime() / DAY_MS);
        const nMax = Math.floor(newMax.getTime() / DAY_MS);
        sliderMin.min = sliderMax.min = String(nMin);
        sliderMin.max = sliderMax.max = String(nMax);
        sliderMin.value = String(nMin);
        sliderMax.value = String(nMax);
        syncLabelsAndEmit();
      };

      return container;
    }
  });
  return new Control();
}

function filterActivitiesByDate(activities, range) {
  const {start, end} = range;
  const s = start.getTime();
  const e = end.getTime();
  return activities.filter(a => {
    const d = parseActivityDate(a);
    if (!d) return false;
    const t = d.getTime();
    return t >= s && t <= e;
  });
}

// ---------------------- ACTIVITIES ---------------------- //

// function to load activities from file and show on map
async function loadAndShow(map, selectedFile) {
  const res = await fetch(selectedFile);
  const activities = await res.json();

  // Save all + compute date bounds
  allActivities = activities.slice();
  const dates = allActivities.map(parseActivityDate)
                    .filter(Boolean)
                    .sort((a, b) => a - b);

  const oldest = dates.length ? dates[0] : new Date();
  const todayUTC = new Date(Date.UTC(
      new Date().getUTCFullYear(), new Date().getUTCMonth(),
      new Date().getUTCDate()));

  // Set current range and (create or) update control
  currentDateRange.start = clampDateToRange(oldest, oldest, todayUTC);
  currentDateRange.end = clampDateToRange(todayUTC, oldest, todayUTC);

  // Show all Strava overlays once on first dataset load so users see data
  if (!stravaVisibilityInitialized) {
    Object.values(stravaLayers).forEach(layer => layer.addTo(map));
    stravaVisibilityInitialized = true;
  }

  if (!dateRangeControl) {
    dateRangeControl = buildDateRangeControl(
        currentDateRange.start, currentDateRange.end, (range) => {
          currentDateRange = range;
          drawActivities(
              map, filterActivitiesByDate(allActivities, currentDateRange));
        });
    dateRangeControl.addTo(map);
  } else {
    // Update existing control to new dataset bounds
    const container = dateRangeControl.getContainer();
    container._updateRange(currentDateRange.start, currentDateRange.end);
  }

  // Initial draw with full range
  drawActivities(map, filterActivitiesByDate(allActivities, currentDateRange));
}

// function to draw activities on map
function drawActivities(map, activities, filterType = null) {
  // Remember which Strava overlays are currently visible
  const wasVisible = {};
  Object.entries(stravaLayers).forEach(([key, layer]) => {
    wasVisible[key] = map.hasLayer(layer);
    layer.clearLayers();  // safe whether visible or not
  });

  // Plot them
  let skipped = 0;
  activities.forEach(activity => {
    const polylineStr = activity.map?.summary_polyline;
    if (!polylineStr || polylineStr.trim() === '') {
      skipped++;
      return;
    }
    let coords;
    try {
      coords = polyline.decode(polylineStr);
    } catch {
      skipped++;
      return;
    }
    if (!coords || coords.length === 0) {
      skipped++;
      return;
    }

    const latlngs = coords.map(([lat, lng]) => [lat, lng]);

    let group = 'Other';
    let color = 'purple';
    if (activity.type === 'Ride') {
      group = 'Cycling';
      color = 'blue';
    } else if (activity.type === 'Run') {
      group = 'Running';
      color = 'red';
    } else if (activity.type === 'Hike' || activity.type === 'Walk') {
      group = 'HikingWalking';
      color = 'green';
    }

    const polylineLayer = L.polyline(latlngs, {color, weight: 5, opacity: 0.7});

    const date =
        (activity.start_date_local || activity.start_date || '').slice(0, 10);
    const distance = (activity.distance / 1000).toFixed(2);
    const popupContent = `
      <b>${activity.name}</b><br>
      Date: ${date}<br>
      Type: ${activity.type}<br>
      Distance: ${distance} km<br>
      Elevation Gain: ${activity.total_elevation_gain} m<br>
      <a href="https://www.strava.com/activities/${
        activity.id}" target="_blank">View on Strava</a>
    `;
    polylineLayer.bindPopup(popupContent);

    stravaLayers[group].addLayer(polylineLayer);
  });

  if (skipped > 0) console.warn(`⚠️ Skipped ${skipped} activities`);

  // Re-apply visibility exactly as before (don’t force overlays back on)
  Object.entries(stravaLayers).forEach(([key, layer]) => {
    if (wasVisible[key]) {
      if (!map.hasLayer(layer)) layer.addTo(map);
    } else {
      if (map.hasLayer(layer)) map.removeLayer(layer);
    }
  });
}

// function to enable multiple datasets
async function populateDatasetSelector(map) {
  try {
    const response = await fetch(ACTIVITIES_MANIFEST);
    if (!response.ok) {
      console.error(`Failed to load manifest.json: ${response.status}`);
      return;
    }

    const datasets = await response.json();
    console.log('Loaded manifest:', datasets);

    const select = document.getElementById('dataset-select');
    select.innerHTML = '';

    datasets.forEach((filename, idx) => {
      const match = filename.match(/activities_(\d+)\.json/);
      if (!match) {
        console.warn(`Filename did not match expected format: ${filename}`);
        return;
      }

      const id = match[1];

      const option = document.createElement('option');
      option.value = filename;
      option.textContent = `Client ID: ${id}`;
      if (idx === 0) option.selected = true;
      select.appendChild(option);
    });

    if (select.value) {
      await loadAndShow(map, select.value);
      console.log(`✅ Loaded ${select.value}`);
    }

    select.addEventListener('change', async () => {
      const selectedFile = select.value;
      try {
        await loadAndShow(map, selectedFile);
        console.log(`✅ Loaded ${selectedFile}`);
      } catch (err) {
        console.error(`❌ Failed to load ${selectedFile}`, err);
      }
    });

  } catch (err) {
    console.error('❌ Failed to load or parse manifest.json:', err);
  }
}

// ---------------------- MAP ---------------------- //

// function to add the layer controls (width/opactity)
function addLayerControls(control) {
  // Delete sliders
  const container = control.getContainer();
  container.querySelectorAll('input.opacity-slider, input.linewidth-slider')
      .forEach(el => el.remove());

  // Set all labels
  const overlays =
      container.querySelectorAll('.leaflet-control-layers-overlays label');
  const bases =
      container.querySelectorAll('.leaflet-control-layers-base label');
  const allLabels = [...bases, ...overlays];

  // Browse all labels
  allLabels.forEach(label => {
    const text = label.textContent.trim().toLowerCase();
    let key = null;

    if (text.includes('world')) key = 'world';
    if (text.includes('topographic')) key = 'topo';
    if (text.includes('satellite')) key = 'satellite';
    if (text.includes('swisstlm3d')) key = 'wanderwege';
    if (text.includes('swissmobile hiking')) key = 'hiking';
    if (text.includes('swissmobile cycling')) key = 'cycling';
    if (text.includes('cycling activities')) key = 'stravaCycling';
    if (text.includes('hiking/walking activities')) key = 'stravaHikingWalking';
    if (text.includes('running activities')) key = 'stravaRunning';
    if (text.includes('other activities')) key = 'stravaOther';
    if (text.includes('lausanne')) key = 'roads';

    const layer = layerRegistry[key];
    if (!key || !layer) return;

    // Opacity slider
    const opacitySlider = document.createElement('input');
    opacitySlider.className = 'opacity-slider';
    opacitySlider.type = 'range';
    opacitySlider.min = 0;
    opacitySlider.max = 1;
    opacitySlider.step = 0.05;
    opacitySlider.value = 0.7;
    opacitySlider.style.marginLeft = '8px';
    opacitySlider.style.width = '70px';
    opacitySlider.title = 'Opacity';
    opacitySlider.addEventListener('input', () => {
      const value = parseFloat(opacitySlider.value);
      if (typeof layer.setOpacity === 'function') {
        layer.setOpacity(value);
      } else if (layer.eachLayer) {
        layer.eachLayer(l => {
          if (typeof l.setStyle === 'function') {
            l.setStyle({opacity: value, fillOpacity: value});
          }
        });
      }
    });
    label.appendChild(opacitySlider);

    // Line width slider (only for strava and roads)
    const supportsLineWidth = key.startsWith('strava') || key === 'roads';
    if (supportsLineWidth) {
      const widthSlider = document.createElement('input');
      widthSlider.className = 'linewidth-slider';
      widthSlider.type = 'range';
      widthSlider.min = 1;
      widthSlider.max = 10;
      widthSlider.step = 1;
      widthSlider.value = 6;
      widthSlider.style.marginLeft = '6px';
      widthSlider.style.width = '60px';
      widthSlider.title = 'Line Width';
      widthSlider.addEventListener('input', () => {
        const weight = parseInt(widthSlider.value);
        if (layer.eachLayer) {
          layer.eachLayer(l => {
            if (typeof l.setStyle === 'function') {
              l.setStyle({weight});
            }
          });
        } else if (typeof layer.setStyle === 'function') {
          layer.setStyle({weight});
        }
      });
      label.appendChild(widthSlider);
    }
  });
}

// function to init the map
function initMap() {
  const map = L.map('map').setView([46.5, 6.6], 10);
  map.createPane('roadsPane');
  map.getPane('roadsPane').style.zIndex = 390;

  const topo = L.tileLayer(
      'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg',
      {attribution: '© Swisstopo', maxZoom: 18});

  const world = L.tileLayer(
      ' https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      {attribution: '© OpenStreetMap contributors', maxZoom: 19});

  const satellite = L.tileLayer(
      ' https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {attribution: '© Esri', maxZoom: 18});

  const hiking = L.tileLayer(
      'https://wmts.geo.admin.ch/1.0.0/ch.astra.wanderland/default/current/3857/{z}/{x}/{y}.png',
      {opacity: 0.7});

  const cycling = L.tileLayer(
      'https://wmts.geo.admin.ch/1.0.0/ch.astra.veloland/default/current/3857/{z}/{x}/{y}.png',
      {opacity: 0.7});

  const wanderwege = L.tileLayer(
      'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swisstlm3d-wanderwege/default/current/3857/{z}/{x}/{y}.png',
      {opacity: 0.7, attribution: '© Swisstopo', maxZoom: 18});

  roadLayer = L.geoJSON(
      null,
      {pane: 'roadsPane', style: {color: 'black', weight: 5, opacity: 0.7}});

  // Add to registry
  layerRegistry.topo = topo;
  layerRegistry.world = world;
  layerRegistry.satellite = satellite;
  layerRegistry.hiking = hiking;
  layerRegistry.cycling = cycling;
  layerRegistry.wanderwege = wanderwege;
  layerRegistry.stravaCycling = stravaLayers.Cycling;
  layerRegistry.stravaHikingWalking = stravaLayers.HikingWalking;
  layerRegistry.stravaRunning = stravaLayers.Running;
  layerRegistry.stravaOther = stravaLayers.Other;
  layerRegistry.roads = roadLayer;

  // Set base map and default
  const baseMaps = {
    'Topographic (CH)': topo,
    'World': world,
    'Satellite': satellite
  };
  topo.addTo(map);
  activeBaseLayer = topo;

  // Set overlays
  const overlayMaps = {
    'SwissMobile Hiking': hiking,
    'SwissMobile Cycling': cycling,
    'SwissTLM3D Hiking Trails': wanderwege,
    'Cycling Activities': stravaLayers.Cycling,
    'Hiking/Walking Activities': stravaLayers.HikingWalking,
    'Running Activities': stravaLayers.Running,
    'Other Activities': stravaLayers.Other,
    'Lausanne Roads': roadLayer
  };

  // Define controls
  const control = L.control.layers(baseMaps, overlayMaps).addTo(map);
  const originalUpdate = control._update;
  control._update = function() {
    originalUpdate.call(this);
    setTimeout(() => addLayerControls(control), 0);
  };

  // Define change of base map
  map.on('baselayerchange', function(e) {
    activeBaseLayer = e.layer;
    console.log('Base layer changed to:', e.name);
  });

  return map;
}

// ---------------------- DOC MAIN FUNCTIONS ---------------------- //

// function to unprotect upon correct password
document.addEventListener('DOMContentLoaded', () => {
  const authContainer = document.getElementById('auth-container');
  const protectedContent = document.getElementById('protected');
  const submitBtn = document.getElementById('password-submit');
  const input = document.getElementById('password-input');
  const errorMsg = document.getElementById('error-msg');

  submitBtn.addEventListener('click', () => {
    const entered = input.value;
    if (entered === PASSWORD) {
      authContainer.style.display = 'none';
      protectedContent.style.display = 'block';
      setTimeout(() => {
        if (window._leafletMapInstance) {
          window._leafletMapInstance.invalidateSize();
        }
      }, 100);
    } else {
      errorMsg.style.display = 'block';
    }
  });
});

// main function
(async function main() {
  // init the map
  const map = initMap();
  window._leafletMapInstance = map;

  // enable the dataset selector
  await populateDatasetSelector(map);

  try {
    // Add roads
    const res2 = await fetch(LOCAL_ROADS);
    console.log('Fetched local roads:', res2);
    if (res2.ok) {
      const data = await res2.json();
      roadLayer.addData(data);
      console.log('✅ Loaded Lausanne roads');
    } else {
      console.error('❌ Failed to load roads, status:', res2.status);
    }
  } catch (e) {
    console.log('❌ Fetch failed:', e);
  }
})();