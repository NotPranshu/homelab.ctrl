# HOMELAB.CTRL

A homelab assistant with live SSH terminals, system metrics, file management, and Docker control.

## Stack

- **Backend**: Node.js + Express + WebSocket
- **SSH**: `ssh2` -> real interactive shell sessions
- **Metrics**: `systeminformation` —> CPU, RAM, disk, network, temperature, processes
- **Docker**: `dockerode` —> real Docker daemon via `/var/run/docker.sock`
- **Files**: Node.js `fs` —> real filesystem read/write
- **Frontend**: React

---

## Quick Start

### 1. Copy files to your server

```bash
scp server.js package.json user@YOUR_SERVER:~/homelab/
```

### 2. Install dependencies

```bash
cd ~/homelab
npm install
```

### 3. Run the backend

```bash
# Basic
node server.js

# Background (persist after logout)
nohup node server.js > homelab.log 2>&1 &

# Or with PM2 (recommended)
npm install -g pm2
pm2 start server.js --name homelab
pm2 save && pm2 startup
```

### 4. Configure the frontend

In the React app, go to **Settings** and set:
- **HTTP API URL**: `http://YOUR_SERVER_IP:3001`
- **WebSocket URL**: `ws://YOUR_SERVER_IP:3001`

---

## Ports & Firewall

The backend listens on port **3001**. Open it if needed:

```bash
# UFW
sudo ufw allow 3001

# iptables
sudo iptables -A INPUT -p tcp --dport 3001 -j ACCEPT

# firewalld
sudo firewall-cmd --permanent --add-port=3001/tcp && sudo firewall-cmd --reload
```

---

## Docker Access

For the Docker API to work, run the backend as root **or** add your user to the docker group:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

Then restart the server.

---

## SSH Access

The SSH terminal connects directly from the backend to any SSH host you specify in the UI. You can:
- SSH into the same machine running the backend (`localhost`)
- SSH into any other machine on your network
- Use password or private key authentication

For key-based auth, paste your private key into the "Private Key" field (or add a key field to the UI).

---

## Security Notes

⚠️ **This backend has no authentication.** For production use:

1. **Bind to localhost only** and use a reverse proxy (nginx/caddy) with auth
2. Or add API key middleware to Express
3. Or use Tailscale/VPN to restrict access

Example nginx config with basic auth:
```nginx
location /api/ {
    auth_basic "Homelab";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://localhost:3001/api/;
}
location /ws {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/health` | GET | Backend health + Docker status |
| `GET /api/metrics` | GET | CPU, memory, disk, network, temp, processes |
| `GET /api/files?path=` | GET | List directory |
| `GET /api/files/read?path=` | GET | Read file content |
| `POST /api/files/write` | POST | Write file content |
| `DELETE /api/files?path=` | DELETE | Delete file/directory |
| `POST /api/files/mkdir` | POST | Create directory |
| `GET /api/docker/containers` | GET | List all containers with stats |
| `POST /api/docker/containers/:id/start` | POST | Start container |
| `POST /api/docker/containers/:id/stop` | POST | Stop container |
| `POST /api/docker/containers/:id/restart` | POST | Restart container |
| `GET /api/docker/containers/:id/logs` | GET | Get container logs |
| `GET /api/docker/images` | GET | List images |
| `DELETE /api/docker/images/:id` | DELETE | Remove image |
| `GET /api/docker/info` | GET | Docker daemon info |

**WebSocket** (`ws://host:3001`):
- `ssh:connect` — Open SSH shell session
- `ssh:input` — Send keystrokes (base64)
- `ssh:resize` — Resize terminal window
- `ssh:disconnect` — Close session

---

## Systemd Service (optional)

Create `/etc/systemd/system/homelab.service`:

```ini
[Unit]
Description=Homelab Assistant Backend
After=network.target

[Service]
ExecStart=/usr/bin/node /home/admin/homelab/server.js
WorkingDirectory=/home/admin/homelab
Restart=always
User=admin
Environment=PORT=3001

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable homelab
sudo systemctl start homelab
sudo systemctl status homelab
```
