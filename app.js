/* ══════════════════════════════════════════════════
   Puntos negros en tu ruta | DGT 2016–2024
   ══════════════════════════════════════════════════ */

const DATA_FILE = 'data/accidentes_puntos.json';
const CELL      = 0.02; // ~2 km, tamaño de celda del índice espacial
const STEP_KM   = 0.2;  // muestreo de la ruta cada 200 m

const MESES = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const DIAS  = ['','Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

// Índices dentro de cada fila de PUNTOS:
// [lon, lat, anyo, mes, dia_semana, hora, muertos24h, graves24h, leves24h, carreteraIdx, km]
const F = { LON: 0, LAT: 1, ANYO: 2, MES: 3, DIA: 4, HORA: 5, MU: 6, HG: 7, HL: 8, CARR: 9, KM: 10 };

let PUNTOS = null;
let CARRETERAS = null;
let PROVINCIAS = null;
let grid = new Map();
let popup = null;
let markerOrigen = null;
let markerDestino = null;
let mostrandoResto = false;
let restoDisponible = false;
let map;
let usandoBasemapRaster = false;

const muColor = [
  'interpolate', ['linear'], ['get', 'muertos'],
  0, '#fecaca',
  1, '#f87171',
  2, '#ef4444',
  3, '#b91c1c',
  5, '#7f1d1d',
];

/* ── Mapa ──
   Se usa el estilo vectorial de CARTO (gratis, sin API key) en vez del raster
   para poder forzar las etiquetas en el idioma local: ese estilo usa "name_en"
   (inglés) en las etiquetas de país/región/ciudad a bajo zoom por defecto — se
   sustituye por "name" (nombre local, español en España) antes de cargarlo. */
const CARTO_STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

async function cargarEstiloBasemap() {
  try {
    const raw = await fetch(CARTO_STYLE_URL).then(r => r.text());
    return JSON.parse(raw.replaceAll('name_en', 'name'));
  } catch (err) {
    console.error('No se pudo cargar el basemap vectorial, uso raster de reserva:', err);
    usandoBasemapRaster = true;
    return { version: 8, sources: {}, layers: [] };
  }
}

cargarEstiloBasemap().then(style => {
  map = new maplibregl.Map({
    container: 'map',
    style,
    center: [-7.4, 35.7],
    zoom: 4,
    minZoom: 3.5,
    maxBounds: [[-32, 20], [15, 60]],
    antialias: true,
  });

  map.on('load', () => { try {

  // Encaja España peninsular + Canarias en la vista inicial
  // (padding izquierdo extra para que el panel de búsqueda no las tape)
  map.fitBounds([[-18.5, 27.3], [4.5, 43.9]], {
    padding: { top: 70, bottom: 70, left: 370, right: 70 },
    duration: 0,
  });

  if (usandoBasemapRaster) {
    map.addSource('basemap', {
      type: 'raster',
      tiles: ['https://cartodb-basemaps-a.global.ssl.fastly.net/light_all/{z}/{x}/{y}{r}.png'],
      tileSize: 256,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    });
    map.addLayer({ id: 'basemap', type: 'raster', source: 'basemap' });
  }

  map.addSource('provincias', { type: 'geojson', data: 'data/spain_provincias.geojson' });
  map.addLayer({
    id: 'provincias-linea',
    type: 'line',
    source: 'provincias',
    paint: { 'line-color': '#aaaaaa', 'line-width': 0.75 },
  });

  map.addSource('ruta', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    attribution: 'Rutas: <a href="http://project-osrm.org">OSRM</a>',
  });
  map.addLayer({
    id: 'ruta-line',
    type: 'line',
    source: 'ruta',
    paint: { 'line-color': '#01f3b3', 'line-width': 4, 'line-opacity': 0.85 },
  });

  // Resto de accidentes (sin fallecidos) — oculto por defecto, se revela desde el popup
  map.addSource('accidentes-ruta-resto', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'accidentes-ruta-resto-circle',
    type: 'circle',
    source: 'accidentes-ruta-resto',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2, 8, 3, 12, 5, 16, 8],
      'circle-color': '#a8a29e',
      'circle-opacity': 0.6,
      'circle-stroke-width': 0.5,
      'circle-stroke-color': '#000000',
      'circle-stroke-opacity': 0.3,
    },
  });

  map.addSource('accidentes-ruta', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'accidentes-ruta-circle',
    type: 'circle',
    source: 'accidentes-ruta',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 8, 5, 12, 8, 16, 13],
      'circle-color': muColor,
      'circle-opacity': 0.9,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#000000',
      'circle-stroke-opacity': 0.4,
    },
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  const onClickPunto = e => {
    const feat = e.features?.[0];
    if (feat) renderPopup(e.lngLat, feat.properties);
  };
  map.on('click', 'accidentes-ruta-circle', onClickPunto);
  map.on('click', 'accidentes-ruta-resto-circle', onClickPunto);
  map.on('mouseenter', 'accidentes-ruta-circle', () => map.getCanvas().style.cursor = 'pointer');
  map.on('mouseleave', 'accidentes-ruta-circle', () => map.getCanvas().style.cursor = modoSeleccion ? 'crosshair' : '');
  map.on('mouseenter', 'accidentes-ruta-resto-circle', () => map.getCanvas().style.cursor = 'pointer');
  map.on('mouseleave', 'accidentes-ruta-resto-circle', () => map.getCanvas().style.cursor = modoSeleccion ? 'crosshair' : '');

  map.on('click', e => {
    if (modoSeleccion) seleccionarUbicacionEnMapa(e.lngLat, modoSeleccion);
  });

  } catch (err) {
    console.error('Error inicializando el mapa:', err);
  }});
});

/* ══════════════════════════════════════════
   Carga de datos + índice espacial
   ══════════════════════════════════════════ */
Promise.all([
  fetch(DATA_FILE).then(r => r.json()),
  fetch('data/spain_provincias.geojson').then(r => r.json()),
])
  .then(([puntosData, provinciasData]) => {
    PUNTOS = puntosData.puntos;
    CARRETERAS = puntosData.carreteras;
    PROVINCIAS = provinciasData;
    buildGrid();
    document.getElementById('loading-overlay').classList.add('hidden');
  })
  .catch(err => {
    console.error('Error cargando datos:', err);
    document.querySelector('#loading-overlay .loading-box').textContent = 'Error cargando datos';
  });

/** Comprueba si un punto cae dentro de alguna provincia española (con datos disponibles). */
function dentroDeEspana(lon, lat) {
  if (!PROVINCIAS) return true; // aún cargando: no bloquear
  const pt = turf.point([lon, lat]);
  return PROVINCIAS.features.some(f => turf.booleanPointInPolygon(pt, f));
}

function buildGrid() {
  grid = new Map();
  for (let i = 0; i < PUNTOS.length; i++) {
    const key = cellKey(PUNTOS[i][F.LON], PUNTOS[i][F.LAT]);
    let arr = grid.get(key);
    if (!arr) { arr = []; grid.set(key, arr); }
    arr.push(i);
  }
}

function cellKey(lon, lat) {
  return `${Math.floor(lon / CELL)}_${Math.floor(lat / CELL)}`;
}

/* ══════════════════════════════════════════
   Autocompletado de direcciones (Nominatim)
   ══════════════════════════════════════════ */
class AutocompleteInput {
  constructor(input, results) {
    this.input = input;
    this.results = results;
    this.selected = null;
    this._timer = null;

    this.input.addEventListener('input', () => {
      this.selected = null;
      clearTimeout(this._timer);
      const q = this.input.value.trim();
      if (q.length < 3) { this._hide(); return; }
      this._timer = setTimeout(() => this._search(q), 350);
    });
    this.input.addEventListener('keydown', e => { if (e.key === 'Escape') this._hide(); });
    document.addEventListener('click', e => {
      if (!this.input.contains(e.target) && !this.results.contains(e.target)) this._hide();
    });
  }

  async _search(q) {
    try {
      const data = await this._buscar(q, 5);
      this._render(data);
    } catch { /* sin red */ }
  }

  _buscar(q, limit) {
    return fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=${limit}&accept-language=es&countrycodes=es`
    ).then(r => r.json());
  }

  _render(items) {
    this.results.innerHTML = '';
    if (!items.length) {
      const el = document.createElement('div');
      el.className = 'ac-item ac-empty';
      el.textContent = 'Sin resultados';
      this.results.appendChild(el);
    } else {
      items.forEach(item => {
        const el = document.createElement('div');
        el.className = 'ac-item';
        el.textContent = item.display_name;
        el.addEventListener('click', () => {
          this.input.value = item.display_name;
          this.selected = { lat: parseFloat(item.lat), lon: parseFloat(item.lon), label: item.display_name };
          this._hide();
        });
        this.results.appendChild(el);
      });
    }
    this.results.hidden = false;
  }

  _hide() { this.results.hidden = true; }

  /** Devuelve las coordenadas seleccionadas, o resuelve el texto libre si el usuario no eligió sugerencia. */
  async resolve() {
    if (this.selected) return this.selected;
    const q = this.input.value.trim();
    if (!q) return null;
    const data = await this._buscar(q, 1);
    if (!data.length) return null;
    this.selected = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), label: data[0].display_name };
    return this.selected;
  }
}

const origenInput  = new AutocompleteInput(document.getElementById('input-origen'), document.getElementById('results-origen'));
const destinoInput = new AutocompleteInput(document.getElementById('input-destino'), document.getElementById('results-destino'));

/* ══════════════════════════════════════════
   Elegir origen/destino haciendo click en el mapa
   ══════════════════════════════════════════ */
let modoSeleccion = null; // null | 'origen' | 'destino'

document.getElementById('btn-pin-origen').addEventListener('click', () => toggleModoSeleccion('origen'));
document.getElementById('btn-pin-destino').addEventListener('click', () => toggleModoSeleccion('destino'));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modoSeleccion) desactivarModoSeleccion(); });

function toggleModoSeleccion(campo) {
  modoSeleccion = modoSeleccion === campo ? null : campo;
  actualizarUISeleccion();
}

function desactivarModoSeleccion() {
  modoSeleccion = null;
  actualizarUISeleccion();
}

function actualizarUISeleccion() {
  document.getElementById('btn-pin-origen').classList.toggle('activo', modoSeleccion === 'origen');
  document.getElementById('btn-pin-destino').classList.toggle('activo', modoSeleccion === 'destino');

  const hint = document.getElementById('modo-seleccion-hint');
  hint.hidden = !modoSeleccion;
  if (modoSeleccion) hint.textContent = `Haz click en el mapa para fijar el ${modoSeleccion}`;

  if (map) map.getCanvas().style.cursor = modoSeleccion ? 'crosshair' : '';
}

function colocarMarcador(campo, lat, lon) {
  const color = '#017a5a';
  if (campo === 'origen') {
    markerOrigen?.remove();
    markerOrigen = new maplibregl.Marker({ color }).setLngLat([lon, lat]).addTo(map);
  } else {
    markerDestino?.remove();
    markerDestino = new maplibregl.Marker({ color }).setLngLat([lon, lat]).addTo(map);
  }
}

async function seleccionarUbicacionEnMapa(lngLat, campo) {
  if (!dentroDeEspana(lngLat.lng, lngLat.lat)) {
    showError('Prueba a seleccionar un punto dentro de España');
    return; // se queda en modo selección para que pueda volver a intentarlo
  }
  hideError();

  const input = campo === 'origen' ? origenInput : destinoInput;
  const coordLabel = `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;

  input.selected = { lat: lngLat.lat, lon: lngLat.lng, label: coordLabel };
  input.input.value = coordLabel;
  input._hide();
  desactivarModoSeleccion();
  colocarMarcador(campo, lngLat.lat, lngLat.lng);

  try {
    const data = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lngLat.lat}&lon=${lngLat.lng}&format=json&accept-language=es`
    ).then(r => r.json());
    if (data?.display_name) {
      input.selected.label = data.display_name;
      input.input.value = data.display_name;
    }
  } catch { /* sin red: nos quedamos con las coordenadas */ }
}

/* ══════════════════════════════════════════
   Cálculo de ruta (OSRM) + filtrado de accidentes
   ══════════════════════════════════════════ */
document.getElementById('btn-buscar').addEventListener('click', buscarRuta);
document.getElementById('btn-cerrar-resultados').addEventListener('click', () => {
  document.getElementById('resultados-panel').hidden = true;
});
document.getElementById('btn-toggle-resto').addEventListener('click', toggleResto);
document.getElementById('btn-limpiar').addEventListener('click', limpiarRuta);
document.getElementById('btn-editar-busqueda').addEventListener('click', expandirBusqueda);

function colapsarBusqueda(origen, destino) {
  const corto = label => label.split(',')[0].trim();
  document.getElementById('search-summary-text').textContent = `${corto(origen.label)} → ${corto(destino.label)}`;
  document.getElementById('search-panel').classList.add('collapsed');
}

function expandirBusqueda() {
  document.getElementById('search-panel').classList.remove('collapsed');
}

function limpiarRuta() {
  hideError();
  desactivarModoSeleccion();
  expandirBusqueda();
  if (!map) return;

  [origenInput, destinoInput].forEach(input => {
    input.input.value = '';
    input.selected = null;
    input._hide();
  });

  markerOrigen?.remove();
  markerDestino?.remove();
  markerOrigen = null;
  markerDestino = null;

  map.getSource('ruta')?.setData({ type: 'FeatureCollection', features: [] });
  map.getSource('accidentes-ruta')?.setData({ type: 'FeatureCollection', features: [] });
  map.getSource('accidentes-ruta-resto')?.setData({ type: 'FeatureCollection', features: [] });

  mostrandoResto = false;
  restoDisponible = false;
  if (map.getLayer('accidentes-ruta-resto-circle')) {
    map.setLayoutProperty('accidentes-ruta-resto-circle', 'visibility', 'none');
  }

  document.getElementById('resultados-panel').hidden = true;
}

async function buscarRuta() {
  hideError();

  if (!PUNTOS) { showError('El histórico de accidentes aún se está cargando…'); return; }
  if (!map || !map.getSource('ruta')) { showError('El mapa aún se está cargando…'); return; }

  setLoadingBtn(true);
  try {
    const [origen, destino] = await Promise.all([origenInput.resolve(), destinoInput.resolve()]);
    if (!origen)  { showError('No se ha encontrado el origen.'); return; }
    if (!destino) { showError('No se ha encontrado el destino.'); return; }
    if (!dentroDeEspana(origen.lon, origen.lat))   { showError('El origen está fuera de España. No hay datos de accidentes ahí.'); return; }
    if (!dentroDeEspana(destino.lon, destino.lat)) { showError('El destino está fuera de España. No hay datos de accidentes ahí.'); return; }

    const ruta = await fetchRuta(origen, destino);
    if (!ruta) { showError('No se ha podido calcular una ruta entre esos puntos.'); return; }

    dibujarRuta(ruta, origen, destino);

    const bufferKm = parseInt(document.getElementById('select-buffer').value, 10) / 1000;
    const filtrados = filtrarAccidentes(ruta.coordinates, bufferKm);
    const fatales = filtrados.filter(p => p[F.MU] > 0);
    const resto = filtrados.filter(p => p[F.MU] === 0);

    mostrandoResto = false;
    restoDisponible = resto.length > 0;
    map.setLayoutProperty('accidentes-ruta-resto-circle', 'visibility', 'none');

    renderPuntos(fatales, resto);
    mostrarResultados(ruta, filtrados);
    colapsarBusqueda(origen, destino);
  } catch (err) {
    console.error(err);
    showError('Ha ocurrido un error al calcular la ruta.');
  } finally {
    setLoadingBtn(false);
  }
}

async function fetchRuta(origen, destino) {
  const url = `https://router.project-osrm.org/route/v1/driving/${origen.lon},${origen.lat};${destino.lon},${destino.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.code !== 'Ok' || !json.routes?.length) return null;
  const route = json.routes[0];
  return {
    coordinates: route.geometry.coordinates,
    distanciaKm: route.distance / 1000,
    duracionMin: route.duration / 60,
  };
}

function dibujarRuta(ruta, origen, destino) {
  map.getSource('ruta').setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ruta.coordinates } }],
  });

  colocarMarcador('origen', origen.lat, origen.lon);
  colocarMarcador('destino', destino.lat, destino.lon);

  const bounds = ruta.coordinates.reduce(
    (b, c) => b.extend(c),
    new maplibregl.LngLatBounds(ruta.coordinates[0], ruta.coordinates[0])
  );
  map.fitBounds(bounds, { padding: 70, duration: 1000 });
}

function filtrarAccidentes(routeCoords, bufferKm) {
  const line = turf.lineString(routeCoords);
  const lengthKm = turf.length(line, { units: 'kilometers' });

  const candidatos = new Set();
  for (let d = 0; d <= lengthKm; d += STEP_KM) {
    const [lon, lat] = turf.along(line, d, { units: 'kilometers' }).geometry.coordinates;
    const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get(`${cx + dx}_${cy + dy}`);
        if (arr) for (const i of arr) candidatos.add(i);
      }
    }
  }

  const simplificada = turf.simplify(line, { tolerance: 0.0015, highQuality: false });
  const resultado = [];
  candidatos.forEach(i => {
    const p = PUNTOS[i];
    const dist = turf.pointToLineDistance(turf.point([p[F.LON], p[F.LAT]]), simplificada, { units: 'kilometers' });
    if (dist <= bufferKm) resultado.push(p);
  });
  return resultado;
}

function renderPuntos(fatales, resto) {
  const toFeatures = puntos => puntos.map(p => ({
    type: 'Feature',
    properties: {
      anyo: p[F.ANYO], mes: p[F.MES], dia_semana: p[F.DIA], hora: p[F.HORA],
      muertos: p[F.MU], graves: p[F.HG], leves: p[F.HL],
      carretera: CARRETERAS[p[F.CARR]], km: p[F.KM],
    },
    geometry: { type: 'Point', coordinates: [p[F.LON], p[F.LAT]] },
  }));
  map.getSource('accidentes-ruta').setData({ type: 'FeatureCollection', features: toFeatures(fatales) });
  map.getSource('accidentes-ruta-resto').setData({ type: 'FeatureCollection', features: toFeatures(resto) });
}

function toggleResto() {
  mostrandoResto = !mostrandoResto;
  map.setLayoutProperty('accidentes-ruta-resto-circle', 'visibility', mostrandoResto ? 'visible' : 'none');
  actualizarBotonResto();
}

function actualizarBotonResto() {
  document.getElementById('btn-toggle-resto').textContent =
    mostrandoResto ? 'Ocultar el resto de accidentes' : 'Mostrar el resto de accidentes';
}

/* ══════════════════════════════════════════
   Panel de resultados
   ══════════════════════════════════════════ */
function mostrarResultados(ruta, puntos) {
  const totalMuertos = puntos.reduce((s, p) => s + p[F.MU], 0);
  const totalGraves  = puntos.reduce((s, p) => s + p[F.HG], 0);
  const totalLeves   = puntos.reduce((s, p) => s + p[F.HL], 0);

  document.getElementById('rp-ruta-info').textContent =
    `${ruta.distanciaKm.toFixed(0)} km | ${formatDuracion(ruta.duracionMin)}`;

  document.getElementById('rp-nota').textContent = restoDisponible
    ? 'El mapa muestra solo los accidentes con fallecidos.'
    : '';

  const btnResto = document.getElementById('btn-toggle-resto');
  btnResto.hidden = !restoDisponible;
  actualizarBotonResto();

  document.getElementById('rp-stats').innerHTML = `
    <div class="rp-stat"><span class="rp-stat-val">${formatNum(puntos.length)}</span><span class="rp-stat-key">Accidentes</span></div>
    <div class="rp-stat"><span class="rp-stat-val rp-stat-val--danger">${formatNum(totalMuertos)}</span><span class="rp-stat-key">Fallecidos</span></div>
    <div class="rp-stat"><span class="rp-stat-val">${formatNum(totalGraves)}</span><span class="rp-stat-key">Heridos graves</span></div>
    <div class="rp-stat"><span class="rp-stat-val">${formatNum(totalLeves)}</span><span class="rp-stat-key">Heridos leves</span></div>
  `;

  const peores = [...puntos]
    .filter(p => p[F.MU] > 0 || p[F.HG] > 0)
    .sort((a, b) => (b[F.MU] - a[F.MU]) || (b[F.HG] - a[F.HG]))
    .slice(0, 5);

  const peoresEl = document.getElementById('rp-peores');
  peoresEl.innerHTML = '';
  if (!peores.length) {
    peoresEl.innerHTML = '<div class="rp-vacio">Sin heridos graves ni fallecidos en el corredor.</div>';
  } else {
    peores.forEach(p => {
      const el = document.createElement('div');
      el.className = 'rp-peor-item';
      const km = p[F.KM] != null ? ` | km ${p[F.KM]}` : '';
      const badge = p[F.MU] > 0
        ? `${p[F.MU]} fallecido${p[F.MU] > 1 ? 's' : ''}`
        : `${p[F.HG]} grave${p[F.HG] > 1 ? 's' : ''}`;
      el.innerHTML = `
        <div>
          <div class="rp-peor-carretera">${escHtml(CARRETERAS[p[F.CARR]])}${escHtml(km)}</div>
          <div class="rp-peor-detalle">${MESES[p[F.MES]] || ''} ${p[F.ANYO]}</div>
        </div>
        <span class="rp-peor-badge">${badge}</span>
      `;
      el.addEventListener('click', () => map.flyTo({ center: [p[F.LON], p[F.LAT]], zoom: 14 }));
      peoresEl.appendChild(el);
    });
  }

  document.getElementById('resultados-panel').hidden = false;
}

function formatDuracion(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/* ── Popup de accidente ── */
function renderPopup(lngLat, p) {
  const carretera = p.carretera || '—';
  const km        = p.km != null ? `km ${p.km}` : '—';
  const mes       = MESES[p.mes] || '—';
  const dia       = DIAS[p.dia_semana] || '—';
  const hora      = p.hora != null ? `${String(p.hora).padStart(2, '0')}:00` : '—';

  const stat = (k, v) => v != null
    ? `<div class="pp-stat"><span class="pp-stat-key">${k}</span><span class="pp-stat-val">${escHtml(String(v))}</span></div>`
    : '';

  const html = `
    <div>
      <div class="pp-bar"></div>
      <div class="pp-inner">
        <div class="pp-header">
          <span class="pp-badge">${escHtml(carretera)}</span>
          <span class="pp-badge pp-badge--muted">${escHtml(km)}</span>
        </div>
        <p class="pp-nombre">${dia} | ${mes} | ${p.anyo} | ${hora}</p>
        <div class="pp-sep"></div>
        <div class="pp-stats">
          ${stat('Fallecidos 24h', p.muertos)}
          ${stat('Heridos graves', p.graves)}
          ${stat('Heridos leves', p.leves)}
        </div>
      </div>
    </div>`;

  if (!popup) popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, offset: 14, maxWidth: '260px' });
  popup.setLngLat(lngLat).setHTML(html).addTo(map);
}

/* ── Utilidades ── */
function showError(msg) {
  const el = document.getElementById('search-error');
  el.textContent = msg;
  el.hidden = false;
}
function hideError() {
  document.getElementById('search-error').hidden = true;
}
function setLoadingBtn(loading) {
  const btn = document.getElementById('btn-buscar');
  btn.disabled = loading;
  btn.textContent = loading ? 'Buscando…' : 'Buscar ruta';
}
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function formatNum(n) {
  return n.toLocaleString('es-ES', { useGrouping: 'always' });
}
