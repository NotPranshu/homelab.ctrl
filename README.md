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

### Docker (Linux server)

Install Docker and Compose on the server, then copy the project directory there:

```bash
git clone YOUR_REPOSITORY_URL homelab.ctrl
cd homelab.ctrl
```

Copy `.env.example` to `.env` and set a long random API key. `HOMELAB_FILES_PATH` controls which host directory the file manager can access:

```dotenv
cp .env.example .env
```

Then edit `.env`:

```dotenv
HOMELAB_API_KEY=replace-with-a-long-random-secret
HOMELAB_FILES_PATH=/srv/homelab
HOMELAB_ALLOWED_ORIGIN=http://YOUR_SERVER_IP:3001
```

Build and start the container:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f homelab
```

Open `http://YOUR_SERVER_IP:3001`. In the app settings, use that same address for the HTTP API URL and WebSocket URL, and enter the API key from `.env`.

The Compose configuration mounts the Docker socket so Docker controls work and uses host PID mode so system metrics can see host processes. The socket grants administrative access to the Docker host; protect the API key and keep the service behind a trusted network or reverse proxy.

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

In the browser app, go to **Settings** and set:
- **HTTP API URL**: `http://YOUR_SERVER_IP:3001`
- **WebSocket URL**: `ws://YOUR_SERVER_IP:3001`
- **API Key**: the value used for `HOMELAB_API_KEY`

For a secure remote deployment, start the backend with an API key and a restricted file root:

```bash
export HOMELAB_API_KEY='replace-with-a-long-random-secret'
export HOMELAB_FILES_ROOT=/srv/homelab
export HOMELAB_ALLOWED_ORIGIN=https://homelab.example.com
export HOST=0.0.0.0
node server.js
```

The server refuses to bind to a non-loopback host unless `HOMELAB_API_KEY` is set. By default it listens only on `127.0.0.1`, limits file operations to the user home directory, and rejects filesystem traversal outside that root.

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

The backend supports bearer API-key authentication for all `/api/*` routes and API-key validation for WebSocket upgrades. It also sends basic security headers, limits JSON request size, restricts CORS to `HOMELAB_ALLOWED_ORIGIN`, and defaults to loopback binding.

Keep the app behind HTTPS and a VPN or authenticated reverse proxy when exposing it beyond localhost. Never send SSH passwords or private keys over an unencrypted `http://` or `ws://` connection.

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
