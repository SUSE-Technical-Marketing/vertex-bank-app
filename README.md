# 🏦 Vertex Trust Bank — Platform Operations Console

> A modern operations dashboard for the **SUSE Virtualization rodeo** bank story.
> It queries the Kubernetes API at runtime and shows live cluster vitals in a
> fintech "platform ops" UI, dressed up as Vertex Trust Bank's core ledger.
> Same engine as the KubeCon `alien-geeko` demo, reskinned for the bank narrative.

**Please read the disclaimer at the bottom before using this app.**

---

## What It Does

`vertex-bank-app` is a single-pod Node.js application that renders a banking
operations console in the browser. It talks to the Kubernetes API using the
service account token that Kubernetes mounts automatically. No init containers,
no ConfigMap patching, no database, no external calls.

The console shows two kinds of data:

- **Real cluster vitals** pulled live from the K8s API and the node.
- **Simulated bank flavor** (transactions per second, ledger sync, fraud scan)
  computed in the browser purely for story immersion. These panels are tagged
  `simulated` in the UI. They are cosmetic and never leave the page.

### Real data sources

| Field | Source |
|---|---|
| K8s version | `GET /version` via K8s API |
| Distribution | Detected from `gitVersion` (`+k3s1` / `+rke2r1` suffix) |
| Node count | `GET /api/v1/nodes` via K8s API |
| Node architecture / role / OS image | Node status and labels |
| Pod / Host IP, Pod / Node name, Namespace | Downward API |
| Instance name | ConfigMap `vertex-bank-config` (`CLUSTER_NAME`) |
| CPU count / model, memory, load average, uptime | Node.js `os` module |

API results are cached for **60 seconds** to keep load off the API server.

---

## The Story

In the SUSE Virtualization rodeo, **Vertex Trust Bank** is migrating off an
expensive legacy hypervisor onto SUSE Virtualization (Harvester HCI) managed by
Rancher Prime. The final chapter extracts the `legacy-ledger-vm` off the old
ISAware cluster while it stays online. This console is the live view the bank's
platform team watches while that migration happens: node health, ledger cluster
status, and a busy activity stream to sell the moment on a booth screen.

Palette: SUSE green `#30ba78`, bank gold `#d4af37`, danger red `#ff4d4d`, in the
SUSE typeface. Light and dark themes both supported (follows the browser).

---

## Repository Layout

```
vertex-bank-app/
├── Dockerfile                  # Multi-arch BCI Node.js 20 image
├── fleet.yaml                  # Fleet bundle — targeting + overlays
├── app/
│   ├── server.js               # Node.js HTTP server + K8s API client
│   └── index.html              # Self-contained fintech ops console UI
├── k8s/
│   ├── 00-namespace.yaml       # Namespace with PSA labels (k3s + RKE2)
│   ├── 01-rbac.yaml            # ServiceAccount + ClusterRole (read nodes)
│   ├── 02-deployment.yaml      # Deployment
│   ├── 03-configmap.yaml       # Instance name (CLUSTER_NAME)
│   ├── 04-service.yaml         # NodePort :30080
│   └── optional/
│       └── vertex-bank-lb-service.yaml   # LoadBalancer variant
└── overlays/
    ├── default/                # base, default instance name
    ├── ledger-core/            # LEDGER-CORE-01
    └── ledger-edge/            # LEDGER-EDGE-01
```

---

## Building the Image

Built on **SUSE BCI Node.js 20** (`registry.suse.com/bci/nodejs:20`), which
ships native `linux/amd64` and `linux/arm64` layers, so one tag runs on x86 and
ARM nodes.

```bash
# Multi-arch build and push
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t docker.io/avaleror/vertex-bank-app:latest \
  --push .

# Quick local test (standalone, no K8s API)
docker build -t vertex-bank-app:dev .
docker run --rm -p 3000:3000 vertex-bank-app:dev
# Open http://localhost:3000
```

Update the `image:` field in `k8s/02-deployment.yaml` if you push to a different
registry.

---

## Deploy on a Cluster (rodeo / manual)

This is the flow used in the rodeo builder track, on the K3s cluster provisioned
inside SUSE Virtualization.

```bash
# 1. Apply the base stack (NodePort service)
kubectl apply -f k8s/

# 2. Set the instance name shown on the console
kubectl -n vertex-bank patch configmap vertex-bank-config \
  --patch '{"data":{"CLUSTER_NAME":"LEDGER-CORE-01"}}'
kubectl -n vertex-bank rollout restart deployment/vertex-bank

# 3. Wait for it to come up
kubectl -n vertex-bank rollout status deployment/vertex-bank
```

Expose it. On a cluster with an IP pool (MetalLB, kube-vip, or the rodeo IP
pool) swap in the LoadBalancer service:

```bash
kubectl apply -f k8s/optional/vertex-bank-lb-service.yaml
kubectl -n vertex-bank get svc vertex-bank   # read the EXTERNAL-IP
```

Or reach it over the NodePort at `http://<node-ip>:30080`, or with a
port-forward for a browser tab:

```bash
kubectl port-forward -n vertex-bank svc/vertex-bank 8092:80 --address=0.0.0.0 &
```

Tear down:

```bash
kubectl delete namespace vertex-bank
```

---

## Deploy via Fleet (GitOps, multi-cluster)

`fleet.yaml` targets clusters by label. Every target needs `bank=true`, plus a
`ledger-tier` label to pick the instance name.

| Label | Effect |
|---|---|
| `bank=true` | Required. No label, no deployment. |
| `ledger-tier=core` | Instance name `LEDGER-CORE-01` |
| `ledger-tier=edge` | Instance name `LEDGER-EDGE-01` |

In Rancher: **Continuous Delivery → Git Repos → Add Repository**, point it at
this repo, branch `main`, path `/`, and target clusters with `bank=true`.

---

## k3s and RKE2 Notes

- **Projected tokens:** both distros rotate the service account token roughly
  hourly. `server.js` re-reads it from disk on every API call, so no restart is
  needed on rotation.
- **Distribution detection:** the `gitVersion` from `/version` is parsed for the
  `+k3s` / `+rke2` suffix and shown in the UI.
- **Pod Security Admission:** RKE2 enforces PSA. The namespace declares
  `enforce: baseline` and the container satisfies `restricted`
  (`runAsNonRoot`, `drop: ALL`, `seccompProfile: RuntimeDefault`, no privilege
  escalation).
- **Single-node k3s:** the deployment tolerates the control-plane taint so it
  schedules on a single-worker cluster or Rancher Desktop.

---

## RBAC

Read-only, and nothing else:

```yaml
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list"]
  - nonResourceURLs: ["/version"]
    verbs: ["get"]
```

No writes. No secrets. No pods. Scoped to the `vertex-bank` namespace.

---

## API Reference

| Endpoint | Description |
|---|---|
| `GET /` | Serves the console UI |
| `GET /api/info` | Cluster info as JSON (60 s cache) |
| `GET /health` | Liveness / readiness probe, returns `200 OK` |

---

## Resource Footprint

| | Request | Limit |
|---|---|---|
| CPU | 25m | 100m |
| Memory | 32Mi | 64Mi |

---

## Disclaimer

**vertex-bank-app** is an independent, community-created demonstration app for
the SUSE Virtualization rodeo. It is not a SUSE product, is not affiliated with
or endorsed by SUSE LLC, and is not supported by SUSE. The SUSE name and the
SUSE chameleon logo are property of SUSE LLC and are referenced only to identify
the platform this demo runs on.

**Vertex Trust Bank** is a fictional company. This is not a real banking system.
The transactions per second, ledger sync, fraud scan, and SLA figures are
simulated in the browser for storytelling and do not represent real financial
data. Do not use this app for anything other than demos and education. It has
had no security audit and must not be exposed to untrusted networks.

Licensed under the Apache License, Version 2.0. See `LICENSE`.

---

*Vertex Trust Bank — every ledger block committed, no Broadcom invoice.*
