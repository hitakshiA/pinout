#!/usr/bin/env bash
# Provision + deploy Pinout Compute to an Azure VM.
#
# PREREQUISITE — run once, interactively (tenant enforces MFA via security
# defaults, so this cannot be automated):
#   az login --tenant 03af6641-aa14-4dec-9691-e465dc5affa9
#
# Then: bash deploy/azure.sh
set -euo pipefail

RG="${RG:-pinout-rg}"
LOC="${LOC:-eastus2}"
VM="${VM:-pinout-vm}"
SIZE="${SIZE:-Standard_D2alds_v7}"   # B-series is capacity-restricted on this subscription in eastus/westus2/centralus
PORT="${PORT:-4021}"
ADMIN="${ADMIN:-pinout}"

echo "==> resource group"
az group create -n "$RG" -l "$LOC" -o none

echo "==> vm"
az vm create -g "$RG" -n "$VM" --image Ubuntu2204 --size "$SIZE" \
  --admin-username "$ADMIN" --generate-ssh-keys --public-ip-sku Standard -o none

echo "==> open $PORT"
az vm open-port -g "$RG" -n "$VM" --port "$PORT" --priority 1001 -o none

IP=$(az vm show -d -g "$RG" -n "$VM" --query publicIps -o tsv)
echo "==> public ip: $IP"

echo "==> provisioning host"
ssh -o StrictHostKeyChecking=no "$ADMIN@$IP" bash -s <<'REMOTE'
set -euo pipefail
sudo apt-get update -qq
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
sudo apt-get install -y -qq nodejs git
mkdir -p ~/pinout
REMOTE

echo "==> uploading source (excluding secrets and deps)"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .venv \
  --exclude .env --exclude sessions.jsonl --exclude '*.log' \
  ./ "$ADMIN@$IP:~/pinout/"

echo "==> uploading .env separately (never in git, never in the image)"
scp -q .env "$ADMIN@$IP:~/pinout/.env"

echo "==> install + service"
ssh "$ADMIN@$IP" bash -s <<REMOTE
set -euo pipefail
cd ~/pinout && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1
sudo tee /etc/systemd/system/pinout.service >/dev/null <<UNIT
[Unit]
Description=Pinout Compute
After=network.target

[Service]
Type=simple
User=$ADMIN
WorkingDirectory=/home/$ADMIN/pinout
Environment=PORT=$PORT
Environment=PUBLIC_URL=http://$IP:$PORT
ExecStart=/usr/bin/node -e "import('./src/server.mjs').then(m=>m.start())"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now pinout
sleep 5
systemctl is-active pinout
REMOTE

echo "==> live at http://$IP:$PORT"
curl -fsS "http://$IP:$PORT/" | head -c 300; echo
echo "$IP" > deploy/.public-ip
