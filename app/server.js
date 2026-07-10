'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const os    = require('os');

const PORT = parseInt(process.env.PORT || '3000', 10);

// ── In-cluster service account paths ─────────────────────────────────────────
// k3s and RKE2 both use projected (bound) service account tokens.
// These are rotated by the kubelet every ~1 hour, so the token MUST be
// re-read from disk on every API call — never cached at module level.
const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const CA_PATH    = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

// KUBERNETES_SERVICE_HOST / PORT are injected by k3s and RKE2 automatically.
// On Rancher Desktop (k3s) this is typically 10.43.0.1 (the ClusterIP of
// the kubernetes service). Never hardcode — always read from env.
const K8S_HOST = process.env.KUBERNETES_SERVICE_HOST;
const K8S_PORT = process.env.KUBERNETES_SERVICE_PORT || '443';

// ── K8s API request ───────────────────────────────────────────────────────────
// Timeout of 5 s prevents hanging on slow nodes under load.
// Token and CA are read fresh on each call to survive projected token rotation.
function k8sGet(path) {
  return new Promise((resolve, reject) => {
    if (!K8S_HOST) {
      return reject(new Error('KUBERNETES_SERVICE_HOST not set — not running in-cluster'));
    }

    let token, ca;
    try {
      token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
      ca    = fs.readFileSync(CA_PATH);
    } catch (e) {
      return reject(new Error(`Cannot read service account credentials: ${e.message}`));
    }

    const opts = {
      hostname: K8S_HOST,
      port:     K8S_PORT,
      path,
      method:   'GET',
      headers:  { Authorization: `Bearer ${token}` },
      ca,
      // Enforce a hard timeout — critical on resource-constrained nodes
      timeout:  5000,
    };

    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`K8s API ${path} returned HTTP ${res.statusCode}`));
        }
        try   { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Non-JSON response from K8s API at ${path}`)); }
      });
    });

    // https.request timeout fires the 'timeout' event — must explicitly abort
    req.on('timeout', () => {
      req.destroy(new Error(`K8s API request to ${path} timed out after 5 s`));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Distribution detection ────────────────────────────────────────────────────
// k3s  gitVersion: v1.29.3+k3s1
// RKE2 gitVersion: v1.29.3+rke2r1
// Vanilla:         v1.29.3
function detectDistribution(gitVersion) {
  if (!gitVersion || gitVersion === 'unknown') return 'Kubernetes';
  if (gitVersion.includes('+k3s'))  return 'k3s';
  if (gitVersion.includes('+rke2')) return 'RKE2';
  return 'Kubernetes';
}

// ── Node role detection ───────────────────────────────────────────────────────
// k3s:  node-role.kubernetes.io/master  (older) or control-plane
// RKE2: node-role.kubernetes.io/control-plane + etcd
function detectNodeRole(labels) {
  if (!labels) return 'worker';
  const l = Object.keys(labels);
  const roles = [];
  if (l.some(k => k.includes('control-plane') || k.includes('master'))) roles.push('control-plane');
  if (l.some(k => k.includes('etcd')))                                   roles.push('etcd');
  if (l.some(k => k.includes('worker') || k.includes('agent')))          roles.push('worker');
  return roles.length ? roles.join('+') : 'worker';
}

// ── Response cache — 60 s TTL ─────────────────────────────────────────────────
// Prevents hammering the API server on every browser refresh.
// Cache is intentionally short so node additions/removals show up quickly.
let cache     = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

async function getClusterInfo() {
  const now = Date.now();
  if (cache && (now - cacheTime) < CACHE_TTL) return cache;

  const info = {};

  // ── Downward API env vars — always available, no API call needed ──────────
  info.nodeName    = process.env.NODE_NAME     || os.hostname();
  info.podName     = process.env.POD_NAME      || os.hostname();
  info.namespace   = process.env.POD_NAMESPACE || 'default';
  info.podIP       = process.env.POD_IP        || '0.0.0.0';
  info.hostIP      = process.env.HOST_IP       || '0.0.0.0';
  info.clusterName = process.env.CLUSTER_NAME  || 'LEDGER-CORE-01';
  info.nodeArch    = process.arch;
  info.nodeRole    = 'worker';
  info.distribution = 'k3s'; // will be confirmed from /version
  info.k8sVersion  = 'unknown';
  info.nodeCount   = '?';

  // ── OS release from the container's /etc/os-release (BCI = SUSE Linux) ───
  try {
    const raw   = fs.readFileSync('/etc/os-release', 'utf8');
    const line  = raw.split('\n').find(l => l.startsWith('PRETTY_NAME'));
    info.osRelease = line
      ? line.split('=')[1].replace(/"/g, '').trim()
      : 'SUSE Linux Micro';
  } catch {
    info.osRelease = 'SUSE Linux Micro';
  }

  // ── GET /version — K8s server version + distribution detection ────────────
  try {
    const ver        = await k8sGet('/version');
    info.k8sVersion  = ver.gitVersion  || 'unknown';
    info.distribution = detectDistribution(ver.gitVersion);
  } catch (e) {
    console.warn(`[vertex-bank] /version: ${e.message}`);
  }

  // ── GET /api/v1/nodes — node count, arch, OS image, role ─────────────────
  try {
    const nodes    = await k8sGet('/api/v1/nodes');
    const items    = nodes.items || [];
    info.nodeCount = String(items.length);

    // Find this specific node to get its arch, OS, and role labels
    const thisNode = items.find(n => n.metadata.name === info.nodeName);
    if (thisNode) {
      const ni = thisNode.status?.nodeInfo || {};
      info.nodeArch  = ni.architecture || info.nodeArch;
      // Prefer the node's reported OS over the container's /etc/os-release —
      // the node runs SUSE Linux Micro, the container runs BCI; we want the
      // host OS for the cluster info display
      if (ni.osImage) info.osRelease = ni.osImage;
      // Use kubelet version as fallback if /version call failed
      if (info.k8sVersion === 'unknown' && ni.kubeletVersion) {
        info.k8sVersion   = ni.kubeletVersion;
        info.distribution = detectDistribution(ni.kubeletVersion);
      }
      info.nodeRole = detectNodeRole(thisNode.metadata?.labels);
    }
  } catch (e) {
    console.warn(`[vertex-bank] /api/v1/nodes: ${e.message}`);
  }

  // ── System metrics — always available via Node.js os module ──────────────
  const total      = os.totalmem();
  const free       = os.freemem();
  info.memTotal    = formatBytes(total);
  info.memUsed     = formatBytes(total - free);
  info.memPercent  = Math.round(((total - free) / total) * 100);
  info.cpuCount    = os.cpus().length;
  info.cpuModel    = os.cpus()[0]?.model?.trim() || 'Unknown CPU';
  info.loadAvg     = os.loadavg().map(l => l.toFixed(2)).join(' / ');
  info.load1       = os.loadavg()[0];
  info.uptime      = formatUptime(os.uptime());
  info.timestamp   = new Date().toISOString();

  cache     = info;
  cacheTime = now;
  return info;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatBytes(b) {
  if (b < 1024)      return b + ' B';
  if (b < 1024 ** 2) return (b / 1024).toFixed(1)      + ' KB';
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(1) + ' MB';
  return                    (b / 1024 ** 3).toFixed(2)  + ' GB';
}

function formatUptime(s) {
  const d   = Math.floor(s / 86400);
  const h   = Math.floor((s % 86400) / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  return `${m}m ${sec}s`;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  if (req.url === '/api/info') {
    try {
      const info = await getClusterInfo();
      res.writeHead(200, {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'no-cache',
      });
      res.end(JSON.stringify(info));
    } catch (e) {
      console.error('[vertex-bank] /api/info error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    try {
      const html = fs.readFileSync('/app/index.html', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('Could not load index.html');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const dist = K8S_HOST ? `in-cluster (${K8S_HOST}:${K8S_PORT})` : 'standalone';
  console.log(`[vertex-bank] Vertex Trust Bank — Platform Operations Console`);
  console.log(`[vertex-bank] Listening on :${PORT}`);
  console.log(`[vertex-bank] Node: ${os.hostname()} | Arch: ${process.arch}`);
  console.log(`[vertex-bank] Mode: ${dist}`);
});
