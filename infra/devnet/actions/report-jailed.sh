#!/usr/bin/env bash
# Usage: report-jailed.sh <valoper>
# Phase 1 of the jail flow (permissionless): record the first observation of a
# jailed validator, starting the purge cooldown.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ $# -ge 1 ] || { echo "usage: $0 <valoper>" >&2; exit 1; }
execute "{\"report_jailed_validator\":{\"valoper\":\"$1\"}}"
smart '{"jail_reports":{}}'
