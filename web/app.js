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
  updateCost();
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
function updateRoom() {
  const width = Math.max(1, number('room-x'));
  const verticalAxis = roomView === 'top' ? 'y' : 'z';
  const verticalSize = Math.max(1, number(`room-${verticalAxis}`));
  $('#widthLabel').textContent = `${width.toFixed(1)} m`;
  $('#verticalDimensionLabel').textContent = `${verticalSize.toFixed(1)} m`;
  const sourceVertical = number(`source-${verticalAxis}`) / verticalSize;
  const listenerVertical = number(`receiver-${verticalAxis}`) / verticalSize;
  placePin('#sourcePin', number('source-x') / width, roomView === 'side' ? 1 - sourceVertical : sourceVertical);
  placePin('#listenerPin', number('receiver-x') / width, roomView === 'side' ? 1 - listenerVertical : listenerVertical);
  updateCost();
}
function placePin(selector, x, y) { const pin = $(selector); pin.style.left = `${Math.max(0, Math.min(100, x * 100))}%`; pin.style.top = `${Math.max(0, Math.min(100, y * 100))}%`; }

const roomDimensionNames = { 'room-x': 'Width', 'room-y': 'Depth', 'room-z': 'Height' };
function clampRoomDimension(input, bounds = ['max']) {
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
  updateRoom();
}));

function makePinDraggable(selector, fieldPrefix) {
  const pin = $(selector);
  let activePointer = null;

  function moveTo(clientX, clientY) {
    const bounds = $('#roomMap').getBoundingClientRect();
    const xRatio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    const yRatio = Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height));
    const verticalAxis = roomView === 'top' ? 'y' : 'z';
    form.elements[`${fieldPrefix}-x`].value = (xRatio * number('room-x')).toFixed(1);
    const verticalRatio = roomView === 'side' ? 1 - yRatio : yRatio;
    form.elements[`${fieldPrefix}-${verticalAxis}`].value = (verticalRatio * number(`room-${verticalAxis}`)).toFixed(1);
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
    xField.value = Math.max(0, Math.min(number('room-x'), Number(xField.value) + movement[0] * step)).toFixed(1);
    const verticalDirection = roomView === 'side' ? -movement[1] : movement[1];
    verticalField.value = Math.max(0, Math.min(number(`room-${verticalAxis}`), Number(verticalField.value) + verticalDirection * step)).toFixed(1);
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
  const cell = 343 / (number('maximum-frequency') * number('points-per-wavelength'));
  const cells = Math.ceil(number('room-x') / cell) * Math.ceil(number('room-y') / cell) * Math.ceil(number('room-z') / cell);
  const steps = Math.ceil(number('ir-duration') * 343 / ((.999 / Math.sqrt(3)) * cell));
  const operations = cells * steps;
  $('#costTitle').textContent = operations > 2e9 ? 'Very heavy reference simulation' : operations > 2e8 ? 'Moderate reference simulation' : 'Light reference simulation';
  $('#costText').textContent = `${cells.toLocaleString()} grid cells · ${steps.toLocaleString()} time steps. Lower bandwidth or response duration if rendering is slow.`;
}

$('select[name=wave-backend]').addEventListener('change', e => {
  $$('.pffdtd-fields').forEach(el => el.hidden = e.target.value !== 'pffdtd');
  updateCost();
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
  const room = ['x','y','z'];
  for (const axis of room) {
    if (number(`source-${axis}`) < 0 || number(`source-${axis}`) > number(`room-${axis}`) || number(`receiver-${axis}`) < 0 || number(`receiver-${axis}`) > number(`room-${axis}`)) {
      setStatus(`Source and listener ${axis.toUpperCase()} positions must be inside the room.`); return;
    }
  }
  setBusy(true, 'Computing pressure field…');
  setStatus('This runs locally and will keep going until it finishes.');
  try {
    const data = Object.fromEntries(new FormData(form).entries());
    $$('input[type=checkbox]', form).forEach(input => data[input.name] = input.checked);
    data.fileName = audioFile.name; data.audioBase64 = await fileToBase64(audioFile);
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

updateMode(); updateRoom();
