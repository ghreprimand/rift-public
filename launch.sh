#!/bin/bash
export PATH="/opt/homebrew/bin:$PATH"
# Resolve to this script's own directory so the launcher works regardless of where the repo lives
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
cd "$DIR" && npm start
