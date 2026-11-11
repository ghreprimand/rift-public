#!/bin/sh
set -eu
# Follow relative or absolute launcher links without GNU readlink -f on macOS.
rift_script=$0
rift_links=0
while [ -L "$rift_script" ]; do
  rift_links=$((rift_links + 1))
  if [ "$rift_links" -gt 20 ]; then printf 'Too many launcher links.\n' >&2; exit 1; fi
  rift_target=$(readlink "$rift_script")
  case "$rift_target" in
    /*) rift_script=$rift_target ;;
    *) rift_script=$(dirname "$rift_script")/$rift_target ;;
  esac
done
rift_dir=$(CDPATH= cd "$(dirname "$rift_script")" && pwd -P)
cd "$rift_dir"
exec npm start
