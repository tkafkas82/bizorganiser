# BizOrganiser

A business management platform for small and medium companies, modelled on the feature set of upd8.gr's CBO and B2B Link:
CRM, quotes with costing, orders, production work orders, deliveries, invoicing with AADE myDATA, purchasing, sales-rep commissions,
a B2B ordering portal for business customers and a public e-shop.

It needs **Node.js 22.13 or newer**. The database is SQLite through the libSQL client: a local file on your PC or server, or **Turso** in the cloud,
so the same code runs locally, on a server or on **Vercel** (see [deploy/VERCEL.md](deploy/VERCEL.md)).

## Quick start

On Windows, double-click **`start.bat`**. It installs the packages on the first start and opens the browser. Or from a terminal:

```bash
cd bizorganiser
npm install          # first time only
npm start            # or: node server/server.js
```

Open <http://127.0.0.1:8080/>.

On the first start the server:

1. creates `data/bizorganiser.db` and loads a demo company (printing & signage, ~6 months of history);
2. creates the accounts below with one **temporary password**, printed in the console and saved to `data/FIRST-RUN-CREDENTIALS.txt`.

| Account | Role | Where to sign in |
|---|---|---|
| admin@demoprint.example | Administrator | `/` |
| sales@demoprint.example | Sales | `/` |
| production@demoprint.example | Production | `/` |
| accounts@demoprint.example | Accounting | `/` |
| portal@knossos.example | Customer (Knossos Hotels) | `/b2b/` |

Every user must choose a new password at first sign-in. Delete `FIRST-RUN-CREDENTIALS.txt` afterwards.
To start with your own admin instead of the demo admin, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before the first start.
To start without demo data, sign in as admin and use **Settings → Data & audit → Start empty**.

## The three web front ends

| URL | Who | What |
|---|---|---|
| `/` | Staff | The full application. What each user sees depends on their role. |
| `/b2b/` | Business customers | The B2B Link portal: catalogue with the customer's own prices and live availability, cart, orders and tracking, confirming orders a sales rep prepared for them, invoices, account. |
| `/shop/` | Public | Retail e-shop configured in **Settings → E-shop builder**: products with *Show in e-shop*, shipping fees, cash on delivery or bank transfer. |

## Integrations (Settings → Integrations, administrators only)

Settings are stored in the database. Passwords and keys are encrypted when `BIZ_SECRET_KEY` is set (always on Vercel), are masked in the settings page, and are never sent to browsers.
Every integration starts in **simulation** mode, so you can try everything safely.

| Integration | Modes | Notes |
|---|---|---|
| Email (SMTP) | off / live | Implicit TLS (465) or STARTTLS (587). Automatic emails are configured per template in *Settings → Email templates*. Status per email is shown in the outbox (sent / failed / not sent), with *Resend*. |
| AADE myDATA | simulate / test / production | ERP channel `SendInvoices`, for invoice types 1.1, 2.1, 11.1 and credit notes 5.1. Test credentials: <https://mydata-dev-register.azurewebsites.net/>. **See the warning below.** |
| ACS Courier | simulate / live | ACS Web Services (`ACSAutoRest`): create voucher, print label (PDF), tracking. ACS only registers vouchers after the daily pickup list is issued (*Deliveries → ACS: issue pickup list*). |
| BOX NOW | simulate / live (stage or production) | Partner API: delivery requests to a locker (locker ID per delivery), PDF labels, parcel tracking. |
| Other couriers | simulate / manual | ELTA, Geniki, Speedex, own vehicle: book in the courier's own system and type the tracking number. |

> **B2B e-invoicing mandate (Greece).** From 2 Feb 2026 (businesses with more than €1M turnover) and 1 Oct 2026 (all businesses),
> B2B invoices must be issued through a **licensed e-invoicing provider** or AADE's free *timologio* app.
> Sending B2B invoices (1.1, 2.1, 5.1) only over the myDATA ERP channel, which this application does, may therefore not be compliant.
> The app shows a warning in production mode. **Confirm the correct setup with your accountant.** Connecting a licensed provider
> means using that provider's own API, which is not included.

The ACS and BOX NOW clients were written from the providers' published API manuals but have **not been tested with live credentials**.
Try them first with ACS demo credentials or the BOX NOW stage environment.

## How the application works

- **Server** (`server/`):
  - `app.js`: API routes, security, integrations;
  - `server.js`: local web server;
  - `store.js`: records with versions and in-memory copy;
  - `db.js`: libSQL / Turso connection;
  - `auth.js`: accounts, sessions;
  - `mail.js`: SMTP;
  - `mydata.js`: myDATA XML;
  - `couriers.js`: ACS / BOX NOW / manual.

  `api/index.js` is the Vercel entry point.
- **Several instances at once** (Vercel, or several servers on one database): every request first brings its in-memory copy
  up to date from the database, and every write runs in a database transaction, so numbering and conflict detection stay exact.
- **Staff app** (`public/`): keeps a working copy of the data in the browser and saves changes automatically. The indicator
  next to your name shows *Saved*, *Saving…* or *Not saved*. Every record has a version: if two people change the same record,
  the second save is refused and that person gets the latest version, so nobody silently overwrites a colleague. Changes by other
  users appear within about 8 seconds.
- **Business rules on the server:**
  - document numbers are assigned by the server in strict sequence, so there are no gaps in invoice numbering;
  - an invoice registered in myDATA cannot be changed or cancelled (issue a credit note instead);
  - invoices cannot be deleted;
  - myDATA registration numbers (MARKs), courier booking fields and email delivery status can only be set by the server.
- **Security:**
  - passwords are hashed with scrypt;
  - sessions use HttpOnly SameSite cookies, expire after 12 idle hours and are logged out everywhere on a password change;
  - five failed sign-ins lock that email or network address for 5 minutes;
  - every change needs a custom request header, which blocks cross-site request forgery;
  - security headers include a Content-Security-Policy;
  - uploaded files are served for download only, never rendered as web pages, and need a staff login;
  - customers can only reach their own data through the `/api/portal` endpoints;
  - an audit log records sign-ins, integration changes, myDATA submissions, courier bookings, user changes and imports.

## Deploying

| Option | Guide | Command |
|---|---|---|
| **Vercel + Turso** (serverless, no server to maintain) | [deploy/VERCEL.md](deploy/VERCEL.md) | `deploy\deploy-vercel.ps1` |
| Any Ubuntu server, e.g. Oracle Cloud *Always Free* (HTTPS, backups, updates) | [deploy/ORACLE-CLOUD.md](deploy/ORACLE-CLOUD.md) | `deploy\deploy.ps1` |

Vercel's free Hobby plan is for **non-commercial use only**; business use needs Vercel Pro.

## Running it for real

- **HTTPS is required** outside a single machine. Put a reverse proxy (IIS, nginx, Caddy) in front of the server, then set
  `"secureCookies": true` and `"trustProxy": true` in `data/config.json`, and `"host": "127.0.0.1"` so only the proxy can reach it.
- **Back up the `data/` folder** (database including uploaded files, and `config.json`), for example with a nightly copy.
  *Settings → Data & audit → Export JSON* gives a portable export of the business data.
- Port and bind address: `PORT` and `HOST` environment variables, or `port` and `host` in `data/config.json`.
- Card payments in the e-shop need a payment provider (e.g. Viva Wallet, Stripe); that is not included.

## Known limitations

- The staff app loads the whole dataset into the browser. That is fine for a small or medium business (thousands of records),
  but not for very large volumes.
- All staff roles can read all business data. Roles limit which screens and actions each user gets; the server also enforces
  who can change settings, integrations and users.
- myDATA: no VAT exemptions (0% VAT), withholding taxes, delivery notes or cancellation of registered invoices
  (use credit notes instead).
