#!/usr/bin/env bash

set -uo pipefail

usage() {
  cat <<'EOF'
Usage: ./get_activities.sh [--all]

By default, fetch only activities newer than the first activity already stored
locally. Use --all to download the complete activity history again.
EOF
}

FULL_REFRESH=false
case "${1:-}" in
  "") ;;
  --all|-a) FULL_REFRESH=true ;;
  --help|-h) usage; exit 0 ;;
  *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
esac

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DATA_DIR="$SCRIPT_DIR/data"

read -r -p "Enter your Strava Client ID: " CLIENT_ID
read -r -s -p "Enter your Strava Client Secret: " CLIENT_SECRET
echo

OUTPUT="$DATA_DIR/activities_${CLIENT_ID}.json"

# Set up redirect URI
REDIRECT_URI="http://localhost"

# Get authorization code (opens browser)
AUTH_URL="https://www.strava.com/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${REDIRECT_URI}&approval_prompt=force&scope=activity:read_all"

echo "Open the following URL in your browser and authorize the app:"
echo "$AUTH_URL"
xdg-open "$AUTH_URL" 2>/dev/null || open "$AUTH_URL" 2>/dev/null || echo "Please open it manually."

# Get code from user
read -r -p "Paste the code from the response URL: " AUTH_CODE

# Exchange code for access token
if ! TOKEN_RESPONSE=$(curl -sS -X POST https://www.strava.com/api/v3/oauth/token \
  -d client_id="$CLIENT_ID" \
  -d client_secret="$CLIENT_SECRET" \
  -d code="$AUTH_CODE" \
  -d grant_type=authorization_code); then
  echo "❌ Could not contact Strava to retrieve an access token." >&2
  exit 1
fi

ACCESS_TOKEN=$(jq -r '.access_token // empty' <<<"$TOKEN_RESPONSE")
if [[ -z "$ACCESS_TOKEN" ]]; then
  MESSAGE=$(jq -r '.message // "Unknown error"' <<<"$TOKEN_RESPONSE" 2>/dev/null || printf '%s' "$TOKEN_RESPONSE")
  echo "❌ Failed to retrieve access token: $MESSAGE" >&2
  exit 1
fi

echo "✅ Access token acquired."

if [[ -f "$OUTPUT" ]] && ! jq -e 'type == "array"' "$OUTPUT" >/dev/null; then
  echo "❌ Existing file is not a JSON array: $OUTPUT" >&2
  exit 1
fi

TEMP_DIR=$(mktemp -d)
trap 'rm -rf -- "$TEMP_DIR"' EXIT
FETCHED_FILE="$TEMP_DIR/fetched.json"
IDS_FILE="$TEMP_DIR/existing_ids.json"
printf '[]\n' > "$FETCHED_FILE"

if [[ "$FULL_REFRESH" == false && -f "$OUTPUT" ]]; then
  jq 'map({key: (.id | tostring), value: true}) | from_entries' "$OUTPUT" > "$IDS_FILE"
  EXISTING_COUNT=$(jq 'length' "$OUTPUT")
  echo "📥 Checking for new activities ($EXISTING_COUNT already stored)..."
else
  printf '{}\n' > "$IDS_FILE"
  if [[ "$FULL_REFRESH" == true ]]; then
    echo "📥 Refetching all activities..."
  else
    echo "📥 Downloading activities..."
  fi
fi

PAGE=1
PER_PAGE=50
FETCHED_COUNT=0

while true; do
  if ! HTTP_RESPONSE=$(curl -sS -w $'\n%{http_code}' \
    "https://www.strava.com/api/v3/athlete/activities?page=$PAGE&per_page=$PER_PAGE" \
    -H "Authorization: Bearer $ACCESS_TOKEN"); then
    echo "❌ Could not contact Strava while fetching page $PAGE. Existing data was left unchanged." >&2
    exit 1
  fi

  HTTP_STATUS=${HTTP_RESPONSE##*$'\n'}
  RESPONSE=${HTTP_RESPONSE%$'\n'*}

  if [[ "$HTTP_STATUS" != 200 ]]; then
    MESSAGE=$(jq -r '.message // "Unknown API error"' <<<"$RESPONSE" 2>/dev/null || printf '%s' "$RESPONSE")
    ERROR_DETAILS=$(jq -r '
      [.errors[]?
        | [.resource, .field, .code]
        | map(select(. != null and . != ""))
        | join(" / ")]
      | join("; ")
    ' <<<"$RESPONSE" 2>/dev/null || true)
    echo "❌ Strava returned HTTP $HTTP_STATUS on page $PAGE: $MESSAGE" >&2
    if [[ -n "$ERROR_DETAILS" ]]; then
      echo "Details: $ERROR_DETAILS" >&2
    fi
    if jq -e '
      any(.errors[]?;
        .resource == "Application"
        and .field == "Status"
        and .code == "Inactive")
    ' >/dev/null 2>&1 <<<"$RESPONSE"; then
      echo "Your Strava API application is inactive. The account that owns the app must have an active Strava subscription; then reactivate the app at https://www.strava.com/settings/api." >&2
    elif [[ "$HTTP_STATUS" == 429 ]]; then
      echo "The Strava rate limit was reached. Retry after the limit resets." >&2
    fi
    echo "Existing data was left unchanged." >&2
    exit 1
  fi

  if ! jq -e 'type == "array"' >/dev/null <<<"$RESPONSE"; then
    MESSAGE=$(jq -r '.message // "response was not an array"' <<<"$RESPONSE" 2>/dev/null || printf '%s' "$RESPONSE")
    echo "❌ Unexpected Strava response on page $PAGE: $MESSAGE" >&2
    echo "Existing data was left unchanged." >&2
    exit 1
  fi

  COUNT=$(jq 'length' <<<"$RESPONSE")
  if (( COUNT == 0 )); then
    break
  fi

  STOP_INDEX=$COUNT
  if [[ "$FULL_REFRESH" == false && -f "$OUTPUT" ]]; then
    STOP_INDEX=$(jq --slurpfile ids "$IDS_FILE" '
      length as $count
      | (first(range(0; $count) as $i
          | select($ids[0][(.[ $i ].id | tostring)] == true)
          | $i) // $count)
    ' <<<"$RESPONSE")
  fi

  NEXT_FETCHED="$TEMP_DIR/fetched-next.json"
  jq -s --argjson stop "$STOP_INDEX" '.[0] + (.[1][0:$stop])' \
    "$FETCHED_FILE" <(printf '%s\n' "$RESPONSE") > "$NEXT_FETCHED"
  mv "$NEXT_FETCHED" "$FETCHED_FILE"

  FETCHED_COUNT=$((FETCHED_COUNT + STOP_INDEX))
  echo "Fetched page $PAGE: $STOP_INDEX new of $COUNT returned activities."

  if (( STOP_INDEX < COUNT || COUNT < PER_PAGE )); then
    break
  fi
  PAGE=$((PAGE + 1))
done

FINAL_FILE="$TEMP_DIR/final.json"
if [[ "$FULL_REFRESH" == false && -f "$OUTPUT" ]]; then
  jq -s 'add | unique_by(.id) | sort_by(.start_date // .start_date_local // "") | reverse' \
    "$FETCHED_FILE" "$OUTPUT" > "$FINAL_FILE"
else
  jq 'unique_by(.id) | sort_by(.start_date // .start_date_local // "") | reverse' \
    "$FETCHED_FILE" > "$FINAL_FILE"
fi

mv "$FINAL_FILE" "$OUTPUT"

find "$DATA_DIR" -maxdepth 1 -type f -name 'activities_*.json' -printf 'data/%f\n' \
  | sort \
  | jq -R -s -c 'split("\n")[:-1]' > "$DATA_DIR/manifest.json"

TOTAL_COUNT=$(jq 'length' "$OUTPUT")
echo "✅ Added $FETCHED_COUNT new activities; $TOTAL_COUNT total saved to $OUTPUT"
