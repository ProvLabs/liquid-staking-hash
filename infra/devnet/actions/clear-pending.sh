#!/usr/bin/env bash
# Drop stuck continuation queues (admin recovery hatch). Safe: withdrawn nHASH
# settles back next epoch; dropped redelegations leave stake in place.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
execute '{"clear_pending_delegations":{}}'
smart '{"epoch_status":{}}'
