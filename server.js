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
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

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
        cpu: p.pcpu?.toFixed(1),
        mem: p.pmem?.toFixed(1),
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
  const dirPath = req.query.path || os.homedir();
  const safePath = path.resolve(dirPath);

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
    const stat = fs.statSync(filePath);
    if (stat.size > 5 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large (>5MB)' });
    }
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ content, size: stat.size, modified: stat.mtime });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

app.post('/api/files/write', (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'No path' });
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

app.delete('/api/files', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'No path' });
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmdirSync(filePath, { recursive: true });
    } else {
      fs.unlinkSync(filePath);
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
    fs.mkdirSync(dirPath, { recursive: true });
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
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 Homelab backend running on http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   Docker:    ${docker ? '✓ connected' : '✗ not available'}`);
  console.log(`   Host:      ${os.hostname()}\n`);
});
