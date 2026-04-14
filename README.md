# Aspen Spas — Delivery Tracker

Live delivery tracking dashboard with Firebase real-time database.

## URLs
- **Firebase**: https://aspen-delivery-tracker.web.app
- **GitHub Pages**: https://aspenservices.github.io/aspen-delivery-tracker

## Setup Instructions

### Step 1: Create Firebase Project

1. Go to https://console.firebase.google.com
2. Click **"Add project"** → name it `aspen-delivery-tracker`
3. Disable Google Analytics (optional) → Create project
4. In the project dashboard, click the **web icon `</>`** to add a web app
5. Name it `delivery-tracker` → Register app
6. **Copy the `firebaseConfig` object** — you'll need it in Step 3

### Step 2: Enable Realtime Database

1. In Firebase console → **Build → Realtime Database**
2. Click **"Create Database"**
3. Choose location (us-central1 is fine)
4. Select **"Start in test mode"** → Enable
5. Note the database URL (e.g. `https://aspen-delivery-tracker-default-rtdb.firebaseio.com`)

### Step 3: Paste Firebase Config

Open `docs/index.html` and `migrate.html`. Find this block near the top of the `<script>`:

```javascript
const firebaseConfig={apiKey:"PASTE_YOUR_API_KEY",authDomain:...
```

Replace the entire config object with the one you copied from Firebase.

### Step 4: Migrate Existing Data

If you have data in localStorage from the old tracker:

1. Open `migrate.html` in the **same browser** where you used the old tracker
2. Click **"Preview Data"** to see what will be migrated
3. Click **"Push to Firebase"** to migrate

### Step 5: Create GitHub Repo

```bash
cd ~/Documents/aspen-delivery-tracker
git init
git add .
git commit -m "Initial commit - Delivery Tracker with Firebase"
git remote add origin git@github.com:aspenservices/aspen-delivery-tracker.git
git branch -M main
git push -u origin main
```

Then enable GitHub Pages:
- Go to repo → Settings → Pages → Source: **Deploy from branch** → Branch: `main`, folder: `/docs`

### Step 6: Deploy to Firebase Hosting

```bash
cd ~/Documents/aspen-delivery-tracker
npm install -g firebase-tools   # if not already installed
firebase login                   # if not already logged in
firebase deploy
```

## Project Structure

```
aspen-delivery-tracker/
├── docs/
│   └── index.html          ← Main app (served by GitHub Pages & Firebase)
├── migrate.html             ← One-time migration tool (localStorage → Firebase)
├── firebase.json            ← Firebase hosting config
├── database.rules.json      ← Realtime Database rules
├── .firebaserc              ← Firebase project link
├── .gitignore
└── README.md
```

## Database Structure (Firebase Realtime DB)

```
/edits/{recordId}    → Override fields for BASE records
/added/[array]       → New deliveries added via the app
/custom_opts         → Custom accessory dropdown options
```

## Notes

- The `BASE` array in `index.html` contains the original seed data
- All changes (edits, new records, checkbox toggles) sync to Firebase in real-time
- Multiple users can use the tracker simultaneously — changes appear instantly
- The green dot next to "Aspen Spas" indicates database connection status
