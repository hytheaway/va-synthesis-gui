const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const form = $('#controls');
const dropZone = $('#dropZone');
const audioInput = $('#audioInput');
const renderButton = $('#renderButton');
let audioFile = null;
let resultUrl = null;
let roomView = 'top';

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
  renderButton.disabled = false;
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
$$('.room-fields input').forEach(input => input.addEventListener('input', updateRoom));

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
    form.elements[`${fieldPrefix}-x`].value = (xRatio * number('room-x')).toFixed(2);
    const verticalRatio = roomView === 'side' ? 1 - yRatio : yRatio;
    form.elements[`${fieldPrefix}-${verticalAxis}`].value = (verticalRatio * number(`room-${verticalAxis}`)).toFixed(2);
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
    xField.value = Math.max(0, Math.min(number('room-x'), Number(xField.value) + movement[0] * step)).toFixed(2);
    const verticalDirection = roomView === 'side' ? -movement[1] : movement[1];
    verticalField.value = Math.max(0, Math.min(number(`room-${verticalAxis}`), Number(verticalField.value) + verticalDirection * step)).toFixed(2);
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

function setStatus(message) { $('#status').textContent = message; }
function fileToBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); }); }

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!audioFile) return;
  const room = ['x','y','z'];
  for (const axis of room) {
    if (number(`source-${axis}`) < 0 || number(`source-${axis}`) > number(`room-${axis}`) || number(`receiver-${axis}`) < 0 || number(`receiver-${axis}`) > number(`room-${axis}`)) {
      setStatus(`Source and listener ${axis.toUpperCase()} positions must be inside the room.`); return;
    }
  }
  renderButton.disabled = true; renderButton.classList.add('loading'); renderButton.querySelector('span').textContent = 'Computing pressure field…'; setStatus('This runs locally. Wave simulations can take a while.');
  try {
    const data = Object.fromEntries(new FormData(form).entries());
    $$('input[type=checkbox]', form).forEach(input => data[input.name] = input.checked);
    data.fileName = audioFile.name; data.audioBase64 = await fileToBase64(audioFile);
    const response = await fetch('/api/render', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Render failed'); }
    const blob = await response.blob();
    if (resultUrl) URL.revokeObjectURL(resultUrl); resultUrl = URL.createObjectURL(blob);
    $('#resultAudio').src = resultUrl; $('#downloadButton').href = resultUrl; $('#downloadButton').download = `${audioFile.name.replace(/\.wav$/i,'')}-va.wav`;
    $('#resultMessage').textContent = response.headers.get('X-VA-Message') || `${(blob.size / 1048576).toFixed(2)} MB WAV`;
    $('#resultPanel').hidden = false; $('#resultPanel').scrollIntoView({behavior:'smooth',block:'center'}); setStatus('');
  } catch (error) { setStatus(error.message); }
  finally { renderButton.disabled = false; renderButton.classList.remove('loading'); renderButton.querySelector('span').textContent = 'Render acoustic result'; }
});

updateMode(); updateRoom();
