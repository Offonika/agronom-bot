# External Exposure (Ports) – Single Server

Working host: `mm.offonika.ru` / `147.45.232.192`

Goal: keep a short, explicit list of what is reachable from the Internet. Everything else must be either:
- bound to `127.0.0.1`, or
- reachable only inside docker networks / VPN, or
- blocked by firewall rules.

This is a production hardening measure: fewer exposed ports = fewer ways to get compromised by accident.

## Expected Public Ports

Source of truth allowlist: `runbooks/exposed_ports.allowlist`

As of now, the following ports are expected to be reachable externally (directly or via proxy):

- `22/tcp` SSH (recommended: restrict by IP or use VPN-only administration).
- `80/tcp` Apache HTTP (redirect to HTTPS + ACME HTTP-01).
- `443/tcp` Apache HTTPS (public vhosts).
- `443/udp` WireGuard (VPN transport).
- `5433/tcp` docker Postgres for `agronom-bot` (restricted by iptables `DOCKER-USER` allowlist).
- `55433/tcp` system Postgres (`pricing` / `offonikabaza`) for PowerBI (restricted by iptables `INPUT` allowlist).
- `4433/tcp`, `4433/udp`, `54321/tcp`, `8443/tcp`, `8444/tcp` VPN services (Outline/Xray). Do not change without the VPN owner.
- Xray may open additional UDP listeners on random high ports. Treat these as VPN-owned. `/opt/admin_scripts/audit_exposure.sh` reports them as `INFO` and does not fail the audit.

Note: Outline may also create additional UDP listeners on random high ports. These should be treated as VPN-owned and investigated with the VPN owner before changing anything.

Anything else listening on a public interface is a deviation and should be investigated.

## Internal-Only Ports (Examples)

These are intentionally NOT reachable from the Internet and should be bound to `127.0.0.1`:

- `8010/tcp` agronom API (reverse-proxied by Apache; bank webhooks are handled by Apache rules).
- `9000-9001/tcp` MinIO (admin/API), internal.
- `18080/tcp` pricing-service API, internal (served via Apache vhost `price.mm.offonika.ru`).
- `8080/tcp` RetailCheck webhook receiver, internal (served via Apache vhost `checklist.offonika.ru`).
- `3306/tcp` MySQL, internal (bound to `127.0.0.1`).

## How To Audit (Manual)

Listen sockets:

```bash
ss -lntp
ss -lnup
```

Docker published ports:

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Firewall rules relevant for exposure:

```bash
iptables -S INPUT
iptables -S DOCKER-USER
```

Apache vhosts:

```bash
apache2ctl -S
```

## One-Command Audit (Recommended)

Server script (host-level): `/opt/admin_scripts/audit_exposure.sh`

Run:

```bash
sudo /opt/admin_scripts/audit_exposure.sh /opt/agronom-bot/runbooks/exposed_ports.allowlist
```

If the script reports an exposed port not listed in the allowlist, treat it as an incident until explained.

## Change Policy

Any change that adds a new externally reachable port must also:
- update `runbooks/exposed_ports.allowlist` and this document,
- include the reason and owner,
- include the intended access policy: `public`, `allowlist`, or `VPN-only`.
