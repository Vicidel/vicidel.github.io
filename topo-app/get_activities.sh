#!/bin/bash

# Prompt for Strava credentials
read -p "Enter your Strava Client ID: " CLIENT_ID
read -s -p "Enter your Strava Client Secret: " CLIENT_SECRET
echo

# Set up redirect URI
REDIRECT_URI="http://localhost"

# Get authorization code (opens browser)
AUTH_URL="https://www.strava.com/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${REDIRECT_URI}&approval_prompt=force&scope=activity:read_all"
echo "Open the following URL in your browser and authorize the app:"
echo "$AUTH_URL"
xdg-open "$AUTH_URL" 2>/dev/null || open "$AUTH_URL" 2>/dev/null || echo "Please open manually."

# Get code from user
read -p "Paste the code from the response URL: " AUTH_CODE

# Exchange code for access token
TOKEN_RESPONSE=$(curl -s -X POST https://www.strava.com/api/v3/oauth/token \
  -d client_id="$CLIENT_ID" \
  -d client_secret="$CLIENT_SECRET" \
  -d code="$AUTH_CODE" \
  -d grant_type=authorization_code)

ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | grep -oP '"access_token":"\K[^"]+')

if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "❌ Failed to retrieve access token."
  echo "Response: $TOKEN_RESPONSE"
  exit 1
fi

echo "✅ Access token acquired."

# Fetch activities in pages
echo "📥 Downloading activities..."
PAGE=1
PER_PAGE=50
ACTIVITIES="[]"

while true; do
  RESPONSE=$(curl -s "https://www.strava.com/api/v3/athlete/activities?page=$PAGE&per_page=$PER_PAGE" \
    -H "Authorization: Bearer $ACCESS_TOKEN")

  COUNT=$(echo "$RESPONSE" | jq 'length')
  if [[ "$COUNT" -eq 0 ]]; then
    break
  fi

  ACTIVITIES=$(echo "$ACTIVITIES $RESPONSE" | jq -s 'add')
  echo "Fetched page $PAGE with $COUNT activities."
  ((PAGE++))
done

# Save to file
OUTPUT="data/activities_${CLIENT_ID}.json"
echo "$ACTIVITIES" | jq '.' > "$OUTPUT"
echo "✅ Saved all activities to $OUTPUT"

# Add to manifest
ls data/activities_*.json | jq -R -s -c 'split("\n")[:-1]' > data/manifest.json