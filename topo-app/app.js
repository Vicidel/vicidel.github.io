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
const layerRegistry = {};  // global layer lookup

function initMap() {
  console.log('init map')
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

  roadLayer = L.geoJSON(
      null,
      {pane: 'roadsPane', style: {color: 'purple', weight: 2, opacity: 0.6}});

  // Add to registry
  layerRegistry.topo = topo;
  layerRegistry.world = world;
  layerRegistry.satellite = satellite;
  layerRegistry.hiking = hiking;
  layerRegistry.cycling = cycling;
  layerRegistry.stravaCycling = stravaLayers.Cycling;
  layerRegistry.stravaHikingWalking = stravaLayers.HikingWalking;
  layerRegistry.stravaRunning = stravaLayers.Running;
  layerRegistry.stravaOther = stravaLayers.Other;
  layerRegistry.roads = roadLayer;

  topo.addTo(map);
  activeBaseLayer = topo;

  const baseMaps = {
    'Topographic (CH)': topo,
    'World': world,
    'Satellite': satellite
  };

  const overlayMaps = {
    'SwissMobile Hiking': hiking,
    'SwissMobile Cycling': cycling,
    'Cycling Activities': stravaLayers.Cycling,
    'Hiking/Walking Activities': stravaLayers.HikingWalking,
    'Running Activities': stravaLayers.Running,
    'Other Activities': stravaLayers.Other,
    'Lausanne Roads': roadLayer
  };

  const control = L.control.layers(baseMaps, overlayMaps).addTo(map);
  const originalUpdate = control._update;
  control._update = function() {
    originalUpdate.call(this);
    setTimeout(() => addOpacitySliders(control), 0);
  };

  map.on('baselayerchange', function(e) {
    activeBaseLayer = e.layer;
    console.log('Base layer changed to:', e.name);
  });

  return map;
}

function addOpacitySliders(control) {
  const container = control.getContainer();

  // Remove previously injected sliders to avoid duplicates
  container.querySelectorAll('input[type="range"].opacity-slider')
      .forEach(el => el.remove());

  const overlays =
      container.querySelectorAll('.leaflet-control-layers-overlays label');
  const bases =
      container.querySelectorAll('.leaflet-control-layers-base label');
  const allLabels = [...bases, ...overlays];

  allLabels.forEach(label => {
    const text = label.textContent.trim().toLowerCase();
    let key = null;

    if (text.includes('world')) key = 'world';
    if (text.includes('topographic')) key = 'topo';
    if (text.includes('satellite')) key = 'satellite';
    if (text.includes('swissmobile hiking')) key = 'hiking';
    if (text.includes('swissmobile cycling')) key = 'cycling';
    if (text.includes('cycling activities')) key = 'stravaCycling';
    if (text.includes('hiking/walking activities')) key = 'stravaHikingWalking';
    if (text.includes('running activities')) key = 'stravaRunning';
    if (text.includes('other activities')) key = 'stravaOther';
    if (text.includes('lausanne')) key = 'roads';

    const layer = layerRegistry[key];
    if (!key || !layer) return;

    const slider = document.createElement('input');
    slider.className = 'opacity-slider';
    slider.type = 'range';
    slider.min = 0;
    slider.max = 1;
    slider.step = 0.05;
    slider.value = 1.0;
    slider.style.marginLeft = '8px';
    slider.style.width = '70px';

    slider.addEventListener('input', () => {
      const value = parseFloat(slider.value);

      if (typeof layer.setOpacity === 'function') {
        if (layer === activeBaseLayer) {
          layer.setOpacity(value);
        }
      } else if (layer.eachLayer) {
        layer.eachLayer(l => {
          if (typeof l.setStyle === 'function') {
            l.setStyle({opacity: value, fillOpacity: value});
          }
        });
      }
    });

    label.appendChild(slider);
  });
}

function drawActivities(map, activities, filterType = null) {
  // Clear old
  Object.values(stravaLayers).forEach(layer => layer.clearLayers());

  // Group by type
  const groups = {Cycling: [], HikingWalking: [], Running: [], Other: []};

  // Plot them
  let skipped = 0;
  activities.forEach(activity => {
    const polylineStr = activity.map?.summary_polyline;
    if (!polylineStr || polylineStr.trim() === '') {
      console.warn(
          `⛔ Skipping "${activity.name}" (ID: ${activity.id}) – no polyline`);
      skipped++;
      return;
    }
    let coords;
    try {
      coords = polyline.decode(polylineStr);
    } catch (e) {
      console.warn(`Skipping bad polyline for activity "${activity.name}"`);
      return;
    }
    if (!coords || coords.length === 0) return;
    const latlngs = coords.map(([lat, lng]) => [lat, lng]);

    let group = 'Other';
    let color = 'orange';
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

    const polylineLayer =
        L.polyline(latlngs, {color: color, weight: 3, opacity: 0.8});

    const popupContent = `
        <b>${activity.name}</b><br>
        Type: ${activity.type}<br>
        Distance: ${activity.distance} m<br>
        Elevation Gain: ${activity.total_elevation_gain} m<br>
        <a href="https://www.strava.com/activities/${
        activity.id}" target="_blank">
          View on Strava
        </a>
      `;
    polylineLayer.bindPopup(popupContent);

    stravaLayers[group].addLayer(polylineLayer);
  });
  if (skipped > 0) {
    console.log(`⚠️ Skipped ${skipped} activities with no geometry`);
  }

  // Add all to map initially
  Object.values(stravaLayers).forEach(layer => layer.addTo(map));
}

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
      console.log('Auto-loading first dataset:', select.value);
      const res = await fetch(select.value);
      const activities = await res.json();
      drawActivities(map, activities);
    }

    select.addEventListener('change', async () => {
      const selectedFile = select.value;
      try {
        const res = await fetch(selectedFile);
        const activities = await res.json();
        drawActivities(map, activities);
        console.log(`✅ Loaded ${selectedFile}`);
      } catch (err) {
        console.error(`❌ Failed to load ${selectedFile}`, err);
      }
    });

  } catch (err) {
    console.error('Failed to load or parse manifest.json:', err);
  }
}

document.getElementById('line-width').addEventListener('input', e => {
  const newWeight = parseInt(e.target.value);
  Object.values(stravaLayers).forEach(group => {
    group.eachLayer(layer => {
      if (typeof layer.setStyle === 'function') {
        layer.setStyle({weight: newWeight});
      }
    });
  });
  roadLayer.setStyle({weight: newWeight});
});

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


(async function main() {
  const map = initMap();
  window._leafletMapInstance = map;

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