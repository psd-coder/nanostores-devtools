#!/bin/bash
set -euo pipefail

# Folder of the package that carries the published version.
PACKAGE_DIR="."

if [ $# -lt 1 ]; then
  echo "Usage: $0 <patch|minor|major>"
  exit 1
fi

VERSION_TYPE=$1

case "$VERSION_TYPE" in
  patch | minor | major) ;;
  *)
    echo "$VERSION_TYPE is no version step: pass patch, minor or major"
    exit 1
    ;;
esac

PACKAGE_JSON="$PACKAGE_DIR/package.json"
CHANGELOG="$PACKAGE_DIR/CHANGELOG.md"

NEW_VERSION=$(node -e '
  const fs = require("node:fs");
  const [file, type] = process.argv.slice(1);
  const raw = fs.readFileSync(file, "utf8");
  const found = raw.match(/"version":\s*"(\d+)\.(\d+)\.(\d+)"/);

  if (!found) {
    console.error(`${file} carries no plain version to bump`);
    process.exit(1);
  }

  const [major, minor, patch] = found.slice(1).map(Number);
  const next = {
    major: `${major + 1}.0.0`,
    minor: `${major}.${minor + 1}.0`,
    patch: `${major}.${minor}.${patch + 1}`,
  }[type];

  fs.writeFileSync(file, raw.replace(found[0], `"version": "${next}"`));
  process.stdout.write(next);
' "$PACKAGE_JSON" "$VERSION_TYPE")

PATHS=("$PACKAGE_JSON")

if [ -f "$CHANGELOG" ]; then
  PATHS+=("$CHANGELOG")
fi

git commit -m "Bump version to: $NEW_VERSION" -- "${PATHS[@]}"
git tag -a "$NEW_VERSION" -m "Release $NEW_VERSION"

echo "Version bump complete. New version: $NEW_VERSION"
echo "Remember to push both the commit and the tag:"
echo "  git push origin $(git branch --show-current)"
echo "  git push --tags"
