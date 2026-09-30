# Deploy BizOrganiser on Vercel + Turso

| Part | Service | Free plan |
|---|---|---|
| Web app and API | **Vercel** (serverless functions, region Frankfurt `fra1`) | Hobby: free, but **for personal, non-commercial use only** (see below) |
| Database | **Turso** (hosted SQLite) | 5 GB storage, 10 million row writes a month, point-in-time restore for the last 24 hours |

> **Licence check.** Vercel's Hobby plan is restricted to personal, non-commercial use. Running a company's business system on it,
> or building it for a client, counts as commercial use and needs **Vercel Pro** (about $20 per member per month).
> Hobby is fine for evaluating and demonstrating the app. Nothing else changes when you upgrade.

Setup takes about 15 minutes. Steps 1 and 2 are in the browser; step 3 is one command from this PC.

---

## 1. Create the Turso database

1. Go to <https://app.turso.tech> and sign up (GitHub, Google or email).
2. **Create database**, for example `bizorganiser`.
   Pick a **European location close to Frankfurt** (e.g. *AWS Frankfurt, eu-central-1*). The app runs in Vercel's Frankfurt
   region, so this keeps it fast and keeps the data in the EU.
3. Open the database and copy its **URL**. It looks like `libsql://bizorganiser-<your-org>.turso.io`.
4. **Create token** (read & write) and copy it. It is shown only once.

## 2. Create a Vercel account

Sign up at <https://vercel.com/signup>. You don't need a project or a Git repository: the script creates the project.

## 3. Deploy

From the `bizorganiser` folder, in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\deploy-vercel.ps1
```

The first run:

1. opens the browser so you can sign in to Vercel;
2. creates the Vercel project `bizorganiser` and links this folder to it;
3. asks for the Turso URL, the Turso token (typed invisibly) and the administrator's email address;
4. generates the other settings (`ADMIN_PASSWORD`, `BIZ_SECRET_KEY`, `CRON_SECRET`) and saves them as Vercel environment variables;
5. deploys and prints the address and a **temporary administrator password**, shown once.

On the first request the app creates the database tables and a demo company. Then:

- sign in with the email you entered and the temporary password, and choose a new password;
- **Settings → Users & logins**: create real accounts, and remove the demo accounts (`sales@…`, `production@…`, `accounts@…`, `portal@…`);
- **Settings → Data & audit → Start empty**, then fill in **Settings → Company**.

To start without the demo company, add the environment variable `BIZ_DEMO` = `0` before the first deployment.

If the script can't set an environment variable automatically, it stops and says which one. Add it in
**Vercel → Project → Settings → Environment Variables** (environment *Production*) and run the script again.

## Updates

Run the same command again. It keeps all settings and data and only deploys the new code.

## Addresses

The printed `…vercel.app` address works immediately. For your own domain (for example `biz.yourcompany.gr`):
**Vercel → Project → Settings → Domains → Add**, and create the DNS record Vercel shows you.

- Staff app: `https://<address>/`
- Customer portal: `https://<address>/b2b/`
- E-shop: `https://<address>/shop/`

## Environment variables

| Name | Purpose |
|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Database connection |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First administrator. Only used while there are no users; the password must be changed at first sign-in. |
| `BIZ_SECRET_KEY` | Encrypts the integration passwords (SMTP, myDATA, couriers) stored in the database. **Never change or lose it**: without it the stored integration settings can't be read and must be entered again. |
| `CRON_SECRET` | Protects the daily maintenance job (`/api/cron`) |
| `BIZ_DEMO` | Optional: `0` = don't create the demo company |

## How it differs from the local version

- **Uploads** are limited to **4 MB per file**, because Vercel caps request size. Files are stored in the database.
- **Emails** are sent right after the action that created them. A daily job (05:00 UTC) retries anything left over,
  and you can resend failed emails from the outbox.
- **First request after a quiet period** takes 1–3 seconds while an instance starts and loads the data.
- Several server instances can run at once. The database keeps invoice numbering gap-free and detects conflicting edits.
  This was tested with parallel instances writing to the same database.

## Backups

- Turso keeps **24 hours of point-in-time restore** on the free plan (Turso dashboard → database → *Restore*).
- For longer history, use **Settings → Data & audit → Export JSON** regularly (for example weekly) and keep the files somewhere safe.
  With the Turso CLI you can also take a full SQL dump: `turso db shell bizorganiser .dump > backup.sql`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Setup needed: add the ADMIN_EMAIL and ADMIN_PASSWORD…" | The variables are missing: run the script again, or add them in Vercel, then redeploy. |
| "The integration settings are encrypted: set BIZ_SECRET_KEY" | `BIZ_SECRET_KEY` was removed or changed. Restore the original value. |
| Errors about the database | Check the Turso URL and token in the Vercel environment variables, and that the token hasn't expired. |
| Logs | Vercel → Project → *Logs* (or `npx vercel logs <address>`) |
