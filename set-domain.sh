#!/usr/bin/env bash
# ============================================================
# STMZ KINETIC — set-domain
# Run once before deploying. Replaces every REPLACE-WITH-YOUR-DOMAIN.com
# placeholder in the codebase with your actual domain.
#
# Usage:
#   ./set-domain.sh stmzkinetic.com
#   ./set-domain.sh mycompany.is-a.dev
# ============================================================
set -euo pipefail

if [ -z "${1-}" ]; then
  echo "Usage: $0 <your-domain.com>"
  echo "Example: $0 stmzkinetic.com"
  exit 1
fi

DOMAIN="$1"
PLACEHOLDER="REPLACE-WITH-YOUR-DOMAIN.com"

if [[ "$DOMAIN" == *"://"* ]] || [[ "$DOMAIN" == "www."* ]]; then
  echo "Pass just the domain — no https://, no www. (e.g. stmzkinetic.com)"
  exit 1
fi

echo "Setting domain to: $DOMAIN"
echo ""

# Files that contain the placeholder
FILES=(
  "public/index.html"
  "public/sitemap.xml"
  "public/robots.txt"
)

for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    if grep -q "$PLACEHOLDER" "$f"; then
      # macOS-safe sed: -i '' on Darwin, -i on Linux
      if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "s/$PLACEHOLDER/$DOMAIN/g" "$f"
      else
        sed -i "s/$PLACEHOLDER/$DOMAIN/g" "$f"
      fi
      echo "  ✓ $f"
    else
      echo "  — $f  (no placeholder, skipped)"
    fi
  fi
done

echo ""
echo "Done. Your site is now branded for: https://$DOMAIN"
echo ""
echo "Next: also set APP_URL=https://$DOMAIN in your .env / Render environment."
