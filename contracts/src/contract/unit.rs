use super::*;
use bech32::{Bech32, Hrp};
use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env};
use cosmwasm_std::{from_json, Addr, Timestamp};

use crate::state::{ValidatorRecord, LAST_CAPTURE, VALIDATORS};

pub fn setup(deps: cosmwasm_std::DepsMut, admin: &Addr, vault: &Addr) {
    instantiate(
        deps,
        mock_env(),
        message_info(admin, &[]),
        InstantiateMsg {
            admin: admin.to_string(),
            vault_address: vault.to_string(),
            underlying_denom: "nhash".to_string(),
            receipt_denom: "nvhash.staked".to_string(),
            max_delegations_per_run: 0,
            aum_fee_bps: 0,
            performance_threshold_bps: 0,
            min_capture_interval_secs: 0,
            max_concentration_multiple_bps: None,
            min_bonded_cap_bps: None,
            max_bonded_cap_bps: None,
            concentration_safety_offset_bps: None,
            commission_bps: None,
            jail_unbond_delay_secs: None,
            redemption_margin_bps: None,
        },
    )
    .unwrap();
}

/// A valoper whose key payload matches `addr` (so `addr` is its operator).
fn valoper_for(addr: &Addr) -> String {
    let (_, payload) = bech32::decode(addr.as_str()).unwrap();
    bech32::encode::<Bech32>(Hrp::parse("tpvaloper").unwrap(), &payload).unwrap()
}

#[test]
fn instantiate_stores_config_and_defaults() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);

    let bin = query(deps.as_ref(), mock_env(), QueryMsg::Config {}).unwrap();
    let resp: ConfigResponse = from_json(&bin).unwrap();
    assert_eq!(resp.admin, admin.to_string());
    assert_eq!(resp.underlying_denom, "nhash");
    assert_eq!(resp.receipt_denom, "nvhash.staked");
    assert_eq!(
        resp.max_concentration_multiple_bps,
        DEFAULT_MAX_CONCENTRATION_MULTIPLE_BPS
    );
    assert_eq!(resp.min_bonded_cap_bps, DEFAULT_MIN_BONDED_CAP_BPS);
    assert_eq!(resp.max_bonded_cap_bps, DEFAULT_MAX_BONDED_CAP_BPS);
    assert_eq!(
        resp.concentration_safety_offset_bps,
        DEFAULT_CONCENTRATION_SAFETY_OFFSET_BPS
    );
    assert!(PENDING_DELEGATIONS.load(&deps.storage).unwrap().is_empty());
    assert_eq!(RECEIPT_MINTED.load(&deps.storage).unwrap(), Uint128::zero());
    assert!(!HALTED.load(&deps.storage).unwrap());
}

/// The setup InstantiateMsg with one field overridden per case.
fn base_msg(admin: &Addr, vault: &Addr) -> InstantiateMsg {
    InstantiateMsg {
        admin: admin.to_string(),
        vault_address: vault.to_string(),
        underlying_denom: "nhash".to_string(),
        receipt_denom: "nvhash.staked".to_string(),
        max_delegations_per_run: 0,
        aum_fee_bps: 0,
        performance_threshold_bps: 0,
        min_capture_interval_secs: 0,
        max_concentration_multiple_bps: None,
        min_bonded_cap_bps: None,
        max_bonded_cap_bps: None,
        concentration_safety_offset_bps: None,
        commission_bps: None,
        jail_unbond_delay_secs: None,
        redemption_margin_bps: None,
    }
}

/// A named out-of-range mutation of one `InstantiateMsg` field.
type BoundsCase<'a> = (&'a str, Box<dyn Fn(&mut InstantiateMsg)>);

#[test]
fn instantiate_bounds_every_config_input() {
    let cases: Vec<BoundsCase> = vec![
        (
            "aum_fee_bps over 100%",
            Box::new(|m| m.aum_fee_bps = 10_001),
        ),
        (
            "performance_threshold_bps over 100%",
            Box::new(|m| m.performance_threshold_bps = 10_001),
        ),
        (
            "commission_bps over 100%",
            Box::new(|m| m.commission_bps = Some(10_001)),
        ),
        (
            "zero concentration multiple",
            Box::new(|m| m.max_concentration_multiple_bps = Some(0)),
        ),
        (
            "zero max bonded cap",
            Box::new(|m| m.max_bonded_cap_bps = Some(0)),
        ),
        (
            "min bonded cap above max",
            Box::new(|m| {
                m.min_bonded_cap_bps = Some(3_400);
                m.max_bonded_cap_bps = Some(3_300);
            }),
        ),
        (
            "safety offset at 100% of max bond",
            Box::new(|m| m.concentration_safety_offset_bps = Some(10_000)),
        ),
        (
            "redemption margin above the 1000 bps bound",
            Box::new(|m| m.redemption_margin_bps = Some(1_001)),
        ),
        (
            "empty underlying denom",
            Box::new(|m| m.underlying_denom = String::new()),
        ),
        (
            "denom with illegal characters",
            Box::new(|m| m.receipt_denom = "nv hash!".to_string()),
        ),
        (
            "denom starting with a digit",
            Box::new(|m| m.underlying_denom = "9hash".to_string()),
        ),
        (
            "identical underlying and receipt denoms",
            Box::new(|m| {
                m.underlying_denom = "nhash".to_string();
                m.receipt_denom = "nhash".to_string();
            }),
        ),
    ];
    for (label, mutate) in cases {
        let mut deps = mock_dependencies();
        let admin = deps.api.addr_make("admin");
        let vault = deps.api.addr_make("vault");
        let mut msg = base_msg(&admin, &vault);
        mutate(&mut msg);
        let err =
            instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap_err();
        assert!(
            matches!(err, ContractError::InvalidConfig { .. }),
            "case '{label}' should be rejected as InvalidConfig, got: {err:?}"
        );
    }
}

#[test]
fn instantiate_accepts_boundary_config_values() {
    // Exact edges of every bound are valid.
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    let mut msg = base_msg(&admin, &vault);
    msg.underlying_denom = "abc".to_string();
    msg.aum_fee_bps = 10_000;
    msg.performance_threshold_bps = 10_000;
    msg.commission_bps = Some(10_000);
    msg.min_bonded_cap_bps = Some(3_300);
    msg.max_bonded_cap_bps = Some(3_300);
    msg.concentration_safety_offset_bps = Some(9_999);
    // Both margin edges are legal; zero's failure mode is a refund, covered by the sim.
    msg.redemption_margin_bps = Some(1_000);
    instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap();
}

#[test]
fn update_config_rejects_out_of_range_redemption_margin() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[]),
        ExecuteMsg::UpdateConfig {
            max_delegations_per_run: None,
            aum_fee_bps: None,
            performance_threshold_bps: None,
            min_capture_interval_secs: None,
            max_concentration_multiple_bps: None,
            min_bonded_cap_bps: None,
            max_bonded_cap_bps: None,
            concentration_safety_offset_bps: None,
            commission_bps: None,
            jail_unbond_delay_secs: None,
            redemption_margin_bps: Some(1_001),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::InvalidConfig { .. }));
    // Rejected → stored value unchanged (the instantiate default).
    let bin = query(deps.as_ref(), mock_env(), QueryMsg::Config {}).unwrap();
    let resp: ConfigResponse = from_json(&bin).unwrap();
    assert_eq!(resp.redemption_margin_bps, DEFAULT_REDEMPTION_MARGIN_BPS);
}

#[test]
fn config_stored_before_the_margin_field_deserializes_at_50() {
    // Config JSON without the margin key must load as 50 (function default, never bare zero).
    let old_json = r#"{
            "admin": "pb1admin",
            "vault_address": "pb1vault",
            "underlying_denom": "nhash",
            "receipt_denom": "nvhash.staked",
            "max_delegations_per_run": 0,
            "aum_fee_bps": 0,
            "performance_threshold_bps": 0,
            "min_capture_interval_secs": 0,
            "max_concentration_multiple_bps": 55000,
            "min_bonded_cap_bps": 500,
            "max_bonded_cap_bps": 3300,
            "concentration_safety_offset_bps": 500
        }"#;
    let cfg: Config = from_json(old_json.as_bytes()).unwrap();
    assert_eq!(cfg.redemption_margin_bps, 50);
    // And the bare-default fields keep their established zero semantics.
    assert_eq!(cfg.commission_bps, 0);
}

#[test]
fn update_config_rejects_out_of_range_values() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);

    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[]),
        ExecuteMsg::UpdateConfig {
            max_delegations_per_run: None,
            aum_fee_bps: Some(10_001),
            performance_threshold_bps: None,
            min_capture_interval_secs: None,
            max_concentration_multiple_bps: None,
            min_bonded_cap_bps: None,
            max_bonded_cap_bps: None,
            concentration_safety_offset_bps: None,
            commission_bps: None,
            jail_unbond_delay_secs: None,
            redemption_margin_bps: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::InvalidConfig { .. }));

    // The rejected update must not have modified the stored config.
    let bin = query(deps.as_ref(), mock_env(), QueryMsg::Config {}).unwrap();
    let resp: ConfigResponse = from_json(&bin).unwrap();
    assert_eq!(resp.aum_fee_bps, 0);
}

#[test]
fn admin_updates_config_fields() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);

    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[]),
        ExecuteMsg::UpdateConfig {
            max_delegations_per_run: Some(8),
            aum_fee_bps: Some(15),
            performance_threshold_bps: Some(9_800),
            min_capture_interval_secs: Some(86_400),
            max_concentration_multiple_bps: None,
            min_bonded_cap_bps: None,
            max_bonded_cap_bps: None,
            concentration_safety_offset_bps: Some(1_000),
            commission_bps: None,
            jail_unbond_delay_secs: None,
            redemption_margin_bps: None,
        },
    )
    .unwrap();
    let bin = query(deps.as_ref(), mock_env(), QueryMsg::Config {}).unwrap();
    let resp: ConfigResponse = from_json(&bin).unwrap();
    assert_eq!(resp.max_delegations_per_run, 8);
    assert_eq!(resp.aum_fee_bps, 15);
    assert_eq!(resp.performance_threshold_bps, 9_800);
    assert_eq!(resp.min_capture_interval_secs, 86_400);
    // None fields keep their instantiate defaults.
    assert_eq!(
        resp.max_concentration_multiple_bps,
        DEFAULT_MAX_CONCENTRATION_MULTIPLE_BPS
    );
    assert_eq!(resp.concentration_safety_offset_bps, 1_000);
}

#[test]
fn setters_reject_non_admin() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    let stranger = deps.api.addr_make("stranger");
    setup(deps.as_mut(), &admin, &vault);
    for msg in [
        ExecuteMsg::UpdateConfig {
            max_delegations_per_run: None,
            aum_fee_bps: None,
            performance_threshold_bps: None,
            min_capture_interval_secs: None,
            max_concentration_multiple_bps: None,
            min_bonded_cap_bps: None,
            max_bonded_cap_bps: None,
            concentration_safety_offset_bps: None,
            commission_bps: None,
            jail_unbond_delay_secs: None,
            redemption_margin_bps: None,
        },
        ExecuteMsg::SetHalted { halted: true },
        ExecuteMsg::ClearPendingDelegations {},
    ] {
        let err =
            execute(deps.as_mut(), mock_env(), message_info(&stranger, &[]), msg).unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));
    }
}

#[test]
fn halt_blocks_fund_moving_cranks() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[]),
        ExecuteMsg::SetHalted { halted: true },
    )
    .unwrap();

    for msg in [ExecuteMsg::RunEpoch {}, ExecuteMsg::ServiceRedemptions {}] {
        let err = execute(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap_err();
        assert!(matches!(err, ContractError::Halted {}));
    }

    let bin = query(deps.as_ref(), mock_env(), QueryMsg::EpochStatus {}).unwrap();
    let resp: EpochStatusResponse = from_json(&bin).unwrap();
    assert!(resp.halted);

    // Resume must get past the halt gate; mock deps then fail with a querier error, not Halted.
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[]),
        ExecuteMsg::SetHalted { halted: false },
    )
    .unwrap();
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[]),
        ExecuteMsg::ServiceRedemptions {},
    )
    .unwrap_err();
    assert!(!matches!(err, ContractError::Halted {}));
}

#[test]
fn register_rejects_bad_shape_and_non_operator() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    let operator = deps.api.addr_make("operator");
    setup(deps.as_mut(), &admin, &vault);

    // Account address (no valoper HRP) is rejected on shape.
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&operator, &[]),
        ExecuteMsg::RegisterParticipation {
            valoper: admin.to_string(),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::InvalidValoper { .. }));

    // A valoper that is not the caller's key payload is rejected.
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&operator, &[]),
        ExecuteMsg::RegisterParticipation {
            valoper: valoper_for(&admin),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotOperator { .. }));

    // Own valoper passes the auth gates first; mock deps then report ValidatorNotFound.
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&operator, &[]),
        ExecuteMsg::RegisterParticipation {
            valoper: valoper_for(&operator),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::ValidatorNotFound { .. }));
}

#[test]
fn unregister_requires_operator_or_admin() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    let operator = deps.api.addr_make("operator");
    let stranger = deps.api.addr_make("stranger");
    setup(deps.as_mut(), &admin, &vault);
    let valoper = valoper_for(&operator);

    // Not enrolled yet.
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&operator, &[]),
        ExecuteMsg::UnregisterParticipation {
            valoper: valoper.clone(),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotEnrolled { .. }));

    // Seed an enrollment directly (registration needs chain queries).
    VALIDATORS
        .save(
            deps.as_mut().storage,
            &valoper,
            &ValidatorRecord {
                operator: operator.clone(),
                enrolled_at: Timestamp::from_seconds(1),
                uptime_sum_bps: 0,
                uptime_count: 0,
                commission_accrued: Uint128::zero(),
                commission_paid: Uint128::zero(),
                commission_due: Uint128::zero(),
                commission_billed: Uint128::zero(),
                tip_epoch: Uint128::zero(),
            },
        )
        .unwrap();

    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[]),
        ExecuteMsg::UnregisterParticipation {
            valoper: valoper.clone(),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));

    // Operator can remove its own validator.
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&operator, &[]),
        ExecuteMsg::UnregisterParticipation {
            valoper: valoper.clone(),
        },
    )
    .unwrap();
    assert!(!VALIDATORS.has(&deps.storage, &valoper));

    // Admin can remove too (governance path).
    VALIDATORS
        .save(
            deps.as_mut().storage,
            &valoper,
            &ValidatorRecord {
                operator: operator.clone(),
                enrolled_at: Timestamp::from_seconds(1),
                uptime_sum_bps: 0,
                uptime_count: 0,
                commission_accrued: Uint128::zero(),
                commission_paid: Uint128::zero(),
                commission_due: Uint128::zero(),
                commission_billed: Uint128::zero(),
                tip_epoch: Uint128::zero(),
            },
        )
        .unwrap();
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[]),
        ExecuteMsg::UnregisterParticipation {
            valoper: valoper.clone(),
        },
    )
    .unwrap();
    assert!(!VALIDATORS.has(&deps.storage, &valoper));
}

#[test]
fn apr_query_decomposes_last_snapshot() {
    use crate::state::{EpochSnapshot, LAST_SNAPSHOT};
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);

    // Before the first epoch: empty response, no error.
    let bin = query(deps.as_ref(), mock_env(), QueryMsg::Apr {}).unwrap();
    let resp: crate::msg::AprResponse = from_json(&bin).unwrap();
    assert_eq!(resp.epoch_index, 0);
    assert_eq!(resp.gross_apr_bps, 0);
    let bin = query(deps.as_ref(), mock_env(), QueryMsg::EpochSnapshot {}).unwrap();
    let resp: crate::msg::EpochSnapshotResponse = from_json(&bin).unwrap();
    assert!(resp.snapshot.is_none());

    // 30-day window on 1e12 TVV: gross 1.3e9, net 1e9 after AUM and write-down drags.
    LAST_SNAPSHOT
        .save(
            deps.as_mut().storage,
            &EpochSnapshot {
                epoch_index: 7,
                started_at_seconds: 1_000,
                ended_at_seconds: 1_000 + 2_592_000,
                end_height: 99,
                tvv_before: Uint128::new(1_000_000_000_000),
                tvv_after: Uint128::new(1_000_001_000_000),
                total_shares: Uint128::new(5),
                rewards_claimed: Uint128::new(1_000_000_000),
                commission_received: Uint128::new(200_000_000),
                tips_received: Uint128::new(100_000_000),
                rewards_deposited: Uint128::new(1_000_000_000),
                settled: Uint128::zero(),
                write_down: Uint128::new(200_000_000),
                deployed: Uint128::zero(),
                rebalanced: Uint128::zero(),
                unbonded_for_redemptions: Uint128::zero(),
                redemptions_expedited: 0,
                validators_purged: 0,
                eligible_count: 3,
                aum_fee_estimate: Uint128::new(100_000_000),
                net_deposits: cosmwasm_std::Int128::new(-42),
            },
        )
        .unwrap();
    let bin = query(deps.as_ref(), mock_env(), QueryMsg::Apr {}).unwrap();
    let resp: crate::msg::AprResponse = from_json(&bin).unwrap();
    assert_eq!(resp.epoch_index, 7);
    assert_eq!(resp.window_seconds, 2_592_000);
    // 1.3e9 over 30d on 1e12 annualizes to 158 bps (floor); net 1.0e9 to 121 bps.
    assert_eq!(resp.gross_apr_bps, 158);
    assert_eq!(resp.net_apr_bps, 121);
}

#[test]
fn pay_handlers_accumulate_epoch_flows() {
    use crate::state::EPOCH_ACCUM;
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    let operator = deps.api.addr_make("operator");
    setup(deps.as_mut(), &admin, &vault);
    let valoper = valoper_for(&operator);
    VALIDATORS
        .save(
            deps.as_mut().storage,
            &valoper,
            &ValidatorRecord {
                operator: operator.clone(),
                enrolled_at: Timestamp::from_seconds(1),
                uptime_sum_bps: 0,
                uptime_count: 0,
                commission_accrued: Uint128::zero(),
                commission_paid: Uint128::zero(),
                commission_due: Uint128::zero(),
                commission_billed: Uint128::zero(),
                tip_epoch: Uint128::zero(),
            },
        )
        .unwrap();
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[cosmwasm_std::coin(70, "nhash")]),
        ExecuteMsg::PayCommission {
            valoper: valoper.clone(),
        },
    )
    .unwrap();
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[cosmwasm_std::coin(30, "nhash")]),
        ExecuteMsg::PayTip { valoper },
    )
    .unwrap();
    let acc = EPOCH_ACCUM.load(&deps.storage).unwrap();
    assert_eq!(acc.commission_received, Uint128::new(70));
    assert_eq!(acc.tips_received, Uint128::new(30));
    assert_eq!(acc.rewards_claimed, Uint128::zero());
}

#[test]
fn jail_flow_gates_report_cooldown_and_claimant() {
    use crate::state::JAIL_REPORTS;
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    let operator = deps.api.addr_make("operator");
    let stranger = deps.api.addr_make("stranger");
    setup(deps.as_mut(), &admin, &vault);
    let jailed = "tpvaloper1jailedjailedjailed".to_string();
    let claimant = valoper_for(&operator);

    // The mock querier resolves not-jailed, so the report records nothing.
    let res = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[]),
        ExecuteMsg::ReportJailedValidator {
            valoper: jailed.clone(),
        },
    )
    .unwrap();
    assert!(res.attributes.iter().any(|a| a.value == "not_jailed"));
    assert!(!JAIL_REPORTS.has(&deps.storage, &jailed));

    // Purge without a report is rejected.
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[]),
        ExecuteMsg::PurgeJailedValidator {
            valoper: jailed.clone(),
            claimant_valoper: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::JailReportMissing { .. }));

    // Inside the cooldown the purge is rejected with the ready time.
    JAIL_REPORTS
        .save(
            deps.as_mut().storage,
            &jailed,
            &crate::state::JailObservation {
                reported_at: mock_env().block.time,
                unbonding_height: 0,
            },
        )
        .unwrap();
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[]),
        ExecuteMsg::UpdateConfig {
            max_delegations_per_run: None,
            aum_fee_bps: None,
            performance_threshold_bps: None,
            min_capture_interval_secs: None,
            max_concentration_multiple_bps: None,
            min_bonded_cap_bps: None,
            max_bonded_cap_bps: None,
            concentration_safety_offset_bps: None,
            commission_bps: None,
            jail_unbond_delay_secs: Some(28_800),
            redemption_margin_bps: None,
        },
    )
    .unwrap();
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[]),
        ExecuteMsg::PurgeJailedValidator {
            valoper: jailed.clone(),
            claimant_valoper: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::JailCooldownActive { .. }));

    // Backdate the report so the cooldown has elapsed for the rest.
    JAIL_REPORTS
        .save(
            deps.as_mut().storage,
            &jailed,
            &crate::state::JailObservation {
                reported_at: Timestamp::from_seconds(1),
                unbonding_height: 0,
            },
        )
        .unwrap();

    // Claimant gates run before any chain read: self-claim, unenrolled, non-operator rejected.
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[]),
        ExecuteMsg::PurgeJailedValidator {
            valoper: jailed.clone(),
            claimant_valoper: Some(jailed.clone()),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::ClaimantNotEligible { .. }));
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[]),
        ExecuteMsg::PurgeJailedValidator {
            valoper: jailed.clone(),
            claimant_valoper: Some(claimant.clone()),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotEnrolled { .. }));
    VALIDATORS
        .save(
            deps.as_mut().storage,
            &claimant,
            &ValidatorRecord {
                operator: operator.clone(),
                enrolled_at: Timestamp::from_seconds(1),
                uptime_sum_bps: 0,
                uptime_count: 0,
                commission_accrued: Uint128::zero(),
                commission_paid: Uint128::zero(),
                commission_due: Uint128::zero(),
                commission_billed: Uint128::zero(),
                tip_epoch: Uint128::zero(),
            },
        )
        .unwrap();
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[]),
        ExecuteMsg::PurgeJailedValidator {
            valoper: jailed.clone(),
            claimant_valoper: Some(claimant.clone()),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotOperator { .. }));

    // An unjailed second observation clears the stale report; a re-jail needs a fresh cycle.
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[]),
        ExecuteMsg::PurgeJailedValidator {
            valoper: jailed.clone(),
            claimant_valoper: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotJailed { .. }));
    assert!(!JAIL_REPORTS.has(&deps.storage, &jailed));

    // Halt blocks the purge (fund-moving) but not the report.
    JAIL_REPORTS
        .save(
            deps.as_mut().storage,
            &jailed,
            &crate::state::JailObservation {
                reported_at: Timestamp::from_seconds(1),
                unbonding_height: 0,
            },
        )
        .unwrap();
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[]),
        ExecuteMsg::SetHalted { halted: true },
    )
    .unwrap();
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[]),
        ExecuteMsg::PurgeJailedValidator {
            valoper: jailed.clone(),
            claimant_valoper: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::Halted {}));
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[]),
        ExecuteMsg::ReportJailedValidator { valoper: jailed },
    )
    .unwrap();
}

#[test]
fn pay_commission_and_tip_credit_from_any_payer() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    let operator = deps.api.addr_make("operator");
    let stranger = deps.api.addr_make("stranger");
    setup(deps.as_mut(), &admin, &vault);
    let valoper = valoper_for(&operator);
    VALIDATORS
        .save(
            deps.as_mut().storage,
            &valoper,
            &ValidatorRecord {
                operator: operator.clone(),
                enrolled_at: Timestamp::from_seconds(1),
                uptime_sum_bps: 0,
                uptime_count: 0,
                commission_accrued: Uint128::new(80),
                commission_paid: Uint128::zero(),
                commission_due: Uint128::zero(),
                commission_billed: Uint128::zero(),
                tip_epoch: Uint128::zero(),
            },
        )
        .unwrap();

    // Any payer may attach nhash; credits accumulate.
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[cosmwasm_std::coin(50, "nhash")]),
        ExecuteMsg::PayCommission {
            valoper: valoper.clone(),
        },
    )
    .unwrap();
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[cosmwasm_std::coin(40, "nhash")]),
        ExecuteMsg::PayTip {
            valoper: valoper.clone(),
        },
    )
    .unwrap();
    let r = VALIDATORS.load(&deps.storage, &valoper).unwrap();
    assert_eq!(r.commission_paid, Uint128::new(50));
    assert_eq!(r.tip_epoch, Uint128::new(40));

    // No funds attached: rejected.
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[]),
        ExecuteMsg::PayCommission {
            valoper: valoper.clone(),
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("No funds"));

    // Wrong denom: rejected (cw-utils names the required token).
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[cosmwasm_std::coin(50, "uusd")]),
        ExecuteMsg::PayTip {
            valoper: valoper.clone(),
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("nhash"));
    let r = VALIDATORS.load(&deps.storage, &valoper).unwrap();
    assert_eq!(r.tip_epoch, Uint128::new(40)); // unchanged

    // Unenrolled validator: rejected (funds would not be creditable).
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[cosmwasm_std::coin(50, "nhash")]),
        ExecuteMsg::PayCommission {
            valoper: "tpvaloper1ghost".to_string(),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::NotEnrolled { .. }));
}

#[test]
fn capture_uptime_skips_inside_interval() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[]),
        ExecuteMsg::UpdateConfig {
            max_delegations_per_run: None,
            aum_fee_bps: None,
            performance_threshold_bps: None,
            min_capture_interval_secs: Some(u64::MAX),
            max_concentration_multiple_bps: None,
            min_bonded_cap_bps: None,
            max_bonded_cap_bps: None,
            concentration_safety_offset_bps: None,
            commission_bps: None,
            jail_unbond_delay_secs: None,
            redemption_margin_bps: None,
        },
    )
    .unwrap();
    LAST_CAPTURE
        .save(deps.as_mut().storage, &Timestamp::from_seconds(1))
        .unwrap();

    let res = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[]),
        ExecuteMsg::CaptureUptimeSignal {},
    )
    .unwrap();
    assert!(res
        .attributes
        .iter()
        .any(|a| a.key == "result" && a.value == "skipped_interval"));
}

#[test]
fn clear_pending_delegations_resets_state_without_advancing_last_run() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);
    PENDING_DELEGATIONS
        .save(
            deps.as_mut().storage,
            &vec![("tpvaloper1badbadbad".to_string(), Uint128::new(5))],
        )
        .unwrap();
    EPOCH
        .update(deps.as_mut().storage, |mut e| -> Result<_, ContractError> {
            e.phase = EpochPhase::Releasing;
            Ok(e)
        })
        .unwrap();

    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[]),
        ExecuteMsg::ClearPendingDelegations {},
    )
    .unwrap();

    assert!(PENDING_DELEGATIONS.load(&deps.storage).unwrap().is_empty());
    let epoch = EPOCH.load(&deps.storage).unwrap();
    assert_eq!(epoch.phase, EpochPhase::Idle);
    assert_eq!(epoch.last_run.seconds(), 0); // aborted epoch may re-run immediately
}

#[test]
fn epoch_status_query_reports_state() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);
    PENDING_DELEGATIONS
        .save(
            deps.as_mut().storage,
            &vec![("tpvaloper1abc".to_string(), Uint128::new(7))],
        )
        .unwrap();

    let bin = query(deps.as_ref(), mock_env(), QueryMsg::EpochStatus {}).unwrap();
    let resp: crate::msg::EpochStatusResponse = from_json(&bin).unwrap();
    assert_eq!(resp.phase, "Idle");
    assert!(!resp.halted);
    assert_eq!(resp.last_run_seconds, 0);
    assert_eq!(resp.receipt_minted, Uint128::zero());
    assert_eq!(resp.pending_delegations.len(), 1);
    assert_eq!(resp.pending_delegations[0].valoper, "tpvaloper1abc");
    assert_eq!(resp.pending_delegations[0].amount, Uint128::new(7));
}

#[test]
fn run_epoch_rejects_within_same_calendar_month() {
    // The calendar gate runs off storage before any chain query, so mock deps suffice.
    // Same civil month as the default last_run (1970-01) must be rejected.
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);

    let mut env = mock_env();
    env.block.time = cosmwasm_std::Timestamp::from_seconds(10 * 86_400); // 1970-01-11
    let err = execute(
        deps.as_mut(),
        env,
        message_info(&admin, &[]),
        ExecuteMsg::RunEpoch {},
    )
    .unwrap_err();
    // next = first second of the following month (1970-02-01 = 31 days).
    assert!(matches!(err, ContractError::TooSoon { next } if next == 31 * 86_400));
}

#[test]
fn pause_vault_emits_vault_message_admin_only() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    let stranger = deps.api.addr_make("stranger");
    setup(deps.as_mut(), &admin, &vault);
    let res = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&admin, &[]),
        ExecuteMsg::PauseVault {
            reason: "manual".to_string(),
        },
    )
    .unwrap();
    assert_eq!(res.messages.len(), 1);
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&stranger, &[]),
        ExecuteMsg::UnpauseVault {},
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));
}

// wasmd owns WHO may migrate; these pin WHAT it may do: name match, no downgrade,
// equal idempotent, older advances the marker, no key beyond contract_info moves.

/// Every raw storage entry as (key, value) pairs, for byte-level diffs.
fn storage_snapshot(storage: &cosmwasm_std::MemoryStorage) -> Vec<(Vec<u8>, Vec<u8>)> {
    use cosmwasm_std::Storage;
    storage
        .range(None, None, cosmwasm_std::Order::Ascending)
        .collect()
}

#[test]
fn migrate_rejects_a_foreign_contract_name() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);
    cw2::set_contract_version(&mut deps.storage, "crates.io:other-contract", "0.0.1").unwrap();
    let before = storage_snapshot(&deps.storage);
    let err = migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap_err();
    assert!(matches!(err, ContractError::InvalidMigration { .. }));
    assert_eq!(storage_snapshot(&deps.storage), before); // nothing moved
}

#[test]
fn migrate_rejects_a_newer_stored_version_downgrade() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);
    cw2::set_contract_version(&mut deps.storage, CONTRACT_NAME, "99.0.0").unwrap();
    let before = storage_snapshot(&deps.storage);
    let err = migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap_err();
    assert!(matches!(err, ContractError::MigrationDowngrade { .. }));
    assert_eq!(storage_snapshot(&deps.storage), before);
}

#[test]
fn migrate_accepts_equal_version_idempotently() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);
    let before = storage_snapshot(&deps.storage);
    let res = migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap();
    assert!(res.messages.is_empty());
    // Equal version re-stamps to identical bytes, so storage stays byte-identical.
    assert_eq!(storage_snapshot(&deps.storage), before);
}

#[test]
fn migrate_accepts_an_older_stored_version_and_advances_only_the_marker() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);
    cw2::set_contract_version(&mut deps.storage, CONTRACT_NAME, "0.0.1").unwrap();
    let before = storage_snapshot(&deps.storage);
    let res = migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap();
    assert!(res
        .attributes
        .iter()
        .any(|a| a.key == "from_version" && a.value == "0.0.1"));
    let after = storage_snapshot(&deps.storage);
    let marker_key = b"contract_info".to_vec();
    let changed: Vec<_> = before
        .iter()
        .filter(|(k, v)| after.iter().find(|(k2, _)| k2 == k).map(|(_, v2)| v2) != Some(v))
        .map(|(k, _)| k.clone())
        .collect();
    assert_eq!(changed, vec![marker_key]); // exactly the cw2 marker moved
    let stored = cw2::get_contract_version(&deps.storage).unwrap();
    assert_eq!(stored.version, CONTRACT_VERSION);
    assert_eq!(stored.contract, CONTRACT_NAME);
}

#[test]
fn migrate_rejects_an_unparseable_stored_version() {
    let mut deps = mock_dependencies();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    setup(deps.as_mut(), &admin, &vault);
    cw2::set_contract_version(&mut deps.storage, CONTRACT_NAME, "not-semver").unwrap();
    let err = migrate(deps.as_mut(), mock_env(), MigrateMsg {}).unwrap_err();
    assert!(matches!(err, ContractError::InvalidMigrationVersion { .. }));
}
