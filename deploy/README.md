# Deploying Pinout Compute

## Azure

One prerequisite that **cannot be automated**: this tenant enforces MFA through
Azure security defaults, so every management call fails with `AADSTS530035`
until a human logs in interactively.

```bash
az login --tenant 03af6641-aa14-4dec-9691-e465dc5affa9
bash deploy/azure.sh
```

The script provisions a `Standard_B2s` Ubuntu 22.04 VM, opens the service port,
installs Node 20, uploads the source (secrets excluded), copies `.env`
separately, and runs the server under systemd with `Restart=always`.

The VM is deliberately small — it only brokers payments and meters. All heavy
compute runs on Daytona and Modal, so the host needs no CPU or GPU of its own.

## Anything else with SSH

`deploy/azure.sh` is mostly provider-agnostic; only the first three `az`
commands are Azure-specific. Point `IP` at any Ubuntu host with SSH and the
remainder works unchanged.

## Before exposing publicly

Testnet HBAR is free from a faucet, so the payment gate provides **no economic
friction** on testnet. A public deployment that runs arbitrary code needs one of:

- mainnet settlement (real HBAR = real friction), or
- an allowlist of payer accounts, or
- hard provider spend caps plus egress and wall-clock limits

See `PUBLIC_RELEASE.md`.
