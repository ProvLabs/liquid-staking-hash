use super::*;

fn tgt(v: &str, a: u128) -> (String, Uint128) {
    (v.to_string(), Uint128::new(a))
}

#[test]
fn split_even_sums_and_spreads() {
    let parts = split_even(Uint128::new(10), 3);
    assert_eq!(
        parts,
        vec![Uint128::new(4), Uint128::new(3), Uint128::new(3)]
    );
    assert_eq!(parts.iter().sum::<Uint128>(), Uint128::new(10));
    assert!(split_even(Uint128::new(10), 0).is_empty());
}

fn room(v: &str, h: u128) -> (String, Uint128) {
    (v.to_string(), Uint128::new(h))
}

#[test]
fn plan_deploy_capped_spreads_evenly_when_unconstrained() {
    let rooms = vec![room("valA", 1000), room("valB", 1000), room("valC", 1000)];
    assert_eq!(
        plan_deploy_capped(Uint128::new(10), &rooms),
        vec![tgt("valA", 4), tgt("valB", 3), tgt("valC", 3)]
    );
    assert_eq!(
        plan_deploy_capped(Uint128::new(2), &rooms),
        vec![tgt("valA", 1), tgt("valB", 1)]
    );
    assert!(plan_deploy_capped(Uint128::zero(), &rooms).is_empty());
    assert!(plan_deploy_capped(Uint128::new(10), &[]).is_empty());
}

#[test]
fn plan_deploy_capped_clamps_and_redistributes() {
    // valB can only take 2; its excess share flows to valA and valC.
    let rooms = vec![room("valA", 100), room("valB", 2), room("valC", 100)];
    let targets = plan_deploy_capped(Uint128::new(30), &rooms);
    assert_eq!(
        targets,
        vec![tgt("valA", 14), tgt("valB", 2), tgt("valC", 14)]
    );
    let total: Uint128 = targets.iter().map(|(_, a)| *a).sum();
    assert_eq!(total, Uint128::new(30));
}

#[test]
fn plan_deploy_capped_leaves_undeliverable_residual_unallocated() {
    // Total headroom 5 < budget 30: allocate 5, the rest stays liquid.
    let rooms = vec![room("valA", 3), room("valB", 2), room("valC", 0)];
    let targets = plan_deploy_capped(Uint128::new(30), &rooms);
    assert_eq!(targets, vec![tgt("valA", 3), tgt("valB", 2)]);
    // All-zero headroom: nothing allocated at all.
    assert!(plan_deploy_capped(Uint128::new(30), &[room("valA", 0)]).is_empty());
}

#[test]
fn uptime_ratio_bps_clamps_malformed_inputs() {
    assert_eq!(uptime_ratio_bps(34_560, 0), 10_000);
    assert_eq!(uptime_ratio_bps(34_560, 34_560), 0);
    assert_eq!(uptime_ratio_bps(34_560, 40_000), 0); // missed > window
    assert_eq!(uptime_ratio_bps(34_560, -5), 10_000); // negative missed
    assert_eq!(uptime_ratio_bps(0, 0), 0); // degenerate window
    assert_eq!(uptime_ratio_bps(10_000, 200), 9_800);
}

#[test]
fn max_bond_adjusted_clamps_and_offsets() {
    let bonded = Uint128::new(1_000_000);
    // 5.5x / 68 validators = 808 bps (within 5%..33%); no offset.
    assert_eq!(
        max_bond_adjusted(bonded, 68, 55_000, 500, 3300, 0),
        Uint128::new(80_800)
    );
    // 5.5x / 200 = 275 bps, clamped up to the 5% floor.
    assert_eq!(
        max_bond_adjusted(bonded, 200, 55_000, 500, 3300, 0),
        Uint128::new(50_000)
    );
    // 5.5x / 10 = 5500 bps, clamped down to the 33% ceiling.
    assert_eq!(
        max_bond_adjusted(bonded, 10, 55_000, 500, 3300, 0),
        Uint128::new(330_000)
    );
    // 5% safety offset shaves 5% off the max bond.
    assert_eq!(
        max_bond_adjusted(bonded, 200, 55_000, 500, 3300, 500),
        Uint128::new(47_500)
    );
    // No active validators: zero.
    assert_eq!(
        max_bond_adjusted(bonded, 0, 55_000, 500, 3300, 0),
        Uint128::zero()
    );
}

#[test]
fn plan_claim_includes_removed_validators_with_rewards() {
    let vals = vec!["valA".to_string(), "valB".to_string()];
    let with = vec!["valZ".to_string(), "valA".to_string()];
    assert_eq!(
        plan_claim(&vals, &with),
        vec!["valA".to_string(), "valZ".to_string()]
    );
}

#[test]
fn take_chunk_splits_by_max() {
    let t = vec![tgt("a", 1), tgt("b", 2), tgt("c", 3)];
    let (run, rest) = take_chunk(t.clone(), 0);
    assert_eq!(run, t);
    assert!(rest.is_empty());
    let (run, rest) = take_chunk(t.clone(), 2);
    assert_eq!(run, vec![tgt("a", 1), tgt("b", 2)]);
    assert_eq!(rest, vec![tgt("c", 3)]);
    let (run, rest) = take_chunk(t.clone(), 5);
    assert_eq!(run, t);
    assert!(rest.is_empty());
}

#[test]
fn fee_reserve_scales_with_tvv_and_time() {
    // 1e9 x 15 bps = 1_500_000/yr; x 2_592_000/31_536_000 = 123_287 (floor).
    assert_eq!(
        fee_reserve(Uint128::new(1_000_000_000), 15, 2_592_000),
        Uint128::new(123_287)
    );
    assert_eq!(
        fee_reserve(Uint128::new(1_000_000_000), 0, 2_592_000),
        Uint128::zero()
    );
    assert_eq!(
        fee_reserve(Uint128::new(1_000_000_000), 15, 0),
        Uint128::zero()
    );
}

#[test]
fn redemption_need_applies_margin() {
    assert_eq!(
        redemption_need(&[(1, Uint128::new(1000)), (2, Uint128::new(1000))], 50),
        Uint128::new(2010)
    );
    assert_eq!(redemption_need(&[], 50), Uint128::zero());
}

#[test]
fn plan_unbond_walks_drain_order() {
    // Takes from the front of drain order, spilling only when a validator is exhausted.
    let dels = vec![
        DelegationView {
            valoper: "valB".into(),
            staked: Uint128::new(100),
        },
        DelegationView {
            valoper: "valA".into(),
            staked: Uint128::new(300),
        },
        DelegationView {
            valoper: "valC".into(),
            staked: Uint128::new(50),
        },
    ];
    assert_eq!(
        plan_unbond(&dels, Uint128::new(250), &[]),
        vec![tgt("valB", 100), tgt("valA", 150)]
    );
    assert_eq!(
        plan_unbond(&dels, Uint128::new(420), &[]),
        vec![tgt("valB", 100), tgt("valA", 300), tgt("valC", 20)]
    );
    assert!(plan_unbond(&dels, Uint128::zero(), &[]).is_empty());
}

fn seat(v: &str, current: u128, headroom: u128) -> RebalanceSeat {
    RebalanceSeat {
        valoper: v.to_string(),
        current: Uint128::new(current),
        add_headroom: Uint128::new(headroom),
    }
}
fn dv(v: &str, staked: u128) -> DelegationView {
    DelegationView {
        valoper: v.to_string(),
        staked: Uint128::new(staked),
    }
}
fn no_blocks() -> (BTreeSet<String>, BTreeSet<(String, String)>) {
    (BTreeSet::new(), BTreeSet::new())
}

#[test]
fn rebalance_converges_to_uniform_slot() {
    // 300 + 0 + 0 staked, 60 fresh: slot = 120 each.
    let (bs, bp) = no_blocks();
    let plan = plan_rebalance(
        &[
            seat("valA", 300, 1000),
            seat("valB", 0, 1000),
            seat("valC", 0, 1000),
        ],
        &[],
        Uint128::new(60),
        &bs,
        &bp,
    );
    // valA sheds 180 to B (120) and C (60); fresh 60 tops C to 120.
    assert_eq!(
        plan.redelegations,
        vec![
            ("valA".into(), "valB".into(), Uint128::new(120)),
            ("valA".into(), "valC".into(), Uint128::new(60)),
        ]
    );
    assert_eq!(
        plan.delegations,
        vec![("valC".to_string(), Uint128::new(60))]
    );
    assert_eq!(plan.undeployable, Uint128::zero());
}

#[test]
fn rebalance_drains_non_eligible_via_redelegation() {
    // Unregistered valX's 90 moves to the eligible seats, never unbonds.
    let (bs, bp) = no_blocks();
    let plan = plan_rebalance(
        &[seat("valA", 30, 1000), seat("valB", 0, 1000)],
        &[dv("valX", 90)],
        Uint128::zero(),
        &bs,
        &bp,
    );
    // Pool 120 -> slot 60: valX's 90 fills valB's 60 then valA's 30.
    let moved: Uint128 = plan
        .redelegations
        .iter()
        .filter(|(s, _, _)| s == "valX")
        .map(|(_, _, a)| *a)
        .sum();
    assert_eq!(moved, Uint128::new(90));
    assert!(plan.redelegations.iter().all(|(s, d, _)| s != d));
    assert!(plan.delegations.is_empty());
}

#[test]
fn rebalance_respects_headroom_and_priority_residual() {
    // Slot 100 each, but valB caps at 10: excess flows to valA; untakeable fresh stays liquid.
    let (bs, bp) = no_blocks();
    let plan = plan_rebalance(
        &[seat("valA", 0, 130), seat("valB", 0, 10)],
        &[],
        Uint128::new(200),
        &bs,
        &bp,
    );
    assert_eq!(
        plan.delegations,
        vec![
            ("valA".to_string(), Uint128::new(130)),
            ("valB".to_string(), Uint128::new(10))
        ]
    );
    assert_eq!(plan.undeployable, Uint128::new(60));
}

#[test]
fn rebalance_pins_blocked_sources_and_routes_around_blocked_pairs() {
    let mut bs = BTreeSet::new();
    bs.insert("valA".to_string()); // in-flight inbound redelegation: cannot give
    let bp = BTreeSet::new();
    let plan = plan_rebalance(
        &[seat("valA", 300, 100), seat("valB", 0, 1000)],
        &[dv("valX", 60)],
        Uint128::zero(),
        &bs,
        &bp,
    );
    // valA is pinned at 300; only valX's 60 moves, all to valB.
    assert_eq!(
        plan.redelegations,
        vec![("valX".into(), "valB".into(), Uint128::new(60))]
    );

    // A blocked (src,dst) route defers the movement when no other destination needs stake.
    let (bs2, mut bp2) = no_blocks();
    bp2.insert(("valX".to_string(), "valB".to_string()));
    let plan = plan_rebalance(
        &[seat("valB", 0, 1000)],
        &[dv("valX", 60)],
        Uint128::zero(),
        &bs2,
        &bp2,
    );
    assert!(plan.redelegations.is_empty()); // deferred, stays staked
}

#[test]
fn rebalance_with_no_eligible_moves_nothing() {
    let (bs, bp) = no_blocks();
    let plan = plan_rebalance(&[], &[dv("valX", 500)], Uint128::new(70), &bs, &bp);
    assert!(plan.redelegations.is_empty());
    assert!(plan.delegations.is_empty());
    assert_eq!(plan.undeployable, Uint128::new(70));
}

#[test]
fn annualized_bps_scales_and_guards() {
    // 1% inflow over a 365-day window = 100 bps.
    assert_eq!(
        annualized_bps(Uint128::new(10_000), Uint128::new(1_000_000), 31_536_000),
        100
    );
    // Same inflow over half the window doubles the rate.
    assert_eq!(
        annualized_bps(Uint128::new(10_000), Uint128::new(1_000_000), 15_768_000),
        200
    );
    assert_eq!(annualized_bps(Uint128::zero(), Uint128::new(1), 100), 0);
    assert_eq!(annualized_bps(Uint128::new(1), Uint128::zero(), 100), 0);
    assert_eq!(annualized_bps(Uint128::new(1), Uint128::new(1), 0), 0);
    // Overflow guard degrades to 0 rather than panicking.
    assert_eq!(annualized_bps(Uint128::MAX, Uint128::new(1), 1), 0);
}

#[test]
fn commission_on_floors() {
    assert_eq!(commission_on(Uint128::new(1000), 1000), Uint128::new(100));
    assert_eq!(commission_on(Uint128::new(999), 1000), Uint128::new(99)); // floor
    assert_eq!(commission_on(Uint128::new(1000), 0), Uint128::zero());
    assert_eq!(commission_on(Uint128::zero(), 1000), Uint128::zero());
}

#[test]
fn plan_unbond_skips_validators_at_entry_capacity() {
    let dels = vec![
        DelegationView {
            valoper: "valA".into(),
            staked: Uint128::new(300),
        },
        DelegationView {
            valoper: "valB".into(),
            staked: Uint128::new(100),
        },
    ];
    let plan = plan_unbond(&dels, Uint128::new(150), &["valA".to_string()]);
    assert_eq!(plan, vec![tgt("valB", 100)]);
}

#[test]
fn plan_service_expedites_only_from_marker_liquid() {
    let dels = vec![DelegationView {
        valoper: "valA".into(),
        staked: Uint128::new(500),
    }];
    // Coverage 300 >= need 200 (no unbond), but only 50 in the marker: no expedites
    // (an unfunded maturity refunds, i.e. cancels, the user's redemption).
    let plan = plan_service(
        &[(1, Uint128::new(100)), (2, Uint128::new(100))],
        Uint128::new(300),
        Uint128::new(50),
        Uint128::zero(),
        &dels,
        &[],
        0,
    );
    assert!(plan.expedite_ids.is_empty());
    assert!(plan.undelegations.is_empty());
}

#[test]
fn plan_service_expedite_gate_includes_margin() {
    // estimate 1000 at 50 bps needs 1005 in the marker; 1004 is not enough.
    let plan = plan_service(
        &[(1, Uint128::new(1000))],
        Uint128::new(10_000),
        Uint128::new(1004),
        Uint128::zero(),
        &[],
        &[],
        50,
    );
    assert!(plan.expedite_ids.is_empty());
    let plan = plan_service(
        &[(1, Uint128::new(1000))],
        Uint128::new(10_000),
        Uint128::new(1005),
        Uint128::zero(),
        &[],
        &[],
        50,
    );
    assert_eq!(plan.expedite_ids, vec![1]);
}

#[test]
fn plan_service_subtracts_inflight_unbonding_and_adds_margin() {
    let dels = vec![DelegationView {
        valoper: "valA".into(),
        staked: Uint128::new(1000),
    }];
    // need 1010; cover 200 + 700 unbonding: unbond only the 110 increment, never re-unbond.
    let plan = plan_service(
        &[(1, Uint128::new(1000))],
        Uint128::new(200),
        Uint128::new(200),
        Uint128::new(700),
        &dels,
        &[],
        100,
    );
    assert_eq!(plan.undelegations, vec![tgt("valA", 110)]);
    let plan2 = plan_service(
        &[(1, Uint128::new(1000))],
        Uint128::new(200),
        Uint128::new(200),
        Uint128::new(900),
        &dels,
        &[],
        100,
    );
    assert!(plan2.undelegations.is_empty());
}

#[test]
fn plan_return_splits_settle_and_write_down() {
    // nothing out: nothing to do.
    assert_eq!(
        plan_return(
            Uint128::zero(),
            Uint128::zero(),
            Uint128::zero(),
            Uint128::new(100)
        ),
        ReturnPlan {
            settle: Uint128::zero(),
            write_down: Uint128::zero()
        }
    );
    // all matured and backed by returned liquid: settle everything.
    assert_eq!(
        plan_return(
            Uint128::new(1000),
            Uint128::zero(),
            Uint128::zero(),
            Uint128::new(1000)
        ),
        ReturnPlan {
            settle: Uint128::new(1000),
            write_down: Uint128::zero()
        }
    );
    // still unbonding: not matured, nothing moves.
    assert_eq!(
        plan_return(
            Uint128::new(1000),
            Uint128::zero(),
            Uint128::new(1000),
            Uint128::zero()
        ),
        ReturnPlan {
            settle: Uint128::zero(),
            write_down: Uint128::zero()
        }
    );
    // partial: 900 still out of 1000; liquid 150: settle the matured 100, 50 is rewards.
    assert_eq!(
        plan_return(
            Uint128::new(1000),
            Uint128::new(600),
            Uint128::new(300),
            Uint128::new(150)
        ),
        ReturnPlan {
            settle: Uint128::new(100),
            write_down: Uint128::zero()
        }
    );
}

#[test]
fn plan_return_write_down_recognizes_slash_immediately() {
    // 5% slash, no liquid: the whole 50 is an unbacked write-down THIS epoch.
    assert_eq!(
        plan_return(
            Uint128::new(1000),
            Uint128::new(950),
            Uint128::zero(),
            Uint128::zero()
        ),
        ReturnPlan {
            settle: Uint128::zero(),
            write_down: Uint128::new(50)
        }
    );
    // 30 rewards net through settle, 20 writes down; settle + write_down == matured always.
    assert_eq!(
        plan_return(
            Uint128::new(1000),
            Uint128::new(950),
            Uint128::zero(),
            Uint128::new(30)
        ),
        ReturnPlan {
            settle: Uint128::new(30),
            write_down: Uint128::new(20)
        }
    );
}
