(() => {
  'use strict';

  const API_URL = '/api/detect';
  const CLIENT_TIMEOUT_MS = 30000;
  const CAMERA_MAX_SIDE = 640;   // frames are downscaled before upload to keep requests light
  const UPLOAD_MAX_SIDE = 1280;
  const MAX_FILE_BYTES = 15 * 1024 * 1024;
  const PALETTE = ['#2f8cff', '#2fd68a', '#ffb340', '#ff5370', '#b07cff', '#22d3ee', '#f472b6', '#a3e635', '#fb923c', '#94a3b8'];

  const $ = (id) => document.getElementById(id);
  const el = {
    status: $('status'), statusText: $('statusText'),
    viewport: $('viewport'), video: $('video'), preview: $('preview'), overlay: $('overlay'),
    empty: $('emptyState'), emptyTitle: $('emptyTitle'), emptyHint: $('emptyHint'),
    scanline: $('scanline'), toast: $('toast'), meta: $('viewportMeta'),
    startBtn: $('startBtn'), stopBtn: $('stopBtn'), intervalSelect: $('intervalSelect'),
    cameraSelect: $('cameraSelect'), cameraSelectWrap: $('cameraSelectWrap'),
    cameraControls: $('cameraControls'), uploadControls: $('uploadControls'),
    fileInput: $('fileInput'), detectBtn: $('detectBtn'), fileName: $('fileName'),
    confSlider: $('confSlider'), confValue: $('confValue'),
    statCount: $('statCount'), statConf: $('statConf'), statTime: $('statTime'), statRuns: $('statRuns'),
    classBar: $('classBar'), classLegend: $('classLegend'),
    results: $('results'), resultBadge: $('resultBadge'), log: $('log'),
  };
  const ctx = el.overlay.getContext('2d');

  const state = {
    mode: 'camera',
    stream: null,
    running: false,
    busy: false,
    timer: null,
    abort: null,
    runs: 0,
    serverReady: false,
    last: null,          // { predictions, refW, refH } — reference dims the coords are expressed in
    uploadedImage: null, // HTMLImageElement source for upload mode
    uploadUrl: null,
    threshold: 0.4,
  };
  const classColors = new Map();

  // ---------- helpers ----------
  function colorFor(name) {
    if (!classColors.has(name)) classColors.set(name, PALETTE[classColors.size % PALETTE.length]);
    return classColors.get(name);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function log(msg, kind = '') {
    const li = document.createElement('li');
    const t = new Date().toLocaleTimeString('id-ID', { hour12: false });
    li.innerHTML = `<time>${t}</time><span class="${kind}">${escapeHtml(msg)}</span>`;
    el.log.prepend(li);
    while (el.log.children.length > 60) el.log.lastChild.remove();
  }
  function setStatus(kind) {
    const labels = { online: 'SYSTEM ONLINE', camera: 'CAMERA ACTIVE', processing: 'PROCESSING', error: 'SYSTEM ERROR', booting: 'INITIALIZING' };
    el.status.dataset.state = kind;
    el.statusText.textContent = labels[kind] || kind;
  }
  function idleStatus() {
    if (!state.serverReady) return setStatus('error');
    setStatus(state.running ? 'camera' : 'online');
  }
  let toastTimer = null;
  function showError(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 6000);
    log(msg, 'err');
  }
  function hideError() { el.toast.hidden = true; }

  // Draws a source (video/image) into a JPEG data URL, downscaled to maxSide.
  function captureJpeg(source, srcW, srcH, maxSide, quality) {
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const w = Math.round(srcW * scale);
    const h = Math.round(srcH * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(source, 0, 0, w, h);
    return { dataUrl: c.toDataURL('image/jpeg', quality), w, h };
  }

  // ---------- API ----------
  async function detect(dataUrl) {
    state.abort = new AbortController();
    const timeout = setTimeout(() => state.abort && state.abort.abort('timeout'), CLIENT_TIMEOUT_MS);
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
        signal: state.abort.signal,
      });
    } catch (e) {
      if (state.abort && state.abort.signal.reason === 'timeout') throw new Error('Request timeout — server tidak merespons dalam 30 detik');
      if (e.name === 'AbortError') throw Object.assign(new Error('aborted'), { aborted: true });
      throw new Error('Tidak dapat menghubungi server. Periksa koneksi internet.');
    } finally {
      clearTimeout(timeout);
      state.abort = null;
    }
    let data = null;
    try { data = await res.json(); } catch { /* handled below */ }
    if (!res.ok) throw new Error((data && data.error) || `Server error (HTTP ${res.status})`);
    if (!data || typeof data !== 'object') throw new Error('Response server kosong atau tidak valid');
    data.clientMs = Math.round(performance.now() - t0);
    data.predictions = Array.isArray(data.predictions) ? data.predictions : [];
    return data;
  }

  async function healthCheck() {
    try {
      const res = await fetch(API_URL, { method: 'GET' });
      const data = await res.json();
      state.serverReady = Boolean(data && data.ok && data.configured);
      if (state.serverReady) log('Backend /api/detect siap', 'ok');
      else showError('Backend aktif, tetapi ROBOFLOW_API_KEY belum diset di server.');
    } catch {
      state.serverReady = false;
      showError('Backend /api/detect tidak dapat dijangkau.');
    }
    idleStatus();
  }

  // ---------- rendering ----------
  function sizeOverlay(w, h) {
    if (el.overlay.width !== w || el.overlay.height !== h) {
      el.overlay.width = w; el.overlay.height = h;
    }
    el.meta.textContent = `${w} × ${h}`;
  }

  function clearOverlay() { ctx.clearRect(0, 0, el.overlay.width, el.overlay.height); }

  function visiblePredictions() {
    if (!state.last) return [];
    return state.last.predictions.filter((p) => p.confidence == null || p.confidence >= state.threshold);
  }

  function drawBoxes() {
    clearOverlay();
    if (!state.last) return;
    const W = el.overlay.width, H = el.overlay.height;
    const sx = W / state.last.refW, sy = H / state.last.refH;
    // Size strokes/labels in on-screen pixels, independent of the source resolution.
    const disp = Math.min(el.overlay.clientWidth / W, el.overlay.clientHeight / H) || 1;
    const lw = Math.max(1, Math.round(2.5 / disp));
    const fs = Math.round(13 / disp);
    ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    ctx.textBaseline = 'top';

    for (const p of visiblePredictions()) {
      // Roboflow coordinates are box centers.
      const x = (p.x - p.width / 2) * sx;
      const y = (p.y - p.height / 2) * sy;
      const w = p.width * sx;
      const h = p.height * sy;
      const color = colorFor(p.class);

      ctx.lineWidth = lw;
      ctx.strokeStyle = color;
      ctx.fillStyle = color + '22';
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);

      const label = `${p.class} ${p.confidence == null ? '' : Math.round(p.confidence * 100) + '%'}`.trim();
      const pad = Math.round(fs * 0.35);
      const tw = ctx.measureText(label).width + pad * 2;
      const th = fs + pad * 2;
      const ly = y - th >= 0 ? y - th : y; // keep label inside the frame
      const lx = Math.min(Math.max(0, x - lw / 2), W - tw);
      ctx.fillStyle = color;
      ctx.fillRect(lx, ly, tw, th);
      ctx.fillStyle = '#05070a';
      ctx.fillText(label, lx + pad, ly + pad);
    }
  }

  function renderPanels(meta) {
    const preds = visiblePredictions();
    el.statCount.textContent = preds.length;
    el.resultBadge.textContent = preds.length;
    const confs = preds.map((p) => p.confidence).filter((c) => typeof c === 'number');
    el.statConf.textContent = confs.length ? `${Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 100)}%` : '—';
    if (meta) {
      const ms = meta.modelTimeMs ?? meta.roundTripMs ?? meta.clientMs;
      el.statTime.textContent = ms == null ? '—' : `${ms} ms`;
      el.statTime.title = `Model/server: ${meta.modelTimeMs ?? '—'} ms · Roboflow round-trip: ${meta.roundTripMs ?? '—'} ms · Total client: ${meta.clientMs} ms`;
    }
    el.statRuns.textContent = state.runs;

    const counts = {};
    preds.forEach((p) => { counts[p.class] = (counts[p.class] || 0) + 1; });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    el.classBar.innerHTML = entries.map(([c, n]) => `<span style="width:${(n / preds.length) * 100}%;background:${colorFor(c)}"></span>`).join('');
    el.classLegend.innerHTML = entries.map(([c, n]) => `<span><i style="background:${colorFor(c)}"></i>${escapeHtml(c)} · ${n}</span>`).join('');

    if (!preds.length) {
      el.results.innerHTML = `<li class="results-empty">${state.last ? 'Tidak ada objek di atas threshold.' : 'Belum ada deteksi.'}</li>`;
      return;
    }
    el.results.innerHTML = preds
      .slice()
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .map((p) => {
        const pct = p.confidence == null ? null : Math.round(p.confidence * 1000) / 10;
        return `<li class="result" style="--c:${colorFor(p.class)}">
          <div class="result-top"><span class="result-name">${escapeHtml(p.class)}</span><span class="result-conf">${pct == null ? 'n/a' : pct + '%'}</span></div>
          <div class="result-bar"><span style="width:${pct ?? 0}%"></span></div>
          <div class="result-meta">x ${Math.round(p.x)} · y ${Math.round(p.y)} · ${Math.round(p.width)}×${Math.round(p.height)} px</div>
        </li>`;
      })
      .join('');
  }

  function applyResult(data, sentW, sentH) {
    state.runs += 1;
    const refW = (data.image && data.image.width) || sentW;
    const refH = (data.image && data.image.height) || sentH;
    state.last = { predictions: data.predictions.filter((p) => [p.x, p.y, p.width, p.height].every(Number.isFinite)), refW, refH };
    drawBoxes();
    renderPanels(data);
  }

  function resetResults() {
    state.last = null;
    clearOverlay();
    renderPanels(null);
    el.statTime.textContent = '—';
  }

  // ---------- camera ----------
  async function listCameras() {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      if (devices.length < 2) { el.cameraSelectWrap.hidden = true; return; }
      const current = state.stream && state.stream.getVideoTracks()[0]?.getSettings().deviceId;
      el.cameraSelect.innerHTML = devices.map((d, i) =>
        `<option value="${escapeHtml(d.deviceId)}" ${d.deviceId === current ? 'selected' : ''}>${escapeHtml(d.label || `Kamera ${i + 1}`)}</option>`).join('');
      el.cameraSelectWrap.hidden = false;
    } catch { el.cameraSelectWrap.hidden = true; }
  }

  async function startCamera(deviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return showError('Browser tidak mendukung akses kamera (butuh HTTPS dan browser modern).');
    }
    hideError();
    el.startBtn.disabled = true;
    stopStream();
    try {
      const video = deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } };
      state.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      el.startBtn.disabled = false;
      const msg = e.name === 'NotAllowedError' ? 'Izin kamera ditolak. Izinkan akses kamera di pengaturan browser.'
        : e.name === 'NotFoundError' ? 'Tidak ada kamera yang terdeteksi.'
        : e.name === 'NotReadableError' ? 'Kamera sedang dipakai aplikasi lain.'
        : `Gagal membuka kamera: ${e.message}`;
      return showError(msg);
    }

    el.video.srcObject = state.stream;
    el.video.hidden = false;
    el.preview.hidden = true;
    el.empty.hidden = true;
    el.viewport.classList.add('live');
    try { await el.video.play(); } catch { /* autoplay muted is allowed */ }
    await new Promise((r) => (el.video.videoWidth ? r() : el.video.addEventListener('loadedmetadata', r, { once: true })));
    sizeOverlay(el.video.videoWidth, el.video.videoHeight);
    resetResults();

    state.running = true;
    el.stopBtn.disabled = false;
    setTabsLocked(true);
    idleStatus();
    log(`Kamera aktif ${el.video.videoWidth}×${el.video.videoHeight}`, 'ok');
    listCameras();
    scheduleNext(0);
  }

  function stopStream() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    el.video.pause();
    el.video.srcObject = null;
  }

  function stopCamera() {
    const wasRunning = state.running;
    state.running = false;
    clearTimeout(state.timer);
    state.timer = null;
    if (state.abort) state.abort.abort();
    stopStream();
    el.video.hidden = true;
    el.viewport.classList.remove('live');
    el.scanline.hidden = true;
    el.startBtn.disabled = false;
    el.stopBtn.disabled = true;
    setTabsLocked(false);
    clearOverlay();
    state.last = null;
    showEmpty();
    idleStatus();
    if (wasRunning) log('Kamera dimatikan');
  }

  function scheduleNext(delay) {
    clearTimeout(state.timer);
    if (!state.running) return;
    state.timer = setTimeout(tick, delay);
  }

  // One request at a time: the next frame is only scheduled after the previous response.
  async function tick() {
    if (!state.running || state.busy) return;
    if (document.hidden || !el.video.videoWidth) return scheduleNext(500);
    if (!state.serverReady) { await healthCheck(); if (!state.serverReady) return scheduleNext(5000); }

    state.busy = true;
    setStatus('processing');
    const frame = captureJpeg(el.video, el.video.videoWidth, el.video.videoHeight, CAMERA_MAX_SIDE, 0.75);
    let backoff = 0;
    try {
      const data = await detect(frame.dataUrl);
      if (!state.running) return;
      sizeOverlay(el.video.videoWidth, el.video.videoHeight);
      applyResult(data, frame.w, frame.h);
      hideError();
      log(`${data.count ?? data.predictions.length} objek · ${data.clientMs} ms`);
    } catch (e) {
      if (e.aborted) return;
      showError(e.message);
      backoff = 3000; // ease off the API after a failure
    } finally {
      state.busy = false;
      if (state.running) { idleStatus(); scheduleNext(Number(el.intervalSelect.value) + backoff); }
    }
  }

  // ---------- upload ----------
  function loadFile(file) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|bmp)$/.test(file.type)) return showError('Format tidak didukung. Gunakan JPG, PNG, WEBP, atau BMP.');
    if (file.size > MAX_FILE_BYTES) return showError('Ukuran file maksimal 15 MB.');
    hideError();
    if (state.uploadUrl) URL.revokeObjectURL(state.uploadUrl);
    state.uploadUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      state.uploadedImage = img;
      el.preview.src = state.uploadUrl;
      el.preview.hidden = false;
      el.empty.hidden = true;
      sizeOverlay(img.naturalWidth, img.naturalHeight);
      resetResults();
      el.detectBtn.disabled = false;
      el.fileName.textContent = file.name;
      log(`Gambar dimuat: ${file.name} (${img.naturalWidth}×${img.naturalHeight})`);
    };
    img.onerror = () => showError('Gambar tidak dapat dibaca.');
    img.src = state.uploadUrl;
  }

  async function detectUpload() {
    if (!state.uploadedImage || state.busy) return;
    const img = state.uploadedImage;
    state.busy = true;
    el.detectBtn.disabled = true;
    el.scanline.hidden = false;
    setStatus('processing');
    hideError();
    try {
      const frame = captureJpeg(img, img.naturalWidth, img.naturalHeight, UPLOAD_MAX_SIDE, 0.9);
      const data = await detect(frame.dataUrl);
      sizeOverlay(img.naturalWidth, img.naturalHeight);
      applyResult(data, frame.w, frame.h);
      log(`${data.count ?? data.predictions.length} objek terdeteksi · ${data.clientMs} ms`, 'ok');
    } catch (e) {
      if (!e.aborted) showError(e.message);
    } finally {
      state.busy = false;
      el.detectBtn.disabled = false;
      el.scanline.hidden = true;
      idleStatus();
    }
  }

  // ---------- mode / UI ----------
  function showEmpty() {
    if (state.mode === 'camera') {
      el.emptyTitle.textContent = 'Kamera belum aktif';
      el.emptyHint.innerHTML = 'Tekan <b>Start Camera</b> untuk deteksi real-time, atau pilih tab Upload Image.';
      el.empty.hidden = false;
    } else {
      el.emptyTitle.textContent = 'Belum ada gambar';
      el.emptyHint.innerHTML = 'Tekan <b>Upload Image</b> atau seret file gambar ke sini, lalu tekan <b>Detect</b>.';
      el.empty.hidden = Boolean(state.uploadedImage);
    }
  }

  function setTabsLocked(locked) {
    document.querySelectorAll('.tab').forEach((t) => { if (t.dataset.mode !== state.mode) t.disabled = locked; });
  }

  function setMode(mode) {
    if (mode === state.mode) return;
    if (state.running) stopCamera();
    state.mode = mode;
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.mode === mode;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on);
    });
    el.cameraControls.hidden = mode !== 'camera';
    el.uploadControls.hidden = mode !== 'upload';
    el.video.hidden = true;
    el.preview.hidden = mode !== 'upload' || !state.uploadedImage;
    resetResults();
    if (mode === 'upload' && state.uploadedImage) {
      sizeOverlay(state.uploadedImage.naturalWidth, state.uploadedImage.naturalHeight);
    } else {
      el.meta.textContent = '— × —';
    }
    showEmpty();
  }

  // ---------- events ----------
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
  el.startBtn.addEventListener('click', () => startCamera());
  el.stopBtn.addEventListener('click', stopCamera);
  el.cameraSelect.addEventListener('change', () => { if (state.running) startCamera(el.cameraSelect.value); });
  el.fileInput.addEventListener('change', () => { loadFile(el.fileInput.files[0]); el.fileInput.value = ''; });
  el.detectBtn.addEventListener('click', detectUpload);
  el.confSlider.addEventListener('input', () => {
    state.threshold = Number(el.confSlider.value) / 100;
    el.confValue.textContent = `${el.confSlider.value}%`;
    drawBoxes();
    renderPanels(null);
  });

  el.viewport.addEventListener('dragover', (e) => { if (state.mode === 'upload') { e.preventDefault(); el.viewport.classList.add('live'); } });
  el.viewport.addEventListener('dragleave', () => { if (state.mode === 'upload') el.viewport.classList.remove('live'); });
  el.viewport.addEventListener('drop', (e) => {
    if (state.mode !== 'upload') return;
    e.preventDefault();
    el.viewport.classList.remove('live');
    loadFile(e.dataTransfer.files[0]);
  });

  // Pause inference while the tab is hidden; the loop resumes automatically.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.running && !state.busy) scheduleNext(0); });
  window.addEventListener('pagehide', stopStream);

  state.threshold = Number(el.confSlider.value) / 100;
  setStatus('booting');
  log('Memulai sistem…');
  healthCheck();
})();
