# Deploy BizOrganiser on Oracle Cloud Always Free

Oracle's *Always Free* tier gives you a permanent virtual server with persistent storage at no cost.
BizOrganiser runs on it unchanged, with HTTPS, automatic security updates and daily backups.

You do steps 1–4 in the Oracle web console (about 20 minutes). Step 5 is a single command from this PC.

---

## 1. Create the Oracle Cloud account

1. Go to <https://www.oracle.com/cloud/free/> and click **Start for free**.
2. Sign up with your email address. Oracle asks for a **credit card to verify your identity**.
   *Always Free* resources are not charged; you only pay if you later upgrade the account and use paid resources.
3. **Choose your home region carefully — it cannot be changed later.** Free server capacity is only available in the home region.
   For Greece a nearby EU region is sensible, e.g. **Italy (Milan)**, **Germany (Frankfurt)** or **Spain (Madrid)**.
   An EU region also keeps customer data in the EU (GDPR).

## 2. Create an SSH key on this PC

Open **PowerShell** and run:

```powershell
ssh-keygen -t ed25519
```

Press Enter to accept the default location (`C:\Users\<you>\.ssh\id_ed25519`). A passphrase is recommended.
Then show the **public** key, which you give to Oracle in the next step:

```powershell
Get-Content $HOME\.ssh\id_ed25519.pub
```

Never share the file without `.pub`: that is your private key.

## 3. Create the virtual server

In the Oracle console: **☰ → Compute → Instances → Create instance**.

| Setting | Value |
|---|---|
| Name | `bizorganiser` |
| Image | **Change image → Canonical Ubuntu 24.04** |
| Shape | **Change shape → Ampere → VM.Standard.A1.Flex**, 2 OCPUs, 12 GB memory (free up to 4 OCPUs / 24 GB in total) |
| Networking | *Create new virtual cloud network* and *public subnet* (defaults), **Assign a public IPv4 address: Yes** |
| Add SSH keys | **Paste public keys** → paste the `.pub` line from step 2 |
| Boot volume | default (about 47 GB; free up to 200 GB) |

Click **Create**. After a minute the instance is *Running*: note its **Public IP address**.

> **"Out of capacity"?** Free ARM capacity is sometimes exhausted. Try another *availability domain* on the same page,
> try again later, or use the other always-free shape **VM.Standard.E2.1.Micro** (AMD, 1 GB RAM), which is enough for a small team.

## 4. Open the web ports (80 and 443)

1. On the instance page, click the **subnet** link (under *Primary VNIC*) → **Security** (or *Security Lists*) → the **Default Security List**.
2. **Add Ingress Rules**, twice:

   | Source CIDR | IP protocol | Destination port |
   |---|---|---|
   | `0.0.0.0/0` | TCP | `80` |
   | `0.0.0.0/0` | TCP | `443` |

Port 22 (SSH) is already open. The install script also opens 80/443 in the server's own firewall.

## 5. Deploy from this PC

In PowerShell, from the `bizorganiser` folder:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1 -Server <PUBLIC-IP>
```

The first run takes 3–5 minutes. It installs Node.js, Caddy (HTTPS), the app as a system service, the firewall rules,
daily backups and automatic security updates. At the end it prints your address, for example:

```
Address:   https://203-0-113-10.sslip.io/
```

`sslip.io` is a free service that turns the IP into a host name, so an HTTPS certificate can be issued automatically.
To use your own domain instead, point a DNS **A record** (e.g. `biz.yourcompany.gr`) at the IP and deploy with
`-Domain biz.yourcompany.gr`.

## 6. First sign-in

Show the temporary password (it is printed only on the server, never sent anywhere):

```powershell
ssh ubuntu@<PUBLIC-IP> "sudo cat /var/lib/bizorganiser/FIRST-RUN-CREDENTIALS.txt"
```

Open the address, sign in as `admin@demoprint.example` and choose a new password. Then:

- **Settings → Users & logins**: create real accounts and disable or delete the demo ones.
- **Settings → Data & audit → Start empty** to remove the demo company, then fill in **Settings → Company**.
- Delete the credentials file: `ssh ubuntu@<PUBLIC-IP> "sudo rm /var/lib/bizorganiser/FIRST-RUN-CREDENTIALS.txt"`

---

## Day-to-day

| Task | How |
|---|---|
| **Update** to a new version | Run the same `deploy.ps1` command again. Data is kept and a backup is taken first. |
| Server log | `ssh ubuntu@<IP> "sudo journalctl -u bizorganiser -n 100"` |
| Restart | `ssh ubuntu@<IP> "sudo systemctl restart bizorganiser"` |
| Backups | Daily at 02:30 in `/var/backups/bizorganiser` (database, uploaded files and settings; kept for 14 days). Take one now: `ssh ubuntu@<IP> "sudo bizorganiser-backup"` |
| Copy backups to this PC | `scp -r ubuntu@<IP>:/var/backups/bizorganiser .` (run `sudo chmod -R a+r /var/backups/bizorganiser` first, or copy as root) |

**Keep an off-server copy.** Backups on the same server don't help if the server is lost, so copy them to this PC or other storage regularly.

## Good to know

- **Idle reclaim.** Oracle may reclaim *Always Free* servers that stay almost completely idle (very low CPU, network and memory use) for 7 days.
  A server in daily use is normally fine. Upgrading the account to *Pay As You Go* removes this rule. Always Free resources stay free,
  but set a budget alert in case anything paid gets created by mistake.
- **Public IP.** The IP stays the same across reboots, but changes if the instance is deleted and recreated.
  If you use `sslip.io`, the address would change too; your own domain avoids that.
- **Where the files are:**
  - app code: `/opt/bizorganiser`
  - data: `/var/lib/bizorganiser` (database, uploads, `config.json` with integration secrets)
  - HTTPS configuration: `/etc/caddy/Caddyfile`
- **Security.** The app only listens on the server itself (127.0.0.1). Caddy handles HTTPS in front of it, with secure cookies.
  SSH accepts keys only. Security updates install automatically.
- **Compliance.** Customer and invoice data will live with a cloud provider. Check this with your IT or compliance team before storing real data.
