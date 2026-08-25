use super::*;

#[test]
fn is_operator_compares_key_payloads_across_hrps() {
    // Same 20-byte payload under account and valoper HRPs.
    let payload = [7u8; 20];
    let acct = bech32::encode::<Bech32>(Hrp::parse("tp").unwrap(), &payload).unwrap();
    let valoper = bech32::encode::<Bech32>(Hrp::parse("tpvaloper").unwrap(), &payload).unwrap();
    let other = bech32::encode::<Bech32>(Hrp::parse("tpvaloper").unwrap(), &[8u8; 20]).unwrap();
    assert!(is_operator(&acct, &valoper));
    assert!(!is_operator(&acct, &other));
    assert!(!is_operator("garbage", &valoper));
    assert!(!is_operator(&acct, "garbage"));
}

#[test]
fn validate_valoper_requires_valoper_hrp() {
    assert!(validate_valoper("tpvaloper1abc").is_ok());
    assert!(matches!(
        validate_valoper("tp1abc"),
        Err(ContractError::InvalidValoper { .. })
    ));
}

#[test]
fn cons_address_derives_from_ed25519_key() {
    use provwasm_std::shim::Any;
    let key = vec![1u8; 32];
    let pk = Ed25519PubKey { key: key.clone() };
    let validator = Validator {
        operator_address: bech32::encode::<Bech32>(Hrp::parse("tpvaloper").unwrap(), &[7u8; 20])
            .unwrap(),
        consensus_pubkey: Some(Any {
            type_url: ED25519_PUBKEY_TYPE_URL.to_string(),
            value: pk.encode_to_vec(),
        }),
        ..Default::default()
    };
    let cons = cons_address(&validator).unwrap();
    assert!(cons.starts_with("tpvalcons1"));
    let (hrp, data) = bech32::decode(&cons).unwrap();
    assert_eq!(hrp.as_str(), "tpvalcons");
    assert_eq!(data.len(), 20);
    assert_eq!(data, Sha256::digest(&key)[..20].to_vec());
}

fn rec(enrolled_at: u64) -> ValidatorRecord {
    ValidatorRecord {
        operator: cosmwasm_std::Addr::unchecked("op"),
        enrolled_at: cosmwasm_std::Timestamp::from_seconds(enrolled_at),
        uptime_sum_bps: 0,
        uptime_count: 0,
        commission_accrued: Uint128::zero(),
        commission_paid: Uint128::zero(),
        commission_due: Uint128::zero(),
        commission_billed: Uint128::zero(),
        tip_epoch: Uint128::zero(),
    }
}

fn assessment(
    valoper: &str,
    tip: u128,
    uptime: Option<u64>,
    enrolled_at: u64,
    eligible: bool,
) -> Assessment {
    let mut record = rec(enrolled_at);
    record.tip_epoch = Uint128::new(tip);
    Assessment {
        valoper: valoper.to_string(),
        record,
        bonded: true,
        jailed: false,
        tombstoned: false,
        uptime_bps: uptime,
        in_arrears: false,
        eligible,
        headroom: Uint128::zero(),
    }
}

#[test]
fn priority_sorts_tip_then_uptime_then_enrollment() {
    let mut v = vec![
        assessment("valD", 0, Some(9900), 5, true), // no tip, high uptime
        assessment("valA", 100, Some(9000), 9, true), // top tip wins outright
        assessment("valB", 0, Some(9900), 2, true), // ties valD on uptime, older
        assessment("valC", 0, None, 1, true),       // unknown uptime sorts as 0
    ];
    sort_by_priority(&mut v);
    let order: Vec<&str> = v.iter().map(|a| a.valoper.as_str()).collect();
    assert_eq!(order, vec!["valA", "valB", "valD", "valC"]);
}

#[test]
fn drain_ranks_put_ineligible_before_eligible_lowest_priority_first() {
    let mut v = vec![
        assessment("valA", 100, Some(9900), 1, true),
        assessment("valB", 50, Some(9900), 1, true),
        assessment("valC", 0, Some(9000), 1, false), // ineligible
    ];
    sort_by_priority(&mut v);
    let ranks = drain_ranks(&v);
    // Ineligible valC drains first; among eligible, lower-priority valB before valA.
    assert!(ranks["valC"] < ranks["valB"]);
    assert!(ranks["valB"] < ranks["valA"]);

    let dels = vec![
        crate::plan::DelegationView {
            valoper: "valA".into(),
            staked: Uint128::new(1),
        },
        crate::plan::DelegationView {
            valoper: "zz-unenrolled".into(),
            staked: Uint128::new(1),
        },
        crate::plan::DelegationView {
            valoper: "valB".into(),
            staked: Uint128::new(1),
        },
        crate::plan::DelegationView {
            valoper: "valC".into(),
            staked: Uint128::new(1),
        },
    ];
    let ordered: Vec<String> = order_for_drain(dels, &ranks)
        .into_iter()
        .map(|d| d.valoper)
        .collect();
    assert_eq!(ordered, vec!["zz-unenrolled", "valC", "valB", "valA"]);
}

#[test]
fn rollover_resets_tip_and_advances_grace_boundary() {
    let mut deps = cosmwasm_std::testing::mock_dependencies();
    let mut r = rec(1);
    r.tip_epoch = Uint128::new(500);
    r.uptime_sum_bps = 20_000;
    r.uptime_count = 2;
    r.commission_accrued = Uint128::new(1_000);
    VALIDATORS
        .save(deps.as_mut().storage, "tpvaloper1x", &r)
        .unwrap();

    // Completion of epoch N: billed snapshots the accrual; nothing due yet.
    epoch_rollover(deps.as_mut().storage).unwrap();
    let r = VALIDATORS.load(&deps.storage, "tpvaloper1x").unwrap();
    assert_eq!(r.tip_epoch, Uint128::zero());
    assert_eq!(r.uptime_count, 0);
    assert_eq!(r.commission_due, Uint128::zero());
    assert_eq!(r.commission_billed, Uint128::new(1_000));

    // Completion of epoch N+1: the epoch-N accrual comes due (grace over).
    epoch_rollover(deps.as_mut().storage).unwrap();
    let r = VALIDATORS.load(&deps.storage, "tpvaloper1x").unwrap();
    assert_eq!(r.commission_due, Uint128::new(1_000));
    assert!(r.commission_paid < r.commission_due); // would assess in arrears
}

#[test]
fn accrue_commission_charges_enrolled_only() {
    let mut deps = cosmwasm_std::testing::mock_dependencies();
    VALIDATORS
        .save(deps.as_mut().storage, "tpvaloper1a", &rec(1))
        .unwrap();
    accrue_commission(
        deps.as_mut().storage,
        &[
            ("tpvaloper1a".to_string(), Uint128::new(1_000)),
            ("tpvaloper1ghost".to_string(), Uint128::new(1_000)),
        ],
        1_000,
    )
    .unwrap();
    let r = VALIDATORS.load(&deps.storage, "tpvaloper1a").unwrap();
    assert_eq!(r.commission_accrued, Uint128::new(100));
    assert!(!VALIDATORS.has(&deps.storage, "tpvaloper1ghost"));
}

#[test]
fn liveness_signal_requires_bonded_and_unjailed() {
    // Jailed/unbonded counters are frozen or reset and read as a vacuous 100%.
    let mut v = Validator {
        status: BondStatus::Bonded as i32,
        jailed: false,
        ..Default::default()
    };
    assert!(has_liveness_signal(&v));
    v.jailed = true;
    assert!(!has_liveness_signal(&v));
    v.jailed = false;
    v.status = BondStatus::Unbonded as i32;
    assert!(!has_liveness_signal(&v));
    v.status = BondStatus::Unbonding as i32;
    assert!(!has_liveness_signal(&v));
    v.status = BondStatus::Unspecified as i32;
    assert!(!has_liveness_signal(&v));
}

#[test]
fn cons_address_rejects_non_ed25519() {
    use provwasm_std::shim::Any;
    let validator = Validator {
        operator_address: "tpvaloper1x".to_string(),
        consensus_pubkey: Some(Any {
            type_url: "/cosmos.crypto.secp256k1.PubKey".to_string(),
            value: vec![],
        }),
        ..Default::default()
    };
    assert!(cons_address(&validator).is_err());
}
