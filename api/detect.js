// Vercel Serverless Function: /api/detect
// Proxies an image to the Roboflow Workflow and returns normalized detections.
// The API key lives only in process.env.ROBOFLOW_API_KEY and never reaches the browser.

const WORKFLOW_URL =
  process.env.ROBOFLOW_WORKFLOW_URL ||
  'https://serverless.roboflow.com/marias-workspace-latfm/workflows/benda-meja-kelompok-10';

const TIMEOUT_MS = Number(process.env.ROBOFLOW_TIMEOUT_MS || 25000);
const MAX_BASE64_CHARS = 4_000_000; // ~3 MB binary; Vercel request body limit is 4.5 MB

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4.5 * 1024 * 1024) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// Accepts a data URL or bare base64 string; returns { base64 } or { error }.
function parseImageInput(body) {
  if (body && typeof body.imageUrl === 'string' && body.imageUrl.trim()) {
    const url = body.imageUrl.trim();
    if (!/^https?:\/\//i.test(url)) return { error: 'imageUrl must be an http(s) URL' };
    return { url };
  }
  const img = body && body.image;
  if (typeof img !== 'string' || !img) return { error: 'Field "image" (base64 or data URL) or "imageUrl" is required' };

  let b64 = img;
  const m = /^data:(image\/(?:jpeg|jpg|png|webp|bmp));base64,(.+)$/i.exec(img);
  if (img.startsWith('data:')) {
    if (!m) return { error: 'Unsupported data URL. Use image/jpeg, image/png, image/webp or image/bmp' };
    b64 = m[2];
  }
  b64 = b64.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { error: 'Image is not valid base64' };
  if (b64.length < 100) return { error: 'Image data is too small' };
  if (b64.length > MAX_BASE64_CHARS) return { error: 'Image too large (max ~3 MB). Resize before sending.', status: 413 };
  return { base64: b64 };
}

// --- Response parsing ------------------------------------------------------
// Roboflow Workflows return { outputs: [ { <output_name>: ... } ] }. The output
// names depend on how the workflow was built, so instead of hard-coding a path we
// walk the tree and pick up every array of detection-like objects.

function isDetection(o) {
  return (
    o && typeof o === 'object' &&
    ['x', 'y', 'width', 'height'].every((k) => typeof o[k] === 'number') &&
    (typeof o.class === 'string' || typeof o.class_name === 'string' || typeof o.label === 'string')
  );
}

function collect(node, path, found, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) {
    if (node.length && node.every(isDetection)) {
      found.detections.push({ path, items: node });
      return;
    }
    node.forEach((child, i) => collect(child, `${path}[${i}]`, found, depth + 1));
    return;
  }
  if (node.image && typeof node.image.width === 'number' && typeof node.image.height === 'number' && !found.image) {
    found.image = { width: node.image.width, height: node.image.height };
  }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'number' && /(^time$|inference_time|processing_time)/i.test(k) && found.time == null) {
      found.time = v;
    }
    collect(v, path ? `${path}.${k}` : k, found, depth + 1);
  }
}

function normalize(data) {
  const found = { detections: [], image: null, time: null };
  collect(data && data.outputs !== undefined ? data.outputs : data, 'outputs', found);

  // Use the first detection array found (workflows usually expose one), dedupe by detection_id.
  const source = found.detections[0];
  const seen = new Set();
  const predictions = (source ? source.items : [])
    .filter((p) => {
      const id = p.detection_id;
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((p) => ({
      class: String(p.class ?? p.class_name ?? p.label),
      confidence: typeof p.confidence === 'number' ? p.confidence : null,
      x: p.x, y: p.y, width: p.width, height: p.height,
    }));

  return {
    predictions,
    image: found.image,
    modelTimeMs: found.time == null ? null : Math.round(found.time < 50 ? found.time * 1000 : found.time),
    predictionsPath: source ? source.path : null,
    outputKeys: Array.isArray(data && data.outputs) && data.outputs[0] && typeof data.outputs[0] === 'object'
      ? Object.keys(data.outputs[0])
      : [],
  };
}

// Strips huge base64 strings so the raw structure can be inspected with ?debug=1.
function redactLargeStrings(node) {
  if (typeof node === 'string') return node.length > 300 ? `<string ${node.length} chars>` : node;
  if (Array.isArray(node)) return node.map(redactLargeStrings);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, redactLargeStrings(v)]));
  }
  return node;
}

module.exports = async function handler(req, res) {
  const apiKey = process.env.ROBOFLOW_API_KEY;

  if (req.method === 'GET') {
    return send(res, 200, { ok: true, service: 'detect', configured: Boolean(apiKey) });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'Method not allowed' });
  }
  if (!apiKey) {
    return send(res, 500, { error: 'Server is not configured: ROBOFLOW_API_KEY environment variable is missing' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return send(res, e.status || 400, { error: e.status === 413 ? 'Payload too large' : 'Invalid JSON body' });
  }

  const parsed = parseImageInput(body);
  if (parsed.error) return send(res, parsed.status || 400, { error: parsed.error });

  const image = parsed.url ? { type: 'url', value: parsed.url } : { type: 'base64', value: parsed.base64 };
  const debug = /(^|[?&])debug=1(&|$)/.test(req.url || '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  let upstream;
  try {
    upstream = await fetch(WORKFLOW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      // Inference v1.5.0+: API key is read from the Authorization header.
      body: JSON.stringify({ inputs: { image } }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      return send(res, 504, { error: `Roboflow did not respond within ${TIMEOUT_MS / 1000}s` });
    }
    return send(res, 502, { error: `Could not reach Roboflow: ${e.message}` });
  }
  clearTimeout(timer);
  const roundTripMs = Date.now() - started;

  const text = await upstream.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    return send(res, 502, { error: `Roboflow returned non-JSON response (HTTP ${upstream.status})` });
  }

  if (!upstream.ok) {
    const msg = (data && (data.message || data.error || data.detail)) || `HTTP ${upstream.status}`;
    const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status >= 500 ? 502 : upstream.status;
    return send(res, status, {
      error: `Roboflow error: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`,
      upstreamStatus: upstream.status,
    });
  }

  const result = normalize(data);
  return send(res, 200, {
    ...result,
    count: result.predictions.length,
    roundTripMs,
    ...(debug ? { raw: redactLargeStrings(data) } : {}),
  });
};

module.exports._internal = { normalize, parseImageInput };
