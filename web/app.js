const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const form = $('#controls');
const dropZone = $('#dropZone');
const audioInput = $('#audioInput');
const renderButton = $('#renderButton');
let audioFile = null;
let resultUrl = null;
let roomView = 'top';
let rendering = false;
let pffdtdVolume = null;
let savedShoebox = null;
let loadedModelPath = null;

async function updateEngineHealth() {
  const state = $('.engine-state');
  $('#engineState').textContent = 'Checking engine';
  state.classList.remove('ready', 'limited', 'unavailable');
  try {
    const response = await fetch('/api/health', {cache:'no-store'});
    const health = await response.json();
    if (!health.ready) throw new Error(health.error || 'Renderer self-check failed');
    const components = health.components || [];
    const limited = components.some(component => component.status === 'limited' || component.status === 'unavailable');
    $('#engineState').textContent = limited ? 'Core ready · limited integrations' : 'All engines ready';
    state.classList.add(limited ? 'limited' : 'ready');
    $('#engineDetails').innerHTML = components.map(component => `
      <div class="engine-component">
        <span class="component-dot ${component.status}"></span>
        <div><strong>${component.name}</strong><small>${component.detail}</small></div>
        <em>${component.status}</em>
      </div>`).join('');
  } catch (error) {
    $('#engineState').textContent = 'Engine unavailable';
    state.classList.add('unavailable');
    $('#engineDetails').innerHTML = `<p>${error.message}</p>`;
  }
}
$('#refreshHealth').addEventListener('click', event => { event.preventDefault(); updateEngineHealth(); });
updateEngineHealth();

function selectFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.wav')) { setStatus('Please choose a WAV file.'); return; }
  audioFile = file;
  $('#dropTitle').textContent = file.name;
  $('#dropMeta').textContent = `${(file.size / 1048576).toFixed(2)} MB · ready to model`;
  $('#replaceButton').hidden = false;
  dropZone.classList.add('loaded');
  renderButton.disabled = rendering;
  setStatus('');
}

dropZone.addEventListener('click', e => { if (e.target !== $('#replaceButton')) audioInput.click(); });
dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') audioInput.click(); });
$('#replaceButton').addEventListener('click', () => audioInput.click());
audioInput.addEventListener('change', () => selectFile(audioInput.files[0]));
['dragenter','dragover'].forEach(type => dropZone.addEventListener(type, e => { e.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave','drop'].forEach(type => dropZone.addEventListener(type, e => { e.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', e => selectFile(e.dataTransfer.files[0]));

$$('.mode-card input').forEach(input => input.addEventListener('change', updateMode));
function updateMode() {
  const mode = $('input[name=mode]:checked').value;
  $$('.mode-card').forEach(card => card.classList.toggle('selected', $('input', card).checked));
  $$('.geometric-param').forEach(el => el.hidden = mode === 'wave');
  $$('.wave-param').forEach(el => el.hidden = mode === 'geometrical');
  $$('.hybrid-param').forEach(el => el.hidden = mode !== 'hybrid');
  $('#parameterHint').textContent = mode === 'geometrical' ? 'Reflection, material, and path controls for room acoustics.' : mode === 'wave' ? 'Resolution and boundary controls for wave propagation.' : 'Complementary wave and ray-traced room controls.';
  updatePffdtdFields();
}

const ranges = [
  ['irDuration','irDurationOutput',v => `${Number(v).toFixed(2)} s`],
  ['sourceGain','sourceGainOutput',v => Number(v).toFixed(2)],
  ['reflectionOrder','reflectionOrderOutput',v => v],
  ['wallAbsorption','wallAbsorptionOutput',v => Number(v).toFixed(2)],
  ['maximumFrequency','maximumFrequencyOutput',v => `${v} Hz`],
  ['ppw','ppwOutput',v => Number(v).toFixed(1)],
  ['absorption','absorptionOutput',v => Number(v).toFixed(2)],
  ['crossover','crossoverOutput',v => `${v} Hz`]
];
ranges.forEach(([id,out,format]) => $(`#${id}`).addEventListener('input', e => { $(`#${out}`).value = format(e.target.value); updateCost(); }));

function number(name) { return Number(form.elements[name].value); }
function pffdtdPrepareActive() {
  const mode = $('input[name=mode]:checked').value;
  return (mode === 'wave' || mode === 'hybrid')
    && $('select[name=wave-backend]').value === 'pffdtd'
    && $('select[name=pffdtd-job-mode]').value === 'prepare';
}
function roomOrigin() {
  return pffdtdVolume ? pffdtdVolume.min : [0, 0, 0];
}
function roomExtent() {
  if (!pffdtdVolume) {
    return {x: Math.max(1, number('room-x')), y: Math.max(1, number('room-y')), z: Math.max(1, number('room-z'))};
  }
  return {
    x: Math.max(1e-6, pffdtdVolume.max[0] - pffdtdVolume.min[0]),
    y: Math.max(1e-6, pffdtdVolume.max[1] - pffdtdVolume.min[1]),
    z: Math.max(1e-6, pffdtdVolume.max[2] - pffdtdVolume.min[2])
  };
}
function axisIndex(axis) { return {x: 0, y: 1, z: 2}[axis]; }
function clampToVolume(axis, value) {
  const origin = roomOrigin();
  const extent = roomExtent();
  const index = axisIndex(axis);
  const min = origin[index];
  const max = origin[index] + extent[axis];
  const margin = Math.min(0.05, (max - min) * 0.01);
  return Math.max(min + margin, Math.min(max - margin, value));
}
function updateRoom() {
  const origin = roomOrigin();
  const extent = roomExtent();
  const width = extent.x;
  const verticalAxis = roomView === 'top' ? 'y' : 'z';
  const verticalSize = extent[verticalAxis];
  $('#widthLabel').textContent = `${width.toFixed(1)} m`;
  $('#verticalDimensionLabel').textContent = `${verticalSize.toFixed(1)} m`;
  const sourceVertical = (number(`source-${verticalAxis}`) - origin[axisIndex(verticalAxis)]) / verticalSize;
  const listenerVertical = (number(`receiver-${verticalAxis}`) - origin[axisIndex(verticalAxis)]) / verticalSize;
  placePin('#sourcePin', (number('source-x') - origin[0]) / width, roomView === 'side' ? 1 - sourceVertical : sourceVertical);
  placePin('#listenerPin', (number('receiver-x') - origin[0]) / width, roomView === 'side' ? 1 - listenerVertical : listenerVertical);
  updateCost();
}
function placePin(selector, x, y) { const pin = $(selector); pin.style.left = `${Math.max(0, Math.min(100, x * 100))}%`; pin.style.top = `${Math.max(0, Math.min(100, y * 100))}%`; }

const roomDimensionNames = { 'room-x': 'Width', 'room-y': 'Depth', 'room-z': 'Height' };
function clampRoomDimension(input, bounds = ['max']) {
  if (input.readOnly) return;
  const value = Number(input.value);
  if (input.value.trim() === '' || !Number.isFinite(value)) return;
  const min = Number(input.min);
  const max = Number(input.max);
  let clamped = value;
  if (bounds.includes('max') && Number.isFinite(max) && value > max) clamped = max;
  if (bounds.includes('min') && Number.isFinite(min) && value < min) clamped = min;
  if (clamped === value) {
    if ($('#status').textContent.includes('is limited to')) setStatus('');
    return;
  }
  input.value = clamped.toFixed(1);
  const label = roomDimensionNames[input.name] || 'Room size';
  if (clamped === max) setStatus(`${label} is limited to ${max.toFixed(0)} m.`);
}

$$('.room-fields input').forEach(input => {
  input.addEventListener('input', () => {
    if (input.name.startsWith('room-')) clampRoomDimension(input);
    updateRoom();
  });
  input.addEventListener('change', () => {
    if (input.name.startsWith('room-')) clampRoomDimension(input, ['min', 'max']);
    updateRoom();
  });
});

$$('.view-switch button').forEach(button => button.addEventListener('click', () => {
  roomView = button.dataset.view;
  $$('.view-switch button').forEach(option => {
    const selected = option === button;
    option.classList.toggle('active', selected);
    option.setAttribute('aria-pressed', selected);
  });
  $('#roomMap').classList.toggle('side-view', roomView === 'side');
  drawRoomGeometry();
  updateRoom();
}));

function makePinDraggable(selector, fieldPrefix) {
  const pin = $(selector);
  let activePointer = null;

  function moveTo(clientX, clientY) {
    const bounds = $('#roomMap').getBoundingClientRect();
    const xRatio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    const yRatio = Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height));
    const origin = roomOrigin();
    const extent = roomExtent();
    const verticalAxis = roomView === 'top' ? 'y' : 'z';
    form.elements[`${fieldPrefix}-x`].value = clampToVolume('x', origin[0] + xRatio * extent.x).toFixed(2);
    const verticalRatio = roomView === 'side' ? 1 - yRatio : yRatio;
    form.elements[`${fieldPrefix}-${verticalAxis}`].value = clampToVolume(verticalAxis, origin[axisIndex(verticalAxis)] + verticalRatio * extent[verticalAxis]).toFixed(2);
    updateRoom();
  }

  pin.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    activePointer = event.pointerId;
    pin.setPointerCapture(event.pointerId);
    pin.classList.add('dragging');
    moveTo(event.clientX, event.clientY);
    event.preventDefault();
  });
  pin.addEventListener('pointermove', event => {
    if (event.pointerId === activePointer) moveTo(event.clientX, event.clientY);
  });
  function finishDrag(event) {
    if (event.pointerId !== activePointer) return;
    activePointer = null;
    pin.classList.remove('dragging');
  }
  pin.addEventListener('pointerup', finishDrag);
  pin.addEventListener('pointercancel', finishDrag);

  pin.addEventListener('keydown', event => {
    const movement = {ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1]}[event.key];
    if (!movement) return;
    const step = event.shiftKey ? 0.5 : 0.1;
    const verticalAxis = roomView === 'top' ? 'y' : 'z';
    const xField = form.elements[`${fieldPrefix}-x`];
    const verticalField = form.elements[`${fieldPrefix}-${verticalAxis}`];
    xField.value = clampToVolume('x', Number(xField.value) + movement[0] * step).toFixed(2);
    const verticalDirection = roomView === 'side' ? -movement[1] : movement[1];
    verticalField.value = clampToVolume(verticalAxis, Number(verticalField.value) + verticalDirection * step).toFixed(2);
    updateRoom();
    event.preventDefault();
  });
}

makePinDraggable('#sourcePin', 'source');
makePinDraggable('#listenerPin', 'receiver');

function updateCost() {
  const mode = $('input[name=mode]:checked').value;
  const note = $('#costNote');
  note.hidden = mode === 'geometrical';
  if (note.hidden) return;
  if ($('select[name=wave-backend]').value === 'pffdtd') {
    const preparing = $('select[name=pffdtd-job-mode]').value === 'prepare';
    $('#costTitle').textContent = preparing ? 'PFFDTD prepare + simulation' : 'PFFDTD uses the prepared job';
    $('#costText').textContent = preparing
      ? 'The loaded model sets the room size. Source and listener in Room & placement are written into the new PFFDTD job, then voxelized and simulated.'
      : 'Runtime is set by the job directory (grid and duration), then convolution with your WAV. The shoebox size sliders do not change the PFFDTD mesh.';
    return;
  }
  const cell = 343 / (number('maximum-frequency') * number('points-per-wavelength'));
  const cells = Math.ceil(number('room-x') / cell) * Math.ceil(number('room-y') / cell) * Math.ceil(number('room-z') / cell);
  const steps = Math.ceil(number('ir-duration') * 343 / ((.999 / Math.sqrt(3)) * cell));
  const operations = cells * steps;
  $('#costTitle').textContent = operations > 2e9 ? 'Very heavy reference simulation' : operations > 2e8 ? 'Moderate reference simulation' : 'Light reference simulation';
  $('#costText').textContent = `${cells.toLocaleString()} grid cells · ${steps.toLocaleString()} time steps. Lower bandwidth or response duration if rendering is slow.`;
}

function drawRoomGeometry() {
  const svg = $('#roomGeometry');
  if (!svg) return;
  svg.replaceChildren();
  if (!pffdtdVolume) {
    svg.hidden = true;
    svg.setAttribute('aria-hidden', 'true');
    $('#roomMap').classList.remove('has-model');
    return;
  }
  const extent = roomExtent();
  const origin = roomOrigin();
  const vertical = roomView === 'top' ? 'y' : 'z';
  const spanV = extent[vertical];
  svg.hidden = false;
  svg.setAttribute('aria-hidden', 'false');
  svg.setAttribute('viewBox', `0 0 ${extent.x} ${spanV}`);
  $('#roomMap').classList.add('has-model');
  const project = point => {
    const x = point[0] - origin[0];
    const y = roomView === 'side' ? origin[2] + spanV - point[1] : point[1] - origin[1];
    return `${x},${y}`;
  };
  const rank = name => /wall/i.test(name) ? 2 : /glass|panel/i.test(name) ? 1 : 0;
  const layers = [...pffdtdVolume.layers].sort((a, b) => rank(a.name) - rank(b.name));
  for (const layer of layers) {
    if (/chair|plush/i.test(layer.name)) continue;
    if (roomView === 'top' && /ceiling/i.test(layer.name)) continue;
    const triangles = layer[roomView === 'top' ? 'top' : 'side'] || [];
    if (!triangles.length) continue;
    const [r, g, b] = layer.color;
    const structure = /wall|glass|panel/i.test(layer.name);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', structure ? 'none' : `rgba(${r},${g},${b},0.2)`);
    path.setAttribute('stroke', structure
      ? 'rgba(213,255,69,0.88)'
      : `rgba(${Math.min(255, r + 50)},${Math.min(255, g + 50)},${Math.min(255, b + 50)},0.78)`);
    path.setAttribute('stroke-width', structure ? '1.6' : '0.8');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.setAttribute('d', triangles.map(tri => {
      const pts = tri.map(project);
      return `M${pts[0]}L${pts[1]}L${pts[2]}Z`;
    }).join(''));
    svg.append(path);
  }
}

function snapshotShoebox() {
  const names = ['room-x','room-y','room-z','source-x','source-y','source-z','receiver-x','receiver-y','receiver-z'];
  const snapshot = {};
  names.forEach(name => { snapshot[name] = form.elements[name].value; });
  return snapshot;
}

function setRoomLocked(locked) {
  ['room-x','room-y','room-z'].forEach(name => {
    const input = form.elements[name];
    input.readOnly = locked;
    input.classList.toggle('locked', locked);
  });
  $('.room-panel').classList.toggle('model-locked', locked);
  $('#roomModelHint').hidden = !locked;
}

function restoreShoebox() {
  pffdtdVolume = null;
  loadedModelPath = null;
  setRoomLocked(false);
  ['room-x','room-y'].forEach(name => { form.elements[name].max = 30; form.elements[name].min = 1; });
  form.elements['room-z'].max = 12;
  form.elements['room-z'].min = 1;
  ['source','receiver'].forEach(prefix => {
    ['x','y','z'].forEach(axis => {
      const input = form.elements[`${prefix}-${axis}`];
      input.min = 0;
      input.removeAttribute('max');
    });
  });
  if (savedShoebox) {
    Object.entries(savedShoebox).forEach(([name, value]) => { form.elements[name].value = value; });
    savedShoebox = null;
  }
  drawRoomGeometry();
  updateRoom();
}

function applyLoadedModel(model, { resetPins = true } = {}) {
  if (!savedShoebox) savedShoebox = snapshotShoebox();
  pffdtdVolume = {min: model.bounds.min, max: model.bounds.max, layers: model.layers || []};
  loadedModelPath = $('input[name=pffdtd-model]').value.trim();
  const extent = roomExtent();
  form.elements['room-x'].value = extent.x.toFixed(2);
  form.elements['room-y'].value = extent.y.toFixed(2);
  form.elements['room-z'].value = extent.z.toFixed(2);
  form.elements['room-x'].max = Math.max(30, extent.x);
  form.elements['room-y'].max = Math.max(30, extent.y);
  form.elements['room-z'].max = Math.max(12, extent.z);
  ['source','receiver'].forEach(prefix => {
    ['x','y','z'].forEach((axis, index) => {
      const input = form.elements[`${prefix}-${axis}`];
      input.min = pffdtdVolume.min[index];
      input.max = pffdtdVolume.max[index];
    });
  });
  if (resetPins) {
    const source = (model.sources && model.sources[0] && model.sources[0].xyz) || pffdtdVolume.min.map((v, i) => v + extent[['x','y','z'][i]] * 0.3);
    const receiver = (model.receivers && model.receivers[0] && model.receivers[0].xyz) || pffdtdVolume.min.map((v, i) => v + extent[['x','y','z'][i]] * 0.7);
    ['x','y','z'].forEach((axis, index) => {
      form.elements[`source-${axis}`].value = clampToVolume(axis, source[index]).toFixed(2);
      form.elements[`receiver-${axis}`].value = clampToVolume(axis, receiver[index]).toFixed(2);
    });
  } else {
    ['source','receiver'].forEach(prefix => {
      ['x','y','z'].forEach(axis => {
        const input = form.elements[`${prefix}-${axis}`];
        input.value = clampToVolume(axis, number(`${prefix}-${axis}`)).toFixed(2);
      });
    });
  }
  setRoomLocked(true);
  drawRoomGeometry();
  updateRoom();
}

async function loadPffdtdModel() {
  if (!pffdtdPrepareActive()) {
    if (loadedModelPath || pffdtdVolume) restoreShoebox();
    return;
  }
  const path = $('input[name=pffdtd-model]').value.trim();
  if (!path) {
    if (loadedModelPath || pffdtdVolume) restoreShoebox();
    return;
  }
  if (path === loadedModelPath && pffdtdVolume) {
    drawRoomGeometry();
    updateRoom();
    return;
  }
  try {
    const response = await fetch(`/api/pffdtd/model?path=${encodeURIComponent(path)}`, {cache: 'no-store'});
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not read the model');
    applyLoadedModel(payload);
  } catch (error) {
    setStatus(error.message);
  }
}

function updatePffdtdFields() {
  const pffdtd = $('select[name=wave-backend]').value === 'pffdtd';
  $$('.pffdtd-fields').forEach(el => { el.hidden = !pffdtd; });
  const preparing = pffdtdPrepareActive();
  $$('.pffdtd-prepare').forEach(el => { el.hidden = !preparing; });
  $$('.pffdtd-existing').forEach(el => { el.hidden = !pffdtd || preparing; });
  loadPffdtdModel();
  updateCost();
}

$('select[name=wave-backend]').addEventListener('change', updatePffdtdFields);
$('select[name=pffdtd-job-mode]').addEventListener('change', () => {
  if ($('select[name=pffdtd-job-mode]').value === 'prepare' && $('select[name=pffdtd-execution]').value === 'prepared') {
    $('select[name=pffdtd-execution]').value = 'python';
  }
  updatePffdtdFields();
});
$('input[name=pffdtd-model]').addEventListener('change', () => {
  loadedModelPath = null;
  loadPffdtdModel();
});

const DEFAULT_PFFDTD_MATERIALS = [
  ['AcousticPanel', 'ctk_acoustic_panel.h5'],
  ['Altar', 'ctk_altar.h5'],
  ['Carpet', 'ctk_carpet.h5'],
  ['Ceiling', 'ctk_ceiling.h5'],
  ['Glass', 'ctk_window.h5'],
  ['PlushChair', 'ctk_chair.h5'],
  ['Tile', 'ctk_tile.h5'],
  ['Walls', 'ctk_walls.h5']
];

function collectPffdtdMaterials() {
  return $$('#pffdtdMaterialRows .pffdtd-material-row').map(row => {
    const name = $('[data-mat-name]', row).value.trim();
    const file = $('[data-mat-file]', row).value.trim();
    return name && file ? `${name}=${file}` : '';
  }).filter(Boolean);
}

function addPffdtdMaterialRow(name = '', file = '') {
  const row = document.createElement('div');
  row.className = 'pffdtd-material-row';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Surface';
  const nameInput = document.createElement('input');
  nameInput.setAttribute('data-mat-name', '');
  nameInput.type = 'text';
  nameInput.value = name;
  nameLabel.append(nameInput);
  const fileLabel = document.createElement('label');
  fileLabel.textContent = 'HDF5 file';
  const fileInput = document.createElement('input');
  fileInput.setAttribute('data-mat-file', '');
  fileInput.type = 'text';
  fileInput.value = file;
  fileLabel.append(fileInput);
  const remove = document.createElement('button');
  remove.className = 'ghost small';
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => row.remove());
  row.append(nameLabel, fileLabel, remove);
  $('#pffdtdMaterialRows').append(row);
}

DEFAULT_PFFDTD_MATERIALS.forEach(([name, file]) => addPffdtdMaterialRow(name, file));
$('#addPffdtdMaterial').addEventListener('click', () => addPffdtdMaterialRow());
$('#loadPffdtdSurfaces').addEventListener('click', async () => {
  const path = $('input[name=pffdtd-model]').value.trim();
  if (!path) { setStatus('Set the model JSON path first.'); return; }
  try {
    const response = await fetch(`/api/pffdtd/model?path=${encodeURIComponent(path)}`, {cache: 'no-store'});
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not read the model');
    if (pffdtdPrepareActive()) applyLoadedModel(payload, {resetPins: !pffdtdVolume});
    const previous = {};
    collectPffdtdMaterials().forEach(item => {
      const index = item.indexOf('=');
      previous[item.slice(0, index)] = item.slice(index + 1);
    });
    $('#pffdtdMaterialRows').replaceChildren();
    (payload.surfaces || []).forEach(name => addPffdtdMaterialRow(name, previous[name] || ''));
    setStatus(payload.hasVaMaterials
      ? 'Loaded surfaces from the model. Mappings are optional when va_materials is present.'
      : `Loaded ${payload.surfaces.length} surfaces from the model.`);
  } catch (error) {
    setStatus(error.message);
  }
});

const JOB_KEY = 'va-render-job';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function setStatus(message) { $('#status').textContent = message; }
function fileToBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); }); }

function formatElapsed(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours) return `${hours}h ${minutes}m ${remainder}s`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function setBusy(busy, label) {
  rendering = busy;
  renderButton.classList.toggle('loading', busy);
  renderButton.querySelector('span').textContent = label || 'Render acoustic result';
  renderButton.disabled = busy || !audioFile;
}

function showResult(blob, job) {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(blob);
  const sourceName = (audioFile && audioFile.name) || job.fileName || 'audio.wav';
  $('#resultAudio').src = resultUrl;
  $('#downloadButton').href = resultUrl;
  $('#downloadButton').download = `${sourceName.replace(/\.wav$/i, '')}-va.wav`;
  $('#resultMessage').textContent = job.message || `${(blob.size / 1048576).toFixed(2)} MB WAV`;
  $('#resultPanel').hidden = false;
  $('#resultPanel').scrollIntoView({behavior: 'smooth', block: 'center'});
}

async function waitForJob(jobId) {
  sessionStorage.setItem(JOB_KEY, jobId);
  let failures = 0;
  while (true) {
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {cache: 'no-store'});
      if (response.status === 404) {
        sessionStorage.removeItem(JOB_KEY);
        throw new Error('The render job is no longer available. Start a new render.');
      }
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'Lost contact with the renderer');
      }
      failures = 0;
      const job = await response.json();
      const elapsed = formatElapsed(job.elapsed);
      renderButton.querySelector('span').textContent = `Computing… ${elapsed}`;
      const detail = job.message ? job.message : 'Renderer is still running';
      setStatus(`${detail} · ${elapsed} elapsed`);
      if (job.status === 'done') {
        return job;
      }
      if (job.status === 'error') {
        sessionStorage.removeItem(JOB_KEY);
        throw new Error(job.error || 'The acoustic renderer failed');
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      failures += 1;
      if (failures >= 30) throw new Error('Lost contact with the renderer');
      setStatus(`Reconnecting to the renderer (${failures})…`);
    }
    await sleep(1000);
  }
}

async function downloadResult(job) {
  let failures = 0;
  while (true) {
    try {
      const response = await fetch(`/api/jobs/${job.jobId}/result`, {cache: 'no-store'});
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'Could not download the rendered audio');
      }
      showResult(await response.blob(), job);
      return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      failures += 1;
      if (failures >= 30) throw new Error('Lost contact with the renderer');
      setStatus(`Reconnecting to download the result (${failures})…`);
      await sleep(1000);
    }
  }
}

async function followJob(jobId) {
  setBusy(true, 'Computing pressure field…');
  try {
    const job = await waitForJob(jobId);
    await downloadResult(job);
    sessionStorage.removeItem(JOB_KEY);
    setStatus('');
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!audioFile || rendering) return;
  const origin = roomOrigin();
  const extent = roomExtent();
  for (const prefix of ['source', 'receiver']) {
    for (const axis of ['x', 'y', 'z']) {
      const value = number(`${prefix}-${axis}`);
      const min = origin[axisIndex(axis)];
      const max = min + extent[axis];
      if (value < min || value > max) {
        setStatus('Source and listener positions must be inside the room.');
        return;
      }
    }
  }
  setBusy(true, 'Computing pressure field…');
  setStatus('This runs locally and will keep going until it finishes.');
  try {
    const data = Object.fromEntries(new FormData(form).entries());
    $$('input[type=checkbox]', form).forEach(input => data[input.name] = input.checked);
    data.fileName = audioFile.name; data.audioBase64 = await fileToBase64(audioFile);
    data['pffdtd-materials'] = collectPffdtdMaterials();
    const response = await fetch('/api/render', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Render failed'); }
    const started = await response.json();
    await followJob(started.jobId);
  } catch (error) {
    setStatus(error.message);
    setBusy(false);
  }
});

const pendingJob = sessionStorage.getItem(JOB_KEY);
if (pendingJob) {
  setStatus('Reconnecting to the running render…');
  followJob(pendingJob);
}

updateMode(); updateRoom(); updatePffdtdFields();
