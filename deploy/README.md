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

The VM is deliberately small. It only brokers payments and meters. All heavy
compute runs on Daytona and Modal, so the host needs no CPU or GPU of its own.

## Live deployment

```
http://20.1.144.110:4021          Standard_D2alds_v7 (2 vCPU / 4 GiB), eastus2, systemd
```

**Capacity note:** `Standard_B2s` is capacity-restricted on this subscription in
eastus, westus2 and centralus (`SkuNotAvailable`). Quota was not the problem, with 0 of 65 vCPUs used. The script now defaults to `Standard_D2alds_v7` in eastus2,
picked by enumerating unrestricted SKUs. If that fails, list what is actually
available rather than guessing:

```bash
az vm list-skus -l <region> --resource-type virtualMachines -o json \
  | jq -r '.[] | select(.restrictions == []) | .name'
```

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
