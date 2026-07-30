#!/usr/bin/env bash
# Deploy the landing page and the workspace UI to the Pinout VM.
#
# One Next.js app serves both: / is the landing page, /app is the workspace.
# It talks to the club API on the same host, so the browser needs a public URL
# for it rather than localhost, which is what NEXT_PUBLIC_CLUB_URL carries.
set -euo pipefail

RG=${RG:-pinout-rg}
VM=${VM:-pinout-vm}
IP=${IP:-20.1.144.110}

az vm run-command invoke -g "$RG" -n "$VM" --command-id RunShellScript --scripts "
export HOME=/root
set -e
cd /home/pinout/pinout
git config --global --add safe.directory /home/pinout/pinout
sudo -u pinout git fetch -q origin main
sudo -u pinout git reset -q --hard origin/main
cd web
echo 'NEXT_PUBLIC_CLUB_URL=https://api.pinout.club' > .env.production
chown pinout:pinout .env.production
sudo -u pinout npm install --no-audit --no-fund 2>&1 | tail -2
sudo -u pinout npx next build 2>&1 | tail -4
chown -R pinout:pinout /home/pinout/pinout/web

cat > /etc/systemd/system/pinout-web.service <<'UNIT'
[Unit]
Description=Pinout site: landing page and agent workspace
After=network.target

[Service]
Type=simple
User=pinout
WorkingDirectory=/home/pinout/pinout/web
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/npx next start -p 3000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable -q pinout-web
systemctl restart pinout-web
sleep 8
systemctl is-active pinout-web
" --query "value[0].message" -o tsv | tail -12

az network nsg rule create -g "$RG" --nsg-name "${VM}NSG" -n web-3000 \
  --priority 1020 --destination-port-ranges 3000 --protocol Tcp \
  --access Allow --direction Inbound -o none 2>/dev/null || true

echo "landing   http://$IP:3000"
echo "workspace http://$IP:3000/app"
