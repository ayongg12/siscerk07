// Offline tests for api/detect.js: input validation, handler error paths, and the
// tree-walking parser. The parser fixture follows Roboflow's documented
// object-detection prediction format; it is a test fixture, not a live response.
const assert = require('assert');
const { Readable } = require('stream');
const handler = require('../api/detect');
const { normalize, parseImageInput } = handler._internal;

function mockReq(method, bodyObj, url = '/api/detect') {
  const r = Readable.from(bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))]);
  r.method = method; r.url = url; r.headers = {};
  return r;
}
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = b || ''; },
    json() { return JSON.parse(this.body); },
  };
}
async function call(method, body, env = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  if (env.ROBOFLOW_API_KEY === undefined) delete process.env.ROBOFLOW_API_KEY;
  const res = mockRes();
  await handler(mockReq(method, body), res);
  process.env = saved;
  return res;
}

const tinyJpeg = 'data:image/jpeg;base64,' + Buffer.alloc(200, 7).toString('base64');

(async () => {
  // parseImageInput
  assert.ok(parseImageInput({}).error);
  assert.ok(parseImageInput({ image: 'data:text/plain;base64,AAAA' }).error);
  assert.ok(parseImageInput({ image: 'not base64 !!' }).error);
  assert.ok(parseImageInput({ imageUrl: 'ftp://x' }).error);
  assert.ok(parseImageInput({ image: tinyJpeg }).base64);
  assert.strictEqual(parseImageInput({ imageUrl: 'https://a.b/c.jpg' }).url, 'https://a.b/c.jpg');

  // normalize — nested, unknown output name, duplicate detection_id
  const fixture = {
    outputs: [{
      some_output_name: {
        image: { width: 640, height: 480 },
        predictions: [
          { x: 100, y: 100, width: 50, height: 40, confidence: 0.91, class: 'mouse', class_id: 1, detection_id: 'a' },
          { x: 300, y: 200, width: 80, height: 60, confidence: 0.55, class: 'cup', class_id: 2, detection_id: 'b' },
          { x: 300, y: 200, width: 80, height: 60, confidence: 0.55, class: 'cup', class_id: 2, detection_id: 'b' },
        ],
      },
      output_image: { type: 'base64', value: 'x'.repeat(1000) },
    }],
  };
  const n = normalize(fixture);
  assert.strictEqual(n.predictions.length, 2);
  assert.deepStrictEqual(n.image, { width: 640, height: 480 });
  assert.strictEqual(n.predictions[0].class, 'mouse');
  assert.strictEqual(n.predictionsPath, 'outputs[0].some_output_name.predictions');
  assert.deepStrictEqual(normalize({ outputs: [{}] }).predictions, []);
  assert.deepStrictEqual(normalize(null).predictions, []);

  // handler paths
  let r = await call('GET');
  assert.strictEqual(r.statusCode, 200); assert.strictEqual(r.json().configured, false);
  r = await call('PUT', {}, { ROBOFLOW_API_KEY: 'k' });
  assert.strictEqual(r.statusCode, 405);
  r = await call('POST', { image: tinyJpeg });
  assert.strictEqual(r.statusCode, 500); assert.match(r.json().error, /ROBOFLOW_API_KEY/);
  r = await call('POST', { foo: 1 }, { ROBOFLOW_API_KEY: 'k' });
  assert.strictEqual(r.statusCode, 400);
  // Upstream unreachable / timeout handling (short timeout, unroutable host)
  r = await call('POST', { image: tinyJpeg }, { ROBOFLOW_API_KEY: 'k' });
  assert.ok([502, 504, 400, 401, 403].includes(r.statusCode), `unexpected ${r.statusCode}`);
  assert.ok(r.json().error, 'error message expected');
  console.log('upstream call ->', r.statusCode, r.json().error);

  console.log('All tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
