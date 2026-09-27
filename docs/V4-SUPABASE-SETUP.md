# Supabase setup for SpokenFrame V4

This guide is written for a non-developer. The values called **Project URL** and **Publishable key** are public browser configuration. Never copy a secret key, service-role key, JWT secret, or database password into GitHub.

## 1. Create the project

1. Open [Supabase](https://supabase.com/dashboard) and sign in.
2. Create an organization named `SpokenFrame` if needed; choose the Free plan.
3. Create a project named `spokenframe-beta`.
4. Generate a strong database password and save it privately. Do not send it to anyone or commit it.
5. Choose **West US (North California)**.
6. Keep **Enable Data API** on.
7. Turn **Automatically expose new tables** off.
8. Turn **Enable automatic RLS** on.
9. Create the project and wait for the status to become Healthy.

## 2. Create the private library tables

1. In the project sidebar, open **SQL Editor**.
2. Open `supabase/migrations/202609270001_v4_accounts_library.sql` from this repository.
3. Copy the entire file into a new query.
4. Click **Run** once.
5. Expected result: `Success. No rows returned`.

The migration enables owner-only Row Level Security and removes anonymous table privileges.

## 3. Configure safe redirects

1. Open **Authentication** → **URL Configuration**.
2. Set **Site URL** to:

   `https://rbc281.github.io/spokenframe-v2-test/`

3. Save it.
4. Add the same address under **Redirect URLs**.

Do not use the Cloudflare Worker URL here.

## 4. Configure email/password accounts

Open **Authentication** → **Sign In / Providers** → **Email** and use:

- Enable email provider: on
- Secure email change: on
- Secure password change: on
- Require current password when updating: off
- Minimum password length: `8`
- Password requirements: no additional option
- Email OTP expiration: `3600`
- Email OTP length: `8`

Save the settings. Keep email confirmation enabled.

## 5. Copy only public browser values

1. Open **Settings** → **API Keys**.
2. Copy the **Publishable key**, beginning with `sb_publishable_`.
3. Open **Settings** → **Data API**.
4. Copy the base Project URL, ending in `.supabase.co`.
5. Put only those public values in `js/config.js`.

Do not copy:

- anything beginning with `sb_secret_`
- `service_role`
- database password
- JWT secret

## 6. Public-beta email checkpoint

Supabase's built-in email sender only delivers to members of the Supabase organization and is rate-limited. It is enough for Roger's initial test, but not for outside beta users.

Before inviting the public, configure a transactional email provider under **Authentication** → **Emails** → **SMTP Settings**. Complete this as its own setup checkpoint; do not disable email confirmation as a shortcut.
