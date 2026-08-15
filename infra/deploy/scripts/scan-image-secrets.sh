#!/usr/bin/env bash
# image-secret-scan (plan 8.4 §4 invariant 1): the check:bundle idiom lifted
# one layer up. The images job plants SENTINEL values in every server-only
# env var and in decoy .env files inside the build context BEFORE building;
# this script then scans EVERY LAYER of the built image for the sentinel
# marker. Any hit fails CI — a public-registry pull must never yield a live
# DB credential or the assertion-minting HMAC key.
#
# Usage: scan-image-secrets.sh <sentinel-marker> <image> [<image>…]
# The sentinel marker is a fixed unique string embedded in every planted
# value (e.g. NVHASH_IMG_SENTINEL_d34db33f); planting is the CALLER's step so
# the scan cannot accidentally scan for a marker nothing planted.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <sentinel-marker> <image> [<image>…]" >&2
  exit 2
fi

sentinel="$1"
shift

fail=0
for image in "$@"; do
  workdir="$(mktemp -d)"
  trap 'rm -rf "$workdir"' EXIT
  echo "image-secret-scan: saving ${image}…"
  docker save "$image" -o "$workdir/image.tar"
  # Scan the whole OCI archive: layer tars, config JSON (ENV/labels), and
  # manifest — a sentinel anywhere in it is a finding. grep -a treats the
  # binary archive as text; the sentinel is ASCII by construction.
  if grep -a -q "$sentinel" "$workdir/image.tar"; then
    echo "image-secret-scan: SENTINEL FOUND in ${image} — a planted secret reached an image layer" >&2
    fail=1
  else
    echo "image-secret-scan: ${image} clean"
  fi
  rm -rf "$workdir"
  trap - EXIT
done

if [[ "$fail" -ne 0 ]]; then
  echo "image-secret-scan: FAILED — no secret of any kind may be baked into any image (D24; SECURITY.md)" >&2
  exit 1
fi
