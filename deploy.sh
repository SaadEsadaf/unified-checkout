#!/bin/bash
# Unified Checkout Deploy Script — dev → master → production
set -e

BRANCH="${1:-master}"
PROJECT_DIR="/var/www/unified-checkout"
PM2_NAME="payment-engine"

echo "=== Deploying Payment Engine ($BRANCH) ==="

cd "$PROJECT_DIR"

# Stash any local changes
git stash --include-untracked 2>/dev/null || true

# Pull latest
git checkout "$BRANCH"
git pull origin "$BRANCH"

# Install dependencies
npm install

# Restart
pm2 restart "$PM2_NAME" --update-env

echo "=== Deploy complete ==="
pm2 list
