# Beginner deployment guide

This guide assumes you already have GitHub, Cloudflare, ElevenLabs, and an ElevenLabs API key. You will never paste that key into GitHub or any SpokenFrame file.

There are two parts:

1. GitHub Pages hosts the visible SpokenFrame website.
2. A Cloudflare Worker privately holds your ElevenLabs key and asks ElevenLabs for small audio passages.

Use a temporary test repository first. Your current live version stays untouched until V3 passes on your phone.

## Part 1 — Put V3 in a temporary GitHub repository

### 1. Download and extract the V3 ZIP

1. Download the `spokenframe-v3.zip` file supplied with this release.
2. Open your computer's Downloads folder.
3. Double-click the ZIP to extract it.
4. Open the extracted `spokenframe-v3` folder.
5. Confirm that `index.html`, `styles.css`, `README.md`, and folders such as `js`, `worker`, `vendor`, and `assets` are visible immediately.

Important: later you will upload the **contents inside** this folder, not the outer folder and not the ZIP file.

### 2. Create a safe test repository

1. Open [github.com](https://github.com) and sign in.
2. Click the **+** near the top-right corner.
3. Click **New repository**.
4. For **Repository name**, enter exactly: `spokenframe-v2-test`
5. Choose **Public**. GitHub Pages is simplest this way on a free account.
6. Leave **Add a README file**, `.gitignore`, and license unchecked; the project already contains them.
7. Click **Create repository**.

### 3. Upload the complete folder structure

1. On the empty repository page, click **uploading an existing file**.
2. Return to the extracted `spokenframe-v3` folder on your computer.
3. Select **everything inside it**: the files and all folders.
4. Drag that entire selection onto GitHub's upload area.
5. Wait until GitHub finishes listing the files. You should see paths beginning with `assets/`, `js/`, `worker/`, and `vendor/`.
6. In the commit message box, enter: `Add SpokenFrame V3 test build`
7. Click **Commit changes**.

If you only see a single ZIP file or a top-level `spokenframe-v3` folder in the repository, stop. Delete that incorrect upload and repeat with the contents inside the extracted folder. `index.html` must be at the repository's top level.

### 4. Put your GitHub username in the Worker allowlist

1. In your test repository, click the `worker` folder.
2. Click `wrangler.toml`.
3. Click the pencil icon labeled **Edit this file**.
4. Find:

   `https://YOUR-GITHUB-USERNAME.github.io`

5. Replace only `YOUR-GITHUB-USERNAME` with your actual GitHub username. Keep `https://` and `.github.io`.
6. Example: if your username is `jane-smith`, the value becomes:

   `ALLOWED_ORIGINS = "http://localhost:8080,https://jane-smith.github.io"`

7. Click **Commit changes**, then **Commit changes** again in the confirmation box.

This value is public and safe. Do not put the ElevenLabs key in this file.

### 5. Enable the temporary GitHub Pages site

1. In the test repository, click **Settings**.
2. In the left menu, click **Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Under **Branch**, choose `main` and `/ (root)`.
5. Click **Save**.
6. Wait one to three minutes, then refresh the Pages settings page.
7. GitHub will show a live URL similar to:

   `https://YOUR-GITHUB-USERNAME.github.io/spokenframe-v2-test/`

8. Open that URL. You should see **SpokenFrame** and **Your Screenplay. Read Aloud.**

At this stage Standard Audio works, but Premium Audio will remain disabled until Parts 2 and 3 are complete.

## Part 2 — Deploy the secure Cloudflare Worker

### 6. Connect Cloudflare to the test repository

1. Open [dash.cloudflare.com](https://dash.cloudflare.com) and sign in.
2. In the left menu, open **Workers & Pages**.
3. Click **Create application**.
4. Choose the option to **Import a repository**. If Cloudflare asks whether this is a Worker or Pages project, choose **Worker**.
5. Choose **GitHub** and approve access if Cloudflare asks.
6. Select the repository named `spokenframe-v2-test`.
7. Set the project/Worker name to exactly: `spokenframe-tts`
8. Set **Production branch** to `main`.
9. Set **Root directory** to: `worker`
10. Set **Build command** to: `npm install`
11. Set **Deploy command** to: `npx wrangler deploy`
12. Leave other values at their defaults and click **Deploy**.

Cloudflare will build the Worker. The first deployment can succeed before the key is added; premium requests will simply report that they are not configured yet.

When deployment finishes, Cloudflare shows an address similar to:

`https://spokenframe-tts.YOUR-CLOUDFLARE-SUBDOMAIN.workers.dev`

Copy this URL somewhere temporary. The Worker URL is public and is **not** the secret.

### 7. Store the ElevenLabs key as a Cloudflare secret

1. Still in Cloudflare, open **Workers & Pages**.
2. Click the `spokenframe-tts` Worker.
3. Click **Settings**.
4. Find **Variables and Secrets**.
5. Click **Add**.
6. For **Type**, choose **Secret** — not plain text.
7. For **Variable name**, enter exactly: `ELEVENLABS_API_KEY`
8. For **Value**, paste your ElevenLabs API key.
9. Click **Deploy** or **Save and deploy**.

Expected result: Cloudflare displays the variable name, but hides the value after saving.

Never paste this key into:

- GitHub
- `js/config.js`
- `worker/wrangler.toml`
- a commit message
- an issue or screenshot
- this chat

Keep your restricted ElevenLabs credit/usage limit enabled. The personal beta has no user login, and origin rules are not a substitute for authentication.

## Part 3 — Connect the website to the Worker

### 8. Add the public Worker URL to SpokenFrame

1. Return to GitHub and open `spokenframe-v2-test`.
2. Open the `js` folder.
3. Click `config.js`.
4. Click the pencil icon.
5. Find this line:

   `workerUrl: ""`

6. Paste the Cloudflare Worker URL between the quotation marks. Do not add `/v1/tts` and do not add the ElevenLabs key.
7. It should look similar to:

   `workerUrl: "https://spokenframe-tts.example.workers.dev"`

8. Click **Commit changes**, enter `Connect premium audio Worker`, and confirm.
9. Wait one to three minutes for GitHub Pages to redeploy.
10. Refresh the temporary SpokenFrame URL. A forced refresh may help: Windows `Ctrl+Shift+R`; Mac `Command+Shift+R`.

### 9. Confirm premium audio

1. Import a short FDX or Fountain screenplay.
2. Click **Cast**.
3. Confirm **Audio Quality** lets you select **Premium Audio** and the Cast list contains premium voices.
4. Close Cast and press Play.
5. The Play button should briefly show a preparation spinner, then generated audio should begin.

If Premium Audio is disabled:

- Check that `js/config.js` contains the Worker URL, not the ElevenLabs key.
- Check Cloudflare **Variables and Secrets** for the exact secret name `ELEVENLABS_API_KEY`.
- Check `worker/wrangler.toml` contains your real GitHub username.
- In Cloudflare, open the Worker's **Deployments** page and confirm the latest deployment succeeded.
- Check your ElevenLabs account still has available credits and that the key is active.

## Part 4 — Test before replacing V1

Open [Real-Device QA Checklist](REAL-DEVICE-QA.md) and test the temporary URL on the phone you actually use. In particular, verify Android Chrome lock-screen playback across at least three passages.

Do not replace V1 until FDX import, premium playback, resume, Cast persistence, and your phone's lock-screen test pass.

## Part 5 — Safely replace the existing GitHub Pages version

### 10. Create a rollback branch from the existing live repository

1. Open your existing live GitHub repository.
2. Click the branch button near the upper-left that currently says `main`.
3. In the search box, type: `v1-backup`
4. Click **Create branch: v1-backup from main**.
5. Use the branch button again and switch back to `main`.

Expected result: `v1-backup` preserves the exact currently-live V1 files.

### 11. Upload V3 over `main`

1. Confirm the branch button says `main`.
2. Click **Add file** → **Upload files**.
3. From your extracted V3 folder, select and drag **all contents** into GitHub.
4. Wait until the folders finish uploading.
5. Enter the commit message: `Deploy SpokenFrame V3`
6. Click **Commit changes**.
7. Open `worker/wrangler.toml` on `main` and confirm your GitHub username is present.
8. Open `js/config.js` on `main`, click the pencil, and paste the same public Cloudflare Worker URL between the quotes.
9. Commit with: `Connect SpokenFrame V3 to Worker`

No secret is being copied: only the public Worker address goes in `config.js`.

### 12. Confirm GitHub Pages still uses `main`

1. In the live repository, open **Settings** → **Pages**.
2. Confirm **Deploy from a branch**, `main`, and `/ (root)` are selected.
3. Wait for the deployment to finish.
4. Open your normal production URL and force-refresh it.
5. Run the short final checklist below.

### 13. Point Cloudflare builds at the production repository later

This is optional on launch day; the deployed Worker continues working. To keep future Worker updates tied to your real production repository:

1. Open Cloudflare → **Workers & Pages** → `spokenframe-tts`.
2. Open **Settings** → **Builds**.
3. Disconnect the temporary test repository if Cloudflare offers that button.
4. Connect your production GitHub repository.
5. Use `main` as the production branch and `worker` as the root directory.
6. Keep build command `npm install` and deploy command `npx wrangler deploy`.
7. Deploy and verify Premium Audio again.

The existing Cloudflare secret remains attached to the Worker. Never move it into GitHub.

## Roll back if V3 has a problem

1. Open the production repository → **Settings** → **Pages**.
2. Change the deployment branch from `main` to `v1-backup` and keep `/ (root)`.
3. Click **Save**.
4. Wait for Pages to redeploy, then force-refresh your site.

This restores the previous version without deleting the V3 work. To return to V3 later, select `main` again.

## Short final live-site checklist

- [ ] The page says **SpokenFrame** and **Your Screenplay. Read Aloud.**
- [ ] FDX, Fountain, and a text-based PDF can be selected.
- [ ] A new screenplay opens with one consistent voice for all roles.
- [ ] Premium Play prepares only briefly, then audio starts.
- [ ] Cast changes and Auto Assign work.
- [ ] Action is always read; there is no Narration switch.
- [ ] The active screenplay passage is gold and follows playback.
- [ ] Pause, Previous, Next, scene jump, speed, refresh, and Resume work.
- [ ] Android lock-screen playback and controls behave acceptably on your phone.
- [ ] GitHub contains a Worker URL but no ElevenLabs API key.
