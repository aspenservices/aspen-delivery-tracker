#!/bin/bash
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "🔧 Aspen Delivery Tracker Setup"
echo "================================"
echo ""
echo "Paste your Firebase apiKey:"
read -p "→ " API_KEY
echo "Paste your appId:"
read -p "→ " APP_ID
echo "Paste your project ID (e.g. aspen-delivery-tracker-xxxxx):"
read -p "→ " PROJECT_ID

AUTH_DOMAIN="$PROJECT_ID.firebaseapp.com"
DB_URL="https://$PROJECT_ID-default-rtdb.firebaseio.com"
STORAGE="$PROJECT_ID.firebasestorage.app"

CONFIG="const firebaseConfig={apiKey:\"$API_KEY\",authDomain:\"$AUTH_DOMAIN\",databaseURL:\"$DB_URL\",projectId:\"$PROJECT_ID\",storageBucket:\"$STORAGE\",messagingSenderId:\"000\",appId:\"$APP_ID\"};"

sed -i '' "s|const firebaseConfig={apiKey:\"PASTE_YOUR_API_KEY\".*};|$CONFIG|g" docs/index.html
sed -i '' "s|const firebaseConfig={apiKey:\"PASTE_YOUR_API_KEY\".*};|$CONFIG|g" migrate.html
echo "{\"projects\":{\"default\":\"$PROJECT_ID\"}}" > .firebaserc

echo -e "${GREEN}✅ Config done${NC}"

firebase use "$PROJECT_ID"
firebase deploy

git add .
git commit -m "Delivery Tracker live"
git push origin main

echo ""
echo -e "${GREEN}✅ LIVE!${NC}"
echo "→ https://$PROJECT_ID.web.app"
echo "→ https://aspenservices.github.io/aspen-delivery-tracker"
