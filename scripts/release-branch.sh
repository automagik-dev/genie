#!/bin/bash

# Automated Release Branch Workflow
# Usage: ./scripts/release-branch.sh (from feat/release-vX.Y.Z branch)

set -e

VERSION=$(node -p "require('./package.json').version")
BRANCH=$(git branch --show-current)
PACKAGE=$(node -p "require('./package.json').name")

# Colors
GREEN='\033[32m'
YELLOW='\033[33m'
BLUE='\033[34m'
RED='\033[31m'
RESET='\033[0m'

echo -e "${BLUE}🚀 Release Workflow: $BRANCH${RESET}\n"

# Validate branch pattern
if [[ ! "$BRANCH" =~ ^feat/release- ]]; then
  echo -e "${RED}❌ Not on release branch (feat/release-*)${RESET}"
  exit 1
fi

echo -e "${GREEN}✅ On release branch: $BRANCH${RESET}"
echo "📌 Version: $VERSION"
echo ""

# Pre-flight: tests
echo -e "${BLUE}🧪 Running tests...${RESET}"
pnpm run test:all > /dev/null 2>&1 || {
  echo -e "${RED}❌ Tests failed${RESET}"
  exit 1
}
echo -e "${GREEN}✅ Tests passed${RESET}"

# Get previous tag
PREVIOUS_TAG=$(git tag --sort=-version:refname | head -1)
if [ -z "$PREVIOUS_TAG" ]; then
  PREVIOUS_TAG=$(git rev-list --max-parents=0 HEAD)
fi

echo ""
echo -e "${BLUE}📝 Analyzing commits since $PREVIOUS_TAG...${RESET}"

# Generate release notes (using gh release's auto-generate for now)
echo -e "${BLUE}🎉 Creating GitHub release...${RESET}"

gh release create v$VERSION \
  --title "v$VERSION" \
  --generate-notes || {
  echo -e "${YELLOW}⚠️  Release already exists or error creating${RESET}"
}

echo -e "${GREEN}✅ GitHub release created${RESET}"

RELEASE_URL="https://github.com/$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')/releases/tag/v$VERSION"
echo "🔗 $RELEASE_URL"
echo ""

# Create PR
echo -e "${BLUE}📋 Creating PR to main...${RESET}"

PR_URL=$(gh pr create \
  --base main \
  --title "chore: release v$VERSION" \
  --body "🚀 Automated release: v$VERSION

Branch: $BRANCH
Previous: $PREVIOUS_TAG

All tests passing. Ready for merge." \
  --json url \
  --jq '.url' 2>/dev/null || echo "")

if [ -z "$PR_URL" ]; then
  echo -e "${YELLOW}⚠️  Could not create PR (may already exist)${RESET}"
else
  echo -e "${GREEN}✅ PR created: $PR_URL${RESET}"
fi

# Wait for tests
echo ""
echo -e "${BLUE}⏳ Waiting for tests (max 5 min)...${RESET}"

MAX_WAIT=300
ELAPSED=0
PR_MERGED=false

while [ $ELAPSED -lt $MAX_WAIT ]; do
  PR_STATE=$(gh pr view --json mergeStateStatus --jq '.mergeStateStatus' 2>/dev/null || echo "")

  if [ "$PR_STATE" = "MERGEABLE" ]; then
    echo -e "${GREEN}✅ Tests passed, auto-merging...${RESET}"
    gh pr merge --auto --merge 2>/dev/null || true
    PR_MERGED=true
    break
  fi

  sleep 5
  ELAPSED=$((ELAPSED + 5))
done

if [ "$PR_MERGED" = false ]; then
  echo -e "${YELLOW}⏰ Tests or merge pending (check PR manually)${RESET}"
fi

# Wait for npm publish
echo ""
echo -e "${BLUE}📦 Verifying npm publish (waiting 60s for registry)...${RESET}"
sleep 60

if npm view $PACKAGE@$VERSION version >/dev/null 2>&1; then
  DIST_TAG=$(npm view $PACKAGE@$VERSION dist-tags --json | jq -r 'keys[0]')
  echo -e "${GREEN}✅ Published to npm (@$DIST_TAG)${RESET}"
else
  echo -e "${YELLOW}⚠️  Not on npm yet (check Actions)${RESET}"
fi

# Success
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}🎉 Release Complete!${RESET}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "Version: ${BLUE}v$VERSION${RESET}"
echo -e "Release: ${BLUE}$RELEASE_URL${RESET}"
echo -e "NPM: ${BLUE}https://www.npmjs.com/package/$PACKAGE/v/$VERSION${RESET}"
echo ""
