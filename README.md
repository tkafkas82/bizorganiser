# BizOrganiser — practice management for architectural offices

Clients, fee proposals, projects with phases and payment schedules, tasks, timesheets, collaborators (engineers, surveyors…)
and their payments, invoicing with AADE myDATA and 20% withholding, reports, and a portal where clients follow their project.

It needs **Node.js 22.13 or newer**. The database is SQLite through the libSQL client: a local file on your PC or server, or **Turso** in the cloud,
so the same code runs locally, on a server or on **Vercel** (see [deploy/VERCEL.md](deploy/VERCEL.md)).

## Quick start

On Windows, double-click **`start.bat`**. It installs the packages on the first start and opens the browser. Or from a terminal:

```bash
cd bizorganiser
npm install          # first time only
npm start            # or: node server/server.js
```

Open <http://127.0.0.1:8080/>. On the first start the server creates `data/bizorganiser.db` with a demo office, plus these accounts.
They share one **temporary password**, which is printed in the console and saved to `data/FIRST-RUN-CREDENTIALS.txt`.

| Account | Role | Where |
|---|---|---|
| admin@demoarchitects.example | Administrator | `/` |
| eleni@demoarchitects.example, nikos@demoarchitects.example | Architect | `/` |
| accounts@demoarchitects.example | Accounting | `/` |
| client@papadakis.example | Client (Papadakis family) | `/client/` |

Everyone must choose a new password at first sign-in.
- To start with your own administrator, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before the first start.
- To start without demo data, set `BIZ_DEMO=0`, or use **Settings → Data & audit → Start empty**.

## What it does

| Area | Features |
|---|---|
| **Clients** | Individuals, companies and the public sector, with VAT and tax office; their projects, proposals, invoices, appointments and emails |
| **Fee proposals** | Phases & fees (with the standard phases one click away); a fee calculator as a % of the construction budget; a **payment schedule** (e.g. 30% / 40% / 30%, checked to add up to 100%); scope and terms; print to PDF; email. An accepted proposal becomes a **project**. |
| **Projects** | Site address, cadastral code (ΚΑΕΚ), building permit, area, construction budget, manager and team. **Phases** with fee, due date, status and budget vs. actual hours. **Payment schedule**: each installment is due on a date or when a chosen phase is done, and is invoiced with one click. Also **collaborators**, **tasks**, **time**, **expenses**, and **files & links**, with a per-file choice of what the client can see. |
| **Tasks** | Board (to do / in progress / done) across projects, filtered by project or person |
| **Timesheets** | Weekly grid per person; hours per project and phase |
| **Collaborators** | Structural and MEP engineers, surveyors, printers… (people or firms). Assign them to projects with a role and an **agreed fee**, record their **bills** and **payments** (also partial), and see agreed / billed / paid / unpaid / still to bill per project. Printable statement and CSV export. |
| **Invoicing** | **Service invoices (2.1)** for businesses and **service receipts (11.2)** for individuals, each with its own numbering series. **Withholding tax** (20% by default, for business clients above €300) is shown on the document; the balance is what the client actually pays. Payments, reminders, and **credit notes** (5.1 / 11.4). **myDATA** registration returns a MARK. |
| **Expenses** | Office and project expenses by category, with due dates and payments |
| **Reports** | Fees per month, client and project type; expenses by category; receivables aging; **project profitability** (fee − labour at each person's hourly cost − collaborators − expenses); **team hours**; **collaborator payments** by project |
| **Calendar** | Appointments and site visits, phase deadlines, task due dates, proposal expiry |
| **Client portal** (`/client/`) | Clients see their projects' phases and payment schedule, download the files you shared, and see their invoices. They can't see anything internal. |

## Integrations (Settings → Integrations, administrators only)

Settings are stored in the database. Passwords and keys are encrypted when `BIZ_SECRET_KEY` is set (always on Vercel), are masked in the settings page, and are never sent to browsers.
Both integrations start in **simulation** mode.

| Integration | Modes | Notes |
|---|---|---|
| Email (SMTP) | off / live | Implicit TLS (465) or STARTTLS (587). The outbox shows each email's status, with *Resend*. |
| AADE myDATA | simulate / test / production | ERP channel `SendInvoices` for 2.1, 11.2, 5.1 and 11.4, with the withholding sent per line (category set in *Settings → Documents & lists*, default 3). Test credentials: <https://mydata-dev-register.azurewebsites.net/>. |

> **B2B e-invoicing mandate (Greece).** From 1 Oct 2026 all businesses must issue **B2B** invoices through a licensed e-invoicing provider
> or AADE's *timologio* app. Sending service invoices (2.1) and credit notes (5.1) only over the myDATA ERP channel, as this application does,
> may therefore not be compliant. Service receipts to individuals (11.2) are not B2B. **Confirm the setup with your accountant**, and test the
> withholding fields in the AADE test environment before using production.

## How it works

- **Server** (`server/`):
  - `app.js`: API routes, security, integrations;
  - `server.js`: local web server;
  - `store.js`: versioned records and the in-memory copy;
  - `db.js`: libSQL / Turso connection;
  - `auth.js`: accounts, sessions;
  - `mail.js`: SMTP;
  - `mydata.js`: myDATA XML.

  `api/index.js` is the Vercel entry point.
- **Browser app** (`public/`):
  - `core.js`: sync, UI helpers, calculations;
  - `crm.js`: dashboard, clients, calendar, email;
  - `proposals.js`: fee proposals;
  - `projects.js`: projects, tasks, timesheets;
  - `finance.js`: invoices, expenses, collaborators;
  - `admin.js`: reports, settings;
  - `client/`: the client portal.
- **Saving and multi-user editing:** the app saves automatically (the indicator next to your name). Each record has a version: if two people change
  the same record, the second save is refused and that person gets the latest version, so nobody silently overwrites a colleague.
  Others' changes appear within about 8 seconds. This also works with several server instances (Vercel).
- **Rules the server enforces:**
  - gap-free numbering per document series;
  - registered invoices can't be changed or cancelled (issue a credit note instead);
  - invoices can't be deleted;
  - myDATA registration numbers (MARKs) and email status are set only by the server.
- **Security:**
  - scrypt password hashing;
  - HttpOnly SameSite session cookies (Secure on HTTPS);
  - sign-in throttling;
  - cross-site request forgery protection via a custom header;
  - a Content-Security-Policy;
  - uploads are served only as downloads, and portal files are served only when shared on the client's own project;
  - an audit log.

## Deploying

| Option | Guide | Command |
|---|---|---|
| **Vercel + Turso** (serverless) | [deploy/VERCEL.md](deploy/VERCEL.md) | `deploy\deploy-vercel.ps1` or Git import |
| Any Ubuntu server, e.g. Oracle Cloud *Always Free* | [deploy/ORACLE-CLOUD.md](deploy/ORACLE-CLOUD.md) | `deploy\deploy.ps1` |

Vercel's free Hobby plan is for **non-commercial use only**; running an office on it needs Vercel Pro.
On Vercel, uploads are limited to 4 MB per file. For large drawing sets, add a link to your shared drive on the project (*Files & links*).

## Running it on your own server

- **HTTPS is required** outside a single machine. Put a reverse proxy (IIS, nginx, Caddy) in front, then set
  `"secureCookies": true` and `"trustProxy": true` in `data/config.json`.
- **Back up** the `data/` folder (database with uploaded files, `config.json`).
  *Settings → Data & audit → Export JSON* gives a portable export.

## Known limitations

- The staff app loads all office data into the browser. That's fine for an office (thousands of records), but not for very large volumes.
- All staff roles can read all project data. Roles decide which screens and actions each person gets: architects don't see invoices,
  expenses or reports.
- myDATA:
  - no VAT exemptions (0% VAT);
  - no delivery notes;
  - registered invoices can't be cancelled (use credit notes instead);
  - the withholding category and the retail credit-note type (11.4) follow published documentation and should be checked in the AADE test environment.
