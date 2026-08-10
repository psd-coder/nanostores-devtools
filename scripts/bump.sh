#!/bin/bash
set -euo pipefail

# Folder of the package that carries the published version.
PACKAGE_DIR="."

if [ $# -lt 1 ]; then
  echo "Usage: $0 <patch|minor|major>"
  exit 1
fi

VERSION_TYPE=$1

npm --no-git-tag-version version "$VERSION_TYPE" --prefix "$PACKAGE_DIR"

NEW_VERSION=$(node -p "require('./$PACKAGE_DIR/package.json').version")

git add "$PACKAGE_DIR/package.json"
git commit -m "Bump version to: $NEW_VERSION"
git tag -a "$NEW_VERSION" -m "Release $NEW_VERSION"

echo "Version bump complete. New version: $NEW_VERSION"
echo "Remember to push both the commit and the tag:"
echo "  git push origin main"
echo "  git push --tags"
