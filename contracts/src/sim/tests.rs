use super::*;

/// Fixed-seed CI smoke: a swarm of scenarios covering churn, slashes,
/// arrears and cap pressure must complete with zero violations.
#[test]
fn simulation_smoke_zero_violations() {
    let mut total_epochs = 0;
    for seed in 1..=40u64 {
        let sc = Scenario::from_seed(seed, 48);
        let result = run_scenario(sc);
        assert!(
            result.violations.is_empty(),
            "seed {seed} violations: {:#?}",
            result.violations
        );
        total_epochs += result.stats.epochs;
    }
    assert!(total_epochs >= 40 * 48);
}

/// Boundary-domain CI check (SECURITY.md): every edge scenario completes with zero
/// violations, and each demonstrably hit the edge it targets.
#[test]
fn simulation_boundary_domain_zero_violations() {
    for (label, sc) in boundary_scenarios(48) {
        let result = run_scenario(sc);
        assert!(
            result.violations.is_empty(),
            "boundary scenario '{label}' violations: {:#?}",
            result.violations
        );
        let s = &result.stats;
        assert!(s.epochs >= 48, "'{label}' ran only {} epochs", s.epochs);
        match label {
            "dust-economy" => {
                assert!(s.deposits > 0, "dust economy made no deposits");
                assert!(
                    s.max_tvv <= 1_000 * 200,
                    "dust economy TVL escaped the dust range: {}",
                    s.max_tvv
                );
            }
            "empty-vault" => {
                assert_eq!(s.deposits, 0, "empty-vault scenario deposited");
                assert_eq!(s.max_tvv, 0, "empty-vault scenario accrued TVV");
            }
            "uint64-share-crossing" => {
                assert!(
                    s.max_shares > u64::MAX as u128,
                    "share supply never crossed uint64: {}",
                    s.max_shares
                );
            }
            "extreme-tvl" => {
                assert!(
                    s.max_tvv > 1_000_000_000_000_000_000_000_000_000, // > 1e27
                    "extreme-TVL scenario stayed small: {}",
                    s.max_tvv
                );
            }
            "margin-zero" => {
                // The edge is exercised when the no-cover path produces refunds.
                assert!(
                    s.redemption_requests > 0,
                    "margin-zero raised no redemptions"
                );
                assert!(
                    s.redemption_refunds > 0,
                    "margin-zero never refunded — the zero-margin edge was not exercised"
                );
            }
            "margin-max" => {
                // The edge is exercised when traffic flowed through the over-covering reserve.
                assert!(
                    s.redemption_requests > 0,
                    "margin-max raised no redemptions"
                );
                assert!(s.redemptions_paid > 0, "margin-max paid no redemptions");
            }
            _ => {}
        }
    }
}

/// Calendar-cadence CI check: every timing edge completes with zero violations
/// and demonstrably reached its edge; the mobilization ceiling is asserted inline.
#[test]
fn simulation_calendar_domain_zero_violations() {
    for (label, sc) in calendar_scenarios(48) {
        let result = run_scenario(sc);
        assert!(
            result.violations.is_empty(),
            "calendar scenario '{label}' violations: {:#?}",
            result.violations
        );
        let s = &result.stats;
        assert!(s.epochs >= 48, "'{label}' ran only {} epochs", s.epochs);
        match label {
            "calendar-compressed-gap" => {
                assert!(
                    s.min_run_gap_secs < UNBOND_SECS,
                    "compressed-gap scenario never squeezed below the unbonding period: {}s",
                    s.min_run_gap_secs
                );
            }
            "calendar-skipped-month" => {
                assert!(
                    s.max_month_skip >= 2,
                    "skipped-month scenario never skipped a month (max jump {})",
                    s.max_month_skip
                );
            }
            "calendar-leap-february" => {
                assert!(s.saw_february, "leap scenario never traversed February");
            }
            _ => {}
        }
    }
}

/// Golden test: a tiny fixed scenario (one validator,
/// no rewards/fees/slashes/churn, a fixed deposit every step, one epoch)
/// serializes to the exact expected trace JSON.
#[test]
fn trace_export_golden_json() {
    let sc = Scenario {
        seed: 7,
        epochs: 1,
        max_validators: 1,
        reward_bps_per_epoch: 0,
        commission_bps: 0,
        aum_fee_bps: 0,
        performance_threshold_bps: 0,
        deposit_ceiling: 5_000_000,
        min_deposit: 5_000_000,
        p_deposit: 100,
        p_redeem: 0,
        p_jail: 0,
        p_enroll: 0,
        p_unregister: 0,
        p_tip: 0,
        p_pay_commission: 0,
        genesis_secs: GENESIS_SECS,
        keeper_jitter_max_secs: 0,
        timing: Timing::Jitter,
        // Pinned so the golden trace stays byte-identical.
        redemption_margin_bps: 50,
    };
    let (result, trace) = run_scenario_traced(sc);
    assert!(
        result.violations.is_empty(),
        "golden scenario violations: {:#?}",
        result.violations
    );
    let json = serde_json::to_string_pretty(&trace).unwrap();
    assert_eq!(json, GOLDEN_TRACE_JSON);
}

/// Summing trace events across addresses must reproduce the pooled totals exactly;
/// splitting a pooled deposit/redemption across owners inflates the per-kind count.
#[test]
fn trace_per_actor_totals_match_pooled_stats() {
    for seed in [1u64, 4, 8] {
        let sc = Scenario::from_seed(seed, 24);
        let (result, trace) = run_scenario_traced(sc);
        assert!(
            result.violations.is_empty(),
            "seed {seed} violations: {:#?}",
            result.violations
        );
        let mut by_address: BTreeMap<&str, BTreeMap<EventKind, u64>> = BTreeMap::new();
        for e in &trace.events {
            *by_address
                .entry(e.address.as_str())
                .or_default()
                .entry(e.kind)
                .or_insert(0) += 1;
        }
        let pooled = |kind: EventKind| -> u64 {
            by_address
                .values()
                .map(|k| *k.get(&kind).unwrap_or(&0))
                .sum()
        };
        assert_eq!(
            pooled(EventKind::SwapIn),
            result.stats.deposits,
            "seed {seed}: per-actor swap_in totals must sum to the pooled deposit count"
        );
        assert_eq!(
            pooled(EventKind::SwapOutRequest),
            result.stats.redemption_requests,
            "seed {seed}: per-actor swap_out_request totals must sum to the pooled request count (never split)"
        );
        assert_eq!(
            pooled(EventKind::RedemptionPayout),
            result.stats.redemptions_paid,
            "seed {seed}: per-actor payout totals must sum to the pooled paid count"
        );
        assert_eq!(
            pooled(EventKind::RedemptionRefund),
            result.stats.redemption_refunds,
            "seed {seed}: per-actor refund totals must sum to the pooled refund count"
        );
    }
}

/// Tracing is purely observational: a traced run must reach byte-identical
/// pooled stats to an untraced run of the same seed.
#[test]
fn tracing_never_changes_economics() {
    for seed in [1u64, 4, 8, 9] {
        let untraced = run_scenario(Scenario::from_seed(seed, 24));
        let (traced, _trace) = run_scenario_traced(Scenario::from_seed(seed, 24));
        assert_eq!(
            untraced.stats.deposits, traced.stats.deposits,
            "seed {seed}: deposits"
        );
        assert_eq!(
            untraced.stats.redemption_requests, traced.stats.redemption_requests,
            "seed {seed}: redemption_requests"
        );
        assert_eq!(
            untraced.stats.redemptions_paid, traced.stats.redemptions_paid,
            "seed {seed}: redemptions_paid"
        );
        assert_eq!(
            untraced.stats.redemption_refunds, traced.stats.redemption_refunds,
            "seed {seed}: redemption_refunds"
        );
        assert_eq!(
            untraced.stats.max_tvv, traced.stats.max_tvv,
            "seed {seed}: max_tvv"
        );
        assert_eq!(
            untraced.stats.max_shares, traced.stats.max_shares,
            "seed {seed}: max_shares"
        );
        assert_eq!(
            untraced.violations.len(),
            traced.violations.len(),
            "seed {seed}: violation count"
        );
    }
}

const GOLDEN_TRACE_JSON: &str = r#"{
  "seed": 7,
  "epochs": [
    {
      "epoch_index": 1,
      "ended_at_seconds": 1738402741,
      "tvv_after": "35000000",
      "total_shares": "35000000000000"
    }
  ],
  "events": [
    {
      "seq": 0,
      "address": "user-0",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    },
    {
      "seq": 1,
      "address": "user-1",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    },
    {
      "seq": 2,
      "address": "user-2",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    },
    {
      "seq": 3,
      "address": "user-0",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    },
    {
      "seq": 4,
      "address": "user-1",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    },
    {
      "seq": 5,
      "address": "user-2",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    },
    {
      "seq": 6,
      "address": "user-0",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    }
  ]
}"#;
