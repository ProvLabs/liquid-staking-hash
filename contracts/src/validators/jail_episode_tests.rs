use super::*;
use cosmwasm_std::testing::{message_info, mock_env};
use cosmwasm_std::{
    Binary, Coin as CwCoin, ContractResult, Decimal, FullDelegation, SystemResult,
    Validator as CwValidator,
};
use provwasm_common::MockableQuerier;
use provwasm_mocks::{mock_provenance_dependencies, MockProvenanceQuerier};
use provwasm_std::types::cosmos::staking::v1beta1::{
    QueryDelegatorUnbondingDelegationsResponse, QueryValidatorResponse, Validator as PValidator,
};

const VALOPER: &str = "tpvaloper1epi0000000000000000000000000000000000";

fn grpc<R: prost::Message>(q: &mut MockProvenanceQuerier, path: &str, resp: &R) {
    let bytes = provwasm_std::types::tendermint::abci::ResponseQuery {
        value: resp.encode_to_vec(),
        ..Default::default()
    }
    .encode_to_vec();
    q.register_custom_query(
        path.to_string(),
        Box::new(move |_| SystemResult::Ok(ContractResult::Ok(Binary::from(bytes.clone())))),
    );
}

/// (Re-)register the chain's view of the validator: jailed or not, and the
/// unbonding_height that fingerprints the current jail episode.
fn set_validator(q: &mut MockProvenanceQuerier, jailed: bool, unbonding_height: i64) {
    grpc(
        q,
        "/cosmos.staking.v1beta1.Query/Validator",
        &QueryValidatorResponse {
            validator: Some(PValidator {
                operator_address: VALOPER.to_string(),
                jailed,
                tokens: "1000".to_string(),
                unbonding_height,
                ..Default::default()
            }),
        },
    );
}

fn setup(
    with_stake: bool,
) -> cosmwasm_std::OwnedDeps<
    cosmwasm_std::testing::MockStorage,
    cosmwasm_std::testing::MockApi,
    MockProvenanceQuerier,
> {
    let mut deps = mock_provenance_dependencies();
    let env = mock_env();
    let admin = deps.api.addr_make("admin");
    let vault = deps.api.addr_make("vault");
    crate::contract::instantiate(
        deps.as_mut(),
        env.clone(),
        message_info(&admin, &[]),
        crate::msg::InstantiateMsg {
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
            jail_unbond_delay_secs: None, // 8h default
            redemption_margin_bps: None,
        },
    )
    .unwrap();
    if with_stake {
        let zero = CwCoin::new(0u128, "nhash");
        deps.querier.mock_querier.staking.update(
            "nhash",
            &[CwValidator::create(
                VALOPER.to_string(),
                Decimal::zero(),
                Decimal::one(),
                Decimal::one(),
            )],
            &[FullDelegation::create(
                env.contract.address.clone(),
                VALOPER.to_string(),
                CwCoin::new(1_000u128, "nhash"),
                zero,
                vec![],
            )],
        );
    }
    grpc(
        &mut deps.querier,
        "/cosmos.staking.v1beta1.Query/DelegatorUnbondingDelegations",
        &QueryDelegatorUnbondingDelegationsResponse {
            unbonding_responses: vec![],
            pagination: None,
        },
    );
    deps
}

#[test]
fn stale_report_from_earlier_jail_episode_cannot_bypass_cooldown() {
    let mut deps = setup(true);
    let env0 = mock_env();
    let delay = crate::contract::DEFAULT_JAIL_UNBOND_DELAY_SECS;

    // Episode 1: jailed at unbonding_height 100; report recorded.
    set_validator(&mut deps.querier, true, 100);
    let res = report_jailed(deps.as_mut(), &env0, VALOPER.to_string()).unwrap();
    assert!(res.attributes.iter().any(|a| a.value == "reported"));
    // Idempotent within the episode: original timestamp kept.
    let res = report_jailed(deps.as_mut(), &env0, VALOPER.to_string()).unwrap();
    assert!(res.attributes.iter().any(|a| a.value == "already_reported"));

    // Unobserved re-jail (episode 2, height 200): the elapsed cooldown must not authorize.
    let mut env1 = env0.clone();
    env1.block.time = env0.block.time.plus_seconds(delay + 1_000);
    set_validator(&mut deps.querier, true, 200);
    let info = message_info(&deps.api.addr_make("keeper"), &[]);
    let err = purge_jailed(deps.as_mut(), &env1, &info, VALOPER.to_string(), None).unwrap_err();
    match err {
        ContractError::JailCooldownActive { ready } => {
            assert_eq!(
                ready,
                env1.block.time.seconds() + delay,
                "cooldown must restart NOW"
            );
        }
        other => panic!("expected restarted cooldown, got {other:?}"),
    }
    // The report was refreshed onto episode 2.
    let obs = JAIL_REPORTS.load(&deps.storage, VALOPER).unwrap();
    assert_eq!(obs.unbonding_height, 200);
    assert_eq!(obs.reported_at, env1.block.time);

    // Same episode after the restarted cooldown: the purge unbonds everything.
    let mut env2 = env1.clone();
    env2.block.time = env1.block.time.plus_seconds(delay + 1);
    let res = purge_jailed(deps.as_mut(), &env2, &info, VALOPER.to_string(), None).unwrap();
    assert!(matches!(
        &res.messages[0].msg,
        cosmwasm_std::CosmosMsg::Staking(cosmwasm_std::StakingMsg::Undelegate { validator, amount })
            if validator == VALOPER && amount.amount.u128() == 1_000
    ));
    assert!(!JAIL_REPORTS.has(&deps.storage, VALOPER));
}

#[test]
fn report_is_recorded_only_where_the_program_has_stake() {
    let mut deps = setup(false);
    set_validator(&mut deps.querier, true, 100);
    let res = report_jailed(deps.as_mut(), &mock_env(), VALOPER.to_string()).unwrap();
    assert!(res.attributes.iter().any(|a| a.value == "no_program_stake"));
    assert!(!JAIL_REPORTS.has(&deps.storage, VALOPER));
}
