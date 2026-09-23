const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { Client } = require('ssh2');
const Docker = require('dockerode');
const si = require('systeminformation');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const API_KEY = process.env.HOMELAB_API_KEY || '';
const FILE_ROOT = path.resolve(process.env.HOMELAB_FILES_ROOT || os.homedir());
const ALLOWED_ORIGIN = process.env.HOMELAB_ALLOWED_ORIGIN || '';
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const wss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024 });

app.disable('x-powered-by');
app.use(cors({ origin: ALLOWED_ORIGIN || false }));
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; connect-src 'self' http: https: ws: wss:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:");
  next();
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/sw.js', (req, res) => res.sendFile(path.join(__dirname, 'sw.js')));

function isAuthorized(req) {
  return !API_KEY || req.get('authorization') === `Bearer ${API_KEY}`;
}

app.use('/api', (req, res, next) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

function resolveFilePath(requestedPath) {
  const candidate = requestedPath === '/' ? FILE_ROOT : path.resolve(String(requestedPath || FILE_ROOT));
  let existing = candidate;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  const realRoot = fs.realpathSync(FILE_ROOT);
  const realExisting = fs.realpathSync(existing);
  const relative = path.relative(realRoot, realExisting);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error('Path is outside the configured files root');
    error.code = 'ESECURITY';
    throw error;
  }
  return candidate;
}

// ─── Docker client ────────────────────────────────────────────────────────────
let docker = null;
try {
  docker = new Docker({ socketPath: '/var/run/docker.sock' });
} catch (e) {
  console.warn('Docker socket not available:', e.message);
}

// ─── Active SSH sessions ──────────────────────────────────────────────────────
const sshSessions = new Map();

// ─── WebSocket Handler ────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let sessionId = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── SSH Connect ──────────────────────────────────────────────────────────
      case 'ssh:connect': {
        const { id, host, port = 22, username, password, privateKey } = msg;
        if (!id || !host || !username || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
          ws.send(JSON.stringify({ type: 'ssh:error', id, message: 'Invalid SSH connection details' }));
          break;
        }
        sessionId = id;

        const conn = new Client();

        conn.on('ready', () => {
          conn.shell({ term: 'xterm-256color', rows: 40, cols: 220 }, (err, stream) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'ssh:error', id, message: err.message }));
              return;
            }

            sshSessions.set(id, { conn, stream });

            stream.on('data', (data) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ssh:data', id, data: data.toString('base64') }));
              }
            });

            stream.stderr.on('data', (data) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ssh:data', id, data: data.toString('base64') }));
              }
            });

            stream.on('close', () => {
              sshSessions.delete(id);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ssh:closed', id }));
              }
            });

            ws.send(JSON.stringify({ type: 'ssh:connected', id }));
          });
        });

        conn.on('error', (err) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ssh:error', id, message: err.message }));
          }
        });

        conn.on('close', () => {
          sshSessions.delete(id);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ssh:closed', id }));
          }
        });

        const connectConfig = {
          host, port, username,
          readyTimeout: 10000,
          keepaliveInterval: 10000,
        };

        if (privateKey) {
          connectConfig.privateKey = privateKey;
        } else if (password) {
          connectConfig.password = password;
        }

        try {
          conn.connect(connectConfig);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'ssh:error', id, message: err.message }));
        }
        break;
      }

      // ── SSH Input ────────────────────────────────────────────────────────────
      case 'ssh:input': {
        const { id, data } = msg;
        const session = sshSessions.get(id);
        if (session?.stream) {
          session.stream.write(Buffer.from(data, 'base64'));
        }
        break;
      }

      // ── SSH Resize ───────────────────────────────────────────────────────────
      case 'ssh:resize': {
        const { id, rows, cols } = msg;
        const session = sshSessions.get(id);
        if (session?.stream) {
          session.stream.setWindow(rows, cols);
        }
        break;
      }

      // ── SSH Disconnect ───────────────────────────────────────────────────────
      case 'ssh:disconnect': {
        const { id } = msg;
        const session = sshSessions.get(id);
        if (session) {
          session.stream?.end();
          session.conn?.end();
          sshSessions.delete(id);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (sessionId) {
      const session = sshSessions.get(sessionId);
      if (session) {
        session.stream?.end();
        session.conn?.end();
        sshSessions.delete(sessionId);
      }
    }
  });
});

// ─── System Metrics ───────────────────────────────────────────────────────────
app.get('/api/metrics', async (req, res) => {
  try {
    const [cpu, mem, disk, network, load, temp, procs, osInfo] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
      si.currentLoad(),
      si.cpuTemperature().catch(() => ({ main: null })),
      si.processes(),
      si.osInfo(),
    ]);

    const topProcs = (procs.list || [])
      .sort((a, b) => b.pcpu - a.pcpu)
      .slice(0, 10)
      .map(p => ({
        pid: p.pid,
        name: p.name,
        cpu: Number(p.pcpu || 0).toFixed(1),
        mem: Number(p.pmem || 0).toFixed(1),
        state: p.state,
        user: p.user,
      }));

    res.json({
      cpu: {
        usage: cpu.currentLoad?.toFixed(1),
        cores: os.cpus().length,
        model: os.cpus()[0]?.model,
        loadAvg: os.loadavg(),
        speed: os.cpus()[0]?.speed,
      },
      memory: {
        total: mem.total,
        used: mem.used,
        free: mem.free,
        available: mem.available,
        swapTotal: mem.swaptotal,
        swapUsed: mem.swapused,
        usedPercent: ((mem.used / mem.total) * 100).toFixed(1),
      },
      disk: disk.map(d => ({
        fs: d.fs,
        type: d.type,
        size: d.size,
        used: d.used,
        available: d.available,
        usePercent: d.use?.toFixed(1),
        mount: d.mount,
      })).filter(d => d.size > 0),
      network: (network || []).slice(0, 3).map(n => ({
        iface: n.iface,
        rxSec: n.rx_sec,
        txSec: n.tx_sec,
        rxBytes: n.rx_bytes,
        txBytes: n.tx_bytes,
      })),
      temperature: temp.main,
      processes: {
        total: procs.all,
        running: procs.running,
        list: topProcs,
      },
      uptime: os.uptime(),
      hostname: os.hostname(),
      platform: osInfo.platform,
      distro: osInfo.distro,
      kernel: osInfo.kernel,
      arch: osInfo.arch,
    });
  } catch (err) {
    console.error('Metrics error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── File System API ──────────────────────────────────────────────────────────
app.get('/api/files', (req, res) => {
  let safePath;
  try { safePath = resolveFilePath(req.query.path || '/'); } catch (err) { return res.status(403).json({ error: err.message }); }

  try {
    const entries = fs.readdirSync(safePath, { withFileTypes: true });
    const items = entries.map(e => {
      const fullPath = path.join(safePath, e.name);
      let stat = null;
      try { stat = fs.statSync(fullPath); } catch {}
      return {
        name: e.name,
        path: fullPath,
        type: e.isDirectory() ? 'dir' : 'file',
        size: stat?.size || 0,
        modified: stat?.mtime || null,
        isHidden: e.name.startsWith('.'),
      };
    });

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ path: safePath, items, parent: path.dirname(safePath) });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

app.get('/api/files/read', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'No path' });

  try {
    const safePath = resolveFilePath(filePath);
    const stat = fs.statSync(safePath);
    if (stat.size > 5 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large (>5MB)' });
    }
    const content = fs.readFileSync(safePath, 'utf8');
    res.json({ content, size: stat.size, modified: stat.mtime });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

app.post('/api/files/write', (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'No path' });
  try {
    fs.writeFileSync(resolveFilePath(filePath), String(content || ''), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

app.delete('/api/files', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'No path' });
  try {
    const safePath = resolveFilePath(filePath);
    if (safePath === FILE_ROOT) return res.status(403).json({ error: 'Cannot delete files root' });
    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) {
      fs.rmSync(safePath, { recursive: true, force: false });
    } else {
      fs.unlinkSync(safePath);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

app.post('/api/files/mkdir', (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'No path' });
  try {
    fs.mkdirSync(resolveFilePath(dirPath), { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

// ─── Docker API ───────────────────────────────────────────────────────────────
app.get('/api/docker/containers', async (req, res) => {
  if (!docker) return res.status(503).json({ error: 'Docker not available' });
  try {
    const containers = await docker.listContainers({ all: true });
    const detailed = await Promise.all(containers.map(async (c) => {
      let stats = null;
      if (c.State === 'running') {
        try {
          const container = docker.getContainer(c.Id);
          stats = await new Promise((resolve, reject) => {
            container.stats({ stream: false }, (err, s) => {
              if (err) reject(err);
              else resolve(s);
            });
          });
        } catch {}
      }

      let cpuPercent = '0.0';
      let memUsage = 0;
      let memLimit = 0;

      if (stats) {
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        const numCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
        cpuPercent = ((cpuDelta / sysDelta) * numCpus * 100).toFixed(2);
        memUsage = stats.memory_stats.usage || 0;
        memLimit = stats.memory_stats.limit || 0;
      }

      return {
        id: c.Id.slice(0, 12),
        fullId: c.Id,
        name: c.Names[0]?.replace('/', '') || 'unnamed',
        image: c.Image,
        status: c.State,
        statusText: c.Status,
        created: c.Created,
        ports: c.Ports?.map(p => p.PublicPort ? `${p.IP || '0.0.0.0'}:${p.PublicPort}->${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`).join(', ') || '—',
        cpu: cpuPercent + '%',
        memUsage,
        memLimit,
        memPercent: memLimit > 0 ? ((memUsage / memLimit) * 100).toFixed(1) : '0',
        networkMode: c.HostConfig?.NetworkMode,
      };
    }));
    res.json(detailed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/docker/containers/:id/:action', async (req, res) => {
  if (!docker) return res.status(503).json({ error: 'Docker not available' });
  const { id, action } = req.params;
  try {
    const container = docker.getContainer(id);
    if (action === 'start') await container.start();
    else if (action === 'stop') await container.stop();
    else if (action === 'restart') await container.restart();
    else if (action === 'remove') await container.remove({ force: true });
    else return res.status(400).json({ error: 'Unknown action' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/docker/containers/:id/logs', async (req, res) => {
  if (!docker) return res.status(503).json({ error: 'Docker not available' });
  try {
    const container = docker.getContainer(req.params.id);
    const logs = await container.logs({ stdout: true, stderr: true, tail: 100, timestamps: true });
    const cleaned = logs.toString().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    res.json({ logs: cleaned });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/docker/images', async (req, res) => {
  if (!docker) return res.status(503).json({ error: 'Docker not available' });
  try {
    const images = await docker.listImages({ all: false });
    res.json(images.map(img => ({
      id: img.Id.replace('sha256:', '').slice(0, 12),
      repoTags: img.RepoTags || ['<none>:<none>'],
      size: img.Size,
      created: img.Created,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/docker/images/:id', async (req, res) => {
  if (!docker) return res.status(503).json({ error: 'Docker not available' });
  try {
    const image = docker.getImage(req.params.id);
    await image.remove({ force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/docker/info', async (req, res) => {
  if (!docker) return res.status(503).json({ error: 'Docker not available' });
  try {
    const info = await docker.info();
    res.json({
      version: info.ServerVersion,
      containers: info.Containers,
      running: info.ContainersRunning,
      paused: info.ContainersPaused,
      stopped: info.ContainersStopped,
      images: info.Images,
      memTotal: info.MemTotal,
      cpus: info.NCPU,
      driver: info.Driver,
      os: info.OperatingSystem,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    docker: docker !== null,
    uptime: process.uptime(),
    hostname: os.hostname(),
    platform: os.platform(),
    authRequired: Boolean(API_KEY),
    filesRoot: FILE_ROOT,
  });
});

// Keep assistant requests on the backend so the browser does not need an API key.
app.post('/api/assistant', (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'Question is required' });

  const q = question.toLowerCase();
  let answer = 'I can help inspect the live server. Open Monitor for current metrics, or use SSH for a command-level investigation.';
  if (q.includes('cpu')) answer = 'Start with Monitor > Top Processes. If one process is dominating, inspect it in SSH with `ps aux --sort=-%cpu | head -20`. Check load average against your CPU core count before treating a spike as a problem.';
  else if (q.includes('memory') || q.includes('ram')) answer = 'Check the Memory gauge and swap usage first. In SSH, run `free -h` and `ps aux --sort=-%mem | head -15`. A high cache value is usually reclaimable; sustained swap use is the stronger warning sign.';
  else if (q.includes('disk')) answer = 'Monitor shows usage by mount. To find the source of growth, run `du -xhd1 / | sort -h` and then inspect the largest directory. Keep a safety margin for Docker layers, logs, and package caches.';
  else if (q.includes('docker')) answer = 'Use Docker for a quick container overview, then open a container to inspect logs. In SSH, `docker system df` shows reclaimable space and `docker ps --format "table {{.Names}}\\t{{.Status}}"` gives a clean status list.';
  else if (q.includes('backup')) answer = 'A practical baseline is: define what must be restorable, snapshot application data rather than containers, keep one copy off-host, and schedule a restore test. Start by listing volumes with `docker volume ls`.';
  res.json({ answer });
});

server.on('upgrade', (req, socket, head) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (requestUrl.pathname !== '/ws' || (API_KEY && requestUrl.searchParams.get('key') !== API_KEY)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

if (!API_KEY && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  throw new Error('HOMELAB_API_KEY is required when HOST is not loopback');
}
server.listen(PORT, HOST, () => {
  console.log(`\n🚀 Homelab backend running on http://${HOST}:${PORT}`);
  console.log(`   WebSocket: ws://${HOST}:${PORT}/ws`);
  console.log(`   Auth:      ${API_KEY ? '✓ API key required' : '⚠ disabled (set HOMELAB_API_KEY)'}`);
  console.log(`   Files:     ${FILE_ROOT}`);
  console.log(`   Docker:    ${docker ? '✓ connected' : '✗ not available'}`);
  console.log(`   Host:      ${os.hostname()}\n`);
});
